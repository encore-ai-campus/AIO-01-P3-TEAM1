"""증권사 리포트 후보: 선별(screen_market)의 중복·제외 규칙과 출처, 전략의 AI 분석 대상과 모의 자동 매수. 네트워크·AI 없음."""
import argparse
from datetime import timedelta

import pytest

import paper_engine.__main__ as main
from paper_engine import info, report
from paper_engine.config import Config, parse_analysts
from paper_engine.judge import screen
from paper_engine.strategies import Strategy, StrategyBook

from test_scheduler import FakeRedis


def candles(rising: bool) -> list[dict]:
    """rising이면 규칙을 통과하는 완만한 상승 (종가가 60일선 위, RSI 중간), 아니면 하락 (60일선 아래)."""
    out, price = [], 100.0
    for i in range(130):
        price *= (1.004 if i % 3 else 0.994) if rising else (0.996 if i % 3 else 1.006)
        out.append({"timestamp": f"d{i:03d}", "openPrice": str(price), "highPrice": str(price * 1.02),
                    "lowPrice": str(price * 0.98), "closePrice": str(price), "volume": "1000"})
    return out


def test_candles_fixture_matches_rules():
    assert isinstance(screen.score("A", "a", candles(True), 1.0), screen.Pick)
    assert screen.score("B", "b", candles(False), 1.0) == "60일선 아래"


PASS = {"A", "R1", "R3"}  # 규칙을 통과하는 종목


class FakeClient:
    def __init__(self):
        self.candle_calls = []

    def rankings(self, type_, market, duration, count):
        return [{"symbol": "A", "rank": 1, "tradingAmount": "5e11"}, {"symbol": "B", "rank": 2, "tradingAmount": "4e11"}]

    def stocks(self, symbols):
        return [{"symbol": s, "name": f"종목{s}", "securityType": "ETF" if s == "E" else "STOCK", "status": "ACTIVE"}
                for s in symbols]

    def market_calendar(self, market):
        return {}  # 오늘 정보가 없으면 drop_incomplete는 봉을 그대로 둔다

    def daily_candles(self, symbol, count):
        self.candle_calls.append(symbol)
        return candles(symbol in PASS)


def found(*symbols):
    return [{"symbol": s, "name": f"종목{s}", "broker": "미래에셋증권", "targetPrice": 186_000.0, "direction": "UP",
             "title": f"[리포트 브리핑]종목{s}, '제목' 목표가 186,000원 - 미래에셋증권",
             "publishedAt": "2026-09-30T01:00:00+00:00", "source": "뉴스핌"} for s in symbols]


@pytest.fixture
def client(monkeypatch):
    c = FakeClient()
    monkeypatch.setattr(main, "_client", lambda cfg: c)
    monkeypatch.setattr(main, "listed_stocks", lambda client, markets: [])
    return c


def test_screen_without_reports_marks_origin_only(client, monkeypatch):
    monkeypatch.setattr(main.broker_reports, "candidates", lambda *a, **kw: pytest.fail("리포트를 조회하면 안 됨"))
    result = main.screen_market(None, "KR", 30)
    assert [(p["symbol"], p["origin"]) for p in result["picks"]] == [("A", "거래대금 상위")]
    assert [(d["symbol"], d["origin"]) for d in result["dropped"]] == [("B", "거래대금 상위")]
    assert "reportCandidates" not in result


def test_screen_reports_dedupes_excludes_and_tags_origin(client, monkeypatch):
    seen = {}

    def fake_candidates(market, listed):
        seen["market"] = market
        return found("A", "H", "M", "E", "R1", "R2", "R3", "R4")
    monkeypatch.setattr(main.broker_reports, "candidates", fake_candidates)
    monkeypatch.setattr(main, "REPORT_CANDIDATES", 4)
    result = main.screen_market(None, "KR", 30, reports=True, exclude={"H": "보유 종목", "M": "자동 관리 중"})
    assert seen["market"] == "KR"
    rc = result["reportCandidates"]
    assert len(rc["fetched"]) == 8 and rc["error"] is None
    assert [(x["symbol"], x["reason"]) for x in rc["skipped"]] == [
        ("A", "거래대금 상위 후보와 중복"), ("H", "보유 종목"), ("M", "자동 관리 중"),
        ("R4", "리포트 후보 4개 초과"), ("E", "종목 유형 ETF")]
    assert (rc["checked"], rc["passed"], rc["dropped"]) == (3, 2, 1)
    # 제외된 종목은 일봉도 받지 않는다 (A는 거래대금 후보로 한 번만)
    assert client.candle_calls == ["A", "B", "R1", "R2", "R3"]
    origins = {p["symbol"]: p["origin"] for p in result["picks"]}
    assert origins == {"A": "거래대금 상위", "R1": "증권사 리포트", "R3": "증권사 리포트"}
    r1 = next(p for p in result["picks"] if p["symbol"] == "R1")
    assert r1["broker"] == "미래에셋증권" and r1["targetPrice"] == 186_000.0 and r1["direction"] == "UP"
    assert r1["title"].startswith("[리포트 브리핑]") and r1["tradingAmountRank"] is None
    assert r1["trading_amount"] > 0  # 마지막 봉으로 어림한 거래대금
    assert [p["score"] for p in result["picks"]] == sorted((p["score"] for p in result["picks"]), reverse=True)
    r2 = next(d for d in result["dropped"] if d["symbol"] == "R2")
    assert r2["origin"] == "증권사 리포트" and r2["reason"] == "60일선 아래"

    text = main.format_screen(result, "#1 국내", None)
    assert "증권사 리포트 후보 8개 → 중복·제외 5개 → 점검 3개, 규칙 통과 2개" in text
    assert "(R1) " in text and "[리포트: 미래에셋증권 목표가 186,000원 ↑]" in text
    assert "리포트 후보 제외: 종목A(A) 거래대금 상위 후보와 중복, 종목H(H) 보유 종목" in text
    a_line = next(line for line in text.splitlines() if "(A) " in line)
    assert "[리포트" not in a_line


def test_screen_reports_failure_keeps_ranking_screen(client, monkeypatch):
    def down(*a, **kw):
        raise OSError("RSS down")
    monkeypatch.setattr(main.broker_reports, "candidates", down)
    result = main.screen_market(None, "US", 30, reports=True)
    assert [p["symbol"] for p in result["picks"]] == ["A"]
    assert result["reportCandidates"]["error"] == "OSError: RSS down"
    assert "리포트 조회 실패: OSError: RSS down" in main.format_screen(result, "미국", None)


def pick(symbol, score, origin="거래대금 상위"):
    return {"symbol": symbol, "score": score, "origin": origin}


def test_analysis_targets_keep_at_least_one_report_pick():
    picks = [pick("A", 90), pick("B", 80), pick("C", 70), pick("R", 60, "증권사 리포트"), pick("S", 50, "증권사 리포트")]
    assert main.analysis_targets(picks, 3) == ["A", "B", "R"]
    assert main.analysis_targets(picks, 1) == ["R"]
    assert main.analysis_targets(picks, 0) == []
    already = [pick("R", 95, "증권사 리포트"), pick("A", 90), pick("B", 80)]
    assert main.analysis_targets(already, 2) == ["R", "A"]
    assert main.analysis_targets([pick("A", 90), pick("B", 80)], 3) == ["A", "B"]  # 리포트 pick이 없으면 그대로
    assert main.analysis_targets([pick("A", 90)], 3) == ["A"]


class Log:
    def __init__(self):
        self.lines = []

    def log(self, text):
        self.lines.append(text)

    send = log


class Rate:
    def exchange_rate(self):
        return {"rate": "1400"}


def run(monkeypatch, s: Strategy, recent: dict | None = None, picks: list | None = None,
        exclude: dict | None = None) -> tuple[dict, dict]:
    seen = {}
    picks = picks or [pick("A", 90), pick("B", 80), pick("C", 70), pick("R", 60, "증권사 리포트")]
    for p in picks:
        p["name"] = f"종목{p['symbol']}"
    exclude = {"H": "보유 종목"} if exclude is None else exclude

    def fake_screen(cfg, market, candidates, reports=False, exclude=frozenset()):
        seen["screen"] = {"reports": reports, "exclude": exclude}
        return {"market": market, "at": "2026-09-30T07:00:00+09:00", "rankCount": 100, "eligibleCount": 60, "checked": 30, "picks": list(picks),
                "dropped": [], "excluded": []}

    def fake_analyze(args):
        seen["symbols"] = args.symbols
        seen["buy"], seen["by"] = args.buy, args.by
    monkeypatch.setattr(main, "screen_market", fake_screen)
    if recent is not None:  # None이면 진짜 recently_analyzed가 main.ROOT/runs를 읽는다
        monkeypatch.setattr(main, "recently_analyzed", lambda now: dict(recent))
    monkeypatch.setattr(main, "exclusions", lambda cfg, notifier, now, recent=None: dict(exclude))
    monkeypatch.setattr(main, "format_screen", lambda *a: "선별")
    monkeypatch.setattr(main, "cmd_analyze", fake_analyze)
    monkeypatch.setattr(main, "_client", lambda cfg: Rate())
    cfg = Config("id", "secret", None, llm_api_key="key", analysts=parse_analysts("a:medium,b:medium"))
    redis = FakeRedis()
    main.run_strategy(cfg, Log(), s, None, redis)
    return seen, main.scheduler.load_scan_result(redis, s.id)


def test_run_strategy_with_reports_analyzes_a_report_pick(monkeypatch):
    seen, saved = run(monkeypatch, Strategy(id=1, name="국내", market="KR", reports=True), recent={})
    assert seen["screen"] == {"reports": True, "exclude": {"H": "보유 종목"}}
    assert (seen["buy"], seen["by"]) == (False, "strategy:1")  # 알림만 전략은 모의 주문하지 않는다
    assert seen["symbols"] == ["A", "B", "R"] and saved["analyzed"] == ["A", "B", "R"]
    assert saved["skipped"] == []


DAILY_REASON = "이미 분석됨 (runs/20260930-070512-daily.json 07:05)"


def test_run_strategy_without_reports_skips_recent_analysis(monkeypatch):
    # 리포트 후보가 꺼진 전략도 제외 목록을 만들고, 최근 24시간 안에 분석한 1위는 빼고 4위로 채운다
    picks = [pick("A", 90), pick("B", 80), pick("C", 70), pick("D", 60), pick("F", 50)]
    seen, saved = run(monkeypatch, Strategy(id=2, name="국내", market="KR"), recent={"A": DAILY_REASON}, picks=picks)
    assert seen["screen"] == {"reports": False, "exclude": {"H": "보유 종목"}}
    assert seen["symbols"] == ["B", "C", "D"] and saved["analyzed"] == ["B", "C", "D"]
    assert saved["skipped"] == [{"symbol": "A", "name": "종목A", "reason": DAILY_REASON}]
    assert [p["symbol"] for p in saved["picks"]] == ["A", "B", "C", "D", "F"]  # 순위·점수는 그대로
    assert saved["picks"][0]["skipped"] == DAILY_REASON and "skipped" not in saved["picks"][1]


def test_run_strategy_analyzes_holdings_without_recent_analysis(monkeypatch):
    # 보유·자동 관리 종목은 리포트 후보에서만 빠지고, 분석 기록이 없으면 AI 분석 대상이 된다
    picks = [pick("H", 90), pick("M", 80), pick("C", 70), pick("R", 60, "증권사 리포트")]
    seen, saved = run(monkeypatch, Strategy(id=3, name="국내", market="KR", reports=True), recent={}, picks=picks,
                      exclude={"H": "보유 종목", "M": "자동 관리 중"})
    assert seen["symbols"] == ["H", "M", "R"] and saved["skipped"] == []


def test_run_strategy_reads_recent_runs_including_daily(monkeypatch, tmp_path):
    # 진짜 runs 기록: 1시간 전 일일 분석(A)은 빠지고, 25시간 전 전략 분석(B)은 빠지지 않는다
    now = main.datetime.now().astimezone()
    runs = tmp_path / "runs"
    runs.mkdir()
    for name, at, symbol, tag in (("20260930-070512-daily.json", now - timedelta(hours=1), "A", "daily"),
                                  ("20260929-060000-s1.json", now - timedelta(hours=25), "B", None)):
        (runs / name).write_text(main.json.dumps({"startedAt": at.isoformat(), "tag": tag, "results": [
            {"snapshot": {"symbol": symbol, "name": f"종목{symbol}"}, "candidates": []}]}))
    monkeypatch.setattr(main, "ROOT", tmp_path)
    picks = [pick("A", 90), pick("B", 80), pick("C", 70), pick("D", 60)]
    seen, saved = run(monkeypatch, Strategy(id=4, name="국내", market="KR"), picks=picks)
    assert seen["symbols"] == ["B", "C", "D"]
    at = now - timedelta(hours=1)
    when = f"{at:%H:%M}" if at.date() == now.date() else f"{at:%m-%d %H:%M}"
    assert saved["skipped"] == [{"symbol": "A", "name": "종목A",
                                 "reason": f"이미 분석됨 (runs/20260930-070512-daily.json {when})"}]


def test_recently_analyzed_reasons(monkeypatch, tmp_path):
    now = main.datetime.fromisoformat("2026-09-30T08:00:00+09:00")
    runs = tmp_path / "runs"
    runs.mkdir()
    for name, at, symbol, tag in (("20260930-070512-daily.json", "2026-09-30T07:05:12+09:00", "A", "daily"),
                                  ("20260929-200000-s1.json", "2026-09-29T20:00:00+09:00", "C", None),
                                  ("20260929-070000-s1.json", "2026-09-29T07:00:00+09:00", "B", None)):
        (runs / name).write_text(main.json.dumps({"startedAt": at, "tag": tag, "results": [
            {"snapshot": {"symbol": symbol, "name": f"종목{symbol}"}, "candidates": []}]}))
    monkeypatch.setattr(main, "ROOT", tmp_path)
    assert main.recently_analyzed(now) == {  # 25시간 전 기록(B)은 넣지 않는다
        "A": DAILY_REASON, "C": "이미 분석됨 (runs/20260929-200000-s1.json 09-29 20:00)"}


def test_analysis_targets_skip_recent_and_keep_report_rule():
    picks = [pick("A", 90), pick("B", 80), pick("C", 70), pick("R", 60, "증권사 리포트"), pick("S", 50, "증권사 리포트")]
    skip = {"A": DAILY_REASON, "R": "이미 분석됨 (runs/x.json 07:00)"}
    assert main.analysis_targets(picks, 3, skip) == ["B", "C", "S"]  # 리포트 규칙은 건너뛰지 않은 pick 안에서
    assert [(p["symbol"], p.get("skipped")) for p in picks] == [
        ("A", DAILY_REASON), ("B", None), ("C", None), ("R", "이미 분석됨 (runs/x.json 07:00)"), ("S", None)]
    fresh = [pick("A", 90), pick("B", 80)]
    assert main.analysis_targets(fresh, 0, {"A": DAILY_REASON}) == [] and "skipped" not in fresh[0]  # 분석 안 하면 표시 안 함


def test_format_screen_marks_skipped_pick():
    p = {"symbol": "A", "name": "종목A", "score": 90.0, "close": 1000.0, "change20d": 0.1, "rsi": 55.0,
         "atr_ratio": 0.03, "trading_amount": 1e11, "origin": "거래대금 상위", "skipped": DAILY_REASON}
    q = dict(p, symbol="B", name="종목B", skipped=None)
    result = {"market": "KR", "rankCount": 100, "eligibleCount": 60, "checked": 30, "picks": [p, q], "dropped": []}
    lines = main.format_screen(result, "#1 국내", None).splitlines()
    assert lines[2].endswith("[분석 제외: 이미 분석됨 07:05]") and "분석 제외" not in lines[3]
    assert main._skip_label("이미 분석됨 (runs/20260929-200000-s1.json 09-29 20:00)") == "이미 분석됨 09-29 20:00"
    assert main._skip_label("최근 24시간 안에 분석함") == "최근 24시간 안에 분석함"


def test_run_strategy_paper_action_buys_as_strategy(monkeypatch):
    seen, _ = run(monkeypatch, Strategy(id=5, name="국내", market="KR", action="paper"), recent={})
    assert (seen["buy"], seen["by"]) == (True, "strategy:5")


def test_exclusions_use_paper_positions(monkeypatch, tmp_path):
    from paper_engine.agents.executor import PaperExecutor
    from paper_engine.records.store import Store
    db = tmp_path / "trading.db"
    monkeypatch.setattr(main, "DB_PATH", db)
    store = Store(db)
    agent = PaperExecutor(store, Log(), tmp_path / "HALT", {"KR": 0.0, "US": 0.0})
    now = main.datetime.now().astimezone()
    agent.buy("H", "보유주", "KR", "KRW", 1, 1_000, None, now, "alice")
    agent.buy("M", "대기주", "KR", "KRW", 1, 1_100, None, now, "alice", limit_price=1_000)
    done = agent.buy("C", "청산주", "KR", "KRW", 1, 1_000, None, now, "alice")
    agent.sell(done, 1_000, None, now, "alice")
    monkeypatch.setattr(main.daily, "recent_analyses", lambda runs, now, **kw: {"X": {}, "H": {}})
    got = main.exclusions(Config(None, None, None), Log(), now)
    assert got == {"H": "보유 종목", "M": "모의 주문 체결 대기", "X": "최근 24시간 안에 분석함"}


def test_scan_reports_option(monkeypatch):
    seen = {}
    monkeypatch.setattr(main, "load_config", lambda: None)
    monkeypatch.setattr(main, "_notifier", lambda cfg: None)
    monkeypatch.setattr(main, "run_strategy", lambda cfg, n, s, start, redis: seen.setdefault("s", s))
    main.cmd_scan(argparse.Namespace(market="KR", no_ai=True, reports=True))
    assert seen["s"].reports and seen["s"].analyze_top == 0


# --- 전략 ---

def test_summary_and_info_show_reports():
    s = Strategy(id=1, name="국내", market="KR", reports=True)
    assert s.summary().endswith(" · 리포트 후보")
    assert "리포트 후보" not in Strategy(id=2, name="국내", market="KR").summary()
    redis = FakeRedis()
    StrategyBook(redis).create(name="국내", market="KR", reports=True)
    assert info.strategies(redis)[0]["reports"] is True
    # 예전에 저장된 전략(reports 없음)도 읽는다
    redis.kv["paper:strategy:9"] = '{"id": 9, "name": "옛 전략", "market": "US"}'
    assert StrategyBook(redis).get(9).reports is False


def test_strategy_actions_are_notify_or_paper():
    s = Strategy(id=1, name="국내", market="KR", action="paper")
    assert s.auto_buy and "모의 자동 매수" in s.summary()
    assert not Strategy(id=2, name="국내", market="KR").auto_buy
    legacy = Strategy(id=3, name="옛 컨펌", market="KR", action="confirm")  # 원본의 컨펌 후 주문
    assert legacy.action == "paper" and legacy.auto_buy
    with pytest.raises(ValueError, match="notify, paper"):
        Strategy(id=4, name="이상", market="KR", action="live")


def test_default_strategies_follow_markets():
    book = StrategyBook(FakeRedis())
    assert [s.market for s in book.ensure_defaults(("KR",))] == ["KR"]
    assert book.ensure_defaults(("KR", "US")) == []  # 처음 한 번만


# --- 리포트 (PDF용 HTML) ---

def test_report_shows_origin_and_report_candidate_summary():
    screen_result = {
        "market": "KR", "rankCount": 100, "eligibleCount": 65, "checked": 30, "analyzed": ["R1"],
        "picks": [{"symbol": "R1", "name": "한국항공우주", "score": 70.0, "close": 150_000, "rsi": 55.0,
                   "atr_ratio": 0.03, "change20d": 0.1, "trading_amount": 1e11, "origin": "증권사 리포트",
                   "broker": "미래에셋증권", "targetPrice": 186_000.0, "direction": "UP",
                   "title": "[리포트 브리핑]한국항공우주, 'KF-21' 목표가 186,000원"},
                  {"symbol": "A", "name": "삼성전자", "score": 60.0, "close": 80_000, "rsi": 50.0,
                   "atr_ratio": 0.02, "change20d": 0.05, "trading_amount": 2e12, "origin": "거래대금 상위"}],
        "dropped": [{"symbol": "R2", "name": "현대로템", "reason": "60일선 아래", "tradingAmountRank": None,
                     "origin": "증권사 리포트"}],
        "excluded": [],
        "reportCandidates": {"fetched": found("R1", "R2", "A", "H"), "checked": 2, "passed": 1, "dropped": 1,
                             "error": None,
                             "skipped": [{"symbol": "A", "name": "삼성전자", "reason": "거래대금 상위 후보와 중복"},
                                         {"symbol": "H", "name": "보유주", "reason": "보유 종목"}]}}
    html = report.build_html({"startedAt": "2026-09-30T08:00:00+09:00", "results": [], "screen": screen_result})
    assert "<th>출처</th>" in html
    assert "증권사 리포트: 미래에셋증권 목표가 186,000원 상향" in html and "KF-21" in html
    assert "<td>거래대금 상위</td>" in html
    assert ("증권사 리포트 후보 4개 → 중복·제외 2개 (거래대금 상위 후보와 중복 1개, 보유 종목 1개) → 2개 점검 → "
            "규칙 통과 1개, 탈락 1개") in html
    assert "보유주" not in html  # 제외된 종목 이름은 콘솔 로그에만
    assert "분석 제외" not in html  # 건너뛴 pick이 없으면 열도 없다
    screen_result["picks"][1]["skipped"] = DAILY_REASON
    html = report.build_html({"startedAt": "2026-09-30T08:00:00+09:00", "results": [], "screen": screen_result})
    assert "<th>출처</th><th>분석 제외</th><th>AI 분석</th>" in html
    assert f'<td class="small">{DAILY_REASON}</td>' in html
    failed = dict(screen_result, reportCandidates={"error": "OSError: down"})
    assert "증권사 리포트 후보를 가져오지 못함: OSError: down" in report.build_html({"screen": failed})
