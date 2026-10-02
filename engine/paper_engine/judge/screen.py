"""거래대금 상위 종목에서 중단기(스윙) 매매 후보를 고르는 규칙. AI를 쓰지 않는다.

탈락:
  - ETF·ETN 등 펀드형, 워런트, 레버리지 상품 (주식·해외주식·예탁증서만 남긴다)
  - 거래정지, 정리매매
  - 완성된 일봉 60개 미만 (지표를 믿기 어렵다)
  - 60일 이동평균 아래 (중기 하락 추세)
  - RSI(14)가 40 미만 또는 75 초과 (약세 또는 과열)
  - ATR(14)/종가가 1.5% 미만 (움직임이 작아 손익비가 안 나온다) 또는 8% 초과 (너무 거칠다)
점수 (100점):
  - 추세 40: 종가 > 20일선 20, 20일선 > 60일선 20
  - 모멘텀 20: 20일 수익률 0~+25% 구간에 비례 (그 밖은 0 또는 만점)
  - 과열 여부 20: RSI가 55에 가까울수록 높다
  - 변동성 20: ATR 비율이 3.5%에 가까울수록 높다
"""
from dataclasses import dataclass

from ..data import indicators

TRADABLE_TYPES = ("STOCK", "FOREIGN_STOCK", "DEPOSITARY_RECEIPT")
MIN_CANDLES = 60


@dataclass(frozen=True)
class Pick:
    symbol: str
    name: str
    score: float
    close: float
    rsi: float
    atr_ratio: float
    change20d: float
    trading_amount: float


def eligible(info: dict) -> str | None:
    """종목 정보로 걸러낼 사유. 통과하면 None."""
    if info.get("securityType") not in TRADABLE_TYPES:
        return f"종목 유형 {info.get('securityType')}"
    if info.get("leverageFactor") not in (None, "1", "1.0"):
        return "레버리지 상품"
    kr = info.get("koreanMarketDetail") or {}
    if kr.get("krxTradingSuspended") or kr.get("liquidationTrading"):
        return "거래정지 또는 정리매매"
    if info.get("status") != "ACTIVE":
        return f"상장 상태 {info.get('status')}"
    return None


def score(symbol: str, name: str, candles: list[dict], trading_amount: float) -> Pick | str:
    """candles는 완성된 일봉 (과거 → 최신, 엔진 내부 형식 = 원본 토스 형식). 탈락이면 사유 문자열."""
    if len(candles) < MIN_CANDLES:
        return f"일봉 {len(candles)}개"
    closes = [float(c["closePrice"]) for c in candles]
    highs = [float(c["highPrice"]) for c in candles]
    lows = [float(c["lowPrice"]) for c in candles]
    close = closes[-1]
    sma20, sma60 = indicators.sma(closes, 20), indicators.sma(closes, 60)
    rsi = indicators.rsi(closes)
    atr_ratio = indicators.atr(highs, lows, closes) / close
    change20 = indicators.change_rate(closes, 20)
    if close < sma60:
        return "60일선 아래"
    if not 40 <= rsi <= 75:
        return f"RSI {rsi:.0f}"
    if not 0.015 <= atr_ratio <= 0.08:
        return f"ATR 비율 {atr_ratio:.1%}"
    points = (20 if close > sma20 else 0) + (20 if sma20 > sma60 else 0)
    points += 20 * min(max(change20, 0) / 0.25, 1)
    points += 20 * max(0, 1 - abs(rsi - 55) / 20)
    points += 20 * max(0, 1 - abs(atr_ratio - 0.035) / 0.035)
    return Pick(symbol, name, round(points, 1), close, rsi, atr_ratio, change20, trading_amount)
