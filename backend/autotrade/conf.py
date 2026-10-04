"""추천·자동매매 설정 (docs/DECISIONS.md 12-5). 값은 환경 변수 → 저장소 .env 순으로 읽는다 (analysis.quota와 같은 방식)."""
import os
from datetime import time
from functools import cache

from paper_engine.config import ROOT, load_env

DEFAULT_VALID_DAYS = 3
DEFAULT_DEMO_PER_USER = 5
DEFAULT_AUTO_TOP, DEFAULT_AUTO_AT = 3, time(8, 0)
AUTO_MODES = ("off", "demo")
OFF = ("off", "0", "false", "no")


@cache
def _dotenv() -> dict:
    return load_env(ROOT / ".env")


def _env(key: str) -> str:
    return (os.environ.get(key) or _dotenv().get(key) or "").strip()


def _int(key: str, default: int, low: int) -> int:
    try:
        return max(int(_env(key) or default), low)
    except ValueError:
        return default


def valid_days() -> int:
    """RECOMMENDATION_VALID_DAYS (기본 3, 달력 일수). 추천을 활성화할 수 있는 기간이자 진입 기한."""
    return _int("RECOMMENDATION_VALID_DAYS", DEFAULT_VALID_DAYS, 1)


def demo_enabled() -> bool:
    """AUTOTRADE_DEMO (기본 on). 시연용 규칙 추천을 웹에서 만들 수 있게 할지."""
    return _env("AUTOTRADE_DEMO").lower() not in OFF


def demo_per_user() -> int:
    """AUTOTRADE_DEMO_PER_USER (기본 5). 팀원별 하루(KST) 시연 추천 수."""
    return _int("AUTOTRADE_DEMO_PER_USER", DEFAULT_DEMO_PER_USER, 0)


def auto_recommend() -> str:
    """AUTO_RECOMMEND (off | demo, 기본 off). demo면 국내 거래일마다 선별 상위 종목으로 시연 추천을 만든다 (증권사 조회 100번 이상)."""
    value = _env("AUTO_RECOMMEND").lower()
    return value if value in AUTO_MODES else "off"


def auto_recommend_top() -> int:
    """AUTO_RECOMMEND_TOP (기본 3). 매일 자동 추천할 선별 상위 종목 수."""
    return _int("AUTO_RECOMMEND_TOP", DEFAULT_AUTO_TOP, 1)


def auto_recommend_at() -> time:
    """AUTO_RECOMMEND_AT (기본 08:00, KST). 이 시각 이후 하루 한 번. 읽지 못하면 기본값."""
    value = _env("AUTO_RECOMMEND_AT")
    try:
        hour, minute = value.split(":")
        return time(int(hour), int(minute))
    except ValueError:  # 비었거나 "HH:MM"이 아님
        return DEFAULT_AUTO_AT
