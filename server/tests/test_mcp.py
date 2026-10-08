"""MCP 서버: 도구 9개(읽기 전용), 호출이 토큰과 X-Admin-Tool을 붙여 관리자 API를 부르는지, 토큰 없으면 401."""
import asyncio
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from paper_admin import mcp_tools
from paper_admin.mcp_server import create_app

HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}
NAMES = {"overview", "service_status", "engine_status", "deploy_history", "report_failures", "report_trace",
         "recovery_stats", "ai_costs", "alerts_and_jobs"}


class FakeApi:
    def __init__(self):
        self.calls = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        self.calls.append(req)
        if req.headers.get("authorization") != "Bearer good":
            return httpx.Response(401, json={"detail": "토큰이 맞지 않습니다."})
        if req.url.path == "/api/admin/me":
            return httpx.Response(200, json={"username": "alice", "via": "token"})
        if req.url.path.endswith("/999/trace"):
            return httpx.Response(404, json={"detail": "리포트가 없습니다."})
        return httpx.Response(200, json={"path": req.url.path, "params": dict(req.url.params)})


@pytest.fixture
def fake():
    return FakeApi()


@pytest.fixture
def mcp(fake):
    app, server = create_app("http://api:8100", httpx.MockTransport(fake))
    with TestClient(app) as client:
        yield client, server


def rpc(client, method, params=None, token="good"):
    headers = {**HEADERS, **({"Authorization": f"Bearer {token}"} if token else {})}
    return client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
                       headers=headers)


def test_nine_read_only_tools(mcp):
    _, server = mcp
    tools = asyncio.run(server.list_tools())
    assert {t.name for t in tools} == NAMES
    for t in tools:
        assert t.annotations.read_only_hint is True and t.annotations.destructive_hint is False
        assert t.description


def test_tools_list_over_http(mcp):
    client, _ = mcp
    res = rpc(client, "tools/list")
    assert res.status_code == 200
    assert {t["name"] for t in res.json()["result"]["tools"]} == NAMES


@pytest.mark.parametrize("tool,args,path,params", [
    ("overview", {}, "/api/admin/overview", {}),
    ("service_status", {}, "/api/admin/service", {}),
    ("engine_status", {}, "/api/admin/engine", {}),
    ("deploy_history", {}, "/api/admin/deploys", {"limit": "50"}),
    ("report_failures", {"days": 3, "kind": "failed"}, "/api/admin/reports",
     {"days": "3", "kind": "failed", "team": "", "limit": "100"}),
    ("report_trace", {"report_id": 12}, "/api/admin/reports/12/trace", {}),
    ("recovery_stats", {}, "/api/admin/recovery", {"days": "7"}),
    ("ai_costs", {"days": 30}, "/api/admin/costs", {"days": "30"}),
    ("alerts_and_jobs", {}, "/api/admin/alerts", {"hours": "24"}),
])
def test_tool_calls_admin_api(mcp, fake, tool, args, path, params):
    client, _ = mcp
    res = rpc(client, "tools/call", {"name": tool, "arguments": args})
    assert res.status_code == 200
    result = res.json()["result"]
    assert result["isError"] is False
    assert result["structuredContent"] == {"path": path, "params": params}
    assert json.loads(result["content"][0]["text"]) == {"path": path, "params": params}
    call = fake.calls[-1]
    assert call.method == "GET" and call.url.host == "api" and call.url.port == 8100
    assert call.headers["authorization"] == "Bearer good" and call.headers["x-admin-tool"] == tool
    # 관리자 화면의 도구 목록(mcp_tools)이 실제로 부르는 경로·인자와 같다
    listed = mcp_tools.BY_NAME[tool]
    assert listed.path.format(**args) == path and set(listed.params) >= set(params) | set(args)


def test_api_error_becomes_tool_error(mcp):
    client, _ = mcp
    result = rpc(client, "tools/call", {"name": "report_trace", "arguments": {"report_id": 999}}).json()["result"]
    assert result["isError"] is True and "404" in result["content"][0]["text"]


def test_token_checked_and_cached(mcp, fake):
    client, _ = mcp
    rpc(client, "tools/list")
    rpc(client, "tools/list")
    assert [c.url.path for c in fake.calls].count("/api/admin/me") == 1  # 60초 기억


@pytest.mark.parametrize("token", [None, "bad"])
def test_missing_or_wrong_token_is_401(mcp, fake, token):
    client, _ = mcp
    res = rpc(client, "tools/call", {"name": "overview", "arguments": {}}, token=token)
    assert res.status_code == 401
    assert all(c.url.path == "/api/admin/me" for c in fake.calls)  # 도구는 불리지 않음


def test_tunnel_host_accepted_with_token(mcp):
    """nginx·SSH 터널을 거친 Host(localhost:8080)도 토큰이 맞으면 받는다."""
    client, _ = mcp
    res = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
                      headers={**HEADERS, "Authorization": "Bearer good", "Host": "localhost:8080",
                               "Origin": "http://localhost:8080"})
    assert res.status_code == 200


def test_every_http_request_needs_token(mcp):
    client, _ = mcp
    assert client.get("/mcp").status_code == 401
    assert client.delete("/mcp").status_code == 401
    assert client.get("/anything").status_code == 401
