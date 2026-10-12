"""자동 리포트의 선별 (reports/autoreport/auto.py): 그날 파일, 점수 순 상위 N개, 증권사 키가 없으면 503. screen_market은 가짜다."""
import json
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

from config import engine
from config.api import Unavailable
from reports.autoreport import auto
from reports.output import pdf

REAL_REPORT_FILE = pdf.ensure_report_file   # day 픽스처가 가짜로 바꾸기 전의 진짜 (두 판 파일을 실제로 만드는 테스트)

KST = ZoneInfo("Asia/Seoul")
NOW = datetime(2026, 10, 5, 7, 50, tzinfo=KST)
PICKS = [{"symbol": "000660", "score": 50.0}, {"symbol": "005930", "score": 80.0},
         {"symbol": "035420", "score": 65.0}, {"symbol": "005380", "score": 70.0}]


@pytest.fixture
def screen(monkeypatch, tmp_path):
    calls = []
    cfg = object()

    def screen_market(config, market, candidates, **kw):
        calls.append((config, market, candidates))
        return {"market": market, "at": "2026-10-05T07:49:00+09:00", "rankedAt": None, "rankCount": 100,
                "eligibleCount": 70, "checked": candidates, "picks": [dict(p) for p in PICKS],
                "dropped": [{"symbol": "035720", "reason": "추세 아님"}], "excluded": [{"symbol": "069500", "reason": "ETF"}],
                "rules": "규칙"}

    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(engine, "engine_config", lambda: cfg)
    monkeypatch.setattr(engine, "broker_client", lambda: object())
    monkeypatch.setattr(auto, "screen_market", screen_market)
    return calls, cfg


def test_select_saves_top_picks_by_score(screen, tmp_path):
    calls, cfg = screen
    result = auto.select("KR", top=3, now=NOW)
    assert calls == [(cfg, "KR", auto.SCREEN_CANDIDATES)]
    assert [p["symbol"] for p in result["picks"]] == ["005930", "005380", "035420"]
    assert result["reportIds"] == [] and result["recommendationIds"] == []
    assert (result["rankCount"], result["eligibleCount"], result["checked"]) == (100, 70, auto.SCREEN_CANDIDATES)
    assert result["at"].startswith("2026-10-05T07:50:00")
    path = tmp_path / "runs" / "screening" / "2026-10-05-KR.json"
    assert json.loads(path.read_text(encoding="utf-8")) == result
    assert auto.load("KR", date(2026, 10, 5)) == result


def test_file_date_is_kst(screen, tmp_path):
    auto.select("KR", top=1, now=datetime(2026, 10, 4, 23, 30, tzinfo=ZoneInfo("UTC")))  # KST 10/5 08:30
    assert (tmp_path / "runs" / "screening" / "2026-10-05-KR.json").exists()


def test_save_updates_ids(screen):
    result = auto.select("KR", top=2, now=NOW)
    result["reportIds"] = [7]
    auto.save(result)
    assert auto.load("KR", date(2026, 10, 5))["reportIds"] == [7]


def test_load_missing_or_broken(screen, tmp_path):
    assert auto.load("KR", date(2026, 10, 5)) is None
    folder = tmp_path / "runs" / "screening"
    folder.mkdir(parents=True)
    (folder / "2026-10-05-KR.json").write_text("{", encoding="utf-8")
    assert auto.load("KR", date(2026, 10, 5)) is None


def test_select_without_broker_is_unavailable(screen, monkeypatch):
    calls, _ = screen
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    with pytest.raises(Unavailable):
        auto.select("KR", now=NOW)
    assert calls == []


# --- GET /api/reports/screening (T1-7) ---

@pytest.fixture
def screening_api(monkeypatch, tmp_path, django_user_model):
    from rest_framework.test import APIClient

    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")
    client = APIClient()
    client.force_authenticate(django_user_model.objects.create_user("alice", password="pw"))
    return client


def test_screening_api_reads_saved_file(screening_api):
    auto.save({"market": "KR", "at": "2026-10-05T07:50:00+09:00", "rankCount": 100, "eligibleCount": 70, "checked": 30,
               "picks": [{"symbol": "005930", "score": 80.0}], "dropped": [], "excluded": [], "reportIds": [],
               "recommendationIds": [7]})
    response = screening_api.get("/api/reports/screening?market=KR&date=2026-10-05")
    assert response.status_code == 200
    assert response.json()["picks"][0]["symbol"] == "005930" and response.json()["recommendationIds"] == [7]


def test_screening_api_404_and_bad_input(screening_api):
    assert screening_api.get("/api/reports/screening?date=2026-10-05").status_code == 404
    assert screening_api.get("/api/reports/screening?market=JP").status_code == 400
    assert screening_api.get("/api/reports/screening?date=10/05").status_code == 400


def test_screening_api_needs_login(db):
    from rest_framework.test import APIClient

    assert APIClient().get("/api/reports/screening").status_code == 401


def test_select_stores_all_candidates_by_score(screen):
    result = auto.select("KR", top=2, now=NOW)
    assert [p["symbol"] for p in result["candidates"]] == ["005930", "005380", "035420", "000660"]
    assert [p["symbol"] for p in result["picks"]] == ["005930", "005380"]


# --- 하루 파이프라인: tick → 선정 팀 → 선정 Guard → 종목 리포트 → 발송 (T1-4·T1-5) ---

DAY_AT = datetime(2026, 10, 5, 8, 30, tzinfo=KST)   # 월요일 08:30
CANDIDATES = [{"symbol": s, "name": n, "score": v} for s, n, v in (
    ("005930", "삼성전자", 80.0), ("005380", "현대차", 70.0), ("035420", "NAVER", 65.0), ("000660", "SK하이닉스", 50.0),
    ("042700", "한미반도체", 45.0))]
NEWS = {"summary": "뉴스", "items": [
    {"symbol": s, "sentiment": "neutral", "materials": [], "concerns": [], "theme": t, "evidence": []}
    for s, t in (("005930", "반도체"), ("042700", "반도체"), ("005380", "자동차"))]}
FILINGS = {"summary": "공시", "items": [{"symbol": "035420", "severity": "high", "signals": ["유상증자"], "evidence": []},
                                      {"symbol": "005930", "severity": "low", "signals": [], "evidence": []}]}
SELECTED = {"summary": "선정", "picks": [{"symbol": s, "rank": i, "reason": f"{s} 이유", "evidence": []} for i, s in
                                       enumerate(("999999", "000660", "035420", "042700", "005930"), 1)]}


class Notifier:
    def __init__(self):
        self.texts, self.files = [], []

    def send(self, text):
        self.texts.append(text)

    def send_file(self, path, caption=""):
        self.files.append((path, caption))

    def log(self, text):
        pass


class Log(list):
    def __call__(self, text):
        self.append(text)


@pytest.fixture
def day(monkeypatch, tmp_path, db):
    """AUTO_REPORT=on · 가짜 선별·장 달력·투자유의·notifier·리포트 파일. state["picks"]가 선별 결과, holiday면 그날 정규장 없음.
    state["report_files"]: 리포트 파일을 만들 때 받은 키워드 인자 (쉬운 판 easy=True인지 본다)."""
    from reports.autoreport import conf
    from reports.output import pdf
    from trading import market

    state = {"calls": [], "holiday": False, "picks": [dict(c) for c in CANDIDATES], "notifier": Notifier(),
             "warnings": {"000660": ["투자경고"]}, "report_files": []}

    def screen_market(config, market_, candidates, **kw):
        state["calls"].append(market_)
        return {"market": market_, "at": "2026-10-05T08:29:00+09:00", "rankCount": 100, "eligibleCount": 70,
                "checked": candidates, "picks": [dict(p) for p in state["picks"]], "dropped": [], "excluded": []}

    def sessions(market_):
        days = [DAY_AT.date() + timedelta(days=d) for d in (-1, 0, 1)]
        starts = [datetime.combine(d, datetime.min.time(), KST).replace(hour=9) for d in days
                  if not (state["holiday"] and d == DAY_AT.date())]
        return [(s, s + timedelta(hours=6, minutes=30)) for s in starts]

    def warnings(symbol):
        found = state["warnings"].get(symbol, [])
        if isinstance(found, Exception):
            raise found
        return found

    def report_file(report, trace, **kw):
        state["report_files"].append(kw)
        path = tmp_path / "reports" / f"{report.id}.html"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("리포트", encoding="utf-8")
        return path

    monkeypatch.setattr(engine, "RUNS_DIR", tmp_path / "runs")
    monkeypatch.setattr(engine, "ROOT", tmp_path)
    monkeypatch.setattr(engine, "engine_config", lambda: object())
    monkeypatch.setattr(engine, "broker_client", lambda: object())
    monkeypatch.setattr(engine, "notifier", lambda: state["notifier"])
    monkeypatch.setattr(auto, "screen_market", screen_market)
    monkeypatch.setattr(market, "sessions", sessions)
    monkeypatch.setattr(market, "warnings", warnings)
    monkeypatch.setattr(pdf, "ensure_report_file", report_file)
    monkeypatch.setattr(conf, "_dotenv", lambda: {})
    for key, value in {"AUTO_REPORT": "on", "AUTO_REPORT_AT": "08:00", "AUTO_REPORT_TOP": "3"}.items():
        monkeypatch.setenv(key, value)
    return state


def day_file(tmp_path) -> dict:
    return json.loads((tmp_path / "runs" / "screening" / "2026-10-05-KR.json").read_text(encoding="utf-8"))


def selection_report():
    from reports.models import Report

    return Report.objects.get(team=Report.STOCK_SELECTION)


def finish(report, results, status="completed", reason=None):
    """Orchestrator 대신 state 함수로 실행을 끝낸다."""
    from reports.orchestration import state

    state.start(report)
    for worker, result in results.items():
        state.add_result(report, worker, result)
    if status == "completed":
        state.record(report, "orchestrator", "workflow_completed", "completed")
    else:
        state.record(report, "orchestrator", "workflow_failed", "failed", details={"reason": reason})
    state.finish(report, status)
    return report


def test_tick_is_off_by_default(day, monkeypatch, tmp_path):
    monkeypatch.delenv("AUTO_REPORT")
    assert auto.tick(DAY_AT, Log()) == 0
    assert day["calls"] == [] and not (tmp_path / "runs").exists()


def test_tick_waits_for_report_time_and_trading_day(day):
    from reports.models import Report

    assert auto.tick(DAY_AT.replace(hour=7, minute=59), Log()) == 0
    day["holiday"] = True
    assert auto.tick(DAY_AT, Log()) == 0
    assert day["calls"] == [] and not Report.objects.exists()


def test_phase_a_requests_one_selection_run(day, tmp_path):
    from reports.models import Report

    log = Log()
    assert auto.tick(DAY_AT, log) == 0
    assert auto.tick(DAY_AT, log) == 0   # 두 번째: 선정 팀이 아직 끝나지 않음 → 기다린다
    report = selection_report()
    assert (report.source, report.user_id, report.chaos, report.symbol, report.market, report.status) == (
        "auto", None, None, "KR", "KR", "requested")
    assert report.name == auto.SELECTION_NAME and report.created_at == DAY_AT
    assert Report.objects.count() == 1 and day["calls"] == ["KR"]
    saved = day_file(tmp_path)
    assert saved["selection"] == {"reportId": report.id, "status": "running", "top": 3}
    assert saved["selectedBy"] is None and saved["fallbackReason"] is None
    assert [c["symbol"] for c in saved["candidates"]] == [c["symbol"] for c in CANDIDATES]
    assert [p["symbol"] for p in saved["picks"]] == ["005930", "005380", "035420"]   # 선정 전: 규칙 상위 (시연 추천 호환)
    assert "선정 팀 실행" in log[0]


def test_phase_a_uses_existing_file(day):
    auto.select("KR", top=3, now=DAY_AT)
    auto.tick(DAY_AT, Log())
    assert day["calls"] == ["KR"] and selection_report()


def test_without_broker_keys_tick_is_quiet(day, monkeypatch, tmp_path):
    """증권사 조회 키가 없으면 매일 건너뜀 표시·팀 채널 알림을 남기지 않고 조용히 넘어간다 (리뷰 C10)."""
    from reports.models import Report

    monkeypatch.setattr(engine, "broker_client", lambda: None)
    log = Log()
    assert auto.tick(DAY_AT, log) == 0
    assert not (tmp_path / "runs" / "screening" / "2026-10-05-KR.skip.json").exists()
    assert day["notifier"].texts == [] and len(log) == 0 and not Report.objects.exists()


def test_screening_failure_skips_the_day_once(day, monkeypatch, tmp_path):
    from reports.models import Report

    def broken(config, market_, candidates, **kw):
        raise Unavailable("증권사 조회 실패")
    monkeypatch.setattr(auto, "screen_market", broken)
    log = Log()
    assert auto.tick(DAY_AT, log) == 0
    assert auto.tick(DAY_AT.replace(hour=10), log) == 0
    assert (tmp_path / "runs" / "screening" / "2026-10-05-KR.skip.json").exists()
    assert len(day["notifier"].texts) == 1 and "건너뜁니다" in day["notifier"].texts[0]
    assert len(log) == 1 and not Report.objects.exists()


def test_running_selection_is_advanced_even_when_auto_report_is_off_and_after_midnight(day, monkeypatch, tmp_path):
    """명령(auto_report)으로 시작했거나 자정을 넘겨 끝난 선정도 다음 단계로 간다 (리뷰 C8·C9). US도 (C17)."""
    from reports.orchestration import state
    from reports.models import Report

    auto.tick(DAY_AT, Log())
    selection = Report.objects.get(team=Report.STOCK_SELECTION)
    state.start(selection)
    state.record(selection, "orchestrator", "workflow_failed", "failed", details={"reason": "timeout"})
    state.finish(selection, Report.FAILED)
    monkeypatch.setenv("AUTO_REPORT", "off")
    after_midnight = (DAY_AT + timedelta(days=1)).replace(hour=0, minute=10)
    assert auto.tick(after_midnight, Log()) == 3
    data = day_file(tmp_path)
    assert data["selection"]["status"] == "done" and data["selectedBy"] == "rule" and len(data["reportIds"]) == 3
def test_calendar_error_skips_the_day(day, monkeypatch, tmp_path):
    from trading import market

    def broken(market_):
        raise Unavailable("장 달력 조회 실패")
    monkeypatch.setattr(market, "sessions", broken)
    auto.tick(DAY_AT, Log())
    auto.tick(DAY_AT, Log())
    assert auto.skipped("KR", DAY_AT.date()) and len(day["notifier"].texts) == 1 and day["calls"] == []


def test_zero_candidates_falls_back_without_selection_team(day, tmp_path):
    from reports.models import Report

    day["picks"] = []
    auto.tick(DAY_AT, Log())
    saved = day_file(tmp_path)
    assert saved["selection"]["status"] == "done" and saved["selection"]["reportId"] is None
    assert (saved["selectedBy"], saved["fallbackReason"], saved["picks"]) == ("rule", "no_candidates", [])
    assert not Report.objects.exists()
    assert saved["coverSent"] is True and len(day["notifier"].files) == 1   # 기다릴 리포트가 없어 표지를 바로 보낸다


def test_phase_b_ai_selection_goes_through_guard(day, tmp_path):
    from reports.models import Report

    auto.tick(DAY_AT, Log())
    finish(selection_report(), {"news_screen_agent": NEWS, "filing_screen_agent": FILINGS, "selector_agent": SELECTED})
    log = Log()
    assert auto.tick(DAY_AT.replace(hour=8, minute=40), log) == 3
    saved = day_file(tmp_path)
    assert (saved["selectedBy"], saved["fallbackReason"], saved["selection"]["status"]) == ("ai", None, "done")
    assert [p["symbol"] for p in saved["aiPicks"]] == ["999999", "000660", "035420", "042700", "005930"]
    assert [(f["symbol"], f["stage"]) for f in saved["filtered"]] == [
        ("999999", "candidates"), ("000660", "warnings"), ("035420", "filing")]
    picks = saved["picks"]
    assert [p["symbol"] for p in picks] == ["042700", "005930", "005380"]
    assert [(p["aiRank"], p["theme"], p["filledByRule"]) for p in picks] == [
        (4, "반도체", False), (5, "반도체", False), (None, "자동차", True)]
    assert picks[1]["score"] == 80.0   # 숫자는 코드 값
    reports = list(Report.objects.filter(team=Report.STOCK_REPORT).order_by("id"))
    assert saved["reportIds"] == [r.id for r in reports]
    assert [(r.symbol, r.name, r.source, r.user_id, r.status, r.created_at) for r in reports] == [
        ("042700", "한미반도체", "auto", None, "requested", DAY_AT.replace(hour=8, minute=40)),
        ("005930", "삼성전자", "auto", None, "requested", DAY_AT.replace(hour=8, minute=40)),
        ("005380", "현대차", "auto", None, "requested", DAY_AT.replace(hour=8, minute=40))]
    assert "AI 선정" in log[0] and "종목 리포트 3개" in log[0]
    assert auto.tick(DAY_AT.replace(hour=9), Log()) == 0   # 하루 한 번
    assert Report.objects.filter(team=Report.STOCK_REPORT).count() == 3


def test_phase_b_review_accepted_with_notes_still_counts_as_ai(day, tmp_path):
    """선정 검토가 마지막 검토에서 지적을 남긴 채 통과해도(acceptedWithNotes) 완료된 실행이라 AI 선정이다 (docs/DECISIONS.md 30장)."""
    auto.tick(DAY_AT, Log())
    review = {"verdict": "PASS", "score": 85, "acceptedWithNotes": True, "handoff": None, "instructions": "출처를 더한다",
              "issues": [{"claim": "005930 reason", "problem": "출처 누락", "fix": "출처를 더한다"}]}
    finish(selection_report(), {"news_screen_agent": NEWS, "filing_screen_agent": FILINGS, "selector_agent": SELECTED,
                                "selection_review_agent": review})
    assert auto.tick(DAY_AT.replace(hour=8, minute=40), Log()) == 3
    saved = day_file(tmp_path)
    assert (saved["selectedBy"], saved["fallbackReason"]) == ("ai", None)
    assert [p["symbol"] for p in saved["aiPicks"]] == [p["symbol"] for p in SELECTED["picks"]]
    assert [p["symbol"] for p in saved["picks"]] == ["042700", "005930", "005380"]


def test_phase_b_waits_while_selection_runs(day, tmp_path):
    from reports.orchestration import state

    auto.tick(DAY_AT, Log())
    state.start(selection_report())
    assert auto.tick(DAY_AT.replace(hour=8, minute=40), Log()) == 0
    assert day_file(tmp_path)["selection"]["status"] == "running"


@pytest.mark.parametrize("reason, expected", [("review_failed", "review_failed"), ("join_blocked", "join_blocked"),
                                              (None, "exception"), ("뭔지 모름", "exception")])
def test_phase_b_failed_selection_falls_back_to_rule(day, tmp_path, reason, expected):
    auto.tick(DAY_AT, Log())
    finish(selection_report(), {"news_screen_agent": NEWS, "filing_screen_agent": FILINGS}, "failed", reason)
    assert auto.tick(DAY_AT.replace(hour=8, minute=40), Log()) == 3
    saved = day_file(tmp_path)
    assert (saved["selectedBy"], saved["fallbackReason"], saved["aiPicks"]) == ("rule", expected, [])
    # 규칙 점수 순 + 선정 Guard (NAVER 고위험 공시, SK하이닉스 투자경고 제외)
    assert [p["symbol"] for p in saved["picks"]] == ["005930", "005380", "042700"]
    assert all(p["filledByRule"] and p["aiRank"] is None for p in saved["picks"])
    assert [(f["symbol"], f["stage"]) for f in saved["filtered"]] == [("035420", "filing"), ("000660", "warnings")]


def test_phase_b_missing_selection_row_falls_back(day, tmp_path):
    auto.tick(DAY_AT, Log())
    selection_report().delete()
    assert auto.tick(DAY_AT.replace(hour=8, minute=40), Log()) == 3
    assert (day_file(tmp_path)["selectedBy"], day_file(tmp_path)["fallbackReason"]) == ("rule", "exception")


def test_request_skips_same_day_auto_report(day, tmp_path):
    from reports.models import Report

    old = Report.objects.create(source="auto", user=None, symbol="005930", name="삼성전자", market="KR",
                                created_at=DAY_AT.replace(hour=1))
    result = auto.select("KR", top=2, now=DAY_AT)
    made = auto.request(result, now=DAY_AT)
    assert [r.symbol for r in made] == ["005380"]
    assert auto.load("KR", DAY_AT.date())["reportIds"] == [old.id, made[0].id]
    assert auto.request(auto.load("KR", DAY_AT.date()), now=DAY_AT) == []


# --- after_finish ---

def requested_day(day):
    """선정까지 끝내 종목 리포트 3개가 신청된 상태. 리포트 목록을 돌려준다."""
    from reports.models import Report

    auto.tick(DAY_AT, Log())
    finish(selection_report(), {"news_screen_agent": NEWS, "filing_screen_agent": FILINGS, "selector_agent": SELECTED})
    auto.tick(DAY_AT.replace(hour=8, minute=40), Log())
    return list(Report.objects.filter(team=Report.STOCK_REPORT).order_by("id"))


DRAFT = {"verdict": "buy", "oneLiner": "실적 개선 흐름", "markdown": "본문"}


@pytest.fixture
def recommend(monkeypatch):
    from types import SimpleNamespace

    from autotrade.recommend import sources

    made = []

    def from_report(report, now=None):
        made.append(report.id)
        return SimpleNamespace(id=900 + report.id)
    monkeypatch.setattr(sources, "from_report", from_report)
    return made


def test_after_finish_sends_completed_report_file_and_records_recommendation(day, tmp_path, recommend):
    from reports.models import Report

    reports = requested_day(day)
    report = finish(reports[0], {"report_agent": DRAFT})
    auto.after_finish(report)
    (path, caption), = day["notifier"].files
    assert path.name == f"{report.id}.html"
    assert caption.startswith(f"자동 리포트 {report.name}({report.symbol})") and "AI 의견: 긍정적" in caption
    assert "실적 개선 흐름" in caption
    assert Report.objects.get(pk=report.id).pdf_path == f"reports/{report.id}.html"
    assert day["report_files"] == [{"easy": True}, {}]   # Discord는 쉬운 판 (docs/DECISIONS.md 20장), 그 뒤 자세한 판도 만든다
    assert recommend == [report.id]
    saved = day_file(tmp_path)
    assert saved["recommendationIds"] == [900 + report.id] and saved["coverSent"] is False   # 나머지 2개가 아직


@pytest.fixture
def real_files(day, monkeypatch):
    """진짜 ensure_report_file + 가짜 render(Chrome 없이 PDF 바이트) + 가짜 완성 일봉. 만든 HTML 목록을 돌려준다."""
    from trading import market

    from ..output.test_pdf import candle_rows, fake_render

    calls = []
    monkeypatch.setattr(pdf, "ensure_report_file", REAL_REPORT_FILE)
    monkeypatch.setattr(pdf, "render_pdf", fake_render(calls))
    monkeypatch.setattr(engine, "engine_config", lambda: SimpleNamespace(chrome_bin=None))
    monkeypatch.setattr(market, "completed_candles", lambda symbol: candle_rows())
    return calls


def test_after_finish_makes_both_variants_and_sends_the_easy_one(day, tmp_path, recommend, real_files):
    """엔진 컨테이너(Chrome이 있는 곳)에서 두 판을 모두 PDF로 만든다 — 웹 컨테이너가 자세한 판을 처음 만들어 HTML로 굳지 않게.
    Discord에는 쉬운 판, pdf_path도 쉬운 판."""
    from reports.models import Report

    reports = requested_day(day)
    report = finish(reports[0], {"report_agent": DRAFT})
    auto.after_finish(report)
    folder = tmp_path / "reports"
    easy, expert = f"{report.id}.v{pdf.TEMPLATE_VERSION}.easy.pdf", f"{report.id}.v{pdf.TEMPLATE_VERSION}.pdf"
    assert sorted(p.name for p in folder.iterdir()) == sorted([easy, expert])
    (path, _caption), = day["notifier"].files
    assert path.name == easy and Report.objects.get(pk=report.id).pdf_path == f"reports/{easy}"
    made = [html for html, _path, _chrome in real_files]
    assert len(made) == 2 and "어떻게 만들었나요" in made[0] and "만든 Agent · 자동 복구" in made[1]


def test_after_finish_expert_failure_does_not_block_discord(day, tmp_path, recommend, real_files, monkeypatch, caplog):
    """자세한 판을 못 만들어도 Discord에는 쉬운 판이 간다 (로그만 남긴다)."""
    good = pdf.render_pdf

    def render(html, pdf_path, chrome_bin=None, **kw):
        if "만든 Agent · 자동 복구" in html:
            raise OSError("Chrome 고장")
        return good(html, pdf_path, chrome_bin)
    monkeypatch.setattr(pdf, "render_pdf", render)
    reports = requested_day(day)
    report = finish(reports[0], {"report_agent": DRAFT})
    auto.after_finish(report)
    (path, _caption), = day["notifier"].files
    assert path.name == f"{report.id}.v{pdf.TEMPLATE_VERSION}.easy.pdf" and day["notifier"].texts == []
    assert f"자동 리포트 #{report.id} 자세한 판 파일 만들기 실패" in caplog.text


def test_after_finish_failed_report_sends_text_once(day, recommend):
    reports = requested_day(day)
    report = finish(reports[1], {}, "failed", "review_failed")
    auto.after_finish(report)
    assert day["notifier"].files == [] and recommend == []
    assert day["notifier"].texts == [f"자동 리포트 실패: {report.name}({report.symbol}) — "
                                     "검토 AI가 근거와 맞지 않는 주장을 찾아 완성하지 않았어요"]


def test_after_finish_ignores_user_and_selection_reports(day, recommend, django_user_model):
    from reports.models import Report

    user = django_user_model.objects.create_user("alice", password="pw")
    mine = finish(Report.objects.create(user=user, symbol="005930", name="삼성전자", market="KR"), {"report_agent": DRAFT})
    auto.after_finish(mine)
    auto.tick(DAY_AT, Log())
    auto.after_finish(finish(selection_report(), {"selector_agent": SELECTED}))
    assert day["notifier"].files == [] and day["notifier"].texts == [] and recommend == []


def test_cover_sent_once_when_all_reports_finish(day, tmp_path, recommend):
    reports = requested_day(day)
    for report in reports[:2]:
        auto.after_finish(finish(report, {"report_agent": DRAFT}))
    assert len(day["notifier"].files) == 2   # 하나가 아직 → 표지 없음
    auto.after_finish(finish(reports[2], {"report_agent": DRAFT}))
    auto.after_finish(reports[2])   # 다시 불러도 표지는 한 번 더 가지 않는다
    covers = [(path, caption) for path, caption in day["notifier"].files if path.name.endswith(".cover.html")]
    assert len(covers) == 1 and covers[0][0].name == "2026-10-05-KR.cover.html"
    assert "AI 선정" in covers[0][1] and "리포트 3개" in covers[0][1]
    assert "한미반도체" in covers[0][0].read_text(encoding="utf-8")
    saved = day_file(tmp_path)
    assert saved["coverSent"] is True and saved["recommendationIds"] == [900 + r.id for r in reports]


def test_after_finish_never_raises(day, monkeypatch, recommend):
    from reports.output import pdf

    reports = requested_day(day)

    def broken(report, trace, **kw):
        raise OSError("Chrome 없음")
    monkeypatch.setattr(pdf, "ensure_report_file", broken)
    auto.after_finish(finish(reports[0], {"report_agent": DRAFT}))
    assert day["notifier"].files == [] and day["notifier"].texts[0].endswith("(파일을 만들지 못했습니다)")
    monkeypatch.setattr(engine, "notifier", lambda: (_ for _ in ()).throw(RuntimeError("notifier 고장")))
    auto.after_finish(reports[1])   # 아직 실행 전 → 아무것도 하지 않음
    auto.after_finish(finish(reports[1], {"report_agent": DRAFT}))   # 예외를 밖으로 내지 않는다


# --- 다시 시도: 손익비 기준을 넘는 추천이 없으면 다음 종목으로 최대 2번 (docs/DECISIONS.md 22장) ---

MORE = [{"symbol": s, "name": n, "score": v} for s, n, v in (
    ("000270", "기아", 40.0), ("068270", "셀트리온", 38.0), ("105560", "KB금융", 36.0),
    ("055550", "신한지주", 34.0), ("012450", "한화에어로스페이스", 32.0), ("009150", "삼성전기", 30.0),
    ("003550", "LG", 28.0))]


@pytest.fixture
def rated(day, monkeypatch):
    """진짜 추천 행을 만드는 from_report (손익비는 state["rr"][symbol], 없으면 0.7 — buy가 아니면 None) + 지금 = 그날 08:50.
    후보는 7개를 더해 12개다."""
    from autotrade.recommend import sources
    from autotrade.models import Recommendation

    state = {"rr": {}}
    day["picks"] = [*day["picks"], *(dict(c) for c in MORE)]

    def from_report(report, now=None):
        draft = (report.results or {}).get("report_agent") or {}
        if draft.get("verdict") != "buy":
            return None
        return Recommendation.objects.create(
            source=Recommendation.REPORT, report=report, symbol=report.symbol, name=report.name, market="KR",
            currency="KRW", entry_price=100, target_price=110, stop_price=95, holding_days=10, probability=0.5,
            target_return=0.1, stop_loss_rate=-0.05, reward_risk=state["rr"].get(report.symbol, 0.7),
            expected_return=0.01, summary="요약", valid_until=DAY_AT + timedelta(days=3))
    monkeypatch.setattr(sources, "from_report", from_report)
    monkeypatch.setattr(auto.timezone, "now", lambda: DAY_AT.replace(hour=8, minute=50))
    return state


def finish_round(reports, verdict="buy"):
    for report in reports:
        auto.after_finish(finish(report, {"report_agent": {**DRAFT, "verdict": verdict}}))


def new_reports(seen):
    from reports.models import Report

    return list(Report.objects.filter(team=Report.STOCK_REPORT).exclude(pk__in=[r.id for r in seen]).order_by("id"))


def covers(day):
    return [(path, caption) for path, caption in day["notifier"].files if path.name.endswith(".cover.html")]


def test_retry_twice_with_next_picks_when_no_recommendation_reaches_min_reward_risk(day, tmp_path, rated):
    first = requested_day(day)
    finish_round(first)   # 3개 모두 손익비 0.7
    saved = day_file(tmp_path)
    second = new_reports(first)
    assert saved["retries"] == 1 and not saved["coverSent"] and covers(day) == []
    assert [r.symbol for r in second] == ["000270", "068270", "105560"]   # 이미 고른·Guard가 뺀 종목 다음, 규칙 점수 순
    assert [(p["symbol"], p.get("retryRound"), p["filledByRule"]) for p in saved["picks"][3:]] == [
        ("000270", 1, True), ("068270", 1, True), ("105560", 1, True)]
    assert saved["reportIds"] == [r.id for r in first + second]
    assert day["notifier"].texts[-1] == ("자동 리포트 다시 시도 1/2: 손익비 1.5 이상인 추천이 없어 다음 종목으로 다시 만들어요 — "
                                         "기아(000270), 셀트리온(068270), KB금융(105560)")

    finish_round(second, verdict="hold")   # 추천 없음도 기준을 넘지 못한 것
    third = new_reports(first + second)
    assert day_file(tmp_path)["retries"] == 2 and [r.symbol for r in third] == ["055550", "012450", "009150"]

    finish_round(third)
    saved = day_file(tmp_path)
    assert saved["retries"] == 2 and saved["coverSent"] is True and len(saved["picks"]) == 9
    assert new_reports(first + second + third) == []   # 2번까지만
    (path, caption), = covers(day)
    assert caption.endswith("리포트 9개 (다시 시도 2번)") and "LG" not in path.read_text(encoding="utf-8")


def test_no_retry_when_a_recommendation_reaches_min_reward_risk(day, tmp_path, rated):
    rated["rr"]["005930"] = 1.5   # 기준과 같으면 넘은 것
    finish_round(requested_day(day))
    saved = day_file(tmp_path)
    assert "retries" not in saved and saved["coverSent"] is True and len(covers(day)) == 1
    assert covers(day)[0][1].endswith("리포트 3개")


def test_retry_stops_when_no_candidates_are_left(day, tmp_path, rated):
    day["picks"] = [dict(c) for c in CANDIDATES]   # 5개: 3개를 고르고 2개는 Guard가 뺐다 → 남은 종목 없음
    finish_round(requested_day(day))
    saved = day_file(tmp_path)
    assert "retries" not in saved and saved["coverSent"] is True


def test_no_retry_after_the_day(day, tmp_path, rated, monkeypatch):
    first = requested_day(day)
    monkeypatch.setattr(auto.timezone, "now", lambda: DAY_AT + timedelta(days=1))
    finish_round(first)
    saved = day_file(tmp_path)
    assert "retries" not in saved and saved["coverSent"] is True and new_reports(first) == []


def test_retry_failure_still_sends_cover(day, tmp_path, rated, monkeypatch):
    from reports.autoreport import selection

    first = requested_day(day)

    def broken(*args, **kwargs):
        raise RuntimeError("Guard 고장")
    monkeypatch.setattr(selection, "guard", broken)
    finish_round(first)
    assert day_file(tmp_path)["coverSent"] is True and new_reports(first) == []


# --- manage.py auto_report (T1-6) ---

def test_auto_report_command_wait_runs_whole_day(day, monkeypatch, tmp_path, recommend):
    import sys
    from io import StringIO
    from types import ModuleType

    from django.core.management import call_command
    from trading import service

    from reports.models import Report

    ran = []

    def run_report(report):
        ran.append(report.team)
        if report.team == Report.STOCK_SELECTION:
            finish(report, {"news_screen_agent": NEWS, "filing_screen_agent": FILINGS, "selector_agent": SELECTED})
        else:
            finish(report, {"report_agent": {**DRAFT, "verdict": "hold"}})

    fake = ModuleType("reports.orchestration.orchestrator")
    fake.run_report = run_report
    monkeypatch.setitem(sys.modules, "reports.orchestration.orchestrator", fake)
    monkeypatch.setattr(service, "now", lambda: DAY_AT.replace(hour=7))   # --force: 시각 조건 무시
    out = StringIO()
    call_command("auto_report", "--force", "--wait", "--top", "2", stdout=out)
    saved = day_file(tmp_path)
    assert ran == ["stock_selection", "stock_report", "stock_report"]
    assert saved["selectedBy"] == "ai" and [p["symbol"] for p in saved["picks"]] == ["042700", "005930"]
    assert all(r.status == "completed" for r in Report.objects.all())
    assert len(day["notifier"].files) == 3 and saved["coverSent"] is True   # 리포트 2개 + 표지
    assert "AI 선정" in out.getvalue()


def test_auto_report_command_checks_time_without_force(day, monkeypatch):
    from django.core.management import CommandError, call_command
    from trading import service

    monkeypatch.setattr(service, "now", lambda: DAY_AT.replace(hour=7))
    with pytest.raises(CommandError, match="08:00"):
        call_command("auto_report")


def test_auto_report_command_wait_also_runs_retry_rounds(day, monkeypatch, tmp_path, rated):
    import sys
    from io import StringIO
    from types import ModuleType

    from django.core.management import call_command
    from trading import service

    from reports.models import Report

    ran = []

    def run_report(report):
        ran.append(report.symbol)
        if report.team == Report.STOCK_SELECTION:
            finish(report, {"news_screen_agent": NEWS, "filing_screen_agent": FILINGS, "selector_agent": SELECTED})
        else:
            finish(report, {"report_agent": {**DRAFT, "verdict": "hold"}})

    fake = ModuleType("reports.orchestration.orchestrator")
    fake.run_report = run_report
    monkeypatch.setitem(sys.modules, "reports.orchestration.orchestrator", fake)
    monkeypatch.setattr(service, "now", lambda: DAY_AT.replace(hour=7))
    call_command("auto_report", "--force", "--wait", "--top", "2", stdout=StringIO())
    saved = day_file(tmp_path)
    assert ran == ["KR", "042700", "005930", "005380", "000270", "068270", "105560"]   # 선정 → 2개 → 다시 2개 → 다시 2개
    assert saved["retries"] == 2 and saved["coverSent"] is True
    assert all(r.status == "completed" for r in Report.objects.all())
