"""장애 주입 시험 시나리오의 설정값 (docs/tasks/04-autohealing.md T4-10, docs/plans/TEAM_DEV_PLAN.md 8장 DR-LLM-01~04).

docs/deliverables/02_배포_및_장애복구_보고서.md 4장의 시나리오 표가 이 SCENARIOS를 그대로 옮긴다. 시험 때 화면(장애 주입 "직접 설정")에 같은 값을 넣으면
여기 적은 Trace가 나와야 한다. LLM은 가짜라 실제 모델의 응답 시간·비용은 시험 결과표에서 본다.
주입한 실패는 기다리지 않는다 (timeout도 바로 실패) — 복구 시간은 대체 모델이 답하는 시간이다.
"""
import pytest

from config import engine
from reports.autohealing import healing, stats
from reports.orchestration import orchestrator
from reports.models import Report

from ..conftest import SAMPLES, FakeWorker, fake_team, make_report

pytestmark = pytest.mark.django_db

PRIMARY, FALLBACK = "gemini-3.8-flash", "gpt-5.6-luna"   # market·fundamental·news의 주 모델과 healing이 고르는 대체 모델

SCENARIOS = {
    # 주 모델 timeout → 같은 모델을 다시 기다리지 않고 바로 대체 모델 → 완료
    "DR-LLM-01": {"enabled": True, "probability": 1, "errorTypes": ["timeout"], "workers": ["market_agent"],
                  "scope": "primary", "seed": 1},
    # 형식 오류 → 오류를 알려 같은 모델에 재요청 → 성공 (seed 3: 1번째 시도만 주입, 2번째는 통과)
    "DR-LLM-02a": {"enabled": True, "probability": 0.5, "errorTypes": ["bad_output"], "workers": ["market_agent"],
                   "scope": "primary", "seed": 3},
    # 형식 오류가 재요청에도 계속 → 대체 모델 → 완료
    "DR-LLM-02b": {"enabled": True, "probability": 1, "errorTypes": ["bad_output"], "workers": ["market_agent"],
                   "scope": "primary", "seed": 1},
    # 선택 Worker(뉴스)의 모든 모델 실패 → 뉴스를 빼고 완료
    "DR-LLM-03": {"enabled": True, "probability": 1, "errorTypes": ["server_error"], "workers": ["news_agent"],
                  "scope": "all", "seed": 1},
    # 필수 Worker(시세)의 모든 모델 실패 → Join 차단 → 실패 종료 (수동 개입: 다시 신청)
    "DR-LLM-04": {"enabled": True, "probability": 1, "errorTypes": ["server_error"], "workers": ["market_agent"],
                  "scope": "all", "seed": 1},
}


@pytest.fixture(autouse=True)
def setup(monkeypatch, inline_workers):
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    now = {"t": 1000.0}
    monkeypatch.setattr(healing, "clock", lambda: now["t"])
    monkeypatch.setattr(healing, "sleep", lambda seconds: now.__setitem__("t", now["t"] + seconds))


def run_scenario(user, fake_llm, scenario_id, target):
    contract = {"market_agent": "MarketResult", "news_agent": "NewsResult"}[target]
    report = make_report(user, chaos=SCENARIOS[scenario_id])
    client = fake_llm({PRIMARY: [SAMPLES[contract]] * 4, FALLBACK: [SAMPLES[contract]] * 4})
    workers = fake_team(**{target: FakeWorker(target, llm=True, contract=contract)})
    orchestrator.run_report(report, workers=workers, llm_client=client)
    report.refresh_from_db()
    return report, client


def steps(report, actor):
    """그 Worker의 복구 사건 (사건, 모델, 실패 종류·재시도 사유·전환 from→to)."""
    out = []
    for e in report.trace_events.filter(actor=actor).order_by("step"):
        d = e.details
        if e.action == "agent_failed":
            out.append(("failed", e.model, d.get("errorType"), d.get("injected"), d.get("final")))
        elif e.action == "agent_retry":
            out.append(("retry", e.model, d.get("reason")))
        elif e.action == "agent_failover":
            out.append(("failover", d.get("from"), d.get("to"), d.get("reason")))
        elif e.action == "agent_completed":
            out.append(("completed", e.model, d.get("attempts")))
    return out


def recovery(report):
    found = stats.report_recovery(list(report.trace_events.order_by("step")))
    return found["failures"], found["recovered"], found["unrecovered"], found["injected"]


def test_dr_llm_01(user, fake_llm):
    report, client = run_scenario(user, fake_llm, "DR-LLM-01", "market_agent")
    assert report.status == Report.COMPLETED
    assert steps(report, "market_agent") == [("failed", PRIMARY, "timeout", True, False),
                                             ("failover", PRIMARY, FALLBACK, "timeout"),
                                             ("completed", FALLBACK, 2)]
    assert recovery(report) == (1, 1, 0, 1)


def test_dr_llm_02a(user, fake_llm):
    report, _ = run_scenario(user, fake_llm, "DR-LLM-02a", "market_agent")
    assert report.status == Report.COMPLETED
    assert steps(report, "market_agent") == [("failed", PRIMARY, "bad_output", True, False),
                                             ("retry", PRIMARY, "bad_output"),
                                             ("completed", PRIMARY, 2)]
    assert recovery(report) == (1, 1, 0, 1)


def test_dr_llm_02b(user, fake_llm):
    report, _ = run_scenario(user, fake_llm, "DR-LLM-02b", "market_agent")
    assert report.status == Report.COMPLETED
    assert steps(report, "market_agent") == [("failed", PRIMARY, "bad_output", True, False),
                                             ("retry", PRIMARY, "bad_output"),
                                             ("failed", PRIMARY, "bad_output", True, False),
                                             ("failover", PRIMARY, FALLBACK, "bad_output"),
                                             ("completed", FALLBACK, 3)]
    assert recovery(report) == (1, 1, 0, 1)


def test_dr_llm_03(user, fake_llm):
    report, client = run_scenario(user, fake_llm, "DR-LLM-03", "news_agent")
    assert report.status == Report.COMPLETED and "news_agent" in report.failed_agents
    news = steps(report, "news_agent")
    assert [s[0] for s in news] == ["failed", "retry", "failed", "failover", "failed", "retry", "failed", "failed"]
    assert news[-1] == ("failed", FALLBACK, "server_error", None, True)  # 4번 뒤 포기 (Orchestrator, 마지막 모델)
    assert client.calls == []  # 주입한 실패는 부르지 않는다 (비용 0)
    assert recovery(report) == (1, 0, 1, 1)


def test_dr_llm_04(user, fake_llm):
    report, _ = run_scenario(user, fake_llm, "DR-LLM-04", "market_agent")
    assert report.status == Report.FAILED
    assert [s[0] for s in steps(report, "market_agent")] == ["failed", "retry", "failed", "failover", "failed",
                                                             "retry", "failed", "failed"]
    assert report.trace_events.filter(action="join_blocked").exists()
    assert report.trace_events.get(action="workflow_failed").details["reason"] == "join_blocked"
    assert recovery(report) == (1, 0, 1, 1)
