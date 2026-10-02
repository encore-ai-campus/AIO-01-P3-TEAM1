import pytest

from paper_engine.data import broker_reports as br
from paper_engine.data.broker_reports import candidates, fetch_headlines, match, parse_headline, stock_reports


def expect(names, broker=None, target=None, direction=None):
    return {"names": names, "broker": broker, "targetPrice": target, "direction": direction}


# 2026-09-30 Google News RSS의 실제 제목
@pytest.mark.parametrize("title,expected", [
    ("[리포트 브리핑]한국항공우주, '결국 해주는 것도, 해줘야 하는 것도 KF-21' 목표가 186,000원 - 미래에셋증권",
     expect(["한국항공우주"], "미래에셋증권", 186_000)),
    ("[리포트 브리핑]한화에어로스페이스, '손이 뻗치지 않는 곳이 없다' 목표가 1,550,000원 - 미래에셋증권",
     expect(["한화에어로스페이스"], "미래에셋증권", 1_550_000)),
    ('유진투자 "한국콜마 목표주가 상향, 미국 새 자외선 차단 성분 허용 덕에 수주 확대 기대"',
     expect(["한국콜마"], "유진투자", direction="UP")),
    ('BNK투자 "하나금융지주 목표주가 상향, 역대 최대 실적에 올해 총주주환원율 51% 예상"',
     expect(["하나금융지주"], "BNK투자", direction="UP")),
    ("삼성證 한화솔루션, 美 무역확장법으로 수혜 기대…목표주가 24% 상향",
     expect(["한화솔루션"], "삼성증권", direction="UP")),
    ('DS증권, 이노션 목표주가↑…"실적상승·주당배당금 상향 기대"', expect(["이노션"], "DS증권", direction="UP")),
    ("한화솔루션, 美 태양광 정책 우호적…목표가 상향-삼성증권 - 머니투데이",
     expect(["한화솔루션"], "삼성증권", direction="UP")),
    ("증권가, 삼전닉스 목표가 잇따라 상향하는 까닭은", expect(["삼전닉스"], direction="UP")),
    ("3분기 영업익 188조 전망…삼성전자·SK하이닉스 목표주가 고공행진", expect(["삼성전자", "SK하이닉스"])),
    ('키움증권 "현대로템 목표주가 하향, 상반기 방산부문 수주 성과 부진"',
     expect(["현대로템"], "키움증권", direction="DOWN")),
    ("KH바텍, 폴더블폰 부진 속 전장・AI데이터센터 성과 본격화 기대...목표주가↓", expect(["KH바텍"], direction="DOWN")),
    ("LX인터내셔널, 물류가 실적 개선 이끈다..목표주가 6만6000원", expect(["LX인터내셔널"], target=66_000)),
    ("“호텔신라, 면세점 매출 더딘 회복…목표주가 하향”[클릭e종목]", expect(["호텔신라"], direction="DOWN")),
    ('"가온전선, 주가 하락 시 저가 매수해야…목표가 36만원"-대신', expect(["가온전선"], target=360_000)),
    ("63만원 vs 27만원… ‘대장주’ 삼성전자 주가 향방은", expect([])),
])
def test_parse_kr(title, expected):
    assert parse_headline(title, "KR") == expected


@pytest.mark.parametrize("title,expected", [
    ("Kimco Realty (NYSE:KIM) Price Target Raised to $25.00", expect(["KIM", "Kimco Realty"], target=25.0,
                                                                     direction="UP")),
    ("BRKR Maintained by Leerink Partners -- Price Target Raised to $8",
     expect(["BRKR"], "Leerink Partners", 8.0, "UP")),
    ("TXG Maintained by Leerink Partners -- Price Target Raised to $90",
     expect(["TXG"], "Leerink Partners", 90.0, "UP")),
    ("AMAT Stock Has Doubled This Year: Analyst Trims Price Target But Sees Higher 2027 Sales",
     expect(["AMAT"], direction="DOWN")),
    ("Analysts raise Bank of America price targets on revised outlook", expect(["Bank of America"], direction="UP")),
    ("XYZ Maintained by Some Bank -- Price Target Held", expect(["XYZ"], "Some Bank", direction="KEEP")),
    ("UBS sees upside in chip stocks", expect([])),
])
def test_parse_us(title, expected):
    assert parse_headline(title, "US") == expected


@pytest.mark.parametrize("title", ["", "   ", "목표가", "[", "$", "목표가 ,원 - 증권"])
def test_parse_never_raises(title):
    for market in ("KR", "US"):
        assert set(parse_headline(title, market)) == {"names", "broker", "targetPrice", "direction"}


KR_LISTED = [{"symbol": "047810", "name": "한국항공우주"}, {"symbol": "009830", "name": "한화솔루션"},
             {"symbol": "005930", "name": "삼성전자"}, {"symbol": "000660", "name": "SK하이닉스"},
             {"symbol": "214320", "name": "이노션"}, {"symbol": "161890", "name": "한국콜마"}]
US_LISTED = [{"symbol": "KIM", "name": "킴코 리얼티"}, {"symbol": "BRKR", "name": "브루커"},
             {"symbol": "BAC", "name": "뱅크 오브 아메리카", "englishName": "Bank of America Corp"}]


def test_match_exact_only():
    assert match(["한국항공우주"], KR_LISTED)["symbol"] == "047810"
    assert match(["sk 하이닉스"], KR_LISTED)["symbol"] == "000660"  # 공백·대소문자 무시
    assert match(["한국항공"], KR_LISTED) is None  # 부분 일치는 받지 않는다
    assert match(["삼전닉스"], KR_LISTED) is None
    assert match([], KR_LISTED) is None


def test_match_ambiguous_is_none():
    assert match(["삼성전자", "SK하이닉스"], KR_LISTED) is None
    assert match(["번스타인", "SK하이닉스"], KR_LISTED)["symbol"] == "000660"  # 종목 아닌 이름은 무시된다


def test_match_us_symbol_and_english_name():
    assert match(["KIM", "Kimco Realty"], US_LISTED)["symbol"] == "KIM"  # 같은 종목이면 하나
    assert match(["brkr"], US_LISTED)["symbol"] == "BRKR"
    assert match(["Bank of America"], US_LISTED)["symbol"] == "BAC"  # 영문 이름이 있으면 회사 형태만 떼고 비교
    assert match(["Bank"], US_LISTED) is None
    assert match(["047810"], KR_LISTED) is None  # 숫자 종목코드는 이름 자리에서 맞추지 않는다


def headline(title, at, source="매체"):
    return {"title": title, "publishedAt": at, "source": source}


def fake_fetch(pages: dict):
    calls = []

    def fetch(query, market, days=7, limit=15):
        calls.append((query, market, days, limit))
        page = pages[query]
        if isinstance(page, Exception):
            raise page
        return page
    fetch.calls = calls
    return fetch


def test_fetch_headlines_dedupes_and_sorts_newest_first():
    same = headline("DS증권, 이노션 목표주가↑", "2026-09-30T01:00:00+00:00")
    fetch = fake_fetch({"목표주가": [same, headline("A", "2026-09-29T01:00:00+00:00")],
                        "리포트 브리핑 목표가": [dict(same), headline("B", "2026-09-30T02:00:00+00:00")]})
    got = fetch_headlines("KR", fetch=fetch)
    assert [h["title"] for h in got] == ["B", "DS증권, 이노션 목표주가↑", "A"]
    assert [c[0] for c in fetch.calls] == list(br.QUERIES["KR"]) and fetch.calls[0][1:] == ("KR", 2, 40)


def test_fetch_headlines_keeps_partial_results_and_raises_when_all_fail():
    fetch = fake_fetch({"목표주가": OSError("down"), "리포트 브리핑 목표가": [headline("B", "2026-09-30")]})
    assert [h["title"] for h in fetch_headlines("KR", fetch=fetch)] == ["B"]
    with pytest.raises(OSError):
        fetch_headlines("KR", fetch=fake_fetch({q: OSError("down") for q in br.QUERIES["KR"]}))


def test_candidates_one_per_stock_latest_first():
    fetch = fake_fetch({
        "목표주가": [
            headline('유진투자 "한국콜마 목표주가 상향, 수주 확대 기대"', "2026-09-30T03:00:00+00:00"),
            headline("증권가, 삼전닉스 목표가 잇따라 상향하는 까닭은", "2026-09-30T02:30:00+00:00"),
            headline("3분기 영업익 188조 전망…삼성전자·SK하이닉스 목표주가 고공행진", "2026-09-30T02:00:00+00:00"),
        ],
        "리포트 브리핑 목표가": [
            headline("[리포트 브리핑]한국콜마, '성장' 목표가 90,000원 - 대신증권", "2026-09-29T01:00:00+00:00"),
            headline("[리포트 브리핑]한국항공우주, 'KF-21' 목표가 186,000원 - 미래에셋증권",
                     "2026-09-30T01:00:00+00:00", "뉴스핌"),
        ]})
    got = candidates("KR", KR_LISTED, fetch=fetch)
    assert [c["symbol"] for c in got] == ["161890", "047810"]
    assert got[0] == {"symbol": "161890", "name": "한국콜마", "broker": "유진투자", "targetPrice": None,
                      "direction": "UP", "title": '유진투자 "한국콜마 목표주가 상향, 수주 확대 기대"',
                      "publishedAt": "2026-09-30T03:00:00+00:00", "source": "매체"}
    assert got[1]["broker"] == "미래에셋증권" and got[1]["targetPrice"] == 186_000 and got[1]["source"] == "뉴스핌"


def test_stock_reports_keeps_target_headlines_about_the_stock():
    fetch = fake_fetch({'"한국항공우주" 목표주가': [
        headline("[리포트 브리핑]한국항공우주, 'KF-21' 목표가 186,000원 - 미래에셋증권", "2026-09-30T01:00:00+00:00"),
        headline("한국항공우주, 수출 계약 체결", "2026-09-29T01:00:00+00:00"),  # 목표가 언급 없음
        headline("현대로템 목표주가 상향", "2026-09-28T01:00:00+00:00"),  # 다른 종목
    ]})
    got = stock_reports("한국항공우주", "047810", "KR", fetch=fetch)
    assert got == [{"publishedAt": "2026-09-30T01:00:00+00:00", "source": "매체",
                    "title": "[리포트 브리핑]한국항공우주, 'KF-21' 목표가 186,000원 - 미래에셋증권",
                    "broker": "미래에셋증권", "targetPrice": 186_000.0, "direction": None}]
    assert fetch.calls == [('"한국항공우주" 목표주가', "KR", 30, 10)]


def test_stock_reports_us_query_and_symbol_mention():
    fetch = fake_fetch({'"Kimco Realty" price target': [
        headline("Kimco Realty (NYSE:KIM) Price Target Raised to $25.00", "2026-09-30T01:00:00+00:00")]})
    got = stock_reports("Kimco Realty", "KIM", "US", fetch=fetch)
    assert got[0]["targetPrice"] == 25.0 and got[0]["direction"] == "UP"


def test_stock_reports_network_error_is_empty():
    assert stock_reports("한국항공우주", "047810", "KR", fetch=fake_fetch({'"한국항공우주" 목표주가': OSError("x")})) == []
