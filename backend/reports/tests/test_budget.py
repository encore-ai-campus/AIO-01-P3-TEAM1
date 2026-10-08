"""팀 전체 AI 하루 예산: KST 날짜, 분석 추정액, 리포트 실제 비용, 신청 차단."""

from datetime import datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone

from analysis.models import Job
from config.api import LimitExceeded
from reports import budget
from reports.models import Report

from .conftest import make_report

pytestmark = pytest.mark.django_db
KST = ZoneInfo("Asia/Seoul")
NOON = datetime(2026, 10, 7, 12, tzinfo=KST)


@pytest.fixture(autouse=True)
def limit(monkeypatch):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "10")


def test_daily_limit_uses_same_setting_as_analysis(monkeypatch):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.5")
    assert budget.daily_limit() == Decimal("0.5")
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "not-a-number")
    assert budget.daily_limit() == Decimal("10")
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "-1")
    assert budget.daily_limit() == Decimal(0)


def test_analysis_estimate_uses_kst_and_excludes_only_unstarted_failure(user):
    Job.objects.create(user=user, created_at=NOON - timedelta(hours=13), status=Job.DONE)
    Job.objects.create(user=user, created_at=NOON, status=Job.QUEUED)
    Job.objects.create(user=user, created_at=NOON, status=Job.FAILED)
    Job.objects.create(user=user, created_at=NOON, started_at=NOON, status=Job.FAILED)
    assert budget.used_usd(NOON) == Decimal("0.6")
    assert budget.used_usd(NOON - timedelta(hours=13)) == Decimal("0.3")


def test_report_actual_cost_counts_all_users_and_failed(user, other):
    make_report(user, created_at=NOON, status=Report.FAILED, cost_usd=Decimal("0.2"))
    make_report(other, "AAPL", created_at=NOON, cost_usd=Decimal("0.35"))
    make_report(user, created_at=NOON - timedelta(hours=13), cost_usd=Decimal("1"))
    assert budget.used_usd(NOON) == Decimal("0.55")


def test_check_blocks_at_limit_and_resets_next_day(user, monkeypatch):
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0.3")
    Job.objects.create(user=user, created_at=NOON)
    with pytest.raises(LimitExceeded):
        budget.check(NOON)
    budget.check(NOON + timedelta(days=1))


def test_post_checks_budget_after_duplicate_and_quota(api, user, stocks, monkeypatch):
    monkeypatch.setattr(timezone, "now", lambda: NOON)
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "0")
    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "3")
    active = make_report(user, created_at=NOON)
    duplicate = api.post("/api/reports", {"symbol": "005930"}, content_type="application/json")
    assert duplicate.status_code == 200 and duplicate.json()["id"] == active.pk
    blocked = api.post("/api/reports", {"symbol": "AAPL"}, content_type="application/json")
    assert blocked.status_code == 429
    assert Report.objects.count() == 1

    monkeypatch.setenv("AI_DAILY_REPORTS_PER_USER", "0")
    quota_first = api.post("/api/reports", {"symbol": "AAPL"}, content_type="application/json")
    assert quota_first.status_code == 429 and quota_first.json()["limit"] == 0
