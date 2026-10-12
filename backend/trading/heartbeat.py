"""엔진 상태 기록 (admin/API.md 5-1): run_engine이 30초마다 engine_status 행 하나를 고친다.

관리 서버가 이 행으로 엔진이 마지막으로 동작한 시각(2분 넘으면 "멈춤"), 버전, 중단 스위치, 최근 단계 오류, 하루 한도를 본다.
중단 스위치 파일과 한도 설정은 엔진 서버에만 있으므로 엔진이 값을 읽어 행에 적는다. 비밀 값은 넣지 않는다.
"""
import os
import re
import socket
import time
from collections import deque
from datetime import datetime, timedelta

from config import engine

from .models import EngineStatus

NAME = "run_engine"
INTERVAL = timedelta(seconds=30)
MAX_ERRORS = 20
MAX_ERROR_CHARS = 300
_URL = re.compile(r"(https?://[^/\s?#]+)[^\s]*")  # 주소의 경로·쿼리(웹훅 토큰·API 키)는 가린다
_WEBHOOK_PATH = re.compile(r"/api/(?:v\d+/)?webhooks/\S+")  # requests 오류 문장의 "url: /api/webhooks/<id>/<토큰>"


def clean_error(error: BaseException) -> str:
    """`예외이름: 메시지`를 300자로. URL은 호스트까지만 남기고, 스킴 없는 웹훅 경로도 가린다."""
    text = _URL.sub(lambda m: m.group(1) + ("/…" if len(m.group(0)) > len(m.group(1)) else ""), f"{type(error).__name__}: {error}")
    text = " ".join(_WEBHOOK_PATH.sub("/api/webhooks/…", text).split())
    return text if len(text) <= MAX_ERROR_CHARS else text[:MAX_ERROR_CHARS - 1] + "…"


def limits() -> dict:
    """관리 화면이 오늘 사용량과 견주는 하루 한도 (설정 값만)."""
    from analysis import quota as analysis_quota
    from reports.limits import quota as report_quota

    return {"aiDailyBudgetUsd": float(analysis_quota.budget_usd()), "analysisCostUsd": float(analysis_quota.COST_PER_ANALYSIS_USD),
            "analysesPerUser": analysis_quota.per_user_limit(), "analysesTotal": analysis_quota.total_limit(),
            "reportsPerUser": report_quota.per_user_limit()}


class Heartbeat:
    """루프 하나의 상태. 단계 오류를 모아 두었다가 beat가 행에 같이 적는다."""

    def __init__(self, now: datetime):
        self.started_at = now
        self.errors: deque[dict] = deque(maxlen=MAX_ERRORS)  # 최신이 앞
        self.last_beat: datetime | None = None
        self.tick_started: float | None = None
        self.last_tick_ms: int | None = None  # 마지막으로 끝난 바퀴의 길이
        self.new_error = False  # 마지막 기록 뒤 단계 오류가 생겼으면 30초를 기다리지 않고 바로 남긴다

    def tick_start(self) -> None:
        self.tick_started = time.monotonic()

    def tick_end(self) -> None:
        if self.tick_started is not None:
            self.last_tick_ms = round((time.monotonic() - self.tick_started) * 1000)

    def error(self, at: datetime, step: str, error: BaseException) -> None:
        self.errors.appendleft({"at": at.isoformat(), "step": step, "error": clean_error(error)})
        self.new_error = True

    def beat(self, now: datetime, broker_ready: bool, force: bool = False) -> bool:
        """마지막 기록에서 30초가 지났거나 새 단계 오류가 있으면(또는 force) 행을 고친다. 고쳤으면 True."""
        if not (force or self.new_error) and self.last_beat is not None and now - self.last_beat < INTERVAL:
            return False
        EngineStatus.objects.update_or_create(name=NAME, defaults={
            "version": (os.environ.get("APP_VERSION") or "dev")[:64], "host": socket.gethostname()[:128], "pid": os.getpid(),
            "started_at": self.started_at, "beat_at": now, "halted": engine.HALT_FILE.exists(), "broker_ready": broker_ready,
            "last_tick_ms": self.last_tick_ms, "step_errors": list(self.errors), "limits": limits()})
        self.last_beat = now
        self.new_error = False
        return True
