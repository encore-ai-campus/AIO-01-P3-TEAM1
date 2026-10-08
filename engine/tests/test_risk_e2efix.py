"""리스크 엔진 사유 문장의 조사 (UX-5): 숫자 뒤 이/가를 숫자를 읽는 소리로 고른다 ("손익비 0.73이")."""
import pytest

from paper_engine.judge.risk import AccountContext, LIMITS, assess, assess_position, josa
from paper_engine.judge.scenario import Scenario


@pytest.mark.parametrize("word,expected", [
    ("0.73", "이"),    # 칠 점 삼 → 삼
    ("1.5", "가"),     # 오
    ("4.26", "이"),    # 육
    ("0.72", "가"),    # 이
    ("1.50", "이"),    # 영
    ("1,234", "가"),   # 사
    ("700,700", "이"),  # 칠백
    ("1,000", "이"),   # 천
    ("20", "이"),      # 이십
    ("10,000", "이"),  # 만
    ("0", "이"),       # 영
    ("2", "가"),       # 이
    ("1,000,000,000,000", "가"),  # 일조
    ("삼성전자", "가"), ("주식", "이"), ("5주", "가"),
    ("abc", "이(가)"), ("", "이(가)"),
])
def test_josa_subject(word, expected):
    assert josa(word) == expected


def test_josa_other_pairs():
    assert josa("삼성전자", "은", "는") == "는" and josa("1.3", "은", "는") == "은"
    assert josa("3주", "을", "를") == "를" and josa("10", "을", "를") == "을"


def usd_scenario(target: float) -> Scenario:
    """수수료·거래세 0 (미국, commission 0) → 1주 손실 = 100 − 90 × 0.99 = 10.9."""
    return Scenario(symbol="AAPL", currency="USD", horizon="SWING", entry_price=100, target_price=target,
                    stop_price=90, probability=0.8, holding_days=10)


ACCOUNT = AccountContext(equity_krw=100_000_000, buying_power=100_000, commission_rate=0.0)


@pytest.mark.parametrize("target,shown", [(107.96, "0.73이"), (113.625, "1.25가"), (110.9, "1.00이")])
def test_reward_risk_sentence_particle(target, shown):
    r = assess(usd_scenario(target), ACCOUNT)
    assert r.codes[0] == "reward_risk_low"
    assert r.reasons[0] == f"손익비 {shown} 최소 기준 {LIMITS['SWING'].min_reward_risk:.1f}보다 낮음"


def test_cash_short_sentence_particle():
    account = AccountContext(equity_krw=10_000_000, buying_power=1_000, commission_rate=0.0)
    ok, reasons, codes = assess_position(1_234, 1, account, LIMITS["LONG_TERM"])
    assert not ok and codes == ["cash_short"]
    assert reasons == ["매수 금액 1,234가 매수 가능 금액 1,000보다 큼"]
