import math

import pytest

from paper_engine.judge.stops import MAX_STOP_ATR, MIN_STOP_ATR, SWING_LOOKBACK, swing_stop


def test_recent_low_minus_half_atr_when_inside_band():
    # 저점 97,000 − 4,000 × 0.5 = 95,000. 허용 범위는 100,000 − 4,000 × (1~2) = 92,000~96,000
    assert swing_stop(100_000, [99_000, 97_000, 98_000], 4_000, "KRW") == 95_000


def test_too_close_low_is_pushed_to_one_atr():
    # 저점 99,500 − 1,000 = 98,500은 현재가에 너무 가깝다 → 100,000 − 2,000 × 1 = 98,000
    assert swing_stop(100_000, [99_500], 2_000, "KRW") == 100_000 - 2_000 * MIN_STOP_ATR


def test_too_far_low_is_capped_at_two_atr():
    # 저점 80,000 − 1,000 = 79,000은 너무 멀다 → 100,000 − 2,000 × 2 = 96,000
    assert swing_stop(100_000, [80_000, 99_000], 2_000, "KRW") == 100_000 - 2_000 * MAX_STOP_ATR


def test_only_recent_candles_count():
    lows = [50_000] + [97_000] * SWING_LOOKBACK  # 오래된 저점 50,000은 보지 않는다
    assert swing_stop(100_000, lows, 4_000, "KRW") == 95_000


def test_rounds_down_to_tick():
    # 276,250원대 종목: 호가 단위 500원. 264,500 − 12,500 × 0.5 = 258,250 → 258,000
    assert swing_stop(276_250, [264_500, 270_000], 12_500, "KRW") == 258_000
    assert swing_stop(147.5, [146.234], 2.0, "USD") == 145.23  # 146.234 − 1 = 145.234 (범위 143.5~145.5) → 센트 단위로 내림


@pytest.mark.parametrize("reference,lows,atr", [
    (100_000, [97_000], None), (100_000, [97_000], 0), (100_000, [97_000], math.nan), (100_000, [], 4_000),
    (0, [97_000], 4_000), (100, [10], 60),  # 마지막: 100 − 60 × 2 = −20 → 0 이하
])
def test_none_when_data_is_missing_or_stop_not_positive(reference, lows, atr):
    assert swing_stop(reference, lows, atr, "KRW") is None
