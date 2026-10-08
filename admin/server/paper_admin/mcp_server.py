"""조회 전용 MCP 서버: `python -m paper_admin.mcp_server` → streamable HTTP `0.0.0.0:8101/mcp` (stateless, JSON 응답).

DB에 붙지 않는다. 도구는 호출자의 Bearer 토큰과 `X-Admin-Tool: <도구 이름>`을 붙여 관리자 API를 GET하고 JSON을 그대로 돌려준다
(숫자는 관리자 백엔드 한 곳에서만 만든다). 모든 HTTP 요청은 Bearer 토큰이 필요하고, 미들웨어가 `GET /api/admin/me`로 확인한다.
mcp 2.x: `mcp.server.mcpserver.MCPServer`, 요청 헤더는 도구의 `Context.headers`로 읽는다.
"""
import hashlib
import os
import time
from typing import Any

import httpx
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.datastructures import Headers
from starlette.responses import JSONResponse

CACHE_SEC = 60
TIMEOUT_SEC = 15.0
READ_ONLY = ToolAnnotations(read_only_hint=True, destructive_hint=False, idempotent_hint=True, open_world_hint=False)


def _bearer(headers) -> str | None:
    value = (headers.get("authorization") if headers else None) or ""
    scheme, _, token = value.partition(" ")
    return token.strip() or None if scheme.lower() == "bearer" else None


class AdminApi:
    """관리자 API GET. transport는 테스트가 가짜 API(httpx.MockTransport)를 끼울 때 쓴다."""

    def __init__(self, base_url: str, transport: httpx.AsyncBaseTransport | None = None):
        self.base_url = base_url.rstrip("/")
        self.transport = transport

    async def get(self, path: str, token: str, tool: str | None = None, params: dict | None = None) -> httpx.Response:
        headers = {"Authorization": f"Bearer {token}"}
        if tool:
            headers["X-Admin-Tool"] = tool
        async with httpx.AsyncClient(base_url=self.base_url, timeout=TIMEOUT_SEC, transport=self.transport) as client:
            return await client.get(path, headers=headers, params=params)


class TokenCheck:
    """토큰이 맞는지 `GET /api/admin/me`로 확인한다. 맞은 토큰은 해시별로 60초 기억한다."""

    def __init__(self, api: AdminApi, clock=time.monotonic):
        self.api = api
        self.clock = clock
        self.ok_until: dict[str, float] = {}

    async def valid(self, token: str) -> bool:
        key = hashlib.sha256(token.encode()).hexdigest()
        now = self.clock()
        if self.ok_until.get(key, 0) > now:
            return True
        try:
            res = await self.api.get("/api/admin/me", token)
        except httpx.HTTPError:
            return False
        if res.status_code != 200:
            self.ok_until.pop(key, None)
            return False
        self.ok_until[key] = now + CACHE_SEC
        return True


class BearerAuth:
    """모든 HTTP 요청에 Bearer 토큰을 요구하는 ASGI 미들웨어. 없거나 틀리면 401."""

    def __init__(self, app, check: TokenCheck):
        self.app = app
        self.check = check

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            token = _bearer(Headers(scope=scope))
            if token is None or not await self.check.valid(token):
                response = JSONResponse({"detail": "토큰이 없거나 맞지 않습니다."}, status_code=401,
                                        headers={"WWW-Authenticate": "Bearer"})
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


TOOLS: dict[str, str] = {
    "overview": "관리자 개요: 서비스·엔진·배포·리포트 장애·복구 지표·AI 비용·알림을 나쁜 것부터 한 줄씩 요약한다.",
    "service_status": "서비스 주소(/api/health, /)의 응답 여부·응답 시간과 최근 24시간 가동률을 본다.",
    "engine_status": "엔진 루프의 마지막 동작 시각(2분 넘으면 멈춤)·버전·중단 스위치·최근 단계 오류·한도를 본다.",
    "deploy_history": "서버별 지금 버전과 배포 기록(성공·실패·되돌림)을 최신순으로 본다. limit 1~200.",
    "report_failures": "기간 안 AI 리포트의 실패·복구·장애 주입 목록. days 1~90, kind all|failed|recovered|chaos, "
                       "team stock_report|stock_selection|빈 값, limit 1~500.",
    "report_trace": "리포트 하나의 실행 기록(재시도·대체 모델 전환·포기)을 시간순으로 보고 복구 요약을 함께 본다.",
    "recovery_stats": "기간 안 자동 복구율·평균 복구 시간·오류 종류별·Worker별 장애 수. days 1~90.",
    "ai_costs": "날짜별 AI 비용(리포트·분석·장기투자)과 오늘 예산·한도 대비 사용량. days 1~90.",
    "alerts_and_jobs": "Discord 알림 발송 실패·오래된 대기와 오래 멈춘 분석·리포트 작업을 본다. hours 1~168.",
}


def create_server(api: AdminApi) -> MCPServer:
    server = MCPServer("paper-admin", instructions="모매매 관리 서버의 조회 전용 도구. 쓰기 도구는 없다.")

    async def call(ctx: Context, tool: str, path: str, params: dict | None = None) -> dict[str, Any]:
        token = _bearer(ctx.headers)
        if token is None:
            raise ToolError("토큰이 없습니다.")
        try:
            res = await api.get(path, token, tool, {k: v for k, v in (params or {}).items() if v is not None})
        except httpx.HTTPError as e:
            raise ToolError(f"관리자 API에 연결할 수 없습니다 ({type(e).__name__})") from None
        try:
            data = res.json()
        except ValueError:
            data = None
        if res.status_code != 200:
            detail = data.get("detail") if isinstance(data, dict) else None
            raise ToolError(f"관리자 API {res.status_code}: {detail or '오류'}")
        return data

    def register(fn):
        server.add_tool(fn, name=fn.__name__, description=TOOLS[fn.__name__], annotations=READ_ONLY)
        return fn

    @register
    async def overview(ctx: Context) -> dict[str, Any]:
        return await call(ctx, "overview", "/api/admin/overview")

    @register
    async def service_status(ctx: Context) -> dict[str, Any]:
        return await call(ctx, "service_status", "/api/admin/service")

    @register
    async def engine_status(ctx: Context) -> dict[str, Any]:
        return await call(ctx, "engine_status", "/api/admin/engine")

    @register
    async def deploy_history(ctx: Context, limit: int = 50) -> dict[str, Any]:
        return await call(ctx, "deploy_history", "/api/admin/deploys", {"limit": limit})

    @register
    async def report_failures(ctx: Context, days: int = 7, kind: str = "all", team: str = "",
                              limit: int = 100) -> dict[str, Any]:
        return await call(ctx, "report_failures", "/api/admin/reports",
                          {"days": days, "kind": kind, "team": team, "limit": limit})

    @register
    async def report_trace(ctx: Context, report_id: int) -> dict[str, Any]:
        return await call(ctx, "report_trace", f"/api/admin/reports/{int(report_id)}/trace")

    @register
    async def recovery_stats(ctx: Context, days: int = 7) -> dict[str, Any]:
        return await call(ctx, "recovery_stats", "/api/admin/recovery", {"days": days})

    @register
    async def ai_costs(ctx: Context, days: int = 14) -> dict[str, Any]:
        return await call(ctx, "ai_costs", "/api/admin/costs", {"days": days})

    @register
    async def alerts_and_jobs(ctx: Context, hours: int = 24) -> dict[str, Any]:
        return await call(ctx, "alerts_and_jobs", "/api/admin/alerts", {"hours": hours})

    return server


def create_app(api_url: str | None = None, transport: httpx.AsyncBaseTransport | None = None):
    """Bearer 미들웨어로 감싼 streamable HTTP ASGI 앱 (경로 /mcp).

    Host/Origin 검사(DNS rebinding 보호)는 끈다: SSH 터널·nginx를 거치면 Host가 터널 주소(localhost:8080 등)가 되고,
    모든 요청에 Bearer 토큰을 요구하므로 브라우저가 토큰 없이 부를 수 없다.
    """
    api = AdminApi(api_url or (os.environ.get("ADMIN_API_URL") or "").strip() or "http://api:8100", transport)
    server = create_server(api)
    app = server.streamable_http_app(streamable_http_path="/mcp", json_response=True, stateless_http=True,
                                     host="0.0.0.0",
                                     transport_security=TransportSecuritySettings(enable_dns_rebinding_protection=False))
    return BearerAuth(app, TokenCheck(api)), server


def main() -> None:
    import uvicorn
    app, _ = create_app()
    uvicorn.run(app, host="0.0.0.0", port=8101, workers=1)


if __name__ == "__main__":
    main()
