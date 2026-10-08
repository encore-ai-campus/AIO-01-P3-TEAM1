"""F3 서비스 상태: `{ADMIN_SERVICE_URL}/api/health`와 `/`를 주기적으로 불러 메모리 링 버퍼(24시간분)에 둔다.

FastAPI lifespan의 asyncio 작업이 돌린다 (uvicorn 워커 1개 전제). 테스트는 clock·transport를 주입한다.
"""
import asyncio
import contextlib
import logging
import math
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta

import httpx

from .util import iso, utcnow

log = logging.getLogger(__name__)
TIMEOUT_SEC = 5.0
RECENT = 60
WARN_WINDOW = timedelta(minutes=10)
SLOW_MS = 2000


@dataclass(frozen=True)
class Probe:
    ok: bool
    status: int | None
    ms: int | None
    error: str | None

    def as_dict(self) -> dict:
        return {"ok": self.ok, "status": self.status, "ms": self.ms, "error": self.error}


@dataclass(frozen=True)
class Check:
    at: datetime
    api: Probe
    page: Probe

    @property
    def ok(self) -> bool:
        return self.api.ok and self.page.ok

    def as_dict(self) -> dict:
        return {"at": iso(self.at), "api": self.api.as_dict(), "page": self.page.as_dict()}


class HealthMonitor:
    def __init__(self, url: str, interval_sec: int = 30, *, clock=utcnow, transport: httpx.AsyncBaseTransport | None = None):
        self.url = url
        self.interval = interval_sec
        self.clock = clock
        self.transport = transport
        self.checks: deque[Check] = deque(maxlen=math.ceil(86400 / interval_sec) + 1)

    async def _probe(self, client: httpx.AsyncClient, path: str) -> Probe:
        started = time.perf_counter()
        try:
            res = await client.get(self.url + path)
        except httpx.TimeoutException:
            return Probe(False, None, None, "timeout")
        except httpx.HTTPError:
            return Probe(False, None, None, "connection")
        ms = round((time.perf_counter() - started) * 1000)
        ok = res.status_code < 400
        return Probe(ok, res.status_code, ms, None if ok else f"HTTP {res.status_code}")

    async def check_once(self) -> Check | None:
        if not self.url:
            return None
        async with httpx.AsyncClient(timeout=TIMEOUT_SEC, transport=self.transport, follow_redirects=False) as client:
            api, page = await asyncio.gather(self._probe(client, "/api/health"), self._probe(client, "/"))
        check = Check(at=self.clock(), api=api, page=page)
        self.checks.append(check)
        return check

    async def run(self) -> None:
        while True:
            try:
                await self.check_once()
            except Exception as e:  # 확인 작업이 죽으면 F3이 멈추므로 계속 돈다
                log.warning("health check 실패: %s", type(e).__name__)
            await asyncio.sleep(self.interval)

    @contextlib.asynccontextmanager
    async def running(self):
        task = asyncio.create_task(self.run()) if self.url else None
        try:
            yield self
        finally:
            if task:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task

    def status(self, now: datetime) -> dict:
        """ServiceStatus (API.md F3)."""
        checks = list(self.checks)
        latest = checks[-1] if checks else None
        day = [c for c in checks if c.at >= now - timedelta(hours=24)]
        api_ms = [c.api.ms for c in day if c.api.ok and c.api.ms is not None]
        down_since = None
        if latest and not latest.ok:
            for c in reversed(checks):
                if c.ok:
                    break
                down_since = c.at
        return {
            "url": self.url, "intervalSec": self.interval, "level": self.level(now),
            "latest": latest.as_dict() if latest else None,
            "downSince": iso(down_since),
            "uptimePct24h": round(sum(c.ok for c in day) / len(day) * 100, 1) if day else None,
            "avgMs24h": round(sum(api_ms) / len(api_ms)) if api_ms else None,
            "recent": [c.as_dict() for c in reversed(checks[-RECENT:])],
        }

    def level(self, now: datetime) -> str:
        if not self.checks:
            return "unknown"
        latest = self.checks[-1]
        if not latest.ok:
            return "down"
        if any(not c.ok for c in self.checks if c.at >= now - WARN_WINDOW):
            return "warn"
        if latest.api.ms is not None and latest.api.ms > SLOW_MS:
            return "warn"
        return "ok"

    def summary(self, now: datetime) -> str:
        """개요 한 줄."""
        if not self.url:
            return "서비스 주소가 설정되지 않음"
        if not self.checks:
            return "아직 확인 전"
        latest = self.checks[-1]
        if not latest.ok:
            since = self.status(now)["downSince"]
            mins = int((now - datetime.fromisoformat(since)).total_seconds() // 60) if since else 0
            what = "API" if not latest.api.ok else "페이지"
            return f"{what} 응답 없음 ({mins}분째)" if mins else f"{what} 응답 없음"
        level = self.level(now)
        if level == "warn" and latest.api.ms is not None and latest.api.ms > SLOW_MS:
            return f"응답 느림 {latest.api.ms:,}ms"
        if level == "warn":
            return "최근 10분 안에 응답 실패가 있었음"
        return f"정상 · 응답 {latest.api.ms:,}ms" if latest.api.ms is not None else "정상"
