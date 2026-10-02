import pytest

from paper_engine.judge.fact_check import fact_check, resolve
from paper_engine.judge.scenario import SWING_MAX_DAYS, SWING_MIN_DAYS

SNAPSHOT = {
    "symbol": "005930", "lastPrice": 100_000.0,
    "indicators": {"rsi14": 54.21, "sma20": 98_000.0, "sma60": None},
    "fundamentals": {"ratios": {"per": 7.64}},
    "recentCandles": [{"close": 99_000.0}, {"close": 100_000.0}],
    "brokerReports": [{"publishedAt": "2026-09-30T01:00:00+00:00", "source": "뉴스핌", "broker": "미래에셋증권",
                       "targetPrice": 186_000.0, "direction": "UP",
                       "title": "[리포트 브리핑]한국항공우주, 'KF-21' 목표가 186,000원 - 미래에셋증권"}],
    "webResearch": {"researchers": [{"findings": [
        {"claim": "키옥시아 지분 평가이익으로 2분기 금융수익이 약 63조원 늘었다."}]}]},
}


def scenario(evidence, **kw):
    return {"horizon": "SWING", "holdingDays": 10, "entryPrice": 100_000,
            "rationale": [{"claim": "x", "evidence": evidence}], **kw}


def test_resolve():
    assert resolve(SNAPSHOT, "indicators.rsi14") == 54.21
    assert resolve(SNAPSHOT, "recentCandles.-1.close") == 100_000.0
    assert resolve(SNAPSHOT, "recentCandles[0].close") == 99_000.0
    # 앞부분을 뺀 경로도 찾는다
    assert resolve(SNAPSHOT, "ratios.per") == 7.64
    assert resolve(SNAPSHOT, "rsi14") == 54.21
    with pytest.raises(KeyError):
        resolve(SNAPSHOT, "ratios.pbr")


def test_broker_report_evidence_paths():
    assert resolve(SNAPSHOT, "brokerReports[0].targetPrice") == 186_000.0
    assert resolve(SNAPSHOT, "brokerReports[-1].broker") == "미래에셋증권"
    assert fact_check(SNAPSHOT, scenario([{"field": "brokerReports[0].targetPrice", "value": 186_000},
                                          {"field": "brokerReports[0].direction", "value": "UP"}])) == []
    assert fact_check(SNAPSHOT, scenario([{"field": "brokerReports[0].targetPrice", "value": 200_000}])) == [
        "brokerReports[0].targetPrice: 인용값 200000 ≠ 실제값 186000.0"]
    assert fact_check(SNAPSHOT, scenario([{"field": "brokerReports[1].targetPrice", "value": 1}])) == [
        "데이터에 없는 항목 인용: brokerReports[1].targetPrice"]


def test_passes_within_tolerance():
    assert fact_check(SNAPSHOT, scenario([{"field": "indicators.rsi14", "value": 54.2}])) == []


def test_catches_wrong_and_missing_values():
    errors = fact_check(SNAPSHOT, scenario([
        {"field": "indicators.rsi14", "value": 30.0},
        {"field": "indicators.macd", "value": 1.0},
        {"field": "indicators.sma60", "value": 97_000},
    ]))
    assert len(errors) == 3


def test_text_quotes():
    path = "webResearch.researchers[0].findings[0].claim"

    def check(value):
        return fact_check(SNAPSHOT, scenario([{"field": path, "value": value}]))

    assert check("키옥시아 지분 평가이익으로  2분기 금융수익이 약 63조원 늘었다.") == []  # 공백 차이
    assert check("키옥시아 지분 평가이익으로 2분기 금융수익이") == []  # 원문의 일부
    assert check("키옥시아 지분 평가이익으로 2분기 금융수익이 약 80조원 늘었다.")  # 내용이 다름
    assert check("63조원")  # 너무 짧은 인용


def test_rejects_entry_far_from_price():
    assert fact_check(SNAPSHOT, scenario([], entryPrice=90_000))
    assert fact_check(SNAPSHOT, {"rationale": []})


def test_tolerates_malformed_rationale():
    assert fact_check(SNAPSHOT, scenario([], rationale=["문자열", {"claim": "x"}])) == []


# --- 매매 방침: 스윙만, 보유 기간 3~20거래일 ---

def test_policy_constants():
    assert (SWING_MIN_DAYS, SWING_MAX_DAYS) == (3, 20)


def test_rejects_long_term():
    assert fact_check(SNAPSHOT, scenario([], horizon="LONG_TERM")) == [
        "매매하지 않는 투자 기간: LONG_TERM (허용 SWING)"]
    # 실제로 나왔던 형태: 장기 + 150일
    assert fact_check(SNAPSHOT, scenario([], horizon="LONG_TERM", holdingDays=150)) == [
        "매매하지 않는 투자 기간: LONG_TERM (허용 SWING)",
        "보유 기간 150거래일이 허용 범위를 벗어남 (허용 3~20거래일)"]
    assert fact_check(SNAPSHOT, scenario([], horizon=None))


@pytest.mark.parametrize("days", [3, 20, 10, 3.0])
def test_holding_days_within_range(days):
    assert fact_check(SNAPSHOT, scenario([], holdingDays=days)) == []


@pytest.mark.parametrize("days,shown", [(2, "2"), (21, "21"), (100, "100"), (0, "0"), (-5, "-5"),
                                        (20.5, "20.5")])
def test_rejects_holding_days_out_of_range(days, shown):
    assert fact_check(SNAPSHOT, scenario([], holdingDays=days)) == [
        f"보유 기간 {shown}거래일이 허용 범위를 벗어남 (허용 3~20거래일)"]


@pytest.mark.parametrize("days", [None, "열흘", [10], {}])
def test_rejects_malformed_holding_days(days):
    assert fact_check(SNAPSHOT, scenario([], holdingDays=days)) == [
        f"holdingDays 누락 또는 형식 오류: {days!r} (허용 3~20거래일)"]


def test_rejects_missing_holding_days():
    raw = scenario([])
    del raw["holdingDays"]
    assert fact_check(SNAPSHOT, raw) == ["holdingDays 누락 또는 형식 오류: None (허용 3~20거래일)"]
