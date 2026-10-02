"""serve(Service): 모의 체결 sync, 예약 실행, 전략 시작, 생존 신호, 시장·자산 기록, 일일 리포트, 스레드별 저장소.

키움·openclaw·AI는 모두 가짜다.
"""
import dataclasses
import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone

import pytest

import paper_engine.__main__ as main
from paper_engine.__main__ import Service
from paper_engine.agents import executor as ex
from paper_engine.config import Config
from paper_engine.scheduler import ReservationBook
from paper_engine.strategies import StrategyBook

from test_scheduler import FakeRedis

WAIT = 5  # 이벤트 대기 상한. 정상이면 바로 풀린다
KST = timezone(timedelta(hours=9))


class Notes:
    def __init__(self):
        self.sent, self.logged, self.files = [], [], []

    def send(self, text):
        self.sent.append(text)

    def log(self, text):
        self.logged.append(text)

    def send_file(self, path, caption=""):
        self.files.append((path, caption))


class Quotes:
    """키움 조회 가짜: 확인 가격, 현재가, 환율, 종목 정보."""

    def __init__(self, prices=None):
        self.quotes = dict(prices or {})
        self.calls = []

    def confirmed_prices(self, symbols):
        self.calls.append(("confirmed_prices", list(symbols)))
        return {s: self.quotes[s] for s in symbols if s in self.quotes}

    def prices(self, symbols):
        return [{"symbol": s, "lastPrice": str(self.quotes[s])} for s in symbols if s in self.quotes]

    def exchange_rate(self):
        return {"rate": "1400"}

    def stocks(self, symbols):
        return [{"symbol": s, "name": f"종목{s}", "currency": "KRW", "status": "ACTIVE"} for s in symbols]


def open_session(now=None):
    now = now or datetime.now().astimezone()
    return [(now - timedelta(hours=1), now + timedelta(hours=1))]


@pytest.fixture
def service(tmp_path, monkeypatch):
    s = Service.__new__(Service)  # openclaw·Redis 없이
    s.cfg = Config("key", "secret", None)
    s.notifier, s.book, s.strategies, s.redis = Notes(), None, None, None
    s.db_path = tmp_path / "trading.db"
    s._calendars = {}
    s.sessions = lambda market, extended=False: open_session()  # 정규장이 열려 있다
    monkeypatch.setattr(main, "HALT_FILE", tmp_path / "HALT")
    return s


def use_quotes(monkeypatch, prices) -> Quotes:
    q = Quotes(prices)
    monkeypatch.setattr(main, "_client", lambda cfg: q)
    return q


def lock_free(service) -> bool:
    """다른 스레드에서 주문 잠금을 바로 잡을 수 있는지."""
    got = []

    def probe():
        ok = service._order_lock.acquire(blocking=False)
        if ok:
            service._order_lock.release()
        got.append(ok)

    t = threading.Thread(target=probe, daemon=True)
    t.start()
    t.join(WAIT)
    return got[0]


# --- 모의 체결 확인 ---

def test_sync_job_fills_limit_and_closes_on_two_confirmations(service, monkeypatch, capsys):
    q = use_quotes(monkeypatch, {"005930": 99_000})
    agent = service.desk(q).executor
    now = datetime.now().astimezone()
    oid = agent.buy("005930", "삼성전자", "KR", "KRW", 10, 101_000, None, now, "alice", limit_price=100_000,
                    target=110_000, stop=95_000)
    service.sync_job()
    assert service.store.paper_order(oid)["status"] == ex.EXIT_WATCHING
    assert "모의 주문 1건 확인 (KR 정규장)" in capsys.readouterr().out
    q.quotes["005930"] = 111_000
    service.sync_job()
    service.sync_job()
    row = service.store.paper_order(oid)
    assert (row["status"], row["exit_reason"], row["exit_price"]) == (ex.CLOSED, "TARGET", 111_000)
    assert any(m.startswith("[모의 청산 #1]") for m in service.notifier.sent)


def test_sync_job_without_orders_does_not_query(service, monkeypatch, capsys):
    q = use_quotes(monkeypatch, {})
    service.sync_job()
    assert q.calls == [] and "진행 중인 모의 주문 없음" in capsys.readouterr().out


def test_sync_job_cancels_day_limit_after_close(service, monkeypatch):
    q = use_quotes(monkeypatch, {"005930": 99_000})
    now = datetime.now().astimezone()
    start, end = now - timedelta(hours=8), now - timedelta(hours=1)
    service.sessions = lambda market, extended=False: [(start, end)]
    oid = service.desk(q).executor.buy("005930", "삼성전자", "KR", "KRW", 1, 101_000, None,
                                       start + timedelta(minutes=10), "alice", limit_price=90_000)
    service.sync_job()
    assert service.store.paper_order(oid)["status"] == ex.CANCELED
    assert ("confirmed_prices", ["005930"]) not in q.calls  # 장이 닫혀 있으면 가격을 묻지 않는다


def test_order_lock_is_held_while_syncing(service, monkeypatch):
    held = []
    monkeypatch.setattr(main.Desk, "sync", lambda self, now=None: held.append(not lock_free(service)) or "확인")
    use_quotes(monkeypatch, {})
    service.sync_job()
    assert held == [True] and lock_free(service)


# --- 예약 ---

def reservation_service(service, monkeypatch, prices):
    q = use_quotes(monkeypatch, prices)
    service.book = ReservationBook(FakeRedis())
    return q


def test_due_buy_reservation_fills_with_requester(service, monkeypatch):
    reservation_service(service, monkeypatch, {"005930": 101_000})
    created = datetime.now().astimezone() - timedelta(hours=2)  # 정규장 시작 전에 예약
    service.book.add(market="KR", side="BUY", symbol="005930", name="삼성전자", quantity="3",
                     created_at=created.isoformat(), reference_price="100000", requested_by="alice",
                     target="110000", stop="95000", days=10)
    service.run_due_reservations()
    (row,) = service.store.paper_orders()
    assert (row["status"], row["requested_by"], row["quantity"], row["fill_price"]) == (
        ex.EXIT_WATCHING, "alice", 3, 101_000)
    assert row["target_price"] == 110_000 and row["expire_date"] == f"{datetime.now().date() + timedelta(days=10)}"
    assert service.book.all() == [] and service.notifier.sent[0].startswith("[예약] #1 삼성전자 (005930) 3주")


def test_buy_reservation_canceled_when_price_moved(service, monkeypatch):
    reservation_service(service, monkeypatch, {"005930": 111_000})
    created = datetime.now().astimezone() - timedelta(hours=2)
    service.book.add(market="KR", side="BUY", symbol="005930", name="삼성전자", quantity="3",
                     created_at=created.isoformat(), reference_price="100000", requested_by="alice")
    service.run_due_reservations()
    assert service.store.paper_orders() == [] and service.book.all() == []
    assert "실행하지 않음" in service.notifier.sent[-1] and "11.0% 벗어남" in service.notifier.sent[-1]


def test_sell_reservation_closes_position(service, monkeypatch):
    q = reservation_service(service, monkeypatch, {"005930": 105_000})
    earlier = datetime.now().astimezone() - timedelta(hours=3)
    oid = service.desk(q).executor.buy("005930", "삼성전자", "KR", "KRW", 2, 100_000, None, earlier, "alice")
    service.book.add(market="KR", side="SELL", symbol="005930", name="삼성전자", quantity="2",
                     created_at=(earlier + timedelta(minutes=1)).isoformat(), reference_price="100000",
                     requested_by="bob", order_id=oid)
    service.run_due_reservations()
    row = service.store.paper_order(oid)
    assert (row["status"], row["exit_reason"], row["exit_price"], row["note"]) == (
        ex.CLOSED, "MANUAL", 105_000, "bob 매도")


def test_reservations_not_due_or_other_market_wait(service, monkeypatch):
    reservation_service(service, monkeypatch, {"AAPL": 200.0})
    created = datetime.now().astimezone() - timedelta(hours=2)
    service.book.add(market="US", side="BUY", symbol="AAPL", name="애플", quantity="1",
                     created_at=created.isoformat(), reference_price="200", requested_by="alice")
    service.run_due_reservations()  # MARKETS=KR이면 미국 예약은 실행하지 않는다
    assert len(service.book.all()) == 1 and service.store.paper_orders() == []


def test_reservation_executes_under_order_lock(service):
    r = type("R", (), {"id": 1, "label": "#1", "market": "KR", "is_due": lambda self, sessions, now: True})()
    service.book = type("B", (), {"all": lambda self: [r], "remove": lambda self, rid: True})()
    held = []
    service.execute_reservation = lambda r, now: held.append(not lock_free(service))
    service.run_due_reservations()
    assert held == [True] and lock_free(service)


# --- 전략, 생존 신호, 오류 처리 ---

def test_due_strategies_only_for_configured_markets(service, monkeypatch):
    service.redis = FakeRedis()
    service.strategies = StrategyBook(service.redis)
    kr = service.strategies.create(name="국내", market="KR", action="paper")
    service.strategies.create(name="미국", market="US")
    now = datetime.now().astimezone()
    service.sessions = lambda market, extended=False: [(now + timedelta(minutes=30), now + timedelta(hours=6))]
    started, done = [], threading.Event()
    monkeypatch.setattr(service, "_run_strategy_safely", lambda s, start: (started.append(s.id), done.set()),
                        raising=False)
    service.start_due_strategies()
    assert done.wait(WAIT) and started == [kr.id]
    service.start_due_strategies()  # 하루 한 번만
    assert started == [kr.id]


def test_beat_sets_heartbeat_with_ttl(service):
    calls = []

    class Recording(FakeRedis):
        def set(self, k, v, nx=False, ex=None):
            calls.append((k, ex))
            return super().set(k, v, nx, ex)

    service.redis = Recording()
    service.beat()
    assert calls == [("paper:engine:heartbeat", 120)]
    assert datetime.fromisoformat(service.redis.kv["paper:engine:heartbeat"]).tzinfo is not None


def test_run_jobs_reports_first_failure_then_recovery(service):
    failing, state = set(), {"fail": True}

    def job():
        if state["fail"]:
            raise main.KiwoomApiError(429, {"return_code": 5, "return_msg": "호출 제한"})

    service.run_jobs([("모의 체결 확인", job)], failing)
    service.run_jobs([("모의 체결 확인", job)], failing)
    assert len(service.notifier.sent) == 1 and "[오류] 모의 체결 확인 실패" in service.notifier.sent[0]
    state["fail"] = False
    service.run_jobs([("모의 체결 확인", job)], failing)
    assert service.notifier.sent[-1] == "모의 체결 확인 복구됨" and not failing


def test_each_thread_gets_its_own_store(service):
    mine = service.store
    assert service.store is mine and mine.account()["cash_krw"] == 10_000_000
    seen = []

    def work():
        other = service.store
        try:
            mine.paper_orders()
            shared = "ok"
        except sqlite3.ProgrammingError:  # 다른 스레드가 만든 연결은 쓸 수 없다
            shared = "error"
        seen.append((other, other is service.store, other.paper_orders(), shared))

    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(WAIT)
    ((other, same, rows, shared),) = seen
    assert other is not mine and same and rows == [] and shared == "error"


def test_store_uses_configured_capital(service):
    service.cfg = dataclasses.replace(service.cfg, paper_capital_krw=3_000_000)
    assert service.store.account()["initial_capital_krw"] == 3_000_000


# --- 일일 리포트와 시장 기록 ---

class FixedNow(main.datetime):
    at = None

    @classmethod
    def now(cls, tz=None):
        return cls.at


def daily_service(service, tmp_path, monkeypatch, hour):
    from test_daily import Client
    service.notifier = Notes()
    FixedNow.at = datetime(2026, 9, 30, hour, 0, tzinfo=KST)
    monkeypatch.setattr(main, "datetime", FixedNow)
    monkeypatch.setattr(main, "_client", lambda cfg: Client())
    monkeypatch.setattr(main, "REPORT_DIR", tmp_path / "reports")
    monkeypatch.setattr(main, "ROOT", tmp_path)
    monkeypatch.setattr(main, "BACKUP_DIR", tmp_path / "backups")
    monkeypatch.setattr(main.report, "find_chrome", lambda configured=None: None)
    return service


def test_daily_report_waits_for_report_hour(service, tmp_path, monkeypatch):
    daily_service(service, tmp_path, monkeypatch, main.REPORT_HOUR - 1)
    service.maybe_daily_report()
    assert service.notifier.files == [] and not (tmp_path / "reports").exists()


def test_daily_report_sent_once_a_day(service, tmp_path, monkeypatch):
    daily_service(service, tmp_path, monkeypatch, main.REPORT_HOUR)
    service.maybe_daily_report().join(WAIT)  # 리포트는 스레드에서 만든다
    (path, caption), = service.notifier.files
    assert path == tmp_path / "reports" / "daily-20260930.html"  # Chrome이 없으면 HTML
    assert caption.startswith("[일일 리포트] 2026-09-29 07:00 ~ 2026-09-30 07:00\n진행 중 모의 주문 0건")
    assert "모의 계좌 10,000,000원" in caption
    html = path.read_text()
    assert "AI 설정 없음" in html and "<h2>모의 계좌</h2>" in html
    assert "<h3>미국" not in html  # MARKETS=KR이면 미국 시장 동향은 넣지 않는다
    assert service.maybe_daily_report() is None
    assert len(service.notifier.files) == 1
    # 요청한 리포트는 시각까지 이름에 넣어 자동 발송분과 겹치지 않는다
    assert service.send_daily_report(7).name == "daily-20260930-070000.html"


def analysis_service(service, tmp_path, monkeypatch, fail=False, gate=None):
    """AI 설정이 있는 서비스. 국내 시장 기록(ETF A001 제외 상위 A002~A004)과 모의 계좌 보유 종목 005930."""
    from test_daily import NOW as RECORDED_AT, write_daily_run
    from test_market_log import MarketClient
    from paper_engine.records import market_log
    daily_service(service, tmp_path, monkeypatch, main.REPORT_HOUR)
    service.cfg = dataclasses.replace(service.cfg, llm_api_key="key", analysts=("model",))
    market_log.record_market(MarketClient(), service.store, "KR", "2026-09-29", RECORDED_AT)
    service.desk(Quotes()).executor.buy("005930", "삼성전자 <주>", "KR", "KRW", 1, 70_000, None,
                                        datetime(2026, 9, 29, 10, tzinfo=KST), "alice")
    calls = []

    def fake(cfg, notifier, symbols, roles=None, earlier=None):
        calls.append((list(symbols), roles))
        if gate:
            assert gate.wait(WAIT)
        if fail:
            raise RuntimeError("DevPass 연결 실패")
        path = write_daily_run(tmp_path / "runs")
        return f"runs/{path.name}"
    monkeypatch.setattr(main, "run_daily_analysis", fake)
    return calls


TARGETS = ["005930", "A002", "A003", "A004"]


def test_scheduled_daily_report_analyzes_in_thread_once(service, tmp_path, monkeypatch):
    gate = threading.Event()
    calls = analysis_service(service, tmp_path, monkeypatch, gate=gate)
    t = service.maybe_daily_report()
    assert t is not None and t.is_alive()  # 메인 루프는 분석을 기다리지 않는다
    assert service.maybe_daily_report() is None  # 분석 중에는 다시 띄우지 않는다
    gate.set()
    t.join(WAIT)
    assert not t.is_alive() and not service._daily_report_lock.locked()
    (symbols, roles), = calls
    assert symbols == TARGETS
    assert roles == {"005930": "보유·모의 주문", "A002": "거래대금 상위 (국내)", "A003": "거래대금 상위 (국내)",
                     "A004": "거래대금 상위 (국내)"}
    assert not any(m.startswith("AI 분석") for m in service.notifier.sent)  # 자동 발송의 분석 시작은 콘솔에만
    assert any(x.startswith("AI 분석 4종목 시작 (약 $0.3/종목)") for x in service.notifier.logged)
    (path, caption), = service.notifier.files
    assert path.name == "daily-20260930.html"
    assert caption.splitlines()[-1] == "AI 분석 3종목 · 추천 1개 · 비용 $0.93"
    assert "<h2>AI 분석</h2>" in path.read_text() and "새로 분석" in path.read_text()
    assert service.maybe_daily_report() is None and len(calls) == 1


def test_daily_report_reuses_todays_analysis(service, tmp_path, monkeypatch):
    from test_daily import write_daily_run
    calls = analysis_service(service, tmp_path, monkeypatch)
    write_daily_run(tmp_path / "runs")  # 오늘 06:40에 한 일일 분석
    service.maybe_daily_report().join(WAIT)
    service.send_daily_report(1)  # 분석을 요청하지 않은 리포트도 오늘 분석이 있으면 넣는다
    assert calls == []
    assert [c.splitlines()[-1] for _, c in service.notifier.files] == [
        "AI 분석 3종목 · 추천 1개 · 비용 $0.93 (오늘 앞서 한 분석 재사용)"] * 2


def test_report_without_todays_analysis_does_not_analyze(service, tmp_path, monkeypatch):
    calls = analysis_service(service, tmp_path, monkeypatch)
    (tmp_path / "runs").mkdir()
    (tmp_path / "runs" / "20260929-070000-daily.json").write_text("{}")  # 어제 분석은 쓰지 않는다
    service.send_daily_report(1)
    (path, caption), = service.notifier.files
    assert calls == [] and "AI 분석" not in caption and "오늘 일일 분석 없음" in path.read_text()


def test_requested_analysis_forces_new_analysis(service, tmp_path, monkeypatch):
    from test_daily import write_daily_run
    calls = analysis_service(service, tmp_path, monkeypatch)
    write_daily_run(tmp_path / "runs")  # 오늘 분석이 있어도 새로 한다
    service.start_daily_report(7, scheduled=False, analyze=True).join(WAIT)
    assert [c[0] for c in calls] == [TARGETS]
    assert any(m.startswith("AI 분석 4종목 시작 (약 $0.3/종목), 끝나면 리포트를 보냄: 삼성전자 <주>(005930)")
               for m in service.notifier.sent)
    (path, caption), = service.notifier.files
    assert path.name == "daily-20260930-070000.html" and "AI 분석 3종목" in caption and "재사용" not in caption


def test_daily_report_sent_even_if_analysis_fails(service, tmp_path, monkeypatch):
    calls = analysis_service(service, tmp_path, monkeypatch, fail=True)
    service.maybe_daily_report().join(WAIT)
    (path, caption), = service.notifier.files
    assert len(calls) == 1 and "AI 분석" not in caption
    assert "AI 분석 실패: RuntimeError: DevPass 연결 실패" in path.read_text()


def test_daily_report_thread_error_is_notified_once_a_day(service, tmp_path, monkeypatch):
    daily_service(service, tmp_path, monkeypatch, main.REPORT_HOUR)

    def broken(days=1, scheduled=False, analyze=False):
        raise sqlite3.OperationalError("disk I/O error")
    monkeypatch.setattr(service, "send_daily_report", broken, raising=False)
    service.maybe_daily_report().join(WAIT)
    service.maybe_daily_report().join(WAIT)  # 다시 시도하지만 알림은 한 번
    assert service.notifier.sent == ["[오류] 일일 리포트 실패: OperationalError: disk I/O error"]
    assert not service._daily_report_lock.locked()
    service.start_daily_report(1, scheduled=False, analyze=True).join(WAIT)  # 요청한 리포트는 매번 알린다
    assert len(service.notifier.sent) == 2


def test_run_daily_analysis_calls_analyze_without_buying(monkeypatch):
    seen = []

    def fake_analyze(args):
        seen.append(vars(args).copy())
        args.run_file = "runs/20260930-070000-daily.json"
        raise SystemExit("모델 응답 에러로 1개 종목의 분석을 중단했습니다.")
    monkeypatch.setattr(main, "cmd_analyze", fake_analyze)
    notes = Notes()
    cfg = Config(None, None, None, llm_api_key="key", analysts=("model",))
    assert main.run_daily_analysis(cfg, notes, ["005930"], {"005930": "보유"}) == "runs/20260930-070000-daily.json"
    (args,) = seen
    assert args == {"symbols": ["005930"], "equity": None, "commission": None, "no_web": False, "buy": False,
                    "by": "daily", "strategy": None, "max_amount_krw": None, "screen": None, "fractional": False,
                    "tag": "daily", "roles": {"005930": "보유"}, "earlier": None}
    assert "일부 실패" in notes.logged[0]
    assert main.run_daily_analysis(Config(None, None, None), notes, ["005930"]) is None  # AI 설정 없음
    assert main.run_daily_analysis(cfg, notes, []) is None and len(seen) == 1


def recorded_service(service, monkeypatch, markets=("KR",)):
    from test_market_log import MarketClient

    class Client(MarketClient):
        def prices(self, symbols):
            return [{"symbol": s, "lastPrice": "72000"} for s in symbols]

    service.cfg = dataclasses.replace(service.cfg, markets=markets)
    now = datetime.now().astimezone()
    service.sessions = lambda market, extended=False: [(now - timedelta(hours=10), now - timedelta(hours=1))]
    client = Client()
    monkeypatch.setattr(main, "_client", lambda cfg: client)
    return client, f"{(now - timedelta(hours=10)).date()}"


def test_record_markets_records_configured_markets_and_equity(service, monkeypatch):
    client, day = recorded_service(service, monkeypatch)
    agent = service.desk(Quotes()).executor
    agent.buy("005930", "삼성전자", "KR", "KRW", 10, 70_000, None, datetime.now().astimezone(), "alice")
    service.maybe_record_markets()
    assert service.store.market_day_recorded("KR", day) and not service.store.market_day_recorded("US", day)
    (eq,) = service.store.equity_days()
    assert eq["day"] == day and eq["holdings_value_krw"] == 720_000  # 장 마감 후 현재가(종가)로 평가
    assert eq["equity_krw"] == pytest.approx(10_000_000 - 700_000 * 1.00015 + 720_000)
    assert any(x.startswith(f"[자산 기록] {day}") for x in service.notifier.logged)
    service.maybe_record_markets()
    assert len(service.store.equity_days()) == 1  # 이미 기록한 날은 다시 하지 않는다


def test_record_markets_skips_recorded_day(service, monkeypatch):
    client, day = recorded_service(service, monkeypatch, markets=("KR", "US"))
    now = datetime.now().astimezone()
    service.store.add_market_day("KR", day, now.isoformat(), None, "069500", 1.0, None, None, [])
    service.maybe_record_markets()
    assert service.store.market_days("KR")[0]["bench_close"] == 1.0  # 이미 기록된 날은 그대로
    assert service.store.market_day_recorded("US", day) and service.store.equity_days() == []
    assert [c[2]["market"] for c in client.calls if c[0] == "rankings_with_time"] == ["US"]
    (line,) = service.notifier.logged
    assert line.startswith(f"[시장 기록] 미국 {day}: 거래대금 상위 100 · 상승 30 · 하락 30 · 벤치마크 SPY $102.00 (+2.00%)")


def test_record_markets_tracks_predictions_after_recording(service, monkeypatch):
    from test_store import add, candidate
    client, _ = recorded_service(service, monkeypatch, markets=("KR", "US"))
    calls = []
    monkeypatch.setattr(main, "track_paper", lambda client, store, notifier: calls.append(client) or [])
    service.maybe_record_markets()
    assert calls == []  # 진행 중인 예측 추적이 없으면 돌리지 않는다
    add(service.store, candidate())
    for m in ("KR", "US"):
        service.store.db.execute("DELETE FROM market_days WHERE market=?", (m,))
    service.maybe_record_markets()
    assert calls == [client, client]  # 시장마다 기록 직후
    service.maybe_record_markets()
    assert len(calls) == 2


def test_scheduled_daily_report_tracks_predictions_first(service, tmp_path, monkeypatch):
    from test_store import add, candidate
    daily_service(service, tmp_path, monkeypatch, main.REPORT_HOUR)
    add(service.store, candidate())
    calls = []
    monkeypatch.setattr(main, "track_paper", lambda client, store, notifier: calls.append(client) or [])
    service.send_daily_report(1, scheduled=False)
    assert calls == []
    service.maybe_daily_report().join(WAIT)
    assert len(calls) == 1


def test_serve_does_not_need_openclaw(tmp_path, monkeypatch):
    monkeypatch.setattr(Service, "db_path", tmp_path / "trading.db")
    s = Service(Config("key", "secret", None))
    from paper_engine.notify import ConsoleNotifier
    assert isinstance(s.notifier, ConsoleNotifier)  # OPENCLAW_TARGET이 없으면 콘솔
    assert s.redis is None and s.book is None and s.store.account()["cash_krw"] == 10_000_000
    assert json.dumps(s.cfg.commission)
