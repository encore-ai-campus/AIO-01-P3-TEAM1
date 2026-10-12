"""장애·복구 요약과 복구 지표 (docs/tasks/04-autohealing.md T4-7, docs/tasks/00-공통.md 9절 셈법):
stats.report_recovery(RecoverySummary), stats.recovery_stats(RecoveryStats), GET /api/reports/recovery-stats, 상세의 recovery."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest

from reports.output import pdf
from reports.autohealing import stats
from reports.models import Report, TraceEvent

from ..conftest import make_report

pytestmark = pytest.mark.django_db

KST = ZoneInfo("Asia/Seoul")
T0 = datetime(2026, 10, 7, 10, 0, tzinfo=KST)


class Trace:
    """리포트 하나의 Trace를 순서대로 쌓는다. at은 T0부터 초 단위."""

    def __init__(self, report):
        self.report, self.step = report, 0

    def add(self, actor, action, seconds, model=None, **details):
        self.step += 1
        status = {"agent_started": "started", "agent_completed": "completed", "agent_failed": "failed",
                  "agent_retry": "started", "agent_failover": "started"}[action]
        return TraceEvent.objects.create(report=self.report, step=self.step, actor=actor, action=action, status=status,
                                         model=model, details=details, at=T0 + timedelta(seconds=seconds))

    def start(self, actor, seconds=0):
        return self.add(actor, "agent_started", seconds, attempt=1)

    def fail(self, actor, seconds, error="timeout", injected=False, model="gemini-3.8-flash"):
        return self.add(actor, "agent_failed", seconds, model, errorType=error, attempt=1, injected=injected, final=False)

    def done(self, actor, seconds, model="gpt-5.6-luna"):
        return self.add(actor, "agent_completed", seconds, model, attempts=2)

    def give_up(self, actor, seconds):
        return self.add(actor, "agent_failed", seconds, None, errorType="timeout", attempts=4, final=True)

    def events(self):
        return list(self.report.trace_events.order_by("step"))


@pytest.fixture
def trace(user):
    return Trace(make_report(user, status=Report.COMPLETED))


def summary(trace):
    return stats.report_recovery(trace.events())


# --- 리포트 하나 (RecoverySummary) ---

def test_no_failures(trace):
    trace.start("market_agent")
    trace.done("market_agent", 3, model="gemini-3.8-flash")
    assert summary(trace) == {"failures": 0, "recovered": 0, "unrecovered": 0, "injected": 0, "recoveryMs": None,
                              "models": {"market_agent": "gemini-3.8-flash"}}


def test_recovered_counts_once_per_run(trace):
    trace.start("news_agent")
    trace.fail("news_agent", 1.0)
    trace.add("news_agent", "agent_retry", 1.0, "gemini-3.8-flash", attempt=2, reason="timeout")
    trace.fail("news_agent", 2.5, error="server_error")  # 같은 run의 뒤 실패는 같은 건
    trace.add("news_agent", "agent_failover", 2.5, "gpt-5.6-luna", **{"from": "gemini-3.8-flash", "to": "gpt-5.6-luna"})
    trace.done("news_agent", 4.25)
    assert summary(trace) == {"failures": 1, "recovered": 1, "unrecovered": 0, "injected": 0, "recoveryMs": 3250,
                              "models": {"news_agent": "gpt-5.6-luna"}}


def test_give_up_is_unrecovered(trace):
    trace.start("fundamental_agent")
    trace.fail("fundamental_agent", 1)
    trace.give_up("fundamental_agent", 9)
    assert summary(trace) | {"models": None} == {"failures": 1, "recovered": 0, "unrecovered": 1, "injected": 0,
                                                 "recoveryMs": None, "models": None}


def test_give_up_without_failure_is_not_an_incident(trace):
    trace.start("market_agent")
    trace.give_up("market_agent", 1)  # 호출 실패 없이 포기(WorkerError 등)는 호출 장애가 아니다
    assert summary(trace)["failures"] == 0


def test_missing_final_counts_as_give_up(trace):
    trace.start("market_agent")
    trace.fail("market_agent", 1)
    trace.add("market_agent", "agent_failed", 2, errorType="timeout")  # final 없음 = 포기 (화면과 같은 판정)
    assert (summary(trace)["unrecovered"], summary(trace)["recovered"]) == (1, 0)


def test_each_run_is_separate(trace):
    """검토 RETRY로 report_agent를 다시 돌리면 run이 둘 → 장애도 따로 센다."""
    trace.start("report_agent", 0)
    trace.fail("report_agent", 1, error="bad_output")
    trace.done("report_agent", 2)
    trace.start("report_agent", 10)
    trace.fail("report_agent", 11, injected=True)
    trace.done("report_agent", 15)
    assert summary(trace) | {"models": None} == {"failures": 2, "recovered": 2, "unrecovered": 0, "injected": 1,
                                                 "recoveryMs": 5000, "models": None}


def test_injected_is_the_first_failure(trace):
    trace.start("news_agent")
    trace.fail("news_agent", 1, injected=False)
    trace.fail("news_agent", 2, injected=True)
    trace.done("news_agent", 3)
    assert summary(trace)["injected"] == 0


def test_unfinished_run_is_a_failure_only(trace):
    trace.start("market_agent")
    trace.fail("market_agent", 1)
    assert summary(trace) | {"models": None} == {"failures": 1, "recovered": 0, "unrecovered": 0, "injected": 0,
                                                 "recoveryMs": None, "models": None}


def test_workers_are_counted_separately(trace):
    for wid in ("market_agent", "news_agent"):
        trace.start(wid)
    trace.fail("market_agent", 1)
    trace.fail("news_agent", 2)
    trace.done("news_agent", 3)
    trace.give_up("market_agent", 4)
    result = summary(trace)
    assert (result["failures"], result["recovered"], result["unrecovered"], result["recoveryMs"]) == (2, 1, 1, 1000)


def test_same_as_pdf_count_for_finished_runs(trace):
    """PDF가 쓰던 임시 셈법(pdf._count_recovery)과 끝난 run에서는 같다."""
    trace.start("report_agent", 0)
    trace.fail("report_agent", 1, injected=True)
    trace.done("report_agent", 2)
    trace.start("news_agent", 0)
    trace.fail("news_agent", 1)
    trace.give_up("news_agent", 5)
    assert summary(trace) == pdf._count_recovery(trace.events())


# --- 기간 지표 (RecoveryStats) ---

NOW = datetime(2026, 10, 7, 21, 0, tzinfo=KST)


def at_day(user, created_at, symbol="005930"):
    return Trace(make_report(user, symbol, status=Report.COMPLETED, created_at=created_at))


def test_stats_window_and_totals(user):
    inside = at_day(user, datetime(2026, 10, 1, 0, 0, tzinfo=KST))           # 7일 창의 첫날 0시
    inside.start("news_agent")
    inside.fail("news_agent", 1, injected=True)
    inside.done("news_agent", 3)
    inside.start("market_agent")
    inside.fail("market_agent", 2, error="server_error")
    inside.give_up("market_agent", 9)
    second = at_day(user, datetime(2026, 10, 7, 20, 0, tzinfo=KST), "AAPL")  # 오늘
    second.start("news_agent")
    second.fail("news_agent", 5)
    second.done("news_agent", 10)
    at_day(user, datetime(2026, 10, 6, 9, 0, tzinfo=KST))                    # 장애 없는 리포트
    old = at_day(user, datetime(2026, 9, 30, 23, 59, tzinfo=KST))            # 창 밖
    old.start("news_agent")
    old.fail("news_agent", 1)

    result = stats.recovery_stats(7, NOW)
    assert {k: result[k] for k in ("from", "to", "days", "reports", "reportsWithFailures", "failures", "recovered",
                                   "unrecovered", "injected", "autoRecoveryRate", "meanRecoveryMs")} == {
        "from": "2026-10-01", "to": "2026-10-07", "days": 7, "reports": 3, "reportsWithFailures": 2,
        "failures": 3, "recovered": 2, "unrecovered": 1, "injected": 1, "autoRecoveryRate": 66.7, "meanRecoveryMs": 3500}
    assert result["byErrorType"] == [{"errorType": "timeout", "failures": 2, "recovered": 2},
                                     {"errorType": "server_error", "failures": 1, "recovered": 0}]
    assert result["byWorker"] == [{"worker": "news_agent", "failures": 2, "recovered": 2},
                                  {"worker": "market_agent", "failures": 1, "recovered": 0}]
    assert [(r["symbol"], r["worker"], r["recovered"]) for r in result["recent"]] == [  # 첫 실패 시각의 최신순
        ("AAPL", "news_agent", True), ("005930", "market_agent", False), ("005930", "news_agent", True)]


def test_stats_recent_row_shape_and_order(user):
    trace = at_day(user, NOW - timedelta(hours=1))
    trace.start("news_agent")
    trace.fail("news_agent", 30, injected=True)
    trace.done("news_agent", 31.5)
    trace.start("market_agent")
    trace.fail("market_agent", 40, error="bad_output")
    row, older = stats.recovery_stats(1, NOW)["recent"]
    assert row == {"reportId": trace.report.id, "symbol": "005930", "worker": "market_agent", "errorType": "bad_output",
                   "injected": False, "recovered": False, "recoveryMs": None, "at": "2026-10-07T10:00:40+09:00"}
    assert (older["worker"], older["recovered"], older["recoveryMs"], older["injected"]) == ("news_agent", True, 1500, True)


def test_stats_recent_is_limited(user):
    trace = at_day(user, NOW - timedelta(hours=1))
    for i in range(stats.RECENT + 5):
        trace.start("news_agent", i * 10)
        trace.fail("news_agent", i * 10 + 1)
        trace.done("news_agent", i * 10 + 2)
    result = stats.recovery_stats(1, NOW)
    assert result["failures"] == stats.RECENT + 5 and len(result["recent"]) == stats.RECENT


def test_stats_empty():
    result = stats.recovery_stats(7, NOW)
    assert (result["reports"], result["failures"], result["autoRecoveryRate"], result["meanRecoveryMs"]) == (0, 0, None, None)
    assert result["byErrorType"] == [] and result["byWorker"] == [] and result["recent"] == []


@pytest.mark.parametrize("days", [0, 91, -1, True, 1.5, "7"])
def test_stats_days_range(days):
    with pytest.raises(ValueError):
        stats.recovery_stats(days, NOW)


def test_stats_query_count(user, django_assert_num_queries):
    for i in range(5):
        trace = at_day(user, NOW - timedelta(hours=i + 1))
        trace.start("news_agent")
        trace.fail("news_agent", 1)
        trace.done("news_agent", 2)
    with django_assert_num_queries(2):  # 리포트 수와 상관없이 리포트·사건 한 번씩
        stats.recovery_stats(7, NOW)


# --- API ---

def test_api_recovery_stats(api, user):
    trace = at_day(user, timezone_now_kst())
    trace.start("news_agent")
    trace.fail("news_agent", 1)
    trace.done("news_agent", 2)
    response = api.get("/api/reports/recovery-stats")
    assert response.status_code == 200
    body = response.json()
    assert body["days"] == 7 and body["failures"] == 1 and body["autoRecoveryRate"] == 100.0
    assert set(body) == {"from", "to", "days", "reports", "reportsWithFailures", "failures", "recovered", "unrecovered",
                         "injected", "autoRecoveryRate", "meanRecoveryMs", "byErrorType", "byWorker", "recent"}
    assert api.get("/api/reports/recovery-stats?days=90").json()["days"] == 90


@pytest.mark.parametrize("days", ["0", "91", "abc", "-3", "1.5", "²"])  # "²"는 isdigit이 참이지만 정수가 아니다
def test_api_recovery_stats_bad_days(api, days):
    response = api.get(f"/api/reports/recovery-stats?days={days}")
    assert response.status_code == 400 and response.json() == {"detail": "days는 1~90 사이의 정수입니다."}


def test_api_recovery_stats_login_required(client):
    assert client.get("/api/reports/recovery-stats").status_code == 401


def test_detail_recovery_is_computed(api, user):
    trace = Trace(make_report(user, status=Report.COMPLETED))
    trace.start("news_agent")
    trace.fail("news_agent", 1, injected=True)
    trace.done("news_agent", 2.5)
    body = api.get(f"/api/reports/{trace.report.id}").json()
    assert body["recovery"] == {"failures": 1, "recovered": 1, "unrecovered": 0, "injected": 1, "recoveryMs": 1500,
                                "models": {"news_agent": "gpt-5.6-luna"}}


def timezone_now_kst():
    from django.utils import timezone

    return timezone.now().astimezone(KST)
