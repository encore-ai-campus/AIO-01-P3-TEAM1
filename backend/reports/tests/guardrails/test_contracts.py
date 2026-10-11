"""Worker 출력 계약의 정리·검증 규칙."""

import pytest

from reports.guardrails.contracts import NAMES, REVIEW_ACCEPTED, ContractError, describe, validate

from ..conftest import SAMPLES


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
        "evidence": ["전자공시"], "ignored": "제거",
    }
    value.update(changes)
    return value


def news(**changes):
    value = {
        "sentiment": "neutral", "score": 0.1, "summary": "뉴스 요약",
        "headlines": [{"date": "2026-10-01", "title": "제목", "source": "매체", "impact": "중립"}],
        "evidence": ["제목 · 매체"], "ignored": "제거",
    }
    value.update(changes)
    return value


def report(**changes):
    value = {
        "title": "종목 리포트", "verdict": "hold", "oneLiner": "AI 의견은 관찰이 필요하다는 쪽입니다.",
        "plainSummary": ["AI 의견은 아직 흐름을 더 지켜봐야 한다는 쪽이에요."], "markdown": "## 본문",
        "reasons": ["실적 흐름이 안정적입니다."], "risks": ["이 의견이 틀리는 경우를 확인해야 합니다."],
        "targets": {"entry": None, "target": None, "stop": None, "holdingDays": None, "probability": None},
        "confidence": 65, "citations": ["완성 일봉"], "ignored": "제거",
    }
    value.update(changes)
    return value


def review(**changes):
    value = {"verdict": "PASS", "score": 90, "issues": [], "instructions": None, "handoff": None,
             "ignored": "제거"}
    value.update(changes)
    return value


def risk(**changes):
    value = {"level": "low", "flags": [], "warnings": ["변동성 확인"], "summary": "위험이 낮습니다.",
             "ignored": "제거"}
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
    assert set(NAMES) == {"MarketResult", "FundamentalResult", "NewsResult", "ReportDraft", "ReviewResult", "RiskResult",
                          "CandidateNewsResult", "FilingCheckResult", "FlowResult", "SelectionDraft"}
    assert all(describe(name) for name in NAMES)
    assert "positive/negative/neutral" in describe("FundamentalResult")
    assert "1~20" in describe("ReportDraft") and "0~1" in describe("ReportDraft")
    assert "volumeRank는 정수" in describe("MarketResult")
    with pytest.raises(KeyError, match="모르는 출력 계약"):
        describe("Unknown")


def test_market_adds_optional_as_of_and_truncates_limits():
    result = validate("MarketResult", market(summary="가" * 700, signals=[str(i) for i in range(7)]))
    assert result["asOf"] is None
    assert len(result["summary"]) == 600
    assert result["signals"] == ["0", "1", "2", "3", "4"]


@pytest.mark.parametrize("value", [float("nan"), float("inf"), float("-inf")])
def test_numbers_must_be_finite(value):
    with pytest.raises(ContractError, match="유한한 숫자"):
        validate("MarketResult", market(price=value))


def test_numeric_contract_fields_accept_null():
    assert validate("MarketResult", market(price=None, changePct=None))["price"] is None
    assert validate("NewsResult", news(score=None))["score"] is None
    assert validate("ReportDraft", report(confidence=None))["confidence"] is None
    assert validate("ReviewResult", review(score=None))["score"] is None


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


def test_fundamental_metrics_may_be_null():
    assert validate("FundamentalResult", fundamental(metrics=None))["metrics"] is None


@pytest.mark.parametrize(("value", "message"), [
    (news(sentiment="mixed"), "sentiment"),
    (news(score=1.1), "score"),
    (news(headlines=[{"date": "오늘", "title": "제목", "source": "매체"}]), "impact"),
])
def test_news_rejects_invalid_values(value, message):
    with pytest.raises(ContractError, match=message):
        validate("NewsResult", value)


def test_news_date_and_source_may_be_null():
    item = {"date": None, "title": "제목", "source": None, "impact": "중립"}
    assert validate("NewsResult", news(headlines=[item]))["headlines"][0]["source"] is None


def test_plain_summary_rejects_digits_and_empty_list_and_truncates_text():
    with pytest.raises(ContractError, match="숫자"):
        validate("ReportDraft", report(plainSummary=["목표가가 70000원이에요."]))
    with pytest.raises(ContractError, match="1개 이상"):
        validate("ReportDraft", report(plainSummary=[]))
    result = validate("ReportDraft", report(plainSummary=["가" * 101]))
    assert len(result["plainSummary"][0]) == 100


@pytest.mark.parametrize("plain", [[""], ["목표가 ７만원이에요"], ["AI 의견으로는 사 볼 만해요"]])
def test_plain_summary_rejects_empty_unicode_digits_and_persuasion(plain):
    with pytest.raises(ContractError):
        validate("ReportDraft", report(plainSummary=plain))


def test_one_liner_rejects_persuasion_and_required_text_rejects_empty_values():
    with pytest.raises(ContractError, match="권유 표현"):
        validate("ReportDraft", report(oneLiner="지금 사면 좋아요"))
    with pytest.raises(ContractError, match="markdown.*비어"):
        validate("ReportDraft", report(markdown="  "))


def test_markdown_is_not_silently_truncated():
    markdown = "본문" * 11_000
    assert validate("ReportDraft", report(markdown=markdown))["markdown"] == markdown


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


def test_review_retry_rejects_whitespace_instructions_and_keeps_full_text():
    with pytest.raises(ContractError, match="instructions"):
        validate("ReviewResult", review(verdict="RETRY", instructions="   "))
    instructions = "수정" * 400
    assert validate("ReviewResult", review(verdict="RETRY", instructions=instructions))["instructions"] == instructions


def test_review_result_keeps_accepted_flag_only_when_true():
    """acceptedWithNotes는 코드만 붙이는 선택 키다 (선정 검토의 마지막 검토, docs/DECISIONS.md 30장). 정확히 true일 때만 남는다."""
    base = SAMPLES["ReviewResult"]
    assert validate("ReviewResult", base) == base   # 옛 결과·종목 리포트 검토는 글자 그대로
    assert REVIEW_ACCEPTED == "acceptedWithNotes" and REVIEW_ACCEPTED not in describe("ReviewResult")   # LLM에는 알리지 않는다
    for value in ("yes", False, 1, None):
        assert REVIEW_ACCEPTED not in validate("ReviewResult", base | {REVIEW_ACCEPTED: value}), value
    assert validate("ReviewResult", base | {REVIEW_ACCEPTED: True}) == base | {REVIEW_ACCEPTED: True}


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
    with pytest.raises(KeyError, match="모르는 출력 계약"):
        validate("Unknown", {})


def test_enum_error_does_not_echo_an_unbounded_model_value():
    value = "x" * 10_000
    with pytest.raises(ContractError) as error:
        validate("MarketResult", market(trend=value))
    assert len(str(error.value)) < 200


def test_unknown_keys_are_removed_from_nested_objects():
    fundamental_value = fundamental(
        metrics={"per": 1, "pbr": 1, "roe": 1, "revenueGrowthPct": 1, "opMarginPct": 1, "extra": 1},
        recentFilings=[{"date": "오늘", "title": "공시", "impact": "neutral", "extra": 1}],
    )
    assert "extra" not in validate("FundamentalResult", fundamental_value)["metrics"]
    assert "extra" not in validate("FundamentalResult", fundamental_value)["recentFilings"][0]

    headline = {"date": None, "title": "제목", "source": None, "impact": "중립", "extra": 1}
    assert "extra" not in validate("NewsResult", news(headlines=[headline]))["headlines"][0]

    targets = {"entry": None, "target": None, "stop": None, "holdingDays": None, "probability": None, "extra": 1}
    assert "extra" not in validate("ReportDraft", report(targets=targets))["targets"]

    issue = {"claim": "주장", "problem": "문제", "fix": "수정", "extra": 1}
    handoff = {"to": "risk_agent", "reason": "위험", "extra": 1}
    result = validate("ReviewResult", review(issues=[issue], handoff=handoff))
    assert "extra" not in result["issues"][0]
    assert "extra" not in result["handoff"]
