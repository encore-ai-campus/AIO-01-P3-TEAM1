"""장애 주입 내부 API의 규칙 (docs/API.md "장애 주입 내부 API", docs/DECISIONS.md 35장 — 계획 docs/plans/장애주입분리계획.md 4-2·4-3).

장애 주입을 켜는 곳은 관리 서버 하나다. 관리 서버는 서비스 DB를 읽기만 하고, 실행은 이 내부 API로만 만든다
(관리 서버 → SSH 터널 → web 127.0.0.1:WEB_LOCAL_PORT. 공개 nginx는 /api/internal/을 404로 막는다). 뷰·경로는 reports/views.py·urls.py.
- 서명: X-Chaos-Timestamp(유닉스 초)와 X-Chaos-Signature = hex(HMAC-SHA256(CHAOS_CONTROL_SECRET, "<timestamp>." + 본문 바이트)).
  헤더가 없거나 틀렸거나 시각이 ±60초 밖이거나 같은 서명을 120초 안에 다시 쓰면 401.
  다시 쓰기 확인은 Redis(paper:chaos:sig:<서명>)에 하고, Redis가 없거나 안 되면 프로세스 메모리에 한다 (web은 gunicorn 프로세스 하나).
- requestedBy: 서비스의 활성 staff 아이디만 (403).
- 실행: Report(source "chaos", 신청자 없음, 종목 리포트 팀, chaos = chaos.parse 결과 + requestedBy). 진행 중인 장애 주입 실행은 1건까지 (409) —
  실행기가 1건씩 돌아 사용자 리포트를 오래 막지 않게. 팀 AI 하루 예산(budget.check)은 공개 신청과 같다 (실제 비용이 든다).
비밀 값(CHAOS_CONTROL_SECRET)이 비었으면 기능이 꺼진다 (views.InternalView가 없는 경로와 같은 404).
설정 검사(chaos.parse)·주입 판정(chaos.should_fail)은 chaos.py 그대로 쓴다.
"""
import hashlib
import hmac
import logging
import threading
import time
from datetime import datetime

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from paper_engine.records.redis_client import Redis, RedisError
from rest_framework import status
from rest_framework.exceptions import APIException, PermissionDenied

from config import engine
from config.api import Rejected

from . import chaos
from ..limits import budget
from ..models import Report
from ..orchestration import registry

MAX_SKEW_SEC = 60          # 서명 시각과 지금의 차이 한도
REPLAY_TTL_SEC = 120       # 같은 서명을 다시 쓰지 못하게 기억하는 시간 (±60초 창 전체를 덮는다)
REPLAY_KEY = "paper:chaos:sig:"
REDIS_TIMEOUT_SEC = 2.0
DEFAULT_SCOPE = "primary"  # chaos.parse의 기본값
BAD_SIGNATURE = "서명이 맞지 않습니다."
NOT_STAFF = "관리자만 장애 주입을 신청할 수 있어요."
NOT_ENABLED = "chaos.enabled가 true여야 합니다."
BUSY = "진행 중인 장애 주입 실행이 있어요. 끝난 뒤에 다시 신청해 주세요."

log = logging.getLogger(__name__)
clock = time.time                # 테스트가 가짜 시계로 바꾼다
_lock = threading.Lock()         # Redis 연결과 프로세스 메모리 기억
_seen: dict[str, float] = {}     # Redis가 없을 때: 서명 → 잊는 시각 (유닉스 초)
_redis: Redis | None = None
_redis_url: str | None = None
# 진행 중 확인과 생성을 한 번에 (web은 gunicorn 프로세스 하나에 스레드 여럿 — deploy/Dockerfile. SQLite는 select_for_update를 무시한다)
_create_lock = threading.Lock()


class BadSignature(APIException):
    """서명 헤더가 없거나 틀렸거나 오래됐거나 다시 쓴 것 → 401 {"detail"}.
    (DRF의 AuthenticationFailed는 인증 클래스가 없는 뷰에서 403으로 바뀌므로 따로 둔다)"""
    status_code = status.HTTP_401_UNAUTHORIZED
    default_detail = BAD_SIGNATURE


class Busy(APIException):
    """진행 중(requested·running)인 장애 주입 실행이 있다 → 409 {"detail", "id"} (뷰가 body()로 Response를 직접 만든다)."""
    status_code = status.HTTP_409_CONFLICT

    def __init__(self, report_id: int):
        self.report_id = report_id
        super().__init__(BUSY)

    def body(self) -> dict:
        return {"detail": str(self.detail), "id": self.report_id}


def secret() -> str:
    """CHAOS_CONTROL_SECRET (비었으면 기능 꺼짐)."""
    return (getattr(settings, "CHAOS_CONTROL_SECRET", "") or "").strip()


def sign(body: bytes, timestamp: str, key: str | None = None) -> str:
    """서명 값 hex(HMAC-SHA256(key, "<timestamp>." + body)). 관리 서버와 같은 셈법이다 (테스트도 쓴다)."""
    key = secret() if key is None else key
    return hmac.new(key.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def verify(headers, body: bytes, now: float | None = None) -> None:
    """서명 헤더 확인. 없거나 틀렸거나 시각이 ±MAX_SKEW_SEC 밖이거나 REPLAY_TTL_SEC 안에 다시 쓴 서명이면 BadSignature(401).
    GET은 빈 본문(b"")을 서명한다."""
    timestamp = (headers.get("X-Chaos-Timestamp") or "").strip()
    signature = (headers.get("X-Chaos-Signature") or "").strip().lower()
    if not (timestamp.isascii() and timestamp.isdigit()) or not signature:
        raise BadSignature()
    now = clock() if now is None else now
    if abs(now - int(timestamp)) > MAX_SKEW_SEC:
        raise BadSignature()
    if not hmac.compare_digest(sign(body, timestamp).encode(), signature.encode()):  # 상수 시간 비교
        raise BadSignature()
    if not first_use(signature, now):
        raise BadSignature()


def redis_store() -> Redis | None:
    """다시 쓰기 확인용 Redis (엔진 설정의 REDIS_URL). 없으면 None. 테스트는 이 함수를 바꿔 끼운다."""
    global _redis, _redis_url
    url = engine.engine_config().redis_url
    if not url:
        return None
    with _lock:
        if _redis is None or _redis_url != url:
            _redis, _redis_url = Redis(url, timeout=REDIS_TIMEOUT_SEC), url
        return _redis


def first_use(signature: str, now: float) -> bool:
    """이 서명을 처음 쓰면 True(기억한다), REPLAY_TTL_SEC 안에 이미 썼으면 False."""
    try:
        store = redis_store()
        if store is not None:
            return store.set(REPLAY_KEY + signature, "1", nx=True, ex=REPLAY_TTL_SEC)
    except (RedisError, OSError, ValueError) as e:
        log.warning("장애 주입 서명 확인에 Redis를 쓸 수 없어 프로세스 메모리로 확인합니다: %s", e)
    with _lock:
        for key in [key for key, until in _seen.items() if until <= now]:
            del _seen[key]
        if signature in _seen:
            return False
        _seen[signature] = now + REPLAY_TTL_SEC
        return True


def staff_username(value) -> str:
    """requestedBy가 서비스의 활성 staff 아이디면 그대로, 아니면 PermissionDenied(403)."""
    model = get_user_model()
    if isinstance(value, str) and value and model.objects.filter(
            **{model.USERNAME_FIELD: value}, is_active=True, is_staff=True).exists():
        return value
    raise PermissionDenied(NOT_STAFF)


def parse_config(body) -> dict:
    """신청 본문의 chaos → 저장할 ChaosConfig (chaos.parse 그대로 — 잘못되면 400). 없거나 꺼져 있으면 만들 실행이 없어 400."""
    config = chaos.parse(body, registry.TEAM)
    if config is None:
        raise Rejected(NOT_ENABLED)
    return config


def active_run() -> Report | None:
    """진행 중(requested·running)인 장애 주입 실행 (가장 오래된 것)."""
    return Report.objects.filter(source=Report.CHAOS, status__in=Report.ACTIVE).order_by("id").first()


def create_run(item: dict, config: dict, requested_by: str, now: datetime) -> Report:
    """장애 주입 실행(requested 행)을 만든다. 진행 중인 것이 있으면 Busy(409), 팀 AI 하루 예산을 넘었으면 LimitExceeded(429)."""
    with _create_lock, transaction.atomic():
        active = active_run()
        if active is not None:
            raise Busy(active.pk)
        budget.check(now)
        return Report.objects.create(source=Report.CHAOS, user=None, team=Report.STOCK_REPORT, symbol=item["symbol"],
                                     name=item["name"], market=item["market"],
                                     chaos={**config, "requestedBy": requested_by}, created_at=now)


def run_body(report: Report) -> dict:
    """ChaosRun {"id", "status", "symbol", "name", "chaos"} (chaos는 서버가 채운 기본값·seed와 requestedBy 포함)."""
    return {"id": report.id, "status": report.status, "symbol": report.symbol, "name": report.name, "chaos": report.chaos}


def options(plan: dict) -> dict:
    """ChaosOptions: 종목 리포트 팀 실행 계획(payloads.plan)의 Worker(registry.worker_ids 순서, Registry의 이름)와 고를 수 있는 값."""
    return {"workers": [{"id": worker["id"], "title": worker["title"]} for worker in plan["workers"]],
            "errorTypes": list(chaos.ERROR_TYPES), "scopes": list(chaos.SCOPES),
            "defaults": {"probability": chaos.DEFAULT_PROBABILITY, "scope": DEFAULT_SCOPE}}
