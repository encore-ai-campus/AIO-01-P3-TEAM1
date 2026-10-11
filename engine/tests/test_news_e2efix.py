"""뉴스 출처에서 블로그·개인 콘텐츠 빼기 (docs/records/운영E2E점검_UX리뷰_2026-10-08.md UX-5).

RSS의 <source url>은 실제 Google 뉴스 응답 모양을 따랐다 (2026-10-08 확인: blog.naver.com "Naver Blog",
m.blog.naver.com "블로그", contents.premium.naver.com "프리미엄콘텐츠"·"네이버 프리미엄콘텐츠").
"""
import pytest

from paper_engine.data.news import is_blocked_source, parse_rss


def item(title, source, url, day="07"):
    return (f'<item><title>{title} - {source}</title><pubDate>Wed, {day} Oct 2026 01:00:00 GMT</pubDate>'
            f'<source url="{url}">{source}</source></item>')


RSS = "<?xml version=\"1.0\"?><rss><channel>" + "".join([
    item("푸조, 네이버 공식 스토어서 전 차종 온라인 판매", "Naver Blog", "https://blog.naver.com"),
    item("삼성전자 주가 전망", "블로그", "https://m.blog.naver.com"),
    item("반도체 지금 사야 할까", "프리미엄콘텐츠", "https://contents.premium.naver.com"),
    item("개인 채널 글", "네이버 프리미엄콘텐츠", "https://in.naver.com"),
    item("티스토리 글", "어떤 블로그", "https://stockdiary.tistory.com"),
    item("브런치 글", "brunch", "https://brunch.co.kr"),
    item("포스트 글", "네이버 포스트", "https://m.post.naver.com"),
    item("삼성전자 신제품 발표", "연합뉴스", "https://www.yna.co.kr", day="06"),
    item("AI 반도체 기사", "블로터", "https://www.bloter.net", day="05"),
    item("실적 기사", "비즈니스포스트", "https://www.businesspost.co.kr", day="04"),
]) + "</channel></rss>"


def test_parse_drops_blog_and_personal_content_sources():
    items = parse_rss(RSS, 10)
    assert [i["source"] for i in items] == ["연합뉴스", "블로터", "비즈니스포스트"]
    assert items[0]["title"] == "삼성전자 신제품 발표"


def test_limit_counts_only_kept_news():
    assert [i["source"] for i in parse_rss(RSS, 2)] == ["연합뉴스", "블로터"]


@pytest.mark.parametrize("source, url, blocked", [
    ("Naver Blog", None, True),
    ("네이버 블로그", None, True),
    ("네이버 프리미엄콘텐츠", None, True),
    ("어떤 매체", "https://blog.naver.com/someone/123", True),
    ("어떤 매체", "https://m.blog.naver.com", True),
    ("어떤 매체", "https://in.naver.com/channel", True),
    ("연합뉴스", "https://www.yna.co.kr", False),
    ("블로터", "https://www.bloter.net", False),          # 이름에 "블로"가 있어도 언론사
    ("비즈니스포스트", "https://www.businesspost.co.kr", False),
    ("Daum", "https://v.daum.net", False),
    (None, None, False),
])
def test_is_blocked_source(source, url, blocked):
    assert is_blocked_source(source, url) is blocked
