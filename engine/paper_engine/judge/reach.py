"""목표가 도달 가능성 점검. 보유 기간 동안 변동성으로 목표가까지 갈 수 있는지 코드로 본다.

표시용이다. 판정(통과·탈락)에는 쓰지 않는다.
예상 변동폭 = ATR14 × √보유일수 (하루 변동폭을 무작위 보행으로 늘린 값)
비율 = (목표가 − 진입가) ÷ 예상 변동폭
"""
import math
from dataclasses import dataclass

# 비율이 이 값보다 크면 도달하기 어렵다고 표시한다. 초기값이며 모의매매 기록으로 보정한다.
HARD_RATIO = 1.5


@dataclass(frozen=True)
class Reach:
    ratio: float | None  # 목표 거리 ÷ 예상 변동폭. 점검하지 못했으면 None
    expected_move: float | None  # 보유 기간 예상 변동폭 (가격 단위)
    hard: bool  # ratio가 HARD_RATIO보다 큼
    note: str  # 표시할 한 줄


def unavailable(reason: str) -> Reach:
    return Reach(None, None, False, f"목표 도달 점검 못 함: {reason}")


def check_reach(entry: float, target: float, holding_days: int, atr: float | None) -> Reach:
    """atr은 일봉 ATR14 (가격과 같은 통화). 없거나 0 이하면 점검하지 못한 것으로 돌려준다."""
    if atr is None or not math.isfinite(atr) or atr <= 0:
        return unavailable("ATR 없음")
    if entry <= 0 or holding_days < 1:
        raise ValueError(f"진입가와 보유일수는 양수여야 합니다: {entry}, {holding_days}")
    expected = atr * math.sqrt(holding_days)
    ratio = (target - entry) / expected
    hard = ratio > HARD_RATIO
    numbers = (f"목표 {(target - entry) / entry:+.1%} / {holding_days}일 예상 변동폭 "
               f"{expected / entry:.1%} (ATR×√일수) = {ratio:.2f}배")
    if hard:
        note = f"주의 목표 도달 어려움: {numbers} (기준 {HARD_RATIO}배)"
    else:
        note = f"목표 도달 점검: {numbers}"
    return Reach(ratio, expected, hard, note)
