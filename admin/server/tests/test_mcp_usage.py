"""F10 MCP 도구·호출 기록 (API.md 6장): 도구 목록, 토큰 목록(해시 없이), 감사 기록의 토큰 요청."""
import json

from conftest import ago

from paper_admin import mcp_tools, mcp_usage
from paper_admin.util import iso


def write_audit(settings, lines):
    settings.audit_path.parent.mkdir(parents=True, exist_ok=True)
    with settings.audit_path.open("a", encoding="utf-8") as f:
        for line in lines:
            f.write((line if isinstance(line, str) else json.dumps(line, ensure_ascii=False)) + "\n")


def req(at, who, tool, path, status):
    return {"at": iso(at), "via": "token", "who": who, "event": "request", "tool": tool, "path": path, "status": status}


def test_lists_tools_tokens_and_calls(staff_client, settings, token):
    write_audit(settings, [
        req(ago(hours=30), "alice", "overview", "/api/admin/overview", 200),            # 기간 밖: lastUsedAt만
        req(ago(hours=2), "alice", None, "/api/admin/me", 200),                         # 토큰 확인 (도구 밖)
        req(ago(hours=2), "alice", "report_trace", "/api/admin/reports/7/trace", 200),
        req(ago(hours=1), "alice", "report_trace", "/api/admin/reports/999/trace", 404),
        req(ago(minutes=30), "alice", "ai_costs", "/api/admin/costs?days=14", 200),
        req(ago(minutes=10), None, None, "/api/admin/me", 401),                         # 틀린 토큰
        {"at": iso(ago(minutes=5)), "via": "session", "who": "admin", "event": "login", "tool": None,
         "path": "/api/admin/login", "status": 200},                                    # 세션 로그인은 빼고
        "깨진 줄",
    ])
    res = staff_client.get("/api/admin/mcp?hours=24")
    assert res.status_code == 200, res.text
    d = res.json()
    assert d["endpoint"] == "/mcp" and d["hours"] == 24
    assert [t["name"] for t in d["tools"]] == [t.name for t in mcp_tools.TOOLS] and len(d["tools"]) == 9
    assert d["tools"][5] == {"name": "report_trace", "description": mcp_tools.BY_NAME["report_trace"].description,
                             "path": "/api/admin/reports/{report_id}/trace", "params": ["report_id"]}
    assert d["tokens"] == [{"name": "alice", "createdAt": d["tokens"][0]["createdAt"],
                            "lastUsedAt": iso(ago(minutes=30)), "calls": 3, "errors": 1}]
    assert "sha256" not in json.dumps(d) and token not in json.dumps(d)
    assert d["summary"] == {"calls": 3, "errors": 1, "invalid": 1,
                            "byTool": [{"tool": "report_trace", "calls": 2, "errors": 1},
                                       {"tool": "ai_costs", "calls": 1, "errors": 0}]}
    assert [(c["who"], c["tool"], c["status"], c["ok"]) for c in d["calls"]] == [
        (None, None, 401, False), ("alice", "ai_costs", 200, True), ("alice", "report_trace", 404, False),
        ("alice", "report_trace", 200, True), ("alice", None, 200, True)]
    assert d["calls"][0]["at"] == iso(ago(minutes=10))


def test_limit_and_hours_bounds(staff_client, settings):
    write_audit(settings, [req(ago(minutes=i), "alice", "overview", "/api/admin/overview", 200) for i in range(5)])
    assert len(staff_client.get("/api/admin/mcp?limit=2").json()["calls"]) == 2
    for bad in ("hours=0", "hours=169", "limit=0", "limit=501"):
        assert staff_client.get(f"/api/admin/mcp?{bad}").status_code == 400


def test_no_audit_file_no_tokens(staff_client):
    d = staff_client.get("/api/admin/mcp").json()
    assert d["tokens"] == [] and d["calls"] == [] and d["summary"]["calls"] == 0 and len(d["tools"]) == 9


def test_requires_login(client):
    assert client.get("/api/admin/mcp").status_code == 401


def test_token_request_to_this_page_is_itself_audited(client, settings, token):
    res = client.get("/api/admin/mcp", headers={"Authorization": f"Bearer {token}"})
    assert res.status_code == 200
    again = client.get("/api/admin/mcp", headers={"Authorization": f"Bearer {token}"}).json()
    assert again["calls"][0]["path"] == "/api/admin/mcp" and again["calls"][0]["who"] == "alice"
    assert again["calls"][0]["tool"] is None and again["summary"]["calls"] == 0


def test_reads_only_file_tail(tmp_path):
    path = tmp_path / "audit.jsonl"
    old = json.dumps(req(ago(hours=3), "old", "overview", "/api/admin/overview", 200))
    new = json.dumps(req(ago(hours=1), "new", "overview", "/api/admin/overview", 200))
    path.write_text(old + "\n" + new + "\n", encoding="utf-8")
    found = mcp_usage.read_token_requests(path, tail_bytes=len(new) + 10)
    assert [r["who"] for r in found] == ["new"]
    assert mcp_usage.read_token_requests(tmp_path / "missing.jsonl") == []
