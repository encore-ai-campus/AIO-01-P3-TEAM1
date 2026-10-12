"""하루 AI 리포트 횟수 한도 (D-7, docs/DECISIONS.md 14-6): 세는 규칙(KST 하루, 장애 주입 없는 failed 제외, 자동 리포트 제외),
POST /api/reports의 429 {"detail", "limit", "used"}, GET /api/reports/quota. 시각은 고정한다 (KST와 UTC 날짜가 다른 새벽 포함)."""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from reports.limits import quota
from reports.orchestration import state
from reports.models import Report

from ..conftest import make_report

pytestmark = pytest.mark.django_db

KST = ZoneInfo("Asia/Seoul")
NOON = datetime(2026, 10, 5, 12, 0, tzinfo=KST)
DAWN = datetime(2026, 10, 5, 0, 30, tzinfo=KST)   # UTC로는 2026-10-04 15:30


@pytest.fixture(autouse=True)
def limit(monkeypatch):
    """한도 기본값 3 (개발자 .env의 값과 상관없이). 테스트가 setenv로 바꾼다."""
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "3")


@pytest.fixture
def clock(monkeypatch):
    """django.utils.timezone.now를 고정한다. clock["now"]를 바꾸면 시각이 옮겨 간다."""
    clock = {"now": NOON}
    monkeypatch.setattr(timezone, "now", lambda: clock["now"])
    return clock


def post(client, symbol):
    return client.post("/api/reports", {"symbol": symbol}, content_type="application/json")


# --- 설정 ---

@pytest.mark.parametrize("value, expected", [("5", 5), ("0", 0), ("-2", 0), ("세 번", None), (" 7 ", 7)])
def test_per_user_limit(monkeypatch, value, expected):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", value)
    assert quota.per_user_limit() == expected


def test_per_user_limit_default(monkeypatch):
    """기본값은 무제한(None) — 2026-10-08 사용자 결정 (전에는 3)."""
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "")
    monkeypatch.setattr(quota, "_dotenv", lambda: {})  # .env에도 없으면 기본값
    assert quota.per_user_limit() is quota.DEFAULT_PER_USER is None
    monkeypatch.setattr(quota, "_dotenv", lambda: {"AI_DAILY_REPORTS_PER_USER": "4"})  # 환경 변수가 비면 .env
    assert quota.per_user_limit() == 4


def test_day_range_is_kst():
    assert quota.day_range(DAWN) == (datetime(2026, 10, 5, tzinfo=KST), datetime(2026, 10, 6, tzinfo=KST))
    utc_late = datetime(2026, 10, 5, 16, 0, tzinfo=ZoneInfo("UTC"))  # KST 10-06 01:00
    assert quota.day_range(utc_late)[0] == datetime(2026, 10, 6, tzinfo=KST)


# --- 세는 규칙 ---

def test_usage_counts_today_kst_without_plain_failures(user, other):
    """오늘(KST) 내 리포트만, 장애 주입 없이 failed로 끝난 것은 빼고 센다. 어제(KST)·내일·남의 리포트는 세지 않는다."""
    make_report(user, created_at=datetime(2026, 10, 4, 23, 50, tzinfo=KST))     # 어제 KST (UTC 날짜는 now와 같다)
    make_report(user, created_at=datetime(2026, 10, 5, 0, 10, tzinfo=KST))      # 오늘 KST (UTC 날짜는 어제) — 센다
    make_report(user, "AAPL", status=Report.COMPLETED, created_at=DAWN)          # 센다
    make_report(user, status=Report.RUNNING, created_at=DAWN)                     # 센다
    make_report(user, status=Report.FAILED, created_at=DAWN)                      # 장애 주입 없는 실패 — 빼고
    make_report(other, created_at=DAWN)                                           # 남의 것
    make_report(user, created_at=datetime(2026, 10, 6, 0, 0, tzinfo=KST))       # 내일 0시 — 다음 날 몫
    used = quota.usage(user, DAWN)
    assert (used.limit, used.used, used.remaining) == (3, 3, 0)
    assert used.resets_at == datetime(2026, 10, 6, tzinfo=KST)
    assert quota.usage(other, DAWN).used == 1
    assert quota.usage(user, datetime(2026, 10, 6, 9, 0, tzinfo=KST)).used == 1


def test_remaining_never_negative(user, monkeypatch):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "1")
    for _ in range(3):
        make_report(user, status=Report.COMPLETED, created_at=NOON)
    used = quota.usage(user, NOON)
    assert (used.used, used.remaining) == (3, 0)


def test_unlimited_usage_has_no_remaining(user, monkeypatch):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "")
    monkeypatch.setattr(quota, "_dotenv", lambda: {})
    for _ in range(5):
        make_report(user, status=Report.COMPLETED, created_at=NOON)
    used = quota.usage(user, NOON)
    assert (used.limit, used.used, used.remaining) == (None, 5, None)
    assert quota.check(user, NOON) == used  # 무제한이면 막지 않는다


def test_counts_rule():
    """failed는 장애 주입(chaos.enabled가 참)을 켰을 때만 센다. chaos 열이 아직 없으면(getattr → None) failed는 빼고, 자동 리포트는 세지 않는다."""
    def report(status, **extra):
        r = Report(status=status)
        for key, value in extra.items():
            setattr(r, key, value)
        return r

    assert quota.counts(report(Report.REQUESTED)) and quota.counts(report(Report.COMPLETED))
    assert quota.counts(report(Report.RUNNING, chaos=None))
    assert not quota.counts(report(Report.FAILED))                                  # 열이 없다
    assert quota.counts(report(Report.FAILED, chaos={"enabled": True, "probability": 0.3}))
    assert not quota.counts(report(Report.FAILED, chaos={"enabled": False}))
    assert not quota.counts(report(Report.FAILED, chaos=None))
    assert not quota.counts(report(Report.FAILED, chaos={"enabled": "true"}))      # 불리언이 아니면 켠 것으로 보지 않는다
    assert not quota.counts(report(Report.FAILED, chaos="on"))
    assert not quota.counts(report(Report.COMPLETED, source="auto"))
    assert quota.counts(report(Report.COMPLETED, source="user"))


def test_usage_reads_chaos_and_source_columns(user):
    """담당 4의 chaos·source 열(마이그레이션 0002): 장애 주입을 켠 failed는 세고, 자동 리포트는 세지 않는다."""
    make_report(user, "AAPL", status=Report.FAILED, created_at=NOON, chaos={"enabled": True})   # 장애 주입 켬 → 센다
    make_report(user, status=Report.FAILED, created_at=NOON, chaos={"enabled": False})          # 장애 주입 끔 → 빼고
    make_report(user, status=Report.COMPLETED, created_at=NOON)                                 # 센다
    make_report(user, status=Report.COMPLETED, created_at=NOON, source=Report.AUTO)             # 자동 리포트 → 빼고
    assert quota.usage(user, NOON).used == 2


# --- POST /api/reports ---

def test_post_over_limit_is_429(api, user, stocks, clock, monkeypatch):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "2")
    make_report(user, status=Report.COMPLETED, created_at=NOON - timedelta(hours=2))
    make_report(user, "AAPL", status=Report.COMPLETED, created_at=NOON - timedelta(hours=1))
    response = post(api, "005930")
    assert response.status_code == 429
    assert response.json() == {"detail": "오늘 리포트 한도(2개)를 다 썼어요. 내일 0시에 다시 만들 수 있어요.",
                               "limit": 2, "used": 2}
    assert Report.objects.count() == 2

    clock["now"] = datetime(2026, 10, 6, 0, 0, 1, tzinfo=KST)  # 다음 날(KST) 0시가 지나면 다시 찬다
    assert post(api, "005930").status_code == 201


def test_post_counts_new_reports_until_limit(api, user, stocks, clock):
    for symbol in ("005930", "AAPL"):
        assert post(api, symbol).status_code == 201
    state.finish(Report.objects.get(symbol="005930"), "completed")
    assert post(api, "005930").status_code == 201          # 3번째
    over = post(api, "AAPL")                                 # AAPL은 진행 중 → 같은 리포트를 200으로 (한도와 무관)
    assert over.status_code == 200
    state.finish(Report.objects.get(pk=over.json()["id"]), "completed")
    blocked = post(api, "AAPL")
    assert blocked.status_code == 429 and (blocked.json()["limit"], blocked.json()["used"]) == (3, 3)
    assert Report.objects.filter(user=user).count() == 3


def test_active_same_symbol_returns_200_even_over_limit(api, user, stocks, clock, monkeypatch):
    """같은 종목의 진행 중 리포트를 돌려주는 200 경로는 한도를 넘었어도 되고, 새로 세지 않는다."""
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "1")
    active = make_report(user, created_at=NOON - timedelta(minutes=5))
    again = post(api, "005930")
    assert again.status_code == 200 and again.json()["id"] == active.id
    assert post(api, "AAPL").status_code == 429
    assert api.get("/api/reports/quota").json()["used"] == 1 and Report.objects.count() == 1


def test_failed_without_chaos_frees_the_slot(api, user, stocks, clock, monkeypatch):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "1")
    first = post(api, "005930")
    assert first.status_code == 201
    assert post(api, "AAPL").status_code == 429
    state.finish(Report.objects.get(pk=first.json()["id"]), "failed")  # 장애 주입 없이 실패 → 세지 않는다
    assert post(api, "AAPL").status_code == 201


def test_unlimited_never_429(api, user, stocks, clock, monkeypatch):
    """한도가 비어 있으면(기본) 몇 번을 신청해도 429가 아니다."""
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "")
    monkeypatch.setattr(quota, "_dotenv", lambda: {})
    for hours in range(1, 6):
        make_report(user, status=Report.COMPLETED, created_at=NOON - timedelta(hours=hours))
    assert post(api, "005930").status_code == 201
    assert api.get("/api/reports/quota").json() == {"limit": None, "used": 6, "remaining": None,
                                                    "resetsAt": "2026-10-06T00:00:00+09:00"}


def test_limit_zero_blocks_every_request(api, user, stocks, clock, monkeypatch):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "0")
    response = post(api, "005930")
    assert response.status_code == 429 and response.json()["limit"] == 0 and response.json()["used"] == 0
    assert not Report.objects.exists()


def test_input_errors_come_before_the_limit(api, user, stocks, clock, monkeypatch):
    """없는 종목은 한도와 상관없이 400 (입력 검사 → 200 경로 → 한도 → 생성 순서)."""
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "0")
    assert post(api, "999999").status_code == 400


def test_other_users_reports_do_not_count(api, user, other, stocks, clock, monkeypatch):
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "1")
    make_report(other, created_at=NOON)
    assert post(api, "005930").status_code == 201


# --- GET /api/reports/quota ---

def test_quota_requires_login(client):
    response = client.get("/api/reports/quota")
    assert response.status_code == 401 and response.json() == {"detail": "로그인이 필요합니다."}


def test_quota_view(api, user, clock):
    assert api.get("/api/reports/quota").json() == {"limit": 3, "used": 0, "remaining": 3,
                                                    "resetsAt": "2026-10-06T00:00:00+09:00"}
    make_report(user, status=Report.COMPLETED, created_at=NOON - timedelta(hours=1))
    make_report(user, status=Report.FAILED, created_at=NOON - timedelta(hours=1))   # 세지 않는다
    assert api.get("/api/reports/quota").json() == {"limit": 3, "used": 1, "remaining": 2,
                                                    "resetsAt": "2026-10-06T00:00:00+09:00"}


def test_quota_view_at_kst_dawn(api, user, clock):
    """KST 새벽(UTC로는 전날)에도 오늘은 KST 날짜, 다시 차는 시각은 다음 날 KST 0시."""
    clock["now"] = DAWN
    make_report(user, created_at=datetime(2026, 10, 4, 23, 59, tzinfo=KST))   # 어제 KST
    make_report(user, created_at=datetime(2026, 10, 5, 0, 1, tzinfo=KST))     # 오늘 KST
    assert api.get("/api/reports/quota").json() == {"limit": 3, "used": 1, "remaining": 2,
                                                    "resetsAt": "2026-10-06T00:00:00+09:00"}
