from paper_engine.data.news import parse_rss

RSS = """<?xml version="1.0"?><rss><channel>
<item><title>오래된 기사 - 매체A</title><pubDate>Wed, 23 Sep 2026 01:00:00 GMT</pubDate><source>매체A</source></item>
<item><title>최신 기사 - 제목에 대시 - 매체B</title><pubDate>Mon, 28 Sep 2026 03:33:00 GMT</pubDate><source>매체B</source></item>
<item><title>날짜 없는 기사</title><source>매체C</source></item>
</channel></rss>"""


def test_parse_sorts_newest_first_and_strips_source():
    items = parse_rss(RSS, 10)
    assert [i["title"] for i in items] == ["최신 기사 - 제목에 대시", "오래된 기사"]
    assert items[0]["source"] == "매체B"
    assert items[0]["publishedAt"].startswith("2026-09-28T03:33")


def test_parse_limit():
    assert len(parse_rss(RSS, 1)) == 1
