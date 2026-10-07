"""Worker 프롬프트는 계약을 안내하고 공개 자료만 받는다."""

import inspect

import pytest

from reports.agents import prompts
from reports.contracts import NAMES


USER_PROMPTS = (
    prompts.market_user_prompt,
    prompts.fundamental_user_prompt,
    prompts.news_user_prompt,
    prompts.report_user_prompt,
    prompts.review_user_prompt,
    prompts.risk_user_prompt,
)


@pytest.mark.parametrize("worker_id", prompts.WORKER_SPECS)
def test_system_prompt_contains_role_contract_and_common_rules(worker_id):
    text = prompts.system_prompt(worker_id)
    _, contract = prompts.WORKER_SPECS[worker_id]
    assert contract in NAMES
    assert contract in text
    assert "JSON 객체 하나만" in text
    assert "한국어" in text
    assert "자료에 없는 사실" in text
    assert "수치 계산" in text
    assert "권유" in text
    assert "실제 주문이나 수량 결정" in text


def test_unknown_worker_is_rejected():
    with pytest.raises(KeyError, match="모르는 Worker"):
        prompts.system_prompt("unknown_agent")


@pytest.mark.parametrize("function", USER_PROMPTS)
def test_user_prompt_signatures_do_not_accept_context_or_secrets(function):
    names = set(inspect.signature(function).parameters)
    assert names.isdisjoint({"ctx", "cfg", "user", "user_id", "username", "api_key", "secret", "token"})


def test_market_prompt_serializes_only_given_public_materials():
    text = prompts.market_user_prompt(
        symbol="005930", name="삼성전자", market="KR",
        data={"price": 70000, "signals": ["완성 일봉 기준"]},
    )
    assert "삼성전자 (005930)" in text
    assert '"price":70000' in text
    assert "완성된 일봉" in text


@pytest.mark.parametrize("sensitive", [
    {"api_key": "secret-value"},
    {"nested": {"CLIENT-SECRET": "secret-value"}},
    {"items": [{"user id": 7}]},
    {"authorization": "Bearer secret-value"},
])
def test_sensitive_fields_are_rejected_at_any_depth(sensitive):
    with pytest.raises(ValueError, match="민감 필드"):
        prompts.news_user_prompt(symbol="005930", name="삼성전자", market="KR", data=sensitive)


def test_non_json_materials_are_rejected():
    with pytest.raises(ValueError, match="JSON"):
        prompts.market_user_prompt(symbol="005930", name="삼성전자", market="KR", data={"bad": object()})


def test_report_prompt_includes_research_and_revision_instructions():
    text = prompts.report_user_prompt(
        symbol="005930", name="삼성전자", market="KR",
        inputs={"market_agent": {"trend": "up"}}, instructions="근거와 결론을 맞추세요.",
    )
    assert '"research"' in text
    assert '"revisionInstructions":"근거와 결론을 맞추세요."' in text
    assert "plainSummary" in text
    assert "손익비 기준을 스스로 적용하지 마세요" in text


def test_review_and_risk_prompts_include_their_boundaries():
    review = prompts.review_user_prompt(
        symbol="005930", name="삼성전자", market="KR", inputs={"report_agent": {"verdict": "hold"}},
    )
    risk = prompts.risk_user_prompt(
        symbol="005930", name="삼성전자", market="KR",
        warnings={"broker": ["투자 유의"]}, handoff={"reason": "고위험 신호"},
    )
    assert "RETRY" in review and "FAIL" in review and "plainSummary" in review
    assert "주문 수량" in risk and '"handoff"' in risk
