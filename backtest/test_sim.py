"""백테스트 시뮬레이션 규칙. 실행: uv run pytest backtest"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from sim import EXPIRED, OPEN, STOP, TARGET, UNFILLED, Backtest, Rule, Settings, plan_prices, simulate_trade  # noqa: E402


FAR = "2099-01-01"  # 기한이 영향을 주지 않는 경우


def bar(day, o, h, l, c, v=1_000_000):  # noqa: E741
    return {"date": day, "openPrice": str(o), "highPrice": str(h), "lowPrice": str(l), "closePrice": str(c),
            "volume": str(v)}


def test_day_order_not_filled_is_cancelled():
    assert simulate_trade([bar("2026-06-01", 101, 105, 100.5, 104)], 100, 110, 95, 94, FAR)[0] == UNFILLED
    assert simulate_trade([], 100, 110, 95, 94, FAR)[0] == UNFILLED


def test_intraday_fill_ignores_target_that_day():
    bars = [bar("2026-06-01", 102, 111, 99, 108), bar("2026-06-02", 108, 112, 107, 111)]
    assert simulate_trade(bars, 100, 110, 95, 94, FAR) == (TARGET, "2026-06-01", 100, "2026-06-02", 110)


def test_open_fill_can_hit_target_same_day():
    bars = [bar("2026-06-01", 99, 111, 98, 108)]
    assert simulate_trade(bars, 100, 110, 95, 94, FAR) == (TARGET, "2026-06-01", 99, "2026-06-01", 110)


def test_stop_sells_at_stop_order_price_and_wins_ties():
    bars = [bar("2026-06-01", 100, 101, 99, 100), bar("2026-06-02", 100, 111, 94.5, 100)]
    assert simulate_trade(bars, 100, 110, 95, 94, FAR) == (STOP, "2026-06-01", 100, "2026-06-02", 94)


def test_gap_down_sells_at_open():
    bars = [bar("2026-06-01", 100, 101, 99, 100), bar("2026-06-02", 90, 92, 89, 91)]
    assert simulate_trade(bars, 100, 110, 95, 94, FAR)[3:] == ("2026-06-02", 90)


def test_expiry_sells_at_next_open_after_expire_date():
    bars = [bar("2026-06-01", 100, 101, 99, 100), bar("2026-06-17", 101, 102, 100, 101),
            bar("2026-06-18", 103, 104, 102, 103)]
    assert simulate_trade(bars, 100, 110, 95, 94, "2026-06-17") == (EXPIRED, "2026-06-01", 100, "2026-06-18", 103)
    assert simulate_trade(bars[:2], 100, 110, 95, 94, "2026-06-17")[0] == OPEN


def test_plan_prices_use_ticks_and_stop_buffer():
    assert plan_prices(19_455, 21_404, 18_507, "KRW") == (19_450, 21_400, 18_500, 18_310)


def test_backtest_buys_only_approved_and_tracks_cash():
    # 100일 완만한 상승 후 6/1 진입, 6/2 목표가 도달
    days = [f"2026-{m:02d}-{d:02d}" for m in (2, 3, 4, 5) for d in range(1, 29)][:100]
    closes = [100 + i * 0.3 + (2 if i % 2 else -2) for i in range(len(days))]  # 오르내리며 상승 (RSI 50대)
    bars = [bar(d, c, c + 1.5, c - 1.5, c) for d, c in zip(days, closes)]
    last = float(bars[-1]["closePrice"])
    bars += [bar("2026-06-01", last - 1, last, last - 2, last), bar("2026-06-02", last, last * 1.3, last, last * 1.2)]
    s = Settings(market="KR", currency="KRW", start="2026-06-01", end="2026-06-02", commission_rate=0.0)
    ok = Backtest(s, Rule("r", 5.0, 1.0, holding_days=10), {"A": bars}, {"A": "에이"}).run()
    t, again = ok.trades
    assert t.approved and t.placed and t.status == TARGET and t.quantity > 0
    assert again.day == "2026-06-02" and not again.placed  # 장 전에는 아직 같은 종목을 보유 중
    assert ok.funnel["skippedActive"] == 1 and ok.funnel["filled"] == 1
    assert ok.equity[-1][1] > s.capital_krw
    low = Backtest(s, Rule("r", 1.0, 1.0), {"A": bars}, {"A": "에이"}).run()
    assert not low.trades[0].placed and low.equity[-1][1] == s.capital_krw


def test_open_mode_fills_at_open_even_above_entry():
    bars = [bar("2026-06-01", 101, 105, 100.5, 104), bar("2026-06-02", 104, 111, 103, 110)]
    assert simulate_trade(bars, 100, 110, 95, 94, FAR, entry_mode="open") == (TARGET, "2026-06-01", 101, "2026-06-02", 110)


def test_fill_window_keeps_limit_order_alive():
    bars = [bar("2026-06-01", 101, 105, 100.5, 104), bar("2026-06-02", 101, 102, 99, 100)]
    assert simulate_trade(bars, 100, 110, 95, 94, FAR)[0] == UNFILLED
    assert simulate_trade(bars, 100, 110, 95, 94, FAR, fill_window=2)[1:3] == ("2026-06-02", 100)


def test_trailing_stop_uses_previous_highs():
    bars = [bar("2026-06-01", 100, 104, 99, 103), bar("2026-06-02", 104, 110, 104, 109),
            bar("2026-06-03", 108, 109, 105, 106)]
    # 전날까지 최고가 110 − 3 = 107 > 95 → 감시가 107, 주문가 105.93. 6/3 저가 105가 닿는다
    assert simulate_trade(bars, 100, 120, 95, 94, FAR, trail=3.0, currency="USD") == (
        STOP, "2026-06-01", 100, "2026-06-03", 105.93)
