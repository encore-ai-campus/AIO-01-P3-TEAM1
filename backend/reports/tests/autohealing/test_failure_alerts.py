"""복구 실패와 알림 (docs/tasks/04-autohealing.md T4-8, docs/plans/TEAM_DEV_PLAN.md 8장 DR-LLM-03·04):
선택 Worker는 모든 모델이 실패해도 빼고 완성, 필수 Worker는 모든 모델이 실패하면 Join 차단 → 실패 종료 → 신청자에게 report_failed 한 번.
자동 리포트는 신청자 알림을 보내지 않는다. Discord는 꺼져 있어(docs/DECISIONS.md 24장) 담당자 쪽 신호는 관리 서버의 "리포트 장애"와 Trace다.
"""
import pytest

from config import engine
from notifications.models import Notification
from reports.output import alerts, text
from reports.autohealing import healing
from reports.orchestration import orchestrator
from reports.models import Report

from ..conftest import FakeWorker, fake_team, make_report

pytestmark = pytest.mark.django_db

ALL_FAIL = {"enabled": True, "probability": 1.0, "errorTypes": ["server_error"], "workers": None, "scope": "all",
            "seed": 4}


@pytest.fixture(autouse=True)
def setup(monkeypatch, inline_workers):
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    now = {"t": 1000.0}
    monkeypatch.setattr(healing, "clock", lambda: now["t"])
    monkeypatch.setattr(healing, "sleep", lambda seconds: now.__setitem__("t", now["t"] + seconds))


def llm_worker(wid, contract):
    return FakeWorker(wid, llm=True, contract=contract)


def run(report, fake_llm, **workers):
    orchestrator.run_report(report, workers=fake_team(**workers), llm_client=fake_llm({}))
    report.refresh_from_db()
    return report


def actions(report, actor):
    return [(e.action, e.details.get("final")) for e in report.trace_events.filter(actor=actor).order_by("step")]


def test_dr_llm_03_optional_worker_all_models_fail(user, fake_llm):
    """DR-LLM-03: 선택 Worker(뉴스)의 모든 모델이 실패 → 뉴스를 빼고 리포트 완료. 신청자 실패 알림은 없다."""
    report = make_report(user, chaos={**ALL_FAIL, "workers": ["news_agent"]})
    report = run(report, fake_llm, news_agent=llm_worker("news_agent", "NewsResult"))

    assert report.status == Report.COMPLETED and "news_agent" in report.failed_agents
    assert actions(report, "news_agent")[-1] == ("agent_failed", True)  # 포기
    alerts.notify_finished(report)
    assert not Notification.objects.filter(kind=alerts.FAILED).exists()


def test_dr_llm_04_required_worker_all_models_fail(user, fake_llm):
    """DR-LLM-04: 필수 Worker의 모든 모델 실패 → Join 차단, 뒤 단계 건너뜀, 실패 종료, 신청자에게 report_failed 한 번 (수동 개입)."""
    report = make_report(user, chaos={**ALL_FAIL, "workers": ["market_agent"]})
    report = run(report, fake_llm, market_agent=llm_worker("market_agent", "MarketResult"))

    assert report.status == Report.FAILED
    market = actions(report, "market_agent")
    assert market.count(("agent_failed", False)) == healing.MAX_ATTEMPTS and market[-1] == ("agent_failed", True)
    assert report.trace_events.filter(action="join_blocked").exists()
    skipped = set(report.trace_events.filter(action="agent_skipped").values_list("actor", flat=True))
    assert {"report_agent", "review_agent"} <= skipped
    assert alerts.failure_reason(report) == "join_blocked"

    alerts.notify_finished(report)
    alerts.notify_finished(report)  # 두 경로(runner·엔진 루프)가 겹쳐도 한 번
    sent = Notification.objects.filter(user=user, kind=alerts.FAILED)
    assert sent.count() == 1 and sent.get().link == f"/reports/{report.id}"
    assert text.failure_sentence("join_blocked") in sent.get().body


def test_dr_llm_04_auto_report_sends_no_user_alert(user, fake_llm):
    """자동 리포트(신청자 없음)가 같은 이유로 실패해도 사용자 알림은 0개 (자동 리포트 실패는 auto.after_finish 몫)."""
    report = make_report(None, source=Report.AUTO, chaos={**ALL_FAIL, "workers": ["market_agent"]})
    report = run(report, fake_llm, market_agent=llm_worker("market_agent", "MarketResult"))

    assert report.status == Report.FAILED
    alerts.notify_finished(report)
    assert not Notification.objects.exists()
