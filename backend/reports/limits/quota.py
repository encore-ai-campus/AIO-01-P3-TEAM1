"""하루 AI 리포트 횟수 한도 (D-7 — docs/DECISIONS.md 14-6, docs/API.md "하루 리포트 한도"). Claude 파일.

팀원마다 오늘(KST) 한도에 세는 리포트 수가 AI_DAILY_REPORTS_PER_USER에 닿으면 새 리포트를 만들지 않는다.
값이 비어 있으면(기본) 한도가 없다 — 2026-10-08 사용자 결정으로 기본값을 3에서 무제한으로 바꿨다 (docs/DECISIONS.md 14-6).
세는 것: 오늘 내가 신청한 리포트에서 **장애 주입 없이 failed로 끝난 것을 뺀** 수 (장애 주입을 켠 리포트는 실패해도 센다).
`chaos` 열은 아직 없으므로(담당 4의 마이그레이션 0002) `getattr(report, "chaos", None)`이 dict이고 `enabled`가 참일 때만
failed도 센다 — 열이 생기기 전에는 failed를 모두 뺀다. JSON 열은 Python에서 읽는다 (PostgreSQL 전용 조회를 쓰지 않는다).
자동 리포트(source "auto")는 신청자가 없어 세지 않는다.

`ReportsView.post`는 같은 종목의 진행 중 리포트를 돌려주는 200 경로 뒤, 생성 앞에서 `check(user, now)`를 부른다
(사용자 행을 잠근 트랜잭션 안이라 같은 사람의 동시 신청이 한도를 넘지 못한다). 넘으면 `Exceeded`(429) —
본문에 limit·used가 있어야 하므로 뷰가 `Exceeded.body()`로 Response를 직접 만든다 (config.api는 detail 외 필드를 버린다).
비용 합산 한도(분석 + 리포트 $)는 팀 파일 budget.py (여기 넣지 않는다). 팀 코드도 이 모듈을 불러도 된다.

한도 값은 환경 변수 → 저장소 .env 순으로 읽는다 (analysis.quota·autotrade.conf와 같은 방식).
"""
import os
from dataclasses import dataclass
from datetime import datetime, timedelta
from functools import cache

from django.utils import timezone
from paper_engine.config import ROOT, load_env

from config.api import LimitExceeded

from ..models import Report
from ..payloads import KST

DEFAULT_PER_USER = None  # 무제한 (2026-10-08 전에는 3)


@cache
def _dotenv() -> dict:
    return load_env(ROOT / ".env")


def _env(key: str) -> str:
    return (os.environ.get(key) or _dotenv().get(key) or "").strip()


def per_user_limit() -> int | None:
    """AI_DAILY_REPORTS_PER_USER (비었거나 숫자가 아니면 기본값 None = 무제한, 0이면 신청할 수 없다)."""
    try:
        return max(int(_env("AI_DAILY_REPORTS_PER_USER")), 0)
    except ValueError:
        return DEFAULT_PER_USER


def day_range(now: datetime | None = None) -> tuple[datetime, datetime]:
    """오늘(KST) 0시와 다음 날 0시. 다음 날 0시가 한도가 다시 차는 시각이다 (KST는 서머타임이 없다)."""
    start = (now or timezone.now()).astimezone(KST).replace(hour=0, minute=0, second=0, microsecond=0)
    return start, start + timedelta(days=1)


def counts(report: Report) -> bool:
    """한도에 세는 리포트인가. 자동 리포트는 세지 않고, failed는 장애 주입을 켰을 때만 센다."""
    if getattr(report, "source", "user") == "auto":
        return False
    if report.status != Report.FAILED:
        return True
    chaos = getattr(report, "chaos", None)
    return isinstance(chaos, dict) and chaos.get("enabled") is True


@dataclass(frozen=True)
class Usage:
    limit: int | None       # None이면 무제한
    used: int               # 오늘 내가 신청한 리포트 중 한도에 세는 수
    resets_at: datetime     # 다음 날 0시 (KST)

    @property
    def remaining(self) -> int | None:
        return None if self.limit is None else max(self.limit - self.used, 0)


def usage(user, now: datetime | None = None) -> Usage:
    """오늘(KST) user의 리포트 한도 사용량."""
    start, end = day_range(now)
    today = (Report.objects.filter(user=user, created_at__gte=start, created_at__lt=end)
             .defer("results", "errors", "content", "completed_agents", "failed_agents"))  # 셀 때 읽지 않는 큰 열
    return Usage(limit=per_user_limit(), used=sum(1 for report in today if counts(report)), resets_at=end)


class Exceeded(LimitExceeded):
    """하루 리포트 한도 초과 → 429 {"detail", "limit", "used"} (뷰가 body()로 Response를 직접 만든다)."""

    def __init__(self, used: Usage):
        self.usage = used
        super().__init__(f"오늘 리포트 한도({used.limit}개)를 다 썼어요. 내일 0시에 다시 만들 수 있어요.")

    def body(self) -> dict:
        return {"detail": str(self.detail), "limit": self.usage.limit, "used": self.usage.used}


def check(user, now: datetime | None = None) -> Usage:
    """새 리포트를 만들 수 있으면 사용량을, 한도에 닿았으면 Exceeded를 낸다 (무제한이면 내지 않는다)."""
    used = usage(user, now)
    if used.remaining is not None and used.remaining <= 0:
        raise Exceeded(used)
    return used
