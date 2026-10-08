"""엔진 상태 기록 (admin/API.md 5-1): run_engine이 engine_status 행에 생존 신호·버전·중단 스위치·단계 오류·한도를 남긴다."""
from datetime import timedelta
from io import StringIO

import pytest
from django.core.management import call_command
from notifications import dispatch

from config import engine
from trading import heartbeat, service
from trading.models import EngineStatus

pytestmark = pytest.mark.django_db


def run_once() -> str:
    err = StringIO()
    call_command("run_engine", "--once", stdout=StringIO(), stderr=err)
    return err.getvalue()


def test_run_engine_writes_status_row(monkeypatch):
    monkeypatch.setenv("APP_VERSION", "500d087abc")
    monkeypatch.setenv("AI_DAILY_BUDGET_USD", "12.5")
    engine.HALT_FILE.touch()
    assert run_once() == ""
    row = EngineStatus.objects.get(name="run_engine")
    assert row.version == "500d087abc" and row.halted is True and row.broker_ready is False
    assert row.beat_at >= row.started_at and row.step_errors == []
    assert row.limits == {"aiDailyBudgetUsd": 12.5, "analysisCostUsd": 0.3, "analysesPerUser": 5, "analysesTotal": 41,
                          "reportsPerUser": 3}


def test_step_error_is_recorded_with_url_hidden(monkeypatch):
    def broken(now, log):
        raise RuntimeError("POST https://discord.com/api/webhooks/123/secret-token?wait=true 실패")

    monkeypatch.setattr(dispatch, "tick", broken)
    err = run_once()
    assert "알림 발송 실패" in err
    errors = EngineStatus.objects.get(name="run_engine").step_errors
    assert len(errors) == 1 and errors[0]["step"] == "알림 발송"
    assert errors[0]["error"] == "RuntimeError: POST https://discord.com/… 실패"
    assert "secret-token" not in str(errors)


def test_beat_writes_every_30_seconds():
    now = service.now()
    beat = heartbeat.Heartbeat(now)
    assert beat.beat(now, broker_ready=True) is True
    assert EngineStatus.objects.get(name="run_engine").last_tick_ms is None  # 아직 끝난 바퀴가 없다
    beat.tick_start()
    beat.tick_end()
    assert beat.beat(now + timedelta(seconds=29), broker_ready=True) is False
    assert beat.beat(now + timedelta(seconds=29), broker_ready=True, force=True) is True
    assert beat.beat(now + timedelta(seconds=60), broker_ready=False) is True
    row = EngineStatus.objects.get(name="run_engine")
    assert row.beat_at == now + timedelta(seconds=60) and row.broker_ready is False and EngineStatus.objects.count() == 1
    assert row.last_tick_ms is not None and row.last_tick_ms >= 0


def test_long_tick_beats_at_start_too(monkeypatch):
    """한 단계가 오래 걸려도 다음 바퀴 시작에 남겨, 관리 서버가 바퀴 길이만큼만 늦게 본다."""
    from notifications import dispatch

    from trading.management.commands import run_engine

    monkeypatch.setattr(dispatch, "tick", lambda now, log: None)
    command = run_engine.Command(stdout=StringIO(), stderr=StringIO())
    command.heartbeat = heartbeat.Heartbeat(service.now())
    beats = []
    monkeypatch.setattr(command.heartbeat, "beat", lambda now, broker, force=False: beats.append(now))
    command.tick()
    assert len(beats) == 2   # 바퀴 시작과 끝


def test_new_error_is_written_without_waiting():
    now = service.now()
    beat = heartbeat.Heartbeat(now)
    assert beat.beat(now, broker_ready=True) is True
    beat.error(now, "자동매매", RuntimeError("x"))
    assert beat.beat(now + timedelta(seconds=5), broker_ready=True) is True
    assert beat.beat(now + timedelta(seconds=10), broker_ready=True) is False


def test_errors_keep_latest_20_newest_first():
    now = service.now()
    beat = heartbeat.Heartbeat(now)
    for i in range(25):
        beat.error(now + timedelta(seconds=i), "체결 확인", ValueError(f"오류 {i}"))
    beat.beat(now, broker_ready=True)
    errors = EngineStatus.objects.get(name="run_engine").step_errors
    assert len(errors) == 20 and errors[0]["error"] == "ValueError: 오류 24" and errors[-1]["error"] == "ValueError: 오류 5"


def test_clean_error_hides_schemeless_webhook_path():
    text = heartbeat.clean_error(ConnectionError("HTTPSConnectionPool(host='discord.com', port=443): url: /api/webhooks/1/SECRET?wait=true"))
    assert "SECRET" not in text and "url: /api/webhooks/…" in text


def test_clean_error_cuts_long_messages():
    text = heartbeat.clean_error(ValueError("가" * 500))
    assert len(text) == 300 and text.endswith("…")
