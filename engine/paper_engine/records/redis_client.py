"""최소 Redis 클라이언트 (RESP2). 런타임을 표준 라이브러리만으로 유지하려고 직접 구현한다.

예약 주문, 전략, 선별 결과, 엔진 생존 신호에 쓰는 명령만 지원한다 (키 접두사 paper:, docs/DECISIONS.md 5장).
"""
from __future__ import annotations

import socket
import threading
from urllib.parse import urlparse


class RedisError(Exception):
    pass


class Redis:
    def __init__(self, url: str, timeout: float = 5.0):
        u = urlparse(url)
        if u.scheme != "redis":
            raise ValueError(f"REDIS_URL은 redis://로 시작해야 합니다: {u.scheme}://")
        self._addr = (u.hostname or "127.0.0.1", u.port or 6379)
        self._db = int((u.path or "/0").lstrip("/") or 0)
        self._password = u.password
        self._timeout = timeout
        self._sock = None
        self._file = None
        self._lock = threading.Lock()  # serve의 여러 스레드가 연결 하나를 같이 쓴다

    def _connect(self):
        self._sock = socket.create_connection(self._addr, timeout=self._timeout)
        self._file = self._sock.makefile("rb")
        if self._password:
            self._roundtrip("AUTH", self._password)
        if self._db:
            self._roundtrip("SELECT", self._db)

    def close(self):
        if self._sock:
            self._sock.close()
        self._sock = self._file = None

    def execute(self, *args):
        with self._lock:
            for attempt in range(2):
                sent = False
                try:
                    if self._sock is None:
                        self._connect()
                    sent = self._send(*args)
                    return self._read()
                except OSError as e:
                    # 서버 재시작 등으로 끊긴 연결은 한 번만 다시 연결한다. 명령을 보낸 뒤 응답을 기다리다 끊겼으면
                    # 서버가 이미 실행했을 수 있어 다시 보내지 않는다 (INCR 두 번, SET NX 실패로 보이는 것을 막는다).
                    self.close()
                    if attempt or sent:
                        raise RedisError(f"Redis 연결 실패 {self._addr[0]}:{self._addr[1]}: {e}") from None

    def _send(self, *args) -> bool:
        parts = [str(a).encode() if not isinstance(a, bytes) else a for a in args]
        payload = b"*%d\r\n" % len(parts) + b"".join(
            b"$%d\r\n%s\r\n" % (len(p), p) for p in parts)
        self._sock.sendall(payload)
        return True

    def _roundtrip(self, *args):
        self._send(*args)
        return self._read()

    def _read(self):
        line = self._file.readline()
        if not line:
            raise ConnectionError("연결이 끊김")
        kind, rest = line[:1], line[1:-2]
        if kind == b"+":
            return rest.decode()
        if kind == b"-":
            raise RedisError(rest.decode())
        if kind == b":":
            return int(rest)
        if kind == b"$":
            n = int(rest)
            if n == -1:
                return None
            data = self._file.read(n + 2)[:-2]
            return data.decode()
        if kind == b"*":
            n = int(rest)
            return None if n == -1 else [self._read() for _ in range(n)]
        raise RedisError(f"알 수 없는 응답: {line!r}")

    # --- 쓰는 명령 ---

    def ping(self) -> bool:
        return self.execute("PING") == "PONG"

    def get(self, key: str) -> str | None:
        return self.execute("GET", key)

    def set(self, key: str, value: str, nx: bool = False, ex: int | None = None) -> bool:
        args = ["SET", key, value]
        if ex:
            args += ["EX", ex]
        if nx:
            args.append("NX")
        return self.execute(*args) == "OK"

    def delete(self, *keys: str) -> int:
        return self.execute("DEL", *keys)

    def incr(self, key: str) -> int:
        return self.execute("INCR", key)

    def sadd(self, key: str, member: str) -> int:
        return self.execute("SADD", key, member)

    def srem(self, key: str, member: str) -> int:
        return self.execute("SREM", key, member)

    def smembers(self, key: str) -> set[str]:
        return set(self.execute("SMEMBERS", key) or [])

    def scan_keys(self, pattern: str) -> list[str]:
        keys, cursor = set(), "0"
        while True:
            cursor, batch = self.execute("SCAN", cursor, "MATCH", pattern, "COUNT", 500)
            keys.update(batch)
            if cursor == "0":
                return sorted(keys)

    def type(self, key: str) -> str:
        return self.execute("TYPE", key)

    def ttl(self, key: str) -> int:
        return self.execute("TTL", key)
