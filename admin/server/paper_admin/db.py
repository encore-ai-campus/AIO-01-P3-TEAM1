"""서비스 DB 읽기 전용 접근 (API.md 4장).

SQL은 `%(name)s` 이름 인자로 쓴다 (SQLite 어댑터가 `:name`으로 바꾼다). `SELECT *`를 쓰지 않는다 — 운영 계정은 열 단위 권한이다.
두 DB가 같은 Python 값을 내도록 JSON 열은 dict/list, 시각 열은 aware datetime, 참거짓 열은 bool로 맞춘다.
"""
import json
import re
import sqlite3
import threading
import time
from datetime import UTC, datetime
from typing import Any, Iterable
from urllib.parse import unquote

from .util import parse_time

PG_OPTIONS = "-c default_transaction_read_only=on -c statement_timeout=5000"
POOL_SIZE = 4         # 동시에 쓰는 연결 상한 (읽기 전용 계정의 CONNECTION LIMIT 10보다 작게. 넘는 요청은 기다린다)
POOL_WAIT_SEC = 10    # 연결을 기다리는 상한. 넘으면 503
FAIL_FAST_SEC = 5     # DB가 한 번 실패하면 이 시간 동안은 기다리지 않고 바로 503 (터널이 끊겼을 때 개요가 항목마다 기다리지 않게)
JSON_COLS = {"details", "step_errors", "limits", "chaos", "payload"}
BOOL_COLS = {"halted", "broker_ready", "is_active"}
_PARAM = re.compile(r"%\((\w+)\)s")


class DBUnavailable(Exception):
    """서비스 DB에 붙지 못했거나 조회가 실패했다 → 503."""


def _normalize(row: dict) -> dict:
    for key, value in row.items():
        if key in JSON_COLS and isinstance(value, (str, bytes)):
            try:
                row[key] = json.loads(value)
            except ValueError:
                row[key] = None
        elif key.endswith("_at") or key == "at":
            row[key] = parse_time(value)
        elif key in BOOL_COLS and value is not None:
            row[key] = bool(value)
    return row


def in_params(prefix: str, values: Iterable[Any]) -> tuple[str, dict]:
    """`IN (...)`에 넣을 이름 인자들. 빈 목록이면 항상 거짓인 조각."""
    params = {f"{prefix}{i}": v for i, v in enumerate(values)}
    if not params:
        return "(NULL)", {}
    return "(" + ", ".join(f"%({k})s" for k in params) + ")", params


def sqlite_time(dt: datetime) -> str:
    """Django가 SQLite에 저장하는 시각 형식 (UTC, 시간대 없음). 문자열 비교가 시각 비교가 된다."""
    return dt.astimezone(UTC).strftime("%Y-%m-%d %H:%M:%S.%f")


class Database:
    def query(self, sql: str, params: dict | None = None) -> list[dict]:
        raise NotImplementedError


def _read_only(conn) -> None:
    conn.read_only = True


class PostgresDatabase(Database):
    """연결 풀(최대 4개)로 붙는다: SSH 터널을 지나는 연결을 요청마다 새로 열지 않고, 동시 요청이 계정 연결 한도를 넘지 않게."""

    def __init__(self, url: str, clock=time.monotonic):
        self.url = url
        self.clock = clock
        self._pool = None
        self._lock = threading.Lock()
        self._down_until = 0.0

    def _connections(self):
        from psycopg_pool import ConnectionPool
        with self._lock:
            if self._pool is None:
                self._pool = ConnectionPool(self.url, min_size=0, max_size=POOL_SIZE, timeout=POOL_WAIT_SEC,
                                            kwargs={"options": PG_OPTIONS, "connect_timeout": 5}, configure=_read_only,
                                            check=ConnectionPool.check_connection, open=True, name="paper-admin")
            return self._pool

    def query(self, sql: str, params: dict | None = None) -> list[dict]:
        import psycopg
        from psycopg.rows import dict_row
        from psycopg_pool import PoolTimeout
        if self.clock() < self._down_until:
            raise DBUnavailable("recently_failed")
        try:
            with self._connections().connection() as conn:
                with conn.cursor(row_factory=dict_row) as cur:
                    cur.execute(sql, params or {})
                    return [_normalize(dict(r)) for r in cur.fetchall()]
        except (psycopg.OperationalError, PoolTimeout) as e:  # 연결 끊김·시간 초과
            self._down_until = self.clock() + FAIL_FAST_SEC
            raise DBUnavailable(type(e).__name__) from e
        except psycopg.Error as e:  # 권한·문법 등: DB는 살아 있다
            raise DBUnavailable(type(e).__name__) from e

    def close(self) -> None:
        with self._lock:
            if self._pool is not None:
                self._pool.close()
                self._pool = None


class SqliteDatabase(Database):
    """테스트용. 읽기 전용(mode=ro)으로 연다."""

    def __init__(self, path: str):
        self.path = path

    def query(self, sql: str, params: dict | None = None) -> list[dict]:
        try:
            conn = sqlite3.connect(f"file:{self.path}?mode=ro", uri=True)
        except sqlite3.Error as e:
            raise DBUnavailable(type(e).__name__) from e
        try:
            conn.row_factory = sqlite3.Row
            args = {k: sqlite_time(v) if isinstance(v, datetime) else v for k, v in (params or {}).items()}
            rows = conn.execute(_PARAM.sub(r":\1", sql), args).fetchall()
            return [_normalize(dict(r)) for r in rows]
        except sqlite3.Error as e:
            raise DBUnavailable(type(e).__name__) from e
        finally:
            conn.close()


def connect(url: str) -> Database:
    if url.startswith("sqlite:///"):
        return SqliteDatabase(unquote(url.removeprefix("sqlite:///")))
    return PostgresDatabase(url)
