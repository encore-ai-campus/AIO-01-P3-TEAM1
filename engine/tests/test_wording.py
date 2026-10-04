import pytest

from paper_engine.wording import CAUSAL, PERSUASION, PREDICTION, forbidden_phrases

# docs/API.md 공통 규칙 "금지 표현"의 최소 목록. 모듈은 이것을 모두 담는다
MIN_PERSUASION = ("사세요", "사 볼 만해요", "사 볼 만", "매수하세요", "매수 기회", "지금 사면", "담으세요", "좋아요",
                  "파세요", "팔아야", "매도하세요", "매도 기회", "지금 팔면", "정리하세요", "비중을 줄이세요",
                  "비중을 늘리세요", "손절하세요")
MIN_CAUSAL = ("때문에", "덕분에", "원인은", "탓에", "영향으로")
MIN_PREDICTION = ("오를 것", "내릴 것", "오를 거", "내릴 거", "상승할 것", "하락할 것", "반등할 것")


def test_lists_contain_the_minimum():
    assert set(MIN_PERSUASION) <= set(PERSUASION)
    assert set(MIN_CAUSAL) <= set(CAUSAL)
    assert set(MIN_PREDICTION) <= set(PREDICTION)


@pytest.mark.parametrize("phrase", PERSUASION)
def test_each_persuasion_phrase_is_caught_in_both_modes(phrase):
    text = f"삼성전자는 {phrase} 라고 썼다"
    assert phrase in forbidden_phrases(text)
    assert phrase in forbidden_phrases(text, causal=True)


@pytest.mark.parametrize("phrase", CAUSAL + PREDICTION)
def test_each_causal_and_prediction_phrase_is_caught_only_with_causal(phrase):
    text = f"오늘 주가는 {phrase} 보인다"
    assert phrase in forbidden_phrases(text, causal=True)
    assert phrase not in forbidden_phrases(text)


@pytest.mark.parametrize("phrase", PERSUASION + CAUSAL + PREDICTION)
def test_spacing_is_ignored(phrase):
    squashed = "".join(phrase.split())
    spaced = " ".join(squashed)  # 글자마다 띄어 쓴 모양
    assert phrase in forbidden_phrases(f"앞{squashed}뒤", causal=True)
    assert phrase in forbidden_phrases(f"앞 {spaced} 뒤", causal=True)


def test_returns_all_hits_in_list_order():
    assert forbidden_phrases("좋아요, 지금 사면") == ["지금 사면", "좋아요"]  # 문장 순서가 아니라 목록 순서
    hits = forbidden_phrases("사볼만해요. 실적 때문에 오를 것", causal=True)
    assert hits == ["사 볼 만해요", "사 볼 만", "때문에", "오를 것"]


def test_clean_sentences_pass():
    for text in ("모의 계좌에서 삼성전자 10주를 71,000원에 샀어요",
                 "목표가에 닿아 모의 계좌에서 팔았어요",
                 "오늘은 시장과 비슷하게 움직였어요",
                 "등락의 원인을 단정하지 않습니다. 같은 날 나온 소식을 모은 것이며 투자 권유가 아닙니다.",
                 "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다",
                 ""):
        assert forbidden_phrases(text, causal=True) == [], text
