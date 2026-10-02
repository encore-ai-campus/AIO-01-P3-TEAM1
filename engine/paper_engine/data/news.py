"""종목 뉴스 제목 수집 (Google News RSS, 키 불필요). 본문은 가져오지 않는다."""
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

URL = "https://news.google.com/rss/search"
LOCALE = {
    "KR": {"hl": "ko", "gl": "KR", "ceid": "KR:ko"},
    "US": {"hl": "en-US", "gl": "US", "ceid": "US:en"},
}


def parse_rss(xml_text: str, limit: int) -> list[dict]:
    """최신순으로 limit개를 반환한다."""
    items = []
    for item in ET.fromstring(xml_text).findall("./channel/item"):
        title = (item.findtext("title") or "").strip()
        source = (item.findtext("source") or "").strip()
        try:
            published = parsedate_to_datetime(item.findtext("pubDate"))
        except (TypeError, ValueError):
            continue
        if not title:
            continue
        # 제목 끝에 붙는 " - 매체명"을 뗀다.
        if source and title.endswith(f" - {source}"):
            title = title[: -len(source) - 3]
        items.append({"publishedAt": published.isoformat(), "source": source, "title": title})
    items.sort(key=lambda x: x["publishedAt"], reverse=True)
    return items[:limit]


def fetch_news(query: str, market_country: str, days: int = 7, limit: int = 15) -> list[dict]:
    params = {"q": f"{query} when:{days}d", **LOCALE[market_country]}
    req = urllib.request.Request(f"{URL}?{urllib.parse.urlencode(params)}",
                                 headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=15) as res:
        return parse_rss(res.read().decode("utf-8", errors="replace"), limit)
