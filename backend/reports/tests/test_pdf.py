"""AI 리포트 A4 PDF: HTML 구성(종목 한 쪽·선별 표지)과 PDF API. 실제 Chrome·증권사는 부르지 않는다 (가짜 render·가짜 일봉)."""
import re
import subprocess
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from paper_engine import report as engine_report
from trading import market

from config import engine
from reports import pdf
from reports.models import Report, TraceEvent

from .conftest import make_report

pytestmark = pytest.mark.django_db

RESULTS = {
    "market_agent": {"trend": "up", "summary": "상승 추세", "price": 72000, "changePct": 1.25, "rsi": 61.3,
                     "volatilityPct": 2.4, "volumeRank": 3, "support": 70000, "resistance": 75000, "signals": [],
                     "evidence": []},
    "fundamental_agent": {"summary": "양호", "metrics": {"per": 12.5, "pbr": 1.1, "roe": 9.0}, "recentFilings": [],
                          "evidence": []},
    "report_agent": {"title": "삼성전자 리포트", "verdict": "buy", "oneLiner": "단기 반등 구간, 분할 접근", "markdown": "# x",
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


@pytest.fixture
def candles(monkeypatch):
    monkeypatch.setattr(market, "candles", lambda symbol: candle_rows())


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
    # ① 머리
    assert "삼성전자" in html and "005930" in html and "2026-10-04" in html
    assert ">매수<" in html and "단기 반등 구간, 분할 접근" in html
    # ② SVG 차트: 캔들, 20일 이동평균, 진입·목표·손절 가로선
    assert "<svg" in html and "<polyline" in html and html.count("<rect") > 60
    assert "진입 72,000" in html and "목표 77,000" in html and "손절 69,000" in html
    # ③ 지표 카드
    for text in ("+1.25%", "3위", "61.3", "2.40%", "12.5배", "1.10배"):
        assert text in html
    # ④ 점수·확률 막대
    assert "검토 점수" in html and "88점" in html and "신뢰도" in html and "74%" in html and "55%" in html
    # ⑤ 근거·리스크·리스크 점검
    assert "수급 개선" in html and "외국인 매도" in html and "리스크 점검: 보통" in html and "단기 과열 주의" in html
    # ⑥ 꼬리: Agent·모델, 자동 복구, 비용, 생성 시각, 문구
    assert "뉴스 Agent — model-b (demo)" in html and "작성 Agent — model-c" in html
    assert "장애 1건 · 자동 복구 1건" in html and "복구 시간 합 3.0초" in html
    assert "뉴스 Agent: timeout 실패 1회 (model-a → model-b) → model-b로 복구" in html
    assert "비용 $0.0345" in html and "KST" in html and "AI는 제안만 합니다" in html


def test_empty_results_report_still_renders(user, monkeypatch):
    def down(symbol):
        raise RuntimeError("시세 조회 불가")
    monkeypatch.setattr(market, "candles", down)
    report = make_report(user, status=Report.COMPLETED)
    html = pdf.build_report_html(report, [])
    assert "시세 자료 없음" in html and "<svg" not in html
    assert html.count("자료 없음") >= 5 and "판정 없음" in html and "Agent 실행 기록 없음" in html
    assert "삼성전자" in html and "AI는 제안만 합니다" in html


def test_report_html_escapes_values(user, candles):
    evil = "<script>alert(1)</script>"
    report = make_report(user, status=Report.COMPLETED, results={
        "report_agent": {"verdict": evil, "oneLiner": evil, "reasons": [evil], "risks": [evil], "targets": {}},
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
    monkeypatch.setattr(market, "candles", lambda symbol: candle_rows(30, 180))
    report = make_report(user, "AAPL", status=Report.COMPLETED, results={"report_agent": {"targets": {"entry": None}}})
    html = pdf.build_report_html(report, [])
    assert "<svg" in html and "진입" not in html.split("</svg>")[0]  # 값이 없는 가로선은 그리지 않는다


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
    html = pdf.build_screening_html(SCREENING, [done])
    assert "선별 요약 · KR" in html and "<svg" in html and html.count("<rect") >= 4
    assert "삼성전자" in html and "82.5점" in html and "1위 · 9,500억" in html
    assert "RSI 과열 — 2종목" in html and "종목 유형 ETF — 1종목" in html
    assert "&lt;b&gt;추세 약함&lt;/b&gt;" in html and "<b>추세" not in html
    assert "삼성전자 (005930)" in html and "단기 반등 구간" in html and "선별 2 · 탈락 3 · 제외 1" in html


def test_screening_cover_empty():
    assert "선별 자료 없음" in pdf.build_screening_html({}, [])
    html = pdf.build_screening_html({"market": "US", "picks": [], "dropped": [], "excluded": []}, [])
    assert html.count("자료 없음") >= 5


# --- API ---

def url(report):
    return f"/api/reports/{report.id}/pdf"


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


def test_pdf_is_made_once_then_reused(api, user, files, candles, monkeypatch):
    calls = []
    monkeypatch.setattr(pdf, "render_pdf", fake_render(calls))
    report, _ = full_report(user)
    first = api.get(url(report))
    assert first.status_code == 200 and first["Content-Type"] == "application/pdf"
    assert b"".join(first.streaming_content) == b"%PDF-fake"
    html, path, chrome_bin = calls[0]
    assert "단기 반등 구간" in html and chrome_bin is None and path.parent == files / "reports"
    assert (files / "reports" / f"{report.id}.pdf").exists()
    assert [p.name for p in (files / "reports").iterdir()] == [f"{report.id}.pdf"]  # 임시 파일이 남지 않는다
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
    assert [p.name for p in (files / "reports").iterdir()] == [f"{report.id}.html"]
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
    assert [p.name for p in (files / "reports").iterdir()] == [f"{report.id}.html"]
