"""로그인·세션 쿠키·Bearer 토큰·감사 기록 (API.md 1장).

비밀번호는 Django `pbkdf2_sha256$반복$솔트$base64해시`만 검증한다. 세션 쿠키는 uid·아이디·만료·비밀번호 해시 지문·nonce를 HMAC으로 서명하고,
요청마다 뷰 `admin_staff_accounts`를 다시 읽어 staff·활성·지문을 확인한다 (서비스 DB가 끊겼을 때만 서명·만료·로그아웃만 본다).
로그아웃한 쿠키의 nonce는 만료까지 메모리에 둬 다시 쓰지 못하게 한다 (uvicorn 워커 1개 전제). 토큰은 SHA-256 해시로만 둔다.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from .db import Database
from .util import iso

COOKIE_NAME = "paper_admin_session"
SESSION_TTL = timedelta(hours=12)
FAIL_WINDOW_SEC = 600
FAIL_LIMIT = 5
BLOCK_SEC = 600
MAX_ITERATIONS = 10_000_000
LOGIN_FAILED = "아이디 또는 비밀번호가 맞지 않거나 관리자 계정이 아닙니다."
# 없는 아이디·staff가 아닌 아이디도 같은 시간이 걸리게 검증하는 가짜 해시 (Django 5.2 기본 반복 수. 어떤 비밀번호와도 맞지 않는다)
DUMMY_HASH = "pbkdf2_sha256$1000000$paperadmindummysalt$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="


def verify_django_password(password: str, encoded: str | None) -> bool:
    """Django pbkdf2_sha256 해시 검증. 다른 형식·깨진 값은 실패."""
    if not encoded or not password:
        return False
    parts = encoded.split("$")
    if len(parts) != 4 or parts[0] != "pbkdf2_sha256":
        return False
    _, iterations, salt, expected = parts
    if not iterations.isdigit() or not 0 < int(iterations) <= MAX_ITERATIONS or not salt:
        return False
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), int(iterations))
    return hmac.compare_digest(base64.b64encode(digest).decode("ascii"), expected)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


@dataclass(frozen=True)
class Staff:
    id: int
    username: str
    password: str
    is_active: bool


STAFF_SQL = "SELECT id, username, password, is_active FROM admin_staff_accounts WHERE {} = %(v)s"


def find_staff(db: Database, *, username: str | None = None, uid: int | None = None) -> Staff | None:
    """뷰에서 staff 한 명. 없으면 None (staff가 아니면 뷰에 없다)."""
    column, value = ("username", username) if username is not None else ("id", uid)
    rows = db.query(STAFF_SQL.format(column), {"v": value})
    if not rows:
        return None
    r = rows[0]
    return Staff(id=int(r["id"]), username=str(r["username"]), password=str(r["password"] or ""),
                 is_active=bool(r["is_active"]))


class Sessions:
    """서명한 세션 쿠키: base64(JSON{uid, exp, fp}).HMAC."""

    def __init__(self, secret: str):
        self.key = hashlib.sha256(b"paper-admin-session:" + secret.encode()).digest()
        self.revoked: dict[str, int] = {}  # 로그아웃한 nonce → 만료 시각
        self.revoked_lock = threading.Lock()

    def fingerprint(self, password_hash: str) -> str:
        return hmac.new(self.key, b"pw:" + password_hash.encode(), hashlib.sha256).hexdigest()[:32]

    def _sign(self, body: str) -> str:
        return _b64(hmac.new(self.key, body.encode(), hashlib.sha256).digest())

    def make(self, staff: Staff, now: datetime) -> str:
        payload = {"uid": staff.id, "u": staff.username, "exp": int((now + SESSION_TTL).timestamp()),
                   "fp": self.fingerprint(staff.password), "n": secrets.token_hex(8)}
        body = _b64(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
        return f"{body}.{self._sign(body)}"

    def read(self, cookie: str | None, now: datetime) -> dict | None:
        """서명·만료·로그아웃 여부를 확인한 내용. 틀리면 None."""
        if not cookie or cookie.count(".") != 1:
            return None
        body, sig = cookie.split(".")
        if not hmac.compare_digest(self._sign(body), sig):
            return None
        try:
            payload = json.loads(_unb64(body))
            uid, exp, fp = int(payload["uid"]), int(payload["exp"]), str(payload["fp"])
            username, nonce = str(payload["u"]), str(payload["n"])
        except (ValueError, KeyError, TypeError):
            return None
        if exp <= now.timestamp():
            return None
        with self.revoked_lock:
            if nonce in self.revoked:
                return None
        return {"uid": uid, "fp": fp, "username": username, "nonce": nonce, "exp": exp}

    def revoke(self, cookie: str | None, now: datetime) -> None:
        """로그아웃: 이 쿠키를 만료까지 받지 않는다. 지난 항목은 이때 지운다."""
        data = self.read(cookie, now)
        if data is None:
            return
        with self.revoked_lock:
            for nonce, exp in list(self.revoked.items()):
                if exp <= now.timestamp():
                    del self.revoked[nonce]
            self.revoked[data["nonce"]] = data["exp"]

    def staff_for(self, db: Database, cookie: str | None, now: datetime) -> Staff | None:
        """쿠키가 가리키는 지금도 유효한 staff. staff 해제·비활성·비밀번호 변경이면 None."""
        data = self.read(cookie, now)
        if data is None:
            return None
        staff = find_staff(db, uid=data["uid"])
        if staff is None or not staff.is_active:
            return None
        if not hmac.compare_digest(self.fingerprint(staff.password), data["fp"]):
            return None
        return staff


class LoginLimiter:
    """아이디별로 10분 안에 5번 시도해 성공하지 못하면 10분 막는다 (메모리, uvicorn 워커 1개 전제).

    시도를 검증 전에 센다 — 동시에 보낸 요청이 모두 확인을 통과해 한도를 넘지 못하게. 성공하면 그 아이디의 기록을 지운다.
    IP로는 여기서 막지 않는다: SSH 터널로 들어오면 모두 같은 주소라 한 사람의 실수로 모두가 막힌다. 퍼블릭으로 열었을 때의 IP 제한은 nginx(web/nginx.conf)가 한다.
    """

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.attempts: dict[str, deque] = {}
        self.blocked: dict[str, float] = {}
        self.lock = threading.Lock()

    @staticmethod
    def key(username: str) -> str:
        return username.lower()

    def try_attempt(self, key: str) -> bool:
        """막혀 있으면 False. 아니면 이 시도를 세고 True (5번째 시도부터 막힘이 걸린다 — 그 시도가 성공하면 풀린다)."""
        now = self.clock()
        with self.lock:
            if self.blocked.get(key, 0) > now:
                return False
            q = self.attempts.setdefault(key, deque())
            while q and q[0] <= now - FAIL_WINDOW_SEC:
                q.popleft()
            q.append(now)
            if len(q) >= FAIL_LIMIT:
                self.blocked[key] = now + BLOCK_SEC
                q.clear()
            return True

    def success(self, key: str) -> None:
        with self.lock:
            self.attempts.pop(key, None)
            self.blocked.pop(key, None)


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class TokenStore:
    """mcp_tokens.json: {"tokens": [{"name", "sha256", "createdAt"}]}. 원문은 두지 않는다."""

    def __init__(self, path: Path):
        self.path = path

    def load(self) -> list[dict]:
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        tokens = data.get("tokens") if isinstance(data, dict) else None
        return [t for t in tokens or [] if isinstance(t, dict) and t.get("name") and t.get("sha256")]

    def save(self, tokens: list[dict]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"tokens": tokens}, f, ensure_ascii=False, indent=2)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)

    def name_for(self, token: str | None) -> str | None:
        """맞는 토큰의 이름. 모든 항목과 compare_digest로 비교한다."""
        if not token:
            return None
        digest = token_hash(token)
        found = None
        for t in self.load():
            if hmac.compare_digest(str(t["sha256"]), digest):
                found = str(t["name"])
        return found


class AuditLog:
    """audit.jsonl에 한 줄씩 더한다. 토큰·비밀번호는 적지 않는다."""

    def __init__(self, path: Path):
        self.path = path
        self.lock = threading.Lock()

    def write(self, now: datetime, *, via: str, who: str | None, event: str, path: str,
              status: int, tool: str | None = None) -> None:
        line = json.dumps({"at": iso(now), "via": via, "who": who, "event": event, "tool": tool,
                           "path": path, "status": status}, ensure_ascii=False)
        with self.lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(line + "\n")
