"""자동 리포트 설정 (docs/design/AI_AGENT_WORKFLOW.md 1장, docs/tasks/01-인프라.md T1-4). 값은 환경 변수 → 저장소 .env 순으로 읽는다
(autotrade.conf와 같은 방식).

AUTO_REPORT=on이면 엔진 루프가 국내 거래일 AUTO_REPORT_AT(KST) 이후 하루 한 번 규칙 선별 → AI 선정 팀 → 선정 Guard →
종목 리포트 AUTO_REPORT_TOP개를 돌린다 (reports/autoreport/auto.py). 켜면 시연 자동 추천(AUTO_RECOMMEND=demo)은 끈다.
"""
import os
from datetime import time
from functools import cache

from paper_engine.config import ROOT, load_env

DEFAULT_TOP, MAX_TOP = 3, 5          # 선정 팀(selector_agent)이 내는 순위가 5개까지라 리포트도 5개까지
DEFAULT_AT = time(8, 0)
ON = ("on", "1", "true", "yes")


@cache
def _dotenv() -> dict:
    return load_env(ROOT / ".env")


def _env(key: str) -> str:
    return (os.environ.get(key) or _dotenv().get(key) or "").strip()


def auto_report() -> bool:
    """AUTO_REPORT (off | on, 기본 off). 켜면 매일 선정 팀과 자동 리포트를 돌린다 (증권사 조회 100번 이상 + LLM 호출)."""
    return _env("AUTO_REPORT").lower() in ON


def auto_report_top() -> int:
    """AUTO_REPORT_TOP (기본 3, 1~5). 매일 자동 리포트를 만들 종목 수 (선정 Guard를 거친 최종 종목 수)."""
    try:
        value = int(_env("AUTO_REPORT_TOP") or DEFAULT_TOP)
    except ValueError:
        return DEFAULT_TOP
    return clamp_top(value)


def clamp_top(value: int) -> int:
    """종목 수를 1~5로 맞춘다 (관리 명령의 --top도 같은 범위)."""
    return min(max(value, 1), MAX_TOP)


def auto_report_at() -> time:
    """AUTO_REPORT_AT (기본 08:00, KST). 이 시각 이후 하루 한 번. 읽지 못하면 기본값."""
    value = _env("AUTO_REPORT_AT")
    try:
        hour, minute = value.split(":")
        return time(int(hour), int(minute))
    except ValueError:  # 비었거나 "HH:MM"이 아님
        return DEFAULT_AT
