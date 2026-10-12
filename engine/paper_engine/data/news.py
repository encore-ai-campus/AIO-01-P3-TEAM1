"""종목 뉴스 제목 수집 (Google News RSS, 키 불필요). 본문은 가져오지 않는다.

블로그·개인 콘텐츠(네이버 블로그·프리미엄콘텐츠·포스트, 티스토리, 브런치)는 뉴스가 아니라서 뺀다
(docs/records/운영E2E점검_UX리뷰_2026-10-08.md UX-5). RSS의 <source url="…">의 호스트와 출처 이름으로 거른다.
이 함수를 쓰는 곳(리포트·선정 뉴스, AI 교차검증 종목 자료, 장기투자 뉴스, 증권사 헤드라인)이 모두 같이 걸러진다.
"""
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from email.utils import parsedate_to_datetime

URL = "https://news.google.com/rss/search"
LOCALE = {
    "KR": {"hl": "ko", "gl": "KR", "ceid": "KR:ko"},
    "US": {"hl": "en-US", "gl": "US", "ceid": "US:en"},
}

# 뉴스로 쓰지 않는 출처: 호스트(그 하위 도메인 포함 — m.blog.naver.com)와 출처 이름(공백·대소문자 무시, 이름 전체가 같을 때만)
BLOCKED_HOSTS = ("blog.naver.com", "in.naver.com", "contents.premium.naver.com", "premium.naver.com", "post.naver.com",
                 "tistory.com", "brunch.co.kr")
BLOCKED_SOURCES = {"naverblog", "네이버블로그", "블로그", "네이버프리미엄콘텐츠", "프리미엄콘텐츠", "naverpremiumcontents",
                   "네이버포스트", "naverpost", "티스토리", "tistory", "브런치", "브런치스토리", "brunch", "brunchstory"}


def is_blocked_source(source: str | None, url: str | None = None) -> bool:
    """블로그·개인 콘텐츠 출처인가 (출처 주소의 호스트 또는 출처 이름으로)."""
    host = (urllib.parse.urlsplit(url).hostname or "").lower() if url else ""
    if any(host == blocked or host.endswith(f".{blocked}") for blocked in BLOCKED_HOSTS):
        return True
    return "".join((source or "").split()).lower() in BLOCKED_SOURCES


def parse_rss(xml_text: str, limit: int) -> list[dict]:
    """최신순으로 limit개를 반환한다 (블로그·개인 콘텐츠 출처는 빼고)."""
    items = []
    for item in ET.fromstring(xml_text).findall("./channel/item"):
        title = (item.findtext("title") or "").strip()
        source_tag = item.find("source")
        source = (source_tag.text or "").strip() if source_tag is not None else ""
        if is_blocked_source(source, source_tag.get("url") if source_tag is not None else None):
            continue
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
