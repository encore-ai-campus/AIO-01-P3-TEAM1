import pytest

from paper_engine.records import paper
from paper_engine.records.paper import simulate


def candle(date, open_, high, low, close):
    return {"date": date, "open": open_, "high": high, "low": low, "close": close}


def run(candles, holding_days=10):
    return simulate(entry=100, target=110, stop=95, holding_days=holding_days, candles=candles)


def test_pending_without_candles():
    assert run([]).status == paper.PENDING


def test_pending_then_unfilled_after_window():
    above = [candle(f"d{i}", 103, 105, 101, 104) for i in range(5)]
    assert run(above[:4]).status == paper.PENDING
    assert run(above).status == paper.UNFILLED
    # 체결 기한이 지난 뒤에 진입가에 닿아도 체결로 보지 않는다
    assert run(above + [candle("d5", 100, 101, 99, 100)]).status == paper.UNFILLED


def test_fills_at_entry_intraday_and_stays_open():
    o = run([candle("d1", 102, 103, 99, 101)])
    assert (o.status, o.filled_at, o.fill_price) == (paper.OPEN, "d1", 100)


def test_fills_at_open_when_open_below_entry():
    o = run([candle("d1", 98, 101, 97, 100)])
    assert o.fill_price == 98


def test_target_hit_next_day():
    o = run([candle("d1", 102, 103, 99, 101), candle("d2", 101, 111, 100, 109)])
    assert (o.status, o.closed_at, o.exit_price) == (paper.TARGET, "d2", 110)


def test_target_not_counted_on_intraday_fill_day():
    # 고가 111이 체결 전에 나왔을 수 있으므로 목표 도달로 보지 않는다
    assert run([candle("d1", 105, 111, 99, 101)]).status == paper.OPEN


def test_target_counted_on_fill_day_when_filled_at_open():
    o = run([candle("d1", 99, 111, 98, 105)])
    assert (o.status, o.exit_price) == (paper.TARGET, 110)


def test_stop_on_fill_day():
    o = run([candle("d1", 102, 103, 94, 96)])
    assert (o.status, o.exit_price) == (paper.STOP, 95)


def test_stop_wins_when_both_hit_in_same_candle():
    o = run([candle("d1", 99, 100, 98, 99), candle("d2", 100, 112, 94, 105)])
    assert o.status == paper.STOP


def test_gap_down_exits_at_open():
    o = run([candle("d1", 99, 100, 98, 99), candle("d2", 90, 92, 89, 91)])
    assert (o.status, o.exit_price) == (paper.STOP, 90)


def test_gap_up_exits_at_open():
    o = run([candle("d1", 99, 100, 98, 99), candle("d2", 115, 116, 114, 115)])
    assert (o.status, o.exit_price) == (paper.TARGET, 115)


def test_gap_below_stop_on_fill_day_fills_at_open():
    o = run([candle("d1", 93, 94, 92, 93)])
    assert (o.status, o.fill_price, o.exit_price) == (paper.STOP, 93, 95)


def test_expires_at_close_after_holding_days():
    candles = [candle("d1", 99, 101, 98, 100), candle("d2", 100, 103, 99, 102)]
    o = run(candles, holding_days=2)
    assert (o.status, o.closed_at, o.exit_price) == (paper.EXPIRED, "d2", 102)


def test_pnl_includes_costs():
    assert paper.pnl(10, 100, 110, 0, 0) == pytest.approx(100)
    assert paper.pnl(10, 100, 110, 0.001, 0.002) == pytest.approx(100 - 1 - 3.3)


def test_track_paper_updates_changed_trade_only():
    from test_store import add, candidate
    from paper_engine import __main__ as main
    from paper_engine.records.store import Store

    class Client:
        def completed_daily_candles(self, symbol, market):
            def c(day, o, h, l, cl):  # noqa: E741
                return {"timestamp": f"{day}T00:00:00+09:00", "openPrice": o, "highPrice": h,
                        "lowPrice": l, "closePrice": cl}
            return [c("2026-09-29", 100_000, 101_000, 99_000, 100_500),
                    c("2026-09-30", 100_500, 116_000, 100_000, 115_000)]

    class Notes:
        sent = []

        def send(self, text):
            self.sent.append(text)

    store = Store(":memory:")
    trade_id = add(store, candidate())  # 생성일 2026-09-28, 진입 10만 / 목표 11.5만 / 손절 9.5만
    notes = Notes()
    (line,) = main.track_paper(Client(), store, notes)
    assert line.startswith(f"#{trade_id} 삼성전자 (claude, 선별) PENDING → TARGET") and "손익" in line
    assert notes.sent == [line] and store.active_trades() == []
    assert main.track_paper(Client(), store, notes) == []  # 상태가 같으면 건너뜀
