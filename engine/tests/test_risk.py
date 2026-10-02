import pytest

from paper_engine.notify import format_report
from paper_engine.judge.risk import AccountContext, assess
from paper_engine.judge.scenario import Scenario


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
    r = assess(scenario(target_price=109_000), account())  # 손익비 약 1.4
    assert not r.approved
    assert any("손익비" in x for x in r.reasons)


def test_loss_uses_stop_order_price():
    # 손절 주문가는 감시가보다 1% 낮다. 손실은 주문가 기준: 100 − 90 × 0.99 = 10.9
    s = scenario(symbol="AAPL", currency="USD", entry_price=100, target_price=120, stop_price=90)
    r = assess(s, account(fx_rate=1_400))
    assert r.reward_risk == pytest.approx(20 / 10.9)
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
        scenario(horizon="DAY")


def test_report_contains_key_numbers():
    s = scenario(rationale=["20일선 지지"], analyst="claude")
    text = format_report(s, assess(s, account(max_total_krw=1_000_000)), "삼성전자")
    assert "[통과] 삼성전자" in text
    assert "10주" in text
    assert "20일선 지지" in text
