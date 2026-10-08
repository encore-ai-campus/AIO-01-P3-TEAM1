"""관리자 API `/api/admin/*` (API.md). `uvicorn paper_admin.api:app --host 0.0.0.0 --port 8100` (워커 1개).

조회만 한다 (쓰기는 로그인·로그아웃뿐). 오류 응답은 모두 {"detail": string}. OpenAPI·docs 경로는 끈다.
"""
import contextlib
import json
import re
from dataclasses import dataclass
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import deploys as deploy_log
from . import mcp_usage, metrics
from .auth import (COOKIE_NAME, DUMMY_HASH, LOGIN_FAILED, SESSION_TTL, AuditLog, LoginLimiter, Sessions, TokenStore,
                   find_staff, verify_django_password)
from .config import Settings, load
from .db import Database, DBUnavailable, connect
from .health import HealthMonitor
from .util import iso, utcnow

DB_DOWN = "서비스 DB에 연결할 수 없습니다"
TOOL = re.compile(r"[a-z_]{1,40}")
TITLES = {"service": "서비스 상태", "engine": "엔진 상태", "deploys": "배포 기록", "reports": "리포트 장애",
          "recovery": "복구 지표", "costs": "AI 비용", "alerts": "알림·작업 실패"}


@dataclass(frozen=True)
class Principal:
    username: str
    via: Literal["session", "token"]

    def me(self) -> dict:
        return {"username": self.username, "via": self.via}


def _bearer(request: Request) -> str | None:
    header = request.headers.get("authorization") or ""
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else None


def create_app(settings: Settings, *, db: Database | None = None, monitor: HealthMonitor | None = None,
               clock=utcnow) -> FastAPI:
    db = db or connect(settings.database_url)
    monitor = monitor or HealthMonitor(settings.service_url, settings.health_interval_sec)
    sessions = Sessions(settings.secret_key)
    limiter = LoginLimiter()
    tokens = TokenStore(settings.tokens_path)
    audit = AuditLog(settings.audit_path)

    @contextlib.asynccontextmanager
    async def lifespan(_app: FastAPI):
        async with monitor.running():
            yield
        close = getattr(db, "close", None)  # PostgreSQL 연결 풀
        if close is not None:
            close()

    app = FastAPI(title="paper-admin", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.settings, app.state.db, app.state.monitor = settings, db, monitor

    @app.exception_handler(RequestValidationError)
    async def _bad_request(_request: Request, exc: RequestValidationError):
        fields = sorted({str(e.get("loc", ["", "?"])[-1]) for e in exc.errors()})
        return JSONResponse({"detail": f"잘못된 값입니다: {', '.join(fields)}"}, status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def _http_error(_request: Request, exc: StarletteHTTPException):
        return JSONResponse({"detail": str(exc.detail)}, status_code=exc.status_code, headers=exc.headers)

    @app.exception_handler(DBUnavailable)
    async def _db_down(_request: Request, _exc: DBUnavailable):
        return JSONResponse({"detail": DB_DOWN}, status_code=503)

    @app.middleware("http")
    async def _audit_tokens(request: Request, call_next):
        """토큰 요청은 응답 코드와 함께 감사 기록 한 줄 (토큰 원문은 적지 않는다)."""
        response = await call_next(request)
        if _bearer(request) is not None and request.url.path.startswith("/api/admin/") \
                and request.url.path != "/api/admin/health":
            tool = request.headers.get("x-admin-tool") or ""
            path = request.url.path + (f"?{request.url.query}" if request.url.query else "")
            audit.write(clock(), via="token", who=getattr(request.state, "token_name", None), event="request",
                        tool=tool if TOOL.fullmatch(tool) else None, path=path[:300], status=response.status_code)
        return response

    def principal(request: Request) -> Principal:
        token = _bearer(request)
        if token is not None:
            name = tokens.name_for(token)
            if name is None:
                raise HTTPException(401, "토큰이 맞지 않습니다.")
            request.state.token_name = name
            return Principal(name, "token")
        cookie = request.cookies.get(COOKIE_NAME)
        try:
            staff = sessions.staff_for(db, cookie, clock())
        except DBUnavailable:
            # 서비스 DB(터널)가 끊겨도 DB가 필요 없는 화면(F3 서비스 상태·F5 배포 기록)은 볼 수 있게: 서명·만료·로그아웃만 본다.
            # DB가 돌아오면 다음 요청부터 staff·비밀번호 확인을 다시 한다.
            data = sessions.read(cookie, clock())
            if data is None:
                raise HTTPException(401, "로그인이 필요합니다.") from None
            return Principal(data["username"], "session")
        if staff is None:
            raise HTTPException(401, "로그인이 필요합니다.")
        return Principal(staff.username, "session")

    authed = [Depends(principal)]

    @app.get("/api/admin/health")
    def health():
        return {"ok": True}

    @app.post("/api/admin/login")
    async def login(request: Request):
        try:
            body = json.loads(await request.body() or b"{}")
        except ValueError:
            body = None
        username = body.get("username") if isinstance(body, dict) else None
        password = body.get("password") if isinstance(body, dict) else None
        if not isinstance(username, str) or not isinstance(password, str) or not username.strip() or not password:
            raise HTTPException(400, "아이디와 비밀번호를 입력하세요.")
        username = username.strip()[:150]
        key = limiter.key(username)
        if not limiter.try_attempt(key):
            raise HTTPException(429, "로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도하세요.")
        staff = await run_in_threadpool(find_staff, db, username=username)
        usable = staff is not None and staff.is_active
        # 없는 아이디도 같은 시간이 걸리게 가짜 해시로 한 번 검증한다 (응답 시간으로 staff 아이디를 알 수 없게)
        verified = await run_in_threadpool(verify_django_password, password, staff.password if usable else DUMMY_HASH)
        ok = usable and verified
        now = clock()
        if not ok:
            audit.write(now, via="session", who=username, event="login_failed", path="/api/admin/login", status=401)
            raise HTTPException(401, LOGIN_FAILED)
        limiter.success(key)
        audit.write(now, via="session", who=staff.username, event="login", path="/api/admin/login", status=200)
        response = JSONResponse(Principal(staff.username, "session").me())
        response.set_cookie(COOKIE_NAME, sessions.make(staff, now), max_age=int(SESSION_TTL.total_seconds()),
                            httponly=True, samesite="strict", secure=settings.cookie_secure, path="/")
        return response

    @app.post("/api/admin/logout", status_code=204)
    def logout(request: Request):
        sessions.revoke(request.cookies.get(COOKIE_NAME), clock())  # 복사해 둔 쿠키도 다시 못 쓴다
        response = Response(status_code=204)
        response.delete_cookie(COOKIE_NAME, path="/", httponly=True, samesite="strict", secure=settings.cookie_secure)
        return response

    @app.get("/api/admin/me")
    def me(who: Principal = Depends(principal)):
        return who.me()

    @app.get("/api/admin/service", dependencies=authed)
    def service():
        return monitor.status(clock())

    @app.get("/api/admin/engine", dependencies=authed)
    def engine():
        return metrics.engine(db, clock(), settings.engine_stale_sec)

    @app.get("/api/admin/deploys", dependencies=authed)
    def deploys(limit: int = Query(50, ge=1, le=200)):
        return deploy_log.deploys(settings.deploys_path, limit)

    @app.get("/api/admin/reports", dependencies=authed)
    def reports(days: int = Query(7, ge=1, le=90), kind: Literal["all", "failed", "recovered", "chaos"] = "all",
                team: Literal["", "stock_report", "stock_selection"] = "", limit: int = Query(100, ge=1, le=500)):
        return metrics.report_list(db, clock(), days, kind, team, limit)

    @app.get("/api/admin/reports/{report_id}/trace", dependencies=authed)
    def report_trace(report_id: int):
        data = metrics.report_trace(db, report_id)
        if data is None:
            raise HTTPException(404, "리포트가 없습니다.")
        return data

    @app.get("/api/admin/recovery", dependencies=authed)
    def recovery(days: int = Query(7, ge=1, le=90)):
        return metrics.recovery_stats(db, clock(), days)

    @app.get("/api/admin/costs", dependencies=authed)
    def costs(days: int = Query(14, ge=1, le=90)):
        return metrics.costs(db, clock(), days)

    @app.get("/api/admin/alerts", dependencies=authed)
    def alerts(hours: int = Query(24, ge=1, le=168)):
        return metrics.alerts(db, clock(), hours)

    @app.get("/api/admin/mcp", dependencies=authed)
    def mcp(hours: int = Query(24, ge=1, le=168), limit: int = Query(200, ge=1, le=500)):
        return mcp_usage.status(tokens, settings.audit_path, clock(), hours, limit)

    @app.get("/api/admin/overview", dependencies=authed)
    def overview():
        return build_overview(settings, db, monitor, clock())

    return app


def _item(key: str, fn) -> dict:
    try:
        level, summary = fn()
    except DBUnavailable:
        level, summary = "unknown", DB_DOWN
    return {"key": key, "title": TITLES[key], "level": level, "summary": summary}


def build_overview(settings: Settings, db: Database, monitor: HealthMonitor, now) -> dict:
    """F2: 항목 7개를 나쁜 것부터 (같으면 key 순서)."""
    def engine():
        data = metrics.engine(db, now, settings.engine_stale_sec)
        return data["level"], metrics.engine_summary(data)

    def alerts():
        data = metrics.alerts(db, now, 24)
        return data["level"], metrics.alerts_summary(data)

    items = [
        _item("service", lambda: (monitor.level(now), monitor.summary(now))),
        _item("engine", engine),
        _item("deploys", lambda: deploy_log.level(deploy_log.deploys(settings.deploys_path, 1))),
        _item("reports", lambda: metrics.reports_level(db, now)),
        _item("recovery", lambda: metrics.recovery_level(metrics.recovery_stats(db, now, 7))),
        _item("costs", lambda: metrics.costs_level(metrics.costs(db, now, 1))),
        _item("alerts", alerts),
    ]
    order = list(TITLES)
    items.sort(key=lambda i: (metrics.LEVEL_ORDER[i["level"]], order.index(i["key"])))
    return {"at": iso(now), "level": items[0]["level"], "items": items}


_app: FastAPI | None = None


def __getattr__(name: str):
    """`paper_admin.api:app`을 처음 찾을 때 환경 변수로 만든다 (설정이 틀리면 시작하지 않는다)."""
    global _app
    if name == "app":
        if _app is None:
            _app = create_app(load())
        return _app
    raise AttributeError(name)
