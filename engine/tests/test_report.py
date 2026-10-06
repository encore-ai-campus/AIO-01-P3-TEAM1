import json
import subprocess

from paper_engine import report
from paper_engine.judge.reach import check_reach
from paper_engine.judge.risk import AccountContext, assess
from paper_engine.judge.scenario import Scenario
from paper_engine.judge.verdict import Approval, Candidate, Critique
from paper_engine.notify import format_recommendation

ACCOUNT = AccountContext(equity_krw=10_000_000, buying_power=10_000_000, commission_rate=0.0)


def candidate(approved=True, score=72.0):
    s = Scenario(symbol="005930", currency="KRW", horizon="SWING", entry_price=100_000,
                 target_price=115_000, stop_price=95_000, probability=0.55, holding_days=10,
                 analyst="gpt", rationale=["20일선 위에서 거래량이 늘었다", "외국인 순매수 5일 연속",
                                           "실적 발표가 보유 기간 밖이다", "네 번째 근거"],
                 invalidation="종가가 20일선 아래로 내려가면 무효")
    return Candidate(
        id="S1", proposer="gpt", raw={}, scenario=s, final=s, proposer_score=80, score=score,
        participation=1.0, consensus_probability=0.55, assessment=assess(s, ACCOUNT),
        critiques=[Critique("gemini", 75, 0.6, ["목표가가 직전 고점 바로 아래다", "둘째 약점"], "실행할 만하다"),
                   Critique("deepseek", 62, 0.5, ["수급 근거가 5일뿐이다"], "애매하다")],
        approval=Approval(approved, "근거가 데이터와 맞고 위험이 관리된다", ["실적 시즌 변동성", "환율"], "claude"),
        reach=check_reach(100_000, 115_000, 10, 4_000))


def as_log(*candidates, **extra):
    import dataclasses
    return {"startedAt": "2026-09-29T08:01:00+09:00", "strategy": None, "paperBuy": False, "costUsd": 0.31,
            "analysts": [{"id": "gpt", "size": "medium"}], "researchers": ["gpt"], "approver": "claude",
            "results": [{"snapshot": {"symbol": "005930", "name": "삼성전자 <b>", "currency": "KRW",
                                      "lastPrice": 100_000, "indicators": {"rsi14": 55.0},
                                      "news": [{"title": "뉴스 & 제목"}],
                                      "webResearch": {"researchers": [{"id": "R1", "findings": [
                                          {"claim": "수주 공시", "direction": "POSITIVE", "date": "2026-09-28",
                                           "sourceTitle": "출처", "sourceVerified": False}],
                                          "upcomingEvents": [{"date": "2026-10-20", "event": "실적 발표"}]}]}},
                         "research": {"researchers": {"R1": "완료"}}, "errors": ["검증 누락: S9"],
                         "stages": [{"stage": "웹 조사", "calls": 2, "seconds": 40, "costUsd": 0.2}],
                         "costUsd": 0.31,
                         "candidates": [dataclasses.asdict(c) | {
                             "passed": c.passed, "selected": c.selected, "rejectReasons": c.reject_reasons}
                             for c in candidates]}]} | extra


# --- 추천 카드 (팀 채널) ---

def test_recommendation_summarizes_reasoning_in_three_steps():
    text = format_recommendation(candidate(), "삼성전자")
    assert text.startswith("[매수 추천] 삼성전자 (005930) · 스윙 10거래일")
    assert "진입 100,000원 / 목표 115,000원 (+15.0%) / 손절 95,000원 (-5.0%)" in text
    assert "점수 72점 (기준 60) · 목표 도달 확률 55% (AI 추정)" in text
    assert "목표 도달 점검:" in text
    assert "① 제안 (gpt, 자기 평가 80점)" in text and "네 번째 근거" not in text  # 근거는 3개까지
    assert "② 검증 (2개 모델, 62~75점)" in text
    # 점수를 낮게 준 검증자의 약점이 먼저, 검증자마다 하나씩
    assert text.index("약점 (deepseek): 수급 근거가 5일뿐이다") < text.index("약점 (gemini): 목표가가")
    assert "둘째 약점" not in text and "총평 (gemini): 실행할 만하다" in text
    assert "③ 최종 컨펌 (claude): 승인 · 근거가 데이터와 맞고" in text and "남은 위험: 환율" in text
    assert text.endswith("무효화 조건: 종가가 20일선 아래로 내려가면 무효")
    assert len(text) < 2000  # Discord 메시지 하나에 들어간다


def test_recommendation_shortens_long_text():
    c = candidate()
    c.approval = Approval(True, "가" * 500, ["나" * 300], "claude")
    text = format_recommendation(c, "삼성전자")
    assert "가" * 239 + "…" in text and "가" * 240 not in text and "나" * 139 + "…" in text


# --- 리포트 ---

def test_report_has_all_evaluation_material_and_escapes_html():
    rejected = candidate(score=40.0)
    failed = Candidate(id="S3", proposer="deepseek", raw={}, fact_errors=["보유 기간 150거래일이 허용 범위를 벗어남"])
    html = report.build_html(as_log(candidate(), rejected, failed))
    assert "삼성전자 &lt;b&gt;" in html and "<b>삼성전자 <b>" not in html and "뉴스 &amp; 제목" in html
    assert html.count('class="tag pick">매수 추천') == 2  # 요약 표와 카드
    assert "교차검증 점수 40점이 기준 60점보다 낮음" in html  # 탈락 사유
    assert "사실·조건 검증 실패" in html and "보유 기간 150거래일" in html
    assert "수급 근거가 5일뿐이다" in html and "둘째 약점" in html  # 약점은 전부
    assert "수주 공시" in html and "출처 확인 안 됨" in html and "실적 발표" in html
    assert "검증 누락: S9" in html and "웹 조사 2회 40초" in html
    assert report.summary(as_log(candidate(), rejected, failed)) == {
        "symbols": 1, "scenarios": 3, "picks": 1, "rejected": 2, "failed": 0}



def test_report_horizon_labels_follow_notify():
    """기간 줄의 투자 기간 이름은 notify.horizon_label 하나를 쓴다 (모르는 값은 그대로)."""
    log = as_log(candidate())
    assert "스윙 · 보유 10거래일" in report.build_html(log)
    for horizon, label in (("LONG_TERM", "장기"), ("WEEKLY", "WEEKLY")):
        card = log["results"][0]["candidates"][0]
        card["final"]["horizon"] = card["scenario"]["horizon"] = horizon
        assert f"{label} · 보유 10거래일" in report.build_html(log)

def test_report_includes_screening_and_handles_old_or_empty_logs():
    screen = {"market": "KR", "rankCount": 100, "eligibleCount": 65, "checked": 30, "analyzed": ["096770"],
              "picks": [{"symbol": "096770", "name": "SK이노베이션", "score": 79.0, "close": 146_400,
                         "rsi": 56.0, "atr_ratio": 0.072, "change20d": 0.264, "trading_amount": 1.6e11}],
              "dropped": [{"symbol": "005380", "name": "현대차", "reason": "RSI 80", "tradingAmountRank": 4}],
              "excluded": [{"symbol": "069500", "name": "KODEX 200", "reason": "종목 유형 ETF"}]}
    html = report.build_html({"startedAt": "2026-09-29T08:00:00+09:00", "results": [], "screen": screen,
                              "strategy": {"id": 1, "name": "기본 국내 선별"}})
    assert "전략 #1 기본 국내 선별 리포트" in html and "SK이노베이션 (096770)" in html
    assert "RSI 80" in html and "KODEX 200(069500): 종목 유형 ETF" in html
    old = as_log(candidate(score=40.0))
    del old["results"][0]["candidates"][0]["rejectReasons"], old["results"][0]["candidates"][0]["reach"]
    assert "탈락" in report.build_html(old)  # 예전 기록도 읽는다
    error = {"results": [{"snapshot": {"symbol": "A", "name": "에이"}, "modelResponseError": "시간 초과"}]}
    assert "분석을 중단함" in report.build_html(error) and report.summary(error)["failed"] == 1


def test_write_report_uses_chrome_and_falls_back_to_html(tmp_path, monkeypatch):
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: "/usr/bin/chrome")
    calls = []

    def ok(args, **kw):
        calls.append(args)
        out = next(a for a in args if a.startswith("--print-to-pdf=")).split("=", 1)[1]
        open(out, "wb").write(b"%PDF")
        return subprocess.CompletedProcess(args, 0)

    path = report.write_report(as_log(candidate()), tmp_path / "runs" / "x.pdf", run=ok)
    assert path.name == "x.pdf" and path.exists() and not path.with_suffix(".html").exists()
    assert calls[0][0] == "/usr/bin/chrome" and calls[0][-1].startswith("file://")

    def fail(args, **kw):
        raise subprocess.CalledProcessError(1, args)

    path = report.write_report(as_log(candidate()), tmp_path / "y.pdf", run=fail)
    assert path.name == "y.html" and "매수 추천" in path.read_text()
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: None)
    assert report.write_report(as_log(), tmp_path / "z.pdf").name == "z.html"


def test_render_pdf_is_public_wrapper(tmp_path, monkeypatch):
    html = "<html><body>직접 만든 HTML</body></html>"
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: "/usr/bin/chrome")
    seen = []

    def ok(args, **kw):
        seen.append(args)
        out = next(a for a in args if a.startswith("--print-to-pdf=")).split("=", 1)[1]
        open(out, "wb").write(b"%PDF")
        return subprocess.CompletedProcess(args, 0)

    path = report.render_pdf(html, tmp_path / "r" / "1.pdf", run=ok)
    assert path.name == "1.pdf" and path.exists() and not path.with_suffix(".html").exists()
    assert seen[0][0] == "/usr/bin/chrome"

    def fail(args, **kw):
        raise subprocess.CalledProcessError(1, args)

    fallback = report.render_pdf(html, tmp_path / "r" / "2.pdf", run=fail)  # PDF 실패 → HTML 경로
    assert fallback.name == "2.html" and "직접 만든 HTML" in fallback.read_text(encoding="utf-8")
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: None)
    assert report.render_pdf(html, tmp_path / "r" / "3.pdf").name == "3.html"  # Chrome 없음 → HTML


# --- 파일 첨부와 결과 알림 ---

class Notes:
    def __init__(self):
        self.sent, self.logged, self.files = [], [], []

    def send(self, text):
        self.sent.append(text)

    def log(self, text):
        self.logged.append(text)

    def send_file(self, path, caption=""):
        self.files.append((path, caption))


def test_publish_report_sends_only_summary_with_file(tmp_path, monkeypatch):
    import paper_engine.__main__ as main
    from paper_engine.config import Config
    monkeypatch.setattr(main, "ROOT", tmp_path)
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: None)
    notes = Notes()
    log = as_log(candidate(), candidate(score=40.0), strategy={"id": 1, "name": "기본 국내 선별"},
                 screen={"market": "KR", "rankCount": 100, "eligibleCount": 65, "checked": 30,
                         "picks": [], "dropped": [], "excluded": []})
    path = main.publish_report(Config("id", "secret", None), notes, log, tmp_path / "runs" / "a.json",
                               ["삼성전자(005930)"])
    (sent_path, caption), = notes.files
    assert sent_path == path and notes.sent == []
    assert caption == ("[전략 #1 기본 국내 선별] 거래대금 상위 100개 중 규칙 통과 0개 · AI 분석 1종목 · "
                       "매수 추천 1개 (삼성전자(005930)) · 그 외 시나리오 1개는 추천하지 않음 · AI 비용 $0.31\n"
                       "전체 평가 자료는 첨부 리포트 참고")
    saved = json.loads((tmp_path / "runs" / "a.json").read_text())
    assert saved["reportFile"] == "runs/a.html" and saved["results"][0]["candidates"][1]["rejectReasons"]


def test_daily_analysis_report_has_its_own_head_and_title(tmp_path, monkeypatch):
    import paper_engine.__main__ as main
    from paper_engine.config import Config
    monkeypatch.setattr(main, "ROOT", tmp_path)
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: None)
    notes = Notes()
    log = as_log(candidate(), tag="daily")
    path = main.publish_report(Config("id", "secret", None), notes, log, tmp_path / "runs" / "a.json", [])
    assert notes.files[0][1].startswith("[일일 분석] AI 분석 1종목")
    assert "<h1>일일 분석 리포트</h1>" in path.read_text()


def test_run_file_name():
    import paper_engine.__main__ as main
    started = main.datetime(2026, 9, 30, 7, 0, 5)
    assert main._run_file_name(started, None, None) == "runs/20260930-070005.json"
    assert main._run_file_name(started, (2, "미국"), None) == "runs/20260930-070005-s2.json"
    assert main._run_file_name(started, None, "daily") == "runs/20260930-070005-daily.json"


def test_plan_without_buy_is_logged_not_sent():
    import paper_engine.__main__ as main
    notes = Notes()
    quiet = main._LogOnly(notes)
    quiet.send("주문 계획")
    assert notes.logged == ["주문 계획"] and notes.sent == []


def test_snapshot_shows_broker_reports_table():
    snap = {"symbol": "047810", "name": "한국항공우주", "currency": "KRW", "lastPrice": 150_000.0, "indicators": {},
            "brokerReports": [{"publishedAt": "2026-09-30T01:00:00+00:00", "source": "뉴스핌", "broker": "미래에셋증권",
                               "targetPrice": 186_000.0, "direction": "UP",
                               "title": "[리포트 브리핑]한국항공우주, 'KF-21' <목표가> 186,000원"},
                              {"publishedAt": "2026-09-29T01:00:00+00:00", "source": "매체", "broker": None,
                               "targetPrice": None, "direction": None, "title": "한국항공우주 목표주가 고공행진"}]}
    html = report._snapshot(snap)
    assert "<th>날짜</th><th>증권사</th><th>목표가</th><th>방향</th><th>제목</th>" in html
    assert '<td class="n">2026-09-30</td><td>미래에셋증권</td><td class="n">186,000원</td><td>상향</td>' in html
    assert "&lt;목표가&gt;" in html and "<td>-</td>" in html
    empty = report._snapshot(dict(snap, brokerReports=[]))
    assert "증권사 리포트" in empty and "<p>없음</p>" in empty
    assert "증권사 리포트" not in report._snapshot({k: v for k, v in snap.items() if k != "brokerReports"})


def test_report_header_shows_paper_buy_mode():
    assert "기록만 (모의 주문 없음)" in report.build_html(as_log(candidate()))
    assert "승인 시 모의 매수" in report.build_html(as_log(candidate(), paperBuy=True))
