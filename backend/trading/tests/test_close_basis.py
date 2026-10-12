"""장마감 기준 공용 함수 (market.basis·closes·close_price·completed_candles — docs/API.md 공통 규칙 "장마감 기준").

지금 시각을 고정하고(django.utils.timezone.now), 장 달력은 엔진 MarketCalendar(공휴일 키 없음)로 그 시각 기준으로 만든다.
날짜는 공휴일이 없는 2026-09-18(금)·21(월)·22(화)를 쓴다.
"""
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest
from django.utils import timezone
from paper_engine.data import calendar as calendar_module
from paper_engine.data.calendar import MarketCalendar

from config import engine
from trading import market

from .conftest import FakeClient, csat_candles

KST = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")
DAYS = ("2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22")  # 마지막 22일 봉은 장중이면 미완성


class FixedClient(FakeClient):
    """지금 시각(now)을 기준으로 장 달력을 만들고, DAYS 날짜의 일봉을 준다 (종가 = 기준 가격 × 0.97·0.98·0.99·1.0)."""

    def __init__(self, now: datetime):
        super().__init__()
        self.now = now
        self.calendars = MarketCalendar()
        self.calendar_fails = False

    def market_calendar(self, market):
        self._hit("market_calendar")
        if self.calendar_fails:
            raise OSError("장 달력 조회 실패")
        return self.calendars.calendar(market, self.now)

    def daily_candles(self, symbol, count=200):
        self._hit("daily_candles")
        base = self.price[symbol]
        return [{"timestamp": f"{day}T00:00:00{'+09:00' if symbol != 'AAPL' else '-04:00'}",
                 "openPrice": f"{base:g}", "highPrice": f"{base:g}", "lowPrice": f"{base:g}",
                 "closePrice": f"{base * rate:g}", "volume": "1000"}
                for day, rate in zip(DAYS, (0.97, 0.98, 0.99, 1.0))][-count:]


class SpyCache:
    """market.cache를 감싸 set의 TTL을 기록한다."""

    def __init__(self, real):
        self.real, self.ttls = real, {}

    def __getattr__(self, name):  # get·delete·clear는 그대로
        return getattr(self.real, name)

    def set(self, key, value, timeout=None):
        self.ttls[key] = timeout
        self.real.set(key, value, timeout)


@pytest.fixture
def clock(monkeypatch):
    """clock(text) — 지금 시각을 KST(또는 tz)로 고정하고 장 달력·시세 캐시를 비운다."""
    state = {}
    monkeypatch.setattr(timezone, "now", lambda: state["now"])

    def set_now(text: str, tz=KST):
        state["now"] = datetime.fromisoformat(text).replace(tzinfo=tz)
        if "client" in state:
            state["client"].now = state["now"]
        market.cache.delete("trading:calendar:KR")
        market.cache.delete("trading:calendar:US")
        return state["now"]

    set_now("2026-09-22T12:00:00")
    client = FixedClient(state["now"])
    state["client"] = client
    monkeypatch.setattr(engine, "broker_client", lambda: client)
    set_now.client = client
    return set_now


def test_basis_switches_ten_minutes_after_close(clock):
    assert market.basis("KR") == {"date": "2026-09-21", "asOf": "2026-09-21T15:30:00+09:00"}
    clock("2026-09-22T15:39:59")
    assert market.basis("KR")["date"] == "2026-09-21"
    clock("2026-09-22T15:40:00")
    assert market.basis("KR") == {"date": "2026-09-22", "asOf": "2026-09-22T15:30:00+09:00"}
    clock("2026-09-22T16:05:00", NEW_YORK)  # 뉴욕 16:10 전
    assert market.basis("US") == {"date": "2026-09-21", "asOf": "2026-09-21T16:00:00-04:00"}
    clock("2026-09-22T16:10:00", NEW_YORK)
    assert market.basis("US")["date"] == "2026-09-22"


def test_traded_since_basis_from_open_until_basis_moves(clock):
    """기준일 뒤 정규장이 시작됐는지 (리포트 시세 — docs/API.md "리포트 시세"): 장 시작 전 False, 정규장 중·15:30~15:40 True, 15:40부터 False."""
    for at, expected in (("2026-09-22T08:59:59", False), ("2026-09-22T09:00:00", True), ("2026-09-22T12:00:00", True),
                         ("2026-09-22T15:35:00", True), ("2026-09-22T15:40:00", False), ("2026-09-19T11:00:00", False)):
        clock(at)
        assert market.traded_since_basis("KR") is expected, at
    clock("2026-09-22T10:00:00", NEW_YORK)  # 뉴욕 장중
    assert market.traded_since_basis("US") is True
    clock("2026-09-22T16:10:00", NEW_YORK)
    assert market.traded_since_basis("US") is False
    clock("2026-09-22T12:00:00")
    clock.client.calendar_fails = True  # 장 달력을 받지 못하면 장마감 기준 쪽
    assert market.traded_since_basis("KR") is False


def test_basis_is_none_without_calendar(clock):
    clock.client.calendar_fails = True
    assert market.basis("KR") is None


def test_closes_during_session_use_previous_close(clock):
    found = market.closes(["005930", "000660"])
    assert found["005930"] == {"price": 70000 * 0.99, "prevClose": 70000 * 0.98, "date": "2026-09-21",
                               "asOf": "2026-09-21T15:30:00+09:00"}
    assert found["000660"]["price"] == 200000 * 0.99
    assert market.close_price("005930") == 70000 * 0.99
    assert [c["timestamp"][:10] for c in market.completed_candles("005930")] == list(DAYS[:3])


def test_closes_after_settle_use_todays_close(clock):
    clock("2026-09-22T15:40:00")
    found = market.closes(["005930"])["005930"]
    assert (found["price"], found["prevClose"], found["date"]) == (70000.0, 70000 * 0.99, "2026-09-22")
    assert found["asOf"] == "2026-09-22T15:30:00+09:00"
    assert [c["timestamp"][:10] for c in market.completed_candles("005930")] == list(DAYS)


def test_closes_on_weekend_use_friday(clock):
    clock("2026-09-19T11:00:00")  # 토요일 → 금요일(18일) 종가
    found = market.closes(["005930"])["005930"]
    assert (found["date"], found["price"], found["prevClose"]) == ("2026-09-18", 70000 * 0.98, 70000 * 0.97)


def test_us_close_uses_new_york_date(clock):
    clock("2026-09-22T10:00:00", NEW_YORK)  # 뉴욕 장중
    found = market.closes(["AAPL"])["AAPL"]
    assert (found["date"], found["price"]) == ("2026-09-21", 200 * 0.99)
    assert found["asOf"] == "2026-09-21T16:00:00-04:00"


def test_close_is_cached_per_symbol_and_basis_day(clock, monkeypatch):
    spy = SpyCache(market.cache)
    monkeypatch.setattr(market, "cache", spy)
    market.closes(["005930"])
    assert spy.ttls["trading:close:005930:2026-09-21"] == market.DAY_TTL
    calls = clock.client.calls.count("daily_candles")
    market.closes(["005930"])
    market.close_price("005930")
    assert clock.client.calls.count("daily_candles") == calls  # 같은 기준일은 다시 받지 않는다
    clock("2026-09-22T15:40:00")
    spy.delete("trading:candles:005930")  # 일봉 60초 캐시가 지났다고 본다
    assert market.closes(["005930"])["005930"]["date"] == "2026-09-22"
    assert clock.client.calls.count("daily_candles") == calls + 1
    assert spy.ttls["trading:close:005930:2026-09-22"] == market.CLOSE_LAG_TTL  # 오늘 봉은 17:00 전 10분만
    clock("2026-09-22T17:00:00")
    spy.delete("trading:close:005930:2026-09-22")  # 10분이 지났다고 본다
    spy.delete("trading:candles:005930")
    assert market.closes(["005930"])["005930"]["price"] == 70000.0
    assert spy.ttls["trading:close:005930:2026-09-22"] == market.DAY_TTL


def test_close_older_than_basis_day_is_cached_briefly(clock, monkeypatch):
    """증권사가 아직 그날 봉을 주지 않으면(또는 장 달력이 모르는 휴장일) 하루가 아니라 10분만 둔다."""
    spy = SpyCache(market.cache)
    monkeypatch.setattr(market, "cache", spy)
    clock("2026-09-23T15:45:00")  # 기준일 23일, 봉은 22일까지
    found = market.closes(["005930"])["005930"]
    assert found["date"] == "2026-09-22" and found["asOf"] == "2026-09-22T15:30:00+09:00"
    assert spy.ttls["trading:close:005930:2026-09-23"] == market.CLOSE_LAG_TTL


def test_failure_is_cached_for_a_minute(clock, monkeypatch):
    spy = SpyCache(market.cache)
    monkeypatch.setattr(market, "cache", spy)
    market.closes(["005930"])  # 장 달력·종목 목록을 먼저 캐시
    market.cache.delete("trading:close:000660:2026-09-21")
    clock.client.fail = True
    assert market.closes(["000660"]) == {}
    assert spy.ttls["trading:close:000660:2026-09-21"] == market.SHORT_TTL
    clock.client.fail = False
    calls = clock.client.calls.count("daily_candles")
    assert market.closes(["000660"]) == {} and market.close_price("000660") is None
    assert clock.client.calls.count("daily_candles") == calls  # 60초 안에는 다시 부르지 않는다


def test_fresh_fetches_are_limited_per_call(clock, monkeypatch):
    monkeypatch.setattr(market, "CLOSE_BATCH", 2)
    symbols = ["005930", "005935", "000660", "AAPL"]
    assert list(market.closes(symbols)) == ["005930", "005935"]
    assert list(market.closes(symbols)) == symbols  # 다음 호출이 나머지를 채운다
    market.cache.clear()
    budget = [3]  # 여러 호출이 예산 하나를 나눠 쓴다
    assert len(market.closes(symbols[:2], budget)) == 2 and budget == [1]
    assert list(market.closes(symbols[2:], budget)) == ["000660"] and budget == [0]


def test_unknown_symbols_are_skipped(clock):
    assert market.closes(["NOPE", " 005930 "]).keys() == {"005930"}
    assert market.close_price("NOPE") is None


def test_without_calendar_uses_local_yesterday(clock):
    clock("2026-09-22T20:00:00")
    clock.client.calendar_fails = True
    found = market.closes(["005930"])["005930"]
    assert found["date"] == "2026-09-21" and found["asOf"] == "2026-09-21T15:30:00+09:00"  # 기본 종료 시각
    assert [c["timestamp"][:10] for c in market.completed_candles("005930")] == list(DAYS[:3])


# --- 장 마감이 늦은 날 (수능일·장 달력이 모르는 특별 운영) ---

def test_close_final_from_five_pm_local():
    kr = datetime(2026, 9, 22, 16, 59, 59, tzinfo=KST)
    assert not market.close_final("KR", "2026-09-22", kr)
    assert market.close_final("KR", "2026-09-22", kr.replace(hour=17, minute=0, second=0))
    assert market.close_final("KR", "2026-09-21", kr)  # 지난 날 봉
    us = datetime(2026, 9, 22, 16, 30, tzinfo=NEW_YORK)  # = 23일 05:30 KST
    assert not market.close_final("US", "2026-09-22", us)
    assert market.close_final("US", "2026-09-22", us.replace(hour=17, minute=0))


def test_csat_day_close_basis_follows_late_close(clock, monkeypatch):
    """수능일(2026-11-19, 정규장 10:00~16:30): 15:40에 장중 가격을 종가로 잡지 않고, 16:40에 16:30 종가로 바뀐다."""
    spy = SpyCache(market.cache)
    monkeypatch.setattr(market, "cache", spy)
    live = {"005930": 70500.0}
    clock.client.daily_candles = csat_candles(clock.client, live)
    clock("2026-11-19T15:45:00")
    assert market.basis("KR") == {"date": "2026-11-18", "asOf": "2026-11-18T15:30:00+09:00"}
    found = market.closes(["005930"])["005930"]
    assert (found["date"], found["price"]) == ("2026-11-18", 70000.0)
    assert spy.ttls["trading:close:005930:2026-11-18"] == market.DAY_TTL
    assert [c["timestamp"][:10] for c in market.completed_candles("005930")] == ["2026-11-17", "2026-11-18"]
    live["005930"] = 71000.0  # 16:30 장 마감 종가
    clock("2026-11-19T16:40:00")
    spy.delete("trading:candles:005930")
    assert market.basis("KR") == {"date": "2026-11-19", "asOf": "2026-11-19T16:30:00+09:00"}
    assert market.closes(["005930"])["005930"] == {"price": 71000.0, "prevClose": 70000.0, "date": "2026-11-19",
                                                   "asOf": "2026-11-19T16:30:00+09:00"}


def test_late_close_unknown_to_calendar_is_corrected_before_five_pm(clock, monkeypatch):
    """장 달력이 모르는 늦은 마감(표에 없는 수능일 등)이면 15:40에 오늘 봉이 장중 값이다 → 10분만 두고 고쳐 받는다."""
    monkeypatch.setattr(calendar_module, "KR_CSAT_DAYS", frozenset())
    spy = SpyCache(market.cache)
    monkeypatch.setattr(market, "cache", spy)
    live = {"005930": 70500.0}
    clock.client.daily_candles = csat_candles(clock.client, live)
    clock("2026-11-19T15:45:00")
    assert market.closes(["005930"])["005930"]["price"] == 70500.0  # 장중 값 (장 달력은 15:30 마감으로 안다)
    assert spy.ttls["trading:close:005930:2026-11-19"] == market.CLOSE_LAG_TTL
    live["005930"] = 71000.0
    clock("2026-11-19T16:41:00")
    spy.delete("trading:close:005930:2026-11-19")  # 10분이 지났다
    spy.delete("trading:candles:005930")
    assert market.closes(["005930"])["005930"]["price"] == 71000.0
    assert spy.ttls["trading:close:005930:2026-11-19"] == market.CLOSE_LAG_TTL


# --- 종목 목록에 없는 종목 (market.unlisted) ---

def test_unlisted_only_when_every_exchange_list_loaded(clock):
    assert market.unlisted(["005930", "NOPE", "AAPL"]) == {"NOPE"}
    assert market.unlisted([]) == set()
    market.cache.clear()
    real = clock.client.listed_stocks

    def listed_stocks(exchange):
        if exchange == "KOSDAQ":
            raise OSError("목록 조회 실패")
        return real(exchange)
    clock.client.listed_stocks = listed_stocks
    assert market.unlisted(["NOPE", "035720"]) == set()  # 빠진 것인지 알 수 없다
