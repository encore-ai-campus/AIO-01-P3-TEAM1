"""AI 분석 한도 (docs/DECISIONS.md 8-4). 횟수로 건다: 팀원별 하루 요청 수, 전체 하루 예산 ÷ 종목당 예상 비용.

하루는 KST 기준이다. 엔진을 시작한 작업은 실패해도 센다 (실패는 대부분 AI 비용을 쓴 뒤에 난다 — 모델 응답 에러, 시간 초과).
엔진을 띄우기 전에 끝난 실패만 세지 않는다. 한도 값은 환경 변수 → 저장소 .env 순으로 읽는다 (config.settings와 같은 방식).
"""
import os
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation
from functools import cache
from zoneinfo import ZoneInfo

from django.utils import timezone
from paper_engine.config import ROOT, Config, load_env

from .models import Job

KST = ZoneInfo("Asia/Seoul")
COST_PER_ANALYSIS_USD = Decimal("0.3")  # 종목당 예상 비용
DEFAULT_PER_USER = 5
DEFAULT_BUDGET_USD = Decimal("10")


@cache
def _dotenv() -> dict:
    return load_env(ROOT / ".env")


def _env(key: str) -> str:
    return (os.environ.get(key) or _dotenv().get(key) or "").strip()


def per_user_limit() -> int:
    """AI_DAILY_ANALYSES_PER_USER (기본 5)."""
    try:
        return max(int(_env("AI_DAILY_ANALYSES_PER_USER") or DEFAULT_PER_USER), 0)
    except ValueError:
        return DEFAULT_PER_USER


def total_limit() -> int:
    """floor(AI_DAILY_BUDGET_USD ÷ 0.3) (기본 10달러 → 33회). 소수 오차가 없게 Decimal로 나눈다."""
    try:
        budget = Decimal(_env("AI_DAILY_BUDGET_USD") or DEFAULT_BUDGET_USD)
    except InvalidOperation:
        budget = DEFAULT_BUDGET_USD
    if not budget.is_finite():
        budget = DEFAULT_BUDGET_USD
    return int(max(budget, Decimal(0)) / COST_PER_ANALYSIS_USD)


def today_start(now: datetime | None = None) -> datetime:
    """오늘(KST) 0시."""
    return (now or timezone.now()).astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0)


@dataclass(frozen=True)
class Usage:
    used: int          # 내가 오늘 요청한 수
    limit: int
    used_total: int    # 팀 전체가 오늘 요청한 수
    limit_total: int

    @property
    def remaining(self) -> int:
        return max(0, min(self.limit - self.used, self.limit_total - self.used_total))


def usage(user) -> Usage:
    today = (Job.objects.filter(type=Job.ANALYZE, created_at__gte=today_start())
             .exclude(status=Job.FAILED, started_at__isnull=True))
    return Usage(used=today.filter(user=user).count(), limit=per_user_limit(),
                 used_total=today.count(), limit_total=total_limit())


def unavailable_reason(cfg: Config) -> str | None:
    """분석을 요청할 수 없는 이유. 요청할 수 있으면 None."""
    if not cfg.llm_api_key or not cfg.analysts:
        return "AI 분석 설정(DEVPASS_APIKEY, ANALYSTS)이 없어 분석을 요청할 수 없습니다."
    if not cfg.broker_ready:
        return "증권사 조회 키가 없어 분석을 요청할 수 없습니다."
    return None
