"""추천 수치와 리스크 미리 보기 (docs/DECISIONS.md 12-3·14-1·28). 판단은 엔진 리스크 엔진(judge/risk.assess_budget)이 한다.

수치(손익비·기대수익률)는 assess와 같은 비용 계산(수수료·거래세·손절 미끄러짐)으로 만든다. 상수는 엔진에서 가져온다.

넣을 돈은 사용자가 정한다 (2026-10-11, docs/API.md "넣을 돈"): budget_percent(매수 가능 금액의 %, 원 단위로 내림) 또는 budget_krw(원).
수량 = 금액 ÷ 1주 매수 비용(진입가 × (1 + 수수료) × 환율) — assess_budget이 계산하고, 매수 가능 금액·총 금액 한도는 줄이지 않고 점검만 한다
(cash_short·total_limit). 건당 위험 한도(LIMITS SWING risk_per_trade)는 수량을 정하지 않고 큰 손실 경고(largeLoss)의 기준으로만 쓴다.
금액이 없으면 크기 계산 없이 점검만 한다 (화면 머리 칩 — quantity 0, limitedBy None).

evaluate(RiskPreview)는 **장마감 기준**이다 (docs/API.md 공통 규칙 "장마감 기준"): lastPrice는 직전 정규장 종가,
자산은 trading.service.summary(장마감 기준 평가). 수량은 진입가로 계산하므로 화면에 보인 수량이 그대로 활성화 수량이 된다.
- price_passed(목표가·손절가를 이미 지났는지): 기준일 뒤 정규장이 시작됐으면(장 중 — market.traded_since_basis) 종가는 지난 가격이라
  장중 가격으로 본다 — 미리 보기는 현재가(실시간 시세와 같은 값), live_check(활성화)는 장중 확인 가격. 문장에 장중 가격 숫자를 넣지 않는다.
  받지 못하거나 장 중이 아니면 직전 종가로 본다 (docs/API.md "리포트 시세", DECISIONS 26 — 리포트의 손절·목표가가 장중 가격 기준이다).
- plan(재주문 점검): 엔진 내부 경로라 지금처럼 장중이다 (docs/API.md "AI 추천" 재주문, docs/DECISIONS.md 14-1) — 자산은
  보유를 장중 가격으로 평가한 값, 가격 점검은 장중 확인 가격으로만 한다 (문장은 활성화와 같다. 화면·문장에 장중 숫자를 내지 않는다).
  금액은 그 계획과 같은 수량의 매수 금액을 매수 가능 금액·총 금액 한도 안으로 줄인 값이다 (_requeue_budget — 한도 때문에 막히지 않고 줄어든다).
사유(reasons)마다 같은 자리에 사유 코드(reasonCodes)를 둔다 — 엔진 RiskAssessment.codes + 여기 코드 (docs/API.md "실행 불가 사유 코드").
blocked_by(Recommendation.blockedBy)는 그중 계좌와 무관한 코드만 같은 assess_budget·is_open으로 낸다 (목록·상세에서 미리 보이는 용도 — 최종 판단은 evaluate).

시연용 수동 시작(DECISIONS 31장): manual_start(미리 보기·활성화) 또는 plan.manual_start(재주문)면 MANUAL_SKIP_CODES 사유를 reasons/reasonCodes에서 빼
skippedReasons/skippedCodes로 옮긴다 (activatable은 남은 사유로만, approved는 리스크 엔진의 원래 판정 그대로). 엔진 assess_budget은 그대로다.
"""
import math
from datetime import datetime

from django.utils import timezone
from paper_engine.judge.risk import LIMITS, SELL_TAX_RATE, STOP_LIMIT_BUFFER, AccountContext, assess_budget
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

from ..models import Recommendation, TradePlan
from ..text import money

CLOSE_BASIS = "close"  # RiskPreview.priceBasis
ASSUMED_PROBABILITY = 0.5
ACCOUNT_FREE = ("reward_risk_low", "ev_negative")  # assess_budget 사유 중 계좌와 무관한 것 (Recommendation.blockedBy)
# 시연용 수동 시작(DECISIONS 31장)이 건너뛰는 계획 품질 사유. 지금은 ACCOUNT_FREE와 같지만 따로 둔다
# (ACCOUNT_FREE가 넓어져도 건너뛰는 범위가 저절로 넓어지지 않게). 넓히려면 docs/API.md·DECISIONS 31장을 먼저 고친다
MANUAL_SKIP_CODES = ("reward_risk_low", "ev_negative")
# 재주문 금액에 더하는 아주 작은 비율: 같은 수량의 금액 ÷ 1주 비용이 나눗셈 오차로 정수(미국은 센트)에 모자라 1주 덜 사는 것을 막는다
SAME_QUANTITY = 1e-9

# 사유 문장 (사람이 읽는 원문 — 화면은 코드로 쉬운 문장을 고른다). 장중 가격 숫자는 넣지 않는다 (docs/API.md 공통 규칙 표)
EXPIRED = "추천의 활성화 기한이 지남"
PLAN_EXISTS = "같은 종목에 진행 중인 내 계획이 있음"
POSITION_EXISTS = "같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만)"
HALTED = "중단 스위치가 켜져 있음 (새 모의 매수 중단)"
LIVE_ABOVE_TARGET = "장중 가격이 이미 목표가 이상이에요"
LIVE_BELOW_STOP = "장중 가격이 이미 손절가 이하예요"
REQUEUE_TOO_SMALL = "같은 수량을 매수 가능 금액·총 금액 한도 안으로 줄이면 1주 미만 (미국 종목은 최소 주문 금액 미만)"


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

    halted(중단 스위치)도 evaluate와 같은 파일로 본다. reward_risk_low·ev_negative는 미리 보기(evaluate)와 같은 assess_budget으로 낸다 — 계좌 값과 무관한 코드만 골라 쓰므로 계좌는 빈 값·금액 없음으로 둔다.
    expired는 evaluate의 rec_open과 같은 is_open. 순서는 미리 보기 reasonCodes 안의 순서와 같다. 비어 있어도 내 계좌 사정으로 막힐 수 있다.
    """
    now = now or timezone.now()
    commission = engine.engine_config().commission[rec.market]
    scenario = _scenario(rec.symbol, rec.currency, rec.entry_price, rec.target_price, rec.stop_price,
                         rec.probability, rec.holding_days)
    a = assess_budget(scenario, AccountContext(equity_krw=0.0, buying_power=0.0, commission_rate=commission), None)
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


def _current_price(symbol: str) -> float | None:
    """현재가 (미리 보기의 가격 점검 — 실시간 시세와 같은 1초 캐시라 요청마다 증권사를 부르지 않는다). 받지 못하면 None."""
    try:
        return market_data.current_prices([symbol]).get(symbol)
    except Unavailable:
        return None


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


def _requeue_budget(quantity: float, unit_krw: float, power_krw: float, ctx: AccountContext) -> float:
    """재주문 점검의 금액(원): 그 계획과 같은 수량의 매수 금액(1주 비용 unit_krw × 수량)을 매수 가능 금액·총 금액 한도 남은 액 안으로 줄인 값.

    한도가 모자라면 그 안으로 줄어들 뿐 cash_short·total_limit로 막히지 않는다 (docs/API.md 재주문 규칙 — 2026-10-11 전 계획도 같다).
    같은 수량의 금액에는 SAME_QUANTITY만큼 더해 둔다 (나눗셈 오차로 1주 덜 사지 않게. 한도 안으로 줄이는 것은 그 뒤다).
    """
    budget = min(quantity * unit_krw * (1 + SAME_QUANTITY), power_krw)
    if ctx.max_total_krw is not None:
        budget = min(budget, max(ctx.max_total_krw - ctx.invested_krw, 0.0))
    return budget


def evaluate(user, *, symbol: str, name: str, market: str, currency: str, entry: float, target: float, stop: float,
             holding_days: int, budget_krw: float | None = None, budget_percent: int | None = None,
             now: datetime | None = None, plan: TradePlan | None = None, live_check: bool = False,
             probability: float = ASSUMED_PROBABILITY, rec_open: bool = True, manual_start: bool = False) -> dict:
    """RiskPreview: 리스크 엔진이 user의 모의 계좌로 계산한 결과 (장마감 기준). name은 문장용 (지금은 쓰지 않는다).

    엔진 LIMITS는 SWING이고, 하루 주문 수·손실은 스윙(style swing) 주문만 센다.
    budget_percent(1~100, 매수 가능 금액의 %) 또는 budget_krw(원) 중 하나로 넣을 돈을 정한다 (둘 다 주면 ValueError, 둘 다 없으면 점검만).
      percent는 그 순간의 매수 가능 금액(음수면 0)에 곱해 원 단위로 내린다.
    plan: 그 계획의 재주문 점검이다 — 추천이 open인지·진행 중 계획은 보지 않고, 그 계획의 주문은 빼고 보며, 자산은
      보유를 장중 가격으로 평가하고(_intraday_summary) 가격 점검은 장중 확인 가격으로 한다 (재주문은 지금처럼 장중).
      금액은 budget 인자를 쓰지 않고 그 계획과 같은 수량으로 정한다 (_requeue_budget, budgetMode None).
    live_check: 활성화 점검 — 장 중(기준일 뒤 정규장이 시작됨)이면 가격 점검을 현재가가 아니라 장중 확인 가격으로 한다.
    probability: 손익비 외 기대값 계산의 확률 (추천 값. 없으면 0.5 가정). rec_open: 추천이 아직 open인지 (아니면 expired).
    manual_start: 시연용 수동 시작(DECISIONS 31장)의 미리 보기·활성화 — MANUAL_SKIP_CODES 사유를 skipped로 옮긴다.
      plan.manual_start인 계획의 재주문 점검도 같다 (인자 없이 plan으로 정한다).
    반환: approved · activatable · reasons · reasonCodes(같은 길이·순서, (코드, 문장) 짝 중복 없음) ·
      skippedReasons · skippedCodes(시연용 수동 시작으로 건너뛴 짝 — 같은 길이·순서, 일반 점검은 []) · quantity · amountKrw ·
      expectedProfitKrw · maxLossKrw · limitedBy · budgetMode · budgetPercent · budgetKrw · buyingPowerKrw · equityKrw ·
      maxLossRate · largeLoss · lastPrice(종가) · lastPriceAsOf · priceBasis("close").
    """
    if budget_krw is not None and budget_percent is not None:
        raise ValueError("budget_krw와 budget_percent 중 하나만 줍니다")
    now = now or timezone.now()
    account = account_for(user)
    store = AccountStore(account)
    fx = _fx(currency)
    # 자산: 미리 보기·활성화는 장마감 기준 평가(trading.service), 재주문 점검은 장중 평가
    s = _intraday_summary(store) if plan is not None else service.summary(account, now)
    power = max(s["buyingPowerKrw"] if s["buyingPowerKrw"] is not None else 0.0, 0.0)
    equity = s["equityKrw"]
    trades_today, loss_today = store.paper_today(f"{now.astimezone(KST).date()}", style=SWING)
    cfg = engine.engine_config()
    commission = cfg.commission[market]
    ctx = AccountContext(
        equity_krw=equity, buying_power=power / fx, commission_rate=commission,
        fx_rate=fx, daily_loss_krw=loss_today, daily_trades=trades_today, warnings=market_data.warnings(symbol),
        invested_krw=_invested_krw(store),
        max_total_krw=cfg.max_total_invest_krw)
    mode = None
    if plan is not None:
        budget_krw, budget_percent = _requeue_budget(plan.quantity, entry * (1 + commission) * fx, power, ctx), None
    elif budget_percent is not None:
        mode, budget_krw = TradePlan.PERCENT, float(math.floor(power * budget_percent / 100))
    elif budget_krw is not None:
        mode = TradePlan.AMOUNT
    a = assess_budget(_scenario(symbol, currency, entry, target, stop, probability, holding_days), ctx,
                      None if budget_krw is None else budget_krw / fx, fractional=(market == "US"))
    pairs = list(zip(a.codes, a.reasons))
    if plan is not None:  # 재주문: 금액은 사용자가 아니라 한도가 줄인 것이다
        pairs = [(code, REQUEUE_TOO_SMALL if code == "budget_too_small" else text) for code, text in pairs]

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
        # 장 중이면 직전 종가는 지난 가격이다 — 장중 가격으로 본다 (활성화는 장중 확인 가격). 받지 못하면 종가로
        live = None
        if market_data.traded_since_basis(market, now):
            live = _live_price(symbol) if live_check else _current_price(symbol)
        if live is not None:
            passed = _live_passed(live, target, stop)
        else:
            passed = _close_passed(close["price"], target, stop, currency) if close else None
    if passed:
        pairs.append(("price_passed", passed))

    pairs = list(dict.fromkeys(pairs))
    # 시연용 수동 시작: 사용자가 고른 활성화(manual_start)나 그렇게 시작한 계획의 재주문(plan.manual_start)이면
    # 계획 품질 사유만 skipped로 옮긴다. 나머지 사유는 그대로 막는다. approved는 리스크 엔진의 원래 판정 그대로다
    manual = manual_start or (plan is not None and plan.manual_start)
    skipped = [pair for pair in pairs if manual and pair[0] in MANUAL_SKIP_CODES]
    pairs = [pair for pair in pairs if pair not in skipped]
    sized = budget_krw is not None
    max_loss = a.max_loss * fx
    return {
        "approved": a.approved, "activatable": not pairs,
        "reasons": [text for _, text in pairs], "reasonCodes": [code for code, _ in pairs],
        "skippedReasons": [text for _, text in skipped], "skippedCodes": [code for code, _ in skipped],
        "quantity": a.quantity, "amountKrw": a.amount * fx,
        "expectedProfitKrw": a.expected_profit * fx, "maxLossKrw": max_loss,
        "limitedBy": a.limited_by or None,
        "budgetMode": mode, "budgetPercent": budget_percent, "budgetKrw": budget_krw,
        "buyingPowerKrw": power, "equityKrw": equity,
        "maxLossRate": max_loss / equity if sized and equity > 0 else None,
        # 손절 시 손실이 총자산의 1%(엔진 스윙 건당 위험 한도)를 넘음 — 경고만, 활성화를 막지 않는다
        "largeLoss": sized and max_loss > equity * LIMITS["SWING"].risk_per_trade,
        "lastPrice": close["price"] if close else None, "lastPriceAsOf": close["asOf"] if close else None,
        "priceBasis": CLOSE_BASIS,
    }


def preview(rec: Recommendation, user, budget_krw: float | None = None, now: datetime | None = None,
            plan: TradePlan | None = None, live_check: bool = False, budget_percent: int | None = None,
            manual_start: bool = False) -> dict:
    """추천 하나의 RiskPreview (evaluate를 감싼다). plan을 주면 그 계획의 재주문 점검, live_check는 활성화 점검.

    넣을 돈은 budget_krw(원) 또는 budget_percent(매수 가능 금액의 %) 중 하나 (없으면 점검만).
    manual_start: 시연용 수동 시작(DECISIONS 31장) — 손익비·기대값 사유만 skippedReasons·skippedCodes로 옮긴다."""
    now = now or timezone.now()
    return evaluate(user, symbol=rec.symbol, name=rec.name, market=rec.market, currency=rec.currency,
                    entry=rec.entry_price, target=rec.target_price, stop=rec.stop_price,
                    holding_days=rec.holding_days, budget_krw=budget_krw, budget_percent=budget_percent, now=now,
                    plan=plan, live_check=live_check, probability=rec.probability, rec_open=is_open(rec, now),
                    manual_start=manual_start)
