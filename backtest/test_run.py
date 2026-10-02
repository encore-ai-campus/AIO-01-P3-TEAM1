"""run.py의 유니버스: 키움은 당일 순위만 주므로 시장 기록(rankings 표)에 쌓인 거래대금 상위를 더한다."""
from datetime import datetime, timedelta, timezone

from paper_engine.records.store import Store
from run import recorded_universe


def test_recorded_universe_reads_amount_rankings(tmp_path):
    db = tmp_path / "trading.db"
    assert recorded_universe("KR", db) == {}  # 기록이 없으면 빈 유니버스
    store = Store(db)
    now = datetime(2026, 9, 30, 16, tzinfo=timezone(timedelta(hours=9))).isoformat()
    for day, symbols in (("2026-09-29", ["A", "B"]), ("2026-09-30", ["B", "C"])):
        store.add_market_day("KR", day, now, None, "069500", 1.0, None, None,
                             [{"type": "AMOUNT", "rank": i, "symbol": s} for i, s in enumerate(symbols, 1)]
                             + [{"type": "GAINERS", "rank": 1, "symbol": "G"}])
    store.add_market_day("US", "2026-09-30", now, None, "SPY", 1.0, None, None,
                         [{"type": "AMOUNT", "rank": 1, "symbol": "AAPL"}])
    assert recorded_universe("KR", db) == {"A": "2026-09-29", "B": "2026-09-29", "C": "2026-09-30"}
