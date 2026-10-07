import pytest

from paper_engine.notify import format_report
from paper_engine.judge.risk import LIMITS, AccountContext, RiskLimits, assess, assess_position
from paper_engine.judge.scenario import HORIZONS, TRADABLE_HORIZONS, Scenario


def scenario(**kw):
    base = dict(symbol="005930", currency="KRW", horizon="SWING", entry_price=100_000,
                target_price=115_000, stop_price=95_000, probability=0.5, holding_days=10)
    return Scenario(**{**base, **kw})


def account(**kw):
    base = dict(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0)
    return AccountContext(**{**base, **kw})


def test_size_by_risk_per_trade():
    # 위험 한도 10만원(1%), 1주당 손실 약 11,078원 (손절 주문가 89,100원, 매도세 포함) → 9주
    r = assess(scenario(stop_price=90_000, target_price=125_000), account())
    assert r.approved
    assert r.limited_by == "건당 위험 한도"
    assert r.quantity == 9
    assert r.max_loss <= 100_000


def test_no_position_limit_by_default():
    # 종목당 비중 한도가 없다. 손절이 가까우면 건당 위험 한도가 큰 수량을 허용한다 (예전에는 10주로 묶였다).
    r = assess(scenario(stop_price=99_000, target_price=104_000), account())
    assert r.limited_by == "건당 위험 한도" and r.quantity == 45  # 10만원 ÷ 1주당 손실 2,188원


def test_size_capped_by_total_limit():
    r = assess(scenario(stop_price=99_000, target_price=104_000), account(max_total_krw=2_000_000))
    assert r.limited_by == "총 금액 한도" and r.quantity == 20
    # 이미 자동 관리 중인 금액만큼 줄어든다
    r = assess(scenario(stop_price=99_000, target_price=104_000),
               account(max_total_krw=2_000_000, invested_krw=1_750_000))
    assert r.quantity == 2
    r = assess(scenario(stop_price=99_000, target_price=104_000),
               account(max_total_krw=2_000_000, invested_krw=2_000_000))
    assert not r.approved and r.quantity == 0 and "1주 미만 (총 금액 한도)" in r.reasons[-1]


def test_total_limit_is_converted_for_usd():
    s = scenario(symbol="AAPL", currency="USD", entry_price=200, target_price=230, stop_price=198)
    r = assess(s, account(buying_power=10_000, fx_rate=1_400, max_total_krw=1_400_000))
    assert r.limited_by == "총 금액 한도" and r.quantity == 5  # 140만원 = $1,000


def test_position_limit_when_set():
    from dataclasses import replace
    from paper_engine.judge import risk
    limits = replace(risk.LIMITS["SWING"], max_position=0.05)
    original = risk.LIMITS["SWING"]
    risk.LIMITS["SWING"] = limits
    try:
        r = assess(scenario(stop_price=99_000, target_price=104_000), account())
        assert r.limited_by == "종목당 비중 한도" and r.quantity == 5  # 자산의 5%
        r = assess(scenario(stop_price=99_000, target_price=104_000), account(position_value=300_000))
        assert r.quantity == 2
    finally:
        risk.LIMITS["SWING"] = original


def test_fractional_sizes_by_amount():
    s = scenario(symbol="META", currency="USD", entry_price=723.2, target_price=810, stop_price=690)
    a = account(equity_krw=2_100_000, buying_power=705.42, fx_rate=1_400, max_total_krw=2_000_000)
    whole = assess(s, a)
    assert whole.quantity == 0 and not whole.approved
    r = assess(s, a, fractional=True)
    # 건당 위험 한도: 자산 $1,500의 1% = $15, 1주당 손실 $40.1 (손절 주문가 $683.1) → 0.3741주 → $270.52
    assert r.approved and r.fractional and r.limited_by == "건당 위험 한도"
    assert r.amount == 270.52 and r.quantity == pytest.approx(0.37406, abs=1e-5)
    assert r.max_loss == pytest.approx(15.0, abs=0.01)


def test_fractional_is_used_only_when_a_whole_share_is_not_affordable():
    s = scenario(symbol="INTC", currency="USD", entry_price=116.5, target_price=135, stop_price=110)
    r = assess(s, account(equity_krw=2_100_000, buying_power=705.42, fx_rate=1_400), fractional=True)
    assert r.quantity == 1 and not r.fractional and r.amount == 116.5  # $15 ÷ $7.6 = 1.97주 → 1주


def test_fractional_rejects_tiny_amount():
    s = scenario(symbol="META", currency="USD", entry_price=723.2, target_price=800, stop_price=690)
    r = assess(s, account(buying_power=0.5, fx_rate=1_400), fractional=True)
    assert not r.approved and "최소 주문 금액" in r.reasons[-1]


def test_size_capped_by_buying_power_and_liquidity():
    assert assess(scenario(), account(buying_power=250_000)).quantity == 2
    r = assess(scenario(), account(avg_daily_trading_amount=50_000_000))
    assert r.limited_by == "유동성 한도"
    assert r.quantity == 5


def test_rejects_low_reward_risk():
    r = assess(scenario(target_price=107_000), account())  # 손익비 약 1.1 (매도 거래세·손절 주문가 반영)
    assert not r.approved
    assert any("손익비" in x and "1.5" in x for x in r.reasons)


def test_swing_minimum_reward_risk_is_1_5():
    assert LIMITS["SWING"].min_reward_risk == 1.5
    # 손실 = 100,000 − 95,000 × 0.99 × (1 − 0.002) = 6,138.1. 이익 = 목표가 × (1 − 0.002) − 100,000
    assert assess(scenario(target_price=109_500), account()).approved  # 9,281 ÷ 6,138.1 ≈ 1.51
    assert not assess(scenario(target_price=109_300), account()).approved  # 9,081.4 ÷ 6,138.1 ≈ 1.48


def test_loss_uses_stop_order_price():
    # 손절 주문가는 감시가보다 1% 낮다. 손실은 주문가 기준: 100 − 90 × 0.99 = 10.9
    s = scenario(symbol="AAPL", currency="USD", entry_price=100, target_price=115, stop_price=90)
    r = assess(s, account(fx_rate=1_400))
    assert r.reward_risk == pytest.approx(15 / 10.9)
    assert not r.approved and any("손익비" in x for x in r.reasons)


def test_rejects_negative_expected_value():
    r = assess(scenario(probability=0.2), account())
    assert not r.approved
    assert any("기대값" in x for x in r.reasons)
    assert r.expected_value < 0


def test_rejects_warnings_daily_loss_and_zero_quantity():
    assert not assess(scenario(), account(warnings=["OVERHEATED"])).approved
    assert not assess(scenario(), account(daily_loss_krw=300_000)).approved
    r = assess(scenario(), account(buying_power=50_000))
    assert r.quantity == 0 and not r.approved


def test_costs_reduce_profit():
    free = assess(scenario(), account())
    paid = assess(scenario(), account(commission_rate=0.001))
    assert paid.reward_risk < free.reward_risk


def test_no_bypass_mode():
    import inspect
    from paper_engine.judge import risk
    assert "bypass" not in inspect.signature(assess).parameters and not hasattr(risk, "BYPASS_LIMITS")


def test_usd_scenario_converts_equity():
    s = scenario(symbol="AAPL", currency="USD", entry_price=100, target_price=140, stop_price=80)
    r = assess(s, account(equity_krw=14_000_000, buying_power=10_000, fx_rate=1400))
    # 자산 $10,000의 1% = $100, 1주당 손실 $20.8 (손절 주문가 $79.2) → 4주
    assert r.limited_by == "건당 위험 한도"
    assert r.quantity == 4


def test_long_term_requires_higher_reward_risk():
    s = scenario(horizon="LONG_TERM", target_price=114_000)  # 손익비 약 2.2
    assert not assess(s, account()).approved
    assert assess(scenario(target_price=114_000), account()).approved


def test_scenario_validation():
    with pytest.raises(ValueError):
        scenario(stop_price=101_000)
    with pytest.raises(ValueError):
        scenario(probability=1.2)
    with pytest.raises(ValueError):
        scenario(horizon="MONTH")


def test_report_contains_key_numbers():
    s = scenario(rationale=["20일선 지지"], analyst="claude")
    text = format_report(s, assess(s, account(max_total_krw=1_000_000)), "삼성전자")
    assert "[통과] 삼성전자" in text
    assert "10주" in text
    assert "20일선 지지" in text


# --- 한도 · 사유 코드 · 장기 보유 점검 (docs/DECISIONS.md 14-3, docs/API.md "실행 불가 사유 코드") ---

def test_horizons_have_limits_and_only_swing_is_tradable_by_ai():
    assert HORIZONS == ("SWING", "LONG_TERM") and TRADABLE_HORIZONS == ("SWING",)
    assert set(LIMITS) == set(HORIZONS)
    assert LIMITS["LONG_TERM"].max_position == 1.0
    assert LIMITS["SWING"].max_position is None and LIMITS["SWING"].max_daily_trades is None


def test_daily_trades_and_loss_limits(monkeypatch):
    assert assess(scenario(), account(daily_trades=50)).approved  # 스윙에는 건수 한도가 없다
    assert not assess(scenario(), account(daily_loss_krw=300_000)).approved  # 자산 1천만원의 3%
    monkeypatch.setitem(LIMITS, "SWING", RiskLimits(risk_per_trade=0.01, max_position=None, min_reward_risk=2.0,
                                                    max_daily_loss=0.03, max_daily_trades=10))
    assert assess(scenario(), account(daily_trades=9)).approved
    r = assess(scenario(), account(daily_trades=10))
    assert not r.approved and r.codes == ["daily_trades_limit"] and "10건" in r.reasons[0]


def test_codes_align_with_reasons():
    r = assess(scenario(target_price=107_000, probability=0.2),
               account(warnings=["투자경고"], daily_loss_krw=300_000, buying_power=50_000))
    assert r.codes == ["reward_risk_low", "ev_negative", "warning_stock", "daily_loss_limit", "size_too_small"]
    assert len(r.codes) == len(r.reasons)
    assert r.reasons[2] == "매수 유의 종목: 투자경고" and r.reasons[-1].startswith("매수 가능 수량이 1주 미만")
    s = scenario(symbol="META", currency="USD", entry_price=723.2, target_price=800, stop_price=690)
    tiny = assess(s, account(buying_power=0.5, fx_rate=1_400), fractional=True)
    assert tiny.codes[-1] == "size_too_small" and len(tiny.codes) == len(tiny.reasons)
    assert assess(scenario(), account()).codes == []


def test_assess_position_passes_within_cash_and_limits():
    ok, reasons, codes = assess_position(70_000, 10, account(commission_rate=0.001), LIMITS["LONG_TERM"])
    assert ok and reasons == [] and codes == []


def test_assess_position_cash_short_includes_commission():
    a = account(buying_power=700_000, commission_rate=0.001)
    assert assess_position(70_000, 9, a, LIMITS["LONG_TERM"])[0]
    ok, reasons, codes = assess_position(70_000, 10, a, LIMITS["LONG_TERM"])  # 700,700 > 700,000
    assert not ok and codes == ["cash_short"]
    assert reasons == ["매수 금액 700,700이 매수 가능 금액 700,000보다 큼"]


def test_assess_position_position_limit():
    limits = RiskLimits(risk_per_trade=0.02, max_position=0.5, min_reward_risk=2.5, max_daily_loss=0.03)
    ok, reasons, codes = assess_position(100_000, 30, account(position_value=2_500_000), limits)
    assert not ok and codes == ["position_limit"] and reasons == ["종목당 비중 한도(50%)를 넘음"]
    assert assess_position(100_000, 25, account(position_value=2_500_000), limits)[0]  # 정확히 50%는 통과
    # 100%(LONG_TERM)는 자산 전부까지 — 매수 가능 금액이 먼저 막는다
    ok, _, codes = assess_position(100_000, 101, account(buying_power=20_000_000), LIMITS["LONG_TERM"])
    assert codes == ["position_limit"]
    assert assess_position(100_000, 100, account(), LIMITS["LONG_TERM"])[0]


def test_assess_position_total_limit_in_krw_and_codes_order():
    s_ok = assess_position(100, 10, account(buying_power=5_000, fx_rate=1_400, max_total_krw=1_400_000,
                                            invested_krw=0), LIMITS["LONG_TERM"])
    assert s_ok[0]
    ok, reasons, codes = assess_position(100, 10, account(buying_power=500, fx_rate=1_400, max_total_krw=1_400_000,
                                                          invested_krw=1_000_000), LIMITS["LONG_TERM"])
    assert not ok and codes == ["cash_short", "total_limit"] and len(reasons) == 2
    assert reasons[0] == "매수 금액 1,000이 매수 가능 금액 500보다 큼"
    assert reasons[1] == "총 금액 한도 1,400,000원을 넘음 (남은 한도 400,000원)"


def test_assess_position_rejects_bad_input():
    with pytest.raises(ValueError):
        assess_position(0, 1, account(), LIMITS["LONG_TERM"])
    with pytest.raises(ValueError):
        assess_position(100, 0, account(), LIMITS["LONG_TERM"])
