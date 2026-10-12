"""python manage.py run_engine: 체결·청산 확인, 예약 실행, 일별 자산 기록, 분석 작업 호출."""
from datetime import UTC, date, datetime, timedelta
from io import StringIO
from zoneinfo import ZoneInfo

import pytest
from analysis import jobs
from django.core.cache import cache
from django.core.management import call_command
from django.utils import timezone
from paper_engine.data.calendar import MarketCalendar

from trading.models import EquityDaily, PaperOrder, Reservation
from trading.store import AccountStore, account_for

from .conftest import set_price, switch

pytestmark = pytest.mark.django_db
KST = ZoneInfo("Asia/Seoul")


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


def test_equity_recorded_once_after_kr_close_is_final(api, fake, user, monkeypatch):
    """run_engine이 일별 자산을 하루 한 번 남긴다: KR 기준일이 오늘이 되고 그날 종가가 굳은 뒤 (17:00 KST).
    시각을 2026-09-22(화)로 고정한다 — 자세한 규칙은 test_close_valuation."""
    state = {}
    calendars = MarketCalendar()
    monkeypatch.setattr(timezone, "now", lambda: state["now"].astimezone(UTC))

    def at(text: str) -> None:
        state["now"] = datetime.fromisoformat(text).replace(tzinfo=KST)
        cache.clear()

    def market_calendar(market_country):
        fake._hit("market_calendar")
        return calendars.calendar(market_country, state["now"])

    def daily_candles(symbol, count=200):  # 21일 봉과 22일 봉 (종가 = 지금 가격)
        fake._hit("daily_candles")
        price = fake.price[symbol]
        return [{"timestamp": f"{day}T00:00:00+09:00", "openPrice": f"{price:g}", "highPrice": f"{price:g}",
                 "lowPrice": f"{price:g}", "closePrice": f"{c:g}", "volume": "1000"}
                for day, c in (("2026-09-21", price * 0.99), ("2026-09-22", price))][-count:]
    fake.market_calendar, fake.daily_candles = market_calendar, daily_candles
    at("2026-09-22T10:00:00")
    api.force_login(user)  # 고정한 시각 기준으로 세션을 새로 만든다
    assert buy(api).status_code == 201
    for text in ("2026-09-22T15:35:00", "2026-09-22T16:30:00"):  # 기준일은 아직 어제, 그다음 오늘이지만 17:00 전
        at(text)
        run_once()
    assert not EquityDaily.objects.exists()
    at("2026-09-22T17:00:00")
    set_price(fake, "005930", 72000)
    run_once()
    run_once()
    row = EquityDaily.objects.get()
    account = account_for(user)
    assert row.account == account and row.day == date(2026, 9, 22)
    assert row.holdings_value_krw == pytest.approx(720_000)  # 그날 종가
    assert row.equity_krw == pytest.approx(account.cash_krw + 720_000)
    points = api.get("/api/account/equity?days=30").json()["points"]
    assert points == [{"day": "2026-09-22", "equityKrw": row.equity_krw}]


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


def test_loop_recovers_and_shuts_down_report_runner(monkeypatch):
    """상주 루프: 시작할 때 이전 실행의 리포트를 정리하고(runner.recover), 끝낼 때(Ctrl+C) 도는 리포트를 기다린다(runner.shutdown)."""
    from types import SimpleNamespace

    from reports.orchestration import runner

    from trading.management.commands import run_engine

    called = []

    def stop(seconds):
        raise KeyboardInterrupt

    monkeypatch.setattr(jobs, "recover", lambda: 0)
    monkeypatch.setattr(jobs, "shutdown", lambda: None)
    monkeypatch.setattr(runner, "recover", lambda: called.append("recover") or 2)
    monkeypatch.setattr(runner, "shutdown", lambda: called.append("shutdown"))
    monkeypatch.setattr(runner, "wait", lambda: called.append("wait"))
    monkeypatch.setattr(run_engine, "close_old_connections", lambda: None)
    monkeypatch.setattr(run_engine, "time", SimpleNamespace(sleep=stop))
    out, err = StringIO(), StringIO()
    call_command("run_engine", stdout=out, stderr=err)
    assert called == ["recover", "shutdown"]
    assert "AI 리포트 2개를 실패로 정리함" in out.getvalue() and err.getvalue() == ""


def test_once_waits_for_started_report(monkeypatch):
    """--once: 이번 바퀴에 시작한 리포트가 끝날 때까지 기다린다. recover·shutdown은 부르지 않는다."""
    from reports.orchestration import runner

    called = []
    monkeypatch.setattr(runner, "tick", lambda: called.append("tick") or 1)
    monkeypatch.setattr(runner, "wait", lambda: called.append("wait"))
    monkeypatch.setattr(runner, "recover", lambda: called.append("recover") or 0)
    monkeypatch.setattr(runner, "shutdown", lambda: called.append("shutdown"))
    _, err = run_once()
    assert called == ["tick", "wait"] and err == ""
