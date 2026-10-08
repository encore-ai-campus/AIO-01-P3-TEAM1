"""추천 수치와 리스크 미리 보기 (docs/DECISIONS.md 12-3·14-1). 판단은 엔진 리스크 엔진(judge/risk.assess)이 한다.

수치(손익비·기대수익률)는 assess와 같은 비용 계산(수수료·거래세·손절 미끄러짐)으로 만든다. 상수는 엔진에서 가져온다.

evaluate(RiskPreview)는 **장마감 기준**이다 (docs/API.md 공통 규칙 "장마감 기준"): lastPrice·price_passed는 직전 정규장 종가,
자산은 trading.service.summary(장마감 기준 평가). 화면에 보인 수량이 그대로 활성화 수량이 된다.
- live_check(활성화): 그 시장이 정규장 중이면 장중 확인 가격으로 목표가·손절가를 한 번 더 본다 (문장에 장중 가격 숫자를 넣지 않는다).
- plan(재주문 점검): 엔진 내부 경로라 지금처럼 장중이다 (docs/API.md "AI 추천" 재주문, docs/DECISIONS.md 14-1) — 수량을 정하는 자산은
  보유를 장중 가격으로 평가한 값, 가격 점검은 장중 확인 가격으로만 한다 (문장은 활성화와 같다. 화면·문장에 장중 숫자를 내지 않는다).
사유(reasons)마다 같은 자리에 사유 코드(reasonCodes)를 둔다 — 엔진 RiskAssessment.codes + 여기 코드 (docs/API.md "실행 불가 사유 코드").
blocked_by(Recommendation.blockedBy)는 그중 계좌와 무관한 코드만 같은 assess·is_open으로 낸다 (목록·상세에서 미리 보이는 용도 — 최종 판단은 evaluate).
"""
import math
from datetime import datetime

from django.utils import timezone
from paper_engine.judge.risk import MIN_FRACTIONAL_AMOUNT, SELL_TAX_RATE, STOP_LIMIT_BUFFER, AccountContext, assess
from paper_engine.judge.scenario import Scenario
from paper_engine.records import account as paper_account
from paper_engine.records.account import EXIT_WATCHING, FxUnavailable
from trading import market as market_data
from trading import service
from trading.models import SWING, PaperOrder
from trading.service import ACTIVE
from trading.store import KST, AccountStore, account_for

from config import engine
from config.api import Unavailable

from .models import Recommendation, TradePlan
from .text import money

BUDGET = "예산"
CLOSE_BASIS = "close"  # RiskPreview.priceBasis
ASSUMED_PROBABILITY = 0.5
ACCOUNT_FREE = ("reward_risk_low", "ev_negative")  # assess 사유 중 계좌와 무관한 것 (Recommendation.blockedBy)

# 사유 문장 (사람이 읽는 원문 — 화면은 코드로 쉬운 문장을 고른다). 장중 가격 숫자는 넣지 않는다 (docs/API.md 공통 규칙 표)
EXPIRED = "추천의 활성화 기한이 지남"
PLAN_EXISTS = "같은 종목에 진행 중인 내 계획이 있음"
POSITION_EXISTS = "같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만)"
HALTED = "중단 스위치가 켜져 있음 (새 모의 매수 중단)"
LIVE_ABOVE_TARGET = "장중 가격이 이미 목표가 이상이에요"
LIVE_BELOW_STOP = "장중 가격이 이미 손절가 이하예요"


def _per_share(entry: float, target: float, stop: float, market_: str) -> tuple[float, float, float]:
    """(수수료율, 1주 이익, 1주 손실) — judge/risk.assess와 같은 식."""
    commission = engine.engine_config().commission[market_]
    sell_cost = commission + SELL_TAX_RATE[market_]
    gain = target * (1 - sell_cost) - entry * (1 + commission)
    loss = entry * (1 + commission) - stop * (1 - STOP_LIMIT_BUFFER) * (1 - sell_cost)
    return commission, gain, loss


def metrics(entry: float, target: float, stop: float, probability: float, market_: str) -> dict:
    """targetReturn · stopLossRate · rewardRisk · expectedReturn."""
    _, gain, loss = _per_share(entry, target, stop, market_)
    return {"targetReturn": target / entry - 1, "stopLossRate": stop / entry - 1,
            "rewardRisk": gain / loss, "expectedReturn": (probability * gain - (1 - probability) * loss) / entry}


def target_for(entry: float, stop: float, reward_risk: float, market_: str) -> float:
    """비용 반영 손익비가 reward_risk가 되는 목표가 (호가 단위로 맞추기 전)."""
    commission, _, loss = _per_share(entry, entry, stop, market_)
    sell_cost = commission + SELL_TAX_RATE[market_]
    return (entry * (1 + commission) + reward_risk * loss) / (1 - sell_cost)


def is_open(rec: Recommendation, now: datetime) -> bool:
    return rec.status == Recommendation.OPEN and now < rec.valid_until


def _scenario(symbol: str, currency: str, entry: float, target: float, stop: float, probability: float,
              holding_days: int) -> Scenario:
    """리스크 엔진에 넘기는 스윙 시나리오 (evaluate와 blocked_by가 같이 쓴다)."""
    return Scenario(symbol=symbol, currency=currency, horizon="SWING", entry_price=entry, target_price=target,
                    stop_price=stop, probability=probability, holding_days=holding_days)


def blocked_by(rec: Recommendation, now: datetime | None = None) -> list[str]:
    """Recommendation.blockedBy: 계좌와 무관하게 지금 활성화를 막는 사유 코드 (docs/API.md Recommendation, DECISIONS 23장).

    halted(중단 스위치)도 evaluate와 같은 파일로 본다. reward_risk_low·ev_negative는 미리 보기(evaluate)와 같은 assess로 낸다 — 계좌 값과 무관한 코드만 골라 쓰므로 계좌는 빈 값으로 둔다.
    expired는 evaluate의 rec_open과 같은 is_open. 순서는 미리 보기 reasonCodes 안의 순서와 같다. 비어 있어도 내 계좌 사정으로 막힐 수 있다.
    """
    now = now or timezone.now()
    commission = engine.engine_config().commission[rec.market]
    scenario = _scenario(rec.symbol, rec.currency, rec.entry_price, rec.target_price, rec.stop_price,
                         rec.probability, rec.holding_days)
    a = assess(scenario, AccountContext(equity_krw=0.0, buying_power=0.0, commission_rate=commission))
    codes = [code for code in a.codes if code in ACCOUNT_FREE]
    if not is_open(rec, now):
        codes.append("expired")
    if engine.HALT_FILE.exists():  # 중단 스위치는 계좌와 무관하게 모두를 막는다 (리뷰 R-7)
        codes.append("halted")
    return codes


def _fx(currency: str) -> float:
    if currency == "KRW":
        return 1.0
    rate = market_data.fx_rate()
    if not rate:
        raise Unavailable("환율을 조회하지 못해 달러 종목의 수량을 계산할 수 없습니다.")
    return rate


def _invested_krw(store: AccountStore) -> float:
    """자동 관리 금액 (총 금액 한도용, 엔진 records.account.invested_krw)."""
    try:
        return paper_account.invested_krw(store, service.fx_if_needed(store))
    except FxUnavailable as e:
        raise Unavailable(str(e)) from None


def _close(symbol: str) -> dict | None:
    """직전 정규장 종가 {"price", "prevClose", "date", "asOf"} (trading.market.closes). 받지 못하면 None."""
    try:
        return market_data.closes([symbol]).get(symbol)
    except Unavailable:
        return None


def _live_price(symbol: str) -> float | None:
    """장중 확인 가격 (내부 점검 전용 — 화면·문장에 숫자로 내지 않는다). 받지 못하면 None."""
    try:
        return market_data.last_price(symbol)
    except Unavailable:
        return None


def _intraday_summary(store: AccountStore) -> dict:
    """재주문 점검의 계좌 평가: 보유를 장중 가격(market.current_prices)으로 평가한 엔진 records.account.summary (내부 경로 전용).

    가격을 받지 못한 보유는 체결가로 평가한다 (엔진 account.summary 방식 — trading.service.summary가 종가를 못 받을 때와 같다).
    """
    held = sorted({r["symbol"] for r in store.paper_orders((EXIT_WATCHING,))})
    try:
        prices = market_data.current_prices(held) if held else {}
    except Unavailable:
        prices = {}
    return paper_account.summary(store, prices, service.fx_if_needed(store), engine.engine_config().commission)


def _is_open(market_: str, now: datetime) -> bool:
    try:
        return market_data.is_open(market_, now)
    except Unavailable:
        return False


def _close_passed(close: float, target: float, stop: float, currency: str) -> str | None:
    """종가로 본 price_passed 문장 (종가 숫자는 넣어도 된다). 지나지 않았으면 None."""
    if close >= target:
        return f"직전 종가({money(close, currency)})가 이미 목표가 이상"
    if close <= stop:
        return f"직전 종가({money(close, currency)})가 이미 손절가 이하"
    return None


def _live_passed(live: float | None, target: float, stop: float) -> str | None:
    """장중 확인 가격으로 본 price_passed 정해진 문장 (숫자 없음). 지나지 않았거나 가격이 없으면 None."""
    if live is None:
        return None
    if live >= target:
        return LIVE_ABOVE_TARGET
    if live <= stop:
        return LIVE_BELOW_STOP
    return None


def evaluate(user, *, symbol: str, name: str, market: str, currency: str, entry: float, target: float, stop: float,
             holding_days: int, budget_krw: float | None = None,
             now: datetime | None = None, plan: TradePlan | None = None, live_check: bool = False,
             probability: float = ASSUMED_PROBABILITY, rec_open: bool = True) -> dict:
    """RiskPreview: 리스크 엔진이 user의 모의 계좌로 계산한 결과 (장마감 기준). name은 문장용 (지금은 쓰지 않는다).

    엔진 LIMITS는 SWING이고, 하루 주문 수·손실은 스윙(style swing) 주문만 센다.
    plan: 그 계획의 재주문 점검이다 — 추천이 open인지·진행 중 계획은 보지 않고, 그 계획의 주문은 빼고 보며, 수량을 정하는 자산은
      보유를 장중 가격으로 평가하고(_intraday_summary) 가격 점검은 장중 확인 가격으로 한다 (재주문은 지금처럼 장중).
    live_check: 활성화 점검 — 종가 점검에 더해 정규장 중이면 장중 확인 가격으로 목표가·손절가를 한 번 더 본다.
    probability: 손익비 외 기대값 계산의 확률 (추천 값. 없으면 0.5 가정). rec_open: 추천이 아직 open인지 (아니면 expired).
    반환: approved · activatable · reasons · reasonCodes(같은 길이·순서, (코드, 문장) 짝 중복 없음) · quantity · amountKrw ·
      expectedProfitKrw · maxLossKrw · limitedBy · budgetKrw · lastPrice(종가) · lastPriceAsOf · priceBasis("close").
    """
    now = now or timezone.now()
    account = account_for(user)
    store = AccountStore(account)
    fx = _fx(currency)
    # 자산: 미리 보기·활성화는 장마감 기준 평가(trading.service), 재주문 점검은 장중 평가
    s = _intraday_summary(store) if plan is not None else service.summary(account, now)
    power = s["buyingPowerKrw"] if s["buyingPowerKrw"] is not None else 0.0
    trades_today, loss_today = store.paper_today(f"{now.astimezone(KST).date()}", style=SWING)
    cfg = engine.engine_config()
    ctx = AccountContext(
        equity_krw=s["equityKrw"], buying_power=max(power, 0.0) / fx, commission_rate=cfg.commission[market],
        fx_rate=fx, daily_loss_krw=loss_today, daily_trades=trades_today, warnings=market_data.warnings(symbol),
        invested_krw=_invested_krw(store),
        max_total_krw=cfg.max_total_invest_krw)
    a = assess(_scenario(symbol, currency, entry, target, stop, probability, holding_days), ctx,
               fractional=(market == "US"))
    pairs = list(zip(a.codes, a.reasons))
    quantity, limited_by = a.quantity, a.limited_by
    if budget_krw is not None:
        unit = entry * (1 + cfg.commission[market]) * fx  # 1주 매수 비용 (원화)
        us = market == "US"  # 미국 종목은 소수점 매수: 예산을 금액(센트 내림)으로 바꿔 수량을 정한다
        amount = math.floor(budget_krw / unit * entry * 100) / 100 if us else None
        cap = amount / entry if us else math.floor(budget_krw / unit)
        if cap < quantity:
            quantity, limited_by = cap, BUDGET
            if us and amount < MIN_FRACTIONAL_AMOUNT:
                pairs.append(("budget_too_small", f"예산 {budget_krw:,.0f}원으로 줄인 매수 금액(${amount:,.2f})이 "
                                                  f"최소 주문 금액 ${MIN_FRACTIONAL_AMOUNT:g}보다 적음"))
            elif not us and quantity < 1:
                pairs.append(("budget_too_small", f"예산 {budget_krw:,.0f}원으로는 1주도 살 수 없음"))
    ratio = quantity / a.quantity if a.quantity else 0.0

    if plan is None:
        if not rec_open:
            pairs.append(("expired", EXPIRED))
        if TradePlan.objects.filter(user=user, symbol=symbol, status__in=TradePlan.LIVE).exists():
            pairs.append(("plan_exists", PLAN_EXISTS))
    orders = PaperOrder.objects.filter(account=account, symbol=symbol, status__in=ACTIVE)
    if plan is not None:
        orders = orders.exclude(requested_by=f"plan:{plan.id}")
    if orders.exists():
        pairs.append(("position_exists", POSITION_EXISTS))
    if engine.HALT_FILE.exists():
        pairs.append(("halted", HALTED))

    close = _close(symbol)
    if plan is not None:  # 재주문: 장중 확인 가격으로만
        passed = _live_passed(_live_price(symbol), target, stop)
    else:
        passed = _close_passed(close["price"], target, stop, currency) if close else None
        if passed is None and live_check and _is_open(market, now):
            passed = _live_passed(_live_price(symbol), target, stop)
    if passed:
        pairs.append(("price_passed", passed))

    pairs = list(dict.fromkeys(pairs))
    return {
        "approved": a.approved, "activatable": not pairs,
        "reasons": [text for _, text in pairs], "reasonCodes": [code for code, _ in pairs],
        "quantity": quantity, "amountKrw": a.amount * ratio * fx,
        "expectedProfitKrw": a.expected_profit * ratio * fx, "maxLossKrw": a.max_loss * ratio * fx,
        "limitedBy": limited_by, "budgetKrw": budget_krw,
        "lastPrice": close["price"] if close else None, "lastPriceAsOf": close["asOf"] if close else None,
        "priceBasis": CLOSE_BASIS,
    }


def preview(rec: Recommendation, user, budget_krw: float | None = None, now: datetime | None = None,
            plan: TradePlan | None = None, live_check: bool = False) -> dict:
    """추천 하나의 RiskPreview (evaluate를 감싼다). plan을 주면 그 계획의 재주문 점검, live_check는 활성화 점검."""
    now = now or timezone.now()
    return evaluate(user, symbol=rec.symbol, name=rec.name, market=rec.market, currency=rec.currency,
                    entry=rec.entry_price, target=rec.target_price, stop=rec.stop_price,
                    holding_days=rec.holding_days, budget_krw=budget_krw, now=now, plan=plan,
                    live_check=live_check, probability=rec.probability, rec_open=is_open(rec, now))
