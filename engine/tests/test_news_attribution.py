"""뉴스 출처 표기 (docs/DECISIONS.md 14-7 U12): 엔진 HTML 리포트와 info 조회의 뉴스에 매체·게시 시각과 "Google 뉴스 검색 결과"."""
import json

from paper_engine import info, report

NEWS = [{"title": "삼성전자 <수주> 공시", "source": "연합뉴스", "publishedAt": "2026-09-28T05:05:00+00:00"},
        {"title": "반도체 업황 점검", "source": "", "publishedAt": None},
        {"title": "", "source": "빈 제목", "publishedAt": "2026-09-27T00:00:00+00:00"},
        "문자열 항목"]


def log_with(news) -> dict:
    return {"startedAt": "2026-09-29T08:01:00+09:00", "results": [
        {"snapshot": {"symbol": "005930", "name": "삼성전자", "currency": "KRW", "lastPrice": 100_000,
                      "indicators": {}, "news": news}, "candidates": []}]}


def test_news_line_has_source_and_kst_time():
    items = report.news_items({"news": NEWS})
    assert items == [{"title": "삼성전자 <수주> 공시", "source": "연합뉴스", "publishedAt": "2026-09-28T05:05:00+00:00"},
                     {"title": "반도체 업황 점검", "source": None, "publishedAt": None}]  # 제목 없는 것·dict 아닌 것은 뺀다
    assert report.news_line(items[0]) == "삼성전자 <수주> 공시 (연합뉴스 · 2026-09-28 14:05)"  # UTC → 한국 시간
    assert report.news_line(items[1]) == "반도체 업황 점검"  # 매체·시각이 없으면 제목만
    assert report.news_time("시각 아님") is None and report.news_time(None) is None
    assert report.news_time("2026-09-28T14:05:00") == "2026-09-28 14:05"  # 시간대 없는 값은 그대로


def test_news_items_are_limited():
    many = [{"title": f"제목 {i}", "source": "매체", "publishedAt": None} for i in range(20)]
    assert len(report.news_items({"news": many})) == report.MAX_NEWS


def test_report_html_shows_source_time_and_provider():
    html = report.build_html(log_with(NEWS))
    assert "삼성전자 &lt;수주&gt; 공시 (연합뉴스 · 2026-09-28 14:05)" in html
    assert "Google 뉴스 검색 결과(각 언론사)" in html and report.NEWS_PROVIDER == "Google 뉴스 검색 결과"
    assert "<li>반도체 업황 점검</li>" in html and "빈 제목" not in html
    assert "https://" not in html  # 링크는 넣지 않는다


def test_report_html_without_news_has_no_caption():
    assert "Google 뉴스" not in report.build_html(log_with([]))


def test_info_analysis_view_keeps_titles_and_adds_items(tmp_path, monkeypatch):
    runs = tmp_path / "runs"
    runs.mkdir()
    (runs / "20260929-080100-a.json").write_text(json.dumps(log_with(NEWS), ensure_ascii=False))
    monkeypatch.setattr(info, "RUNS_DIR", runs)
    (view,) = info.analyses("005930")
    assert view["news"] == ["삼성전자 <수주> 공시", "반도체 업황 점검"]  # 예전 형식 그대로 (제목만)
    assert view["newsItems"][0] == {"title": "삼성전자 <수주> 공시", "source": "연합뉴스",
                                    "publishedAt": "2026-09-28T05:05:00+00:00"}
    assert view["newsProvider"] == "Google 뉴스 검색 결과"
