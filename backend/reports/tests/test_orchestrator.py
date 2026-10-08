"""Orchestrator (T3-3·T3-5~T3-9·T3-12): 정상 경로, 부분 실패 정책, Join Guard, 시간 초과, 검토 반복, Handoff, 실패 사유 코드.

Worker는 가짜(FakeWorker), LLM은 FakeLlm이다 (실제 LLM·증권사를 부르지 않는다). 대부분 스레드 없이(inline_workers) 돌고,
실제 스레드 시험 두 개만 transaction=True로 돈다.
"""
import copy
import threading
import time

import pytest

from config import engine
from reports import healing, orchestrator, registry, state
from reports.agents.base import WorkerError
from reports.models import Report

from .conftest import FAIL_REVIEW, RETRY_REVIEW, SAMPLES, FakeLlm, FakeWorker, fake_team, make_report

RESEARCH = ["market_agent", "fundamental_agent", "news_agent"]
DRAFT2 = {**SAMPLES["ReportDraft"], "markdown": "# 삼성전자\n\n고친 본문"}
CANDIDATES = [{"symbol": "005930", "name": "삼성전자", "score": 80}, {"symbol": "000660", "name": "SK하이닉스", "score": 70}]


@pytest.fixture(autouse=True)
def no_broker(monkeypatch):
    monkeypatch.setattr(engine, "broker_client", lambda: None)


@pytest.fixture
def clock(monkeypatch):
    """가짜 시계 (healing.clock·healing.sleep — Orchestrator의 deadline도 같은 시계)."""
    now = {"t": 1000.0}

    def sleep(seconds):
        now["t"] += seconds
    monkeypatch.setattr(healing, "clock", lambda: now["t"])
    monkeypatch.setattr(healing, "sleep", sleep)
    now["sleep"] = sleep
    return now


def patch_plan(monkeypatch, team=registry.TEAM, steps=None, **changes):
    """Orchestrator가 읽는 실행 계획을 바꾼다 (state가 보는 step·Worker id는 그대로). steps={step id: {키: 값}}."""
    plan = registry.execution_plan(team)
    for step in plan["steps"]:
        step.update((steps or {}).get(step["id"], {}))
    plan.update(changes)
    original = registry.execution_plan
    monkeypatch.setattr(registry, "execution_plan", lambda t=registry.TEAM: copy.deepcopy(plan) if t == team else original(t))
    return plan


def run(report, workers, llm=None):
    return orchestrator.run_report(report, workers=workers, llm_client=llm or FakeLlm({}))


def trace(report):
    return [(e.actor, e.action, e.status, e.details) for e in report.trace_events.order_by("step")]


def actions(report):
    return [(actor, action) for actor, action, _, _ in trace(report)]


def event(report, actor, action, index=-1):
    found = [e for e in report.trace_events.order_by("step") if e.actor == actor and e.action == action]
    return found[index]


def failure(report):
    return event(report, "orchestrator", "workflow_failed").details["reason"]


pytestmark = [pytest.mark.django_db, pytest.mark.usefixtures("inline_workers")]


# ---------------------------------------------------------------------- 정상 경로

def test_normal_path_trace_order_and_state(user):
    report = make_report(user)
    workers = fake_team()
    run(report, workers)

    assert actions(report) == [
        ("orchestrator", "workflow_started"),
        *[(wid, "agent_started") for wid in RESEARCH], *[(wid, "agent_completed") for wid in RESEARCH],
        ("join_guard", "join_completed"),
        ("report_agent", "agent_started"), ("report_agent", "agent_completed"),
        ("review_agent", "agent_started"), ("review_agent", "agent_completed"),
        ("orchestrator", "workflow_completed"),
    ]
    report.refresh_from_db()
    assert report.status == Report.COMPLETED and report.current_step is None
    assert report.completed_agents == [*RESEARCH, "report_agent", "review_agent"] and report.failed_agents == []
    assert report.results["report_agent"] == SAMPLES["ReportDraft"]
    assert report.content == SAMPLES["ReportDraft"]["markdown"]
    assert event(report, "orchestrator", "workflow_started").details == {
        "chaos": False, "source": "user", "team": "stock_report"}
    assert event(report, "market_agent", "agent_started").details == {"attempt": 1, "step": "parallel_research"}
    assert event(report, "join_guard", "join_completed").details == {
        "step": "compose", "required": ["market_agent", "fundamental_agent"], "missing": [], "inputs": RESEARCH}
    review = event(report, "review_agent", "agent_completed").details
    assert review["verdict"] == "PASS" and review["score"] == 85 and review["attempts"] == 0 and review["guarded"] == []
    done = event(report, "orchestrator", "workflow_completed").details
    assert done["costUsd"] == 0 and isinstance(done["durationMs"], int)

    research_ctx = workers["market_agent"].calls[0]
    assert research_ctx.inputs == {} and research_ctx.task_id == f"report-{report.pk}" and research_ctx.team_inputs is None
    assert research_ctx.symbol == "005930" and research_ctx.attempt == 1 and research_ctx.instructions is None
    assert set(workers["report_agent"].calls[0].inputs) == set(RESEARCH)
    assert set(workers["review_agent"].calls[0].inputs) == {*RESEARCH, "report_agent"}
    assert workers["risk_agent"].calls == []


def test_agent_completed_details_from_healing_caller(user, fake_llm):
    """Worker가 ctx.llm을 부르면 호출기의 시도 수·복구·모델·비용이 agent_completed와 Report.cost_usd에 남는다."""
    report = make_report(user)
    market = FakeWorker("market_agent", llm=True, contract="MarketResult")
    client = fake_llm({"gemini-3.8-flash": ["bad_output", SAMPLES["MarketResult"]]}, cost=0.02)
    run(report, fake_team(market_agent=market), client)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    assert actions(report)[4:7] == [("market_agent", "agent_failed"), ("market_agent", "agent_retry"),
                                    ("market_agent", "agent_completed")]
    done = event(report, "market_agent", "agent_completed")
    assert done.provider == "devpass" and done.model == "gemini-3.8-flash" and isinstance(done.latency_ms, int)
    assert done.details["attempts"] == 2 and done.details["recovered"] is True
    assert isinstance(done.details["recoveryMs"], int) and done.details["costUsd"] == 0.02
    assert report.cost_usd == pytest.approx(0.02)
    assert event(report, "orchestrator", "workflow_completed").details["costUsd"] == 0.02


def test_guarded_keys_are_removed_and_recorded(user):
    report = make_report(user)
    news = {**SAMPLES["NewsResult"], "_guarded": ["instruction", "secret"], "_debug": "지움"}
    run(report, fake_team(news_agent=news))

    report.refresh_from_db()
    assert report.results["news_agent"] == SAMPLES["NewsResult"]
    assert event(report, "news_agent", "agent_completed").details["guarded"] == ["instruction", "secret"]


# ---------------------------------------------------------------------- 부분 실패 정책·Join Guard

def test_optional_research_failure_continues(user):
    report = make_report(user)
    workers = fake_team(news_agent=WorkerError("뉴스를 가져오지 못했습니다"))
    run(report, workers)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    assert report.errors == {"news_agent": "뉴스를 가져오지 못했습니다"} and report.failed_agents == ["news_agent"]
    failed = event(report, "news_agent", "agent_failed").details
    assert failed == {"errorType": "worker_error", "attempts": 0, "final": True, "message": "뉴스를 가져오지 못했습니다"}
    assert event(report, "join_guard", "join_completed").details["inputs"] == ["market_agent", "fundamental_agent"]
    assert set(workers["report_agent"].calls[0].inputs) == {"market_agent", "fundamental_agent"}


def test_required_failure_blocks_join_and_skips_later_workers(user):
    report = make_report(user)
    gave_up = healing.LlmGaveUp(healing.ErrorType.SERVER_ERROR, 4, "gpt-5.6-luna", "market_agent: 서버 오류")
    workers = fake_team(market_agent=gave_up)
    run(report, workers)

    report.refresh_from_db()
    assert report.status == Report.FAILED and report.content is None
    assert actions(report)[-5:] == [
        ("news_agent", "agent_completed"), ("join_guard", "join_blocked"),
        ("report_agent", "agent_skipped"), ("review_agent", "agent_skipped"),
        ("orchestrator", "workflow_failed"),
    ]
    failed = event(report, "market_agent", "agent_failed")
    assert failed.details["errorType"] == "server_error" and failed.details["final"] is True
    assert failed.model == "gpt-5.6-luna"
    assert event(report, "join_guard", "join_blocked").details["missing"] == ["market_agent"]
    assert event(report, "report_agent", "agent_skipped").details == {"reason": "join_blocked"}
    assert failure(report) == "join_blocked"
    assert workers["report_agent"].calls == []


def test_fail_fast_stops_on_optional_failure(user, monkeypatch):
    patch_plan(monkeypatch, failurePolicy="fail_fast")
    report = make_report(user)
    run(report, fake_team(news_agent=WorkerError("뉴스 없음")))

    report.refresh_from_db()
    assert report.status == Report.FAILED
    assert event(report, "join_guard", "join_blocked").details["missing"] == ["news_agent"]
    assert event(report, "review_agent", "agent_skipped").details == {"reason": "fail_fast"}
    assert failure(report) == "join_blocked"


def test_best_effort_writes_with_any_result(user, monkeypatch):
    patch_plan(monkeypatch, failurePolicy="best_effort")
    report = make_report(user)
    workers = fake_team(market_agent=WorkerError("시세 없음"), fundamental_agent=WorkerError("재무 없음"))
    run(report, workers)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    joined = event(report, "join_guard", "join_completed").details
    assert joined["missing"] == ["market_agent", "fundamental_agent"] and joined["inputs"] == ["news_agent"]
    assert set(workers["report_agent"].calls[0].inputs) == {"news_agent"}


def test_best_effort_stops_when_whole_step_failed(user, monkeypatch):
    patch_plan(monkeypatch, failurePolicy="best_effort")
    report = make_report(user)
    run(report, fake_team(**{wid: WorkerError("없음") for wid in RESEARCH}))

    report.refresh_from_db()
    assert report.status == Report.FAILED and failure(report) == "join_blocked"


def test_worker_exception_and_contract_violation(user):
    report = make_report(user)
    run(report, fake_team(market_agent=RuntimeError("터짐"), fundamental_agent={"summary": "metrics 빠짐"}))

    market = event(report, "market_agent", "agent_failed").details
    assert market["errorType"] == "exception" and market["message"] == "RuntimeError: 터짐"
    fundamental = event(report, "fundamental_agent", "agent_failed").details
    assert fundamental["errorType"] == "bad_output" and fundamental["message"].startswith("출력 계약 위반")
    assert failure(report) == "join_blocked"


def test_required_failure_without_join_is_agent_failed(user):
    """작성 Worker가 끝내 실패하면 다음 단계(검토)는 Join이 아니므로 agent_failed."""
    report = make_report(user)
    run(report, fake_team(report_agent=WorkerError("조사 결과가 모자랍니다")))

    report.refresh_from_db()
    assert report.status == Report.FAILED and failure(report) == "agent_failed"
    assert event(report, "review_agent", "agent_skipped").details == {"reason": "agent_failed"}


# ---------------------------------------------------------------------- 시간 초과

def test_step_timeout_with_fake_clock(user, clock, fake_llm):
    """필수 Worker의 호출이 단계 제한 시간(180초)을 다 쓰면 Join 앞이어도 timeout으로 끝난다."""
    report = make_report(user)
    market = FakeWorker("market_agent", llm=True, contract="MarketResult")
    client = fake_llm({"gemini-3.8-flash": [{"__delay__": 999}, {"__delay__": 999}],
                       "gpt-5.6-luna": [{"__delay__": 999}]}, sleep=clock["sleep"])
    run(report, fake_team(market_agent=market), client)

    report.refresh_from_db()
    assert report.status == Report.FAILED and failure(report) == "timeout"
    final = event(report, "market_agent", "agent_failed").details
    assert final["final"] is True and final["errorType"] == "timeout" and final["attempts"] == 2
    assert ("join_guard", "join_blocked") not in actions(report)
    assert event(report, "report_agent", "agent_skipped").details == {"reason": "timeout"}


@pytest.mark.django_db(transaction=True)
def test_step_timeout_abandons_running_worker(user, monkeypatch):
    """실제 스레드: 제한 시간 안에 끝나지 않은 Worker는 버려지고, 나중에 끝나도 State·Trace를 쓰지 않는다."""
    monkeypatch.setattr(orchestrator, "make_executor", _real_executor)
    monkeypatch.setattr(orchestrator, "STEP_GRACE_SEC", 0)
    patch_plan(monkeypatch, steps={"parallel_research": {"timeoutSec": 0.3}})
    gate = threading.Event()
    market = FakeWorker("market_agent", SAMPLES["MarketResult"], gate=gate, contract="MarketResult")
    report = make_report(user)
    try:
        run(report, fake_team(market_agent=market))
        report.refresh_from_db()
        assert report.status == Report.FAILED and failure(report) == "timeout"
        failed = event(report, "market_agent", "agent_failed").details
        assert failed["errorType"] == "timeout" and failed["message"] == "단계 제한 시간(0.3초)을 넘겼습니다"
        events = report.trace_events.count()
    finally:
        gate.set()
        assert market.finished.wait(5)
        _join_worker_threads()
    report.refresh_from_db()
    assert report.trace_events.count() == events and "market_agent" not in report.results


def _real_executor(workers):
    return orchestrator.DaemonExecutor()


@pytest.mark.django_db(transaction=True)
def test_result_being_written_at_the_deadline_is_waited_for_not_abandoned(user, monkeypatch):
    """실제 스레드: Worker가 제한 시간 안에 끝냈지만 결과 쓰기가 늦어 deadline을 넘겨도, Orchestrator는 쓰기가 끝나길 기다리고
    그 결과로 계속한다 (결과를 잃고 join_blocked로 끝나면 안 된다 — 리뷰 C0)."""
    monkeypatch.setattr(orchestrator, "make_executor", _real_executor)
    monkeypatch.setattr(orchestrator, "STEP_GRACE_SEC", 0)
    patch_plan(monkeypatch, steps={"parallel_research": {"timeoutSec": 0.2}})
    real_add_result = state.add_result

    def slow_add_result(report, agent, result):
        if agent == "market_agent":
            time.sleep(0.3)  # 쓰기 잠금·DB 잠금을 기다리는 것처럼
        return real_add_result(report, agent, result)
    monkeypatch.setattr(state, "add_result", slow_add_result)
    market = FakeWorker("market_agent", SAMPLES["MarketResult"], delay=0.1, contract="MarketResult")
    report = make_report(user)
    run(report, fake_team(market_agent=market))
    _join_worker_threads()

    report.refresh_from_db()
    assert report.status == Report.COMPLETED and "market_agent" in report.results
    assert event(report, "market_agent", "agent_completed") is not None


def _join_worker_threads():
    for thread in threading.enumerate():
        if thread.name.startswith("report-worker"):
            thread.join(5)


@pytest.mark.django_db(transaction=True)
def test_parallel_research_runs_in_real_threads(user, monkeypatch):
    monkeypatch.setattr(orchestrator, "make_executor", _real_executor)
    report = make_report(user)
    workers = fake_team(**{wid: FakeWorker(wid, SAMPLES[contract], delay=0.3, contract=contract)
                           for wid, contract in (("market_agent", "MarketResult"),
                                                 ("fundamental_agent", "FundamentalResult"),
                                                 ("news_agent", "NewsResult"))})
    began = time.monotonic()
    run(report, workers)
    elapsed = time.monotonic() - began
    _join_worker_threads()

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    assert elapsed < 0.85  # 셋을 차례로 돌리면 0.9초 넘게 걸린다
    assert {workers[wid].calls[0].attempt for wid in RESEARCH} == {1}
    steps = [e.step for e in report.trace_events.all()]
    assert sorted(steps) == list(range(1, len(steps) + 1))


# ---------------------------------------------------------------------- 검토 반복

def test_review_retry_then_pass(user):
    report = make_report(user)
    review = FakeWorker("review_agent", script=[RETRY_REVIEW, SAMPLES["ReviewResult"]], contract="ReviewResult")
    draft = FakeWorker("report_agent", script=[SAMPLES["ReportDraft"], DRAFT2], contract="ReportDraft")
    run(report, fake_team(review_agent=review, report_agent=draft))

    report.refresh_from_db()
    assert report.status == Report.COMPLETED and report.content == DRAFT2["markdown"]
    assert actions(report)[-6:] == [("orchestrator", "review_retry"), ("report_agent", "agent_started"),
                    ("report_agent", "agent_completed"), ("review_agent", "agent_started"),
                    ("review_agent", "agent_completed"), ("orchestrator", "workflow_completed")]
    assert event(report, "orchestrator", "review_retry").details == {
        "round": 1, "target": "report_agent", "issues": ["목표가 77000원 — 근거가 없다"],
        "instructions": RETRY_REVIEW["instructions"]}
    assert event(report, "report_agent", "agent_started").details == {"attempt": 2, "step": "compose"}
    assert event(report, "review_agent", "agent_started").details == {"attempt": 2, "step": "review"}
    again = draft.calls[1]
    assert again.attempt == 2 and again.instructions == RETRY_REVIEW["instructions"]
    assert again.inputs["report_agent"] == SAMPLES["ReportDraft"] and set(again.inputs) == {*RESEARCH, "report_agent"}
    assert review.calls[1].attempt == 2 and review.calls[1].inputs["report_agent"] == DRAFT2


def test_review_retry_beyond_max_rounds_fails(user):
    report = make_report(user)
    review = FakeWorker("review_agent", RETRY_REVIEW, contract="ReviewResult")
    draft = FakeWorker("report_agent", SAMPLES["ReportDraft"], contract="ReportDraft")
    run(report, fake_team(review_agent=review, report_agent=draft))

    report.refresh_from_db()
    assert report.status == Report.FAILED and failure(report) == "review_failed" and report.content is None
    assert [e.details["round"] for e in report.trace_events.filter(action="review_retry").order_by("step")] == [1, 2]
    assert [ctx.attempt for ctx in draft.calls] == [1, 2, 3] and len(review.calls) == 3


def test_review_fail_ends_without_retry(user):
    report = make_report(user)
    run(report, fake_team(review_agent=FAIL_REVIEW))

    report.refresh_from_db()
    assert report.status == Report.FAILED and failure(report) == "review_failed"
    assert not report.trace_events.filter(action="review_retry").exists()


def test_rewrite_failure_stops_with_agent_failed(user):
    report = make_report(user)
    review = FakeWorker("review_agent", RETRY_REVIEW, contract="ReviewResult")
    draft = FakeWorker("report_agent", script=[SAMPLES["ReportDraft"], WorkerError("다시 쓰지 못했습니다")],
                       contract="ReportDraft")
    run(report, fake_team(review_agent=review, report_agent=draft))

    report.refresh_from_db()
    assert report.status == Report.FAILED and failure(report) == "agent_failed"
    assert len(review.calls) == 1


# ---------------------------------------------------------------------- Handoff

HANDOFF_REVIEW = {**SAMPLES["ReviewResult"], "handoff": {"to": "risk_agent", "reason": "투자경고 종목입니다"}}


def test_handoff_runs_risk_agent_and_puts_warning_on_top(user):
    report = make_report(user)
    workers = fake_team(review_agent=HANDOFF_REVIEW)
    run(report, workers)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    assert actions(report)[-5:] == [
        ("handoff_guard", "handoff_started"), ("risk_agent", "agent_started"), ("risk_agent", "agent_completed"),
        ("handoff_guard", "handoff_completed"), ("orchestrator", "workflow_completed")]
    assert event(report, "handoff_guard", "handoff_started").details == {
        "from": "review_agent", "to": "risk_agent", "hopCount": 1, "reason": "투자경고 종목입니다"}
    assert event(report, "handoff_guard", "handoff_completed").details["ok"] is True
    assert event(report, "risk_agent", "agent_started").details == {"attempt": 1, "step": "review"}
    ctx = workers["risk_agent"].calls[0]
    plan = registry.execution_plan()
    assert ctx.handoff == {
        "task_id": f"report-{report.pk}", "trace_id": f"report-{report.pk}", "from_agent": "review_agent",
        "to_agent": "risk_agent", "objective": plan["handoffs"][0]["responsibility"],
        "inputs": {"memory_refs": [*RESEARCH, "report_agent", "review_agent"]},
        "constraints": orchestrator.HANDOFF_CONSTRAINTS, "expected_output": "RiskResult", "attempt": 1,
        "user_id": user.pk, "hop_count": 1, "reason": "투자경고 종목입니다"}
    assert set(ctx.inputs) == {*RESEARCH, "report_agent", "review_agent"}
    assert report.content.startswith("> ⚠️ **리스크 점검 (높음)**: 투자경고 지정\n> - 투자경고 종목입니다\n\n# 삼성전자")


def test_handoff_blocked_when_route_not_in_plan(user, monkeypatch):
    patch_plan(monkeypatch, handoffs=[])
    report = make_report(user)
    workers = fake_team(review_agent=HANDOFF_REVIEW)
    run(report, workers)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED and report.content == SAMPLES["ReportDraft"]["markdown"]
    blocked = event(report, "handoff_guard", "handoff_blocked").details
    assert blocked["to"] == "risk_agent" and blocked["hopCount"] == 1 and "실행 계획에 없는 경로" in blocked["reason"]
    assert workers["risk_agent"].calls == []


def test_handoff_blocked_when_payload_has_secret(user):
    report = make_report(user)
    review = {**HANDOFF_REVIEW, "handoff": {"to": "risk_agent", "reason": "키 sk-abcdefghijklmnopqrstuvwxyz123"}}
    workers = fake_team(review_agent=review)
    run(report, workers)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    assert "비밀 값" in event(report, "handoff_guard", "handoff_blocked").details["reason"]
    assert workers["risk_agent"].calls == []


def test_handoff_target_failure_still_completes(user):
    report = make_report(user)
    run(report, fake_team(review_agent=HANDOFF_REVIEW, risk_agent=WorkerError("투자유의 조회 실패")))

    report.refresh_from_db()
    assert report.status == Report.COMPLETED and report.content == SAMPLES["ReportDraft"]["markdown"]
    assert event(report, "handoff_guard", "handoff_completed").details["ok"] is False


# ---------------------------------------------------------------------- 실패 사유 코드

def test_no_llm_client(user, monkeypatch):
    monkeypatch.setattr(healing, "llm_client", lambda: None)
    report = make_report(user)
    workers = fake_team()
    orchestrator.run_report(report, workers=workers)

    report.refresh_from_db()
    assert report.status == Report.FAILED and failure(report) == "no_llm"
    assert not report.trace_events.filter(action="agent_started").exists()
    skipped = report.trace_events.filter(action="agent_skipped")
    assert skipped.count() == 5 and {e.details["reason"] for e in skipped} == {"no_llm"}


def test_unexpected_error_ends_with_exception(user, monkeypatch):
    def broken(report, inputs=None):
        raise ValueError("본문을 만들 수 없음")
    monkeypatch.setattr(orchestrator, "content_of", broken)
    report = make_report(user)
    returned = run(report, fake_team())

    assert returned is report and report.status == Report.FAILED
    failed = event(report, "orchestrator", "workflow_failed").details
    assert failed["reason"] == "exception" and failed["message"] == "ValueError: 본문을 만들 수 없음"


def test_report_not_requested_is_left_alone(user):
    report = make_report(user)
    state.start(report)
    run(report, fake_team())
    report.refresh_from_db()
    assert report.status == Report.RUNNING and report.trace_events.count() == 0


def test_failure_reasons_are_the_agreed_codes():
    assert set(orchestrator.FAILURE_REASONS) == {
        "join_blocked", "review_failed", "timeout", "engine_restarted", "exception", "agent_failed", "no_llm", "expired"}


# ---------------------------------------------------------------------- 선정 팀

def selection_report():
    return Report.objects.create(user=None, source=Report.AUTO, team=Report.STOCK_SELECTION, symbol="KR",
                                 name="오늘의 매매 종목 선정", market="KR")


def test_selection_team_runs_with_team_inputs(monkeypatch):
    inputs = {"market": "KR", "day": "2026-10-07", "candidates": CANDIDATES}
    monkeypatch.setattr(orchestrator, "team_inputs", lambda report: copy.deepcopy(inputs))
    report = selection_report()
    workers = fake_team(registry.SELECTION_TEAM, flow_agent=WorkerError("수급 자료 없음"))
    run(report, workers)

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    assert [e.details["step"] for e in report.trace_events.filter(action="agent_started").order_by("step")] == [
        "candidate_research", "candidate_research", "candidate_research", "select", "select_review"]
    joined = event(report, "join_guard", "join_completed").details
    assert joined["step"] == "select" and joined["required"] == ["news_screen_agent", "filing_screen_agent"]
    assert all(ctx.team_inputs == inputs for worker in workers.values() for ctx in worker.calls)
    assert set(workers["selector_agent"].calls[0].inputs) == {"news_screen_agent", "filing_screen_agent"}
    assert "| 1 | 삼성전자 (005930) | 신제품 재료 |" in report.content
    assert "| 2 | SK하이닉스 (000660) | 수급 개선 |" in report.content
    assert "안전장치(선정 Guard)" in report.content
    assert event(report, "orchestrator", "workflow_started").details == {
        "chaos": False, "source": "auto", "team": "stock_selection"}


def test_selection_review_retry_reruns_selector(monkeypatch):
    monkeypatch.setattr(orchestrator, "team_inputs", lambda report: {"market": "KR", "day": "2026-10-07",
                                                                     "candidates": CANDIDATES})
    review = FakeWorker("selection_review_agent", script=[RETRY_REVIEW, SAMPLES["ReviewResult"]], contract="ReviewResult")
    selector = FakeWorker("selector_agent", SAMPLES["SelectionDraft"], contract="SelectionDraft")
    report = selection_report()
    run(report, fake_team(registry.SELECTION_TEAM, selection_review_agent=review, selector_agent=selector))

    report.refresh_from_db()
    assert report.status == Report.COMPLETED
    assert event(report, "orchestrator", "review_retry").details["target"] == "selector_agent"
    assert selector.calls[1].attempt == 2 and selector.calls[1].inputs["selector_agent"] == SAMPLES["SelectionDraft"]


def test_selection_without_candidate_table_fails_with_exception(monkeypatch):
    def missing(report):
        raise WorkerError("오늘의 후보 표가 없습니다")
    monkeypatch.setattr(orchestrator, "team_inputs", missing)
    report = selection_report()
    run(report, fake_team(registry.SELECTION_TEAM))

    report.refresh_from_db()
    assert report.status == Report.FAILED
    failed = event(report, "orchestrator", "workflow_failed").details
    assert failed["reason"] == "exception" and failed["message"] == "오늘의 후보 표가 없습니다"
    assert {e.details["reason"] for e in report.trace_events.filter(action="agent_skipped")} == {"exception"}


def test_team_inputs_loader_imports_lazily(monkeypatch):
    """선정 팀 입력은 TEAM_INPUTS의 "모듈.함수"를 실행 때 import해 부른다. 종목 리포트는 None."""
    import types

    module = types.ModuleType("fake_selection")
    module.team_inputs = lambda report: {"market": report.market}
    monkeypatch.setitem(__import__("sys").modules, "fake_selection", module)
    monkeypatch.setitem(orchestrator.TEAM_INPUTS, registry.SELECTION_TEAM, "fake_selection.team_inputs")
    assert orchestrator.team_inputs(selection_report()) == {"market": "KR"}
    assert orchestrator.team_inputs(Report(team=Report.STOCK_REPORT, symbol="005930", name="삼성전자", market="KR")) is None
