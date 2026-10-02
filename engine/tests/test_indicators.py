import math

import pytest

from paper_engine.data import indicators


def test_sma():
    assert indicators.sma([1, 2, 3, 4], 2) == 3.5
    assert indicators.sma([1], 2) is None


def test_rsi_extremes():
    assert indicators.rsi([float(i) for i in range(1, 30)]) == 100.0
    assert indicators.rsi([float(i) for i in range(30, 1, -1)]) == pytest.approx(0.0)
    assert indicators.rsi([1.0] * 5) is None


def test_rsi_alternating_is_neutral():
    closes = [100.0 + (i % 2) for i in range(101)]
    assert indicators.rsi(closes) == pytest.approx(50, abs=5)


def test_atr_constant_range():
    n = 30
    closes = [100.0] * n
    assert indicators.atr([102.0] * n, [98.0] * n, closes) == pytest.approx(4.0)


def test_atr_uses_gap_from_previous_close():
    # 전일 종가 100, 당일 고가 121 / 저가 120 → TR은 21
    highs = [100.0] + [121.0]
    lows = [100.0] + [120.0]
    closes = [100.0, 120.0]
    assert indicators.atr(highs, lows, closes, period=1) == pytest.approx(21.0)


def test_change_rate():
    assert indicators.change_rate([100.0, 105.0, 110.0], 2) == pytest.approx(0.10)
    assert indicators.change_rate([100.0], 2) is None


def test_volatility():
    assert indicators.volatility([100.0] * 25) == 0.0
    closes = [100.0 * math.exp(0.01 * (-1) ** i) for i in range(30)]
    assert indicators.volatility(closes) > 0
