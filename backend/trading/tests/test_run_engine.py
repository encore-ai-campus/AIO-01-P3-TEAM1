"""python manage.py run_engine: 체결·청산 확인, 예약 실행, 일별 자산 기록, 분석 작업 호출."""
from datetime import timedelta
from io import StringIO

import pytest
from analysis import jobs
from django.core.management import call_command
from django.utils import timezone

from trading.models import EquityDaily, PaperOrder, Reservation
from trading.store import AccountStore, account_for

from .conftest import set_price, switch

pytestmark = pytest.mark.django_db


def run_once() -> tuple[str, str]:
    out, err = StringIO(), StringIO()
    call_command("run_engine", "--once", stdout=out, stderr=err)
    return out.getvalue(), err.getvalue()


def buy(api, **body):
    return api.post("/api/orders", {"symbol": "005930", "quantity": 10, "orderType": "MARKET", **body}, format="json")


def test_limit_order_fills_when_price_drops(api, fake):
    order = buy(api, orderType="LIMIT", limitPrice=69000).json()["order"]
    run_once()
    assert PaperOrder.objects.get(pk=order["id"]).status == "ENTRY_PENDING"
    set_price(fake, "005930", 68500)
    run_once()
    filled = PaperOrder.objects.get(pk=order["id"])
    assert filled.status == "EXIT_WATCHING" and filled.fill_price == 68500


def test_target_exit_needs_two_confirmations(api, fake):
    order = buy(api, targetPrice=77000, stopPrice=66000, days=10).json()["order"]
    assert order["expireDate"] == f"{timezone.localdate() + timedelta(days=10)}"
    set_price(fake, "005930", 78000)
    run_once()
    row = PaperOrder.objects.get(pk=order["id"])
    assert row.status == "EXIT_WATCHING" and row.signal_count == 1
    out, _ = run_once()
    row = PaperOrder.objects.get(pk=order["id"])
    assert row.status == "CLOSED" and row.exit_reason == "TARGET" and row.exit_price == 78000
    assert "목표가 도달" in out


def test_reserved_buy_runs_when_market_opens(api, fake, user):
    switch(fake, KR=False)
    reservation = buy(api).json()["reservation"]
    run_once()  # 아직 장 밖
    assert Reservation.objects.filter(pk=reservation["id"]).exists()
    Reservation.objects.update(created_at=timezone.now() - timedelta(hours=2))
    switch(fake, KR=True)  # 예약 뒤에 시작한 정규장
    out, err = run_once()
    assert not Reservation.objects.exists(), err
    order = PaperOrder.objects.get(symbol="005930")
    assert order.status == "EXIT_WATCHING" and order.requested_by == "alice" and order.account.user == user
    assert f"[예약 #{reservation['id']}]" in out


def test_reserved_sell_runs_and_failed_reservation_is_dropped(api, fake):
    order = buy(api).json()["order"]
    switch(fake, KR=False)
    api.post(f"/api/orders/{order['id']}/sell")
    reserved_buy = buy(api, symbol="000660", quantity=1).json()["reservation"]
    Reservation.objects.update(created_at=timezone.now() - timedelta(hours=2))
    set_price(fake, "000660", 300000)  # 예약 때 가격에서 10% 넘게 올라 매수하지 않는다
    switch(fake, KR=True)
    out, _ = run_once()
    assert PaperOrder.objects.get(pk=order["id"]).exit_reason == "MANUAL"
    assert not Reservation.objects.exists()
    assert not PaperOrder.objects.filter(symbol="000660").exists()
    assert f"[예약 #{reserved_buy['id']}]" in out and "실행하지 않음" in out


def test_equity_recorded_once_after_close(api, fake, user):
    buy(api)
    run_once()
    assert not EquityDaily.objects.exists()  # 정규장 중
    fake.ended.add("KR")
    set_price(fake, "005930", 72000)
    run_once()
    run_once()
    row = EquityDaily.objects.get()
    account = account_for(user)
    assert row.account == account and row.day == timezone.localdate()
    assert row.holdings_value_krw == pytest.approx(720_000)
    assert row.equity_krw == pytest.approx(account.cash_krw + 720_000)
    points = api.get("/api/account/equity?days=30").json()["points"]
    assert points == [{"day": f"{timezone.localdate()}", "equityKrw": row.equity_krw}]


def test_without_broker_only_analysis_runs(monkeypatch, api):
    called = []
    monkeypatch.setattr(jobs, "tick", lambda: called.append(1))
    out, err = run_once()
    assert called == [1] and err == ""
    assert "분석 작업·추천 수집·알림 발송만" in out


def test_step_error_is_logged_and_loop_continues(monkeypatch, fake):
    def boom():
        raise RuntimeError("분석 오류")
    monkeypatch.setattr(jobs, "tick", boom)
    fake.fail = True
    _, err = run_once()
    assert "분석 작업 실패: RuntimeError: 분석 오류" in err


def test_store_is_scoped_to_one_account(api, fake, django_user_model):
    order = buy(api).json()["order"]
    bob = django_user_model.objects.create_user("bob", password="pw-bob-1234")
    store = AccountStore(account_for(bob))
    assert store.paper_order(order["id"]) is None and store.paper_orders() == []
    assert store.order_fills(order["id"]) == []
    mine = AccountStore(PaperOrder.objects.get(pk=order["id"]).account)
    row = mine.paper_order(order["id"])
    assert row["status"] == "EXIT_WATCHING" and row["created_at"].endswith("+09:00")
    assert mine.paper_today(f"{timezone.localdate()}") == (1, 0.0)
    assert mine.last_fx_rate("USD") is None
