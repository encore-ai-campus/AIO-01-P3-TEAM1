"""투자 성향·경험 진단 점수표 (accounts/assessment.py, docs/API.md "투자자 프로필과 주린이모드"). 순수 함수라 DB 없이."""
import itertools

import pytest

from accounts import assessment
from accounts.assessment import (ANSWERS_REQUIRED, DEPOSIT_ALONE, Q2_DUPLICATE, Q2_EMPTY, Assessment, answers_error,
                                 assess, clean_answers, experience_level, risk_profile)

BASE = {"q1": "none", "q2": ["deposit"], "q3": "never", "q4": "unknown", "q5": "no_loss", "q6": "years", "q7": "practice"}


def answers(**overrides) -> dict:
    """모든 점수가 0인 답에서 일부만 바꾼 답."""
    return {**BASE, **overrides}


def test_api_worked_example():
    """docs/API.md의 예: 경험 1(입문), 성향 2(안정추구형), 추천 켬."""
    result = assess({"q1": "none", "q2": ["deposit"], "q3": "never", "q4": "heard",
                     "q5": "loss_10", "q6": "weeks", "q7": "practice"})
    assert result == Assessment(experience_score=1, experience_level="intro", risk_score=2,
                                risk_profile="stable_seeking", recommended_beginner_mode=True)


def test_all_zero():
    assert assess(BASE) == Assessment(0, "intro", 0, "stable", True)


@pytest.mark.parametrize("score, level", [
    (0, "intro"), (2, "intro"), (3, "novice"), (5, "novice"), (6, "intermediate"), (8, "intermediate"),
    (9, "expert"), (11, "expert"),
])
def test_experience_level_bands(score, level):
    assert experience_level(score) == level


@pytest.mark.parametrize("score, profile", [
    (0, "stable"), (1, "stable"), (2, "stable_seeking"), (3, "stable_seeking"), (4, "neutral"), (5, "neutral"),
    (6, "active"), (7, "aggressive"), (8, "aggressive"),
])
def test_risk_profile_bands(score, profile):
    assert risk_profile(score) == profile


@pytest.mark.parametrize("overrides, score, level, recommended", [
    ({"q1": "under_1y", "q4": "heard"}, 2, "intro", True),
    ({"q1": "1_3y", "q4": "heard"}, 3, "novice", True),
    ({"q1": "over_3y", "q4": "explain"}, 5, "novice", True),
    ({"q1": "over_3y", "q3": "yearly", "q4": "explain"}, 6, "intermediate", False),
    ({"q1": "over_3y", "q3": "monthly", "q4": "explain", "q2": ["kr_stock"]}, 8, "intermediate", False),
    ({"q1": "over_3y", "q3": "daily", "q4": "explain", "q2": ["kr_stock"]}, 9, "expert", False),
    ({"q1": "over_3y", "q3": "daily", "q4": "explain", "q2": ["kr_stock", "us_stock", "derivatives"]}, 11, "expert", False),
])
def test_experience_boundaries_through_answers(overrides, score, level, recommended):
    """경계 2/3 · 5/6 · 8/9를 실제 답으로. 추천 주린이모드는 입문·초급이면 켬."""
    result = assess(answers(**overrides))
    assert (result.experience_score, result.experience_level, result.recommended_beginner_mode) == (score, level, recommended)


@pytest.mark.parametrize("overrides, score, profile", [
    ({"q5": "loss_10"}, 1, "stable"),
    ({"q5": "loss_20"}, 2, "stable_seeking"),
    ({"q5": "more"}, 3, "stable_seeking"),
    ({"q5": "more", "q6": "weeks"}, 4, "neutral"),
    ({"q5": "more", "q6": "intraday"}, 5, "neutral"),
    ({"q5": "more", "q6": "intraday", "q7": "growth"}, 6, "active"),
    ({"q5": "more", "q6": "intraday", "q7": "short_term"}, 7, "aggressive"),
    ({"q5": "more", "q6": "intraday", "q7": "short_term", "q2": ["derivatives"]}, 8, "aggressive"),
])
def test_risk_boundaries_through_answers(overrides, score, profile):
    """경계 1/2 · 3/4 · 5/6 · 6/7을 실제 답으로."""
    result = assess(answers(**overrides))
    assert (result.risk_score, result.risk_profile) == (score, profile)


@pytest.mark.parametrize("products, experience, risk", [
    (["deposit"], 0, 0),
    (["fund_etf"], 0, 0),
    (["kr_stock"], 1, 0),
    (["kr_stock", "us_stock"], 2, 0),
    (["derivatives"], 2, 1),
    (["kr_stock", "derivatives"], 3, 1),
    (["kr_stock", "us_stock", "derivatives"], 3, 1),  # 경험 합계는 3까지
    (["fund_etf", "kr_stock", "us_stock", "derivatives"], 3, 1),
])
def test_q2_points(products, experience, risk):
    result = assess(answers(q2=products))
    assert (result.experience_score, result.risk_score) == (experience, risk)


def test_risk_profile_does_not_change_recommendation():
    """성향은 추천에 쓰지 않는다: 공격투자형이어도 입문이면 켬 추천."""
    result = assess(answers(q5="more", q6="intraday", q7="short_term"))
    assert result.risk_profile == "aggressive"
    assert result.experience_level == "intro" and result.recommended_beginner_mode is True


def _all_answer_sets():
    others = [p for p in assessment.PRODUCTS if p != "deposit"]
    product_sets = [["deposit"]] + [list(c) for n in range(1, 5) for c in itertools.combinations(others, n)]
    singles = {key: list(points) for key, points in assessment.SINGLE_CHOICE.items()}
    for q1, q3, q4, q5, q6, q7 in itertools.product(*(singles[k] for k in ("q1", "q3", "q4", "q5", "q6", "q7"))):
        for q2 in product_sets:
            yield {"q1": q1, "q2": q2, "q3": q3, "q4": q4, "q5": q5, "q6": q6, "q7": q7}


def test_every_valid_answer_set_scores_in_range():
    """모든 올바른 답 조합: 점수는 0~11 · 0~8 안이고 그 사이 모든 값이 나온다."""
    experiences, risks = set(), set()
    count = 0
    for answer_set in _all_answer_sets():
        assert answers_error(answer_set) is None
        result = assess(answer_set)
        experiences.add(result.experience_score)
        risks.add(result.risk_score)
        assert result.recommended_beginner_mode is (result.experience_level in ("intro", "novice"))
        count += 1
    assert count == 4 * 16 * 4 * 3 * 4 * 3 * 3
    assert experiences == set(range(12))
    assert risks == set(range(9))


@pytest.mark.parametrize("raw, message", [
    (None, ANSWERS_REQUIRED),
    ([], ANSWERS_REQUIRED),
    ("q1", ANSWERS_REQUIRED),
    (answers(q8="x"), "모르는 문항입니다: q8"),
    ({**answers(), "zz": 1, "q0": 1}, "모르는 문항입니다: q0, zz"),
    ({k: v for k, v in BASE.items() if k != "q3"}, "q3에 답해 주세요."),
    ({}, "q1에 답해 주세요."),
    (answers(q1="sometimes"), "q1의 답이 올바르지 않습니다."),
    (answers(q1=1), "q1의 답이 올바르지 않습니다."),
    (answers(q1=None), "q1의 답이 올바르지 않습니다."),
    (answers(q1=["none"]), "q1의 답이 올바르지 않습니다."),
    (answers(q6="Years"), "q6의 답이 올바르지 않습니다."),
    (answers(q7=True), "q7의 답이 올바르지 않습니다."),
    (answers(q2=[]), Q2_EMPTY),
    (answers(q2="kr_stock"), Q2_EMPTY),
    (answers(q2=None), Q2_EMPTY),
    (answers(q2={"kr_stock": True}), Q2_EMPTY),
    (answers(q2=["bonds"]), "q2의 답이 올바르지 않습니다."),
    (answers(q2=[1]), "q2의 답이 올바르지 않습니다."),
    (answers(q2=[["kr_stock"]]), "q2의 답이 올바르지 않습니다."),
    (answers(q2=["kr_stock", "kr_stock"]), Q2_DUPLICATE),
    (answers(q2=["deposit", "deposit"]), Q2_DUPLICATE),
    (answers(q2=["deposit", "kr_stock"]), DEPOSIT_ALONE),
    (answers(q2=["fund_etf", "deposit"]), DEPOSIT_ALONE),
])
def test_answers_error(raw, message):
    assert answers_error(raw) == message
    if isinstance(raw, dict):
        with pytest.raises(ValueError, match="."):
            assess(raw)


def test_valid_answers_have_no_error():
    assert answers_error(BASE) is None
    assert answers_error(answers(q2=["fund_etf", "kr_stock", "us_stock", "derivatives"])) is None


def test_clean_answers_orders_keys_and_products():
    raw = {"q7": "growth", "q2": ["derivatives", "kr_stock"], "q1": "1_3y", "q3": "daily", "q4": "heard",
           "q5": "loss_20", "q6": "weeks"}
    cleaned = clean_answers(raw)
    assert list(cleaned) == ["q1", "q2", "q3", "q4", "q5", "q6", "q7"]
    assert cleaned["q2"] == ["kr_stock", "derivatives"]
    assert raw["q2"] == ["derivatives", "kr_stock"]  # 받은 값은 그대로 둔다


def test_labels_cover_every_code():
    assert set(assessment.EXPERIENCE_LEVEL_LABELS) == {name for _, name in assessment.EXPERIENCE_LEVELS}
    assert set(assessment.RISK_PROFILE_LABELS) == {name for _, name in assessment.RISK_PROFILES}
