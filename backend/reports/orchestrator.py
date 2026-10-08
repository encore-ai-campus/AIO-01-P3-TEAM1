"""YAML 실행 계획에 따라 리포트 Worker를 실행한다."""

from __future__ import annotations

import time
from concurrent.futures import Future, ThreadPoolExecutor, TimeoutError as FutureTimeout
from dataclasses import dataclass

from django.db import connections

from config import engine

from . import contracts, guards, healing, registry, state
from .agents import WORKERS
from .agents.base import WorkerContext, WorkerError
from .models import Report

FAILURE_REASONS = {"join_blocked", "review_failed", "timeout", "engine_restarted", "expired", "exception"}


@dataclass
class WorkerRun:
    worker_id: str
    attempt: int
    caller: healing.LlmCaller
    future: Future
    handoff: dict | None = None


@dataclass
class WorkerOutcome:
    worker_id: str
    attempt: int
    caller: healing.LlmCaller
    result: dict | None = None
    guarded: list[str] | None = None
    error: Exception | None = None
    timed_out: bool = False


def run_report(report: Report, *, workers=None, llm_client=None, now=None) -> Report:
    """리포트 하나를 끝까지 실행한다. 실패도 예외를 내보내지 않고 ``failed``로 끝낸다."""
    del now  # 외부 API 호환용. 실행 제한은 반드시 monotonic clock을 쓴다.
    started = time.monotonic()
    worker_attempts: dict[str, int] = {}
    failure_reason: str | None = None

    try:
        if report.status == Report.REQUESTED:
            state.start(report)
        elif report.status != Report.RUNNING or report.trace_events.exists():
            return report
        plan = registry.execution_plan()
        worker_map = WORKERS if workers is None else workers
        client = healing.llm_client() if llm_client is None else llm_client
        state.record(report, "orchestrator", "workflow_started", "started", details={
            "chaos": bool(getattr(report, "chaos", None)),
            "source": getattr(report, "source", "user"),
        })

        steps = plan["steps"]
        for index, step in enumerate(steps):
            state.set_step(report, step["id"])
            decision = guards.join(report, step, plan)
            if step.get("dependsOn"):
                _record_join(report, step, plan, decision)
            cannot_proceed = (
                (not decision.ok and plan["failurePolicy"] != "best_effort")
                or ("report_agent" in step["workers"] and bool(step.get("dependsOn")) and not decision.inputs)
                or ("review_agent" in step["workers"] and "report_agent" not in decision.inputs)
            )
            if cannot_proceed:
                failure_reason = "join_blocked"
                _skip_from(report, steps[index:], "join_blocked")
                break

            outcomes = _run_step(
                report, step, plan, worker_map, client, decision.inputs, worker_attempts,
            )
            required_failures = [outcome for outcome in outcomes if outcome.worker_id in step["required"] and outcome.error]
            any_failures = [outcome for outcome in outcomes if outcome.error]
            blocking = any_failures if plan["failurePolicy"] == "fail_fast" else required_failures
            if blocking and plan["failurePolicy"] != "best_effort":
                failure_reason = "timeout" if any(outcome.timed_out for outcome in blocking) else "join_blocked"
                skip_reason = "fail_fast" if plan["failurePolicy"] == "fail_fast" else "join_blocked"
                _skip_from(report, steps[index + 1:], skip_reason)
                break

            if "review_agent" in step["workers"]:
                review = report.results.get("review_agent")
                failure_reason = _review_loop(
                    report, step, plan, worker_map, client, worker_attempts, review,
                )
                if failure_reason:
                    _skip_from(report, steps[index + 1:],
                               "review_failed" if failure_reason == "review_failed" else "join_blocked")
                    break
                review = report.results.get("review_agent")
                if review and review.get("handoff"):
                    _run_handoff(report, plan, worker_map, client, worker_attempts, review["handoff"])

        if failure_reason:
            return _fail(report, failure_reason, started)

        draft = report.results.get("report_agent") or {}
        if not draft.get("markdown") or ("review_agent" not in report.results):
            return _fail(report, "join_blocked", started)
        content = draft["markdown"]
        risk = report.results.get("risk_agent")
        if risk:
            warnings = risk.get("warnings") or []
            if warnings:
                content = "> ⚠️ 리스크 점검: " + "; ".join(warnings) + "\n\n" + content
        state.record(report, "orchestrator", "workflow_completed", "completed", details={
            "reason": None,
            "costUsd": _report_cost(report),
            "durationMs": _ms(time.monotonic() - started),
        })
        return state.finish(report, Report.COMPLETED, content)
    except Exception:
        if report.status in Report.FINISHED:
            return report
        if report.status == Report.REQUESTED:
            state.start(report)
        return _fail(report, "exception", started)


def _run_step(report, step, plan, workers, client, inputs, attempts) -> list[WorkerOutcome]:
    deadline = time.monotonic() + (step.get("timeoutSec") or 60)
    if step["mode"] == "sequential":
        outcomes = []
        for worker_id in step["workers"]:
            run = _prepare_run(report, step, plan, workers, client, inputs, attempts, worker_id, deadline)
            outcomes.append(_collect(report, run, deadline))
        return outcomes
    executor = ThreadPoolExecutor(max_workers=len(step["workers"]), thread_name_prefix=f"report-{report.pk}-{step['id']}")
    try:
        runs = [
            _prepare_run(report, step, plan, workers, client, inputs, attempts, worker_id, deadline,
                         executor=executor)
            for worker_id in step["workers"]
        ]
    finally:
        executor.shutdown(wait=False)
    return [_collect(report, run, deadline) for run in runs]


def _prepare_run(report, step, plan, workers, client, inputs, attempts, worker_id, deadline,
                 instructions=None, handoff=None, executor=None) -> WorkerRun:
    attempts[worker_id] = attempts.get(worker_id, 0) + 1
    worker_attempt = attempts[worker_id]
    state.record(report, worker_id, "agent_started", "started", details={
        "attempt": worker_attempt,
        "step": step["id"],
    })
    specs = {item["id"]: item for item in plan["workers"]}
    caller = healing.make_caller(
        report,
        specs[worker_id],
        getattr(report, "chaos", None),
        client,
        deadline,
    )
    ctx = WorkerContext(
        report_id=report.pk,
        task_id=f"report-{report.pk}",
        symbol=report.symbol,
        name=report.name,
        market=report.market,
        worker_id=worker_id,
        attempt=worker_attempt,
        inputs=inputs,
        instructions=instructions,
        handoff=handoff,
        llm=caller,
        deadline=deadline,
        cfg=engine.engine_config(),
        client=engine.broker_client(),
    )
    owned_executor = executor is None
    if executor is None:
        executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f"report-{report.pk}-{worker_id}")
    future = executor.submit(_invoke, workers[worker_id], ctx)
    # Python 스레드는 강제로 중단할 수 없다. future가 끝나면 스스로 정리하되,
    # Orchestrator는 단계 deadline 뒤 결과를 받지 않는다.
    if owned_executor:
        executor.shutdown(wait=False)
    return WorkerRun(worker_id, worker_attempt, caller, future, handoff)


def _invoke(worker, ctx) -> tuple[dict, list[str]]:
    try:
        raw = worker.run(ctx)
        public = {key: value for key, value in raw.items() if not key.startswith("_")}
        guarded = raw.get("_guarded") or []
        return contracts.validate(worker.output_contract, public), list(guarded)
    finally:
        connections.close_all()


def _collect(report, run: WorkerRun, deadline: float) -> WorkerOutcome:
    remaining = deadline - time.monotonic()
    if remaining <= 0 and not run.future.done():
        return _record_failure(report, run, TimeoutError("단계 제한 시간을 넘었습니다."), timed_out=True)
    try:
        result, guarded = run.future.result(timeout=max(remaining, 0))
    except FutureTimeout:
        return _record_failure(report, run, TimeoutError("단계 제한 시간을 넘었습니다."), timed_out=True)
    except Exception as error:
        return _record_failure(report, run, error, timed_out=isinstance(error, TimeoutError))

    state.add_cost(report, run.caller.cost_usd)
    state.add_result(report, run.worker_id, result)
    replies = run.caller.calls
    reply = replies[-1] if replies else None
    details = {
        "attempts": run.caller.attempt,
        "recovered": bool(reply and reply.recovered),
        "recoveryMs": None if reply is None else reply.recovery_ms,
        "costUsd": run.caller.cost_usd,
        "guarded": guarded,
    }
    if run.worker_id == "review_agent":
        details.update({"verdict": result.get("verdict"), "score": result.get("score")})
    state.record(
        report,
        run.worker_id,
        "agent_completed",
        "completed",
        provider=None if reply is None else reply.provider,
        model=None if reply is None else reply.model,
        latency_ms=None if reply is None else reply.latency_ms,
        details=details,
    )
    return WorkerOutcome(run.worker_id, run.attempt, run.caller, result=result, guarded=guarded)


def _record_failure(report, run: WorkerRun, error: Exception, *, timed_out: bool) -> WorkerOutcome:
    if isinstance(error, healing.LlmGaveUp):
        error_type = error.error_type.value
        attempts = error.attempts
        timed_out = error.error_type is healing.ErrorType.TIMEOUT
    elif timed_out or isinstance(error, TimeoutError):
        error_type = "timeout"
        attempts = run.caller.attempt
        timed_out = True
    elif isinstance(error, (WorkerError, contracts.ContractError)):
        error_type = "unknown"
        attempts = run.caller.attempt
    else:
        error_type = "unknown"
        attempts = run.caller.attempt
    message = str(error) or type(error).__name__
    state.add_cost(report, run.caller.cost_usd)
    state.add_error(report, run.worker_id, message)
    state.record(report, run.worker_id, "agent_failed", "failed", details={
        "errorType": error_type,
        "attempts": attempts,
        "final": True,
        "message": message,
    })
    return WorkerOutcome(run.worker_id, run.attempt, run.caller, error=error, timed_out=timed_out)


def _review_loop(report, review_step, plan, workers, client, attempts, review) -> str | None:
    retry = review_step.get("retry")
    if review and review.get("verdict") == "PASS":
        return None
    if not review or review.get("verdict") == "FAIL" or retry is None:
        return "review_failed"

    target = retry["target"]
    target_step = next(step for step in plan["steps"] if target in step["workers"])
    for round_number in range(1, retry["maxRounds"] + 1):
        instructions = review.get("instructions")
        state.record(report, "orchestrator", "review_retry", "started", details={
            "round": round_number,
            "target": target,
            "issues": review.get("issues") or [],
            "instructions": instructions,
        })
        compose_inputs = guards.join(report, target_step, plan).inputs
        deadline = time.monotonic() + (target_step.get("timeoutSec") or 60)
        target_run = _prepare_run(
            report, target_step, plan, workers, client, compose_inputs, attempts, target, deadline, instructions,
        )
        target_outcome = _collect(report, target_run, deadline)
        if target_outcome.error:
            return "timeout" if target_outcome.timed_out else "join_blocked"

        review_inputs = guards.join(report, review_step, plan).inputs
        deadline = time.monotonic() + (review_step.get("timeoutSec") or 60)
        review_run = _prepare_run(
            report, review_step, plan, workers, client, review_inputs, attempts, "review_agent", deadline,
        )
        review_outcome = _collect(report, review_run, deadline)
        if review_outcome.error:
            return "timeout" if review_outcome.timed_out else "review_failed"
        review = review_outcome.result
        if review.get("verdict") == "PASS":
            return None
        if review.get("verdict") == "FAIL":
            return "review_failed"
    return "review_failed"


def _run_handoff(report, plan, workers, client, attempts, request) -> None:
    target = request.get("to")
    decision = guards.handoff(report, plan, "review_agent", target, request.get("reason"),
                              attempt=attempts.get(target, 0) + 1)
    details = {"from": "review_agent", "to": target, "hopCount": 0, "reason": decision.reason}
    if not decision.ok:
        state.record(report, "handoff_guard", "handoff_blocked", "blocked", details=details)
        return
    details["hopCount"] = decision.payload["hop_count"]
    state.record(report, "handoff_guard", "handoff_started", "started", details=details)
    inputs = {key: report.results[key] for key in decision.payload["inputs"]["memory_refs"]}
    step = {"id": "review", "workers": [target], "timeoutSec": 60}
    deadline = time.monotonic() + step["timeoutSec"]
    run = _prepare_run(report, step, plan, workers, client, inputs, attempts, target, deadline,
                       handoff=decision.payload)
    outcome = _collect(report, run, deadline)
    state.record(report, "handoff_guard", "handoff_completed", "completed", details={
        **details, "reason": None if outcome.error is None else "risk_worker_failed",
    })


def _record_join(report, step, plan, decision: guards.JoinDecision) -> None:
    state.record(
        report,
        "join_guard",
        "join_completed" if decision.ok else "join_blocked",
        "completed" if decision.ok else "blocked",
        details={
            "step": step["id"],
            "required": _dependency_required(step, plan),
            "missing": decision.missing,
            "inputs": list(decision.inputs),
        },
    )


def _dependency_required(step: dict, plan: dict) -> list[str]:
    steps = {item["id"]: item for item in plan["steps"]}
    required = []
    seen = set()

    def visit(step_id: str) -> None:
        dependency = steps[step_id]
        for parent in dependency.get("dependsOn", []):
            visit(parent)
        for worker_id in dependency.get("required", []):
            if worker_id not in seen:
                seen.add(worker_id)
                required.append(worker_id)

    for dependency_id in step.get("dependsOn", []):
        visit(dependency_id)
    return required


def _skip_from(report, steps, reason: str) -> None:
    seen = set(report.completed_agents) | set(report.failed_agents)
    for step in steps:
        for worker_id in step["workers"]:
            if worker_id in seen:
                continue
            state.record(report, worker_id, "agent_skipped", "skipped", details={"reason": reason})
            seen.add(worker_id)


def _fail(report, reason: str, started: float) -> Report:
    if reason not in FAILURE_REASONS:
        reason = "exception"
    state.record(report, "orchestrator", "workflow_failed", "failed", details={
        "reason": reason,
        "costUsd": _report_cost(report),
        "durationMs": _ms(time.monotonic() - started),
    })
    return state.finish(report, Report.FAILED)


def _report_cost(report) -> float:
    return float(getattr(report, "cost_usd", 0.0) or 0.0)


def _ms(seconds: float) -> int:
    return max(int(seconds * 1_000), 0)
