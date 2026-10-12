"""기반 단계(2026-10-04) 확인: 보유 방식 style 열·마이그레이션, 저장소의 style별 하루 셈, run_engine의 새 단계.

새 단계 함수(reports.output.alerts.sweep_finished, longterm.jobs.tick)는 가짜로 바꿔 부른 순서만 본다.
"""
from datetime import datetime
from io import StringIO
from zoneinfo import ZoneInfo

import pytest
from analysis import jobs
from autotrade.recommend import auto, sources
from autotrade.plans import executor
from django.core.management import call_command
from django.db import connection
from django.db.migrations.executor import MigrationExecutor
from longterm import jobs as longterm_jobs
from notifications import dispatch
from reports.output import alerts

from trading import service
from trading.models import PaperOrder, Reservation
from trading.store import AccountStore, account_for

KST = ZoneInfo("Asia/Seoul")
ALL = ["체결 확인", "예약 실행", "일별 자산 기록", "분석 작업", "추천 수집", "리포트 알림", "자동 추천", "자동매매", "장기투자",
       "알림 발송"]
WITHOUT_BROKER = ["분석 작업", "추천 수집", "리포트 알림", "알림 발송"]


@pytest.fixture
def steps(monkeypatch):
    called: list[str] = []

    def fake(label):
        def run(*args, **kwargs):
            called.append(label)
        return run

    for target, name, label in ((service, "sync_accounts", "체결 확인"), (service, "run_reservations", "예약 실행"),
                                (service, "record_equity", "일별 자산 기록"), (jobs, "tick", "분석 작업"),
                                (sources, "collect", "추천 수집"), (alerts, "sweep_finished", "리포트 알림"),
                                (auto, "tick", "자동 추천"), (executor, "tick", "자동매매"),
                                (longterm_jobs, "tick", "장기투자"), (dispatch, "tick", "알림 발송")):
        monkeypatch.setattr(target, name, fake(label))
    return called


def run_once() -> tuple[str, str]:
    out, err = StringIO(), StringIO()
    call_command("run_engine", "--once", stdout=out, stderr=err)
    return out.getvalue(), err.getvalue()


@pytest.mark.django_db
def test_run_engine_runs_report_alerts_and_longterm_in_order(steps, fake):
    _, err = run_once()
    assert steps == ALL and err == ""


@pytest.mark.django_db
def test_without_broker_report_alerts_run_but_longterm_skips(steps):
    out, err = run_once()
    assert steps == WITHOUT_BROKER and err == ""
    assert "장기투자" in out.splitlines()[0]  # 건너뛰는 단계 안내


@pytest.mark.django_db
def test_new_step_stubs_run_quietly(fake):
    """가짜 없이: 기반 단계의 빈 껍데기(리포트 알림·장기투자)가 오류 없이 지나간다 (LONGTERM_JOBS는 루트 conftest가 off로)."""
    _, err = run_once()
    assert err == ""


def kst(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=KST)


def order(account, created_at, style="swing", **fields):
    base = dict(requested_by="alice", symbol="005930", name="삼성전자", market="KR", currency="KRW",
                order_type="LIMIT", limit_price=70000, quantity=1, entry_price=70000, status="CANCELED",
                created_at=kst(created_at), style=style)
    return PaperOrder.objects.create(account=account, **(base | fields))


@pytest.mark.django_db
def test_order_style_defaults_and_paper_today_filters_by_style(user):
    account = account_for(user)
    store = AccountStore(account)
    oid = store.add_paper_order(requested_by="alice", trade_id=None, symbol="005930", name="삼성전자", market="KR",
                                currency="KRW", order_type="LIMIT", limit_price=70000.0, quantity=1,
                                entry_price=70000.0, target_price=77000.0, stop_price=66000.0, expire_date=None,
                                status="CANCELED", created_at="2026-09-29T09:10:00+09:00")
    assert store.paper_order(oid)["style"] == "swing"  # 엔진이 style을 주지 않으면 swing
    order(account, "2026-09-29T09:20:00", "swing", status="CLOSED", closed_at=kst("2026-09-29T14:00:00"), pnl_krw=-700)
    order(account, "2026-09-29T09:30:00", "swing")
    order(account, "2026-09-29T09:40:00", "long", status="CLOSED", closed_at=kst("2026-09-29T10:00:00"),
          pnl_krw=-300)
    order(account, "2026-09-28T23:59:00", "swing")  # 전날 (KST)
    assert store.paper_today("2026-09-29") == (4, 1000.0)
    assert store.paper_today("2026-09-29", style="swing") == (3, 700.0)
    assert store.paper_today("2026-09-29", style="long") == (1, 300.0)
    assert store.paper_today("2026-09-28", style="swing") == (1, 0.0)


@pytest.mark.django_db(transaction=True)
def test_style_migration_fills_existing_orders_and_reservations():
    """trading 0002: 목표·손절·기한이 모두 없는 기존 주문·BUY 예약은 long, 나머지는 swing, SELL 예약은 null."""
    migrator = MigrationExecutor(connection)
    before, after = [("trading", "0001_initial")], [("trading", "0002_order_style")]
    migrator.migrate(before)
    old = migrator.loader.project_state(before).apps
    user = old.get_model("auth", "User").objects.create(username="old-alice")
    account = old.get_model("trading", "PaperAccount").objects.create(
        user=user, name="old-alice", initial_capital_krw=1e7, cash_krw=1e7)
    Order, Res = old.get_model("trading", "PaperOrder"), old.get_model("trading", "Reservation")
    base = dict(account=account, requested_by="old-alice", name="삼성전자", market="KR", currency="KRW",
                order_type="MARKET", quantity=1, entry_price=70000, status="EXIT_WATCHING", created_at=kst("2026-09-01T10:00:00"))
    ids = [Order.objects.create(symbol=s, **base, **f).pk for s, f in (
        ("A1", dict(target_price=77000, stop_price=66000, expire_date=None)),
        ("A2", dict()),                                   # 목표·손절·기한 모두 없음 → long
        ("A3", dict(expire_date=datetime(2026, 10, 1).date())),  # 기한만 → swing (기존 주문 예외)
        ("A4", dict(target_price=77000)))]                # 목표만 → swing
    res_base = dict(account=account, symbol="005930", name="삼성전자", market="KR", currency="KRW", quantity=1)
    res = [Res.objects.create(kind="BUY", **res_base).pk,
           Res.objects.create(kind="BUY", target_price=77000, stop_price=66000, days=10, **res_base).pk,
           Res.objects.create(kind="SELL", **res_base).pk]
    try:
        migrator = MigrationExecutor(connection)
        migrator.migrate(after)
        new = migrator.loader.project_state(after).apps
        styles = dict(new.get_model("trading", "PaperOrder").objects.values_list("pk", "style"))
        assert [styles[i] for i in ids] == ["swing", "long", "swing", "swing"]
        reservations = dict(new.get_model("trading", "Reservation").objects.values_list("pk", "style"))
        assert [reservations[i] for i in res] == ["long", "swing", None]
    finally:
        migrator = MigrationExecutor(connection)
        migrator.migrate(migrator.loader.graph.leaf_nodes())
    assert PaperOrder._meta.get_field("style").default == "swing" and Reservation._meta.get_field("style").null


@pytest.mark.django_db(transaction=True)
def test_day_style_migration_cancels_pending_and_turns_rest_into_swing():
    """trading 0003 (단타 기능 삭제): style day 체결 대기는 취소(closed_at·note), 단타 주문은 모두 swing. 다른 주문은 그대로."""
    migrator = MigrationExecutor(connection)
    before, after = [("trading", "0002_order_style")], [("trading", "0003_remove_day_style")]
    migrator.migrate(before)
    old = migrator.loader.project_state(before).apps
    user = old.get_model("auth", "User").objects.create(username="old-alice")
    account = old.get_model("trading", "PaperAccount").objects.create(
        user=user, name="old-alice", initial_capital_krw=1e7, cash_krw=1e7)
    Order = old.get_model("trading", "PaperOrder")
    base = dict(account=account, requested_by="plan:1", name="삼성전자", market="KR", currency="KRW",
                order_type="LIMIT", limit_price=70000, quantity=1, entry_price=70000, target_price=72000,
                stop_price=67000, created_at=kst("2026-10-05T10:00:00"))
    pending = Order.objects.create(symbol="A1", style="day", status="ENTRY_PENDING", **base).pk
    holding = Order.objects.create(symbol="A2", style="day", status="EXIT_WATCHING", **base).pk
    swing = Order.objects.create(symbol="A3", style="swing", status="ENTRY_PENDING", **base).pk
    try:
        migrator = MigrationExecutor(connection)
        migrator.migrate(after)
        rows = {r["pk"]: r for r in migrator.loader.project_state(after).apps.get_model("trading", "PaperOrder")
                .objects.values("pk", "style", "status", "note", "closed_at")}
        assert (rows[pending]["style"], rows[pending]["status"], rows[pending]["note"]) == ("swing", "CANCELED",
                                                                                             "단타 기능 삭제")
        assert rows[pending]["closed_at"] is not None
        assert (rows[holding]["style"], rows[holding]["status"], rows[holding]["closed_at"]) == ("swing", "EXIT_WATCHING",
                                                                                                 None)
        assert (rows[swing]["style"], rows[swing]["status"], rows[swing]["note"]) == ("swing", "ENTRY_PENDING", None)
    finally:
        migrator = MigrationExecutor(connection)
        migrator.migrate(migrator.loader.graph.leaf_nodes())
