"""기술 지표. 입력은 모두 과거 → 최신 순서의 리스트이고, 데이터가 부족하면 None을 반환한다."""
import math


def sma(values: list[float], period: int) -> float | None:
    if len(values) < period:
        return None
    return sum(values[-period:]) / period


def rsi(closes: list[float], period: int = 14) -> float | None:
    """Wilder 방식 RSI."""
    if len(closes) < period + 1:
        return None
    changes = [b - a for a, b in zip(closes, closes[1:])]
    gain = sum(max(c, 0) for c in changes[:period]) / period
    loss = sum(max(-c, 0) for c in changes[:period]) / period
    for c in changes[period:]:
        gain = (gain * (period - 1) + max(c, 0)) / period
        loss = (loss * (period - 1) + max(-c, 0)) / period
    if loss == 0:
        return 100.0
    return 100 - 100 / (1 + gain / loss)


def atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> float | None:
    """Wilder 방식 ATR."""
    if len(closes) < period + 1:
        return None
    trs = [max(h - l, abs(h - pc), abs(l - pc))
           for h, l, pc in zip(highs[1:], lows[1:], closes)]  # noqa: E741
    value = sum(trs[:period]) / period
    for tr in trs[period:]:
        value = (value * (period - 1) + tr) / period
    return value


def change_rate(closes: list[float], days: int) -> float | None:
    if len(closes) < days + 1:
        return None
    return closes[-1] / closes[-1 - days] - 1


def volatility(closes: list[float], period: int = 20) -> float | None:
    """일간 로그수익률 표준편차를 연율화한 값 (거래일 252일 기준)."""
    if len(closes) < period + 1:
        return None
    window = closes[-period - 1:]
    rets = [math.log(b / a) for a, b in zip(window, window[1:])]
    mean = sum(rets) / period
    var = sum((r - mean) ** 2 for r in rets) / (period - 1)
    return math.sqrt(var) * math.sqrt(252)
