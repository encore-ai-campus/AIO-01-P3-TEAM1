"""로그인·세션·토큰·감사 기록 (API.md 1장)."""
import json
import os
import stat

from conftest import DJANGO_HASH, PASSWORD, audit_lines

from paper_admin import tokens as token_cli
from paper_admin.auth import COOKIE_NAME, LOGIN_FAILED, Sessions, Staff, TokenStore, verify_django_password


def login(client, username="admin", password=PASSWORD, **kw):
    return client.post("/api/admin/login", json={"username": username, "password": password}, **kw)


def test_django_hash_vector():
    assert verify_django_password(PASSWORD, DJANGO_HASH)
    assert not verify_django_password("admin-pass-2", DJANGO_HASH)
    assert not verify_django_password(PASSWORD, "argon2$argon2id$v=19$m=102400,t=2,p=8$abc$def")
    assert not verify_django_password(PASSWORD, "pbkdf2_sha256$x$salt$hash")
    assert not verify_django_password(PASSWORD, "!unusable")
    assert not verify_django_password(PASSWORD, None)


def test_login_success_sets_cookie(client, rows, settings):
    rows.staff()
    res = login(client)
    assert res.status_code == 200
    assert res.json() == {"username": "admin", "via": "session"}
    cookie = res.headers["set-cookie"]
    assert COOKIE_NAME in cookie and "HttpOnly" in cookie and "SameSite=strict" in cookie and "Max-Age=43200" in cookie
    assert client.get("/api/admin/me").json() == {"username": "admin", "via": "session"}
    lines = audit_lines(settings)
    assert lines[-1]["event"] == "login" and lines[-1]["via"] == "session" and lines[-1]["who"] == "admin"
    assert PASSWORD not in settings.audit_path.read_text() and DJANGO_HASH not in settings.audit_path.read_text()


def test_login_failures(client, rows, settings):
    rows.staff()
    rows.staff(username="member", staff=False)
    rows.staff(username="sleepy", active=False)
    for username, password in (("admin", "wrong"), ("member", PASSWORD), ("sleepy", PASSWORD), ("nobody", PASSWORD)):
        res = login(client, username, password)
        assert res.status_code == 401
        assert res.json() == {"detail": LOGIN_FAILED}
    assert [x["event"] for x in audit_lines(settings)] == ["login_failed"] * 4
    assert login(client, "", "x").status_code == 400
    assert client.post("/api/admin/login", content=b"not json").status_code == 400
    assert client.get("/api/admin/me").status_code == 401


def test_rate_limit_by_username(client, rows):
    rows.staff()
    for _ in range(5):
        assert login(client, password="wrong", headers={"X-Forwarded-For": "10.0.0.1"}).status_code == 401
    # 다른 IP에서도 같은 아이디는 막힌다. 맞는 비밀번호여도 429
    res = login(client, headers={"X-Forwarded-For": "10.0.0.2"})
    assert res.status_code == 429 and "detail" in res.json()


def test_rate_limit_not_by_ip(client, rows):
    """관리자는 모두 SSH 터널로 들어와 IP가 같다: 다른 아이디의 실패로 막히지 않는다."""
    rows.staff()
    for i in range(6):
        assert login(client, f"user{i}", "wrong", headers={"X-Forwarded-For": "10.0.0.9"}).status_code == 401
    assert login(client, headers={"X-Forwarded-For": "10.0.0.9"}).status_code == 200


def test_rate_limit_counts_before_verify_and_success_clears():
    """시도를 검증 전에 센다 (동시 요청으로 한도를 넘지 못한다). 5번째 시도가 성공하면 풀린다."""
    from paper_admin.auth import LoginLimiter

    t = [0.0]
    limiter = LoginLimiter(clock=lambda: t[0])
    assert all(limiter.try_attempt("admin") for _ in range(5))   # 동시에 온 5개는 받는다 (아직 결과 전)
    assert limiter.try_attempt("admin") is False                  # 6번째부터 막힘
    assert limiter.try_attempt("other") is True
    limiter.success("admin")
    assert limiter.try_attempt("admin") is True
    t[0] = 10_000
    assert limiter.try_attempt("other") is True


def test_fifth_try_success_unblocks(client, rows):
    rows.staff()
    for _ in range(4):
        assert login(client, password="wrong").status_code == 401
    assert login(client).status_code == 200
    assert login(client, password="wrong").status_code == 401


def test_unknown_user_still_verifies_dummy_hash(client, rows, monkeypatch):
    """없는 아이디도 가짜 해시로 같은 시간 검증한다 (응답 시간으로 staff 아이디를 알 수 없게)."""
    from paper_admin import api
    from paper_admin.auth import DUMMY_HASH

    seen = []
    monkeypatch.setattr(api, "verify_django_password", lambda pw, encoded: seen.append(encoded) or False)
    rows.staff(username="member", staff=False)
    assert login(client, "nobody").status_code == 401
    assert login(client, "member").status_code == 401
    assert seen == [DUMMY_HASH, DUMMY_HASH]
    assert not verify_django_password(PASSWORD, DUMMY_HASH)


def test_forged_cookie_rejected(client, rows):
    rows.staff()
    login(client)
    value = client.cookies.get(COOKIE_NAME)
    body, sig = value.split(".")
    client.cookies.set(COOKIE_NAME, body + "." + sig[:-2] + ("AA" if sig[-2:] != "AA" else "BB"))
    assert client.get("/api/admin/me").status_code == 401
    other = Sessions("another-secret-key-0123456789-abcdefgh").make(Staff(1, "admin", DJANGO_HASH, True), _now())
    client.cookies.set(COOKIE_NAME, other)
    assert client.get("/api/admin/me").status_code == 401


def _now():
    from conftest import NOW
    return NOW


def test_session_invalid_after_password_change_or_unstaff(client, rows):
    uid = rows.staff()
    login(client)
    assert client.get("/api/admin/engine").status_code == 200
    rows.sql("UPDATE auth_user SET password = ? WHERE id = ?", ("pbkdf2_sha256$1000$othersalt$xxxx", uid))
    assert client.get("/api/admin/engine").status_code == 401
    rows.sql("UPDATE auth_user SET password = ? WHERE id = ?", (DJANGO_HASH, uid))
    assert client.get("/api/admin/engine").status_code == 200
    rows.sql("UPDATE auth_user SET is_staff = 0 WHERE id = ?", (uid,))
    assert client.get("/api/admin/engine").status_code == 401
    rows.sql("UPDATE auth_user SET is_staff = 1, is_active = 0 WHERE id = ?", (uid,))
    assert client.get("/api/admin/engine").status_code == 401


def test_session_expires(client, rows, clock):
    from datetime import timedelta
    rows.staff()
    login(client)
    clock.now = clock.now + timedelta(hours=12, seconds=1)
    assert client.get("/api/admin/me").status_code == 401


def test_logout_clears_cookie(staff_client):
    res = staff_client.post("/api/admin/logout")
    assert res.status_code == 204
    assert 'paper_admin_session=""' in res.headers["set-cookie"] or "Max-Age=0" in res.headers["set-cookie"]
    assert staff_client.get("/api/admin/me").status_code == 401


def test_logout_revokes_copied_cookie(staff_client):
    copied = staff_client.cookies.get(COOKIE_NAME)
    staff_client.post("/api/admin/logout")
    staff_client.cookies.set(COOKIE_NAME, copied)
    assert staff_client.get("/api/admin/me").status_code == 401


def test_db_down_keeps_session_for_db_free_pages(staff_client, app, monkeypatch):
    """서비스 DB(터널)가 끊겨도 서명이 맞는 세션은 F3·F5를 볼 수 있다. DB가 필요한 경로는 503."""
    from paper_admin.db import DBUnavailable

    def down(*args, **kwargs):
        raise DBUnavailable("OperationalError")

    monkeypatch.setattr(app.state.db, "query", down)
    assert staff_client.get("/api/admin/me").json() == {"username": "admin", "via": "session"}
    assert staff_client.get("/api/admin/service").status_code == 200
    assert staff_client.get("/api/admin/deploys").status_code == 200
    assert staff_client.get("/api/admin/engine").status_code == 503
    overview = staff_client.get("/api/admin/overview").json()
    assert {i["key"]: i["summary"] for i in overview["items"]}["engine"] == "서비스 DB에 연결할 수 없습니다"
    staff_client.cookies.set(COOKIE_NAME, "garbage.value")
    assert staff_client.get("/api/admin/me").status_code == 401
    assert login(staff_client).status_code == 503


def test_token_auth_and_audit(client, settings, token):
    res = client.get("/api/admin/engine", headers={"Authorization": f"Bearer {token}", "X-Admin-Tool": "engine_status"})
    assert res.status_code == 200
    me = client.get("/api/admin/me", headers={"Authorization": f"Bearer {token}"})
    assert me.json() == {"username": "alice", "via": "token"}
    assert client.get("/api/admin/engine", headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert client.get("/api/admin/engine").status_code == 401
    lines = audit_lines(settings)
    assert len(lines) == 3
    assert lines[0] == {"at": lines[0]["at"], "via": "token", "who": "alice", "event": "request",
                        "tool": "engine_status", "path": "/api/admin/engine", "status": 200}
    assert lines[1]["tool"] is None and lines[1]["path"] == "/api/admin/me"
    assert lines[2]["who"] is None and lines[2]["status"] == 401
    text = settings.audit_path.read_text()
    assert token not in text and "wrong" not in text


def test_token_file_has_only_hashes(settings, token):
    data = json.loads(settings.tokens_path.read_text())
    assert token not in settings.tokens_path.read_text()
    assert data["tokens"][0]["name"] == "alice" and len(data["tokens"][0]["sha256"]) == 64
    assert stat.S_IMODE(os.stat(settings.tokens_path).st_mode) == 0o600


def test_tokens_cli(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("ADMIN_DATA_DIR", str(tmp_path / "d"))
    assert token_cli.main(["add", "bob"]) == 0
    raw = capsys.readouterr().out.strip()
    store = TokenStore(tmp_path / "d" / "mcp_tokens.json")
    assert store.name_for(raw) == "bob" and len(raw) >= 40
    assert token_cli.main(["add", "bob"]) == 1
    assert token_cli.main(["add", "bad name!"]) == 1
    capsys.readouterr()
    assert token_cli.main(["list"]) == 0
    listed = capsys.readouterr().out
    assert "bob" in listed and raw not in listed
    assert token_cli.main(["revoke", "bob"]) == 0
    assert store.name_for(raw) is None
    assert token_cli.main(["revoke", "bob"]) == 1
