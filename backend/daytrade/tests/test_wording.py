"""단타 연습 API가 사람에게 보이는 문장에 권유 표현을 쓰지 않는다 (docs/API.md 공통 규칙 "금지 표현")."""
from paper_engine.wording import forbidden_phrases

from daytrade import service


def test_fixed_texts_have_no_persuasion():
    texts = [service.SUMMARY, service.ENTRY_CLOSED_TEXT, service.NOT_ACKNOWLEDGED, service.LOCKED_TEXT]
    for text in texts:
        assert forbidden_phrases(text) == [], text


def test_summary_says_it_is_not_ai():
    assert "AI 아님" in service.SUMMARY  # 단타 추천은 사용자가 직접 입력한 값이다
