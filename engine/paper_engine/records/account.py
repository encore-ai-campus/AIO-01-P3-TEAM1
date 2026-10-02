"""모의 계좌 계산 (docs/DECISIONS.md 4-2). 기록 저장소의 값과 호출하는 쪽이 준 가격·환율만으로 계산한다.

- 평가액 = 현금 + 보유 평가액 (보유 수량 × 확인 가격 × 현재 환율). 가격이 없는 종목은 체결가로 평가한다.
- 매수 가능액 = 현금 − 대기 매수 금액 (ENTRY_PENDING의 수량 × 지정가(시장가는 진입가) × 환율 × (1 + 수수료율)).
  backtest/sim.py와 같은 방식이다.
- 환율(fx_rate)은 달러 1의 원화 가치. 원화 종목만 있으면 필요 없다 (None이어도 된다).
  달러 종목이 있는데 환율이 없으면 가장 최근 달러 체결 환율을 쓰고, 그것도 없으면 FxUnavailable.
"""
from .store import Store

ENTRY_PENDING, EXIT_WATCHING, CLOSED, CANCELED = "ENTRY_PENDING", "EXIT_WATCHING", "CLOSED", "CANCELED"
ACTIVE = (ENTRY_PENDING, EXIT_WATCHING)
MARKET_OF = {"KRW": "KR", "USD": "US"}


class FxUnavailable(Exception):
    """달러 종목을 원화로 바꿀 환율이 없음."""


def fx_for(store: Store, currency: str, fx_rate: float | None) -> float:
    """종목 통화 1단위의 원화 가치."""
    if currency == "KRW":
        return 1.0
    rate = fx_rate or store.last_fx_rate(currency)
    if not rate:
        raise FxUnavailable("환율을 조회하지 못했고 이전 달러 체결도 없어 원화로 환산할 수 없음")
    return rate


def pending_krw(store: Store, fx_rate: float | None, rates: dict[str, float]) -> float:
    """대기 매수 금액 합계 (원화, 수수료 포함)."""
    total = 0.0
    for r in store.paper_orders((ENTRY_PENDING,)):
        price = r["limit_price"] if r["limit_price"] is not None else r["entry_price"]
        total += r["quantity"] * price * fx_for(store, r["currency"], fx_rate) * (1 + rates[r["market"]])
    return total


def buying_power_krw(store: Store, fx_rate: float | None, rates: dict[str, float]) -> float:
    return store.account()["cash_krw"] - pending_krw(store, fx_rate, rates)


def holdings(store: Store, prices: dict[str, float], fx_rate: float | None) -> list[dict]:
    """보유 포지션 (EXIT_WATCHING) 평가. prices에 없는 종목은 체결가로, 환율이 없으면 체결 환율로 평가한다."""
    out = []
    for r in store.paper_orders((EXIT_WATCHING,)):
        last = prices.get(r["symbol"])
        price = last if last is not None else r["fill_price"]
        fx = 1.0 if r["currency"] == "KRW" else (fx_rate or r["fill_fx_rate"])
        qty = r["filled_quantity"]
        cost = qty * r["fill_price"]
        out.append({
            "id": r["id"], "symbol": r["symbol"], "name": r["name"], "market": r["market"],
            "currency": r["currency"], "quantity": qty, "fillPrice": r["fill_price"], "lastPrice": last,
            "priced": last is not None, "value": qty * price, "valueKrw": qty * price * fx, "fxRate": fx,
            "unrealized": qty * price - cost, "unrealizedRate": price / r["fill_price"] - 1 if r["fill_price"] else None,
            "target": r["target_price"], "stop": r["stop_price"], "expireDate": r["expire_date"],
            "filledAt": r["filled_at"], "requestedBy": r["requested_by"]})
    return out


def invested_krw(store: Store, fx_rate: float | None) -> float:
    """자동 관리 금액: 보유 포지션(체결 금액)과 대기 주문(주문 금액)의 합계 (원화). 총 금액 한도에 쓴다."""
    total = 0.0
    for r in store.paper_orders(ACTIVE):
        if r["status"] == EXIT_WATCHING:
            amount = r["filled_quantity"] * r["fill_price"]
            fx = 1.0 if r["currency"] == "KRW" else (fx_rate or r["fill_fx_rate"])
        else:
            amount = r["quantity"] * (r["limit_price"] if r["limit_price"] is not None else r["entry_price"])
            fx = fx_for(store, r["currency"], fx_rate)
        total += amount * fx
    return total


def summary(store: Store, prices: dict[str, float], fx_rate: float | None, rates: dict[str, float]) -> dict:
    """계좌 요약. 대기 금액을 환산하지 못하면 매수 가능액은 None이고 notes에 사유를 남긴다."""
    acc = store.account()
    items = holdings(store, prices, fx_rate)
    value = sum(h["valueKrw"] for h in items)
    equity = acc["cash_krw"] + value
    notes = []
    unpriced = [h["symbol"] for h in items if not h["priced"]]
    if unpriced:
        notes.append(f"현재가를 받지 못해 체결가로 평가: {', '.join(unpriced)}")
    if fx_rate is None and any(h["currency"] != "KRW" for h in items):
        notes.append("환율을 조회하지 못해 달러 종목은 체결 환율로 평가")
    try:
        pending = pending_krw(store, fx_rate, rates)
    except FxUnavailable as e:
        pending = None
        notes.append(str(e))
    initial = acc["initial_capital_krw"]
    return {"name": acc["name"], "initialCapitalKrw": initial, "cashKrw": acc["cash_krw"],
            "holdingsValueKrw": value, "equityKrw": equity, "profitKrw": equity - initial,
            "profitRate": equity / initial - 1 if initial else None, "pendingKrw": pending,
            "buyingPowerKrw": None if pending is None else acc["cash_krw"] - pending,
            "usdKrw": fx_rate, "holdings": items, "notes": notes}
