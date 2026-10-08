"""장마감 기준 평가(계좌·랭킹·일별 자산)와 보유 방식(style)·KST 날짜 (docs/API.md "장마감 기준"·"보유 방식").

지금 시각을 고정하고(django.utils.timezone.now), 장 달력은 엔진 MarketCalendar(공휴일 키 없음)로 그 시각 기준으로 만든다.
날짜는 공휴일이 없는 2026-09-18(금)·21(월)·22(화)를 쓴다. 일봉 종가 = 현재가 × 0.97(17일)·0.98(18일)·0.99(21일)·1.0(22일).
"""
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from accounts.models import profile_of
from django.utils import timezone
from paper_engine.data.calendar import MarketCalendar

from config import engine
from trading import market, service
from trading.models import EquityDaily, PaperOrder, Reservation
from trading.store import AccountStore, account_for

from .conftest import CFG, LISTED, FakeClient, csat_candles, login

pytestmark = pytest.mark.django_db
KST = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")
DAYS = ("2026-09-17", "2026-09-18", "2026-09-21", "2026-09-22")
RATES = (0.97, 0.98, 0.99, 1.0)


class FixedClient(FakeClient):
    """고정 시각(now)의 장 달력과 DAYS 날짜의 일봉을 주는 가짜 조회 클라이언트."""

    def __init__(self, now: datetime):
        super().__init__()
        self.now = now
        self.calendars = MarketCalendar()

    def market_calendar(self, market_country):
        self._hit("market_calendar")
        return self.calendars.calendar(market_country, self.now)

    def daily_candles(self, symbol, count=200):
        self._hit("daily_candles")
        base = self.price[symbol]
        offset = "-04:00" if symbol == "AAPL" else "+09:00"
        return [{"timestamp": f"{day}T00:00:00{offset}", "openPrice": f"{base:g}", "highPrice": f"{base:g}",
                 "lowPrice": f"{base:g}", "closePrice": f"{base * rate:g}", "volume": "1000"}
                for day, rate in zip(DAYS, RATES)][-count:]


@pytest.fixture
def clock(monkeypatch):
    """clock(text, tz=KST) — 지금 시각을 고정하고 캐시를 비운다. clock.client는 가짜 조회 클라이언트."""
    state = {}
    monkeypatch.setattr(timezone, "now", lambda: state["now"].astimezone(UTC))

    def set_now(text: str, tz=KST) -> datetime:
        state["now"] = datetime.fromisoformat(text).replace(tzinfo=tz)
        state["client"].now = state["now"]
        market.cache.clear()
        return state["now"]

    state["client"] = FixedClient(datetime(2026, 9, 22, 12, tzinfo=KST))
    monkeypatch.setattr(engine, "broker_client", lambda: state["client"])
    set_now.client = state["client"]
    set_now("2026-09-22T12:00:00")
    return set_now


def order(api, **body):
    return api.post("/api/orders", {"symbol": "005930", "quantity": 10, "orderType": "MARKET", **body}, format="json")


def lines():
    out = []
    return out, out.append


# --- 계좌·랭킹 평가 (장마감 기준) ---

def buy_us(api, clock, **body):
    """뉴욕 21일 장중(10:00)에 AAPL을 사 둔다 (국내 정규장과 시간이 겹치지 않는다)."""
    clock("2026-09-21T10:00:00", NEW_YORK)
    result = order(api, symbol="AAPL", quantity=1, **body).json()
    assert result["order"]["status"] == "EXIT_WATCHING", result
    return result["order"]


def test_summary_prices_as_of_per_market(api, clock):
    """국내 장중(12:00 KST)에는 국내 어제(21일) 종가, 미국은 뉴욕 21일 종가로 평가한다. pricesAsOf는 시장별."""
    buy_us(api, clock)
    clock("2026-09-22T12:00:00")
    assert order(api).status_code == 201
    body = api.get("/api/account").json()
    positions = {p["symbol"]: p for p in body["positions"]}
    assert positions["005930"]["lastPrice"] == pytest.approx(70000 * 0.99)
    assert positions["AAPL"]["lastPrice"] == pytest.approx(200 * 0.99)
    assert body["pricesAsOf"] == {"KR": "2026-09-21T15:30:00+09:00", "US": "2026-09-21T16:00:00-04:00"}
    assert body["asOf"] == "2026-09-22T12:00:00+09:00"  # 계산 시각


def test_summary_after_kr_settle_uses_todays_close(api, clock):
    clock("2026-09-22T10:00:00")
    order(api)
    clock("2026-09-22T15:39:00")
    assert api.get("/api/account").json()["pricesAsOf"]["KR"] == "2026-09-21T15:30:00+09:00"
    clock("2026-09-22T15:40:00")
    body = api.get("/api/account").json()
    assert body["pricesAsOf"]["KR"] == "2026-09-22T15:30:00+09:00"
    assert body["positions"][0]["lastPrice"] == pytest.approx(70000)


def test_ranking_prices_as_of_and_close_valuation(clock, django_user_model):
    from rest_framework.test import APIClient
    clients = {}
    for name in ("alice", "bob"):
        u = django_user_model.objects.create_user(name, password=f"pw-{name}-1234")
        profile = profile_of(u)
        profile.is_public = True
        profile.save()
        clients[name] = APIClient()
        clients[name].force_login(u)
    clock("2026-09-21T10:00:00")
    order(clients["alice"])                        # 21일 70,000에 체결, 22일 장중 평가는 21일 종가 69,300
    buy_us(clients["bob"], clock)
    clock("2026-09-22T12:00:00")
    body = clients["alice"].get("/api/ranking").json()
    assert body["pricesAsOf"] == {"KR": "2026-09-21T15:30:00+09:00", "US": "2026-09-21T16:00:00-04:00"}
    alice = next(e for e in body["results"] if e["nickname"] == "alice")
    assert alice["profitRate"] == pytest.approx((10 * 69300 - 700_000 * 1.001) / 10_000_000)
    assert body["asOf"] == "2026-09-22T12:00:00+09:00"


def test_ranking_without_holdings_has_empty_prices_as_of(api, clock):
    assert api.get("/api/ranking").json()["pricesAsOf"] == {}


# --- 일별 자산 (KR 기준일이 오늘이 되고 그날 종가가 굳은 뒤 — 현지 17:00) ---

def test_equity_waits_until_todays_close_is_final(api, user, clock):
    buy_us(api, clock)
    clock("2026-09-22T12:00:00")
    order(api)
    out, log = lines()
    for text in ("2026-09-22T15:30:00", "2026-09-22T15:39:59",   # 정규장 종료 뒤지만 10분 전 (기준일은 어제)
                 "2026-09-22T15:40:00", "2026-09-22T16:59:59"):  # 기준일은 오늘이지만 종가가 굳기 전 (17:00)
        assert service.record_equity(clock(text), log) == 0, text
    assert not EquityDaily.objects.exists()
    at = clock("2026-09-22T17:00:00")
    assert service.record_equity(at, log) == 1
    row = EquityDaily.objects.get()
    account = account_for(user)
    # 국내는 그날(22일) 종가, 미국은 그때의 최신 미국 종가 (뉴욕 21일 — 17:00 KST는 뉴욕 22일 04:00)
    value = 10 * 70000 + 1 * 200 * 0.99 * 1400
    assert row.day.isoformat() == "2026-09-22" and row.holdings_value_krw == pytest.approx(value)
    assert row.equity_krw == pytest.approx(account.cash_krw + value)
    assert row.recorded_at == at
    assert service.record_equity(clock("2026-09-22T18:00:00"), log) == 0  # 하루 한 번
    assert out == ["[자산 기록] 2026-09-22: 계좌 1개"]
    assert api.get("/api/account/equity").json()["points"] == [{"day": "2026-09-22", "equityKrw": row.equity_krw}]


def test_equity_not_recorded_on_weekend_or_before_settle_after_midnight(api, clock):
    order(api)
    out, log = lines()
    assert service.record_equity(clock("2026-09-23T00:30:00"), log) == 0  # 기준일 22일 ≠ 오늘 23일
    assert service.record_equity(clock("2026-09-19T17:30:00"), log) == 0  # 토요일
    assert not EquityDaily.objects.exists()


def test_equity_on_csat_day_uses_late_close(api, user, clock):
    """수능일(2026-11-19, 정규장 10:00~16:30)에는 16:30 종가로 기록한다 (15:40의 장중 값이 아니라)."""
    live = {"005930": 70500.0}
    clock.client.daily_candles = csat_candles(clock.client, live)
    clock("2026-11-19T11:00:00")
    api.force_login(user)  # 고정한 시각 기준으로 세션을 새로 만든다 (로그인 세션 만료)
    assert order(api).status_code == 201
    out, log = lines()
    for text in ("2026-11-19T15:40:00", "2026-11-19T16:39:59", "2026-11-19T16:45:00"):
        assert service.record_equity(clock(text), log) == 0, text
    live["005930"] = 71000.0  # 16:30 장 마감 종가
    assert service.record_equity(clock("2026-11-19T17:00:00"), log) == 1
    assert EquityDaily.objects.get().holdings_value_krw == pytest.approx(10 * 71000)


def test_equity_deferred_when_a_close_is_missing(api, clock, django_user_model):
    """종가를 잠깐 받지 못한 종목(일시 오류)은 그 종목을 가진 계좌만 미루고, 다음 루프에서 그 계좌만 다시 한다."""
    order(api)
    bob = login(django_user_model, "bob")[1]
    assert order(bob, symbol="000660", quantity=1).status_code == 201
    real = clock.client.daily_candles

    def daily_candles(symbol, count=200):
        if symbol == "005930":
            raise OSError("일봉 조회 실패")
        return real(symbol, count)
    clock.client.daily_candles = daily_candles
    out, log = lines()
    with pytest.raises(RuntimeError, match="계좌 1개.*005930"):
        service.record_equity(clock("2026-09-22T17:00:00"), log)
    assert [r.account.user.username for r in EquityDaily.objects.all()] == ["bob"]
    assert out == ["[자산 기록] 2026-09-22: 계좌 1개"]
    clock.client.daily_candles = real
    assert service.record_equity(clock("2026-09-22T17:05:00"), log) == 1  # 미룬 계좌(alice)만
    assert EquityDaily.objects.count() == 2


def test_equity_values_unlisted_symbol_at_fill_price(api, clock, django_user_model, monkeypatch):
    """종목 목록에서 빠진 보유 종목(상장 폐지 등)은 다시 해도 종가가 오지 않는다 → 화면처럼 체결가로 평가하고 모든 계좌를 기록한다."""
    order(api)                                       # alice: 005930 10주 (체결가 70,000)
    login(django_user_model, "bob")[1].get("/api/account")  # bob: 보유 없음
    monkeypatch.setitem(LISTED, "KOSPI", [s for s in LISTED["KOSPI"] if s["symbol"] != "005930"])
    out, log = lines()
    assert service.record_equity(clock("2026-09-22T17:00:00"), log) == 2
    alice = EquityDaily.objects.get(account__user__username="alice")
    assert alice.holdings_value_krw == pytest.approx(10 * 70000)
    assert out == ["[자산 기록] 2026-09-22: 계좌 2개 (종목 목록에 없어 체결가로 평가: 005930)"]


def test_equity_deferred_when_an_exchange_list_is_missing(api, clock, monkeypatch):
    """거래소 목록을 받지 못해 종목이 빠진 것은 일시 오류다 → 체결가로 기록하지 않고 미룬다."""
    clock.client.price["035720"] = 30000.0
    assert order(api, symbol="035720", quantity=1).status_code == 201  # KOSDAQ
    real = clock.client.listed_stocks

    def listed_stocks(exchange):
        if exchange == "KOSDAQ":
            raise OSError("목록 조회 실패")
        return real(exchange)
    clock.client.listed_stocks = listed_stocks
    with pytest.raises(RuntimeError, match="035720"):
        service.record_equity(clock("2026-09-22T17:00:00"), lambda text: None)
    assert not EquityDaily.objects.exists()


# --- 보유 방식 (style) ---

def test_style_is_inferred_and_validated(api, clock):
    assert order(api, style="short").status_code == 400
    assert order(api, style=1).status_code == 400
    response = order(api, style="swing")
    assert response.status_code == 400 and "목표가와 손절가" in response.json()["detail"]
    response = order(api, style="swing", targetPrice=77000)
    assert response.status_code == 400 and "reasonCodes" not in response.json()
    assert order(api, days=5).status_code == 400  # style 없이 기한만 → 스윙인데 목표·손절이 없다
    for extra in ({"targetPrice": 77000, "stopPrice": 66000}, {"days": 5}):
        response = order(api, style="long", **extra)
        assert response.status_code == 400 and "장기 보유" in response.json()["detail"]
    assert not PaperOrder.objects.exists()
    swing = order(api, style="swing", targetPrice=77000, stopPrice=66000).json()["order"]
    assert swing["style"] == "swing" and swing["expireDate"] is None  # 기한은 선택
    long_ = order(api, symbol="000660", quantity=1, style="long").json()["order"]
    assert long_["style"] == "long" and long_["targetPrice"] is None and long_["expireDate"] is None
    assert PaperOrder.objects.get(pk=long_["id"]).style == "long"


def test_long_buy_blocked_by_total_limit(api, clock, monkeypatch):
    import dataclasses
    monkeypatch.setattr(engine, "engine_config", lambda: dataclasses.replace(CFG, max_total_invest_krw=1_000_000))
    response = order(api, quantity=20)  # 직전 종가 69,300 × 20주 ≈ 139만원 > 총 금액 한도 100만원
    assert response.status_code == 400
    assert response.json()["reasonCodes"] == ["total_limit"] and "총 금액 한도" in response.json()["detail"]
    assert not PaperOrder.objects.exists()
    # 지정가 주문은 지정가로 점검한다
    assert order(api, quantity=20, orderType="LIMIT", limitPrice=40000).status_code == 201


def test_long_market_buy_outside_session_reserves_with_style(api, clock):
    clock("2026-09-22T08:00:00")  # 정규장 전
    reservation = order(api).json()["reservation"]
    assert reservation["style"] == "long" and Reservation.objects.get().style == "long"
    swing = order(api, symbol="000660", quantity=1, targetPrice=230000, stopPrice=180000, days=3).json()["reservation"]
    assert swing["style"] == "swing"
    response = order(api, symbol="005935", quantity=1000)  # 장기 보유 점검은 예약을 받을 때 한다
    assert response.status_code == 400 and "cash_short" in response.json()["reasonCodes"]
    # 정규장이 열리면 저장한 style로 실행한다 (기한은 실행한 날부터)
    at = clock("2026-09-22T09:00:30")
    out, log = lines()
    assert service.run_reservations(at, log) == 2, out
    long_, swing_ = PaperOrder.objects.order_by("id")
    assert (long_.symbol, long_.style, long_.expire_date) == ("005930", "long", None)
    assert (swing_.symbol, swing_.style, swing_.expire_date.isoformat()) == ("000660", "swing", "2026-09-25")


def test_patch_rules_for_long_orders(api, clock):
    long_ = order(api, orderType="LIMIT", limitPrice=60000).json()["order"]
    for body in ({"targetPrice": 80000}, {"stopPrice": 50000}, {"days": 3}):
        response = api.patch(f"/api/orders/{long_['id']}", body, format="json")
        assert response.status_code == 400 and "장기 보유" in response.json()["detail"]
    row = PaperOrder.objects.get(pk=long_["id"])
    assert (row.target_price, row.stop_price, row.expire_date) == (None, None, None)


def test_buy_without_style_keeps_positional_signature(user, clock):
    """autotrade가 부르는 모양 (위치 인자, style 없음, 목표·손절·기한 있음) → swing."""
    result = service.buy(account_for(user), "plan:1", "005930", 1, service.LIMIT, 69000, 72000, 67000, 5,
                         clock("2026-09-22T10:00:00"))
    assert result["order"]["style"] == "swing" and result["order"]["expireDate"] == "2026-09-27"


# --- KST 날짜 (UTC 시각을 받아도 한국 날짜로) ---

def test_expire_uses_kst_date_between_midnight_and_nine(user, clock):
    """00:00~09:00 KST에는 UTC 날짜가 하루 앞이다. 기한은 한국 날짜 + days여야 한다."""
    at = datetime(2026, 9, 21, 16, 30, tzinfo=UTC)  # = 2026-09-22 01:30 KST
    clock("2026-09-22T01:30:00")
    assert service._expire(14, at) == "2026-10-06"
    result = service.buy(account_for(user), "plan:1", "005930", 1, service.LIMIT, 69000, 72000, 67000, 14, at)
    assert result["order"]["expireDate"] == "2026-10-06"


def test_reserved_buy_expiry_uses_kst_date(user, clock):
    account = account_for(user)
    r = Reservation.objects.create(account=account, kind="BUY", symbol="005930", name="삼성전자", market="KR",
                                   currency="KRW", quantity=1, target_price=77000, stop_price=66000, days=10,
                                   reference_price=70000, created_at=datetime(2026, 9, 21, 20, tzinfo=KST),
                                   style="swing")
    at = datetime(2026, 9, 21, 23, 30, tzinfo=UTC)  # = 2026-09-22 08:30 KST (UTC 날짜는 21일)
    clock("2026-09-22T08:30:00")
    service.execute_reservation(r, at, service.Notes())
    row = AccountStore(account).paper_orders()[0]
    assert row["expire_date"] == "2026-10-02" and row["style"] == "swing"


def test_modify_days_uses_kst_date(api, clock):
    clock("2026-09-22T10:00:00")
    created = order(api, orderType="LIMIT", limitPrice=69000, targetPrice=75000, stopPrice=65000).json()["order"]
    clock("2026-09-22T02:00:00")  # UTC로는 21일 17:00
    response = api.patch(f"/api/orders/{created['id']}", {"days": 5}, format="json")
    assert response.status_code == 200 and response.json()["expireDate"] == "2026-09-27"


def test_utc_and_kst_now_give_same_basis(clock):
    """timezone.now()는 UTC로 돌려준다 (Django 기본). 기준일은 시장 현지 날짜로 정한다."""
    clock("2026-09-22T00:30:00")  # UTC 21일 15:30
    assert market.basis_day("KR") == "2026-09-21"
    assert timezone.now().tzinfo == UTC and timezone.localtime().date().isoformat() == "2026-09-22"
    assert (timezone.now() + timedelta(hours=9)).date().isoformat() == "2026-09-22"


# --- 응답 형식 ---

def test_payloads_carry_style_and_exit_reason(api, user, clock):
    """청산 사유와 보유 방식이 주문·체결 응답에 그대로 나온다."""
    created = service.buy(account_for(user), "plan:7", "005930", 2, service.LIMIT, 70000, 72000, 67000, None,
                          clock("2026-09-22T10:00:00"), style="swing")["order"]
    assert created["status"] == "EXIT_WATCHING" and created["style"] == "swing"  # 장중 지정가 70,000 ≥ 확인 가격 → 체결
    store = AccountStore(account_for(user))
    row = store.paper_order(created["id"])
    at = "2026-09-22T14:00:05+09:00"
    store.add_fill(created["id"], "SELL", 72000, 2, 144, 288, 1.0, 144_000 - 432, "TARGET", at,
                   {"status": "CLOSED", "exit_price": 72000, "exit_reason": "TARGET", "closed_at": at,
                    "pnl_krw": 3500.0})
    assert row["style"] == "swing"
    orders = api.get("/api/orders?status=all").json()["results"]
    assert (orders[0]["style"], orders[0]["exitReason"], orders[0]["expireDate"]) == ("swing", "TARGET", None)
    fills = api.get("/api/fills").json()["results"]
    assert fills[0]["reason"] == "TARGET" and fills[1]["reason"] == "ENTRY"
