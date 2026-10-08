"""신청 만료, 실행기 중복 방지, 재시작 복구 동작."""

from datetime import timedelta

import pytest
from django.utils import timezone

from reports import runner, state
from reports.models import Report

from .conftest import make_report


@pytest.mark.django_db(transaction=True)
def test_tick_without_requested_does_nothing(user):
    report = state.finish(make_report(user), Report.COMPLETED)

    assert runner.tick() is None
    report.refresh_from_db()
    assert report.status == Report.COMPLETED


@pytest.mark.django_db(transaction=True)
def test_recover_marks_orphaned_running_with_reason(user):
    report = state.start(make_report(user))

    assert runner.recover() == 1
    report.refresh_from_db()
    assert report.status == Report.FAILED
    assert report.trace_events.get(action="workflow_failed").details["reason"] == "engine_restarted"
    assert runner.recover() == 0


@pytest.mark.django_db(transaction=True)
def test_tick_claims_oldest_once(user, monkeypatch):
    oldest = make_report(user)
    newer = make_report(user, "AAPL")
    seen = []

    def fake_run(report):
        seen.append(report.pk)
        return state.finish(report, Report.COMPLETED)

    monkeypatch.setattr(runner.orchestrator, "run_report", fake_run)
    assert runner.tick() == oldest.pk
    runner.shutdown()
    assert seen == [oldest.pk]
    assert newer.status == Report.REQUESTED
    assert runner.tick() == newer.pk
    runner.shutdown()
    assert seen == [oldest.pk, newer.pk]


@pytest.mark.django_db(transaction=True)
def test_tick_expires_old_requested_before_running_valid_one(user, monkeypatch):
    now = timezone.now()
    monkeypatch.setattr(runner.timezone, "now", lambda: now)
    expired = make_report(user, created_at=now - timedelta(hours=24, seconds=1))
    boundary = make_report(user, "AAPL", created_at=now - timedelta(hours=24))
    fresh = make_report(user, created_at=now - timedelta(hours=1))
    seen = []

    def fake_run(report):
        seen.append(report.pk)
        return state.finish(report, Report.COMPLETED)

    monkeypatch.setattr(runner.orchestrator, "run_report", fake_run)
    assert runner.tick() == boundary.pk
    runner.shutdown()

    expired.refresh_from_db()
    boundary.refresh_from_db()
    fresh.refresh_from_db()
    assert expired.status == Report.FAILED
    assert expired.trace_events.get(action="workflow_failed").details["reason"] == "expired"
    assert expired.cost_usd == 0
    assert Report.objects.filter(pk=expired.pk).exists()
    assert seen == [boundary.pk]
    assert boundary.status == Report.COMPLETED
    assert fresh.status == Report.REQUESTED
