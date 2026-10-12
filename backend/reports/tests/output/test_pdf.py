"""AI 리포트 A4 PDF: HTML 구성(종목 한 쪽·선별 표지)과 PDF API. 실제 Chrome·증권사는 부르지 않는다 (가짜 render·가짜 완성 일봉).

양식(docs/DECISIONS.md 14-7 "PDF", 15-7): 쪽 머리에 로고 + 이름 "모매매"(2026-10-07 바뀜, 양식 4판), 맨 위 쉬운 요약 상자 + 통일 면책 문장,
완성 일봉 차트 + "YYYY-MM-DD 종가 기준", 시세 지표의 장마감 기준 시각, 꼬리말 통일 면책 문장, 양식 판 번호가 붙은 파일 이름.
여기는 자세한 판이다 (API는 ?view=expert). 주린이모드 쉬운 판과 판 고르기는 test_pdf_easy.py.
"""
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest
from paper_engine import report as engine_report
from paper_engine.wording import forbidden_phrases
from trading import market

from config import engine
from reports.output import pdf
from reports.models import Report, TraceEvent

from ..conftest import make_report

pytestmark = pytest.mark.django_db

RESULTS = {
    "market_agent": {"trend": "up", "summary": "상승 추세", "price": 72000, "changePct": 1.25,
                     "asOf": "2026-10-02T15:30:00+09:00", "rsi": 61.3,
                     "volatilityPct": 2.4, "volumeRank": 3, "support": 70000, "resistance": 75000, "signals": [],
                     "evidence": []},
    "fundamental_agent": {"summary": "양호", "metrics": {"per": 12.5, "pbr": 1.1, "roe": 9.0}, "recentFilings": [],
                          "evidence": []},
    "report_agent": {"title": "삼성전자 리포트", "verdict": "buy", "oneLiner": "단기 반등 구간, 분할 접근", "markdown": "# x",
                     "plainSummary": ["거래가 늘며 값이 오르는 흐름이에요", "실적이 나아지고 있다는 공시가 있었어요",
                                      "환율이 바뀌면 손실이 더 클 수도 있어요"],
                     "reasons": ["수급 개선", "실적 바닥 통과", "거래대금 증가"],
                     "risks": ["환율 변동", "반도체 가격", "외국인 매도"],
                     "targets": {"entry": 72000, "target": 77000, "stop": 69000, "holdingDays": 10, "probability": 0.55},
                     "confidence": 74, "citations": []},
    "review_agent": {"verdict": "PASS", "score": 88, "issues": [], "instructions": None, "handoff": None},
    "risk_agent": {"level": "medium", "flags": [], "warnings": ["단기 과열 주의"], "summary": "변동성 확대 구간"},
}


def candle_rows(n=80, start=70000):
    day = datetime(2026, 7, 1)
    rows = []
    for i in range(n):
        close = start + i * 40 + (150 if i % 3 else -120)
        rows.append({"timestamp": (day + timedelta(days=i)).strftime("%Y-%m-%dT00:00:00+09:00"),
                     "openPrice": str(close - 50), "highPrice": str(close + 200), "lowPrice": str(close - 200),
                     "closePrice": str(close), "volume": "1000"})
    return rows


def no_live_candles(symbol):
    raise AssertionError("PDF 차트는 장중 미완성 봉이 섞인 market.candles가 아니라 completed_candles를 쓴다")


@pytest.fixture
def candles(monkeypatch):
    """완성 일봉 80개 (2026-07-01 ~ 2026-09-18)."""
    monkeypatch.setattr(market, "completed_candles", lambda symbol: candle_rows())
    monkeypatch.setattr(market, "candles", no_live_candles)


def pdf_name(report, suffix=".pdf") -> str:
    return f"{report.id}.v{pdf.TEMPLATE_VERSION}{suffix}"


def text_of(html: str) -> str:
    """HTML에서 사람이 읽는 글자만 (스타일·태그를 지운다)."""
    return re.sub(r"<[^>]+>", " ", re.sub(r"<style>.*?</style>", " ", html, flags=re.S))


@pytest.fixture
def files(monkeypatch, tmp_path):
    """PAPER_ROOT를 임시 폴더로, 엔진 설정은 Chrome 경로 없음으로 (.env를 읽지 않는다)."""
    monkeypatch.setattr(engine, "ROOT", tmp_path)
    monkeypatch.setattr(engine, "engine_config", lambda: SimpleNamespace(chrome_bin=None))
    return tmp_path


def event(report, step, actor, action, status, at_sec=0, model=None, provider=None, **details):
    base = datetime(2026, 10, 4, 9, 0, 0, tzinfo=timezone.utc)
    return TraceEvent.objects.create(report=report, step=step, actor=actor, action=action, status=status,
                                     model=model, provider=provider, details=details,
                                     at=base + timedelta(seconds=at_sec))


def full_report(user) -> tuple[Report, list[TraceEvent]]:
    report = make_report(user, status=Report.COMPLETED, results=RESULTS,
                         completed_agents=list(RESULTS), finished_at=datetime(2026, 10, 4, 9, 5, tzinfo=timezone.utc))
    trace = [
        event(report, 1, "orchestrator", "workflow_started", "started"),
        event(report, 2, "news_agent", "agent_started", "started", attempt=1),
        event(report, 3, "news_agent", "agent_failed", "failed", 1, model="model-a", errorType="timeout",
              attempt=1, injected=True, final=False),
        event(report, 4, "news_agent", "agent_failover", "started", 2, **{"from": "model-a", "to": "model-b",
                                                                          "reason": "timeout"}),
        event(report, 5, "news_agent", "agent_completed", "completed", 4, model="model-b", provider="demo",
              attempts=2, recovered=True, costUsd=0.01),
        event(report, 6, "report_agent", "agent_started", "started", 5, attempt=1),
        event(report, 7, "report_agent", "agent_completed", "completed", 7, model="model-c", provider="demo",
              costUsd=0.02),
        event(report, 8, "orchestrator", "workflow_completed", "completed", 8, costUsd=0.0345, durationMs=8000),
    ]
    return report, trace


def test_report_html_has_every_section(user, candles):
    report, trace = full_report(user)
    html = pdf.build_report_html(report, trace)
    assert "@page { size: A4; margin: 12mm }" in html and '"Noto Sans CJK KR", "Apple SD Gothic Neo", sans-serif' in html
    # ⓪ 쪽 머리: 로고(32px 이상 판 — 타일 + 속이 빈 ㅁ 블록 셋) + 이름, 오른쪽 작은 글씨, 맨 위. 면책 문장·날짜는 되풀이하지 않는다
    assert html.index('<header class="brand">') < html.index("<h1>")
    brand = html.split('<header class="brand">')[1].split("</header>")[0]
    assert '<svg class="logo"' in brand and brand.count("<rect") == 1 and brand.count("<path") == 3
    assert 'fill-rule="evenodd"' in brand and brand.count(pdf.MU_PATH) == 3
    assert f"<span>{pdf.SERVICE_NAME}</span>" in brand and pdf.BRAND_NOTE in brand
    assert "투자 권유" not in brand and "2026-10-04" not in brand
    # ① 머리: 서비스 이름(탭 제목), AI 의견 배지(권유가 아닌 말), 한 줄 요약. 이름은 쪽 머리에 있어 날짜 줄에 다시 쓰지 않는다
    assert pdf.SERVICE_NAME == "모매매" and "<title>삼성전자 AI 리포트 · 모매매</title>" in html
    assert "삼성전자" in html and "005930" in html and "2026-10-04" in html
    assert "2026-10-04 · AI 의견" in html and ">긍정적<" in html and ">매수<" not in html
    assert "단기 반등 구간, 분할 접근" in html
    # ①-2 맨 위 쉬운 요약 상자 (plainSummary 세 줄) + 통일 면책 문장 — 차트보다 먼저
    easy = html.split('<div class="easy">')[1].split("</div>")[0]
    assert "<h2>쉬운 요약</h2>" in easy and easy.count("<li>") == 3
    assert "거래가 늘며 값이 오르는 흐름이에요" in easy and "환율이 바뀌면 손실이 더 클 수도 있어요" in easy
    assert pdf.DISCLAIMER in easy
    assert html.index('<div class="easy">') < html.index("<h2>가격 차트</h2>")
    # ② SVG 차트: 완성 일봉 캔들, 20일 이동평균, 진입·목표·손절 가로선, 범례의 종가 기준 날짜(마지막 완성 봉)
    assert "<svg" in html and "<polyline" in html and html.count("<rect") > 60
    assert "진입 72,000" in html and "목표 77,000" in html and "손절 69,000" in html
    assert "2026-09-18 종가 기준 · 일봉(최근 60일)" in html
    # ③ 지표 카드와 그 기준 시각 (MarketResult의 종가·asOf)
    for text in ("+1.25%", "3위", "61.3", "2.40%", "12.5배", "1.10배"):
        assert text in html
    assert "시세 지표: 종가 72,000원 · 10월 2일(금) 15:30 장마감 기준" in html
    # ④ 점수·확률 막대
    assert "검토 점수" in html and "88점" in html and "신뢰도" in html and "74%" in html and "55%" in html
    # ⑤ 근거·리스크·리스크 점검
    assert "수급 개선" in html and "외국인 매도" in html and "리스크 점검: 보통" in html and "단기 과열 주의" in html
    # ⑥ 꼬리: Agent·모델, 자동 복구, 비용, 생성 시각, 문구
    assert "뉴스 Agent — model-b (demo)" in html and "작성 Agent — model-c" in html
    assert "장애 1건 · 자동 복구 1건" in html and "복구 시간 합 3.0초" in html
    assert "뉴스 Agent: timeout 실패 1회 (model-a → model-b) → model-b로 복구" in html
    assert "비용 $0.0345" in html and "KST · 모매매" in html
    assert html.count(pdf.DISCLAIMER) == 2 and "AI는 제안만 합니다" not in html  # 위 상자와 꼬리말, 통일 문장 하나
    assert html.count("투자 권유가 아닙니다") == 2  # 쪽 머리가 면책을 한 번 더 말하지 않는다
    assert html.index(pdf.DISCLAIMER, html.index('<div class="foot">')) > 0
    assert forbidden_phrases(text_of(html)) == []


def test_empty_results_report_still_renders(user, monkeypatch):
    def down(symbol):
        raise RuntimeError("시세 조회 불가")
    monkeypatch.setattr(market, "completed_candles", down)
    monkeypatch.setattr(market, "candles", no_live_candles)
    report = make_report(user, status=Report.COMPLETED)
    html = pdf.build_report_html(report, [])
    assert "시세 자료 없음" in html and '<svg class="chart"' not in html and "종가 기준 ·" not in html
    assert '<svg class="logo"' in html  # 쪽 머리 로고는 자료와 상관없이 늘 있다
    assert html.count("자료 없음") >= 5 and "AI 의견 없음" in html and "Agent 실행 기록 없음" in html
    easy = html.split('<div class="easy">')[1].split("</div>")[0]
    assert '<p class="empty">자료 없음</p>' in easy and pdf.DISCLAIMER in easy  # 쉬운 요약이 없어도 상자와 면책 문장
    assert "시세 지표 기준 시각: 자료 없음" in html
    assert "삼성전자" in html and html.count(pdf.DISCLAIMER) == 2
    assert forbidden_phrases(text_of(html)) == []


def test_market_basis_label(user, candles):
    """시세 지표 기준 줄: asOf가 있으면 그 시장 현지 시각의 장마감 기준 (미국은 뉴욕), 읽지 못하면 자료 없음 (가격도 숨긴다)."""
    def html_for(symbol, market_agent):
        return pdf.build_report_html(make_report(user, symbol, status=Report.COMPLETED,
                                                 results={"market_agent": market_agent}), [])

    us = html_for("AAPL", {"price": 180.5, "asOf": "2026-10-02T16:00:00-04:00"})
    assert "시세 지표: 종가 180.50달러 · 10월 2일(금) 16:00(뉴욕) 장마감 기준" in us
    utc = html_for("005930", {"price": 72000, "asOf": "2026-10-02T06:30:00+00:00"})  # 국내는 KST로 바꿔 적는다
    assert "10월 2일(금) 15:30 장마감 기준" in utc
    no_price = html_for("005930", {"asOf": "2026-10-02T15:30:00+09:00"})
    assert "시세 지표: 10월 2일(금) 15:30 장마감 기준" in no_price
    for bad in ("어제", "2026-10-02T15:30:00", None, 20261002):  # 형식이 틀림 · 시간대 없음 · 없음 · 숫자
        html = html_for("005930", {"price": 72000, "asOf": bad})
        assert "시세 지표 기준 시각: 자료 없음" in html and "종가 72,000원" not in html, bad
    # 장 중에 만든 리포트 (docs/API.md "리포트 시세"): 장중 가격과 받은 시각 (그 시장 현지 시각)
    live = html_for("005930", {"price": 71500, "asOf": "2026-10-08T11:20:05+09:00", "priceBasis": "live"})
    assert "시세 지표: 장중 가격 71,500원 · 10월 8일(목) 11:20 기준" in live and "장마감 기준" not in live
    us_live = html_for("AAPL", {"price": 180.5, "asOf": "2026-10-08T00:20:05+09:00", "priceBasis": "live"})
    assert "시세 지표: 장중 가격 180.50달러 · 10월 7일(수) 11:20(뉴욕) 기준" in us_live
    bad_live = html_for("005930", {"price": 71500, "asOf": "어제", "priceBasis": "live"})
    assert "시세 지표 기준 시각: 자료 없음" in bad_live and "71,500원" not in bad_live


def test_report_html_escapes_values(user, candles):
    evil = "<script>alert(1)</script>"
    report = make_report(user, status=Report.COMPLETED, results={
        "market_agent": {"asOf": evil, "price": 1},
        "report_agent": {"verdict": evil, "oneLiner": evil, "plainSummary": [evil], "reasons": [evil], "risks": [evil],
                         "targets": {}},
        "risk_agent": {"level": evil, "warnings": [evil], "summary": evil}})
    report.name = evil
    report.save()
    trace = [event(report, 1, evil, "agent_completed", "completed", model=evil, provider=evil)]
    html = pdf.build_report_html(report, trace)
    assert "<script>" not in html and "&lt;script&gt;" in html


def test_report_html_has_no_login_id_or_secrets(user, candles):
    report, trace = full_report(user)
    html = pdf.build_report_html(report, trace)
    assert "alice" not in html and "앨리스" not in html  # 신청자(아이디·닉네임)는 넣지 않는다
    assert not re.search(r"(?i)secret|token|password|api[_-]?key|authorization|bearer|sk-[a-z0-9]{8}", html)


def test_chart_handles_us_market_and_missing_targets(user, monkeypatch):
    monkeypatch.setattr(market, "completed_candles", lambda symbol: candle_rows(30, 180))
    monkeypatch.setattr(market, "candles", no_live_candles)
    report = make_report(user, "AAPL", status=Report.COMPLETED, results={"report_agent": {"targets": {"entry": None}}})
    html = pdf.build_report_html(report, [])
    chart = html.split('<svg class="chart"')[1].split("</svg>")[0]
    assert "<rect" in chart and "진입" not in chart  # 값이 없는 가로선은 그리지 않는다
    assert "2026-07-30 종가 기준" in html


def test_as_of_formatter():
    assert pdf._as_of("2026-10-05T15:30:00+09:00", "KR") == "10월 5일(월) 15:30 장마감 기준"
    assert pdf._as_of("2026-10-05T20:00:00+00:00", "US") == "10월 5일(월) 16:00(뉴욕) 장마감 기준"  # 서머타임(EDT)
    assert pdf._as_of("2026-12-04T21:00:00+00:00", "US") == "12월 4일(금) 16:00(뉴욕) 장마감 기준"  # 표준시(EST)
    assert pdf._as_of("2026-10-05T15:30:00", "KR") is None and pdf._as_of("x", "KR") is None


# --- 선별 표지 ---

SCREENING = {
    "market": "KR", "at": "2026-10-05T08:05:00+09:00", "rankCount": 100, "eligibleCount": 82, "checked": 20,
    "picks": [
        {"symbol": "005930", "name": "삼성전자", "score": 82.5, "trading_amount": 9.5e11, "tradingAmountRank": 1},
        {"symbol": "000660", "name": "SK하이닉스", "score": 74.0, "trading_amount": 6.1e11, "tradingAmountRank": 2},
    ],
    "dropped": [{"symbol": "A", "name": "에이", "reason": "RSI 과열"}, {"symbol": "B", "name": "비", "reason": "RSI 과열"},
                {"symbol": "C", "name": "씨", "reason": "<b>추세 약함</b>"}],
    "excluded": [{"symbol": "E", "name": "ETF", "reason": "종목 유형 ETF"}], "reportIds": [1],
}


def test_screening_cover(user):
    done = make_report(user, status=Report.COMPLETED, results=RESULTS)
    running = make_report(user, "AAPL", status=Report.RUNNING,
                          results={"report_agent": {"verdict": "avoid", "oneLiner": "검토 전 초안"}})
    html = pdf.build_screening_html(SCREENING, [done, running])
    assert "<title>선별 요약 · KR · 모매매</title>" in html and '<header class="brand">' in html
    assert "선별 요약 · KR" in html and html.count('<svg class="chart"') == 2 and html.count("<rect") >= 4
    assert "삼성전자" in html and "82.5점" in html and "1위 · 9,500억" in html
    assert "RSI 과열 — 2종목" in html and "종목 유형 ETF — 1종목" in html
    assert "&lt;b&gt;추세 약함&lt;/b&gt;" in html and "<b>추세" not in html
    assert "삼성전자 (005930)" in html and "단기 반등 구간" in html and "선별 2 · 탈락 3 · 제외 1" in html
    assert "<th>AI 의견</th><th>한 줄 요약</th>" in html and "<td>긍정적</td>" in html
    assert "검토 전 초안" not in html and "<td>부정적</td>" not in html  # 완성 전 리포트의 초안은 목록 카드처럼 내지 않는다
    assert pdf.DISCLAIMER in html and "AI는 제안만 합니다" not in html
    assert forbidden_phrases(text_of(html)) == []


RULE_NOTE = "선별은 AI가 아니라 규칙 점수(결정론적 코드)로 한 것입니다."


@pytest.mark.parametrize("extra, note", [
    ({}, RULE_NOTE),                                                      # 예전 파일 (선정 키 없음)
    ({"selectedBy": None, "fallbackReason": None}, RULE_NOTE),           # 아직 선정 중
    ({"selectedBy": "ai", "fallbackReason": None},
     "AI 선정 팀이 순위를 매기고 안전장치(규칙 코드)가 거른 결과입니다."),
    ({"selectedBy": "rule", "fallbackReason": "no_candidates"}, f"{RULE_NOTE} 규칙 선별을 통과한 종목이 없었어요."),
    ({"selectedBy": "rule", "fallbackReason": "timeout"},
     f"{RULE_NOTE} AI 선정 팀을 쓰지 못한 이유: 시간이 너무 오래 걸려 멈췄어요."),
    ({"selectedBy": "rule", "fallbackReason": "no_llm"},
     f"{RULE_NOTE} AI 선정 팀을 쓰지 못한 이유: AI 연결 설정이 없어 AI가 고르지 못했어요."),
    ({"selectedBy": "rule", "fallbackReason": "agent_failed"},
     f"{RULE_NOTE} AI 선정 팀을 쓰지 못한 이유: 필요한 AI가 끝내 응답하지 않아 멈췄어요."),
    ({"selectedBy": "rule", "fallbackReason": None}, RULE_NOTE),
    ({"selectedBy": "rule", "fallbackReason": "<b>모르는_코드</b>"}, RULE_NOTE),  # 모르는 코드는 사유 없이
    ({"selectedBy": "모름"}, RULE_NOTE),
])
def test_screening_cover_footer_says_how_picks_were_chosen(extra, note):
    """꼬리말: ai면 AI 선정 팀 + 안전장치, rule이면 규칙 문장 + Fallback 사유, 선정 키가 없거나 null이면 규칙 문장."""
    html = pdf.build_screening_html(SCREENING | extra, [])
    (foot,) = re.findall(r'<p class="foot small">(.*?)</p>', html)
    assert foot == f"{pdf.SERVICE_NAME} · {note} {pdf.DISCLAIMER}"
    assert "모르는_코드" not in html and forbidden_phrases(text_of(html)) == []
    if extra.get("selectedBy") == "ai":
        assert "AI가 아니라" not in html


def test_screening_cover_empty():
    assert "선별 자료 없음" in pdf.build_screening_html({}, [])
    html = pdf.build_screening_html({"market": "US", "picks": [], "dropped": [], "excluded": []}, [])
    assert html.count("자료 없음") >= 5


# --- API ---

def url(report, view="expert"):
    """PDF 주소. 이 파일은 자세한 판을 본다 — view가 없으면 신청자(alice, 프로필 없음 = 주린이모드 켬)의 쉬운 판이 된다."""
    return f"/api/reports/{report.id}/pdf?view={view}"


def fake_render(calls):
    def render(html, pdf_path, chrome_bin=None, run=subprocess.run):
        calls.append((html, pdf_path, chrome_bin))
        pdf_path.parent.mkdir(parents=True, exist_ok=True)
        pdf_path.write_bytes(b"%PDF-fake")
        return pdf_path
    return render


def test_pdf_requires_login(client, user):
    assert client.get(url(make_report(user, status=Report.COMPLETED))).status_code == 401


@pytest.mark.parametrize("state", [Report.REQUESTED, Report.RUNNING, Report.FAILED])
def test_pdf_not_ready_is_409(api, user, files, state):
    response = api.get(url(make_report(user, status=state)))
    assert response.status_code == 409 and response.json() == {"detail": "리포트가 아직 완성되지 않았습니다."}


def test_pdf_missing_report_is_404(api, files):
    assert api.get("/api/reports/999/pdf").status_code == 404


@pytest.mark.parametrize("state", [Report.COMPLETED, Report.RUNNING])
def test_pdf_of_selection_run_is_404(api, files, monkeypatch, state):
    """매매 종목 선정 실행(team stock_selection)은 종목 리포트 양식이 아니라 PDF가 없다 (완성돼도)."""
    calls = []
    monkeypatch.setattr(pdf, "render_pdf", fake_render(calls))
    selection = Report.objects.create(team=Report.STOCK_SELECTION, source=Report.AUTO, symbol="KR",
                                      name="오늘의 매매 종목 선정", market="KR", status=state)
    response = api.get(url(selection))
    assert response.status_code == 404 and response.json() == {"detail": "선정 실행은 PDF가 없습니다."}
    assert calls == [] and not (files / "reports").exists()


def test_pdf_is_made_once_then_reused(api, user, files, candles, monkeypatch):
    calls = []
    monkeypatch.setattr(pdf, "render_pdf", fake_render(calls))
    report, _ = full_report(user)
    first = api.get(url(report))
    assert first.status_code == 200 and first["Content-Type"] == "application/pdf"
    assert b"".join(first.streaming_content) == b"%PDF-fake"
    html, path, chrome_bin = calls[0]
    assert "단기 반등 구간" in html and chrome_bin is None and path.parent == files / "reports"
    assert (files / "reports" / pdf_name(report)).exists()
    assert [p.name for p in (files / "reports").iterdir()] == [pdf_name(report)]  # 임시 파일이 남지 않는다
    second = api.get(url(report))
    assert second.status_code == 200 and b"".join(second.streaming_content) == b"%PDF-fake"
    assert len(calls) == 1  # 남은 파일을 쓴다


def test_pdf_passes_configured_chrome(api, user, files, candles, monkeypatch):
    calls = []
    monkeypatch.setattr(pdf, "render_pdf", fake_render(calls))
    monkeypatch.setattr(engine, "engine_config", lambda: SimpleNamespace(chrome_bin="/opt/chrome"))
    assert api.get(url(make_report(user, status=Report.COMPLETED))).status_code == 200
    assert calls[0][2] == "/opt/chrome"


def test_pdf_without_chrome_serves_html(api, user, files, candles, monkeypatch):
    monkeypatch.setattr(engine_report, "find_chrome", lambda configured=None: None)
    report, _ = full_report(user)
    response = api.get(url(report))
    assert response.status_code == 200 and response["Content-Type"].startswith("text/html")
    assert "단기 반등 구간" in b"".join(response.streaming_content).decode()
    assert [p.name for p in (files / "reports").iterdir()] == [pdf_name(report, ".html")]
    again = api.get(url(report))  # 남은 HTML을 다시 쓴다
    assert again.status_code == 200 and again["Content-Type"].startswith("text/html")


def test_pdf_render_failure_falls_back_to_html(api, user, files, candles, monkeypatch):
    monkeypatch.setattr(engine_report, "find_chrome", lambda configured=None: "/usr/bin/chrome")

    def boom(args, **kw):
        raise subprocess.CalledProcessError(1, args)
    report, _ = full_report(user)
    monkeypatch.setattr(pdf, "render_pdf",
                        lambda html, path, chrome_bin=None: engine_report.render_pdf(html, path, chrome_bin, boom))
    response = api.get(url(report))
    assert response.status_code == 200 and response["Content-Type"].startswith("text/html")
    assert [p.name for p in (files / "reports").iterdir()] == [pdf_name(report, ".html")]


def test_pdf_of_older_template_is_made_again(api, user, files, candles, monkeypatch):
    """양식 판이 오르면 예전 판 파일(판 번호 없는 <id>.pdf = 1판)을 쓰지 않고 새로 만든 뒤 지운다. 다른 리포트 파일은 그대로."""
    calls = []
    monkeypatch.setattr(pdf, "render_pdf", fake_render(calls))
    report, _ = full_report(user)
    folder = files / "reports"
    folder.mkdir()
    (folder / f"{report.id}.pdf").write_bytes(b"%PDF-old")
    (folder / f"{report.id}.html").write_text("old", encoding="utf-8")
    (folder / f"{report.id}.v2.pdf").write_bytes(b"%PDF-v2")  # 2판 (옛 이름, 로고 없음)
    (folder / f"{report.id + 1}.pdf").write_bytes(b"%PDF-other")
    response = api.get(url(report))
    assert response.status_code == 200 and b"".join(response.streaming_content) == b"%PDF-fake"
    assert len(calls) == 1 and '<header class="brand">' in calls[0][0] and "리포트 데스크" not in calls[0][0]  # 옛 이름(D-5)
    assert sorted(p.name for p in folder.iterdir()) == sorted([pdf_name(report), f"{report.id + 1}.pdf"])


def test_file_stem():
    assert pdf._file_stem(7, 1) == "7" and pdf._file_stem(7, 2) == "7.v2"
    assert pdf.TEMPLATE_VERSION == 5 and pdf._file_stem(7, pdf.TEMPLATE_VERSION) == "7.v5"  # 5판: 로고 ㅁ 블록 셋


def test_logo_shapes_match_frontend():
    """PDF 머리 로고의 도형 값이 화면 로고(frontend/src/lib/brandShapes.ts)와 같다 — 한쪽만 바꾸면 PDF와 화면의 로고가 달라진다."""
    shapes = (Path(__file__).resolve().parents[4] / "frontend" / "src" / "lib" / "brandShapes.ts").read_text(encoding="utf-8")
    assert f'export const MU_PATH = "{pdf.MU_PATH}";' in shapes
    assert f"export const ICON_BLOCK_SCALE = {pdf.ICON_BLOCK_SCALE};" in shapes
    blocks = shapes.split("export const ICON_BLOCKS = [")[1].split("]")[0]
    found = tuple((float(x), float(y)) for x, y in re.findall(r"\{ x: ([\d.]+), y: ([\d.]+) \}", blocks))
    assert found == pdf.ICON_BLOCKS
