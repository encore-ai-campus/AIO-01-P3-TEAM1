"""리스크 미리 보기, 계획 활성화·진행·중단 (executor), 추천·계획 API."""
from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from trading import service
from trading.models import PaperAccount, PaperOrder, Reservation
from trading.store import account_for

from autotrade import executor, risk
from autotrade.models import PlanEvent, Recommendation, TradePlan
from autotrade.tokens import activation_token
from config import engine

from .conftest import login, make_rec, set_price, switch

pytestmark = pytest.mark.django_db


def sync():
    service.sync_accounts(timezone.now(), lambda text: None)


def activate(api, rec, **body):
    return api.post(f"/api/recommendations/{rec.id}/activate", body, format="json")


def kinds(plan) -> list[str]:
    return list(PlanEvent.objects.filter(plan=plan).order_by("step").values_list("kind", flat=True))


def day_end(plan, fake):
    """연결된 진입 주문을 3시간 전 접수로 돌리고 정규장을 끝내 체결 확인 → 그날 미체결로 취소 (DAY_END)."""
    PaperOrder.objects.filter(pk=plan.order_id).update(created_at=timezone.now() - timedelta(hours=3))
    fake.ended.add("KR")
    switch(fake)  # 캐시 비우기
    fake.ended.add("KR")
    sync()
    assert PaperOrder.objects.get(pk=plan.order_id).note == executor.DAY_END


def plan_in(status, rec, user, **fields) -> TradePlan:
    """주문을 내지 않은 계획을 바로 만든다 (상태 전이만 볼 때)."""
    return TradePlan.objects.create(
        recommendation=rec, user=user, symbol=rec.symbol, name=rec.name, market=rec.market, currency=rec.currency,
        status=status, quantity=10, entry_price=rec.entry_price, target_price=rec.target_price,
        stop_price=rec.stop_price, holding_days=rec.holding_days, entry_deadline=rec.valid_until, **fields)


# --- 미리 보기 ---

def test_preview_passes(api, fake):
    rec = make_rec()
    body = api.get(f"/api/recommendations/{rec.id}/preview")
    assert body.status_code == 200, body.json()
    p = body.json()
    assert p["approved"] and p["activatable"] and p["reasons"] == []
    assert p["limitedBy"] == "건당 위험 한도" and p["quantity"] == 25  # 자산 1천만 × 1% ÷ 1주 손실
    assert p["amountKrw"] == pytest.approx(25 * 69000)
    assert p["maxLossKrw"] == pytest.approx(25 * (69000 * 1.001 - 66000 * 0.99 * 0.997))
    assert p["budgetKrw"] is None and p["lastPrice"] == 70000


def test_preview_budget_limits_quantity(api, fake):
    rec = make_rec()
    p = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=700000").json()
    assert p["quantity"] == 10 and p["limitedBy"] == "예산" and p["budgetKrw"] == 700000  # 700,000 ÷ 69,069
    assert p["amountKrw"] == pytest.approx(10 * 69000) and p["activatable"]
    big = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=100000000").json()
    assert big["quantity"] == 25 and big["limitedBy"] == "건당 위험 한도"  # 늘리지는 않는다
    small = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=1000").json()
    assert not small["activatable"] and "1주도 살 수 없음" in small["reasons"][0]
    for bad in ("abc", "0", "-5"):
        assert api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw={bad}").status_code == 400


def test_preview_blockers(api, fake):
    rec = make_rec()
    engine.HALT_FILE.touch()
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert not p["activatable"] and any("중단 스위치" in r for r in p["reasons"])
    engine.HALT_FILE.unlink()
    api.post("/api/orders", {"symbol": "005930", "quantity": 1, "orderType": "MARKET"}, format="json")
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["approved"] and not p["activatable"] and any("진행 중인 모의 주문" in r for r in p["reasons"])


def test_preview_price_above_target_or_below_stop(api, fake):
    rec = make_rec()
    set_price(fake, "005930", 81000)
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert not p["activatable"] and any("이미 목표가에 도달" in r for r in p["reasons"])
    set_price(fake, "005930", 65000)
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert any("손절가 이하" in r for r in p["reasons"])


def test_preview_expired_and_warning(api, fake):
    rec = make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=230000, stop=180000)
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert not p["approved"] and any("매수 유의" in r for r in p["reasons"])
    old = make_rec(now=timezone.now() - timedelta(days=4))
    p = api.get(f"/api/recommendations/{old.id}/preview").json()
    assert any("활성화 기한" in r for r in p["reasons"])


def test_preview_without_broker_is_503(api):
    rec = make_rec()
    assert api.get(f"/api/recommendations/{rec.id}/preview").status_code == 503


# --- 활성화 ---

def test_activate_places_limit_order(api, fake, user, sent):
    rec = make_rec()
    body = activate(api, rec)
    assert body.status_code == 201, body.json()
    plan = body.json()
    assert plan["status"] == "entry_pending" and plan["via"] == "web" and plan["quantity"] == 25
    assert plan["source"] == "analysis" and plan["recommendation"]["myPlan"] == {"id": plan["id"],
                                                                               "status": "entry_pending"}
    assert [e["kind"] for e in plan["events"]] == ["activated", "risk_checked", "order_placed"]
    assert [e["step"] for e in plan["events"]] == [1, 2, 3]
    assert plan["events"][2]["message"] == "삼성전자 25주 69,000원 지정가 매수 주문 접수"
    order = PaperOrder.objects.get(pk=plan["orderId"])
    assert order.order_type == "LIMIT" and order.limit_price == 69000 and order.quantity == 25
    assert order.requested_by == f"plan:{plan['id']}" and order.account.user == user
    assert (order.target_price, order.stop_price) == (80000, 66000)
    assert order.expire_date == timezone.localdate() + timedelta(days=executor.order_days(rec.holding_days))
    assert sent.kinds == ["recommendation", "plan_activated", "order_placed"]
    assert sent.calls[-1]["link"] == f"/plans/{plan['id']}" and sent.calls[-1]["users"] == user


def test_activate_with_discord_token(api, fake):
    rec = make_rec()
    assert activate(api, rec, token="위조").status_code == 400
    assert activate(api, rec, token="위조").json()["detail"] == "링크가 만료되었거나 올바르지 않습니다."
    body = activate(api, rec, token=activation_token(rec), budgetKrw=700000)
    assert body.status_code == 201 and body.json()["via"] == "discord" and body.json()["budgetKrw"] == 700000
    assert body.json()["quantity"] == 10


def test_activate_twice_and_others(api, fake, django_user_model):
    rec = make_rec()
    first = activate(api, rec).json()
    again = activate(api, rec)
    assert again.status_code == 400 and "진행 중" in again.json()["detail"]
    assert activate(api, make_rec(), budgetKrw=-1).status_code == 400
    assert api.post("/api/recommendations/999/activate", {}, format="json").status_code == 404
    bob, bob_api = login(django_user_model, "bob")
    assert bob_api.get(f"/api/trade-plans/{first['id']}").status_code == 404
    assert bob_api.post(f"/api/trade-plans/{first['id']}/cancel").status_code == 404
    assert activate(bob_api, rec).status_code == 201  # 같은 추천을 다른 팀원이 각자 활성화


def test_activate_rejected_by_risk_engine(api, fake):
    rec = make_rec(target=70500)  # 손익비 미달
    body = activate(api, rec)
    assert body.status_code == 400 and "손익비" in body.json()["detail"]
    assert not TradePlan.objects.exists()


# --- 진행 ---

def test_full_flow_fill_then_target_exit(api, fake, sent):
    rec = make_rec()
    plan = TradePlan.objects.get(pk=activate(api, rec).json()["id"])
    set_price(fake, "005930", 68500)
    sync()
    executor.tick(timezone.now(), lambda text: None)
    plan.refresh_from_db()
    assert plan.status == "holding" and plan.fill_price == 68500 and plan.filled_at is not None
    set_price(fake, "005930", 81000)
    sync()
    sync()  # 목표가는 두 번 확인한다
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "closed" and plan.exit_reason == "TARGET" and plan.exit_price == 81000
    assert plan.pnl_krw > 0 and plan.closed_at is not None
    assert kinds(plan) == ["activated", "risk_checked", "order_placed", "filled", "closed"]
    assert sent.kinds == ["recommendation", "plan_activated", "order_placed", "filled", "closed"]
    assert sent.calls[-1]["title"] == "삼성전자 청산 · 목표가 도달"
    assert executor.tick(timezone.now(), lambda text: None) == 0


def test_activation_fills_immediately_when_price_is_at_entry(api, fake):
    rec = make_rec(entry=70000, target=82000, stop=67000)
    plan = activate(api, rec).json()
    assert plan["status"] == "holding" and plan["fillPrice"] == 70000
    assert [e["kind"] for e in plan["events"]][-2:] == ["order_placed", "filled"]


def test_day_end_cancel_requeues(api, fake, sent):
    rec = make_rec()
    plan = TradePlan.objects.get(pk=activate(api, rec).json()["id"])
    first = plan.order_id
    PaperOrder.objects.filter(pk=first).update(created_at=timezone.now() - timedelta(hours=3))
    fake.ended.add("KR")
    switch(fake)  # 캐시 비우기
    fake.ended.add("KR")
    sync()
    assert PaperOrder.objects.get(pk=first).status == "CANCELED"
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "entry_pending" and plan.order_id != first
    new = PaperOrder.objects.get(pk=plan.order_id)
    assert new.status == "ENTRY_PENDING" and new.limit_price == 69000 and new.requested_by == f"plan:{plan.id}"
    event = PlanEvent.objects.get(plan=plan, kind="order_requeued")
    assert event.details == {"orderId": plan.order_id, "previousOrderId": first}
    requeued = sent.calls[-1]
    assert requeued["kind"] == "order_requeued" and requeued["discord"] is False
    executor.step(plan, timezone.now())  # 새 주문은 아직 대기 → 그대로
    assert PaperOrder.objects.filter(requested_by=f"plan:{plan.id}").count() == 2


def test_requeue_fails_when_price_passed_target(api, fake):
    rec = make_rec()
    plan = TradePlan.objects.get(pk=activate(api, rec).json()["id"])
    PaperOrder.objects.filter(pk=plan.order_id).update(created_at=timezone.now() - timedelta(hours=3))
    fake.ended.add("KR")
    set_price(fake, "005930", 81000)
    fake.ended.add("KR")
    sync()
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "failed" and "이미 목표가에 도달" in plan.failure_reason


def test_deadline_expires_pending_order(api, fake, sent):
    rec = make_rec()
    plan = TradePlan.objects.get(pk=activate(api, rec).json()["id"])
    executor.step(plan, plan.entry_deadline + timedelta(seconds=1))
    plan.refresh_from_db()
    assert plan.status == "expired" and PaperOrder.objects.get(pk=plan.order_id).status == "CANCELED"
    assert kinds(plan)[-1] == "expired" and sent.kinds[-1] == "expired"


def test_active_plan_past_deadline_expires_without_order(fake, user):
    rec = make_rec()
    plan = plan_in("active", rec, user)
    executor.step(plan, plan.entry_deadline)
    plan.refresh_from_db()
    assert plan.status == "expired" and not PaperOrder.objects.exists()


def test_user_cancels_order_directly(api, fake, sent):
    rec = make_rec()
    plan = TradePlan.objects.get(pk=activate(api, rec).json()["id"])
    assert api.post(f"/api/orders/{plan.order_id}/cancel").status_code == 200
    executor.tick(timezone.now(), lambda text: None)
    plan.refresh_from_db()
    assert plan.status == "cancelled" and plan.failure_reason == "모의 주문을 직접 취소함"
    assert sent.kinds[-1] == "cancelled"


def test_user_sells_directly_closes_manual(api, fake):
    rec = make_rec(entry=70000, target=82000, stop=67000)
    plan = TradePlan.objects.get(pk=activate(api, rec).json()["id"])
    api.post(f"/api/orders/{plan.order_id}/sell")
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "closed" and plan.exit_reason == "MANUAL"


def test_step_twice_places_one_order(fake, user):
    rec = make_rec()
    plan = plan_in("active", rec, user)
    executor.step(plan, timezone.now())
    executor.step(TradePlan.objects.get(pk=plan.pk), timezone.now())
    assert PaperOrder.objects.filter(requested_by=f"plan:{plan.id}").count() == 1
    assert kinds(plan) == ["order_placed"]
    # 다른 쪽이 상태를 먼저 잡았으면(active가 아니면) 주문하지 않는다
    stale = plan_in("active", make_rec(symbol="005935", name="삼성전자우", entry=59000, target=70000,
                                       stop=56000), user)
    TradePlan.objects.filter(pk=stale.pk).update(status="entry_pending")
    executor._enter(stale, timezone.now(), lambda text: None)
    assert not PaperOrder.objects.filter(requested_by=f"plan:{stale.id}").exists()


def test_broker_failure_keeps_plan_active(fake, user):
    rec = make_rec()
    plan = plan_in("active", rec, user)
    fake.fail = True
    logs = []
    executor.step(plan, timezone.now(), logs.append)
    plan.refresh_from_db()
    assert plan.status == "active" and plan.order_id is None and logs
    fake.fail = False
    executor.step(plan, timezone.now())
    assert TradePlan.objects.get(pk=plan.pk).status == "entry_pending"


def test_halt_makes_plan_fail(fake, user, sent):
    plan = plan_in("active", make_rec(), user)
    engine.HALT_FILE.touch()
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "failed" and "중단 스위치" in plan.failure_reason and sent.kinds[-1] == "failed"


def test_tick_isolates_errors(fake, user, monkeypatch):
    plans = [plan_in("active", make_rec(), user),
             plan_in("active", make_rec(symbol="005935", name="삼성전자우", entry=59000, target=70000, stop=56000),
                     user)]
    original = executor.step

    def flaky(plan, now, log=None):
        if plan.id == plans[0].id:
            raise RuntimeError("깨짐")
        return original(plan, now, log)
    monkeypatch.setattr(executor, "step", flaky)
    logs = []
    assert executor.tick(timezone.now(), logs.append) == 2
    assert any("깨짐" in line for line in logs)
    assert TradePlan.objects.get(pk=plans[1].pk).status == "entry_pending"


# --- 중단 API ---

def test_cancel_active_plan(api, fake, user):
    plan = plan_in("active", make_rec(), user)
    body = api.post(f"/api/trade-plans/{plan.id}/cancel")
    assert body.status_code == 200 and body.json()["status"] == "cancelled"
    assert body.json()["events"][-1]["kind"] == "cancelled"
    assert api.post(f"/api/trade-plans/{plan.id}/cancel").status_code == 400  # 이미 끝남


def test_cancel_pending_plan_cancels_order(api, fake):
    plan = activate(api, make_rec()).json()
    body = api.post(f"/api/trade-plans/{plan['id']}/cancel").json()
    assert body["status"] == "cancelled" and body["failureReason"] == "사용자가 계획을 중단함"
    order = PaperOrder.objects.get(pk=plan["orderId"])
    assert order.status == "CANCELED" and order.note == f"사용자 취소 (plan:{plan['id']})"
    executor.tick(timezone.now(), lambda text: None)  # 끝난 계획은 진행하지 않는다
    assert TradePlan.objects.get(pk=plan["id"]).status == "cancelled"


def test_cancel_holding_plan_sells(api, fake):
    plan = activate(api, make_rec(entry=70000, target=82000, stop=67000)).json()
    assert plan["status"] == "holding"
    body = api.post(f"/api/trade-plans/{plan['id']}/cancel").json()
    assert body["status"] == "closed" and body["exitReason"] == "MANUAL"
    assert [e["kind"] for e in body["events"]][-2:] == ["exit_requested", "closed"]


def test_cancel_holding_plan_outside_hours_reserves_sell(api, fake):
    plan = activate(api, make_rec(entry=70000, target=82000, stop=67000)).json()
    switch(fake, KR=False)
    body = api.post(f"/api/trade-plans/{plan['id']}/cancel").json()
    assert body["status"] == "holding"
    event = body["events"][-1]
    reservation = Reservation.objects.get()
    assert event["kind"] == "exit_requested" and event["details"] == {"orderId": plan["orderId"],
                                                                      "reservationId": reservation.id}


# --- 목록 API ---

def test_recommendation_list_filters_and_my_plan(api, fake, user, django_user_model):
    a = make_rec()
    b = make_rec(source="demo", symbol="005935", name="삼성전자우", entry=59000, target=70000, stop=56000)
    old = make_rec(source="demo", now=timezone.now() - timedelta(days=4))
    plan = activate(api, a).json()
    bob, bob_api = login(django_user_model, "bob")
    activate(bob_api, a)
    results = api.get("/api/recommendations").json()
    assert results["count"] == 2 and [r["id"] for r in results["results"]] == [b.id, a.id]
    mine = results["results"][1]
    assert mine["myPlan"] == {"id": plan["id"], "status": "entry_pending"} and mine["planCount"] == 2
    assert results["results"][0]["myPlan"] is None and results["results"][0]["planCount"] == 0
    assert bob_api.get("/api/recommendations").json()["results"][1]["myPlan"]["id"] != plan["id"]
    every = api.get("/api/recommendations?status=all").json()
    assert every["count"] == 3 and every["results"][-1]["id"] == old.id
    assert every["results"][-1]["status"] == "expired"
    assert api.get("/api/recommendations?source=demo").json()["count"] == 1
    assert api.get(f"/api/recommendations?source=analysis&sourceId={a.analysis_id or 0}").json()["count"] == 0
    assert api.get("/api/recommendations?symbol=005935").json()["results"][0]["id"] == b.id
    assert api.get("/api/recommendations?status=nope").status_code == 400
    assert api.get("/api/recommendations?source=nope").status_code == 400
    assert api.get("/api/recommendations?sourceId=1").status_code == 400
    assert api.get(f"/api/recommendations/{a.id}").json()["planCount"] == 2
    assert api.get("/api/recommendations/999").status_code == 404


def test_recommendation_list_source_id(api, user):
    from analysis.models import AnalysisRun
    from reports.models import Report
    run = AnalysisRun.objects.create(run_file="runs/x.json", symbol="005930", name="삼성전자", market="KR",
                                     currency="KRW", analyzed_at=timezone.now(), verdict="BUY")
    report = Report.objects.create(user=user, symbol="005930", name="삼성전자", market="KR")
    by_run, by_report = make_rec(analysis=run), make_rec(source="report", report=report)
    found = api.get(f"/api/recommendations?source=analysis&sourceId={run.id}").json()["results"]
    assert [r["id"] for r in found] == [by_run.id] and found[0]["sourceId"] == run.id
    found = api.get(f"/api/recommendations?source=report&sourceId={report.id}").json()["results"]
    assert [r["id"] for r in found] == [by_report.id] and found[0]["requestedBy"] is None


def test_recommendation_list_query_count_is_flat(api, user):
    make_rec()
    with CaptureQueriesContext(connection) as one:
        api.get("/api/recommendations")
    for i in range(4):
        make_rec(requested_by=user, symbol=f"00{i}", name=f"종목{i}")
    with CaptureQueriesContext(connection) as many:
        body = api.get("/api/recommendations").json()
    assert body["count"] == 5 and body["results"][0]["requestedBy"] == "alice"
    assert len(many) <= len(one) + 1  # 닉네임 조회가 하나 더 (신청자가 생겨서)


def test_trade_plan_list(api, fake, user):
    plan = activate(api, make_rec()).json()
    done = plan_in("cancelled", make_rec(symbol="005935", name="삼성전자우", entry=59000, target=70000, stop=56000),
                   user)
    active = api.get("/api/trade-plans").json()
    assert active["count"] == 1 and active["results"][0]["id"] == plan["id"]
    assert "events" not in active["results"][0]
    every = api.get("/api/trade-plans?status=all").json()
    assert [p["id"] for p in every["results"]] == [done.id, plan["id"]]
    detail = api.get(f"/api/trade-plans/{plan['id']}").json()
    assert detail["recommendation"]["id"] == plan["recommendationId"] and len(detail["events"]) == 3
    assert api.get("/api/trade-plans?status=nope").status_code == 400


def test_plans_need_login(client):
    assert client.get("/api/trade-plans").status_code == 401
    assert client.get("/api/recommendations").status_code == 401


def test_open_status_hides_past_valid_until(api):
    rec = make_rec()
    Recommendation.objects.filter(pk=rec.pk).update(valid_until=timezone.now() - timedelta(seconds=1))
    assert api.get("/api/recommendations").json()["count"] == 0
    assert api.get(f"/api/recommendations/{rec.id}").json()["status"] == "expired"


def test_preview_function_excludes_own_plan_when_requeueing(fake, user):
    rec = make_rec()
    plan = plan_in("entry_pending", rec, user)
    assert risk.preview(rec, user, plan=plan)["activatable"]
    assert not risk.preview(rec, user)["activatable"]


def test_preview_us_converts_to_krw(api, fake):
    rec = make_rec(symbol="AAPL", name="Apple", market_="US", entry=190, target=230, stop=180, price_at_creation=200)
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["activatable"], p["reasons"]
    assert p["quantity"] == 5 and p["amountKrw"] == pytest.approx(5 * 190 * 1400)


# --- 경합 · 재주문 수량 · 엔진 취소 · 트랜잭션 ---

def test_cancel_racing_requeue_leaves_no_live_order(api, fake, monkeypatch):
    """웹 중단이 앞 주문(그날 미체결 취소)을 읽은 뒤 엔진이 다시 주문하면, 중단은 새 주문까지 취소하고 끝낸다."""
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    first = plan.order_id
    day_end(plan, fake)
    original = executor._end

    def requeue_first(p, frm, to, reason, details=None, match=None):
        if to == TradePlan.CANCELLED and match == {"order_id": first}:
            monkeypatch.setattr(executor, "_end", original)
            executor.step(TradePlan.objects.get(pk=p.pk), timezone.now())  # 엔진 루프가 끼어든다
        return original(p, frm, to, reason, details, match)
    monkeypatch.setattr(executor, "_end", requeue_first)
    body = api.post(f"/api/trade-plans/{plan.id}/cancel")
    assert body.status_code == 200 and body.json()["status"] == "cancelled"
    plan.refresh_from_db()
    assert plan.order_id != first and PaperOrder.objects.get(pk=plan.order_id).status == "CANCELED"
    assert not PaperOrder.objects.filter(requested_by=f"plan:{plan.id}", status="ENTRY_PENDING").exists()
    assert kinds(plan)[-2:] == ["order_requeued", "cancelled"]


def test_place_cancels_order_when_plan_ended_meanwhile(fake, user, monkeypatch, sent):
    plan = plan_in("active", make_rec(), user)
    real_buy = service.buy

    def buy_then_cancelled(*args, **kwargs):
        result = real_buy(*args, **kwargs)
        TradePlan.objects.filter(pk=plan.pk).update(status="cancelled")  # 주문을 내는 사이 중단됐다
        return result
    monkeypatch.setattr(service, "buy", buy_then_cancelled)
    logs = []
    executor.step(plan, timezone.now(), logs.append)
    plan.refresh_from_db()
    order = PaperOrder.objects.get(requested_by=f"plan:{plan.id}")
    assert plan.status == "cancelled" and plan.order_id is None and order.status == "CANCELED"
    assert kinds(plan) == [] and "order_placed" not in sent.kinds  # 사건·알림을 남기지 않는다
    assert any("방금 낸 주문" in line for line in logs)


def test_place_sells_order_that_filled_before_it_was_linked(fake, user, monkeypatch):
    plan = plan_in("active", make_rec(entry=70000, target=82000, stop=67000), user)  # 지금 가격 = 진입가: 바로 체결
    real_buy = service.buy

    def buy_then_linked_elsewhere(*args, **kwargs):
        result = real_buy(*args, **kwargs)
        TradePlan.objects.filter(pk=plan.pk).update(status="cancelled")
        return result
    monkeypatch.setattr(service, "buy", buy_then_linked_elsewhere)
    executor.step(plan, timezone.now())
    order = PaperOrder.objects.get(requested_by=f"plan:{plan.id}")
    assert order.status == "CLOSED" and order.exit_reason == "MANUAL"  # 어떤 계획도 따라가지 않는 포지션을 남기지 않는다


def test_requeue_shrinks_quantity_when_risk_shrinks(api, fake, sent):
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    first = plan.order_id
    assert plan.quantity == 25
    day_end(plan, fake)
    account = account_for(plan.user)
    PaperAccount.objects.filter(pk=account.pk).update(cash_krw=account.cash_krw * 0.5)  # 자산이 줄었다
    expected = risk.preview(plan.recommendation, plan.user, None, timezone.now(), plan=plan)["quantity"]
    assert expected < 25
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    new = PaperOrder.objects.get(pk=plan.order_id)
    assert plan.status == "entry_pending" and plan.quantity == expected and new.quantity == expected
    event = PlanEvent.objects.get(plan=plan, kind="order_requeued")
    assert event.details == {"orderId": new.id, "previousOrderId": first, "quantity": expected,
                             "previousQuantity": 25}
    assert f"25주 → {expected}주" in event.message and sent.calls[-1]["kind"] == "order_requeued"


def test_requeue_never_grows_quantity(api, fake):
    plan = TradePlan.objects.get(pk=activate(api, make_rec(), budgetKrw=700000).json()["id"])
    assert plan.quantity == 10
    day_end(plan, fake)
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.quantity == 10 and PaperOrder.objects.get(pk=plan.order_id).quantity == 10
    assert PlanEvent.objects.get(plan=plan, kind="order_requeued").details.keys() == {"orderId", "previousOrderId"}


def test_engine_cancel_makes_plan_failed(api, fake, sent):
    """사용자가 하지 않은 취소(체결 시점 현금 부족 등)는 cancelled가 아니라 failed."""
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    note = "체결 시점 현금 부족 (필요 1,726,725원, 가능 1,000원)"
    PaperOrder.objects.filter(pk=plan.order_id).update(status="CANCELED", note=note)
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "failed" and plan.failure_reason == f"모의 주문이 취소됨: {note}"
    assert kinds(plan)[-1] == "failed" and sent.kinds[-1] == "failed"


def test_cancel_holding_twice_outside_hours(api, fake):
    plan = activate(api, make_rec(entry=70000, target=82000, stop=67000)).json()
    switch(fake, KR=False)
    first = api.post(f"/api/trade-plans/{plan['id']}/cancel").json()
    again = api.post(f"/api/trade-plans/{plan['id']}/cancel")
    assert again.status_code == 200 and again.json()["status"] == "holding"
    assert again.json()["events"] == first["events"]  # 사건을 다시 남기지 않는다
    assert Reservation.objects.count() == 1


def test_transition_and_event_roll_back_together(fake, user, monkeypatch, sent):
    plan = plan_in("active", make_rec(), user)

    def broken(*args, **kwargs):
        raise RuntimeError("database is locked")
    monkeypatch.setattr(executor, "_event", broken)
    with pytest.raises(RuntimeError):
        executor._end(plan, TradePlan.ACTIVE, TradePlan.FAILED, "실패")
    plan.refresh_from_db()
    assert plan.status == "active" and plan.failure_reason is None  # 상태도 사건도 남지 않는다
    assert "failed" not in sent.kinds  # 롤백되면 알림도 없다


def test_recover_relinks_order_and_records_missing_event(fake, user, sent):
    """주문을 낸 뒤 계획에 잇기 전에 멈췄으면, 다음 진행이 그 주문을 다시 잇고 order_placed를 남긴다 (한 번만)."""
    plan = plan_in("entry_pending", make_rec(), user)
    result = service.buy(account_for(user), f"plan:{plan.id}", "005930", 10, service.LIMIT, 69000, 80000, 66000, 14,
                         timezone.now())
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.order_id == result["order"]["id"] and plan.status == "entry_pending"
    assert kinds(plan) == ["order_placed"] and sent.kinds[-1] == "order_placed"
    executor.step(plan, timezone.now())
    assert kinds(plan) == ["order_placed"]


def test_preview_us_budget_is_fractional_amount(api, fake):
    rec = make_rec(symbol="AAPL", name="Apple", market_="US", entry=190, target=230, stop=180, price_at_creation=200)
    p = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=600000").json()
    assert p["activatable"], p["reasons"]
    assert p["limitedBy"] == "예산" and 2 < p["quantity"] < 3  # 정수 주로 내리지 않는다 (소수점 매수)
    assert p["quantity"] * 190 == pytest.approx(round(p["quantity"] * 190, 2))  # 금액은 센트 단위
    small = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=100000").json()  # 1주($190)보다 적다
    assert small["activatable"] and 0 < small["quantity"] < 1
    tiny = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=1000").json()  # 약 $0.71
    assert not tiny["activatable"] and any("최소 주문 금액" in r for r in tiny["reasons"])
