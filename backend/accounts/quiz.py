"""단타 연습 퀴즈 (docs/API.md "단타 연습 퀴즈", docs/DECISIONS.md 14-4).

5문항(당일 청산 · 손절 · 비용 · VI · 모의 투자의 한계). 문항·보기·정답·해설은 **이 서버 코드에만** 둔다 —
GET 응답(public_questions)에는 정답·해설이 없다. **5문항을 모두 맞혀야 통과**하고, 몇 번이든 다시 풀 수 있다.
가짜 API(frontend/src/mocks/quiz.ts)가 같은 문항·같은 오류 문장을 흉내 낸다.

문장은 정보만 준다 (권유 표현 금지 — engine/paper_engine/wording.py).
"""
from dataclasses import dataclass

from paper_engine.judge.risk import SELL_TAX_RATE

# 국내 매도 거래세 (리스크 엔진·모의 체결기와 같은 값). 0.002 → "0.20%"
KR_SELL_TAX_TEXT = f"{SELL_TAX_RATE['KR'] * 100:.2f}%"


@dataclass(frozen=True)
class Question:
    id: str
    text: str
    choices: tuple[tuple[str, str], ...]   # (보기 id, 문장). id는 문항 안에서 유일 ("a"~"d")
    answer: str                            # 정답 보기 id
    explanation: str                       # 채점 뒤 보이는 해설 (맞혀도 준다)


QUESTIONS = (
    Question(
        id="q1",
        text="단타 연습장에서 산 주식은 언제 정리되나요?",
        choices=(
            ("a", "목표 가격에 닿을 때까지 며칠이고 가지고 있어요"),
            ("b", "그날 15:15가 지나면 목표·손절에 닿지 않았어도 정리돼요"),
            ("c", "다음 날 장이 시작할 때 정리돼요"),
            ("d", "내가 팔 때까지 계속 가지고 있어요"),
        ),
        answer="b",
        explanation="단타 계획은 밤을 넘기지 않아요. 그 세션 15:15 이후 첫 확인에서 체결 대기 주문은 취소하고, "
                    "가진 주식은 바로 정리해요(장 마감 전 정리).",
    ),
    Question(
        id="q2",
        text="손절 가격을 정해 두는 이유로 맞는 것은?",
        choices=(
            ("a", "손실이 더 커지기 전에 정해 둔 가격에서 팔려고"),
            ("b", "손절 가격에 닿으면 반드시 이익이 나서"),
            ("c", "손절 가격을 정하면 가격이 그 아래로 내려가지 않아서"),
            ("d", "수수료를 아끼려고"),
        ),
        answer="a",
        explanation="손절은 손실을 정해 둔 만큼으로 줄이려는 장치예요. 가격이 갑자기 크게 움직이면 손절 가격보다 더 낮게 팔릴 수도 있어요.",
    ),
    Question(
        id="q3",
        text="하루에 여러 번 사고팔 때 비용에 대해 맞는 것은?",
        choices=(
            ("a", "모의 투자라 비용은 계산하지 않아요"),
            ("b", "수수료는 이익이 났을 때만 내요"),
            ("c", f"살 때와 팔 때 수수료가 붙고, 팔 때는 거래세({KR_SELL_TAX_TEXT})도 붙어 자주 거래할수록 비용이 쌓여요"),
            ("d", "거래세는 살 때만 내요"),
        ),
        answer="c",
        explanation="단타는 거래가 잦아 비용이 손익을 크게 좌우해요. 이 서비스는 모의 계좌에도 수수료(매수·매도)와 "
                    "매도 거래세를 똑같이 계산해요.",
    ),
    Question(
        id="q4",
        text="VI(변동성 완화장치)가 걸리면 어떻게 되나요?",
        choices=(
            ("a", "그 종목 거래가 그날 내내 멈춰요"),
            ("b", "가격이 반드시 오른다는 신호예요"),
            ("c", "장이 바로 끝나요"),
            ("d", "가격이 짧은 시간에 크게 움직이면 잠시(보통 2분) 단일가 매매로 바뀌어 바로 체결되지 않을 수 있어요"),
        ),
        answer="d",
        explanation="VI는 급격한 가격 변동을 잠시 식히는 장치예요. 그동안은 주문이 바로 체결되지 않아 생각한 가격과 다르게 체결될 수 있어요.",
    ),
    Question(
        id="q5",
        text="모의 단타 연습 결과에 대해 맞는 것은?",
        choices=(
            ("a", "모의 체결은 실제 호가·체결 속도와 달라, 실제 매매에서는 결과가 달라질 수 있어요"),
            ("b", "모의에서 번 만큼 실제 계좌에서도 벌 수 있어요"),
            ("c", "모의 투자에서는 손실이 나지 않아요"),
            ("d", "모의 결과는 실제 계좌에 반영돼요"),
        ),
        answer="a",
        explanation="모의 체결은 약 5초마다 확인한 가격으로 흉내 낸 것이라 실제 호가·체결과 달라요. 연습 결과가 실제 결과를 말해 주지 않아요.",
    ),
)
QUESTION_IDS = tuple(question.id for question in QUESTIONS)
TOTAL = len(QUESTIONS)

# 오류 문장 (400 detail). 가짜 API와 같은 문장
ANSWERS_REQUIRED = "answers가 필요합니다."


def unknown_question(keys) -> str:
    return f"모르는 문항입니다: {', '.join(keys)}"


def missing_answer(key: str) -> str:
    return f"{key}에 답해 주세요."


def bad_choice(key: str) -> str:
    return f"{key}에 없는 보기입니다."


def public_questions() -> list[dict]:
    """GET /api/me/day-trading-quiz의 questions — 정답·해설을 뺀 문항 (q1부터)."""
    return [{"id": q.id, "text": q.text, "choices": [{"id": cid, "text": text} for cid, text in q.choices]}
            for q in QUESTIONS]


def answers_error(answers) -> str | None:
    """POST 본문의 answers 검사. 틀리면 사유(400 detail), 맞으면 None.

    다섯 문항 모두 답해야 하고, 모르는 문항 키·그 문항에 없는 보기 id(문자열이 아닌 값 포함)는 틀리다.
    """
    if not isinstance(answers, dict):
        return ANSWERS_REQUIRED
    unknown = sorted(str(key) for key in answers if key not in QUESTION_IDS)
    if unknown:
        return unknown_question(unknown)
    for question in QUESTIONS:
        if question.id not in answers:
            return missing_answer(question.id)
        choice = answers[question.id]
        if not (isinstance(choice, str) and any(choice == cid for cid, _ in question.choices)):
            return bad_choice(question.id)
    return None


def grade(answers: dict) -> dict:
    """채점. DayQuizResult에서 passedAt을 뺀 모양 {passed, correct, total, results}. 답이 틀린 모양이면 ValueError.

    passed = 5문항 모두 맞힘 (하나라도 틀리면 false). results는 q1부터, 맞혀도 해설을 준다.
    """
    error = answers_error(answers)
    if error:
        raise ValueError(error)
    results = [{"id": q.id, "correct": answers[q.id] == q.answer, "explanation": q.explanation} for q in QUESTIONS]
    correct = sum(1 for result in results if result["correct"])
    return {"passed": correct == TOTAL, "correct": correct, "total": TOTAL, "results": results}
