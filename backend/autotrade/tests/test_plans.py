"""리스크 미리 보기, 계획 활성화·진행·중단 (executor), 추천·계획 API.

넣을 돈은 사용자가 정한다 (2026-10-11, docs/API.md "넣을 돈"): 활성화는 budgetPercent·budgetKrw 중 하나가 필수다.
여기 활성화 도우미는 금액을 주지 않으면 BUDGET_KRW(삼성전자 25주)로 보낸다. 넣을 돈 규칙 자체는 test_budget.py가 본다.
"""
from datetime import timedelta

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils import timezone
from trading import service
from trading.models import PaperAccount, PaperOrder, Reservation
from trading.store import account_for

from autotrade.plans import executor, risk
from autotrade.models import PlanEvent, Recommendation, TradePlan
from autotrade.tokens import activation_token
from config import engine

from .conftest import close_of, login, make_rec, set_price, switch

pytestmark = pytest.mark.django_db


def sync():
    service.sync_accounts(timezone.now(), lambda text: None)


BUDGET_KRW = 1_760_000  # 진입 69,000원(1주 69,069원)·70,000원(70,070원)이면 25주


def activate(api, rec, **body):
    """활성화 요청. 넣을 돈(budgetPercent·budgetKrw)이 없으면 BUDGET_KRW로 보낸다 (금액 없음은 api.post로 직접 본다)."""
    if "budgetPercent" not in body and "budgetKrw" not in body:
        body["budgetKrw"] = BUDGET_KRW
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

LOSS_PER_SHARE = 69000 * 1.001 - 66000 * 0.99 * 0.997  # make_rec() 1주 손절 손실 (비용·손절 주문가 반영)


def test_preview_without_budget_checks_only(api, fake):
    """금액이 없으면 크기 계산 없이 점검만 한다 — activatable은 "금액만 정하면 시작할 수 있음"의 뜻."""
    rec = make_rec()
    body = api.get(f"/api/recommendations/{rec.id}/preview")
    assert body.status_code == 200, body.json()
    p = body.json()
    assert p["approved"] and p["activatable"] and p["reasons"] == [] and p["reasonCodes"] == []
    assert p["quantity"] == 0 and p["amountKrw"] == 0 and p["expectedProfitKrw"] == 0 and p["maxLossKrw"] == 0
    assert p["limitedBy"] is None and p["maxLossRate"] is None and p["largeLoss"] is False
    assert (p["budgetMode"], p["budgetPercent"], p["budgetKrw"]) == (None, None, None)
    assert p["buyingPowerKrw"] == 10_000_000 and p["equityKrw"] == 10_000_000 and p["priceBasis"] == "close"
    assert p["lastPrice"] == close_of(70000)  # 직전 정규장 종가 (장마감 기준)
    assert p["lastPriceAsOf"]  # 그 종가 봉 날짜의 정규장 종료 시각 (가짜 장 달력 기준)


def test_preview_with_amount(api, fake):
    rec = make_rec()
    p = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=700000").json()
    assert p["activatable"] and p["quantity"] == 10 and p["limitedBy"] == "내가 정한 금액"  # 700,000 ÷ 69,069
    assert (p["budgetMode"], p["budgetPercent"], p["budgetKrw"]) == ("amount", None, 700000)
    assert p["amountKrw"] == pytest.approx(10 * 69000)
    assert p["maxLossKrw"] == pytest.approx(10 * LOSS_PER_SHARE)
    assert p["maxLossRate"] == pytest.approx(10 * LOSS_PER_SHARE / 10_000_000) and p["largeLoss"] is False


def test_preview_blockers(api, fake):
    rec = make_rec()
    engine.HALT_FILE.touch()
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert not p["activatable"] and any("중단 스위치" in r for r in p["reasons"]) and p["reasonCodes"] == ["halted"]
    engine.HALT_FILE.unlink()
    api.post("/api/orders", {"symbol": "005930", "quantity": 1, "orderType": "MARKET", "style": "long"},
             format="json")
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["approved"] and not p["activatable"] and any("진행 중인 모의 주문" in r for r in p["reasons"])
    assert p["reasonCodes"] == ["position_exists"]


def test_preview_price_above_target_or_below_stop(api, fake):
    """장 밖(기준일 뒤 정규장이 아직 없음)이면 미리 보기는 직전 종가로 본다 (종가 숫자는 문장에 넣어도 된다)."""
    rec = make_rec()
    switch(fake, KR=False)  # 장 시작 전
    set_price(fake, "005930", 81000)
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert not p["activatable"] and p["reasonCodes"] == ["price_passed"]
    assert p["reasons"] == [f"직전 종가({close_of(81000):,.0f}원)가 이미 목표가 이상"]
    set_price(fake, "005930", 65000)
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["reasons"] == [f"직전 종가({close_of(65000):,.0f}원)가 이미 손절가 이하"]
    set_price(fake, "005930", 80100)  # 장중 가격은 목표가 이상이지만 종가(79,823원)는 아직 아래: 장 밖 미리 보기는 통과
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["activatable"] and p["lastPrice"] == close_of(80100) < 80000


def test_preview_during_session_checks_live_price(api, fake):
    """장 중이면 직전 종가는 지난 가격이다 — 미리 보기도 현재가로 본다 (숫자 없는 문장, docs/API.md "리포트 시세").
    lastPrice·금액은 그대로 종가 기준이다."""
    rec = make_rec()  # 목표 80,000 · 손절 66,000
    set_price(fake, "005930", 80100)  # 종가 79,823원 < 목표가 80,000원 ≤ 현재가 80,100원
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["reasonCodes"] == ["price_passed"] and p["reasons"] == ["장중 가격이 이미 목표가 이상이에요"]
    assert p["lastPrice"] == close_of(80100) and p["priceBasis"] == "close"
    set_price(fake, "005930", 66100)  # 종가 65,872원은 손절가 이하지만 지금 가격은 손절가 위: 시작할 수 있다
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["activatable"] and p["lastPrice"] == close_of(66100) <= 66000
    switch(fake, KR=False)  # 장 밖이면 종가로
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert p["reasons"] == [f"직전 종가({close_of(66100):,.0f}원)가 이미 손절가 이하"]


def test_preview_expired_and_warning(api, fake):
    rec = make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=230000, stop=180000)
    p = api.get(f"/api/recommendations/{rec.id}/preview").json()
    assert not p["approved"] and any("매수 유의" in r for r in p["reasons"]) and p["reasonCodes"] == ["warning_stock"]
    old = make_rec(now=timezone.now() - timedelta(days=4))
    p = api.get(f"/api/recommendations/{old.id}/preview").json()
    assert any("활성화 기한" in r for r in p["reasons"]) and p["reasonCodes"] == ["expired"]


def test_preview_without_broker_is_503(api):
    rec = make_rec()
    assert api.get(f"/api/recommendations/{rec.id}/preview").status_code == 503


# --- 활성화 ---

@pytest.mark.parametrize("at", ["2026-09-22T10:00:00", "2026-09-22T01:30:00"])  # 장중 · KST와 UTC 날짜가 다른 새벽
def test_activate_places_limit_order(api, clock, user, sent, at):
    now = clock(at)
    rec = make_rec()
    body = activate(api, rec)
    assert body.status_code == 201, body.json()
    plan = body.json()
    assert plan["status"] == "entry_pending" and plan["via"] == "web" and plan["quantity"] == 25
    assert plan["source"] == "analysis" and plan["recommendation"]["myPlan"] == {"id": plan["id"],
                                                                               "status": "entry_pending"}
    assert [e["kind"] for e in plan["events"]] == ["activated", "risk_checked", "order_placed"]
    assert [e["step"] for e in plan["events"]] == [1, 2, 3]
    assert plan["events"][0]["details"] == {"via": "web", "budgetMode": "amount", "budgetPercent": None,
                                            "budgetKrw": BUDGET_KRW, "acknowledged": False}
    assert plan["events"][1]["message"] == (f"리스크 엔진 점검 통과: 내가 정한 금액 1,760,000원으로 25주 "
                                            f"(손익비 {rec.reward_risk:.2f})")
    assert plan["events"][1]["details"] == {"approved": True, "quantity": 25, "limitedBy": "내가 정한 금액",
                                            "rewardRisk": rec.reward_risk, "reasons": []}
    assert (plan["budgetMode"], plan["budgetPercent"], plan["budgetKrw"]) == ("amount", None, BUDGET_KRW)
    assert plan["events"][2]["message"] == "삼성전자 25주 69,000원 지정가 매수 주문 접수"
    order = PaperOrder.objects.get(pk=plan["orderId"])
    assert order.order_type == "LIMIT" and order.limit_price == 69000 and order.quantity == 25
    assert order.requested_by == f"plan:{plan['id']}" and order.account.user == user and order.style == "swing"
    assert (order.target_price, order.stop_price) == (80000, 66000)
    days = executor.order_days(rec.holding_days)
    assert str(order.expire_date) == str(now.date() + timedelta(days=days))  # 주문한 날의 KST 날짜 기준
    assert sent.kinds == ["recommendation", "order_placed"]  # 시작·주문 접수를 합친 하나 (docs/API.md "알림 합치기")
    assert sent.calls[-1]["link"] == f"/plans/{plan['id']}" and sent.calls[-1]["users"] == user
    assert sent.calls[-1]["discord"] is True


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
    assert again.json()["reasonCodes"] == ["plan_exists", "position_exists"]
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
    assert set(body.json()) == {"detail", "reasonCodes"} and "reward_risk_low" in body.json()["reasonCodes"]
    assert len(body.json()["reasonCodes"]) == len(body.json()["detail"].split("; "))
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
    assert sent.kinds == ["recommendation", "order_placed", "filled", "closed"]  # 활성화 요청 안의 시작·주문 접수는 하나로
    assert sent.calls[-1]["expert_title"] == "삼성전자 청산 · 목표가 도달"
    assert sent.calls[-1]["title"] == "삼성전자 모의 계좌에서 모두 팔았어요"
    assert sent.calls[-1]["body"].startswith("목표 가격에 닿아 모의 계좌에서 삼성전자 25주를 81,000원에 모두 팔았어요.")
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
    # 재주문은 장중 확인 가격으로 보고, 문장에 장중 가격 숫자를 넣지 않는다
    assert plan.status == "failed" and plan.failure_reason == "다시 주문할 수 없음: 장중 가격이 이미 목표가 이상이에요"
    failed = PlanEvent.objects.get(plan=plan, kind="failed")
    assert failed.details["reasonCodes"] == ["price_passed"] and "81,000" not in failed.message


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
    p = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=1400000").json()  # $1,000
    assert p["activatable"], p["reasons"]
    # 매수 금액 = $1,000 ÷ 1.002를 센트로 내린 $998, 수량 = $998 ÷ $190 (소수점)
    assert p["quantity"] == pytest.approx(998 / 190) and p["amountKrw"] == pytest.approx(998 * 1400)


# --- 경합 · 재주문 수량 · 엔진 취소 · 트랜잭션 ---

def test_cancel_racing_requeue_leaves_no_live_order(api, fake, monkeypatch):
    """웹 중단이 앞 주문(그날 미체결 취소)을 읽은 뒤 엔진이 다시 주문하면, 중단은 새 주문까지 취소하고 끝낸다."""
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    first = plan.order_id
    day_end(plan, fake)
    original = executor._end

    def requeue_first(p, frm, to, reason, details=None, match=None, **kw):
        if to == TradePlan.CANCELLED and match == {"order_id": first}:
            monkeypatch.setattr(executor, "_end", original)
            executor.step(TradePlan.objects.get(pk=p.pk), timezone.now())  # 엔진 루프가 끼어든다
        return original(p, frm, to, reason, details, match, **kw)
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


def test_requeue_keeps_quantity_when_equity_shrinks(api, fake):
    """재주문은 같은 수량이다 — 자산이 줄어도 건당 위험 한도로 다시 계산하지 않는다 (2026-10-11)."""
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    day_end(plan, fake)
    PaperAccount.objects.filter(pk=account_for(plan.user).pk).update(cash_krw=2_000_000)  # 1주 손실 × 25주 > 자산 1%
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "entry_pending" and plan.quantity == 25
    assert PaperOrder.objects.get(pk=plan.order_id).quantity == 25
    assert PlanEvent.objects.get(plan=plan, kind="order_requeued").details.keys() == {"orderId", "previousOrderId"}


def test_requeue_shrinks_quantity_when_cash_is_short(api, fake, sent):
    """매수 가능 금액이 모자라면 그 안으로 줄이기만 한다 (막지 않는다)."""
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    first = plan.order_id
    assert plan.quantity == 25
    day_end(plan, fake)
    PaperAccount.objects.filter(pk=account_for(plan.user).pk).update(cash_krw=1_000_000)
    expected = risk.preview(plan.recommendation, plan.user, None, timezone.now(), plan=plan)["quantity"]
    assert expected == 14  # 1,000,000 ÷ 69,069
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    new = PaperOrder.objects.get(pk=plan.order_id)
    assert plan.status == "entry_pending" and plan.quantity == expected and new.quantity == expected
    event = PlanEvent.objects.get(plan=plan, kind="order_requeued")
    assert event.details == {"orderId": new.id, "previousOrderId": first, "quantity": expected,
                             "previousQuantity": 25}
    assert f"25주 → {expected}주" in event.message and sent.calls[-1]["kind"] == "order_requeued"
    assert "한도에 맞춰 수량을 25주에서 14주로 줄였어요" in sent.calls[-1]["body"]


def test_requeue_fails_when_reduced_below_one_share(api, fake, sent):
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    day_end(plan, fake)
    PaperAccount.objects.filter(pk=account_for(plan.user).pk).update(cash_krw=50_000)  # 1주(69,069원)도 안 된다
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "failed" and plan.failure_reason == "다시 주문할 수 없음: " + risk.REQUEUE_TOO_SMALL
    assert PlanEvent.objects.get(plan=plan, kind="failed").details["reasonCodes"] == ["budget_too_small"]
    assert sent.kinds[-1] == "failed" and "1주도 살 수 없어" in sent.calls[-1]["body"]
    assert "내가 정한 금액" not in sent.calls[-1]["body"]  # 재주문 금액은 한도가 줄인 것이다


def test_requeue_of_old_plan_without_budget_mode(api, fake):
    """2026-10-11 전 계획(budget_mode·budget_krw 없음)도 같은 수량으로 다시 낸다."""
    plan = TradePlan.objects.get(pk=activate(api, make_rec()).json()["id"])
    TradePlan.objects.filter(pk=plan.pk).update(budget_mode=None, budget_krw=None)
    day_end(plan, fake)
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "entry_pending" and plan.quantity == 25 and plan.budget_mode is None
    assert PaperOrder.objects.get(pk=plan.order_id).quantity == 25


def test_requeue_keeps_us_fractional_quantity(api, fake):
    """미국 소수점 수량도 나눗셈 오차로 1센트 덜 사지 않고 그대로다."""
    rec = make_rec(symbol="AAPL", name="Apple", market_="US", entry=190, target=230, stop=180, price_at_creation=200)
    plan = TradePlan.objects.get(pk=activate(api, rec, budgetKrw=600000).json()["id"])
    assert 0 < plan.quantity % 1
    assert risk.preview(rec, plan.user, plan=plan)["quantity"] == plan.quantity


def test_requeue_keeps_old_us_whole_shares(fake, user):
    """2026-10-11 전 미국 정수 주 계획(27주)은 센트 내림·나눗셈 오차로 26.999…주가 되지 않고 27주 그대로 다시 낸다 (독립 리뷰)."""
    rec = make_rec(symbol="AAPL", name="Apple", market_="US", entry=19.09, target=23, stop=18, price_at_creation=20)
    plan = TradePlan.objects.create(
        recommendation=rec, user=user, symbol=rec.symbol, name=rec.name, market=rec.market, currency=rec.currency,
        status="entry_pending", quantity=27, entry_price=rec.entry_price, target_price=rec.target_price,
        stop_price=rec.stop_price, holding_days=rec.holding_days, entry_deadline=rec.valid_until)
    checked = risk.preview(rec, user, plan=plan)["quantity"]
    assert checked == pytest.approx(27)
    assert executor._requeue_quantity(plan.quantity, checked) == 27
    assert executor._requeue_quantity(27, 23.999999999999996) == 23.999999999999996  # 정말 줄었으면 줄인 수량
    assert executor._requeue_quantity(24, 23.999999999999996) == 24


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
    # 괄호 안 금액은 장중 확인 가격으로 계산한 값이라 옮기지 않는다
    assert plan.status == "failed" and plan.failure_reason == "모의 주문이 취소됨: 체결 시점 현금 부족"
    assert kinds(plan)[-1] == "failed" and sent.kinds[-1] == "failed"
    assert "현금이 모자라" in sent.calls[-1]["body"] and "1,726,725" not in sent.calls[-1]["body"]


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
    assert p["limitedBy"] == "내가 정한 금액" and 2 < p["quantity"] < 3  # 정수 주로 내리지 않는다 (소수점 매수)
    assert p["quantity"] * 190 == pytest.approx(round(p["quantity"] * 190, 2))  # 금액은 센트 단위
    small = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=100000").json()  # 1주($190)보다 적다
    assert small["activatable"] and 0 < small["quantity"] < 1
    tiny = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=1000").json()  # 약 $0.71
    assert not tiny["activatable"] and tiny["reasonCodes"] == ["budget_too_small"]
    assert tiny["reasons"] == ["내가 정한 금액으로 살 매수 금액($0.71)이 최소 주문 금액 $1보다 적음"]


# --- 사유 코드 (B4) · 활성화의 장중 확인 · acknowledged (B5) ---

def test_reason_codes_align_with_reasons(api, fake, user):
    rec = make_rec(symbol="000660", name="SK하이닉스", entry=190000, target=230000, stop=180000,
                   now=timezone.now() - timedelta(days=4))  # 매수 유의 + 기한 지남
    engine.HALT_FILE.touch()
    p = api.get(f"/api/recommendations/{rec.id}/preview?budgetKrw=1000").json()
    assert p["reasonCodes"] == ["warning_stock", "budget_too_small", "expired", "halted"]
    assert len(p["reasons"]) == len(p["reasonCodes"]) and not p["activatable"]
    body = activate(api, rec, budgetKrw=1000)
    assert body.status_code == 400 and body.json()["reasonCodes"] == p["reasonCodes"]
    assert body.json()["detail"].split("; ") == p["reasons"]


def test_reason_pairs_are_deduplicated_in_order(fake, user, monkeypatch):
    """같은 (코드, 문장) 짝은 한 번만 — 두 목록이 같은 길이·같은 순서로 남는다."""
    real = risk.assess_budget

    def doubled(scenario, ctx, budget, fractional=False):
        a = real(scenario, ctx, budget, fractional)
        reasons, codes = ["일일 손실 한도 도달"] * 2 + ["손익비 낮음"], ["daily_loss_limit"] * 2 + ["reward_risk_low"]
        return a.__class__(**{**a.__dict__, "approved": False, "reasons": reasons, "codes": codes})
    monkeypatch.setattr(risk, "assess_budget", doubled)
    p = risk.preview(make_rec(), user)
    assert p["reasonCodes"] == ["daily_loss_limit", "reward_risk_low"] and p["reasons"] == ["일일 손실 한도 도달", "손익비 낮음"]


def test_activation_rechecks_intraday_price_without_numbers(api, fake, monkeypatch):
    """종가로는 통과해도 정규장 중 장중 확인 가격이 이미 목표가 이상이면 활성화하지 않는다 (문장에 장중 가격 숫자 없음).
    활성화는 장중 확인 가격(확인 가격)으로 본다 — 미리 보기의 현재가가 아니다."""
    rec = make_rec()
    set_price(fake, "005930", 79900)  # 종가 79,624원·현재가 79,900원 < 목표가 80,000원 ≤ 장중 확인 가격 80,100원
    monkeypatch.setattr(fake, "confirmed_prices", lambda symbols: {s: 80100.0 for s in symbols})
    assert api.get(f"/api/recommendations/{rec.id}/preview").json()["activatable"]
    body = activate(api, rec)
    assert body.status_code == 400
    assert body.json() == {"detail": "장중 가격이 이미 목표가 이상이에요", "reasonCodes": ["price_passed"]}
    assert not TradePlan.objects.exists()
    switch(fake, KR=False)  # 정규장 밖이면 장중 확인은 없다 (종가 기준 판단만)
    assert activate(api, rec).status_code == 201


def test_activation_intraday_below_stop(fake, user, monkeypatch):
    rec = make_rec()
    monkeypatch.setattr(risk, "_live_price", lambda symbol: 65000.0)
    with pytest.raises(executor.Blocked) as caught:
        executor.activate(rec, user, BUDGET_KRW)
    assert caught.value.reasons == ["장중 가격이 이미 손절가 이하예요"] and caught.value.codes == ["price_passed"]
    assert caught.value.body() == {"detail": "장중 가격이 이미 손절가 이하예요", "reasonCodes": ["price_passed"]}


def test_activation_race_on_live_plan_is_plan_exists(fake, user, monkeypatch):
    """점검과 계획 만들기 사이에 같은 종목 계획이 생기면 (유일 제약) plan_exists로 막는다."""
    rec = make_rec()
    plan_in("active", make_rec(), user)
    monkeypatch.setattr(risk, "preview", lambda *a, **kw: PASSED)
    with pytest.raises(executor.Blocked) as caught:
        executor.activate(rec, user, BUDGET_KRW)
    assert caught.value.codes == ["plan_exists"] and caught.value.reasons == [risk.PLAN_EXISTS]


PASSED = {"activatable": True, "quantity": 1, "limitedBy": "내가 정한 금액", "approved": True, "reasons": [],
          "reasonCodes": [], "budgetMode": "amount", "budgetPercent": None, "budgetKrw": 100_000.0}  # 통과한 미리 보기


@pytest.mark.parametrize("body,expected", [({}, False), ({"acknowledged": True}, True), ({"acknowledged": False}, False)])
def test_acknowledged_is_recorded(api, fake, body, expected):
    plan = activate(api, make_rec(), **body).json()
    assert plan["events"][0]["kind"] == "activated" and plan["events"][0]["details"]["acknowledged"] is expected


@pytest.mark.parametrize("bad", ["yes", 1, None, [True]])
def test_acknowledged_must_be_boolean(api, fake, bad):
    body = activate(api, make_rec(), acknowledged=bad)
    assert body.status_code == 400 and set(body.json()) == {"detail"} and "acknowledged" in body.json()["detail"]
    assert not TradePlan.objects.exists()


def test_evaluate_shape_matches_preview(fake, user):
    rec = make_rec()
    direct = risk.evaluate(user, symbol=rec.symbol, name=rec.name, market=rec.market, currency=rec.currency,
                           entry=rec.entry_price, target=rec.target_price, stop=rec.stop_price,
                           holding_days=rec.holding_days, probability=rec.probability)
    assert direct == risk.preview(rec, user)
    assert {"reasonCodes", "lastPrice", "lastPriceAsOf", "priceBasis"} <= set(direct)


def test_requeue_evaluates_intraday_equity(api, clock, user, monkeypatch):
    """재주문 점검의 자산은 보유를 장중 가격으로 평가한 값이다 (docs/API.md "재주문의 계산은 지금처럼 장중 확인 가격").
    미리 보기·활성화는 그대로 장마감 기준(종가) 자산이다. 수량은 자산과 무관하게 그 계획과 같다 (2026-10-11)."""
    clock("2026-09-21T10:00:00")  # 전 거래일 정규장 중에 산 보유 — 기준 종가보다 먼저 체결돼 종가로 평가된다 (오늘 산 것은 체결가, DECISIONS 23장)
    held = api.post("/api/orders", {"symbol": "000660", "quantity": 20, "orderType": "MARKET", "style": "long"},
                    format="json")
    assert held.status_code == 201 and held.json()["order"]["status"] == "EXIT_WATCHING", held.json()
    clock("2026-09-22T10:00:00")  # 국내 정규장 중
    rec = make_rec()
    plan = plan_in("entry_pending", rec, user)
    cash = account_for(user).cash_krw
    intraday = {"000660": 100_000.0}  # 장중에 크게 떨어짐 (종가 = 어제 봉은 그대로)
    client = clock.client
    monkeypatch.setattr(client, "prices", lambda symbols: [
        {"symbol": s, "lastPrice": f"{intraday.get(s, client.price[s]):g}"} for s in symbols if s in client.price])
    monkeypatch.setattr(client, "confirmed_prices", lambda symbols: {
        s: intraday.get(s, client.price[s]) for s in symbols if s in client.price})
    clock("2026-09-22T10:05:00")  # 몇 분 뒤 (매수 점검이 받아 둔 현재가 1초 캐시는 지났다)
    shown = risk.preview(rec, user, BUDGET_KRW)  # 미리 보기: 종가 기준
    requeue = risk.preview(rec, user, plan=plan)  # 재주문 점검: 장중 평가
    assert shown["equityKrw"] == pytest.approx(cash + 20 * close_of(200_000))
    assert requeue["equityKrw"] == pytest.approx(cash + 20 * 100_000)
    assert requeue["activatable"] and requeue["quantity"] == plan.quantity == 10 and shown["quantity"] == 25
    assert requeue["budgetMode"] is None and requeue["limitedBy"] == "내가 정한 금액"
    assert requeue["priceBasis"] == "close" and requeue["lastPrice"] == close_of(70000)  # 표시 값은 그대로 종가
