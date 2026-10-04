"""단타 연습 퀴즈 문항·채점 (accounts/quiz.py, docs/API.md "단타 연습 퀴즈"). 순수 함수라 DB 없이."""
import json

import pytest
from paper_engine.wording import forbidden_phrases

from accounts import quiz
from accounts.quiz import ANSWERS_REQUIRED, QUESTIONS, answers_error, grade, public_questions

KEY = {q.id: q.answer for q in QUESTIONS}


def wrong(question_id: str) -> str:
    question = next(q for q in QUESTIONS if q.id == question_id)
    return next(cid for cid, _ in question.choices if cid != question.answer)


def test_five_questions_with_valid_choices():
    assert [q.id for q in QUESTIONS] == ["q1", "q2", "q3", "q4", "q5"]
    assert quiz.TOTAL == 5
    for q in QUESTIONS:
        ids = [cid for cid, _ in q.choices]
        assert ids == ["a", "b", "c", "d"]
        assert q.answer in ids
        assert q.text and q.explanation and all(text for _, text in q.choices)


@pytest.mark.parametrize("question_id, topic", [
    ("q1", "15:15"),       # 당일 청산
    ("q2", "손절"),
    ("q3", "거래세"),      # 비용
    ("q4", "VI"),
    ("q5", "모의"),        # 모의 투자의 한계
])
def test_topics(question_id, topic):
    question = next(q for q in QUESTIONS if q.id == question_id)
    assert topic in " ".join([question.text, *(text for _, text in question.choices)])


def test_tax_rate_matches_engine():
    """비용 문항의 거래세는 리스크 엔진·모의 체결기의 국내 매도 거래세와 같다 (0.20%)."""
    assert quiz.KR_SELL_TAX_TEXT == "0.20%"
    q3 = next(q for q in QUESTIONS if q.id == "q3")
    assert "0.20%" in dict(q3.choices)[q3.answer]


def test_no_persuasion_wording():
    texts = [q.text for q in QUESTIONS] + [q.explanation for q in QUESTIONS]
    texts += [text for q in QUESTIONS for _, text in q.choices]
    assert [t for t in texts if forbidden_phrases(t)] == []


def test_public_questions_hide_answers_and_explanations():
    questions = public_questions()
    assert [q["id"] for q in questions] == ["q1", "q2", "q3", "q4", "q5"]
    for q in questions:
        assert set(q) == {"id", "text", "choices"}
        assert all(set(choice) == {"id", "text"} for choice in q["choices"])
    dumped = json.dumps(questions, ensure_ascii=False)
    assert "answer" not in dumped and "explanation" not in dumped
    assert not any(q.explanation in dumped for q in QUESTIONS)


def test_public_questions_are_copies():
    public_questions()[0]["choices"].clear()
    assert len(public_questions()[0]["choices"]) == 4


def test_grade_all_correct_passes():
    result = grade(KEY)
    assert (result["passed"], result["correct"], result["total"]) == (True, 5, 5)
    assert [r["id"] for r in result["results"]] == ["q1", "q2", "q3", "q4", "q5"]
    assert all(r["correct"] for r in result["results"])
    assert [r["explanation"] for r in result["results"]] == [q.explanation for q in QUESTIONS]  # 맞혀도 해설


@pytest.mark.parametrize("question_id", ["q1", "q2", "q3", "q4", "q5"])
def test_one_wrong_fails(question_id):
    """5문항을 모두 맞혀야 통과한다 (4/5는 실패)."""
    result = grade({**KEY, question_id: wrong(question_id)})
    assert (result["passed"], result["correct"], result["total"]) == (False, 4, 5)
    assert [r["id"] for r in result["results"] if not r["correct"]] == [question_id]


def test_all_wrong():
    result = grade({qid: wrong(qid) for qid in KEY})
    assert (result["passed"], result["correct"]) == (False, 0)


@pytest.mark.parametrize("raw, message", [
    (None, ANSWERS_REQUIRED),
    (["b", "a", "c", "d", "a"], ANSWERS_REQUIRED),
    ({**KEY, "q6": "a"}, "모르는 문항입니다: q6"),
    ({**KEY, "zz": "a", "q0": "a"}, "모르는 문항입니다: q0, zz"),
    ({k: v for k, v in KEY.items() if k != "q4"}, "q4에 답해 주세요."),
    ({}, "q1에 답해 주세요."),
    ({**KEY, "q2": "e"}, "q2에 없는 보기입니다."),
    ({**KEY, "q2": "A"}, "q2에 없는 보기입니다."),
    ({**KEY, "q3": 1}, "q3에 없는 보기입니다."),
    ({**KEY, "q3": None}, "q3에 없는 보기입니다."),
    ({**KEY, "q5": ["a"]}, "q5에 없는 보기입니다."),
])
def test_answers_error(raw, message):
    assert answers_error(raw) == message
    if isinstance(raw, dict):
        with pytest.raises(ValueError):
            grade(raw)
