"""실시간 시세 (docs/API.md 공통 규칙 "실시간 시세", docs/DECISIONS.md 17): Quote(live·close)와 StockDetail의 일봉·asOf.

지금 시각을 고정하고(django.utils.timezone.now), 장 달력은 엔진 MarketCalendar(공휴일 키 없음 — 양력 고정 공휴일은 안다)로
그 시각 기준으로 만든다. 일봉은 지금(시장 현지 날짜)까지의 봉만 주고, 현재가(FakeClient.price)는 일봉과 따로 정한다.
날짜: 2026-09-17(목)·18(금)·19(토)·21(월)·22(화), 2026-10-07(수)·08(목)·09(금, 한글날 휴장)·10(토).
"""
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from django.core.cache import cache
from django.utils import timezone
from paper_engine.data.calendar import MarketCalendar

from config import engine
from trading import market

from .conftest import FakeClient

pytestmark = pytest.mark.django_db
KST = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")
BASE = {"005930": 70000.0, "005935": 60000.0, "000660": 200000.0, "AAPL": 200.0}  # 일봉 종가 = BASE × 날짜별 비율
SEPTEMBER = {"2026-09-17": 0.96, "2026-09-18": 0.97, "2026-09-21": 0.98, "2026-09-22": 0.99}
OCTOBER = {"2026-10-07": 0.96, "2026-10-08": 0.97, "2026-10-12": 0.98}


class LiveClient(FakeClient):
    """고정 시각(now)의 장 달력과 days(날짜 → 비율)의 일봉 중 지금(시장 현지 날짜)까지의 봉을 준다.

    today_candle이 False면 오늘 봉을 주지 않는다 (장 시작 전). calendar_fails면 장 달력 조회가 실패한다.
    """

    def __init__(self):
        super().__init__()
        self.now: datetime | None = None
        self.calendars = MarketCalendar()
        self.days = dict(SEPTEMBER)
        self.today_candle = True
        self.calendar_fails = False

    def market_calendar(self, market_country):
        self._hit("market_calendar")
        if self.calendar_fails:
            raise OSError("장 달력 조회 실패")
        return self.calendars.calendar(market_country, self.now)

    def daily_candles(self, symbol, count=200):
        self._hit("daily_candles")
        tz, offset = (NEW_YORK, "-04:00") if symbol == "AAPL" else (KST, "+09:00")
        today = f"{self.now.astimezone(tz).date()}"
        rows = [(day, BASE[symbol] * rate) for day, rate in self.days.items()
                if day < today or (day == today and self.today_candle)]
        return [{"timestamp": f"{day}T00:00:00{offset}", "openPrice": f"{c:g}", "highPrice": f"{c:g}",
                 "lowPrice": f"{c:g}", "closePrice": f"{c:g}", "volume": "1000"} for day, c in rows][-count:]


class SpyCache:
    """market.cache를 감싸 set의 TTL을 기록한다."""

    def __init__(self, real):
        self.real, self.ttls = real, {}

    def __getattr__(self, name):  # get·delete·clear는 그대로
        return getattr(self.real, name)

    def set(self, key, value, timeout=None):
        self.ttls[key] = timeout
        self.real.set(key, value, timeout)


def failing(symbols):
    raise OSError("현재가 조회 실패")


@pytest.fixture
def clock(monkeypatch):
    """clock(text, tz=KST) — 지금 시각을 고정하고 캐시를 비운다. clock.client는 가짜 조회 클라이언트."""
    state = {}
    monkeypatch.setattr(timezone, "now", lambda: state["now"].astimezone(UTC))

    def set_now(text: str, tz=KST) -> datetime:
        state["now"] = datetime.fromisoformat(text).replace(tzinfo=tz)
        set_now.client.now = state["now"]
        cache.clear()
        return state["now"]

    set_now.client = LiveClient()
    set_now("2026-09-22T12:00:00")
    monkeypatch.setattr(engine, "broker_client", lambda: set_now.client)
    return set_now


def quote(api, symbol: str = "005930") -> dict:
    return api.get(f"/api/quotes?symbols={symbol}").json()["quotes"][0]


def test_live_quote_during_session(api, clock):
    q = quote(api)  # 22일(화) 12:00 장중. 오늘 진행 중인 봉의 종가는 69,300
    assert q["basis"] == "live" and q["price"] == 70000  # 현재가
    assert q["prevClose"] == pytest.approx(70000 * 0.98)  # 가격이 속한 거래일(22일)의 전 거래일(21일) 종가
    assert q["change"] == pytest.approx(70000 * 0.02) and q["changeRate"] == pytest.approx(1 / 0.98 - 1)
    assert q["asOf"] == "2026-09-22T12:00:00+09:00"  # 현재가를 받은 시각
    # 미국은 뉴욕 날짜로 본다: KST 22일 12:00 = 뉴욕 21일(월) 23:00 → 가격이 속한 거래일은 21일, 전 거래일은 18일(금)
    aapl = quote(api, "AAPL")
    assert aapl["basis"] == "live" and aapl["price"] == 200 and aapl["prevClose"] == pytest.approx(200 * 0.97)
    assert aapl["asOf"] == "2026-09-22T12:00:00+09:00"


def test_before_open_prev_close_is_yesterday(api, clock):
    clock("2026-09-22T08:00:00")  # 오늘(화)은 거래일이고 정규장 전, 오늘 봉은 아직 없다
    clock.client.today_candle = False
    clock.client.price["005930"] = 70000 * 0.985  # 장 시작 전 현재가
    q = quote(api)
    assert q["basis"] == "live" and q["prevClose"] == pytest.approx(70000 * 0.98)  # 어제(21일) 종가 대비
    assert q["changeRate"] == pytest.approx(0.985 / 0.98 - 1) and q["asOf"] == "2026-09-22T08:00:00+09:00"
    # 장마감 기준(closes)은 21일 종가와 18일 종가다 — 실시간은 오늘을 거래일로 본다
    assert market.closes(["005930"])["005930"]["prevClose"] == pytest.approx(70000 * 0.97)
    clock("2026-09-22T08:30:00")  # 장 시작 전에 증권사가 오늘 봉을 주더라도 같다
    clock.client.today_candle = True
    assert quote(api)["prevClose"] == pytest.approx(70000 * 0.98)


def test_weekend_and_holiday_show_last_trading_day_change(api, clock):
    clock("2026-09-19T12:00:00")  # 토요일: 가격이 속한 거래일 = 마지막 일봉 날짜(18일 금)
    clock.client.price["005930"] = 70000 * 0.97  # 현재가 = 금요일 종가
    q = quote(api)
    assert q["basis"] == "live" and q["prevClose"] == pytest.approx(70000 * 0.96)  # 17일(목) 종가
    assert q["changeRate"] == pytest.approx(0.97 / 0.96 - 1)  # 금요일의 등락
    clock("2026-10-09T12:00:00")  # 한글날(금) 휴장: 마지막 거래일 8일(목)의 등락
    clock.client.days = dict(OCTOBER)
    q = quote(api)
    assert q["prevClose"] == pytest.approx(70000 * 0.96) and q["changeRate"] == pytest.approx(0.97 / 0.96 - 1)


def test_without_calendar_weekdays_are_trading_days(api, clock):
    clock.client.calendar_fails = True
    clock.client.days = dict(OCTOBER)
    clock.client.price["005930"] = 70000 * 0.97
    clock("2026-10-09T12:00:00")  # 휴장일이지만 장 달력이 없으면 평일 = 거래일 → 전 거래일 종가 = 8일 종가
    q = quote(api)
    assert q["basis"] == "live" and q["prevClose"] == pytest.approx(70000 * 0.97)
    assert q["change"] == pytest.approx(0)
    clock("2026-10-10T12:00:00")  # 토요일 → 마지막 일봉(8일)의 등락
    assert quote(api)["prevClose"] == pytest.approx(70000 * 0.96)


def test_quote_falls_back_to_close_without_current_price(api, clock):
    real = clock.client.prices
    clock.client.prices = lambda symbols: [p for p in real(symbols) if p["symbol"] != "005935"]  # 이 종목만 현재가 없음
    quotes = {q["symbol"]: q for q in api.get("/api/quotes?symbols=005930,005935").json()["quotes"]}
    assert quotes["005930"]["basis"] == "live" and quotes["005930"]["price"] == 70000
    closed = quotes["005935"]  # 그 종목만 장마감 기준 (기준일 21일)
    assert closed["basis"] == "close" and closed["price"] == pytest.approx(60000 * 0.98)
    assert closed["prevClose"] == pytest.approx(60000 * 0.97) and closed["asOf"] == "2026-09-21T15:30:00+09:00"
    # 현재가 조회가 실패하면 모든 종목이 장마감 기준 (503이 아니다)
    cache.clear()
    clock.client.prices = failing
    quotes = api.get("/api/quotes?symbols=005930,005935").json()["quotes"]
    assert [q["basis"] for q in quotes] == ["close", "close"]
    assert quotes[0]["price"] == pytest.approx(70000 * 0.98) and quotes[0]["asOf"] == "2026-09-21T15:30:00+09:00"


def test_prev_close_is_cached_for_the_day_unless_broker_lags(api, clock, monkeypatch):
    spy = SpyCache(market.cache)
    monkeypatch.setattr(market, "cache", spy)
    key = "trading:prev:005930:2026-09-22:1"
    quote(api)
    assert spy.ttls[key] == market.DAY_TTL  # 전 거래일 봉(21일) = 장 달력의 직전 영업일
    clock.client.days.pop("2026-09-21")  # 증권사가 아직 21일 봉을 주지 않는다
    clock("2026-09-22T12:01:00")
    assert quote(api)["prevClose"] == pytest.approx(70000 * 0.97)  # 받은 봉 중 오늘 앞 마지막(18일)
    assert spy.ttls[key] == market.CLOSE_LAG_TTL  # 10분 뒤에 다시 본다


def test_stock_detail_candles_and_as_of(api, clock):
    body = api.get("/api/stocks/005930").json()  # 22일 12:00 장중
    assert [c["date"] for c in body["candles"]] == list(SEPTEMBER)  # 오늘 진행 중인 봉까지
    assert body["candles"][-1]["close"] == pytest.approx(70000 * 0.99)
    assert body["asOf"] == body["quote"]["asOf"] == "2026-09-22T12:00:00+09:00"  # 진행 중인 봉 → 받은 시각
    clock("2026-09-22T16:00:00")  # 정규장이 끝났다 → 오늘 봉은 완성 봉
    body = api.get("/api/stocks/005930").json()
    assert body["candles"][-1]["date"] == "2026-09-22" and body["quote"]["asOf"] == "2026-09-22T16:00:00+09:00"
    assert body["asOf"] == "2026-09-22T15:30:00+09:00"  # 그 봉 날짜의 정규장 종료 시각
    clock("2026-09-22T08:00:00")  # 정규장 전, 오늘 봉 없음 → 마지막 봉은 어제 완성 봉
    clock.client.today_candle = False
    body = api.get("/api/stocks/005930").json()
    assert body["candles"][-1]["date"] == "2026-09-21" and body["asOf"] == "2026-09-21T15:30:00+09:00"
    # 현재가를 받지 못하면 전체가 장마감 기준: 기준일(21일) 이하 완성 봉만
    clock("2026-09-22T12:00:00")
    clock.client.today_candle = True
    clock.client.prices = failing
    body = api.get("/api/stocks/005930").json()
    assert body["quote"]["basis"] == "close" and body["candles"][-1]["date"] == "2026-09-21"
    assert body["asOf"] == body["quote"]["asOf"] == "2026-09-21T15:30:00+09:00"
