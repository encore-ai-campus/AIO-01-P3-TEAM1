"""장기투자 설정 (docs/DECISIONS.md 14-8). 값은 환경 변수 → 저장소 .env 순으로 읽는다 (autotrade.conf와 같은 방식).

  LONGTERM_JOBS     on | off (기본 on). 엔진 루프에서 오늘의 내 종목 뉴스·펀더멘털 점검을 돌릴지. 테스트는 루트 conftest.py가 off
  DAILY_MOVE_AT     HH:MM (기본 16:30, KST). 국내 거래일, 이 시각 이후 하루 한 번 오늘의 내 종목 뉴스를 만든다
  DAILY_MOVE_MODEL  오늘의 내 종목 뉴스 설명에 쓸 LLM 모델. 없으면 엔진 설정 APPROVER, 그것도 없으면 템플릿 문장만
  THESIS_CHECK_AT   HH:MM (기본 18:00, KST). 이 시각 이후 정기공시 종목(거래일)·월요일 전체를 점검한다
"""
import os
from datetime import time
from functools import cache

from paper_engine.config import ROOT, load_env

from config import engine

DEFAULT_DAILY_MOVE_AT, DEFAULT_THESIS_CHECK_AT = time(16, 30), time(18, 0)
OFF = ("off", "0", "false", "no")


@cache
def _dotenv() -> dict:
    return load_env(ROOT / ".env")


def _env(key: str) -> str:
    return (os.environ.get(key) or _dotenv().get(key) or "").strip()


def _time(key: str, default: time) -> time:
    try:
        hour, minute = _env(key).split(":")
        return time(int(hour), int(minute))
    except ValueError:  # 비었거나 "HH:MM"이 아님 (범위를 벗어난 시각 포함)
        return default


def jobs_enabled() -> bool:
    """LONGTERM_JOBS (기본 on). off면 엔진 루프의 장기투자 단계가 아무것도 하지 않는다."""
    return _env("LONGTERM_JOBS").lower() not in OFF


def daily_move_at() -> time:
    """DAILY_MOVE_AT (기본 16:30, KST)."""
    return _time("DAILY_MOVE_AT", DEFAULT_DAILY_MOVE_AT)


def thesis_check_at() -> time:
    """THESIS_CHECK_AT (기본 18:00, KST)."""
    return _time("THESIS_CHECK_AT", DEFAULT_THESIS_CHECK_AT)


def daily_move_model() -> str | None:
    """DAILY_MOVE_MODEL → 없으면 엔진 설정의 APPROVER → 없으면 None (템플릿 문장만)."""
    return _env("DAILY_MOVE_MODEL") or engine.engine_config().approver or None
