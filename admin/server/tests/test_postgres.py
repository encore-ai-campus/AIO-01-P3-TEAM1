"""PostgreSQL 통합 테스트: ADMIN_TEST_PG_DSN(읽기 전용 계정 paper_admin_ro)이 있을 때만 돈다.

서비스 마이그레이션을 적용한 DB에 deploy/readonly_role.sql을 건 뒤 돌린다. 모든 엔드포인트가 200이고, 쓰기는 실패해야 한다.
"""
import os

import pytest
from fastapi.testclient import TestClient

from paper_admin import tokens as token_cli
from paper_admin.api import create_app
from paper_admin.auth import TokenStore
from paper_admin.config import Settings
from paper_admin.db import PostgresDatabase
from paper_admin.health import HealthMonitor

DSN = os.environ.get("ADMIN_TEST_PG_DSN")
pytestmark = [pytest.mark.pg, pytest.mark.skipif(not DSN, reason="ADMIN_TEST_PG_DSN 없음")]

PATHS = ["/api/admin/me", "/api/admin/overview", "/api/admin/service", "/api/admin/engine", "/api/admin/deploys",
         "/api/admin/reports?days=90", "/api/admin/recovery?days=90", "/api/admin/costs?days=90",
         "/api/admin/alerts?hours=168", "/api/admin/mcp?hours=168"]


@pytest.fixture
def client(tmp_path):
    settings = Settings(database_url=DSN, secret_key="x" * 40, data_dir=tmp_path)
    token = token_cli.add(TokenStore(settings.tokens_path), "pg-test")
    app = create_app(settings, monitor=HealthMonitor("", 30))
    with TestClient(app) as c:  # lifespan이 끝나면 연결 풀을 닫는다 (계정 연결 한도 10)
        c.headers["Authorization"] = f"Bearer {token}"
        yield c


def test_pool_limits_concurrent_connections():
    """동시 요청이 많아도 연결 풀 크기(4)를 넘지 않는다 — 계정의 CONNECTION LIMIT 10 안."""
    from concurrent.futures import ThreadPoolExecutor

    from paper_admin.db import POOL_SIZE

    db = PostgresDatabase(DSN)
    try:
        with ThreadPoolExecutor(max_workers=12) as ex:
            counts = list(ex.map(lambda _: db.query(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE usename = current_user")[0]["n"], range(24)))
        assert max(counts) <= POOL_SIZE
    finally:
        db.close()


@pytest.mark.parametrize("path", PATHS)
def test_all_endpoints_200(client, path):
    res = client.get(path)
    assert res.status_code == 200, res.text


def test_trace_of_latest_report(client):
    rows = client.get("/api/admin/reports?days=90&kind=all").json()["results"]
    if not rows:
        assert client.get("/api/admin/reports/1/trace").status_code in (200, 404)
        return
    assert client.get(f"/api/admin/reports/{rows[0]['id']}/trace").status_code == 200


def test_staff_view_readable():
    db = PostgresDatabase(DSN)
    try:
        db.query("SELECT id, username, password, is_active FROM admin_staff_accounts WHERE id = %(id)s", {"id": 0})
    finally:
        db.close()


@pytest.mark.parametrize("sql", [
    "INSERT INTO notification_outbox (kind, content, status, attempts, created_at) VALUES ('x', 'x', 'pending', 0, now())",
    "UPDATE reports SET status = status WHERE id = 0",
    "DELETE FROM jobs WHERE id = 0",
])
def test_writes_fail(sql):
    import psycopg
    # 읽기 전용 옵션 없이 붙어도 계정 권한으로 막혀야 한다
    with psycopg.connect(DSN, autocommit=True) as conn:
        with pytest.raises(psycopg.Error):
            conn.execute(sql)


def test_hidden_columns_fail():
    import psycopg
    with psycopg.connect(DSN, autocommit=True) as conn:
        for sql in ("SELECT content FROM reports LIMIT 1", "SELECT content FROM notification_outbox LIMIT 1",
                    "SELECT password FROM auth_user LIMIT 1"):
            with pytest.raises(psycopg.Error):
                conn.execute(sql)


def test_fail_fast_after_connection_failure():
    """DB(터널)가 끊기면 한 번 기다린 뒤 FAIL_FAST_SEC 동안은 바로 실패한다."""
    import time

    from paper_admin.db import DBUnavailable

    t = [0.0]
    db = PostgresDatabase("postgresql://paper_admin_ro:x@127.0.0.1:1/paper", clock=lambda: t[0])
    try:
        with pytest.raises(DBUnavailable):
            db.query("SELECT 1 AS n")
        started = time.monotonic()
        with pytest.raises(DBUnavailable, match="recently_failed"):
            db.query("SELECT 1 AS n")
        assert time.monotonic() - started < 0.5
        t[0] = 10.0
        ok = PostgresDatabase(DSN)
        try:
            assert ok.query("SELECT 1 AS n") == [{"n": 1}]
        finally:
            ok.close()
    finally:
        db.close()
