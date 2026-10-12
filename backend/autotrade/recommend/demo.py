"""시연용 규칙 추천 — AI가 아니다 (docs/DECISIONS.md 12-1). AI 리포트가 준비되기 전에도 추천 → 활성화 → 자동매매 → 알림을 끝까지 시연한다.

진입가 = 직전 정규장 종가(호가 단위로 내림), 손절가 = 진입가 − 1.5 × ATR14(완성 일봉), 목표가 = 비용 반영 손익비가 2.4가 되는 값
(호가 단위로 올림), 보유 10거래일, 확률 0.45(가정). 손익비가 리스크 엔진 기준(스윙 1.5)보다 커서 늘 리스크 엔진을 통과한다.
가격과 일봉은 장마감 기준이다 (docs/API.md 공통 규칙 "장마감 기준" — 장중에도 오늘 미완성 봉을 쓰지 않는다).
화면 표기는 "연습용 예시 계획 (AI 아님)" (D-4).
"""
from datetime import datetime

from analysis.quota import today_start
from django.utils import timezone
from paper_engine.data.indicators import atr, change_rate, rsi, sma
from paper_engine.data.ticks import round_price
from rest_framework.exceptions import PermissionDenied
from trading import market

from config.api import LimitExceeded, Rejected

from .. import conf
from ..plans import risk
from . import sources
from ..models import Recommendation
from ..text import money, pct

DEMO_SYMBOLS = ("005930", "000660", "035420", "005380", "051910", "035720")
STOP_ATR, REWARD_RISK, HOLDING_DAYS, PROBABILITY = 1.5, 2.4, 10, 0.45
ATR_PERIOD = 14
NOT_AI = "규칙으로 만든 연습용 예시 계획이며 AI 분석이 아님"


def _pick(today) -> dict:
    """시연 목록에서 오늘 시연 추천이 아직 없는 첫 종목 (종목 목록에 없는 것은 건너뛴다)."""
    known = market.directory()
    used = set(Recommendation.objects.filter(source=Recommendation.DEMO, created_at__gte=today)
               .values_list("symbol", flat=True))
    for symbol in DEMO_SYMBOLS:
        if symbol in known and symbol not in used:
            return known[symbol]
    raise Rejected("오늘 시연할 종목이 남지 않았습니다. 종목을 지정하세요.")


def _facts(closes: list[float], entry: float, atr_value: float, currency: str) -> list[str]:
    """지표 사실 (판단이 아니라 숫자). 계산할 수 있는 것만."""
    out = []
    average = sma(closes, 20)
    if average:
        out.append(f"20일 이동평균 {money(average, currency)} 대비 {pct(closes[-1] / average - 1)}")
    strength = rsi(closes, 14)
    if strength is not None:
        out.append(f"RSI(14) {strength:.0f}")
    change = change_rate(closes, 5)
    if change is not None:
        out.append(f"최근 5거래일 {pct(change)}")
    out.append(f"ATR(14) {money(atr_value, currency)} (진입가의 {atr_value / entry:.1%})")
    return out[:3]


def recommend(user, symbol: str | None = None, now: datetime | None = None) -> Recommendation:
    """시연 추천을 만들고 알린다. user가 None이면(관리 명령) 하루 한도를 보지 않고 팀 전체에 알린다."""
    now = now or timezone.now()
    if not conf.demo_enabled():
        raise PermissionDenied("시연 추천이 꺼져 있습니다 (AUTOTRADE_DEMO=off).")
    today = today_start(now)
    if user is not None:
        limit = conf.demo_per_user()
        used = Recommendation.objects.filter(source=Recommendation.DEMO, requested_by=user,
                                             created_at__gte=today).count()
        if used >= limit:
            raise LimitExceeded(f"오늘 시연 추천 한도({limit}회)를 모두 썼습니다.")
    if symbol:
        item = market.stock_item(symbol)
        if item is None:
            raise Rejected(f"'{symbol}' 종목을 찾을 수 없음")
    else:
        item = _pick(today)
    symbol, name, mkt = item["symbol"], item["name"], item["market"]
    currency = market.CURRENCY[mkt]

    candles = market.completed_candles(symbol)  # 기준일 이하 완성 봉만
    try:
        highs = [float(c["highPrice"]) for c in candles]
        lows = [float(c["lowPrice"]) for c in candles]
        closes = [float(c["closePrice"]) for c in candles]
    except (KeyError, TypeError, ValueError):
        raise Rejected(f"{name}({symbol}) 일봉을 읽지 못함") from None
    atr_value = atr(highs, lows, closes, ATR_PERIOD)
    if not atr_value:
        raise Rejected(f"{name}({symbol}) 일봉이 부족해 시연 추천을 만들 수 없음 ({len(candles)}개, "
                       f"{ATR_PERIOD + 1}개 이상 필요)")
    price = closes[-1]  # 직전 정규장 종가 (완성 봉의 마지막 = market.close_price)
    entry = float(round_price(price, currency))
    stop = float(round_price(entry - STOP_ATR * atr_value, currency))
    if not 0 < stop < entry:
        raise Rejected(f"{name}({symbol}) 변동성이 너무 커서 손절가를 정할 수 없음")
    target = float(round_price(risk.target_for(entry, stop, REWARD_RISK, mkt), currency, up=True))
    summary = (f"연습용 예시 계획 (AI 아님): 진입 {money(entry, currency)} · 목표 {money(target, currency)} · "
               f"손절 {money(stop, currency)} (손절 ATR {STOP_ATR:g}배, 비용 반영 손익비 {REWARD_RISK:g}, 진입가는 직전 종가)")
    risks = [NOT_AI, f"손절가를 ATR {STOP_ATR:g}배로 기계적으로 정함 (변동성이 커지면 바로 손절될 수 있음)",
             f"확률 {PROBABILITY:.0%}는 예측이 아니라 가정한 값"]
    try:
        return sources.create(Recommendation.DEMO, symbol=symbol, name=name, market_=mkt, entry=entry, target=target,
                              stop=stop, holding_days=HOLDING_DAYS, probability=PROBABILITY, probability_assumed=True,
                              summary=summary, reasons=_facts(closes, entry, atr_value, currency), risks=risks,
                              requested_by=user, price_at_creation=price, now=now)
    except ValueError as e:
        raise Rejected(f"시연 추천을 만들 수 없음: {e}") from None
