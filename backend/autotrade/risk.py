"""추천 수치와 리스크 미리 보기 (docs/DECISIONS.md 12-3). 판단은 엔진 리스크 엔진(judge/risk.assess)이 한다.

수치(손익비·기대수익률)는 assess와 같은 비용 계산(수수료·거래세·손절 미끄러짐)으로 만든다. 상수는 엔진에서 가져온다.
"""
import math
from datetime import datetime

from django.utils import timezone
from paper_engine.judge.risk import MIN_FRACTIONAL_AMOUNT, SELL_TAX_RATE, STOP_LIMIT_BUFFER, AccountContext, assess
from paper_engine.judge.scenario import Scenario
from paper_engine.records import account as paper_account
from paper_engine.records.account import FxUnavailable
from trading import market, service
from trading.models import PaperOrder
from trading.service import ACTIVE
from trading.store import KST, AccountStore, account_for

from config import engine
from config.api import Unavailable

from .models import Recommendation, TradePlan

BUDGET = "예산"


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


def _fx(currency: str) -> float:
    if currency == "KRW":
        return 1.0
    rate = market.fx_rate()
    if not rate:
        raise Unavailable("환율을 조회하지 못해 달러 종목의 수량을 계산할 수 없습니다.")
    return rate


def _invested_krw(store: AccountStore) -> float:
    """자동 관리 금액 (총 금액 한도용, 엔진 records.account.invested_krw)."""
    try:
        return paper_account.invested_krw(store, service.fx_if_needed(store))
    except FxUnavailable as e:
        raise Unavailable(str(e)) from None


def _last_price(symbol: str) -> float | None:
    try:
        return market.last_price(symbol)
    except Unavailable:
        return None


def preview(rec: Recommendation, user, budget_krw: float | None = None, now: datetime | None = None,
            plan: TradePlan | None = None) -> dict:
    """RiskPreview: 리스크 엔진이 user의 모의 계좌로 계산한 결과.

    plan을 주면 그 계획의 재주문 점검이다: 추천이 open인지와 그 계획 자신(과 그 계획의 주문)은 보지 않는다.
    """
    now = now or timezone.now()
    account = account_for(user)
    store = AccountStore(account)
    fx = _fx(rec.currency)
    s = service.summary(account, now)
    power = s["buyingPowerKrw"] if s["buyingPowerKrw"] is not None else 0.0
    trades_today, loss_today = store.paper_today(f"{now.astimezone(KST).date()}")
    cfg = engine.engine_config()
    ctx = AccountContext(
        equity_krw=s["equityKrw"], buying_power=max(power, 0.0) / fx, commission_rate=cfg.commission[rec.market],
        fx_rate=fx, daily_loss_krw=loss_today, daily_trades=trades_today, warnings=market.warnings(rec.symbol),
        invested_krw=_invested_krw(store),
        max_total_krw=cfg.max_total_invest_krw)
    scenario = Scenario(symbol=rec.symbol, currency=rec.currency, horizon="SWING", entry_price=rec.entry_price,
                        target_price=rec.target_price, stop_price=rec.stop_price, probability=rec.probability,
                        holding_days=rec.holding_days)
    a = assess(scenario, ctx, fractional=(rec.market == "US"))
    reasons = list(a.reasons)
    quantity, limited_by = a.quantity, a.limited_by
    if budget_krw is not None:
        unit = rec.entry_price * (1 + cfg.commission[rec.market]) * fx  # 1주 매수 비용 (원화)
        us = rec.market == "US"  # 미국 종목은 소수점 매수: 예산을 금액(센트 내림)으로 바꿔 수량을 정한다
        amount = math.floor(budget_krw / unit * rec.entry_price * 100) / 100 if us else None
        cap = amount / rec.entry_price if us else math.floor(budget_krw / unit)
        if cap < quantity:
            quantity, limited_by = cap, BUDGET
            if us and amount < MIN_FRACTIONAL_AMOUNT:
                reasons.append(f"예산 {budget_krw:,.0f}원으로 줄인 매수 금액 ${amount:,.2f}이(가) "
                               f"최소 주문 금액 ${MIN_FRACTIONAL_AMOUNT:g}보다 적음")
            elif not us and quantity < 1:
                reasons.append(f"예산 {budget_krw:,.0f}원으로는 1주도 살 수 없음")
    ratio = quantity / a.quantity if a.quantity else 0.0

    if plan is None:
        if not is_open(rec, now):
            reasons.append("추천의 활성화 기한이 지남")
        if TradePlan.objects.filter(user=user, symbol=rec.symbol, status__in=TradePlan.LIVE).exists():
            reasons.append("같은 종목에 진행 중인 내 계획이 있음")
    orders = PaperOrder.objects.filter(account=account, symbol=rec.symbol, status__in=ACTIVE)
    if plan is not None:
        orders = orders.exclude(requested_by=f"plan:{plan.id}")
    if orders.exists():
        reasons.append("같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만)")
    if engine.HALT_FILE.exists():
        reasons.append("중단 스위치가 켜져 있음 (새 모의 매수 중단)")
    last = _last_price(rec.symbol)
    if last is not None and last >= rec.target_price:
        reasons.append(f"이미 목표가에 도달 (지금 {last:,g})")
    elif last is not None and last <= rec.stop_price:
        reasons.append(f"이미 손절가 이하 (지금 {last:,g})")

    reasons = list(dict.fromkeys(reasons))
    return {
        "approved": a.approved, "activatable": not reasons, "reasons": reasons,
        "quantity": quantity, "amountKrw": a.amount * ratio * fx,
        "expectedProfitKrw": a.expected_profit * ratio * fx, "maxLossKrw": a.max_loss * ratio * fx,
        "limitedBy": limited_by, "budgetKrw": budget_krw, "lastPrice": last,
    }
