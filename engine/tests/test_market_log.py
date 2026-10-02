from datetime import datetime, timedelta, timezone

from paper_engine.records import market_log
from paper_engine.records.store import Store

KST = timezone(timedelta(hours=9))
ET = timezone(timedelta(hours=-4))


def kr(day: int):
    return (datetime(2026, 9, day, 9, 0, tzinfo=KST), datetime(2026, 9, day, 15, 30, tzinfo=KST))


# --- due_day ---

def test_due_after_session_end_plus_delay():
    sessions = [kr(29), kr(30)]
    assert market_log.due_day(sessions, datetime(2026, 9, 30, 15, 44, tzinfo=KST)) is None  # 종료 14분 뒤
    assert market_log.due_day(sessions, datetime(2026, 9, 30, 15, 45, tzinfo=KST)) == "2026-09-30"


def test_due_picks_latest_finished_session():
    sessions = [kr(28), kr(29), kr(30)]
    assert market_log.due_day(sessions, datetime(2026, 9, 30, 20, 0, tzinfo=KST)) == "2026-09-30"
    # 다음 정규장이 시작하기 전(아침)에는 전일 것이 기록 대상이다 (serve가 멈춰 있던 경우)
    assert market_log.due_day(sessions, datetime(2026, 9, 30, 8, 0, tzinfo=KST)) == "2026-09-29"


def test_no_due_day_when_nothing_finished_or_next_session_started():
    assert market_log.due_day([], datetime(2026, 9, 30, 20, 0, tzinfo=KST)) is None
    assert market_log.due_day([kr(30)], datetime(2026, 9, 30, 12, 0, tzinfo=KST)) is None
    # 오늘 정규장이 이미 열렸으면 랭킹이 오늘 값이라 전일 기록으로 남기지 않는다
    assert market_log.due_day([kr(29), kr(30)], datetime(2026, 9, 30, 10, 0, tzinfo=KST)) is None


def test_us_day_is_local_date():
    session = (datetime(2026, 9, 29, 9, 30, tzinfo=ET), datetime(2026, 9, 29, 16, 0, tzinfo=ET))
    now = datetime(2026, 9, 30, 5, 30, tzinfo=KST)  # 미국 9/29 16:30
    assert market_log.due_day([session], now) == "2026-09-29"


# --- record_market ---

def rank_item(rank, symbol, price=100.0, change=0.01):
    return {"rank": rank, "symbol": symbol, "price": {"lastPrice": str(price), "changeRate": str(change)},
            "tradingAmount": str(rank * 1_000_000), "tradingVolume": str(rank * 10)}


class MarketClient:
    def __init__(self, close=(100.0, 102.0), rate="1390.5"):
        self.close, self.rate = close, rate
        self.calls = []

    def rankings_with_time(self, type_, market, duration="1d", count=30, exclude_caution=True):
        self.calls.append(("rankings_with_time", type_, {"market": market, "count": count, "excludeCaution": exclude_caution}))
        return [rank_item(i, f"A{i:03d}") for i in range(1, 101)], "2026-09-30T15:30:00+09:00"

    def rankings(self, type_, market, duration="1d", count=30):
        self.calls.append(("rankings", type_, market, count))
        prefix = "G" if type_ == "TOP_GAINERS" else "L"
        change = 0.2 if prefix == "G" else -0.2
        return [rank_item(i, f"{prefix}{i:02d}", change=change) for i in range(1, count + 1)]

    def stocks(self, symbols):
        self.calls.append(("stocks", len(symbols)))
        return [{"symbol": s, "name": f"종목{s}", "securityType": "ETF" if s == "A001" else "STOCK"}
                for s in symbols]

    def daily_candles(self, symbol, count=200):
        self.calls.append(("candles", symbol, count))
        return [{"closePrice": str(c)} for c in self.close]

    def exchange_rate(self):
        return {"rate": self.rate}


NOW = datetime(2026, 9, 30, 15, 50, tzinfo=KST)


def test_record_market_saves_rankings_bench_and_fx():
    store, client = Store(":memory:"), MarketClient()
    out = market_log.record_market(client, store, "KR", "2026-09-30", NOW)
    assert out == {"market": "KR", "day": "2026-09-30", "amount": 100, "gainers": 30, "losers": 30,
                   "benchClose": 102.0, "benchChange": 102 / 100 - 1, "usdKrw": 1390.5}
    assert store.market_day_recorded("KR", "2026-09-30") and not store.market_day_recorded("US", "2026-09-30")
    (day,) = store.market_days("KR")
    assert day["ranked_at"] == "2026-09-30T15:30:00+09:00" and day["bench_symbol"] == "069500"
    assert day["bench_close"] == 102.0 and abs(day["bench_change"] - 0.02) < 1e-9 and day["usd_krw"] == 1390.5
    amount = store.rankings("KR", "2026-09-30", market_log.AMOUNT)
    assert len(amount) == 100 and amount[0]["symbol"] == "A001" and amount[0]["security_type"] == "ETF"
    assert amount[0]["name"] == "종목A001" and amount[0]["trading_amount"] == 1_000_000
    assert [r["symbol"] for r in store.rankings("KR", "2026-09-30", market_log.GAINERS)][:2] == ["G01", "G02"]
    losers = store.rankings("KR", "2026-09-30", market_log.LOSERS)
    assert len(losers) == 30 and losers[0]["change_rate"] == -0.2  # 리포트가 ETF를 뺀 뒤 10개를 남기도록 넉넉히
    # 랭킹은 투자 유의 종목을 빼고 받고, 종목 정보는 120종목을 100개씩 나눠 조회한다
    assert client.calls[0][2] == {"market": "KR", "count": 100, "excludeCaution": True}
    assert [c for c in client.calls if c[0] == "stocks"] == [("stocks", 100), ("stocks", 60)]


def test_record_same_day_again_overwrites():
    store = Store(":memory:")
    market_log.record_market(MarketClient(), store, "US", "2026-09-29", NOW)
    market_log.record_market(MarketClient(close=(200.0,), rate="1400"), store, "US", "2026-09-29", NOW)
    (day,) = store.market_days("US")
    assert day["bench_symbol"] == "SPY" and day["bench_close"] == 200.0 and day["bench_change"] is None
    assert day["usd_krw"] == 1400
    assert len(store.rankings("US", "2026-09-29", market_log.AMOUNT)) == 100
    assert store.market_day_count("US") == 1


def test_record_market_continues_without_exchange_rate():
    class NoFx(MarketClient):
        def exchange_rate(self):
            from paper_engine.data.kiwoom import KiwoomApiError
            raise KiwoomApiError(403, {"return_code": 2, "return_msg": "해외주식 계좌 없음"})

    store = Store(":memory:")
    out = market_log.record_market(NoFx(), store, "KR", "2026-09-30", NOW)
    assert out["usdKrw"] is None and store.market_days("KR")[0]["usd_krw"] is None  # MARKETS=KR은 환율 없이도 기록
