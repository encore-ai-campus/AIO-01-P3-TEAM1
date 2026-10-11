"""reports.orchestration.state: Orchestrator가 부를 State·Trace 저장 함수. 판단은 하지 않고 저장 규칙만 지킨다."""
import pytest

from reports.orchestration import state
from reports.models import Report, TraceEvent
from reports.orchestration.state import StateError

from ..conftest import make_report

pytestmark = pytest.mark.django_db


@pytest.fixture
def report(user):
    return make_report(user)


@pytest.fixture
def running(report):
    return state.start(report)


def test_start_and_full_lifecycle(report):
    assert (report.status, report.started_at) == ("requested", None)
    state.start(report)
    assert report.status == "running" and report.started_at is not None
    state.set_step(report, "parallel_research")
    state.record(report, "market_agent", "agent_started", "started")
    state.record(report, "market_agent", "agent_completed", "completed", provider="openai", model="gpt-x",
                 latency_ms=1234, details={"tokens": 10})
    state.add_result(report, "market_agent", {"trend": "up"})
    state.add_error(report, "news_agent", "시간 초과")
    state.finish(report, "completed", content="# 리포트")

    saved = Report.objects.get(pk=report.pk)
    assert (saved.status, saved.current_step, saved.content) == ("completed", None, "# 리포트")
    assert saved.finished_at is not None and saved.started_at == report.started_at
    assert (saved.results, saved.completed_agents) == ({"market_agent": {"trend": "up"}}, ["market_agent"])
    assert (saved.errors, saved.failed_agents) == ({"news_agent": "시간 초과"}, ["news_agent"])
    assert report.status == "completed" and report.current_step is None  # 넘긴 객체도 맞춰 둔다
    event = saved.trace_events.get(step=2)
    assert (event.actor, event.action, event.status, event.provider, event.model, event.latency_ms, event.details) == (
        "market_agent", "agent_completed", "completed", "openai", "gpt-x", 1234, {"tokens": 10})


def test_record_numbers_steps_per_report(user, running):
    other = state.start(make_report(user, "AAPL"))
    steps = [state.record(running, "orchestrator", "workflow_started", "started").step,
             state.record(other, "orchestrator", "workflow_started", "started").step,
             state.record(running, "join_guard", "join_blocked", "blocked").step,
             state.record(running, "news_agent", "agent_skipped", "skipped").step]
    assert steps == [1, 1, 2, 3]
    assert TraceEvent.objects.get(report=running, step=1).details == {}


def test_record_retries_when_step_taken(running, monkeypatch):
    """다른 쪽이 같은 번호를 먼저 쓰면(유일 제약 위반) 번호를 다시 구한다."""
    state.record(running, "orchestrator", "workflow_started", "started")
    real, stale = state._next_step, iter([1])
    monkeypatch.setattr(state, "_next_step", lambda report: next(stale, None) or real(report))
    assert state.record(running, "market_agent", "agent_started", "started").step == 2
    assert running.trace_events.count() == 2


@pytest.mark.parametrize("kwargs, message", [
    ({"status": "done"}, "Trace status"),
    ({"details": ["x"]}, "details는 dict"),
    ({"latency_ms": "12"}, "latency_ms"),
    ({"actor": ""}, "actor 값이 없습니다"),
])
def test_record_rejects_bad_values(running, kwargs, message):
    values = {"actor": "market_agent", "action": "agent_started", "status": "started"} | kwargs
    with pytest.raises(StateError, match=message):
        state.record(running, **values)
    assert not running.trace_events.exists()


def test_set_step_only_plan_steps(running):
    with pytest.raises(StateError, match="실행 계획에 없는 step id: cooking"):
        state.set_step(running, "cooking")
    state.set_step(running, "review")
    assert Report.objects.get(pk=running.pk).current_step == "review"


def test_agents_must_be_in_plan(running):
    with pytest.raises(StateError, match="실행 계획에 없는 Worker"):
        state.add_result(running, "ghost_agent", {})
    with pytest.raises(StateError, match="실행 계획에 없는 Worker"):
        state.add_error(running, "ghost_agent", "오류")


def test_add_result_and_error_do_not_duplicate(running):
    state.add_result(running, "market_agent", {"v": 1})
    state.add_result(running, "market_agent", {"v": 2})
    state.add_error(running, "news_agent", "첫 오류")
    state.add_error(running, "news_agent", "둘째 오류")
    saved = Report.objects.get(pk=running.pk)
    assert (saved.results, saved.completed_agents) == ({"market_agent": {"v": 2}}, ["market_agent"])
    assert (saved.errors, saved.failed_agents) == ({"news_agent": "둘째 오류"}, ["news_agent"])


def test_order_rules(report):
    """start 전에는 running 전용 함수를 못 부르고, start는 한 번만."""
    with pytest.raises(StateError, match="requested 상태"):
        state.record(report, "orchestrator", "workflow_started", "started")
    with pytest.raises(StateError, match="requested 상태"):
        state.set_step(report, "compose")
    state.start(report)
    with pytest.raises(StateError, match="running 상태"):
        state.start(report)


def test_finish_status_values(report):
    with pytest.raises(StateError, match="종료 상태"):
        state.finish(report, "running")
    state.finish(report, "failed")  # 시작 전에 실패로 끝낼 수도 있다
    assert Report.objects.get(pk=report.pk).status == "failed"


@pytest.mark.parametrize("final", ["completed", "failed"])
def test_finished_report_cannot_change(running, final):
    state.set_step(running, "compose")
    state.finish(running, final)
    stale = Report.objects.get(pk=running.pk)
    stale.status = "running"  # 오래된 객체를 들고 있어도 DB 값으로 판단한다
    for call in (lambda: state.start(stale), lambda: state.set_step(stale, "review"),
                 lambda: state.record(stale, "orchestrator", "workflow_completed", "completed"),
                 lambda: state.add_result(stale, "report_agent", {}), lambda: state.add_error(stale, "report_agent", "x"),
                 lambda: state.finish(stale, "completed")):
        with pytest.raises(StateError, match="끝난 리포트"):
            call()
    saved = Report.objects.get(pk=running.pk)
    assert (saved.status, saved.current_step, saved.results, saved.trace_events.count()) == (final, None, {}, 0)


def test_state_checks_ids_against_the_reports_team(user):
    selection = state.start(Report.objects.create(user=None, source=Report.AUTO, team=Report.STOCK_SELECTION,
                                                  symbol="KR", name="오늘의 매매 종목 선정", market="KR"))
    state.set_step(selection, "candidate_research")
    state.add_result(selection, "selector_agent", {"summary": "s", "picks": []})
    with pytest.raises(StateError, match="실행 계획에 없는 step id"):
        state.set_step(selection, "parallel_research")
    with pytest.raises(StateError, match="실행 계획에 없는 Worker"):
        state.add_result(selection, "report_agent", {})


def test_add_cost_accumulates_and_rejects_bad_values(running):
    state.add_cost(running, 0.25)
    state.add_cost(running, 0.5)
    assert running.cost_usd == 0.75
    running.refresh_from_db()
    assert running.cost_usd == 0.75
    for bad in (-1, float("nan"), "1", True):
        with pytest.raises(StateError, match="비용"):
            state.add_cost(running, bad)
