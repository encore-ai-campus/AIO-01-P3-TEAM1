"""공용 fixture: SQLite 테스트 DB, 고정 시계, 관리자 앱, 로그인·토큰 도우미."""
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from paper_admin import tokens as token_cli
from paper_admin.api import create_app
from paper_admin.auth import TokenStore
from paper_admin.config import Settings
from paper_admin.db import sqlite_time
from paper_admin.health import HealthMonitor
from paper_admin.util import KST

SCHEMA = Path(__file__).with_name("schema.sql")
NOW = datetime(2026, 10, 8, 12, 0, 0, tzinfo=KST)
SECRET = "test-secret-key-0123456789-abcdefghij"
# 실제 Django가 만든 해시: 비밀번호 admin-pass-1
DJANGO_HASH = "pbkdf2_sha256$1000$seasaltseasalt12$GNxnwplHTw1vYfPt7ErHAc58uT4HCaPlOPtlyEVCpOs="
PASSWORD = "admin-pass-1"


def ago(**kw) -> datetime:
    return NOW - timedelta(**kw)


class Rows:
    """테스트 DB에 행을 넣는 도우미. dict/list → JSON 문자열, datetime → Django SQLite 형식."""

    def __init__(self, path: Path):
        self.path = path

    @staticmethod
    def _value(v):
        if isinstance(v, (dict, list)):
            return json.dumps(v, ensure_ascii=False)
        if isinstance(v, datetime):
            return sqlite_time(v)
        if isinstance(v, bool):
            return int(v)
        return v

    def add(self, table: str, **cols) -> int:
        keys = list(cols)
        with sqlite3.connect(self.path) as conn:
            cur = conn.execute(f"INSERT INTO {table} ({', '.join(keys)}) VALUES ({', '.join('?' for _ in keys)})",
                               [self._value(cols[k]) for k in keys])
            return cur.lastrowid

    def sql(self, statement: str, params=()) -> None:
        with sqlite3.connect(self.path) as conn:
            conn.execute(statement, params)

    def staff(self, username="admin", password=DJANGO_HASH, active=True, staff=True) -> int:
        return self.add("auth_user", username=username, password=password, is_active=active, is_staff=staff)

    def report(self, **cols) -> int:
        base = {"symbol": "005930", "name": "삼성전자", "status": "completed", "created_at": ago(hours=1)}
        return self.add("reports", **{**base, **cols})

    def event(self, report_id: int, step: int, actor: str, action: str, at: datetime, status="started", **cols) -> int:
        return self.add("report_trace_events", report_id=report_id, step=step, actor=actor, action=action,
                        status=status, at=at, **{"details": {}, **cols})

    def engine(self, **cols) -> int:
        base = {"name": "run_engine", "version": "500d087abc", "host": "engine-1", "pid": 7,
                "started_at": ago(hours=2), "beat_at": ago(seconds=10), "halted": False, "broker_ready": True,
                "last_tick_ms": 420, "step_errors": [],
                "limits": {"aiDailyBudgetUsd": 10, "analysesPerUser": 5, "analysesTotal": 33, "reportsPerUser": 3}}
        return self.add("engine_status", **{**base, **cols})


@pytest.fixture
def db_path(tmp_path) -> Path:
    path = tmp_path / "service.sqlite3"
    with sqlite3.connect(path) as conn:
        conn.executescript(SCHEMA.read_text(encoding="utf-8"))
    return path


@pytest.fixture
def rows(db_path) -> Rows:
    return Rows(db_path)


@pytest.fixture
def settings(tmp_path, db_path) -> Settings:
    return Settings(database_url=f"sqlite:///{db_path}", secret_key=SECRET, data_dir=tmp_path / "data")


class Clock:
    def __init__(self, now: datetime = NOW):
        self.now = now

    def __call__(self) -> datetime:
        return self.now


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def monitor(clock) -> HealthMonitor:
    return HealthMonitor("", 30, clock=clock)


@pytest.fixture
def app(settings, monitor, clock):
    return create_app(settings, monitor=monitor, clock=clock)


@pytest.fixture
def client(app) -> TestClient:
    return TestClient(app)


@pytest.fixture
def staff_client(client, rows) -> TestClient:
    """staff로 로그인한 클라이언트."""
    rows.staff()
    res = client.post("/api/admin/login", json={"username": "admin", "password": PASSWORD})
    assert res.status_code == 200, res.text
    return client


@pytest.fixture
def token(settings) -> str:
    return token_cli.add(TokenStore(settings.tokens_path), "alice")


def audit_lines(settings) -> list[dict]:
    if not settings.audit_path.exists():
        return []
    return [json.loads(line) for line in settings.audit_path.read_text(encoding="utf-8").splitlines()]
