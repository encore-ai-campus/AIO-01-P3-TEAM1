"""Worker 출력 계약의 정리·검증 규칙."""

import pytest

from reports.contracts import NAMES, ContractError, describe, validate


def market(**changes):
    value = {
        "trend": "up", "summary": "상승 흐름", "price": 70000, "changePct": 1.2,
        "rsi": 55.2, "volatilityPct": None, "volumeRank": 3, "support": 68000, "resistance": 72000,
        "signals": ["이동평균선 위"], "evidence": ["완성 일봉"], "ignored": "제거",
    }
    value.update(changes)
    return value


def fundamental(**changes):
    value = {
        "summary": "재무 요약",
        "metrics": {"per": 12.3, "pbr": 1.2, "roe": None, "revenueGrowthPct": 4.5, "opMarginPct": 8.1},
        "recentFilings": [{"date": "2026-10-01", "title": "분기보고서", "impact": "neutral"}],
        "evidence": ["전자공시"],
    }
    value.update(changes)
    return value


def news(**changes):
    value = {
        "sentiment": "neutral", "score": 0.1, "summary": "뉴스 요약",
        "headlines": [{"date": "2026-10-01", "title": "제목", "source": "매체", "impact": "중립"}],
        "evidence": ["제목 · 매체"],
    }
    value.update(changes)
    return value


def report(**changes):
    value = {
        "title": "종목 리포트", "verdict": "hold", "oneLiner": "AI 의견은 관찰이 필요하다는 쪽입니다.",
        "plainSummary": ["AI 의견은 아직 흐름을 더 지켜봐야 한다는 쪽이에요."], "markdown": "## 본문",
        "reasons": ["실적 흐름이 안정적입니다."], "risks": ["이 의견이 틀리는 경우를 확인해야 합니다."],
        "targets": {"entry": None, "target": None, "stop": None, "holdingDays": None, "probability": None},
        "confidence": 65, "citations": ["완성 일봉"],
    }
    value.update(changes)
    return value


def review(**changes):
    value = {"verdict": "PASS", "score": 90, "issues": [], "instructions": None, "handoff": None}
    value.update(changes)
    return value


def risk(**changes):
    value = {"level": "low", "flags": [], "warnings": ["변동성 확인"], "summary": "위험이 낮습니다."}
    value.update(changes)
    return value


@pytest.mark.parametrize(("name", "value"), [
    ("MarketResult", market()), ("FundamentalResult", fundamental()), ("NewsResult", news()),
    ("ReportDraft", report()), ("ReviewResult", review()), ("RiskResult", risk()),
])
def test_each_contract_accepts_valid_output(name, value):
    result = validate(name, value)
    assert isinstance(result, dict)
    assert "ignored" not in result


def test_names_and_descriptions_cover_all_contracts():
    assert set(NAMES) == {"MarketResult", "FundamentalResult", "NewsResult", "ReportDraft", "ReviewResult", "RiskResult"}
    assert all(describe(name) for name in NAMES)
    with pytest.raises(ContractError, match="모르는 출력 계약"):
        describe("Unknown")


def test_market_adds_optional_as_of_and_truncates_limits():
    result = validate("MarketResult", market(summary="가" * 700, signals=[str(i) for i in range(7)]))
    assert result["asOf"] is None
    assert len(result["summary"]) == 600
    assert result["signals"] == ["0", "1", "2", "3", "4"]


@pytest.mark.parametrize(("value", "message"), [
    (market(trend="bullish"), "trend"),
    (market(price="70000"), "price"),
    (market(volumeRank=1.5), "volumeRank"),
])
def test_market_rejects_invalid_values(value, message):
    with pytest.raises(ContractError, match=message):
        validate("MarketResult", value)


@pytest.mark.parametrize(("value", "message"), [
    (fundamental(metrics={"per": 1}), "metrics.pbr"),
    (fundamental(recentFilings=[{"date": "오늘", "title": "공시", "impact": "good"}]), "impact"),
    (fundamental(evidence="전자공시"), "evidence"),
])
def test_fundamental_rejects_invalid_values(value, message):
    with pytest.raises(ContractError, match=message):
        validate("FundamentalResult", value)


@pytest.mark.parametrize(("value", "message"), [
    (news(sentiment="mixed"), "sentiment"),
    (news(score=1.1), "score"),
    (news(headlines=[{"date": "오늘", "title": "제목", "source": "매체"}]), "impact"),
])
def test_news_rejects_invalid_values(value, message):
    with pytest.raises(ContractError, match=message):
        validate("NewsResult", value)


def test_plain_summary_rejects_digits_and_empty_list_and_truncates_text():
    with pytest.raises(ContractError, match="숫자"):
        validate("ReportDraft", report(plainSummary=["목표가가 70000원이에요."]))
    with pytest.raises(ContractError, match="1개 이상"):
        validate("ReportDraft", report(plainSummary=[]))
    result = validate("ReportDraft", report(plainSummary=["가" * 101]))
    assert len(result["plainSummary"][0]) == 100


@pytest.mark.parametrize(("value", "message"), [
    (report(targets={"entry": None, "target": None, "stop": None, "holdingDays": 0, "probability": None}), "holdingDays"),
    (report(targets={"entry": None, "target": None, "stop": None, "holdingDays": None, "probability": 1.1}), "probability"),
    (report(confidence=101), "confidence"),
])
def test_report_rejects_invalid_ranges(value, message):
    with pytest.raises(ContractError, match=message):
        validate("ReportDraft", value)


@pytest.mark.parametrize(("value", "message"), [
    (review(verdict="RETRY", instructions=None), "instructions"),
    (review(score=-1), "score"),
    (review(handoff={"to": "report_agent", "reason": "다시 작성"}), "handoff.to"),
])
def test_review_rejects_invalid_values(value, message):
    with pytest.raises(ContractError, match=message):
        validate("ReviewResult", value)


@pytest.mark.parametrize(("value", "message"), [
    (risk(level="critical"), "level"),
    (risk(flags="주의"), "flags"),
    (risk(summary=None), "summary"),
])
def test_risk_rejects_invalid_values(value, message):
    with pytest.raises(ContractError, match=message):
        validate("RiskResult", value)


def test_contract_requires_json_object_and_known_name():
    with pytest.raises(ContractError, match="JSON 객체"):
        validate("MarketResult", [])
    with pytest.raises(ContractError, match="모르는 출력 계약"):
        validate("Unknown", {})
