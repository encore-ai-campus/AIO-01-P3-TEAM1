"""모의 주문 창구(trading.Desk)와 모의 계좌 CLI. 키움은 가짜, 예약은 가짜 Redis."""
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

import paper_engine.__main__ as main
from paper_engine import trading
from paper_engine.agents import executor as ex
from paper_engine.agents.executor import OrderRejected
from paper_engine.config import Config
from paper_engine.records.store import Store
from paper_engine.scheduler import ReservationBook
from paper_engine.symbols import SymbolError

from test_scheduler import FakeRedis

KST = timezone(timedelta(hours=9))
NOW = datetime(2026, 9, 29, 10, 0, tzinfo=KST)
EVENING = datetime(2026, 9, 29, 20, 0, tzinfo=KST)
KR_SESSIONS = [(datetime(2026, 9, 29, 9, 0, tzinfo=KST), datetime(2026, 9, 29, 15, 30, tzinfo=KST)),
               (datetime(2026, 9, 30, 9, 0, tzinfo=KST), datetime(2026, 9, 30, 15, 30, tzinfo=KST))]
STOCKS = {"005930": {"symbol": "005930", "name": "삼성전자", "currency": "KRW", "status": "ACTIVE"},
          "AAPL": {"symbol": "AAPL", "name": "애플", "currency": "USD", "status": "ACTIVE"},
          "000001": {"symbol": "000001", "name": "정지주", "currency": "KRW", "status": "SUSPENDED"}}


class Notes:
    def __init__(self):
        self.sent, self.logged = [], []

    def send(self, text):
        self.sent.append(text)

    def log(self, text):
        self.logged.append(text)


class Quotes:
    def __init__(self, prices):
        self.quotes = prices

    def confirmed_prices(self, symbols):
        return {s: self.quotes[s] for s in symbols if s in self.quotes}

    def prices(self, symbols):
        return [{"symbol": s, "lastPrice": str(self.quotes[s])} for s in symbols if s in self.quotes]

    def stocks(self, symbols):
        return [STOCKS[s] for s in symbols if s in STOCKS]

    def exchange_rate(self):
        return {"rate": "1400"}


def desk(tmp_path, prices=None, book=True, markets=("KR",)):
    cfg = Config("key", "secret", None, markets=markets)
    return trading.Desk(cfg, Store(":memory:"), Notes(), Quotes(prices or {"005930": 100_000, "AAPL": 200.0}),
                        ReservationBook(FakeRedis()) if book else None, tmp_path / "HALT",
                        sessions=lambda market: KR_SESSIONS)


def test_market_buy_in_session_fills(tmp_path):
    d = desk(tmp_path)
    assert d.buy("005930", 3, "alice", target=110_000, stop=95_000, now=NOW) == "모의 주문 #1 보유 중"
    row = d.store.paper_order(1)
    assert (row["fill_price"], row["requested_by"], row["expire_date"]) == (100_000, "alice", "2026-10-29")  # 기본 30일


def test_market_buy_off_hours_becomes_reservation(tmp_path):
    d = desk(tmp_path)
    msg = d.buy("005930", 3, "alice", target=110_000, stop=95_000, days=10, now=EVENING)
    assert msg == "예약 #1 (09-30 09:00 실행)" and d.store.paper_orders() == []
    (r,) = d.book.all()
    assert (r.side, r.symbol, r.quantity, r.reference_price, r.requested_by, r.target, r.stop, r.days) == (
        "BUY", "005930", "3", "100000", "alice", "110000", "95000", 10)
    assert d.notifier.sent[-1].startswith("[예약] #1 삼성전자 (005930) 3주 시장가 매수")
    with pytest.raises(OrderRejected, match="순서가 아님"):  # 예약도 접수 때 점검한다
        d.buy("005930", 3, "alice", target=99_000, stop=95_000, now=EVENING)
    with pytest.raises(OrderRejected, match="REDIS_URL"):
        desk(tmp_path, book=False).buy("005930", 3, "alice", now=EVENING)


def test_limit_buy_off_hours_waits_as_pending(tmp_path):
    d = desk(tmp_path)
    assert d.buy("005930", 3, "alice", limit=99_000, now=EVENING) == "모의 주문 #1 체결 대기"
    assert d.book.all() == []


def test_buy_checks_symbol_and_markets(tmp_path, monkeypatch):
    d = desk(tmp_path)
    with pytest.raises(OrderRejected, match="MARKETS에 US"):
        d.buy("AAPL", 1, "alice", now=NOW)
    with pytest.raises(SymbolError, match="거래 가능한 상태가 아님"):
        d.buy("000001", 1, "alice", now=NOW)
    seen = []
    monkeypatch.setattr(trading, "listed_stocks", lambda client, markets: seen.append(markets) or [
        {"symbol": "005930", "name": "삼성전자"}])
    assert d.buy("삼성 전자", 1, "alice", now=NOW) == "모의 주문 #1 보유 중"
    assert seen == [["KOSPI", "KOSDAQ"]]  # MARKETS=KR이면 국내 목록만
    with pytest.raises(OrderRejected, match="기한은 1~180일"):
        d.buy("005930", 1, "bob", target=110_000, stop=95_000, days=0, now=NOW)


def test_us_buy_when_us_market_enabled(tmp_path):
    d = desk(tmp_path, markets=("KR", "US"))
    d.buy("AAPL", 0.25, "alice", now=NOW)
    row = d.store.paper_order(1)
    assert (row["market"], row["quantity"], row["fill_fx_rate"]) == ("US", 0.25, 1_400)


def test_sell_in_session_off_hours_and_pending(tmp_path):
    d = desk(tmp_path)
    d.buy("005930", 3, "alice", now=NOW)
    assert d.sell(1, "bob", now=EVENING) == "예약 #1 (09-30 09:00 실행)"
    (r,) = d.book.all()
    assert (r.side, r.order_id, r.requested_by) == ("SELL", 1, "bob")
    with pytest.raises(OrderRejected, match="매도 예약이 이미 있음"):
        d.sell(1, "bob", now=EVENING)
    assert d.sell(1, "bob", now=NOW + timedelta(minutes=5)) == "모의 주문 #1 매도 완료"
    assert d.store.paper_order(1)["exit_reason"] == "MANUAL"
    d.buy("005930", 1, "alice", limit=90_000, now=NOW)
    assert d.sell(2, "alice", now=NOW) == "모의 주문 #2 취소"
    with pytest.raises(OrderRejected, match="#9이\\(가\\) 없음"):
        d.sell(9, "alice", now=NOW)


def test_run_reservation_rejects_closed_position(tmp_path):
    d = desk(tmp_path)
    d.buy("005930", 3, "alice", now=NOW)
    d.sell(1, "bob", now=EVENING)
    (r,) = d.book.all()
    d.executor.sell(1, 101_000, None, NOW, "alice")  # 예약 실행 전에 이미 청산됨
    with pytest.raises(OrderRejected, match="보유 중이 아님"):
        d.run_reservation(r, NOW + timedelta(days=1))


def test_modify_and_cancel(tmp_path):
    d = desk(tmp_path)
    d.buy("005930", 3, "alice", target=110_000, stop=95_000, now=NOW)
    new = d.modify(1, None, 97_000, 5, now=NOW)
    assert new == {"target_price": 110_000, "stop_price": 97_000, "expire_date": "2026-10-04"}
    with pytest.raises(OrderRejected, match="보유 중인 포지션은 매도"):
        d.cancel(1, "alice", now=NOW)


def test_sync_summary(tmp_path):
    d = desk(tmp_path, prices={"005930": 99_000})
    assert d.sync(NOW) == "10:00 진행 중인 모의 주문 없음"
    d.buy("005930", 1, "alice", limit=99_500, now=NOW)
    assert d.sync(NOW + timedelta(minutes=1)) == "10:01 모의 주문 1건 확인 (KR 정규장)"
    assert d.store.paper_order(1)["status"] == ex.EXIT_WATCHING
    assert d.sync(EVENING) == "20:00 모의 주문 1건 확인 (KR 장 밖)"



def test_account_context_counts_only_swing_orders(tmp_path, monkeypatch):
    """AI 경로(SWING만 매매)의 하루 주문 수 한도에는 장기 보유(style long) 주문을 세지 않는다."""
    class Today(date):
        @classmethod
        def today(cls):
            return cls(2026, 9, 29)
    monkeypatch.setattr(trading, "date", Today)
    d = desk(tmp_path)
    d.executor.buy("005930", "종목", "KR", "KRW", 1, 100_000, None, NOW, "alice", 99_000, 110_000, 90_000, None,
                   regular_open=False)
    for symbol in ("000660", "035420"):
        d.executor.buy(symbol, "종목", "KR", "KRW", 1, 100_000, None, NOW, "alice", 99_000, regular_open=False,
                       style=ex.LONG)
    assert d.store.paper_today("2026-09-29") == (3, 0.0)
    assert d.account_context("005930", "KRW", None, []).daily_trades == 1

def test_account_summary_without_client_uses_fill_price(tmp_path):
    d = desk(tmp_path)
    d.buy("005930", 2, "alice", now=NOW)
    offline = trading.Desk(d.cfg, d.store, Notes(), None, None, tmp_path / "HALT")
    s = offline.account_summary()
    assert s["holdingsValueKrw"] == 200_000 and not s["holdings"][0]["priced"]
    with pytest.raises(OrderRejected, match="키움 클라이언트가 없음"):
        offline.buy("005930", 1, "alice", now=NOW)


# --- CLI (키움 키 없이 되는 명령) ---

@pytest.fixture
def cli(tmp_path, monkeypatch):
    for key in ("KIWOOM_APPKEY", "KIWOOM_SECRETKEY", "REDIS_URL", "OPENCLAW_TARGET"):
        monkeypatch.setenv(key, "")
    monkeypatch.setattr(main, "DB_PATH", tmp_path / "data" / "trading.db")
    monkeypatch.setattr(main, "HALT_FILE", tmp_path / "data" / "HALT")
    return tmp_path


def test_cli_account_orders_fills_halt_resume_without_keys(cli, capsys):
    main.main(["account"])
    out = capsys.readouterr().out
    assert "모의 계좌 (팀 공용) 총자산 10,000,000원" in out and "보유 없음" in out and "체결가로 평가" in out
    store = Store(main.DB_PATH)
    agent = ex.PaperExecutor(store, Notes(), main.HALT_FILE, {"KR": 0.00015, "US": 0.00015})
    agent.buy("005930", "삼성전자", "KR", "KRW", 2, 100_000, None, NOW, "alice", target=110_000, stop=95_000)
    main.main(["orders"])
    assert "#1 2026-09-29 10:00 삼성전자 (005930) 2주 시장가 · EXIT_WATCHING · 체결 100,000원" in capsys.readouterr().out
    main.main(["fills", "--limit", "5"])
    assert "#1 삼성전자 (005930) 매수 2주 @ 100,000원" in capsys.readouterr().out
    main.main(["halt"])
    assert main.HALT_FILE.exists() and "새 모의 매수를 받지 않습니다" in capsys.readouterr().out
    main.main(["orders", "--all"])
    assert "중단 스위치: 켜짐" in capsys.readouterr().out
    main.main(["resume"])
    assert not main.HALT_FILE.exists()
    with pytest.raises(SystemExit, match="보유 중인 포지션은 매도"):  # 거절은 종료 메시지로
        main.main(["cancel", "1"])


def test_cli_rejections_exit_with_message(cli, capsys):
    with pytest.raises(SystemExit, match="주문하지 않음: 모의 주문 #3이\\(가\\) 없음"):
        main.main(["cancel", "3"])
    with pytest.raises(SystemExit, match="KIWOOM_APPKEY"):
        main.main(["buy", "005930", "1"])
    with pytest.raises(SystemExit, match="REDIS_URL"):
        main.main(["reservations"])


def test_every_command_has_help():
    env = dict(os.environ, PYTHONPATH=str(Path(main.__file__).resolve().parents[1]))
    out = subprocess.run([sys.executable, "-m", "paper_engine", "--help"], capture_output=True, text=True, env=env)
    assert out.returncode == 0
    for name in ("account", "orders", "fills", "buy", "sell", "cancel", "modify", "reservations", "sync", "serve",
                 "analyze", "daily-report", "halt", "resume"):
        assert name in out.stdout
    with pytest.raises(SystemExit) as e:
        main.main(["buy", "--help"])
    assert e.value.code == 0
