"""assess_budget: 사용자가 정한 금액으로 수량을 계산하고 한도는 점검만 한다 (docs/API.md "넣을 돈", DECISIONS 28장 — 2026-10-11).

크기와 무관한 점검은 assess와 같고(같은 문장·순서), 건당 위험 한도는 수량을 정하지도 줄이지도 않는다.
"""
import pytest

from paper_engine.judge.risk import (BUDGET_LIMITED, LIMITS, MIN_FRACTIONAL_AMOUNT, AccountContext, assess,
                                     assess_budget, assess_position)
from paper_engine.judge.scenario import Scenario


def scenario(**kw):
    base = dict(symbol="005930", currency="KRW", horizon="SWING", entry_price=100_000,
                target_price=115_000, stop_price=95_000, probability=0.5, holding_days=10)
    return Scenario(**{**base, **kw})


def usd(**kw):
    return scenario(**{"symbol": "AAPL", "currency": "USD", "entry_price": 190, "target_price": 230,
                       "stop_price": 180, **kw})


def account(**kw):
    base = dict(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0)
    return AccountContext(**{**base, **kw})


def test_quantity_is_budget_over_unit_cost_floor():
    # 1주 비용 100,000 × 1.001 = 100,100원 → 1,000,000원 ÷ 100,100 = 9.99 → 9주
    r = assess_budget(scenario(), account(commission_rate=0.001), 1_000_000)
    assert r.approved and r.codes == [] and r.quantity == 9 and r.amount == 900_000
    assert r.limited_by == BUDGET_LIMITED == "내가 정한 금액" and not r.fractional


def test_risk_per_trade_does_not_cap_quantity():
    s = scenario(stop_price=90_000, target_price=125_000)
    assert assess(s, account()).quantity == 9  # 건당 위험 한도 (자산 1%)
    r = assess_budget(s, account(), 10_000_000)
    assert r.approved and r.quantity == 100  # 금액이 정한다
    assert r.max_loss > account().equity_krw * LIMITS["SWING"].risk_per_trade  # 큰 손실 — 막지 않는다 (경고는 화면)
    assert r.expected_profit == pytest.approx(100 * (125_000 * 0.998 - 100_000))


def test_cash_short_blocks_without_shrinking():
    r = assess_budget(scenario(), account(buying_power=500_000), 1_000_000)
    assert not r.approved and r.codes == ["cash_short"] and r.quantity == 10  # 줄이지 않는다
    assert r.reasons == ["매수 금액 1,000,000이 매수 가능 금액 500,000보다 큼"]


def test_cash_short_includes_commission():
    a = account(buying_power=1_000_000, commission_rate=0.001)
    assert assess_budget(scenario(), a, 1_000_000).approved  # 9주 = 900,900
    r = assess_budget(scenario(), account(buying_power=900_000, commission_rate=0.001), 1_000_000)
    assert r.codes == ["cash_short"] and r.reasons == ["매수 금액 900,900이 매수 가능 금액 900,000보다 큼"]


def test_total_limit_in_krw_blocks_without_shrinking():
    r = assess_budget(scenario(), account(max_total_krw=2_000_000, invested_krw=1_500_000), 1_000_000)
    assert not r.approved and r.codes == ["total_limit"] and r.quantity == 10
    assert r.reasons == ["총 금액 한도 2,000,000원을 넘음 (남은 한도 500,000원)"]
    # 미국: 매수 금액(달러) × 환율로 비교한다
    r = assess_budget(usd(), account(buying_power=10_000, fx_rate=1_400, max_total_krw=1_400_000), 1_000,
                      fractional=True)
    assert r.approved and r.amount == 1_000  # $1,000 × 1,400 = 한도와 같다
    r = assess_budget(usd(), account(buying_power=10_000, fx_rate=1_400, max_total_krw=1_400_000), 1_000.5,
                      fractional=True)
    assert r.codes == ["total_limit"] and r.amount == 1_000.5


def test_position_limit_when_set():
    s = scenario(horizon="LONG_TERM", target_price=130_000)  # LONG_TERM 종목당 비중 한도 100%
    r = assess_budget(s, account(buying_power=20_000_000, position_value=5_000_000), 6_000_000)
    assert r.codes == ["position_limit"] and r.reasons == ["종목당 비중 한도(100%)를 넘음"] and r.quantity == 60


def test_budget_too_small_kr():
    r = assess_budget(scenario(), account(buying_power=0.0), 99_999)
    assert not r.approved and r.codes == ["budget_too_small"] and r.quantity == 0 and r.amount == 0
    assert r.reasons == ["내가 정한 금액(99,999원)으로는 1주도 살 수 없음"]  # 살 수량이 없으면 현금 점검은 하지 않는다
    assert "size_too_small" not in r.codes


def test_fractional_amount_is_floored_to_cents():
    # $600 ÷ 1.002 = $598.80… → $598.80, 수량 = $598.80 ÷ $190 (정수 주로 내리지 않는다)
    r = assess_budget(usd(), account(buying_power=1_000, fx_rate=1_400, commission_rate=0.002), 600, fractional=True)
    assert r.approved and r.fractional and r.amount == 598.80
    assert r.quantity == pytest.approx(598.80 / 190) and 3 < r.quantity < 4
    assert r.amount * 1.002 <= 600  # 수수료를 더해도 정한 금액을 넘지 않는다


def test_fractional_budget_too_small():
    r = assess_budget(usd(), account(buying_power=1_000, fx_rate=1_400), 0.5, fractional=True)
    assert not r.approved and r.codes == ["budget_too_small"] and r.amount == 0.5
    assert r.reasons == [f"내가 정한 금액으로 살 매수 금액($0.50)이 최소 주문 금액 ${MIN_FRACTIONAL_AMOUNT:g}보다 적음"]
    assert assess_budget(usd(), account(buying_power=1_000, fx_rate=1_400), 1.0, fractional=True).approved


def test_no_budget_checks_only():
    r = assess_budget(scenario(), account(buying_power=0.0), None)
    assert r.approved and r.quantity == 0 and r.amount == 0 and r.limited_by == "" and not r.fractional
    assert r.max_loss == 0 and r.expected_profit == 0 and r.codes == []
    assert r.reward_risk == assess(scenario(), account()).reward_risk
    low = assess_budget(scenario(target_price=107_000, probability=0.2), account(buying_power=0.0), None)
    assert low.codes == ["reward_risk_low", "ev_negative"]


@pytest.mark.parametrize("kw,acc", [
    ({}, {}),
    ({"target_price": 107_000}, {}),
    ({"probability": 0.2}, {"warnings": ["투자경고"]}),
    ({"target_price": 107_000, "probability": 0.2}, {"warnings": ["투자경고"], "daily_loss_krw": 300_000}),
])
def test_screening_matches_assess(kw, acc):
    """크기와 무관한 점검은 assess와 같은 코드·문장·순서다."""
    s, a = scenario(**kw), account(**acc)
    full = assess(s, a)
    screened = [(c, t) for c, t in zip(full.codes, full.reasons) if c != "size_too_small"]
    for budget in (None, 1_000_000):
        r = assess_budget(s, a, budget)
        assert list(zip(r.codes, r.reasons)) == screened
        assert r.reward_risk == full.reward_risk and r.expected_return == full.expected_return


def test_size_codes_follow_screening_codes():
    r = assess_budget(scenario(), account(warnings=["투자경고"], buying_power=500_000, max_total_krw=600_000),
                      1_000_000)
    assert r.codes == ["warning_stock", "cash_short", "total_limit"] and len(r.reasons) == 3


def test_daily_limits_still_apply(monkeypatch):
    from paper_engine.judge.risk import RiskLimits
    assert not assess_budget(scenario(), account(daily_loss_krw=300_000), 1_000_000).approved
    monkeypatch.setitem(LIMITS, "SWING", RiskLimits(risk_per_trade=0.01, max_position=None, min_reward_risk=1.5,
                                                    max_daily_loss=0.03, max_daily_trades=10))
    r = assess_budget(scenario(), account(daily_trades=10), 1_000_000)
    assert r.codes == ["daily_trades_limit"]


def test_assess_position_unchanged_by_refactor():
    ok, reasons, codes = assess_position(100, 10, account(buying_power=500, fx_rate=1_400, max_total_krw=1_400_000,
                                                          invested_krw=1_000_000), LIMITS["LONG_TERM"])
    assert not ok and codes == ["cash_short", "total_limit"]
    assert reasons == ["매수 금액 1,000이 매수 가능 금액 500보다 큼", "총 금액 한도 1,400,000원을 넘음 (남은 한도 400,000원)"]
