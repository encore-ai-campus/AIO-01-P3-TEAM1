"""각 엔드포인트의 형식과 레벨 기준값 (API.md 2장)."""
import json

import httpx
import pytest
from conftest import NOW, ago
from fastapi.testclient import TestClient

from paper_admin.api import create_app
from paper_admin.config import Settings
from paper_admin.health import HealthMonitor

PATHS = ["/api/admin/overview", "/api/admin/service", "/api/admin/engine", "/api/admin/deploys",
         "/api/admin/reports", "/api/admin/reports/1/trace", "/api/admin/recovery", "/api/admin/costs",
         "/api/admin/alerts", "/api/admin/me"]


@pytest.mark.parametrize("path", PATHS)
def test_requires_login(client, path):
    res = client.get(path)
    assert res.status_code == 401 and isinstance(res.json()["detail"], str)


def test_health_and_no_docs(client):
    assert client.get("/api/admin/health").json() == {"ok": True}
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404


@pytest.mark.parametrize("query", ["/api/admin/reports?days=0", "/api/admin/reports?days=91", "/api/admin/reports?kind=x",
                                   "/api/admin/reports?team=foo", "/api/admin/reports?limit=501", "/api/admin/recovery?days=abc",
                                   "/api/admin/costs?days=91", "/api/admin/alerts?hours=169", "/api/admin/deploys?limit=0",
                                   "/api/admin/reports/abc/trace"])
def test_bad_query_is_400(staff_client, query):
    res = staff_client.get(query)
    assert res.status_code == 400 and isinstance(res.json()["detail"], str)


def test_db_unavailable_is_503(tmp_path, clock):
    settings = Settings(database_url=f"sqlite:///{tmp_path / 'missing.sqlite3'}", secret_key="x" * 40, data_dir=tmp_path)
    client = TestClient(create_app(settings, monitor=HealthMonitor("", 30), clock=clock))
    res = client.get("/api/admin/me", headers={"Authorization": "Bearer nope"})
    assert res.status_code == 401
    res = client.post("/api/admin/login", json={"username": "a", "password": "b"})
    assert res.status_code == 503 and res.json() == {"detail": "서비스 DB에 연결할 수 없습니다"}


# ---------- F4 엔진 ----------

@pytest.mark.parametrize("age,level,stale", [(119, "ok", False), (120, "ok", False), (121, "down", True)])
def test_engine_stale_boundary(staff_client, rows, age, level, stale):
    rows.engine(beat_at=ago(seconds=age))
    data = staff_client.get("/api/admin/engine").json()
    assert (data["level"], data["stale"], data["ageSec"], data["staleAfterSec"]) == (level, stale, age, 120)
    assert data["found"] is True and data["version"] == "500d087abc" and data["limits"]["reportsPerUser"] == 3


def test_engine_missing_is_down(staff_client):
    data = staff_client.get("/api/admin/engine").json()
    assert data["level"] == "down" and data["found"] is False and data["errors"] == [] and data["limits"] == {}


def test_engine_warn_halted_and_recent_errors(staff_client, rows):
    long_error = "ValueError: " + "x" * 400 + " https://discord.com/api/webhooks/123/secret?x=1"
    rows.engine(halted=True, step_errors=[{"at": ago(minutes=40).isoformat(), "step": "dispatch", "error": "old"}])
    data = staff_client.get("/api/admin/engine").json()
    assert data["level"] == "warn" and data["halted"] is True
    rows.sql("DELETE FROM engine_status")
    rows.engine(step_errors=[{"at": ago(minutes=40).isoformat(), "step": "a", "error": "old"},
                             {"at": ago(minutes=29).isoformat(), "step": "b", "error": long_error}])
    data = staff_client.get("/api/admin/engine").json()
    assert data["level"] == "warn"
    assert [e["step"] for e in data["errors"]] == ["b", "a"]
    assert len(data["errors"][0]["error"]) == 300
    rows.sql("DELETE FROM engine_status")
    rows.engine(step_errors=[{"at": ago(minutes=31).isoformat(), "step": "a", "error": "boom https://h.example/p?q=s"}])
    data = staff_client.get("/api/admin/engine").json()
    assert data["level"] == "ok" and data["errors"][0]["error"] == "boom https://h.example/…"


# ---------- F5 배포 ----------

def _deploy(settings, **rec):
    settings.data_dir.mkdir(parents=True, exist_ok=True)
    base = {"server": "app", "tag": "aaa111", "previous": None, "result": "success", "actor": "dev", "commit": "c",
            "runUrl": None}
    with settings.deploys_path.open("a") as f:
        f.write(json.dumps({**base, **rec}) + "\n")


def test_deploys_current_rules(staff_client, settings):
    _deploy(settings, at="2026-10-08T01:00:00+00:00", tag="v1")
    _deploy(settings, at="2026-10-08T02:00:00+00:00", tag="v2", previous="v1", result="rolled_back")
    _deploy(settings, at="2026-10-08T03:00:00+00:00", tag="v3", previous="v1", result="failed")
    _deploy(settings, at="2026-10-08T01:30:00+00:00", server="admin", tag="a1")
    _deploy(settings, at="2026-10-08T02:30:00+00:00", server="admin", tag="a2", previous="a1", result="rollback_failed")
    _deploy(settings, at="2026-10-08T03:30:00+00:00", server="admin", tag="a3", result="blocked")
    with settings.deploys_path.open("a") as f:
        f.write("{broken json\n" + json.dumps({"at": "x", "server": "app", "tag": "t", "result": "success"}) + "\n")
    data = staff_client.get("/api/admin/deploys?limit=2").json()
    assert data["total"] == 6 and len(data["records"]) == 2
    assert data["records"][0]["tag"] == "a3" and data["records"][0]["at"] == "2026-10-08T12:30:00+09:00"
    servers = {s["server"]: s for s in data["servers"]}
    assert [s["server"] for s in data["servers"]] == ["admin", "app"]
    assert servers["app"]["current"] == "v1" and servers["app"]["currentAt"] == "2026-10-08T11:00:00+09:00"
    assert servers["app"]["last"]["tag"] == "v3"
    assert servers["admin"]["current"] is None and servers["admin"]["currentAt"] == "2026-10-08T11:30:00+09:00"
    overview = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert overview["deploys"]["level"] == "warn"  # 서버별 최신 기록: blocked(warn), failed(warn)


def test_deploys_level(staff_client, settings):
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["deploys"]["level"] == "unknown"
    _deploy(settings, at="2026-10-08T01:00:00+00:00", tag="v1")
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["deploys"]["level"] == "ok"
    _deploy(settings, at="2026-10-08T02:00:00+00:00", tag="v2", previous="v1", result="rollback_failed")
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["deploys"]["level"] == "down"


# ---------- F6 리포트 · F7 복구 ----------

def _report_with_recovery(rows, **cols):
    rid = rows.report(**cols)
    rows.event(rid, 1, "news_agent", "agent_started", ago(minutes=59))
    rows.event(rid, 2, "news_agent", "agent_failed", ago(minutes=59) .replace(second=2), status="failed",
               model="gemini", details={"errorType": "timeout", "injected": True, "final": False})
    rows.event(rid, 3, "news_agent", "agent_retry", ago(minutes=59).replace(second=3))
    rows.event(rid, 4, "news_agent", "agent_completed", ago(minutes=59).replace(second=4), status="completed",
               details={"recovered": True})
    return rid


def test_reports_list_and_kinds(staff_client, rows):
    ok = rows.report(created_at=ago(hours=2), started_at=ago(hours=2), finished_at=ago(hours=2) .replace(minute=1))
    failed = rows.report(status="failed", created_at=ago(hours=3), cost_usd=0.25)
    rows.event(failed, 1, "orchestrator", "workflow_failed", ago(hours=3), status="failed",
               details={"reason": "join_blocked"})
    chaos = rows.report(status="completed", chaos={"enabled": True}, created_at=ago(hours=4), team="stock_selection",
                        symbol="KR", name="선정", source="auto")
    recovered = _report_with_recovery(rows)
    rows.report(status="failed", created_at=ago(days=8))  # 기간 밖
    data = staff_client.get("/api/admin/reports").json()
    assert data["days"] == 7 and data["kind"] == "all" and (data["from"], data["to"]) == ("2026-10-02", "2026-10-08")
    assert [r["id"] for r in data["results"]] == [recovered, failed, chaos]
    assert data["count"] == 3
    row = {r["id"]: r for r in data["results"]}
    assert row[failed]["failReason"] == "join_blocked" and row[failed]["costUsd"] == 0.25
    assert row[recovered]["recovered"] == 1 and row[recovered]["injected"] == 1
    assert row[chaos]["chaos"] is True and row[chaos]["source"] == "auto"
    assert set(row[failed]) == {"id", "team", "symbol", "name", "source", "status", "chaos", "failReason", "failures",
                                "recovered", "unrecovered", "injected", "costUsd", "createdAt", "startedAt",
                                "finishedAt", "durationMs"}
    assert ok not in row
    assert [r["id"] for r in staff_client.get("/api/admin/reports?kind=failed").json()["results"]] == [failed]
    assert [r["id"] for r in staff_client.get("/api/admin/reports?kind=recovered").json()["results"]] == [recovered]
    assert [r["id"] for r in staff_client.get("/api/admin/reports?kind=chaos").json()["results"]] == [chaos]
    assert [r["id"] for r in staff_client.get("/api/admin/reports?team=stock_selection").json()["results"]] == [chaos]
    limited = staff_client.get("/api/admin/reports?limit=1").json()
    assert limited["count"] == 3 and len(limited["results"]) == 1
    assert staff_client.get("/api/admin/reports?days=9&kind=failed").json()["count"] == 2


def test_report_trace(staff_client, rows):
    rid = _report_with_recovery(rows, started_at=ago(minutes=59), finished_at=ago(minutes=58))
    rows.event(rid, 5, "orchestrator", "review_retry", ago(minutes=58), details={"note": "y" * 500})
    data = staff_client.get(f"/api/admin/reports/{rid}/trace").json()
    assert data["recovery"] == {"failures": 1, "recovered": 1, "unrecovered": 0, "injected": 1, "recoveryMs": 2000}
    assert [e["kind"] for e in data["events"]] == ["other", "failure", "retry", "recovered", "guard"]
    assert [e["step"] for e in data["events"]] == [1, 2, 3, 4, 5]
    assert len(data["events"][4]["details"]["note"]) == 300
    assert data["report"]["durationMs"] == 60000
    assert staff_client.get("/api/admin/reports/999/trace").status_code == 404


def test_recovery_endpoint(staff_client, rows):
    _report_with_recovery(rows)
    rows.report()
    data = staff_client.get("/api/admin/recovery?days=7").json()
    assert (data["from"], data["to"], data["days"]) == ("2026-10-02", "2026-10-08", 7)   # 서비스 stats처럼 KST 날짜
    assert (data["reports"], data["reportsWithFailures"], data["failures"], data["recovered"]) == (2, 1, 1, 1)
    assert data["autoRecoveryRate"] == 100.0 and data["meanRecoveryMs"] == 2000
    assert data["byErrorType"] == [{"errorType": "timeout", "failures": 1, "recovered": 1}]
    assert data["recent"][0]["symbol"] == "005930" and data["recent"][0]["injected"] is True


def test_reports_and_recovery_levels(staff_client, rows):
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["reports"]["level"] == "ok" and items["recovery"] == {
        "key": "recovery", "title": "복구 지표", "level": "unknown", "summary": "장애 없음"}
    rows.report(status="failed", chaos={"enabled": True})
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["reports"]["level"] == "ok"
    rid = rows.report(status="failed")
    rows.event(rid, 1, "market_agent", "agent_failed", ago(minutes=30), status="failed", details={"final": False})
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    # 끝나지 않은 run의 장애는 진행 중 (복구도 포기도 아니다 — 서비스 reports.autohealing.stats와 같다)
    assert items["reports"]["level"] == "warn" and items["recovery"]["level"] == "ok"
    assert items["recovery"]["summary"] == "자동 복구율 0.0% · 진행 중 1건"
    rows.event(rid, 2, "market_agent", "agent_failed", ago(minutes=29), status="failed", details={"final": True})
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["recovery"]["level"] == "warn" and items["recovery"]["summary"] == "복구 못한 장애 1건 · 자동 복구율 0.0%"


# ---------- F8 비용 ----------

def test_costs(staff_client, rows):
    rows.engine()
    uid = rows.staff(username="u1", staff=False)
    uid2 = rows.staff(username="u2", staff=False)
    rows.report(user_id=uid, cost_usd=1.5, created_at=ago(hours=1))
    rows.report(user_id=uid, cost_usd=0.5, created_at=ago(hours=2), status="failed")             # 한도에 세지 않음
    rows.report(user_id=uid, created_at=ago(hours=3), status="failed", chaos={"enabled": True})  # 셈
    rows.report(user_id=uid2, created_at=ago(hours=3))
    rows.report(source="auto", cost_usd=1.0, created_at=ago(hours=4))                           # 비용엔 넣고 한도엔 안 셈
    rows.report(user_id=uid, cost_usd=2.0, created_at=ago(days=1))                              # 어제
    rows.add("analysis_runs", symbol="005930", analyzed_at=ago(hours=1), cost_usd=0.3)
    rows.add("analysis_runs", symbol="000660", analyzed_at=ago(days=13), cost_usd=0.3)
    rows.add("analysis_runs", symbol="000660", analyzed_at=ago(days=14), cost_usd=9.0)          # 기간 밖
    rows.add("daily_move_notes", symbol="005930", created_at=ago(hours=1), cost_usd=0.2)
    rows.add("jobs", user_id=uid, status="DONE", created_at=ago(hours=1), started_at=ago(hours=1))
    rows.add("jobs", user_id=uid, status="FAILED", created_at=ago(hours=1), started_at=ago(hours=1))
    rows.add("jobs", user_id=uid, status="FAILED", created_at=ago(hours=1))                       # 세지 않음
    rows.add("jobs", user_id=uid, status="DONE", created_at=ago(hours=13))                        # 어제(KST)
    data = staff_client.get("/api/admin/costs").json()
    assert data["days"] == 14 and len(data["daily"]) == 14
    assert data["daily"][0]["date"] == "2026-09-25" and data["daily"][-1]["date"] == "2026-10-08"
    assert data["from"] == "2026-09-25T00:00:00+09:00"
    today = data["daily"][-1]
    assert today == {"date": "2026-10-08", "reportsUsd": 3.0, "analysisUsd": 0.3, "longtermUsd": 0.2, "totalUsd": 3.5,
                     "reports": 5, "analyses": 1}
    assert data["daily"][-2]["reportsUsd"] == 2.0 and data["daily"][0]["analysisUsd"] == 0.3
    assert data["totals"] == {"reportsUsd": 5.0, "analysisUsd": 0.6, "longtermUsd": 0.2, "totalUsd": 5.8}
    # 예산 사용액 = 서비스 budget.used_usd 셈: 오늘 분석 요청 2건 × 0.3 + 오늘 리포트 실제 비용 3.0
    assert data["today"] == {"date": "2026-10-08", "totalUsd": 3.5, "budgetUsd": 10.0, "budgetUsedUsd": 3.6, "budgetPct": 36.0,
                             "analyses": {"used": 2, "limit": 33}, "reportsPerUser": {"maxUsed": 2, "limit": 3, "unlimited": False}}


def test_costs_report_limit_unlimited_or_unknown(staff_client, rows):
    """엔진이 리포트 한도를 null로 알려 주면 무제한, 키가 없으면 모름 (서비스 기본값은 무제한 — 2026-10-08)."""
    rows.engine(limits={"aiDailyBudgetUsd": 10, "reportsPerUser": None})
    assert staff_client.get("/api/admin/costs").json()["today"]["reportsPerUser"] == {"maxUsed": 0, "limit": None, "unlimited": True}


def test_costs_report_limit_unknown_without_key(staff_client, rows):
    rows.engine(limits={"aiDailyBudgetUsd": 10})
    assert staff_client.get("/api/admin/costs").json()["today"]["reportsPerUser"] == {"maxUsed": 0, "limit": None, "unlimited": False}


@pytest.mark.parametrize("spent,level", [(7.99, "ok"), (8.0, "warn"), (9.99, "warn"), (10.0, "down")])
def test_costs_budget_levels(staff_client, rows, spent, level):
    rows.engine()
    rows.report(cost_usd=spent)
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["costs"]["level"] == level


def test_costs_unknown_budget(staff_client):
    data = staff_client.get("/api/admin/costs?days=1").json()
    assert data["today"]["budgetUsd"] is None and data["today"]["budgetPct"] is None
    assert data["today"]["analyses"]["limit"] is None
    items = {i["key"]: i for i in staff_client.get("/api/admin/overview").json()["items"]}
    assert items["costs"]["level"] == "unknown"


# ---------- F9 알림·작업 ----------

def test_alerts(staff_client, rows):
    secret_error = "HTTPError: 404 https://discord.com/api/webhooks/1/TOKEN?wait=true " + "z" * 400
    rows.add("notification_outbox", kind="report", status="failed", attempts=3, last_error=secret_error,
             created_at=ago(hours=2), content="본문 비밀")
    rows.add("notification_outbox", kind="report", status="failed", created_at=ago(hours=25))     # 기간 밖
    rows.add("notification_outbox", kind="trade", status="pending", created_at=ago(minutes=11))
    rows.add("notification_outbox", kind="trade", status="pending", created_at=ago(minutes=9))
    rows.add("notification_outbox", kind="trade", status="sending", created_at=ago(minutes=30), claimed_at=ago(minutes=11))
    rows.add("notification_outbox", kind="trade", status="sending", created_at=ago(minutes=30), claimed_at=ago(minutes=9))
    rows.add("notification_outbox", kind="trade", status="sent", created_at=ago(minutes=30))
    rows.add("jobs", user_id=1, payload={"symbol": "005930"}, status="RUNNING", created_at=ago(minutes=40),
             started_at=ago(minutes=16))
    rows.add("jobs", user_id=1, status="RUNNING", created_at=ago(minutes=40), started_at=ago(minutes=14))
    rows.add("jobs", user_id=1, payload={"symbol": "000660"}, status="QUEUED", created_at=ago(minutes=11))
    rows.add("jobs", user_id=1, status="QUEUED", created_at=ago(minutes=9))
    rows.report(status="running", created_at=ago(minutes=50), started_at=ago(minutes=21))
    rows.report(status="running", created_at=ago(minutes=50), started_at=ago(minutes=19))
    rows.report(status="requested", team="stock_selection", symbol="KR", name="선정", created_at=ago(minutes=31))
    rows.report(status="requested", created_at=ago(minutes=29))
    data = staff_client.get("/api/admin/alerts").json()
    assert data["level"] == "warn" and data["hours"] == 24
    d = data["discord"]
    assert (d["failed"], d["pendingOld"], d["sendingStuck"]) == (1, 1, 1)
    assert [r["status"] for r in d["rows"]] == ["pending", "sending", "failed"]
    err = d["rows"][2]["lastError"]
    assert len(err) <= 300 and "TOKEN" not in err and "webhooks" not in err and "https://discord.com/…" in err
    assert "본문" not in json.dumps(data, ensure_ascii=False)
    assert [s["label"] for s in data["stuck"]] == ["선정 KR", "리포트 삼성전자(005930)", "분석 005930", "분석 000660"]
    assert data["stuck"][0]["ageSec"] == 31 * 60 and data["stuck"][0]["since"] == ago(minutes=31).isoformat()


def test_alerts_ok(staff_client):
    data = staff_client.get("/api/admin/alerts?hours=1").json()
    assert data["level"] == "ok" and data["stuck"] == [] and data["discord"]["rows"] == []


# ---------- F3 서비스 · F2 개요 ----------

def _service_client(settings, clock, handler):
    monitor = HealthMonitor("http://svc", 30, clock=clock, transport=httpx.MockTransport(handler))
    return monitor, TestClient(create_app(settings, monitor=monitor, clock=clock))


def test_service_status(settings, clock, rows):
    from datetime import timedelta
    state = {"api": 200, "page": 200}

    def handler(req):
        return httpx.Response(state["api"] if req.url.path == "/api/health" else state["page"])

    monitor, client = _service_client(settings, clock, handler)
    rows.staff()
    client.post("/api/admin/login", json={"username": "admin", "password": "admin-pass-1"})
    data = client.get("/api/admin/service").json()
    assert data["level"] == "unknown" and data["latest"] is None and data["url"] == "http://svc"
    import asyncio
    clock.now = NOW - timedelta(minutes=20)
    asyncio.run(monitor.check_once())
    state["api"] = 502
    clock.now = NOW - timedelta(minutes=2)
    asyncio.run(monitor.check_once())
    clock.now = NOW
    asyncio.run(monitor.check_once())
    data = client.get("/api/admin/service").json()
    assert data["level"] == "down" and data["latest"]["api"] == {"ok": False, "status": 502, "ms": data["latest"]["api"]["ms"],
                                                                  "error": "HTTP 502"}
    assert data["downSince"] == (NOW - timedelta(minutes=2)).isoformat()
    assert data["uptimePct24h"] == 33.3 and len(data["recent"]) == 3 and data["recent"][0]["at"] == NOW.isoformat()
    items = {i["key"]: i for i in client.get("/api/admin/overview").json()["items"]}
    assert items["service"]["summary"] == "API 응답 없음 (2분째)"
    state["api"] = 200
    asyncio.run(monitor.check_once())
    assert client.get("/api/admin/service").json()["level"] == "warn"  # 최근 10분 안에 실패
    clock.now = NOW + timedelta(minutes=11)
    asyncio.run(monitor.check_once())
    assert client.get("/api/admin/service").json()["level"] == "ok"


def test_service_probe_errors(settings, clock):
    import asyncio

    def handler(req):
        if req.url.path == "/":
            raise httpx.ConnectError("refused")
        raise httpx.ReadTimeout("slow")

    monitor, _ = _service_client(settings, clock, handler)
    check = asyncio.run(monitor.check_once())
    assert check.api.error == "timeout" and check.page.error == "connection" and check.api.status is None


def test_overview_order(staff_client, rows):
    rows.engine(beat_at=ago(minutes=5))
    data = staff_client.get("/api/admin/overview").json()
    assert data["at"] == NOW.isoformat() and data["level"] == "down"
    keys = [i["key"] for i in data["items"]]
    levels = [i["level"] for i in data["items"]]
    assert keys[0] == "engine" and levels == sorted(levels, key=["down", "warn", "unknown", "ok"].index)
    assert set(keys) == {"service", "engine", "deploys", "reports", "recovery", "costs", "alerts"}
    unknown = [i["key"] for i in data["items"] if i["level"] == "unknown"]
    assert unknown == [k for k in ["service", "engine", "deploys", "reports", "recovery", "costs", "alerts"] if k in unknown]
    engine = data["items"][0]
    assert engine["title"] == "엔진 상태" and engine["summary"].startswith("멈춤")
