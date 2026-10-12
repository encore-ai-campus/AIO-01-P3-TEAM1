"""리포트 실행기 (T3-4·T3-12): 오래된 requested부터 하나씩 스레드로 실행, 두 번 잡지 않음, 엔진 재시작 정리, 끝 처리 호출.

스레드가 DB를 쓰므로 실행 시험은 transaction=True로 돌고 스레드를 join(timeout)으로 기다린다.
"""
import threading
from datetime import timedelta
from io import StringIO

import pytest
from django.core.management import call_command
from django.utils import timezone

from config import engine
from reports.autoreport import auto
from reports.autohealing import healing
from reports.orchestration import orchestrator, runner, state
from reports.models import Report

from ..conftest import FakeLlm, fake_team, make_report


@pytest.fixture(autouse=True)
def clean_runner(monkeypatch):
    """모듈 전역 스레드를 비우고, 끝 처리(after_finish)를 기록용 가짜로 바꾼다."""
    monkeypatch.setattr(runner, "_worker", None)
    finished: list[tuple[int, str]] = []
    monkeypatch.setattr(auto, "after_finish", lambda report: finished.append((report.pk, report.status)), raising=False)
    yield finished
    if runner._worker is not None:
        runner._worker.join(5)


def old_report(user, minutes, **fields):
    report = make_report(user, **fields)
    Report.objects.filter(pk=report.pk).update(created_at=timezone.now() - timedelta(minutes=minutes))
    return report


def fake_run(calls, gate=None):
    """run_report 대신: 시작하고(state.start) 바로 끝낸다. gate가 있으면 그것이 set될 때까지 기다린다."""
    def run_report(report, **kwargs):
        calls.append(report.pk)
        state.start(report)
        if gate is not None:
            gate.wait(5)
        state.record(report, "orchestrator", "workflow_completed", "completed", details={})
        state.finish(report, Report.COMPLETED, "본문")
        return report
    return run_report


def join():
    assert runner._worker is not None
    runner._worker.join(10)
    assert not runner._worker.is_alive()


@pytest.mark.django_db(transaction=True)
def test_tick_runs_oldest_requested_in_thread(user, monkeypatch, clean_runner):
    calls: list[int] = []
    monkeypatch.setattr(orchestrator, "run_report", fake_run(calls))
    newer, older = old_report(user, 1), old_report(user, 5)
    Report.objects.create(user=user, symbol="005930", name="삼성전자", market="KR", status=Report.COMPLETED)

    assert runner.tick() == 1
    join()
    assert calls == [older.pk] and clean_runner == [(older.pk, Report.COMPLETED)]
    assert runner.tick() == 1
    join()
    assert calls == [older.pk, newer.pk]
    assert runner.tick() == 0 and runner._worker.is_alive() is False


@pytest.mark.django_db(transaction=True)
def test_tick_does_not_start_second_report_while_one_runs(user, monkeypatch):
    calls: list[int] = []
    gate = threading.Event()
    monkeypatch.setattr(orchestrator, "run_report", fake_run(calls, gate))
    first, second = old_report(user, 5), old_report(user, 1)
    try:
        assert runner.tick() == 1
        assert runner.running() and runner.tick() == 0 and runner.tick() == 0
    finally:
        gate.set()
    join()
    assert calls == [first.pk]
    assert runner.tick() == 1
    join()
    assert calls == [first.pk, second.pk]
    first.refresh_from_db()
    assert first.trace_events.filter(action="workflow_completed").count() == 1


@pytest.mark.django_db(transaction=True)
def test_after_finish_error_is_swallowed(user, monkeypatch):
    def broken(report):
        raise RuntimeError("Discord 오류")
    monkeypatch.setattr(auto, "after_finish", broken, raising=False)
    monkeypatch.setattr(orchestrator, "run_report", fake_run([]))
    report = make_report(user)
    assert runner.tick() == 1
    join()
    report.refresh_from_db()
    assert report.status == Report.COMPLETED


@pytest.mark.django_db
def test_tick_is_quiet_without_work(capsys, caplog):
    assert runner.tick() == 0 and runner._worker is None
    out, err = capsys.readouterr()
    assert out == "" and err == "" and caplog.records == []


@pytest.mark.django_db
def test_recover_marks_running_reports_engine_restarted(user, clean_runner):
    stuck = state.start(make_report(user))
    waiting = make_report(user)

    assert runner.recover() == 1
    stuck.refresh_from_db()
    waiting.refresh_from_db()
    assert stuck.status == Report.FAILED and stuck.finished_at is not None and waiting.status == Report.REQUESTED
    last = stuck.trace_events.order_by("step").last()
    assert (last.actor, last.action, last.status) == ("orchestrator", "workflow_failed", "failed")
    assert last.details == {"reason": "engine_restarted"}
    assert clean_runner == [(stuck.pk, Report.FAILED)]
    assert runner.recover() == 0


@pytest.mark.django_db
def test_shutdown_and_wait_without_thread():
    runner.shutdown(timeout=0.1)
    runner.wait(timeout=0.1)


@pytest.mark.django_db(transaction=True)
def test_run_engine_once_runs_report_to_completion(user, monkeypatch, clean_runner, tmp_path):
    """run_engine --once: requested 리포트를 Agent 팀(가짜 Worker·가짜 LLM)으로 끝까지 돌리고 기다린다."""
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")  # 같은 루프의 "자동 리포트" 단계가 실제 runs/를 건드리지 않게
    monkeypatch.setattr(healing, "llm_client", lambda: FakeLlm({}))
    monkeypatch.setattr(orchestrator.agents, "WORKERS", fake_team())
    monkeypatch.setattr(orchestrator, "make_executor", lambda workers: orchestrator.InlineExecutor())
    report = make_report(user)

    out, err = StringIO(), StringIO()
    call_command("run_engine", "--once", stdout=out, stderr=err)
    report.refresh_from_db()
    assert report.status == Report.COMPLETED and report.content == "# 삼성전자\n\n본문"
    assert "리포트 실행 실패" not in err.getvalue()
    assert clean_runner == [(report.pk, Report.COMPLETED)]


@pytest.mark.django_db
def test_run_next_runs_oldest_inline(user, monkeypatch, clean_runner, inline_workers):
    """엔진 루프 없이(auto_report --wait): 부른 스레드에서 오래된 것부터 하나씩 끝까지."""
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    monkeypatch.setattr(healing, "llm_client", lambda: FakeLlm({}))
    monkeypatch.setattr(orchestrator.agents, "WORKERS", fake_team())
    newer, older = old_report(user, 1), old_report(user, 5)

    assert runner.run_next() == older.pk and runner._worker is None
    assert runner.run_next() == newer.pk and runner.run_next() is None
    assert clean_runner == [(older.pk, Report.COMPLETED), (newer.pk, Report.COMPLETED)]


@pytest.mark.django_db(transaction=True)
def test_tick_expires_stale_requests_instead_of_running_them(user, monkeypatch, clean_runner):
    """24시간 넘게 기다린 신청은 실행하지 않고 expired로 끝낸다 (묵은 신청이 실제 비용으로 한꺼번에 돌지 않게 — Q5)."""
    calls = []
    monkeypatch.setattr(orchestrator, "run_report", fake_run(calls))
    stale = old_report(user, minutes=runner.STALE_REQUEST_HOURS * 60 + 1)
    fresh = old_report(user, minutes=runner.STALE_REQUEST_HOURS * 60 - 5, symbol="AAPL")

    assert runner.tick() == 1
    join()
    stale.refresh_from_db()
    fresh.refresh_from_db()
    assert stale.status == Report.FAILED and fresh.status == Report.COMPLETED and calls == [fresh.pk]
    last = stale.trace_events.order_by("step").last()
    assert (last.action, last.details["reason"]) == ("workflow_failed", "expired")
    assert (stale.pk, Report.FAILED) in clean_runner
    assert runner.expire_stale() == 0
