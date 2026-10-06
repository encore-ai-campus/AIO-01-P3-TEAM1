"""입력 검증·CSRF·시세 호출 제한과, 한 시장·한 번의 조회 실패가 다른 체결·예약을 멈추지 않는지."""
from datetime import timedelta
from io import StringIO

import pytest
from django.core.cache import cache
from django.core.management import call_command
from django.utils import timezone
from rest_framework.test import APIClient

from trading import market, service
from trading.models import PaperOrder, Reservation

from .conftest import set_price, switch

pytestmark = pytest.mark.django_db
JSON = "application/json"


def run_once() -> tuple[str, str]:
    out, err = StringIO(), StringIO()
    call_command("run_engine", "--once", stdout=out, stderr=err)
    return out.getvalue(), err.getvalue()


def buy(api, **body):
    return api.post("/api/orders", {"symbol": "005930", "quantity": 10, "orderType": "MARKET", **body}, format="json")


# --- 입력 검증 ---

@pytest.mark.parametrize("body", [
    '{"symbol": "005930", "orderType": "MARKET", "quantity": 1e400}',
    '{"symbol": "005930", "orderType": "MARKET", "quantity": ' + "9" * 400 + "}",
    '{"symbol": "005930", "orderType": "MARKET", "quantity": 1, "days": 1e400}',
    '{"symbol": "005930", "orderType": "MARKET", "quantity": 1, "targetPrice": 1e400, "stopPrice": 1}',
    '{"symbol": "005930", "orderType": "LIMIT", "quantity": 1, "limitPrice": 1e400}',
])
def test_order_rejects_numbers_too_large(api, fake, body):
    """JSON의 1e400은 inf로 읽히고 400자리 정수는 float로 못 바꾼다. 500이 아니라 400 {"detail"}이어야 한다."""
    response = api.post("/api/orders", body, content_type=JSON)
    assert response.status_code == 400 and "너무 큽니다" in response.json()["detail"]
    assert not PaperOrder.objects.exists()


def test_modify_rejects_numbers_too_large(api, fake):
    order = buy(api).json()["order"]
    response = api.patch(f"/api/orders/{order['id']}", '{"days": 1e400}', content_type=JSON)
    assert response.status_code == 400 and "너무 큽니다" in response.json()["detail"]


# --- CSRF ---

def test_mutations_require_csrf(user, fake, api):
    order = buy(api).json()["order"]
    switch(fake, KR=False)
    reservation = api.post(f"/api/orders/{order['id']}/sell").json()["reservation"]
    browser = APIClient(enforce_csrf_checks=True)  # 실제 브라우저처럼 CSRF를 검사한다
    browser.force_login(user)
    for method, path in (("post", "/api/orders"), ("patch", f"/api/orders/{order['id']}"),
                         ("post", f"/api/orders/{order['id']}/sell"), ("post", f"/api/orders/{order['id']}/cancel"),
                         ("delete", f"/api/reservations/{reservation['id']}")):
        response = getattr(browser, method)(path, {}, format="json")
        assert response.status_code == 403 and "CSRF" in response.json()["detail"], path
    assert Reservation.objects.filter(pk=reservation["id"]).exists()


# --- 시세 호출 제한 ---

def test_failed_close_is_cached_so_polling_does_not_repeat_calls(api, fake):
    calls = []

    def broken(symbol, count=200):
        calls.append(symbol)
        raise OSError("일봉 조회 실패")
    fake.daily_candles = broken
    for _ in range(3):  # 화면이 되풀이해 보내는 폴링
        quotes = api.get("/api/quotes?symbols=005930,000660").json()["quotes"]
        # 현재가는 보이고 전 거래일 종가(등락)만 비어 있다
        assert [(q["price"], q["prevClose"], q["changeRate"], q["basis"]) for q in quotes] == [
            (70000, None, None, "live"), (200000, None, None, "live")]
    assert sorted(calls) == ["000660", "005930"]  # 종목마다 한 번만 (실패도 잠시 캐시한다)
    # 현재가도 받지 못하면 장마감 기준 — 그 일봉 실패도 잠시 캐시한다
    cache.clear()
    fake.prices = lambda symbols: (_ for _ in ()).throw(OSError("현재가 조회 실패"))
    for _ in range(3):
        quotes = api.get("/api/quotes?symbols=005930,000660").json()["quotes"]
        assert [(q["price"], q["prevClose"], q["asOf"], q["basis"]) for q in quotes] == [(None, None, None, "close")] * 2
    assert sorted(calls) == ["000660", "000660", "005930", "005930"]


def test_quotes_limits_new_close_lookups_per_request(api, fake, monkeypatch):
    monkeypatch.setattr(market, "CLOSE_BATCH", 1)
    path = "/api/quotes?symbols=005930,005935,000660"
    first = api.get(path).json()["quotes"]
    assert fake.calls.count("daily_candles") == 1
    assert all(q["price"] is not None for q in first)  # 현재가는 한 번에 묶어 받는다
    assert [q["prevClose"] is not None for q in first] == [True, False, False]  # 나머지는 다음 폴링에 채운다
    api.get(path)
    third = api.get(path).json()["quotes"]
    assert fake.calls.count("daily_candles") == 3 and all(q["prevClose"] is not None for q in third)
    # 현재가를 받지 못한 종목의 종가(장마감 기준)도 같은 예산을 쓴다
    cache.clear()
    fake.prices = lambda symbols: (_ for _ in ()).throw(OSError("현재가 조회 실패"))
    first = api.get(path).json()["quotes"]
    assert fake.calls.count("daily_candles") == 4
    assert [(q["basis"], q["price"] is not None) for q in first] == [("close", True), ("close", False), ("close", False)]


# --- 한 시장·한 번의 실패 ---

def test_sync_continues_when_another_market_calendar_fails(api, fake):
    """미국 장 달력 조회가 실패해도 국내 지정가 체결(과 목표·손절 청산)은 계속한다."""
    assert api.post("/api/orders", {"symbol": "AAPL", "quantity": 1, "orderType": "MARKET"},
                    format="json").status_code == 201
    order = buy(api, orderType="LIMIT", limitPrice=69000).json()["order"]
    calendar = fake.market_calendar

    def broken(market_country):
        if market_country == "US":
            raise OSError("미국 장 운영 정보 조회 실패")
        return calendar(market_country)
    fake.market_calendar = broken
    set_price(fake, "005930", 68500)
    out, err = run_once()
    assert PaperOrder.objects.get(pk=order["id"]).status == "EXIT_WATCHING", err
    assert "US 장 운영 정보를 받지 못해" in out


def reserved_buy(api, fake) -> dict:
    """장 밖에서 넣은 시장가 매수 예약. 그 뒤 정규장이 열린 상태로 만든다."""
    switch(fake, KR=False)
    reservation = buy(api).json()["reservation"]
    Reservation.objects.update(created_at=timezone.now() - timedelta(hours=2))
    switch(fake, KR=True)
    return reservation


def fail_confirmed_prices(symbols):
    raise OSError("일시 장애")


def test_reservation_is_retried_after_transient_failure(api, fake, monkeypatch):
    monkeypatch.setattr(service, "RESERVATION_RETRY", timedelta(hours=3))
    reservation = reserved_buy(api, fake)
    fake.confirmed_prices = fail_confirmed_prices
    out, _ = run_once()
    assert Reservation.objects.filter(pk=reservation["id"]).exists() and "다시 시도 예정" in out
    assert not PaperOrder.objects.exists()
    del fake.confirmed_prices  # 증권사가 돌아왔다
    out, err = run_once()
    assert not Reservation.objects.exists(), err
    assert PaperOrder.objects.get(symbol="005930").status == "EXIT_WATCHING"


def test_reservation_is_dropped_when_failure_outlasts_retry_window(api, fake):
    reserved_buy(api, fake)  # 가짜 정규장은 1시간 전에 시작했다 (다시 시도하는 10분을 넘김)
    fake.confirmed_prices = fail_confirmed_prices
    out, _ = run_once()
    assert not Reservation.objects.exists() and "예약을 지움" in out
    assert not PaperOrder.objects.exists()


def test_reservations_continue_when_another_market_calendar_fails(api, fake):
    reserved_buy(api, fake)
    Reservation.objects.create(account=Reservation.objects.get().account, kind="BUY", symbol="AAPL", name="Apple",
                               market="US", currency="USD", quantity=1, reference_price=200.0,
                               created_at=timezone.now() - timedelta(hours=2))
    calendar = fake.market_calendar

    def broken(market_country):
        if market_country == "US":
            raise OSError("미국 장 운영 정보 조회 실패")
        return calendar(market_country)
    fake.market_calendar = broken
    cache.clear()
    out, err = run_once()
    assert PaperOrder.objects.get(symbol="005930").status == "EXIT_WATCHING", err
    assert list(Reservation.objects.values_list("symbol", flat=True)) == ["AAPL"]  # 미국 예약은 남아 다음에 다시 본다
