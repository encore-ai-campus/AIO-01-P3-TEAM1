"""손절가. AI가 아니라 코드가 정한다 (docs/design/DESIGN.md "리스크 엔진").

손절가 = 최근 SWING_LOOKBACK개 완성 봉의 최저가 − ATR14 × LOW_BUFFER_ATR (최근 저점 바로 아래)
이 값을 기준가에서 ATR14의 MIN_STOP_ATR배 이상, MAX_STOP_ATR배 이하로 떨어지게 맞추고 호가 단위로 내린다.
너무 가까우면 평소 흔들림에 걸리고, 너무 멀면 한 번에 잃는 돈이 커진다.

기준가는 분석할 때의 가격이다 (엔진 분석은 lastPrice, AI 리포트는 시세 조사의 price — 장 중이면 현재가, 아니면 직전 정규장 종가).
진입가가 아니라 기준가로 정하므로 AI는 손절가를 미리 받아 확률을 추정하고, 진입가를 바꿔도 손절가는 그대로다.
"""
import math

from ..data.ticks import round_price

SWING_LOOKBACK = 10   # 최근 저점을 찾는 완성 봉 수
LOW_BUFFER_ATR = 0.5  # 최근 저점 아래 여유 (ATR 배수)
MIN_STOP_ATR = 1.0    # 기준가에서 손절가까지 최소 거리 (ATR 배수)
MAX_STOP_ATR = 2.0    # 기준가에서 손절가까지 최대 거리 (ATR 배수)
RULE = (f"최근 완성 봉 {SWING_LOOKBACK}개의 최저가 − ATR14×{LOW_BUFFER_ATR:g}을 "
        f"기준가 − ATR14×{MAX_STOP_ATR:g} ~ 기준가 − ATR14×{MIN_STOP_ATR:g} 안으로 맞추고 호가 단위로 내린 값")


def swing_stop(reference: float, lows: list[float], atr: float | None, currency: str) -> float | None:
    """기준가·최근 완성 봉 저가(과거 → 최신)·ATR14 → 손절가. 자료가 모자라거나 0 이하가 되면 None."""
    if atr is None or not math.isfinite(atr) or atr <= 0 or reference is None or reference <= 0:
        return None
    recent = [low for low in lows[-SWING_LOOKBACK:] if low is not None and math.isfinite(low) and low > 0]
    if not recent:
        return None
    structural = min(recent) - atr * LOW_BUFFER_ATR
    stop = min(max(structural, reference - atr * MAX_STOP_ATR), reference - atr * MIN_STOP_ATR)
    if stop <= 0:
        return None
    rounded = float(round_price(stop, currency))
    return rounded if rounded > 0 else None
