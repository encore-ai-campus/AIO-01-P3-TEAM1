"""AI 리포트 Orchestrator (docs/tasks/00-공통.md 8·9절, 03-orchestrator.md T3-3·T3-5~T3-9·T3-12, docs/design/AI_AGENT_WORKFLOW.md).

실행 계획(registry.execution_plan(report.team))대로 Worker를 단계마다 병렬·순차로 돌리고, Join Guard·부분 실패 정책·
검토 반복(RETRY)·Handoff를 판단해 Shared State와 Trace를 남긴다. State·Trace는 `state.*`로만 바꾼다.

- Worker는 늘 실행기(make_executor)를 거쳐 돈다. 단계 제한 시간(timeoutSec)이 Worker의 deadline이다 (healing.clock 기준).
  제한 시간 + STEP_GRACE_SEC 안에 끝나지 않은 Worker는 시간 초과로 "버린다" — 스레드는 끝날 때까지 남지만 결과를 쓰지 않는다
  (Worker 실행 하나마다 잠금 + settled 표시로, 결과 쓰기와 버림 중 하나만 일어난다).
- 실패로 끝낼 때 `workflow_failed.details.reason`은 FAILURE_REASONS 중 하나다 (00-공통 9절).
  필수 Worker가 실패하면: 단계 제한 시간 초과면 `timeout` → 아니고 다음 단계가 이 단계를 Join하면 Join Guard가 `join_blocked`
  → 아니면 `agent_failed`. 실행 시작 때 LLM 클라이언트가 없으면 `no_llm`, 그 밖의 예외는 `exception`.
- `run_report`는 예외를 밖으로 내지 않는다 (실패도 finish(failed)로 끝낸다).
- Worker 결과는 출력 계약을 통과한 뒤 State에 넣기 전에 `tidy.tidy_result`로 후처리한다 (금액 쉼표·의견 영어·쉬운 글 용어 풀이).
- 검토 반복: 다시 도는 검토 Worker에는 ctx.retry(직전 검토와 그 검토가 본 초안)를 준다. FAIL이나 한도를 넘긴 RETRY는 review_failed이고,
  남은 지적 줄은 workflow_failed.details.message에 넣는다. Worker 결과의 _guarded·_changed는 계약 검증 전에 꺼내
  agent_completed.details의 guarded·changed로 남긴다 (docs/DECISIONS.md 30장).
"""
import concurrent.futures
import copy
import importlib
import logging
import threading
import time
from dataclasses import dataclass, field

from django.db import connections

from config import engine

from .. import agents
from ..guardrails import contracts, guards, tidy
from ..autohealing import healing
from . import registry, state
from ..agents.base import WorkerContext, WorkerError
from ..models import Report

log = logging.getLogger(__name__)

DEFAULT_STEP_TIMEOUT_SEC = 180  # 단계에 timeout이 없을 때
STEP_GRACE_SEC = 5              # deadline 뒤 Worker를 더 기다리는 시간 (마지막 호출의 실패 기록이 들어올 여유)
MESSAGE_MAX = 300               # agent_failed·workflow_failed의 message 길이 상한

ORCHESTRATOR, HANDOFF_GUARD = "orchestrator", "handoff_guard"  # Trace actor

# 실패 사유 코드 (workflow_failed.details.reason — 00-공통 9절. 화면·알림이 이 코드로 쉬운 문장을 고른다)
JOIN_BLOCKED, REVIEW_FAILED, TIMEOUT = "join_blocked", "review_failed", "timeout"
ENGINE_RESTARTED, EXCEPTION = "engine_restarted", "exception"
AGENT_FAILED, NO_LLM, EXPIRED = "agent_failed", "no_llm", "expired"  # expired는 runner가 묵은 신청을 끝낼 때
FAILURE_REASONS = (JOIN_BLOCKED, REVIEW_FAILED, TIMEOUT, ENGINE_RESTARTED, EXCEPTION, AGENT_FAILED, NO_LLM, EXPIRED)
FAIL_FAST = "fail_fast"  # fail_fast 정책으로 멈췄을 때 남은 Worker의 agent_skipped 사유

# 팀 실행 전체가 같이 쓰는 입력(WorkerContext.team_inputs)을 만드는 함수 ("모듈.함수", 실행 시작 때 한 번 지연 import)
TEAM_INPUTS = {registry.SELECTION_TEAM: "reports.autoreport.selection.team_inputs"}

HANDOFF_CONSTRAINTS = [
    "리포트 본문(report_agent 결과)을 고치지 않는다",
    "memory_refs의 결과와 종목 자료에 있는 사실만 근거로 쓴다",
    "매매를 권유하지 않고 위험 신호만 정리한다",
]
RISK_LEVEL_TEXT = {"low": "낮음", "medium": "보통", "high": "높음"}


def make_executor(workers: int):
    """Worker를 돌릴 실행기 (concurrent.futures.Executor 모양). 테스트는 InlineExecutor로 바꿔 스레드 없이 돌린다."""
    return DaemonExecutor()


class DaemonExecutor:
    """submit마다 데몬 스레드 하나 (한 단계의 Worker는 어차피 모두 같이 돈다).

    ThreadPoolExecutor의 스레드는 인터프리터가 끝날 때 끝까지 기다려진다 — 시간 초과로 버린 Worker가 엔진 종료(Ctrl+C)를
    단계 제한 시간만큼 붙잡지 않게 데몬 스레드를 쓴다. 끝나지 않은 리포트는 다음 시작의 runner.recover()가 정리한다.
    """

    def submit(self, fn, *args, **kwargs) -> concurrent.futures.Future:
        future: concurrent.futures.Future = concurrent.futures.Future()

        def work() -> None:
            if not future.set_running_or_notify_cancel():
                return
            try:
                future.set_result(fn(*args, **kwargs))
            except BaseException as e:  # noqa: BLE001 — Future에 그대로 넘긴다
                future.set_exception(e)

        threading.Thread(target=work, name="report-worker", daemon=True).start()
        return future

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        pass


class InlineExecutor:
    """부른 스레드에서 바로 실행하는 실행기 (테스트용: `monkeypatch.setattr(orchestrator, "make_executor", ...)`)."""

    def submit(self, fn, *args, **kwargs) -> concurrent.futures.Future:
        future: concurrent.futures.Future = concurrent.futures.Future()
        try:
            future.set_result(fn(*args, **kwargs))
        except Exception as e:
            future.set_exception(e)
        return future

    def shutdown(self, wait: bool = True, *, cancel_futures: bool = False) -> None:
        pass


def team_inputs(report: Report) -> dict | None:
    """팀 실행 전체가 같이 쓰는 입력. 종목 리포트는 None, 선정 팀은 reports.autoreport.selection.team_inputs(report)."""
    target = TEAM_INPUTS.get(report.team)
    if target is None:
        return None
    module, _, name = target.rpartition(".")
    return getattr(importlib.import_module(module), name)(report)


def run_report(report: Report, *, workers=None, llm_client=None, now=None) -> Report:
    """리포트 하나를 처음부터 끝까지 실행한다 (requested → running → completed|failed). 예외를 밖으로 내지 않는다.

    workers: Worker id → Worker (기본 agents.WORKERS). llm_client: complete_json_once가 있는 LLM 클라이언트
    (기본 healing.llm_client() — DEVPASS_APIKEY가 없으면 None이라 `no_llm`으로 끝난다). now는 쓰지 않는다 (계약 자리).
    다른 쪽이 먼저 시작한 리포트(requested가 아님)는 건드리지 않고 그대로 돌려준다.
    """
    try:
        state.start(report)
    except Exception as e:
        log.warning("리포트 #%s를 시작하지 못함: %s", report.pk, e)
        return report
    flow = _Flow(report, workers, llm_client)
    try:
        flow.run()
    except Exception as error:
        log.exception("리포트 #%s 실행 중 예상하지 못한 오류", report.pk)
        flow.give_up(error)
    return report


def content_of(report: Report, inputs: dict | None = None) -> str:
    """완료된 리포트의 본문 (Markdown). inputs는 팀 입력(선정 팀의 후보 표 — 종목 이름을 찾는다)."""
    if report.team == registry.SELECTION_TEAM:
        return _selection_content(report.results["selector_agent"], (inputs or {}).get("candidates") or [],
                                  report.results.get("selection_review_agent"))
    markdown = report.results["report_agent"]["markdown"]
    risk = report.results.get("risk_agent")
    return f"{_risk_block(risk)}\n\n{markdown}" if risk else markdown


@dataclass(eq=False)
class _Run:
    """Worker 실행 한 번. 스레드(결과 쓰기)와 Orchestrator(시간 초과로 버림)가 같이 보고, lock으로 하나만 State에 쓴다."""
    worker_id: str
    attempt: int
    step_id: str
    inputs: dict
    instructions: str | None = None
    handoff: dict | None = None
    retry: dict | None = None   # 검토 반복으로 다시 도는 검토 Worker의 ctx.retry ({round, review, draft})
    lock: threading.Lock = field(default_factory=threading.Lock)
    caller: healing.LlmCaller | None = None
    began: float = 0.0          # time.monotonic() — agent_started 때
    settled: bool = False       # 결과(성공·실패)를 State에 썼거나 버렸다
    ok: bool = False
    timed_out: bool = False     # 단계 제한 시간 초과로 실패
    result: dict | None = None


class _Flow:
    """리포트 실행 하나의 진행 상태 (계획, 시도 수, 시작한 Worker, Handoff 수)."""

    def __init__(self, report: Report, workers, llm_client):
        self.report, self.workers, self.llm = report, workers, llm_client
        self.thread = threading.current_thread()   # 이 스레드에서 인라인으로 돈 Worker는 DB 연결을 닫지 않는다
        self.began = time.monotonic()
        self.plan: dict | None = None
        self.defs: dict[str, dict] = {}
        self.step_of: dict[str, dict] = {}
        self.attempts: dict[str, int] = {}
        self.inputs_used: dict[str, dict] = {}
        self.started: set[str] = set()
        self.hops = 0
        self.team_inputs: dict | None = None
        self.cfg = self.client = None
        self.failure_message: str | None = None   # review_failed로 끝낼 때 workflow_failed.details.message (남은 검토 지적)

    # ------------------------------------------------------------------ 전체 흐름

    def run(self) -> None:
        report = self.report
        state.record(report, ORCHESTRATOR, "workflow_started", "started", details={
            "chaos": bool(report.chaos and report.chaos.get("enabled")), "source": report.source, "team": report.team})
        self.plan = registry.execution_plan(report.team)
        self.defs = {worker["id"]: worker for worker in self.plan["workers"]}
        self.step_of = {wid: step for step in self.plan["steps"] for wid in step["workers"]}
        if self.workers is None:
            self.workers = agents.WORKERS
        if self.llm is None:
            self.llm = healing.llm_client()
        if self.llm is None:
            return self.fail(NO_LLM)
        try:
            self.team_inputs = team_inputs(report)
        except Exception as e:
            log.warning("리포트 #%s 팀 입력을 만들지 못함: %s", report.pk, e)
            return self.fail(EXCEPTION, message=_message(e))
        self.cfg, self.client = engine.engine_config(), engine.broker_client()
        steps = self.plan["steps"]
        for index, step in enumerate(steps):
            reason = self._step(step, steps[index + 1] if index + 1 < len(steps) else None)
            if reason:
                return self.fail(reason, message=self.failure_message)
        content = content_of(report, self.team_inputs)
        state.record(report, ORCHESTRATOR, "workflow_completed", "completed", details=self._totals())
        state.finish(report, Report.COMPLETED, content)

    def fail(self, reason: str, message: str | None = None) -> None:
        """남은 Worker를 건너뜀으로 남기고 workflow_failed(reason) → finish(failed)."""
        policy = (self.plan or {}).get("failurePolicy")
        skip = FAIL_FAST if policy == FAIL_FAST and reason in (TIMEOUT, JOIN_BLOCKED, AGENT_FAILED) else reason
        for wid in self._remaining():
            state.record(self.report, wid, "agent_skipped", "skipped", details={"reason": skip})
        details = {"reason": reason, **self._totals()}
        if message:
            details["message"] = message
        state.record(self.report, ORCHESTRATOR, "workflow_failed", "failed", details=details)
        state.finish(self.report, Report.FAILED)

    def give_up(self, error: Exception) -> None:
        """예상하지 못한 예외: 아직 끝나지 않았으면 exception으로 끝낸다. 그것도 안 되면 finish만."""
        if self.report.status != Report.RUNNING:
            return
        try:
            self.fail(EXCEPTION, message=_message(error))
        except Exception:
            log.exception("리포트 #%s 실패 기록을 남기지 못함", self.report.pk)
            try:
                state.finish(self.report, Report.FAILED)
            except Exception:
                log.exception("리포트 #%s를 실패로 끝내지 못함", self.report.pk)

    def _remaining(self) -> list[str]:
        if not self.plan:
            return []
        return [wid for step in self.plan["steps"] for wid in step["workers"] if wid not in self.started]

    def _totals(self) -> dict:
        return {"costUsd": round(self.report.cost_usd or 0, 6), "durationMs": _ms(time.monotonic() - self.began)}

    # ------------------------------------------------------------------ 단계

    def _step(self, step: dict, next_step: dict | None) -> str | None:
        """단계 하나. 멈춰야 하면 실패 사유 코드, 계속이면 None."""
        report = self.report
        state.set_step(report, step["id"])
        timeout_sec = _timeout(step)
        deadline = healing.clock() + timeout_sec
        if step["join"]:
            decision = guards.join(report, step, self.plan)
            if not decision.ok:
                return JOIN_BLOCKED
            inputs = decision.inputs
        else:
            inputs = self._inputs(step)
        runs = [self._new_run(wid, step, inputs) for wid in step["workers"]]
        self._execute(runs, deadline, timeout_sec, parallel=step["mode"] == "parallel")
        reason = self._judge(step, runs, next_step)
        if reason:
            return reason
        for run in runs:
            if run.ok and self.defs[run.worker_id]["outputContract"] == registry.REVIEW_CONTRACT:
                reason = self._review(step, run)
                if reason:
                    return reason
                self._handoff(step, run.worker_id)
        return None

    def _judge(self, step: dict, runs: list[_Run], next_step: dict | None) -> str | None:
        """부분 실패 정책. 멈출 실패면 사유 코드, 계속이면 None (다음 단계의 Join Guard가 막을 때도 None)."""
        failed = [run for run in runs if not run.ok]
        if not failed:
            return None
        policy = self.plan["failurePolicy"]
        if policy == FAIL_FAST:
            fatal = failed
        elif policy == "best_effort":  # 끝까지 간다. 단계 전체가 실패하면 뒤 단계가 쓸 입력이 없어 멈춘다
            fatal = failed if len(failed) == len(runs) else []
        else:  # required_optional: 선택 Worker 실패는 빼고 계속
            fatal = [run for run in failed if run.worker_id in step["required"]]
        if not fatal:
            return None
        if any(run.timed_out for run in fatal):
            return TIMEOUT
        if next_step is not None and next_step["join"] and step["id"] in next_step["dependsOn"]:
            return None
        return AGENT_FAILED

    def _inputs(self, step: dict) -> dict[str, dict]:
        """앞 단계 전부의 Worker 중 결과가 있는 것 {Worker id: 결과}."""
        results = self.report.results or {}
        return {wid: results[wid] for wid in guards.upstream_workers(self.plan, step) if wid in results}

    def _results(self) -> dict[str, dict]:
        """지금까지의 결과 전부를 실행 계획의 Worker 순서로 (PostgreSQL jsonb는 키 순서를 지키지 않는다)."""
        results = self.report.results or {}
        return {wid: results[wid] for wid in self.defs if wid in results}

    # ------------------------------------------------------------------ 검토 반복과 Handoff

    def _review(self, step: dict, run: _Run) -> str | None:
        """검토 결과(ReviewResult)의 verdict. PASS → None, RETRY → target을 고쳐 쓰게 하고 다시 검토, FAIL·한도 초과 → review_failed.

        다시 도는 검토 Worker에는 retry={round, review: 직전 검토, draft: 그 검토가 본 target 결과}를 준다 (target에는 주지 않는다).
        review_failed면 남은 지적 줄을 workflow_failed.details.message로 남긴다 (지적이 없으면 "검토 판정 FAIL" 또는 "검토 판정 RETRY").
        """
        retry = step["retry"] or {}
        target, max_rounds = retry.get("target"), retry.get("maxRounds", 0)
        rounds = 0
        while True:
            review = run.result
            if review["verdict"] == "PASS":
                return None
            if review["verdict"] != "RETRY" or target is None or rounds >= max_rounds:
                self.failure_message = _short(" / ".join(_issue_lines(review["issues"])) or f"검토 판정 {review['verdict']}")
                return REVIEW_FAILED
            rounds += 1
            state.record(self.report, ORCHESTRATOR, "review_retry", "started", details={
                "round": rounds, "target": target, "issues": _issue_lines(review["issues"]),
                "instructions": review["instructions"]})
            target_step = self.step_of[target]
            previous = (self.report.results or {}).get(target)
            redo = self._again(target_step, target, {**self.inputs_used.get(target, {}), target: previous},
                               instructions=review["instructions"])
            if not redo.ok:
                return TIMEOUT if redo.timed_out else AGENT_FAILED
            run = self._again(step, run.worker_id, self._inputs(step),
                              retry={"round": rounds, "review": review, "draft": previous})
            if not run.ok:
                return TIMEOUT if run.timed_out else AGENT_FAILED

    def _again(self, step: dict, wid: str, inputs: dict, *, instructions: str | None = None,
               retry: dict | None = None) -> _Run:
        """검토 반복으로 Worker 하나를 다시 실행한다 (attempt + 1, 그 Worker 단계의 제한 시간을 새로)."""
        state.set_step(self.report, step["id"])
        timeout_sec = _timeout(step)
        run = self._new_run(wid, step, inputs, instructions=instructions, retry=retry)
        self._execute([run], healing.clock() + timeout_sec, timeout_sec, parallel=False)
        return run

    def _handoff(self, step: dict, frm: str) -> None:
        """검토가 PASS이고 결과에 handoff가 있으면 Handoff Guard를 거쳐 to Worker를 실행한다. 거절·실패해도 계속한다."""
        request = (self.report.results or {}).get(frm, {}).get("handoff")
        if not request:
            return
        report, to = self.report, request["to"]
        route = next((item for item in self.plan["handoffs"] if item["from"] == frm and item["to"] == to), None)
        results = self._results()
        payload = {
            "task_id": f"report-{report.pk}", "trace_id": f"report-{report.pk}", "from_agent": frm, "to_agent": to,
            "objective": route["responsibility"] if route else None,
            "inputs": {"memory_refs": list(results)}, "constraints": list(HANDOFF_CONSTRAINTS),
            "expected_output": self.defs.get(to, {}).get("outputContract"), "attempt": self.attempts.get(to, 0) + 1,
            "user_id": report.user_id or "auto", "hop_count": self.hops + 1, "reason": request.get("reason"),
        }
        details = {"from": frm, "to": to, "hopCount": self.hops + 1}
        decision = guards.handoff(report, self.plan, frm, to, payload, self.hops)
        if not decision.ok:
            state.record(report, HANDOFF_GUARD, "handoff_blocked", "blocked", details={**details, "reason": decision.reason})
            return
        self.hops += 1
        details["reason"] = request.get("reason")
        state.record(report, HANDOFF_GUARD, "handoff_started", "started", details=details)
        timeout_sec = _timeout(step)
        run = self._new_run(to, step, results, handoff=payload)
        self._execute([run], healing.clock() + timeout_sec, timeout_sec, parallel=False)
        state.record(report, HANDOFF_GUARD, "handoff_completed", "completed", details={**details, "ok": run.ok})

    # ------------------------------------------------------------------ Worker 실행

    def _new_run(self, wid: str, step: dict, inputs: dict, *, instructions=None, handoff=None, retry=None) -> _Run:
        self.attempts[wid] = self.attempts.get(wid, 0) + 1
        self.inputs_used[wid] = inputs
        return _Run(wid, self.attempts[wid], step["id"], inputs, instructions, handoff, retry)

    def _execute(self, runs: list[_Run], deadline: float, timeout_sec: float, *, parallel: bool) -> None:
        """runs를 실행기로 돌리고 deadline(+여유)까지 기다린다. 병렬이면 같이, 아니면 하나씩. 끝나지 않은 것은 버린다."""
        for batch in ([runs] if parallel else [[run] for run in runs]):
            for run in batch:
                self.started.add(run.worker_id)
                run.began = time.monotonic()
                state.record(self.report, run.worker_id, "agent_started", "started",
                             details={"attempt": run.attempt, "step": run.step_id})
            executor = make_executor(len(batch))
            try:
                futures = [executor.submit(self._work, run, deadline) for run in batch]
                done, _ = concurrent.futures.wait(futures, timeout=max(0.0, deadline - healing.clock()) + STEP_GRACE_SEC)
            finally:
                executor.shutdown(wait=False, cancel_futures=True)
            for run in batch:  # _abandon은 run.lock을 잡으므로 스레드가 결과를 쓰는 중이면 다 쓸 때까지 기다린다
                self._abandon(run, timeout_sec)
            for future in done:
                error = future.exception()
                if error is not None:  # 결과를 State에 쓰다가 난 오류 (Worker 실패는 _work 안에서 기록한다)
                    raise error

    def _work(self, run: _Run, deadline: float) -> None:
        """실행기 안에서 Worker 하나를 돌리고 결과를 남긴다. 풀 스레드였으면 끝에 그 스레드의 DB 연결을 닫는다."""
        try:
            self._attempt(run, deadline)
        finally:
            if threading.current_thread() is not self.thread:
                connections.close_all()

    def _attempt(self, run: _Run, deadline: float) -> None:
        definition = self.defs[run.worker_id]
        try:
            run.caller = healing.make_caller(self.report, definition, self.report.chaos, self.llm, deadline)
            worker = self.workers.get(run.worker_id)
            if worker is None:
                raise LookupError(f"등록된 Worker가 없습니다: {run.worker_id}")
            raw = worker.run(self._context(run, deadline))
            if not isinstance(raw, dict):
                raise contracts.ContractError("Worker 결과가 JSON 객체가 아닙니다.")
            result = {key: value for key, value in raw.items() if not str(key).startswith("_")}
            guarded = _guarded(raw.get("_guarded"))
            changed = _changed(raw.get("_changed"))
            result = contracts.validate(definition["outputContract"], result)
            result = tidy.tidy_result(definition["outputContract"], result)  # 금액 쉼표·의견 영어·쉬운 글 용어 풀이
        except Exception as error:
            self._failed(run, error, timed_out=healing.clock() >= deadline)
        else:
            self._completed(run, result, guarded, changed)

    def _context(self, run: _Run, deadline: float) -> WorkerContext:
        report = self.report
        return WorkerContext(
            report_id=report.pk, task_id=f"report-{report.pk}", symbol=report.symbol, name=report.name,
            market=report.market, worker_id=run.worker_id, attempt=run.attempt, inputs=copy.deepcopy(run.inputs),
            instructions=run.instructions, handoff=copy.deepcopy(run.handoff), llm=run.caller, deadline=deadline,
            cfg=self.cfg, client=self.client, team_inputs=self.team_inputs, retry=copy.deepcopy(run.retry))

    def _completed(self, run: _Run, result: dict, guarded: list[str], changed: list[str] | None = None) -> None:
        caller, report, wid = run.caller, self.report, run.worker_id
        with run.lock:
            if run.settled:  # 이미 시간 초과로 버렸다
                return
            run.settled, run.ok, run.result = True, True, result
            state.add_result(report, wid, result)
            recovered = [call for call in caller.calls if call.recovered]
            recovery = [call.recovery_ms for call in recovered if call.recovery_ms is not None]
            details = {"attempts": caller.attempt, "recovered": bool(recovered),
                       "recoveryMs": sum(recovery) if recovery else None, "costUsd": round(caller.cost_usd, 6),
                       "guarded": guarded}
            if changed is not None:  # 선정 Worker가 검토 RETRY로 다시 쓴 곳 ([]이면 아무것도 고치지 않았다)
                details["changed"] = changed
            if self.defs[wid]["outputContract"] == registry.REVIEW_CONTRACT:
                details.update(verdict=result["verdict"], score=result["score"])
                if result.get(contracts.REVIEW_ACCEPTED):  # 선정 검토의 마지막 검토가 지적을 남긴 채 통과
                    details[contracts.REVIEW_ACCEPTED] = True
            last = caller.calls[-1] if caller.calls else None
            state.record(report, wid, "agent_completed", "completed", provider=last.provider if last else None,
                         model=last.model if last else None, latency_ms=_ms(time.monotonic() - run.began),
                         details=details)
            self._charge(caller)

    def _failed(self, run: _Run, error: Exception, *, timed_out: bool) -> None:
        if isinstance(error, healing.LlmGaveUp):
            error_type, message, model = error.error_type.value, error.message, error.last_model
        elif isinstance(error, WorkerError):
            error_type, message, model = "worker_error", str(error), None
        elif isinstance(error, contracts.ContractError):
            error_type, message, model = "bad_output", f"출력 계약 위반: {error}", None
        else:
            error_type, message, model = "exception", f"{type(error).__name__}: {error}", None
        with run.lock:
            if run.settled:
                return
            run.settled, run.timed_out = True, timed_out
            self._record_failure(run, error_type, message or error_type, model)

    def _abandon(self, run: _Run, timeout_sec: float) -> None:
        """제한 시간 안에 끝나지 않은 Worker를 시간 초과 실패로 남긴다. 스레드가 나중에 끝나도 아무것도 쓰지 않는다."""
        with run.lock:
            if run.settled:
                return
            run.settled, run.timed_out = True, True
            self._record_failure(run, healing.ErrorType.TIMEOUT.value, f"단계 제한 시간({timeout_sec:g}초)을 넘겼습니다", None)

    def _record_failure(self, run: _Run, error_type: str, message: str, model: str | None) -> None:
        """add_error + agent_failed(final: true) + 비용. run.lock 안에서 부른다."""
        caller, wid = run.caller, run.worker_id
        message = _short(message)
        state.add_error(self.report, wid, message)
        state.record(self.report, wid, "agent_failed", "failed", provider=self.defs[wid].get("provider"), model=model,
                     latency_ms=_ms(time.monotonic() - run.began),
                     details={"errorType": error_type, "attempts": caller.attempt if caller else 0, "final": True,
                              "message": message})
        if caller is not None:
            self._charge(caller)

    def _charge(self, caller: healing.LlmCaller) -> None:
        if caller.cost_usd > 0:
            state.add_cost(self.report, caller.cost_usd)


# ---------------------------------------------------------------------- 도우미

def _timeout(step: dict) -> float:
    return step.get("timeoutSec") or DEFAULT_STEP_TIMEOUT_SEC


def _ms(seconds: float) -> int:
    return max(int(seconds * 1000), 0)


def _short(text: str, limit: int = MESSAGE_MAX) -> str:
    text = " ".join(str(text).split())
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _message(error: Exception) -> str:
    text = str(error)
    return _short(text if isinstance(error, WorkerError) and text else f"{type(error).__name__}: {text}")


def _guarded(value) -> list[str]:
    """Worker 결과의 `_guarded` (입력 Guard가 지운 사유 코드 목록)."""
    if value is None:
        return []
    items = value if isinstance(value, (list, tuple)) else [value]
    return list(dict.fromkeys(str(item) for item in items))


def _changed(value) -> list[str] | None:
    """Worker 결과의 `_changed` (선정 Worker가 다시 쓸 때 이전 선정안과 달라진 곳). 목록이 아니면 None — details에 넣지 않는다."""
    return [str(item) for item in value] if isinstance(value, (list, tuple)) else None


def _issue_lines(issues) -> list[str]:
    """검토 지적({claim, problem, fix}) → review_retry.details.issues의 한 줄 글 (화면이 글 목록으로 보여 준다)."""
    lines = []
    for issue in issues or []:
        if isinstance(issue, dict):
            line = " — ".join(part for part in (issue.get("claim"), issue.get("problem")) if part)
        else:
            line = str(issue)
        if line:
            lines.append(_short(line, 200))
    return lines


def _risk_block(risk: dict) -> str:
    """리스크 점검 결과 → 본문 맨 위 경고 블록."""
    level = RISK_LEVEL_TEXT.get(risk.get("level"), risk.get("level") or "")
    lines = [f"> ⚠️ **리스크 점검 ({level})**: {_cell(risk.get('summary') or '')}"]
    lines += [f"> - {_cell(warning)}" for warning in risk.get("warnings") or []]
    return "\n".join(lines)


def _selection_content(draft: dict, candidates: list, review: dict | None = None) -> str:
    """선정 팀 본문: 요약 + 순위표 (순위·종목·고른 이유).

    검토가 지적을 남긴 채 통과했으면(review의 acceptedWithNotes) 안전장치 문장 바로 앞에 검토 메모 한 줄을 넣는다.
    지적(issues)이 비고 수정 지시만 남은 RETRY였으면 건수 대신 "수정 의견"이라고 쓴다.
    """
    names = {str(item.get("symbol")): item.get("name") for item in candidates if isinstance(item, dict)}
    rows = []
    for pick in draft["picks"]:
        name = names.get(pick["symbol"])
        label = f"{name} ({pick['symbol']})" if name else pick["symbol"]
        rows.append(f"| {pick['rank']} | {_cell(label)} | {_cell(pick['reason'])} |")
    note = []
    if isinstance(review, dict) and review.get(contracts.REVIEW_ACCEPTED) is True:
        count = len(review.get("issues") or [])
        left = f"검토 AI의 지적 {count}건이" if count else "검토 AI의 수정 의견이"
        note = [f"검토 메모: 고쳐 쓰기 횟수를 다 쓴 뒤에도 {left} 남았다. "
                "코드 점검(후보 표 밖 종목·고위험 공시·권유 표현·가격)은 통과해 이 선정안을 그대로 썼다.", ""]
    return "\n".join([
        "## 오늘의 매매 종목 선정안 (AI 선정 팀)", "", draft["summary"], "",
        "| 순위 | 종목 | 고른 이유 |", "|---|---|---|", *rows, "", *note,
        "최종 종목은 안전장치(선정 Guard)를 거쳐 정해진다: 후보 밖·투자유의·고위험 공시 종목을 빼고, 같은 테마는 2개까지.",
    ])


def _cell(text) -> str:
    return " ".join(str(text).split()).replace("|", "\\|")
