"""장애 주입 신청 (API.md 7장, F11): 서비스 내부 API를 서명해 부르고, 세션 쿠키로만 신청하며, 감사 기록을 남긴다.

서비스는 httpx.MockTransport로 흉내 낸다 (실제 네트워크를 부르지 않는다).
"""
import dataclasses
import hashlib
import hmac
import json
import time

import httpx
import pytest
from conftest import PASSWORD, audit_lines
from fastapi.testclient import TestClient

from paper_admin import mcp_tools
from paper_admin.api import CHAOS_BY_TOKEN, create_app
from paper_admin.chaos import OFF, UNREACHABLE, ChaosClient, sign

CHAOS_SECRET = "chaos-control-secret-0123456789"
OPTIONS = {"workers": [{"id": "market_agent", "title": "시세 조사"}, {"id": "news_agent", "title": "뉴스 조사"}],
           "errorTypes": ["timeout", "server_error", "bad_output"], "scopes": ["primary", "all"],
           "defaults": {"probability": 0.3, "scope": "primary"}}
REQUEST = {"symbol": "005930", "chaos": {"enabled": True, "probability": 0.8, "scope": "primary", "seed": 7}}


def _run(**chaos) -> dict:
    return {"id": 77, "status": "requested", "symbol": "005930", "name": "삼성전자",
            "chaos": {"enabled": True, "probability": 0.8, "errorTypes": ["timeout", "server_error", "bad_output"],
                      "workers": None, "scope": "primary", "seed": 7, "requestedBy": "admin", **chaos}}


class FakeService:
    """서비스 내부 API 흉내. 받은 요청을 모두 남기고 reply(request)로 답한다."""

    def __init__(self):
        self.requests: list[httpx.Request] = []
        self.reply = self.default

    @staticmethod
    def default(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/internal/chaos-runs/options":
            return httpx.Response(200, json=OPTIONS)
        return httpx.Response(201, json=_run())

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.reply(request)


@pytest.fixture
def service() -> FakeService:
    return FakeService()


@pytest.fixture
def chaos_settings(settings):
    return dataclasses.replace(settings, chaos_secret=CHAOS_SECRET)


@pytest.fixture
def chaos_app(chaos_settings, monitor, clock, service):
    chaos = ChaosClient(chaos_settings.service_internal_url, CHAOS_SECRET, transport=httpx.MockTransport(service))
    return create_app(chaos_settings, monitor=monitor, clock=clock, chaos=chaos)


@pytest.fixture
def admin(chaos_app, rows) -> TestClient:
    """장애 주입이 켜진 앱에 staff(admin)로 로그인한 클라이언트."""
    client = TestClient(chaos_app)
    rows.staff()
    assert client.post("/api/admin/login", json={"username": "admin", "password": PASSWORD}).status_code == 200
    return client


def _assert_signed(request: httpx.Request) -> None:
    """서명이 보낸 본문 바이트 그대로에 대한 것인지, 시각이 지금인지, Host가 127.0.0.1인지."""
    ts = request.headers["x-chaos-timestamp"]
    assert ts.isdigit() and abs(int(ts) - time.time()) < 30
    expected = hmac.new(CHAOS_SECRET.encode(), ts.encode() + b"." + request.content, hashlib.sha256).hexdigest()
    assert request.headers["x-chaos-signature"] == expected == sign(CHAOS_SECRET, ts, request.content)
    assert request.headers["host"] == "127.0.0.1"


def _chaos_audit(settings) -> list[dict]:
    return [line for line in audit_lines(settings) if line["event"] == "chaos_requested"]


# ---------- 꺼짐 · 로그인 ----------

def test_off_is_404_for_both(staff_client, settings):
    res = staff_client.get("/api/admin/chaos/options")
    assert res.status_code == 404 and res.json() == {"detail": OFF}
    res = staff_client.post("/api/admin/chaos/runs", json=REQUEST)
    assert res.status_code == 404 and res.json() == {"detail": OFF}
    assert _chaos_audit(settings)[-1] == {"at": "2026-10-08T12:00:00+09:00", "via": "session", "who": "admin",
                                          "event": "chaos_requested", "tool": None, "path": "/api/admin/chaos/runs",
                                          "status": 404, "target": "404"}


def test_requires_login(chaos_app, service, chaos_settings):
    client = TestClient(chaos_app)
    assert client.get("/api/admin/chaos/options").status_code == 401
    res = client.post("/api/admin/chaos/runs", json=REQUEST)
    assert res.status_code == 401 and res.json() == {"detail": "로그인이 필요합니다."}
    assert service.requests == [] and _chaos_audit(chaos_settings) == []


# ---------- options ----------

def test_options_pass_through_signed(admin, service, chaos_settings, token):
    res = admin.get("/api/admin/chaos/options")
    assert res.status_code == 200 and res.json() == OPTIONS
    req = service.requests[-1]
    assert req.method == "GET" and str(req.url) == "http://tunnel:8000/api/internal/chaos-runs/options"
    assert req.content == b""
    _assert_signed(req)
    # 조회라서 토큰으로도 부를 수 있다 (다른 GET과 같다)
    admin.cookies.clear()
    assert admin.get("/api/admin/chaos/options", headers={"Authorization": f"Bearer {token}"}).json() == OPTIONS


@pytest.mark.parametrize("reply", [
    lambda r: httpx.Response(401, json={"detail": "서명이 맞지 않습니다."}),
    lambda r: httpx.Response(404, json={"detail": "Not found"}),
    lambda r: httpx.Response(500, text="boom"),
    lambda r: httpx.Response(200, text="<html>"),
    lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")),
    lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
])
def test_options_unreachable_is_503(admin, service, reply):
    service.reply = reply
    res = admin.get("/api/admin/chaos/options")
    assert res.status_code == 503 and res.json() == {"detail": UNREACHABLE}


# ---------- 신청 ----------

def test_create_signs_exact_bytes_and_sets_requested_by(admin, service, chaos_settings):
    body = {**REQUEST, "requestedBy": "mallory", "extra": 1,
            "chaos": {**REQUEST["chaos"], "requestedBy": "mallory", "workers": ["news_agent"]}}
    res = admin.post("/api/admin/chaos/runs", json=body)
    assert res.status_code == 201 and res.json() == _run()
    req = service.requests[-1]
    assert req.method == "POST" and str(req.url) == "http://tunnel:8000/api/internal/chaos-runs"
    assert req.headers["content-type"] == "application/json"
    _assert_signed(req)
    sent = json.loads(req.content)
    # 클라이언트가 넣은 requestedBy(바깥·chaos 안 모두)는 버리고 로그인한 staff 아이디로 덮어쓴다. 모르는 키는 보내지 않는다
    assert sent == {"symbol": "005930", "chaos": {"enabled": True, "probability": 0.8, "scope": "primary", "seed": 7,
                                                  "workers": ["news_agent"]}, "requestedBy": "admin"}
    assert _chaos_audit(chaos_settings)[-1] == {"at": "2026-10-08T12:00:00+09:00", "via": "session", "who": "admin",
                                                "event": "chaos_requested", "tool": None,
                                                "path": "/api/admin/chaos/runs", "status": 201, "target": "77"}


def test_create_with_token_is_403_even_with_cookie(admin, service, chaos_settings, token):
    res = admin.post("/api/admin/chaos/runs", json=REQUEST, headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 403 and res.json() == {"detail": CHAOS_BY_TOKEN}
    admin.cookies.clear()
    assert admin.post("/api/admin/chaos/runs", json=REQUEST, headers={"Authorization": f"Bearer {token}"}).status_code == 403
    assert admin.post("/api/admin/chaos/runs", json=REQUEST, headers={"Authorization": "Bearer wrong"}).status_code == 403
    assert service.requests == [] and _chaos_audit(chaos_settings) == []
    last = audit_lines(chaos_settings)[-1]   # 토큰 요청은 미들웨어가 남긴다 (틀린 토큰이면 who null)
    assert (last["via"], last["event"], last["who"], last["status"]) == ("token", "request", None, 403)
    assert audit_lines(chaos_settings)[-2]["who"] == "alice"


def test_mcp_tools_stay_read_only():
    """MCP 도구는 9개 그대로이고 장애 주입 경로를 부르는 도구가 없다 (토큰으로는 어차피 403)."""
    assert len(mcp_tools.TOOLS) == 9
    assert not [t for t in mcp_tools.TOOLS if "chaos" in t.path]


def test_create_rechecks_staff_in_db(admin, rows, chaos_app, service, monkeypatch):
    from paper_admin.db import DBUnavailable

    rows.sql("UPDATE auth_user SET is_staff = 0 WHERE username = 'admin'")
    assert admin.post("/api/admin/chaos/runs", json=REQUEST).status_code == 401
    rows.sql("UPDATE auth_user SET is_staff = 1 WHERE username = 'admin'")

    def down(*args, **kwargs):
        raise DBUnavailable("OperationalError")

    monkeypatch.setattr(chaos_app.state.db, "query", down)
    res = admin.post("/api/admin/chaos/runs", json=REQUEST)
    assert res.status_code == 503 and res.json() == {"detail": "서비스 DB에 연결할 수 없습니다"}
    assert service.requests == []


@pytest.mark.parametrize("raw", [b"[]", b'"x"', b"{broken", b""])
def test_create_bad_body_is_400(admin, service, chaos_settings, raw):
    res = admin.post("/api/admin/chaos/runs", content=raw, headers={"Content-Type": "application/json"})
    assert res.status_code == 400 and isinstance(res.json()["detail"], str)
    assert service.requests == [] and _chaos_audit(chaos_settings)[-1]["target"] == "400"


@pytest.mark.parametrize("status,body,expected", [
    (400, {"detail": "없는 종목입니다: 999999"}, {"detail": "없는 종목입니다: 999999"}),
    (403, {"detail": "관리자만 장애 주입을 신청할 수 있어요."}, {"detail": "관리자만 장애 주입을 신청할 수 있어요."}),
    (409, {"detail": "진행 중인 장애 주입 실행이 있어요. 끝난 뒤에 다시 신청해 주세요.", "id": 76, "x": 1},
     {"detail": "진행 중인 장애 주입 실행이 있어요. 끝난 뒤에 다시 신청해 주세요.", "id": 76}),
    (429, {"detail": "오늘 팀 AI 예산을 다 썼어요."}, {"detail": "오늘 팀 AI 예산을 다 썼어요."}),
    (400, None, {"detail": "서비스가 요청을 거절했습니다 (HTTP 400)"}),
])
def test_create_passes_service_errors_through(admin, service, chaos_settings, status, body, expected):
    service.reply = lambda r: httpx.Response(status, json=body) if body is not None else httpx.Response(status, text="x")
    res = admin.post("/api/admin/chaos/runs", json=REQUEST)
    assert res.status_code == status and res.json() == expected
    assert _chaos_audit(chaos_settings)[-1]["target"] == str(status) and _chaos_audit(chaos_settings)[-1]["status"] == status


@pytest.mark.parametrize("reply", [
    lambda r: httpx.Response(401, json={"detail": "서명이 맞지 않습니다."}),
    lambda r: httpx.Response(404, json={"detail": "Not found"}),
    lambda r: httpx.Response(500, json={"detail": "server error"}),
    lambda r: httpx.Response(502, text="Bad Gateway"),
    lambda r: httpx.Response(201, text="not json"),
    lambda r: (_ for _ in ()).throw(httpx.ConnectError("refused")),
    lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("slow")),
])
def test_create_unreachable_is_503(admin, service, chaos_settings, reply):
    service.reply = reply
    res = admin.post("/api/admin/chaos/runs", json=REQUEST)
    assert res.status_code == 503 and res.json() == {"detail": UNREACHABLE}
    assert _chaos_audit(chaos_settings)[-1] == {"at": "2026-10-08T12:00:00+09:00", "via": "session", "who": "admin",
                                                "event": "chaos_requested", "tool": None,
                                                "path": "/api/admin/chaos/runs", "status": 503, "target": "503"}


def test_client_timeout_is_10_seconds(monkeypatch):
    seen = {}

    class Spy(httpx.Client):
        def __init__(self, **kw):
            seen["timeout"] = kw["timeout"]
            super().__init__(**kw)

    monkeypatch.setattr(httpx, "Client", Spy)
    ChaosClient("http://svc", "s", transport=httpx.MockTransport(lambda r: httpx.Response(200, json={}))).options()
    assert seen["timeout"] == 10.0


# ---------- 리포트 상세의 저장된 설정 ----------

def test_trace_has_chaos_config(staff_client, rows):
    config = {"enabled": True, "probability": 0.8, "errorTypes": ["timeout"], "workers": None, "scope": "primary",
              "seed": 12345, "requestedBy": "admin"}
    rid = rows.report(source="chaos", chaos=config, status="running")
    plain = rows.report()
    off = rows.report(chaos={"enabled": False})
    data = staff_client.get(f"/api/admin/reports/{rid}/trace").json()
    assert data["report"]["chaosConfig"] == config and data["report"]["source"] == "chaos"
    assert data["report"]["chaos"] is True
    assert staff_client.get(f"/api/admin/reports/{plain}/trace").json()["report"]["chaosConfig"] is None
    assert staff_client.get(f"/api/admin/reports/{off}/trace").json()["report"]["chaosConfig"] is None
    listed = staff_client.get("/api/admin/reports?kind=chaos").json()["results"]
    assert [(r["id"], r["source"], r["chaosConfig"]) for r in listed] == [(rid, "chaos", None)]
