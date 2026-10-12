"""장애 주입 신청 (API.md 7장, F11): 서비스 내부 API(서비스 docs/API.md "장애 주입 내부 API")를 서명해 부른다.

관리 서버는 서비스 DB에 쓰지 않는다. 길: 관리자 백엔드 → tunnel:8000 → SSH 터널 → 서비스 서버 127.0.0.1:WEB_LOCAL_PORT(web).
서명: `X-Chaos-Timestamp`(유닉스 초), `X-Chaos-Signature` = hex(HMAC-SHA256(ADMIN_CHAOS_SECRET, "<timestamp>." + 보낸 본문 바이트)).
본문은 한 번만 직렬화해 그 바이트에 서명하고 그 바이트를 그대로 보낸다 (GET은 빈 본문 b""에 서명).
Host는 `127.0.0.1`로 보낸다 — 서비스 Django의 ALLOWED_HOSTS가 받는 이름이다 (터널 이름 `tunnel`은 거절된다).
"""
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

import httpx

TIMEOUT_SEC = 10.0
SERVICE_HOST = "127.0.0.1"
OPTIONS_PATH = "/api/internal/chaos-runs/options"
RUNS_PATH = "/api/internal/chaos-runs"
PASS_THROUGH = (400, 403, 409, 429)  # 서비스의 이 응답은 상태와 detail(409는 id도) 그대로 돌려준다
OFF = "장애 주입이 꺼져 있습니다 (ADMIN_CHAOS_SECRET 없음)"
UNREACHABLE = "서비스에 연결할 수 없습니다"


class Unreachable(Exception):
    """서비스 내부 API에 닿지 못했거나 거절(401 서명·404 꺼짐·5xx)당했다 → 503."""


@dataclass(frozen=True)
class Reply:
    status: int
    body: dict


def sign(secret: str, timestamp: str, body: bytes) -> str:
    return hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


class ChaosClient:
    """서비스 내부 API 클라이언트. transport는 테스트가 가짜 서비스(httpx.MockTransport)를 끼울 때 쓴다."""

    def __init__(self, base_url: str, secret: str, *, transport: httpx.BaseTransport | None = None, clock=time.time):
        self.base_url = base_url.rstrip("/")
        self.secret = secret
        self.transport = transport
        self.clock = clock

    def _send(self, method: str, path: str, body: bytes) -> httpx.Response:
        timestamp = str(int(self.clock()))
        headers = {"Host": SERVICE_HOST, "X-Chaos-Timestamp": timestamp,
                   "X-Chaos-Signature": sign(self.secret, timestamp, body)}
        if body:
            headers["Content-Type"] = "application/json"
        try:
            with httpx.Client(timeout=TIMEOUT_SEC, transport=self.transport, follow_redirects=False) as client:
                return client.request(method, self.base_url + path, content=body, headers=headers)
        except httpx.HTTPError:
            raise Unreachable("connection") from None

    @staticmethod
    def _json(res: httpx.Response) -> dict:
        try:
            data = res.json()
        except ValueError:
            data = None
        if not isinstance(data, dict):
            raise Unreachable(f"HTTP {res.status_code} (JSON 아님)")
        return data

    def options(self) -> dict:
        """GET options: 200이면 JSON 그대로. 그 밖은 Unreachable."""
        res = self._send("GET", OPTIONS_PATH, b"")
        if res.status_code != 200:
            raise Unreachable(f"HTTP {res.status_code}")
        return self._json(res)

    def create(self, symbol, chaos, requested_by: str) -> Reply:
        """POST 실행 만들기: 201은 본문 그대로, 400·403·409·429는 detail(409는 id도) 그대로. 그 밖은 Unreachable."""
        if isinstance(chaos, dict):
            chaos = {k: v for k, v in chaos.items() if k != "requestedBy"}  # 신청한 사람은 로그인한 staff로만 정한다
        payload = {"symbol": symbol, "chaos": chaos, "requestedBy": requested_by}
        body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        res = self._send("POST", RUNS_PATH, body)
        if res.status_code == 201:
            return Reply(201, self._json(res))
        if res.status_code not in PASS_THROUGH:
            raise Unreachable(f"HTTP {res.status_code}")
        try:
            data = res.json()
        except ValueError:
            data = None
        data = data if isinstance(data, dict) else {}
        detail = data.get("detail")
        out = {"detail": detail if isinstance(detail, str) and detail else f"서비스가 요청을 거절했습니다 (HTTP {res.status_code})"}
        if res.status_code == 409 and isinstance(data.get("id"), int) and not isinstance(data.get("id"), bool):
            out["id"] = data["id"]
        return Reply(res.status_code, out)
