"""리포트 끝 알림 (B7 — reports/output/alerts.py, docs/API.md "리포트 끝 알림"): 완성·실패마다 신청자에게 한 번만.

완성 리포트로 추천이 생기면 추천 알림(본문 첫 줄 "리포트가 완성됐어요")이 완성 알림을 대신한다. 실제 증권사·Discord를 부르지 않는다
(증권사가 없으면 추천의 priceAtCreation은 None, Discord 설정이 없으면 편지함 메시지는 skipped).
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from accounts.models import InvestorProfile
from autotrade.models import Recommendation
from notifications.models import Notification, OutboxMessage
from notifications.service import HEADER
from paper_engine.wording import forbidden_phrases

from reports.output import alerts, text
from reports.models import Report, TraceEvent

from ..conftest import make_report

pytestmark = pytest.mark.django_db

NOW = datetime(2026, 9, 22, 18, 0, tzinfo=ZoneInfo("Asia/Seoul"))
DRAFT = {"title": "삼성전자", "verdict": "buy", "oneLiner": "반도체 업황 회복", "markdown": "...", "reasons": ["실적"],
         "risks": ["환율"], "targets": {"entry": 69000, "target": 80000, "stop": 66000, "holdingDays": 7,
                                       "probability": 0.55}, "confidence": 72, "citations": []}


class Log(list):
    def __call__(self, line):
        self.append(line)


def finished(user, status=Report.COMPLETED, draft=None, reason=None, at=NOW - timedelta(hours=1)) -> Report:
    report = make_report(user, status=status, finished_at=at,
                         results={"report_agent": draft} if draft is not None else {})
    if reason is not None:
        TraceEvent.objects.create(report=report, step=1, actor="orchestrator", action="workflow_failed",
                                  status="failed", details={"reason": reason})
    return report


def notes(user, kind=None):
    rows = Notification.objects.filter(user=user).order_by("id")
    return list(rows.filter(kind=kind) if kind else rows)


def test_completed_without_plan_sends_report_completed_once(user):
    report = finished(user, draft=DRAFT | {"verdict": "hold"})
    log = Log()
    assert alerts.sweep_finished(NOW, log) == 1
    (n,) = notes(user)
    assert (n.kind, n.link) == ("report_completed", f"/reports/{report.id}")
    assert n.title == "삼성전자 리포트가 완성됐어요" and n.body.startswith("AI 의견: 지켜보기. 지켜보기 의견이라 매매 계획은 없어요.")
    assert alerts.sweep_finished(NOW, log) == 0  # 같은 사용자·kind·link는 한 번만
    alerts.notify_finished(report)
    assert len(notes(user)) == 1 and not Recommendation.objects.exists()
    (m,) = OutboxMessage.objects.all()
    assert m.kind == "report_completed" and m.content.startswith(f"{HEADER} **삼성전자 리포트가 완성됐어요**")


def test_completed_buy_makes_recommendation_whose_alert_replaces_completion(user):
    report = finished(user, draft=DRAFT)
    alerts.notify_finished(report)
    rec = Recommendation.objects.get(report=report)
    (n,) = notes(user)
    assert n.kind == "recommendation" and n.link == f"/recommendations/{rec.id}"
    assert n.body.splitlines()[0] == text.COMPLETED_LINE == "리포트가 완성됐어요"
    assert alerts.sweep_finished(NOW, Log()) == 0 and len(notes(user)) == 1  # report_completed를 따로 보내지 않는다


def test_completed_with_existing_recommendation_sends_nothing(user):
    """추천 수집(collect)이 같은 바퀴에서 먼저 추천을 만들었으면 그 추천 알림이 완성 알림이다."""
    report = finished(user, draft=DRAFT)
    from autotrade.recommend import sources
    sources.from_report(report, NOW)
    before = len(notes(user))
    assert alerts.sweep_finished(NOW, Log()) == 0 and len(notes(user)) == before


def test_buy_with_bad_prices_is_completed_without_plan(user):
    finished(user, draft=DRAFT | {"targets": {"entry": 69000, "target": 80000, "stop": 70000}})  # 손절 > 진입
    assert alerts.sweep_finished(NOW, Log()) == 1
    (n,) = notes(user)
    assert n.kind == "report_completed" and "가격 조건이 맞지 않아" in n.body and not Recommendation.objects.exists()


@pytest.mark.parametrize("reason,sentence", [
    ("join_blocked", "자료를 모으는 AI가 응답하지 않아 리포트를 쓸 수 없었어요. 다시 만들 수 있어요."),
    ("review_failed", "검토 AI가 근거와 맞지 않는 주장을 찾아 완성하지 않았어요. 다시 만들 수 있어요."),
    ("timeout", "시간이 너무 오래 걸려 멈췄어요. 다시 만들 수 있어요."),
    ("engine_restarted", "서버가 다시 시작돼 중단됐어요. 다시 만들 수 있어요."),
    ("exception", "예상하지 못한 오류로 멈췄어요. 다시 만들 수 있어요."),
    ("agent_failed", "필요한 AI가 끝내 응답하지 않아 멈췄어요. 다시 만들 수 있어요."),
    ("no_llm", "AI 연결 설정이 없어 리포트를 쓰지 못했어요. 다시 만들 수 있어요."),
    ("모르는_코드", "리포트를 만들지 못했어요. 다시 만들 수 있어요."),
    (None, "리포트를 만들지 못했어요. 다시 만들 수 있어요."),
])
def test_failed_sends_report_failed_with_reason_sentence(user, reason, sentence):
    report = finished(user, status=Report.FAILED, reason=reason)
    alerts.notify_finished(report)
    alerts.notify_finished(report)
    (n,) = notes(user)
    assert (n.kind, n.link, n.title, n.body) == ("report_failed", f"/reports/{report.id}",
                                                 "삼성전자 리포트를 만들지 못했어요", sentence)


def test_failure_reason_is_the_last_workflow_failed(user):
    report = finished(user, status=Report.FAILED, reason="timeout")
    TraceEvent.objects.create(report=report, step=2, actor="orchestrator", action="workflow_failed", status="failed",
                              details={"reason": "engine_restarted"})
    assert alerts.failure_reason(report) == "engine_restarted"


def test_expert_mode_gets_expert_wording(user):
    InvestorProfile.objects.create(user=user, beginner_mode=False)
    finished(user, status=Report.FAILED, reason="review_failed")
    alerts.sweep_finished(NOW, Log())
    (n,) = notes(user)
    assert n.title == "삼성전자 (005930) 리포트 실패" and n.body == "실패 사유 코드: review_failed"


def test_sweep_window_unfinished_and_auto_reports_are_skipped(user):
    finished(user, draft=DRAFT | {"verdict": "avoid"}, at=NOW - timedelta(hours=25))  # 24시간보다 오래
    make_report(user, status=Report.RUNNING)
    assert alerts.sweep_finished(NOW, Log()) == 0
    auto = finished(user, status=Report.FAILED, reason="timeout")
    auto.source = "auto"  # 자동 리포트(팀 몫)는 건너뛴다 (열이 생기면 그 값)
    alerts.notify_finished(auto)
    assert notes(user) == []


@pytest.mark.parametrize("status", [Report.COMPLETED, Report.FAILED])
def test_selection_runs_are_skipped_even_with_source_user(user, status):
    """매매 종목 선정 실행(team stock_selection)은 종목 리포트가 아니라 알림 대상이 아니다 (source가 user여도)."""
    for owner in (user, None):  # 신청자가 없는 행에 보내면 팀 전체에 매 바퀴 다시 갈 수 있다
        selection = make_report(owner, team=Report.STOCK_SELECTION, source=Report.USER, status=status,
                                finished_at=NOW - timedelta(hours=1), results={"report_agent": DRAFT})
        TraceEvent.objects.create(report=selection, step=1, actor="orchestrator", action="workflow_failed",
                                  status="failed", details={"reason": "agent_failed"})
        alerts.notify_finished(selection)
    assert alerts.sweep_finished(NOW, Log()) == 0
    assert not Notification.objects.exists() and not OutboxMessage.objects.exists()
    assert not Recommendation.objects.exists()  # buy 초안이 있어도 추천을 만들지 않는다

    report = finished(user, status=status, draft=DRAFT | {"verdict": "hold"}, reason="timeout")
    assert alerts.sweep_finished(NOW, Log()) == 1  # 같은 사람의 종목 리포트는 그대로 간다
    assert [n.link for n in notes(user)] == [f"/reports/{report.id}"]


def test_each_user_gets_their_own_alert(user, other):
    mine, theirs = finished(user, status=Report.FAILED, reason="timeout"), finished(other, draft=DRAFT | {"verdict": "hold"})
    assert alerts.sweep_finished(NOW, Log()) == 2
    assert [n.link for n in notes(user)] == [f"/reports/{mine.id}"]
    assert [n.link for n in notes(other)] == [f"/reports/{theirs.id}"]


def test_notify_finished_never_raises_and_sweep_isolates_errors(user, monkeypatch):
    good = finished(user, status=Report.FAILED, reason="timeout")
    bad = finished(user, status=Report.FAILED, reason="timeout")
    real = alerts._failed

    def flaky(report):
        if report.id == bad.id:
            raise RuntimeError("깨짐")
        return real(report)
    monkeypatch.setattr(alerts, "_failed", flaky)
    alerts.notify_finished(bad)  # 예외를 밖으로 내지 않는다
    log = Log()
    assert alerts.sweep_finished(NOW, log) == 1
    assert any("깨짐" in line for line in log) and [n.link for n in notes(user)] == [f"/reports/{good.id}"]


def test_report_sentences_have_no_persuasion():
    notices = [text.completed("삼성전자", "005930", verdict) for verdict in ("buy", "hold", "avoid", None, "이상한 값")]
    notices += [text.failed("삼성전자", "005930", reason) for reason in (*text.FAILURE_TEXT, None, "x")]
    for n in notices:
        for sentence in (n.title, n.body, n.expert_title, n.expert_body):
            assert forbidden_phrases(sentence) == [], sentence


def test_expired_failure_says_it_can_be_made_again_once():
    body = text.failed("삼성전자", "005930", "expired").body
    assert body == "오래 기다린 신청이라 실행하지 않았어요. 다시 만들 수 있어요." and body.count("다시 만들 수 있어요") == 1


@pytest.mark.django_db
def test_report_without_requester_is_not_broadcast(other):
    """신청자 없는 종목 리포트(관리자 화면에서 만든 행 등)는 알리지 않는다 — notify(None)은 팀 전체이고 매 바퀴 다시 간다."""
    now = datetime.now(ZoneInfo("Asia/Seoul"))
    Report.objects.create(user=None, symbol="005930", name="삼성전자", market="KR", status=Report.FAILED, finished_at=now)
    assert alerts.sweep_finished(now, lambda line: None) == 0
    assert alerts.sweep_finished(now, lambda line: None) == 0
    assert Notification.objects.count() == 0


def test_selection_fallback_sentences_talk_about_selection():
    for code in ("join_blocked", "review_failed", "no_llm", "expired", "no_candidates"):
        sentence = text.selection_fallback_sentence(code)
        assert sentence and "리포트" not in sentence and not forbidden_phrases(sentence), code
    assert text.selection_fallback_sentence("timeout") == text.FAILURE_TEXT["timeout"]
    assert text.selection_fallback_sentence("brand_new") is None and text.selection_fallback_sentence(None) is None
