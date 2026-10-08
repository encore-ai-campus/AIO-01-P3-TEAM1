"""종목 검색의 한글 별칭 (UX-12): "엘지에너지" → LG에너지솔루션처럼 한글로 읽은 영문 상호도 찾는다 (trading.market.SEARCH_ALIASES)."""
import pytest

from .conftest import LISTED

pytestmark = pytest.mark.django_db
MORE = [{"symbol": "373220", "name": "LG에너지솔루션", "market": "KOSPI"},
        {"symbol": "066570", "name": "LG전자", "market": "KOSPI"},
        {"symbol": "035420", "name": "NAVER", "market": "KOSPI"},
        {"symbol": "030200", "name": "KT", "market": "KOSPI"},
        {"symbol": "033780", "name": "KT&G", "market": "KOSPI"},
        {"symbol": "010950", "name": "S-Oil", "market": "KOSPI"},
        {"symbol": "005490", "name": "POSCO홀딩스", "market": "KOSPI"},
        {"symbol": "006400", "name": "삼성SDI", "market": "KOSPI"}]


@pytest.fixture
def listed(monkeypatch):
    monkeypatch.setitem(LISTED, "KOSPI", LISTED["KOSPI"] + MORE)


def symbols(api, q: str) -> list[str]:
    return [r["symbol"] for r in api.get("/api/stocks/search", {"q": q}).json()["results"]]


def test_korean_aliases(api, fake, listed):
    assert symbols(api, "엘지에너지") == ["373220"]
    assert symbols(api, "엘지 에너지 솔루션") == ["373220"]
    assert symbols(api, "엘지") == ["066570", "373220"]               # 앞부분이 같음, 이름이 짧은 것 먼저
    assert symbols(api, "에스케이하이닉스") == ["000660"]
    assert symbols(api, "네이버") == ["035420"]
    assert symbols(api, "케이티") == ["030200", "033780"]              # KT 정확히 같음, KT&G 앞부분
    assert symbols(api, "케이티앤지") == ["033780"]
    assert symbols(api, "에쓰오일") == symbols(api, "에스오일") == ["010950"]
    assert symbols(api, "포스코") == ["005490"]
    assert symbols(api, "삼성에스디아이") == ["006400"]


def test_original_query_still_works_and_no_duplicates(api, fake, listed):
    assert symbols(api, "LG에너지") == ["373220"]
    assert symbols(api, "삼성") == ["005930", "005935", "006400"]      # 별칭이 없으면 검색어 그대로
    assert symbols(api, "삼성SDI") == symbols(api, "삼성에스디아이") == ["006400"]
    assert symbols(api, "에스") == []                                  # 별칭이 아닌 조각은 바꾸지 않는다
