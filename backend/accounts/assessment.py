"""투자 성향·경험 진단 점수표 (docs/API.md "투자자 프로필과 주린이모드", docs/DECISIONS.md 13-2 E-2).

순수 함수 모듈이다 (DB·Django 없음). 점수 계산은 결정론적 코드다 (LLM 아님). 점수표를 바꾸면 docs/API.md의 표를 먼저 고친다.
가짜 API(frontend/src/mocks/investor.ts)가 같은 규칙·같은 오류 문장을 따른다.

  경험 점수 = q1 + q3 + q4 + q2(경험, 최대 3)   0~11 → 0~2 입문 · 3~5 초급 · 6~8 중급 · 9 이상 숙련
  성향 점수 = q5 + q6 + q7 + q2(성향)           0~8  → 0~1 안정형 · 2~3 안정추구형 · 4~5 위험중립형 · 6 적극투자형 · 7 이상 공격투자형
  추천 주린이모드 = 경험 단계가 입문·초급이면 켬 (성향은 추천에 쓰지 않는다)

법정 적합성 진단이 아니다. 성향은 화면 안내에만 쓰고 리스크 엔진의 수량 계산은 바꾸지 않는다 (DECISIONS 13-1 D-6).
"""
from dataclasses import dataclass

QUESTION_KEYS = ("q1", "q2", "q3", "q4", "q5", "q6", "q7")

# 하나만 고르는 문항: 보기 값 → 점수
EXPERIENCE_POINTS = {
    "q1": {"none": 0, "under_1y": 1, "1_3y": 2, "over_3y": 3},     # 주식 투자를 해 본 기간
    "q3": {"never": 0, "yearly": 1, "monthly": 2, "daily": 3},     # 주식 거래 빈도
    "q4": {"unknown": 0, "heard": 1, "explain": 2},                # "PER, 손절, 지정가"를 설명할 수 있나
}
RISK_POINTS = {
    "q5": {"no_loss": 0, "loss_10": 1, "loss_20": 2, "more": 3},   # 견딜 수 있는 손실
    "q6": {"years": 0, "weeks": 1, "intraday": 2},                 # 투자 기간
    "q7": {"practice": 0, "growth": 1, "short_term": 2},           # 투자 목적
}
SINGLE_CHOICE = {**EXPERIENCE_POINTS, **RISK_POINTS}

# q2 거래해 본 상품 (여럿 고름, 1개 이상. deposit은 혼자만). 이 순서로 저장한다
PRODUCTS = ("deposit", "fund_etf", "kr_stock", "us_stock", "derivatives")
DEPOSIT_ONLY = "deposit"
PRODUCT_EXPERIENCE = {"kr_stock": 1, "us_stock": 1, "derivatives": 2}
PRODUCT_EXPERIENCE_MAX = 3
PRODUCT_RISK = {"derivatives": 1}

EXPERIENCE_MAX = 11
RISK_MAX = 8
# (이 점수 이하, 단계). 마지막은 그 위 전부
EXPERIENCE_LEVELS = ((2, "intro"), (5, "novice"), (8, "intermediate"), (EXPERIENCE_MAX, "expert"))
RISK_PROFILES = ((1, "stable"), (3, "stable_seeking"), (5, "neutral"), (6, "active"), (RISK_MAX, "aggressive"))
BEGINNER_LEVELS = ("intro", "novice")

EXPERIENCE_LEVEL_LABELS = {"intro": "입문", "novice": "초급", "intermediate": "중급", "expert": "숙련"}
RISK_PROFILE_LABELS = {"stable": "안정형", "stable_seeking": "안정추구형", "neutral": "위험중립형",
                       "active": "적극투자형", "aggressive": "공격투자형"}

# 오류 문장 (400 detail). 가짜 API와 같은 문장
ANSWERS_REQUIRED = "answers가 필요합니다."
Q2_EMPTY = "q2는 하나 이상 골라 주세요."
Q2_DUPLICATE = "q2에 같은 답이 두 번 있습니다."
DEPOSIT_ALONE = "\"예적금만\"은 다른 보기와 같이 고를 수 없습니다."


def unknown_question(keys) -> str:
    return f"모르는 문항입니다: {', '.join(keys)}"


def missing_answer(key: str) -> str:
    return f"{key}에 답해 주세요."


def bad_answer(key: str) -> str:
    return f"{key}의 답이 올바르지 않습니다."


@dataclass(frozen=True)
class Assessment:
    experience_score: int
    experience_level: str
    risk_score: int
    risk_profile: str
    recommended_beginner_mode: bool


def answers_error(answers) -> str | None:
    """InvestorAnswers 검사. 틀리면 사람이 읽는 사유(400 detail), 맞으면 None.

    빠진 문항·모르는 키·모르는 값, q2가 목록이 아니거나 비었거나 같은 값이 두 번이거나 deposit이 다른 보기와 같이 오면 틀리다.
    """
    if not isinstance(answers, dict):
        return ANSWERS_REQUIRED
    unknown = sorted(str(key) for key in answers if key not in QUESTION_KEYS)
    if unknown:
        return unknown_question(unknown)
    for key in QUESTION_KEYS:
        if key not in answers:
            return missing_answer(key)
    for key in QUESTION_KEYS:
        value = answers[key]
        if key == "q2":
            error = _products_error(value)
            if error:
                return error
        elif not (isinstance(value, str) and value in SINGLE_CHOICE[key]):
            return bad_answer(key)
    return None


def _products_error(products) -> str | None:
    if not isinstance(products, list) or not products:
        return Q2_EMPTY
    if any(not (isinstance(product, str) and product in PRODUCTS) for product in products):
        return bad_answer("q2")
    if len(set(products)) != len(products):
        return Q2_DUPLICATE
    if DEPOSIT_ONLY in products and len(products) > 1:
        return DEPOSIT_ALONE
    return None


def clean_answers(answers: dict) -> dict:
    """저장할 모양: 문항 순서(q1~q7), q2는 PRODUCTS 순서. 틀린 답이면 ValueError."""
    error = answers_error(answers)
    if error:
        raise ValueError(error)
    cleaned = {key: answers[key] for key in QUESTION_KEYS}
    cleaned["q2"] = [product for product in PRODUCTS if product in answers["q2"]]
    return cleaned


def experience_score(answers: dict) -> int:
    products = min(PRODUCT_EXPERIENCE_MAX, sum(PRODUCT_EXPERIENCE.get(p, 0) for p in answers["q2"]))
    return sum(EXPERIENCE_POINTS[key][answers[key]] for key in EXPERIENCE_POINTS) + products


def risk_score(answers: dict) -> int:
    products = sum(PRODUCT_RISK.get(p, 0) for p in answers["q2"])
    return sum(RISK_POINTS[key][answers[key]] for key in RISK_POINTS) + products


def _band(score: int, bands: tuple) -> str:
    for upper, name in bands:
        if score <= upper:
            return name
    return bands[-1][1]


def experience_level(score: int) -> str:
    """경험 점수 → 단계: 0~2 intro · 3~5 novice · 6~8 intermediate · 9 이상 expert."""
    return _band(score, EXPERIENCE_LEVELS)


def risk_profile(score: int) -> str:
    """성향 점수 → 5단계: 0~1 stable · 2~3 stable_seeking · 4~5 neutral · 6 active · 7 이상 aggressive."""
    return _band(score, RISK_PROFILES)


def recommended_beginner_mode(level: str) -> bool:
    return level in BEGINNER_LEVELS


def assess(answers: dict) -> Assessment:
    """진단 결과. 답이 틀리면 ValueError(사유)."""
    answers = clean_answers(answers)
    experience = experience_score(answers)
    risk = risk_score(answers)
    level = experience_level(experience)
    return Assessment(experience_score=experience, experience_level=level, risk_score=risk,
                      risk_profile=risk_profile(risk), recommended_beginner_mode=recommended_beginner_mode(level))
