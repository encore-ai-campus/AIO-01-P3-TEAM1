"""일일 리포트: 자료 모으기(collect), HTML, PDF 변환 실패 시 HTML. 실제 Store(":memory:")와 모의 체결기, 가짜 시세."""
import json
import subprocess
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from paper_engine import daily, report
from paper_engine.agents.executor import PaperExecutor
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.records import market_log
from paper_engine.records.store import Store
from paper_engine.scheduler import ReservationBook, save_scan_result
from paper_engine.strategies import StrategyBook

from test_market_log import MarketClient
from test_scheduler import FakeRedis

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 9, 30, 7, 0, tzinfo=KST)
RATES = {"KR": 0.00015, "US": 0.00015}
BUY_COST = 1_000_000 * 1.00015  # 10주 × 100,000원 + 수수료


class Client:
    """현재가·환율 조회 가짜."""

    def __init__(self, fail=False):
        self.fail = fail
        self.price_calls = []

    def exchange_rate(self):
        if self.fail:
            raise KiwoomApiError(500, {"return_code": 1, "return_msg": "internal"})
        return {"rate": "1400"}

    def prices(self, symbols):
        self.price_calls.append(list(symbols))
        return [{"symbol": s, "lastPrice": "108000"} for s in symbols]


class Quiet:
    def send(self, text):
        pass

    log = send


def at(day, hour, minute=0):
    return datetime(2026, 9, day, hour, minute, tzinfo=KST)


def paper_orders(store: Store, tmp_path: Path | None = None) -> PaperExecutor:
    """보유 1건(005930), 목표가 청산 1건(000660, 기간 안), 당일 미체결 취소 1건, 손절 청산 1건(기간 밖)."""
    tmp_path = tmp_path or Path(tempfile.mkdtemp())  # 중단 스위치 없음 + 주문 잠금 파일 위치
    ex = PaperExecutor(store, Quiet(), tmp_path / "HALT", RATES)
    open_kr = {"KR"}

    def sync(symbol, price, when, close=None):
        ex.sync({symbol: price}, when, open_kr, None, {"KR": close})

    old = ex.buy("035420", "NAVER", "KR", "KRW", 10, 100_000, None, at(1, 10), "alice", target=115_000, stop=96_000)
    sync("035420", 95_000, at(10, 10))
    sync("035420", 95_000, at(10, 10, 1))  # 2회 연속 확인 → 손절
    ex.buy("005930", "삼성전자 <주>", "KR", "KRW", 10, 100_000, None, at(25, 10), "strategy:1",
           target=115_000, stop=95_000, expire_date="2026-10-29")
    won = ex.buy("000660", "SK하이닉스", "KR", "KRW", 10, 100_000, None, at(26, 10), "bob", target=115_000,
                 stop=95_000)
    sync("000660", 116_000, at(29, 13, 59))
    sync("000660", 116_000, at(29, 14))
    ex.buy("068270", "셀트리온", "KR", "KRW", 1, 180_000, None, at(29, 9, 10), "bob", limit_price=170_000)
    sync("068270", 175_000, at(29, 16), close=at(29, 15, 30))  # 정규장이 끝났는데 체결되지 않음 → 취소
    assert store.paper_order(old)["exit_reason"] == "STOP" and store.paper_order(won)["exit_reason"] == "TARGET"
    return ex


def filled_store() -> Store:
    store = Store(":memory:")
    paper_orders(store)
    market_log.record_market(MarketClient(), store, "KR", "2026-09-29", NOW)
    return store


def strategy_redis():
    redis = FakeRedis()
    s = StrategyBook(redis).create(name="국내 <스윙>", market="KR")
    StrategyBook(redis).record_run(s.id, "규칙 통과 3개")
    save_scan_result(redis, s.id, {"at": "2026-09-29T08:00:00+09:00", "picks": [
        {"name": f"종목{i}", "symbol": f"S{i}", "score": 90 - i} for i in range(7)]})
    ReservationBook(redis).add(market="KR", side="BUY", symbol="005380", name="현대차", quantity="1",
                               created_at="2026-09-29T20:00:00+09:00", reference_price="250000", requested_by="alice")
    return redis


def write_runs(tmp_path):
    runs = tmp_path / "runs"
    runs.mkdir()
    (runs / "20260929-080000-s1.json").write_text(json.dumps({
        "startedAt": "2026-09-29T08:00:00+09:00", "strategy": {"id": 1, "name": "국내 스윙"}, "costUsd": 0.9,
        "paperBuy": True,
        "results": [{"snapshot": {"symbol": "005930", "name": "삼성전자"},
                     "candidates": [{"selected": True}, {"selected": False}]},
                    {"snapshot": {"symbol": "000660", "name": "SK하이닉스"}, "modelResponseError": "시간 초과"}]}))
    (runs / "20260920-080000.json").write_text(json.dumps({"startedAt": "2026-09-20T08:00:00+09:00",
                                                           "results": []}))
    (runs / "broken.json").write_text("{")
    return runs


def collect(tmp_path, client=None, redis=None, days=1, store=None):
    backups = tmp_path / "backups"
    backups.mkdir(exist_ok=True)
    (backups / "trading-20260929-060000.db").write_text("")
    (backups / "trading-20260930-060000.db").write_text("")
    halt = tmp_path / "HALT"
    return daily.collect(store or filled_store(), redis, client, NOW, days, markets=("KR", "US"), commission=RATES,
                         runs_dir=write_runs(tmp_path) if not (tmp_path / "runs").exists() else tmp_path / "runs",
                         halt_file=halt, backup_dir=backups)


STOP_PNL = 950_000 * (1 - 0.00015 - 0.002) - BUY_COST
TARGET_PNL = 1_160_000 * (1 - 0.00015 - 0.002) - BUY_COST
CASH = 10_000_000 - 3 * BUY_COST + 950_000 * (1 - 0.00215) + 1_160_000 * (1 - 0.00215)


def test_collect_fills_every_section(tmp_path):
    client = Client()
    store = filled_store()
    store.record_equity("2026-09-29", 9_000_000, 1_000_000, "2026-09-29T15:45:00+09:00")
    data = collect(tmp_path, client, strategy_redis(), store=store)
    json.dumps(data)  # 직렬화할 수 있어야 한다
    assert data["period"] == {"since": "2026-09-29T07:00:00+09:00", "until": "2026-09-30T07:00:00+09:00",
                              "days": 1}

    a = data["account"]
    assert a["cashKrw"] == pytest.approx(CASH) and a["holdingsValueKrw"] == 1_080_000
    assert a["equityKrw"] == pytest.approx(CASH + 1_080_000)
    assert a["profitKrw"] == pytest.approx(CASH + 1_080_000 - 10_000_000) and a["usdKrw"] is None
    assert a["dailyChangeKrw"] == pytest.approx(CASH + 1_080_000 - 10_000_000)  # 전일 기록 1천만원 대비
    assert a["buyingPowerKrw"] == pytest.approx(CASH) and a["pendingKrw"] == 0
    (item,) = a["holdings"]
    assert (item["symbol"], item["quantity"], item["lastPrice"], item["unrealized"]) == ("005930", 10, 108_000, 80_000)

    t = data["trades"]
    (active,) = t["active"]
    assert active["lastPrice"] == 108_000 and client.price_calls == [["005930"]]  # 현재가는 한 번에
    assert (active["expectedGain"], active["expectedLoss"]) == (150_000, -50_000)
    assert active["unrealized"] == 80_000 and active["filled"] and active["requestedBy"] == "strategy:1"
    assert [(r["status"], r["exitReason"]) for r in t["finished"]] == [("CLOSED", "TARGET"), ("CANCELED", None)]
    assert t["finished"][0]["pnl"] == pytest.approx(TARGET_PNL)
    assert t["openedCount"] == 1 and t["realized"] == {"KRW": pytest.approx(TARGET_PNL)}
    cum = t["cumulative"]["KRW"]
    assert (cum["count"], cum["wins"], cum["winRate"]) == (2, 1, 0.5)
    assert cum["pnl"] == pytest.approx(TARGET_PNL + STOP_PNL)

    kr, us = data["markets"]["KR"], data["markets"]["US"]
    assert kr["latestDay"] == "2026-09-29" and kr["recordedDays"] == 1 and kr["note"] is None
    assert kr["days"][0]["benchSymbol"] == "069500" and kr["days"][0]["benchClose"] == 102
    # ETF(A001)는 리포트 상위 목록에서 뺀다. 기록에는 남아 있다
    assert len(kr["amount"]) == 10 and kr["amount"][0]["symbol"] == "A002"
    assert all(r["securityType"] == "STOCK" for key in ("amount", "gainers", "losers") for r in kr[key])
    assert kr["gainers"][0]["changeRate"] == 0.2 and len(kr["losers"]) == 10
    assert us["days"] == [] and us["amount"] == [] and us["recordedDays"] == 0 and "기록 없음" in us["note"]

    r = data["records"]
    (s,) = r["strategies"]
    assert s["lastSummary"] == "규칙 통과 3개" and len(s["latestPicks"]) == 5
    assert r["reservations"] == ["#1 현대차 (005380) 1주 시장가 매수 · 요청 alice"]
    (run,) = r["runs"]
    assert run == {"file": "20260929-080000-s1.json", "startedAt": "2026-09-29T08:00:00+09:00",
                   "strategy": "#1 국내 스윙", "symbols": 2, "picks": ["삼성전자(005930)"], "failed": 1,
                   "costUsd": 0.9, "paperBuy": True}
    assert r["paper"] == [] and r["halted"] is False and r["latestBackup"] == "trading-20260930-060000.db"


def test_markets_follow_configured_markets(tmp_path):
    data = daily.collect(filled_store(), None, None, NOW, runs_dir=tmp_path, halt_file=tmp_path / "HALT",
                         backup_dir=tmp_path)
    assert list(data["markets"]) == ["KR"]  # 기본은 국내만 (MARKETS=KR)


def test_longer_period_and_no_client_or_redis(tmp_path):
    data = collect(tmp_path, days=30)
    a = data["account"]
    assert a["holdingsValueKrw"] == 1_000_000 and "체결가로 평가" in a["notes"][0]  # 조회하지 않음
    assert a["dailyChangeKrw"] is None and data["records"]["strategies"] is None
    assert data["trades"]["active"][0]["lastPrice"] is None
    assert len(data["records"]["runs"]) == 2
    assert data["trades"]["realized"] == {"KRW": pytest.approx(TARGET_PNL + STOP_PNL)}


def test_usd_position_without_exchange_rate_uses_fill_rate(tmp_path):
    store = filled_store()
    ex = PaperExecutor(store, Quiet(), tmp_path / "HALT", RATES)
    ex.buy("AAPL", "애플", "US", "USD", 2, 250.0, 1_400.0, at(29, 23), "alice")
    data = collect(tmp_path, Client(fail=True), store=store)
    a = data["account"]
    (aapl,) = [h for h in a["holdings"] if h["symbol"] == "AAPL"]
    assert aapl["fxRate"] == 1_400 and a["usdKrw"] is None
    assert any("체결 환율" in n for n in a["notes"]) and "계좌 평가 실패" not in daily.caption(data)
    assert len(data["trades"]["active"]) == 2 and data["markets"]["KR"]["recordedDays"] == 1


def test_caption_has_period_orders_pnl_and_assets(tmp_path):
    lines = daily.caption(collect(tmp_path, Client())).splitlines()
    equity = CASH + 1_080_000
    assert lines == ["[일일 리포트] 2026-09-29 07:00 ~ 2026-09-30 07:00",
                     f"진행 중 모의 주문 1건 · 기간 확정 손익 +{TARGET_PNL:,.0f}원",
                     f"모의 계좌 {equity:,.0f}원 (현금 {CASH:,.0f}원 + 보유 1,080,000원) · 초기 자금 대비 "
                     f"+{equity - 10_000_000:,.0f}원 ({equity / 10_000_000 - 1:+.2%})",
                     "기록: 시나리오 0건 (청산 0건)"]


def test_daily_html_escapes_and_has_all_sections(tmp_path):
    html = report.build_daily_html(collect(tmp_path, Client(), strategy_redis()))
    for title in ("일일 리포트 · 2026-09-29 07:00 ~ 2026-09-30 07:00", "모의 계좌", "보유 종목",
                  "진행 중 모의 주문", "기간 내 종료 주문", "누적 성적", "시장 동향",
                  "거래대금 상위 10", "상승률 상위 10", "하락률 상위 10", "기록", "기간 내 분석 실행",
                  "예약 주문", "AI 시나리오 예측 추적 성적", "중단 스위치", "최근 백업", "시장 기록 일수",
                  "AI 판단 없음, 기록과 조회값만 담음", "초기 자금 대비", "전일 대비", "strategy:1"):
        assert title in html, title
    assert "삼성전자 &lt;주&gt;" in html and "<주>" not in html and "사용자 주문" not in html
    assert "국내 &lt;스윙&gt;" in html
    assert f"+{TARGET_PNL:,.0f}원" in html and "종목A002 (A002)" in html and "종목A001 (A001)" not in html
    assert "CLOSED · TARGET" in html and "정정정규장" not in html
    assert "시장 기록 없음" in html  # 미국은 기록이 없다


def test_daily_html_shows_none_for_empty_sections():
    missing = Path("/nonexistent")
    data = daily.collect(Store(":memory:"), None, None, NOW, 1, runs_dir=missing, halt_file=missing / "HALT",
                         backup_dir=missing)
    html = report.build_daily_html(data)
    assert html.count("<p>없음</p>") >= 4 and "REDIS_URL 없음" in html and "보유 종목 없음" in html
    assert "10,000,000원" in html  # 새 계좌는 초기 자금으로 만든다


def test_write_daily_report_falls_back_to_html(tmp_path, monkeypatch):
    data = collect(tmp_path)
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: None)
    path = report.write_daily_report(data, tmp_path / "reports" / "daily-20260930.pdf")
    assert path == tmp_path / "reports" / "daily-20260930.html" and "일일 리포트" in path.read_text()

    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, "chrome")
    monkeypatch.setattr(report, "find_chrome", lambda configured=None: "/usr/bin/chrome")
    assert report.write_daily_report(data, tmp_path / "x.pdf", run=fail).name == "x.html"

    def ok(args, **kwargs):
        pdf = next(a for a in args if a.startswith("--print-to-pdf=")).split("=", 1)[1]
        open(pdf, "wb").write(b"%PDF")
    path = report.write_daily_report(data, tmp_path / "y.pdf", run=ok)
    assert path.name == "y.pdf" and not (tmp_path / "y.html").exists()


# --- 일일 AI 분석 (분석 결과는 가짜 실행 기록, AI 호출 없음) ---

def selection_data(kr_amount=None, us_recorded=False):
    rank = lambda s: {"symbol": s, "name": f"종목{s}"}  # noqa: E731
    return {"account": {"holdings": [{"symbol": "005930", "name": "삼성전자"},
                                     {"symbol": "360750", "name": "TIGER 미국S&P500"},
                                     {"symbol": "AAPL", "name": "애플"}]},
            "trades": {"active": [{"symbol": "005930", "name": "삼성전자"}, {"symbol": "000660", "name": "SK하이닉스"},
                                  {"symbol": "000660", "name": "SK하이닉스"}]},
            "markets": {"KR": {"latestDay": "2026-09-29",
                               "amount": kr_amount or [rank(s) for s in ("000660", "A1", "A2", "A3")]},
                        "US": {"latestDay": "2026-09-29" if us_recorded else None,
                               "amount": [rank("NVDA")] if us_recorded else []}}}


def test_analysis_symbols_order_roles_and_notes():
    notes = []
    items = daily.analysis_symbols(selection_data(), notes=notes)
    assert [(x["symbol"], x["role"]) for x in items] == [
        ("005930", "보유·모의 주문"), ("AAPL", "보유"), ("000660", "모의 주문·거래대금 상위 (국내)"),
        ("A1", "거래대금 상위 (국내)"), ("A2", "거래대금 상위 (국내)")]  # 시장별 상위 3개 (000660 포함)
    assert items[0]["name"] == "삼성전자"
    assert notes == ["미국 시장 기록이 없어 거래대금 상위는 분석하지 않음",
                     "ETF·ETN으로 보여 분석에서 뺌: TIGER 미국S&P500(360750)"]


def test_analysis_symbols_limit_and_both_markets():
    notes = []
    items = daily.analysis_symbols(selection_data(us_recorded=True), limit=3, notes=notes)
    assert [x["symbol"] for x in items] == ["005930", "AAPL", "000660"]
    assert notes[-1] == "분석 대상 6종목 중 앞 3종목만 분석 (뺀 종목: 종목A1(A1), 종목A2(A2), 종목NVDA(NVDA))"
    assert daily.analysis_symbols({"account": None, "trades": {}, "markets": {}}) == []


def test_latest_daily_run(tmp_path):
    runs = tmp_path / "runs"
    assert daily.latest_daily_run(runs, "20260930") is None  # 폴더가 없어도
    runs.mkdir()
    for name in ("20260930-070001-daily.json", "20260930-093000-daily.json", "20260930-100000-s1.json",
                 "20260929-070000-daily.json"):
        (runs / name).write_text("{}")
    assert daily.latest_daily_run(runs, "20260930").name == "20260930-093000-daily.json"
    assert daily.latest_daily_run(runs, "2026-09-29").name == "20260929-070000-daily.json"
    assert daily.latest_daily_run(runs, "20261001") is None


def candidate(selected=False, score=60.0, reasons=(), approval=None):
    return {"selected": selected, "passed": selected, "score": score, "consensus_probability": 0.55,
            "rejectReasons": list(reasons), "approval": approval,
            "final": {"entry_price": 100_000, "target_price": 115_000, "stop_price": 95_000, "probability": 0.5,
                      "holding_days": 10}}


def write_daily_run(runs: Path) -> Path:
    runs.mkdir(exist_ok=True)
    path = runs / "20260930-064005-daily.json"
    path.write_text(json.dumps({
        "startedAt": "2026-09-30T06:40:05+09:00", "tag": "daily", "costUsd": 0.93,
        "roles": {"005930": "보유", "000660": "거래대금 상위 (국내)", "AAPL": "보유"},
        "results": [
            {"snapshot": {"symbol": "005930", "name": "삼성전자", "currency": "KRW"},
             "candidates": [candidate(score=55, reasons=["손익비 부족"]),
                            candidate(True, 72, approval={"approved": True, "reason": "추세 <양호>"})]},
            {"snapshot": {"symbol": "000660", "name": "SK하이닉스", "currency": "KRW"},
             "candidates": [candidate(score=50, reasons=["확률 낮음", "손익비 부족"]),
                            candidate(score=65, reasons=["손익비 부족", "근거 부족"])]},
            {"snapshot": {"symbol": "AAPL", "name": "애플", "currency": "USD"}, "modelResponseError": "시간 초과"}]}))
    return path


def test_collect_fills_analysis_section(tmp_path):
    run = write_daily_run(tmp_path / "runs")
    data = daily.collect(Store(":memory:"), None, None, NOW, runs_dir=tmp_path / "runs",
                         halt_file=tmp_path / "HALT", backup_dir=tmp_path, analysis_run=run, reused=True,
                         roles={"000660": "자동 관리"}, analysis_notes=["메모"])
    json.dumps(data)
    a = data["analysis"]
    assert (a["runFile"], a["startedAt"], a["reused"], a["costUsd"], a["notes"]) == (
        run.name, "2026-09-30T06:40:05+09:00", True, 0.93, ["메모"])
    buy, none, stopped = a["symbols"]
    assert buy == {"symbol": "005930", "name": "삼성전자", "currency": "KRW", "role": None, "outcome": "매수 추천",
                   "bestScore": 72, "scenarios": 2, "reasons": [], "earlier": None,
                   "pick": {"entry": 100_000, "target": 115_000, "stop": 95_000, "probability": 0.55,
                            "holdingDays": 10, "reason": "추세 <양호>"}}  # 넘긴 역할이 기록보다 우선
    assert (none["outcome"], none["role"], none["bestScore"], none["pick"]) == ("추천 없음", "자동 관리", 65, None)
    assert none["reasons"] == ["손익비 부족", "근거 부족"]  # 점수 높은 시나리오부터, 중복 없이 2개
    assert (stopped["outcome"], stopped["scenarios"], stopped["reasons"]) == ("분석 중단", 0, ["모델 응답 에러: 시간 초과"])
    # 역할을 넘기지 않으면 기록에 넣어 둔 역할
    data = daily.collect(Store(":memory:"), None, None, NOW, runs_dir=tmp_path / "runs", halt_file=tmp_path / "HALT",
                         backup_dir=tmp_path, analysis_run=run)
    assert [x["role"] for x in data["analysis"]["symbols"]] == ["보유", "거래대금 상위 (국내)", "보유"]
    assert data["records"]["runs"][0]["strategy"] == "일일 분석"


def test_analysis_section_in_html_and_caption(tmp_path):
    run = write_daily_run(tmp_path / "runs")
    data = collect(tmp_path, Client())
    assert data["analysis"] is None and "AI 분석" not in daily.caption(data)
    assert "<h2>AI 분석</h2><p>없음 (분석하지 않음)</p>" in report.build_daily_html(data)

    data = daily.collect(filled_store(), None, Client(), NOW, runs_dir=tmp_path / "runs", halt_file=tmp_path / "HALT",
                         backup_dir=tmp_path, analysis_run=run, reused=True, analysis_notes=["미국 시장 기록 없음"])
    assert daily.caption(data).splitlines()[-1] == "AI 분석 3종목 · 추천 1개 · 비용 $0.93 (오늘 앞서 한 분석 재사용)"
    html = report.build_daily_html(data)
    assert html.index("<h2>모의 계좌</h2>") < html.index("<h2>AI 분석</h2>") < html.index("진행 중 모의 주문")
    for text in ("기록만, 모의 주문 없음. 보유 종목은 매수 시나리오 기준 재평가라 보유 유지 판단의 참고용이다",
                 "오늘 앞서 한 분석 재사용", "매수 추천 1개", "$0.93", "100,000원 / 115,000원 / 95,000원",
                 "확률 55.0% · 보유 10거래일", "추세 &lt;양호&gt;", "추천 없음 (시나리오 2개)",
                 "손익비 부족; 근거 부족", "분석 중단", "모델 응답 에러: 시간 초과", "미국 시장 기록 없음",
                 "삼성전자 (005930)</td><td>보유</td>"):
        assert text in html, text


def test_analysis_section_shows_reason_when_not_analyzed(tmp_path):
    data = daily.collect(Store(":memory:"), None, None, NOW, runs_dir=tmp_path / "none", halt_file=tmp_path / "HALT",
                         backup_dir=tmp_path, analysis_notes=["AI 설정 없음"])
    assert data["analysis"]["runFile"] is None and data["analysis"]["symbols"] == []
    assert "<h2>AI 분석</h2><p>없음 (AI 설정 없음)</p>" in report.build_daily_html(data)
    assert "AI 분석" not in daily.caption(data)
    broken = tmp_path / "20260930-070000-daily.json"
    broken.write_text("{")
    data = daily.collect(Store(":memory:"), None, None, NOW, runs_dir=tmp_path / "none", halt_file=tmp_path / "HALT",
                         backup_dir=tmp_path, analysis_run=broken)
    assert data["analysis"]["symbols"] == [] and "분석 기록을 읽지 못함" in data["analysis"]["notes"][0]


def write_recent_runs(runs: Path):
    """전략 실행(23시간 전, 000660은 모델 에러), 25시간 전 수동 분석, 일일 분석(1시간 전)."""
    runs.mkdir(exist_ok=True)
    (runs / "20260929-080000-s1.json").write_text(json.dumps({
        "startedAt": "2026-09-29T08:00:00+09:00", "strategy": {"id": 1, "name": "국내"}, "results": [
            {"snapshot": {"symbol": "A1", "name": "종목A1", "currency": "KRW"},
             "candidates": [candidate(True, 70, approval={"reason": "돌파"})]},
            {"snapshot": {"symbol": "000660", "name": "SK하이닉스"}, "modelResponseError": "시간 초과"}]}))
    (runs / "20260929-060000.json").write_text(json.dumps({
        "startedAt": "2026-09-29T06:00:00+09:00", "results": [
            {"snapshot": {"symbol": "AAPL", "name": "애플"}, "candidates": []}]}))
    (runs / "20260930-060000-daily.json").write_text(json.dumps({
        "startedAt": "2026-09-30T06:00:00+09:00", "tag": "daily", "results": [
            {"snapshot": {"symbol": "005930", "name": "삼성전자"}, "candidates": []}]}))


def test_recent_analyses_last_24_hours_without_daily_runs(tmp_path):
    write_recent_runs(tmp_path / "runs")
    recent = daily.recent_analyses(tmp_path / "runs", NOW)
    assert list(recent) == ["A1"]  # 25시간 전 기록, 일일 분석, 모델 에러 종목은 빼고
    assert recent["A1"]["runFile"] == "runs/20260929-080000-s1.json"
    assert recent["A1"]["startedAt"] == "2026-09-29T08:00:00+09:00" and recent["A1"]["result"]["outcome"] == "매수 추천"
    assert "AAPL" in daily.recent_analyses(tmp_path / "runs", NOW, hours=26)
    assert daily.recent_analyses(tmp_path / "none", NOW) == {}


def test_analysis_symbols_reuses_recent_and_skips_strategy_markets(tmp_path):
    write_recent_runs(tmp_path / "runs")
    recent = daily.recent_analyses(tmp_path / "runs", NOW)
    recent["005930"] = recent["A1"] | {"runFile": "runs/x.json"}  # 보유 종목도 최근 분석이 있으면 뺀다
    notes = []
    items = daily.analysis_symbols(selection_data(us_recorded=True), recent, {}, limit=3, notes=notes)
    fresh = [x["symbol"] for x in items if not x["earlier"]]
    assert fresh == ["AAPL", "000660", "A2"]  # 최근 분석한 것은 한도에 세지 않는다
    assert [(x["symbol"], x["earlier"]["runFile"]) for x in items if x["earlier"]] == [
        ("005930", "runs/x.json"), ("A1", "runs/20260929-080000-s1.json")]
    assert "최근 24시간 안에 분석된 2종목은 다시 분석하지 않고 그 결과를 씀" in notes
    assert notes[-1].startswith("분석 대상 4종목 중 앞 3종목만 분석 (뺀 종목: 종목NVDA(NVDA))")

    notes = []
    items = daily.analysis_symbols(selection_data(us_recorded=True), {}, {"KR": [1, 3]}, notes=notes)
    assert [(x["symbol"], x["role"]) for x in items] == [  # 000660은 모의 주문으로만 남는다
        ("005930", "보유·모의 주문"), ("AAPL", "보유"), ("000660", "모의 주문"), ("NVDA", "거래대금 상위 (미국)")]
    assert "국내 거래대금 상위는 전략 #1, #3이(가) 매일 분석하므로 제외" in notes


def test_active_strategy_markets():
    redis = FakeRedis()
    book = StrategyBook(redis)
    kr = book.create(name="국내", market="KR")
    us = book.create(name="미국", market="US")
    book.create(name="선별만", market="US", analyze_top=0)  # AI 분석을 하지 않는 전략은 중복이 아니다
    assert daily.active_strategy_markets(redis) == {"KR": [kr.id], "US": [us.id]}
    book.set_status(us.id, "stopped")  # 중지된 전략의 시장은 분석한다
    assert daily.active_strategy_markets(redis) == {"KR": [kr.id]}
    assert daily.active_strategy_markets(None) == {}


def test_analysis_section_shows_reused_recent_results(tmp_path):
    write_recent_runs(tmp_path / "runs")
    recent = daily.recent_analyses(tmp_path / "runs", NOW)
    earlier = [{"symbol": "A1", "name": "종목A1", "role": "거래대금 상위 (국내)", "earlier": recent["A1"]}]
    run = write_daily_run(tmp_path / "runs")
    data = daily.collect(Store(":memory:"), None, None, NOW, runs_dir=tmp_path / "runs", halt_file=tmp_path / "HALT",
                         backup_dir=tmp_path, analysis_run=run, earlier=earlier)
    json.dumps(data)
    a1 = data["analysis"]["symbols"][-1]
    assert (a1["symbol"], a1["role"], a1["outcome"], a1["pick"]["reason"]) == ("A1", "거래대금 상위 (국내)", "매수 추천", "돌파")
    assert a1["earlier"] == {"runFile": "runs/20260929-080000-s1.json", "startedAt": "2026-09-29T08:00:00+09:00"}
    assert all(x["earlier"] is None for x in data["analysis"]["symbols"][:-1])
    assert daily.caption(data).splitlines()[-1] == "AI 분석 4종목 (최근 분석 재사용 1종목 포함) · 추천 2개 · 비용 $0.93"
    html = report.build_daily_html(data)
    assert "이미 분석됨 (runs/20260929-080000-s1.json, 2026-09-29 08:00)" in html
    assert "새로 분석 3종목" in html and "최근 분석 재사용 1종목" in html

    # 새로 분석할 종목이 없어도 최근 분석 결과는 표로 보인다
    data = daily.collect(Store(":memory:"), None, None, NOW, runs_dir=tmp_path / "runs", halt_file=tmp_path / "HALT",
                         backup_dir=tmp_path, earlier=earlier, analysis_notes=["새로 분석할 종목 없음"])
    html = report.build_daily_html(data)
    assert data["analysis"]["runFile"] is None and "새로 분석한 종목 없음 · 최근 분석 재사용 1종목" in html
    assert "이미 분석됨" in html and "AI 분석 1종목 (최근 분석 재사용 1종목 포함)" in daily.caption(data)


def prediction_store() -> Store:
    from test_store import add, candidate
    from paper_engine.records import paper
    store = Store(":memory:")
    win, lose, _ = add(store, candidate()), add(store, candidate(proposer_p=0.8)), add(store, candidate())
    store.update_outcome(win, paper.Outcome(paper.TARGET, "2026-09-30", 100_000, "2026-10-02", 115_000), 1.0)
    store.update_outcome(lose, paper.Outcome(paper.STOP, "2026-09-30", 100_000, "2026-10-01", 95_000), -1.0)
    return store


def test_collect_fills_predictions_section(tmp_path):
    empty = collect(tmp_path, store=Store(":memory:"))["records"]["predictions"]
    assert empty["summary"]["total"] == 0 and empty["summary"]["hit_rate"] is None and empty["models"] == []
    data = collect(tmp_path, store=prediction_store())
    json.dumps(data)
    p = data["records"]["predictions"]
    assert (p["summary"]["total"], p["summary"]["closed"], p["summary"]["active"]) == (3, 2, 1)
    assert {m["analyst"] for m in p["models"]} == {"claude", "openai", "google"}
    assert "기록: 시나리오 3건 (청산 2건)" in daily.caption(data).splitlines()


def test_predictions_section_in_html(tmp_path):
    html = report.build_daily_html(collect(tmp_path, store=prediction_store()))
    assert "예측 기록 현황" in html and "목표 도달률 50%" in html and "Brier" in html and "claude" in html
    assert html.index("예측 기록 현황") < html.index("AI 시나리오 예측 추적 성적")
    html = report.build_daily_html(collect(tmp_path, store=Store(":memory:")))
    assert "예측 기록 현황" in html and "기록 없음" in html
    from test_store import add, candidate
    store = Store(":memory:")
    add(store, candidate())
    assert "아직 청산된 시나리오 없음 (1건 진행 중)" in report.build_daily_html(collect(tmp_path, store=store))
