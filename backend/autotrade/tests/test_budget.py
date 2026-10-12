"""넣을 돈은 사용자가 정한다 (2026-10-11, docs/API.md "넣을 돈"·RiskPreview·TradePlan, DECISIONS 28장).

budgetPercent(매수 가능 금액의 %, 원 단위로 내림) 또는 budgetKrw(원) — 활성화는 하나가 필수, 미리 보기는 없어도 된다.
수량 = 금액 ÷ 1주 매수 비용(진입가 × (1 + 수수료) × 환율). 한도(매수 가능 금액·총 금액 한도)는 줄이지 않고 막는다.
건당 위험 1%는 수량을 정하지 않고 큰 손실 경고(largeLoss)만 낸다. 가짜 계좌: 현금 1천만원, 수수료 국내 0.1%·미국 0.2%, 환율 1,400원.
"""
from dataclasses import replace

import pytest
from django.utils import timezone
from trading.models import PaperAccount
from trading.store import account_for
from trading.tests.conftest import CFG

from autotrade.plans import executor, risk
from autotrade import views
from autotrade.models import PlanEvent, TradePlan
from config import engine
from config.api import Rejected

from .conftest import make_rec
from .test_plans import LOSS_PER_SHARE, day_end, plan_in

pytestmark = pytest.mark.django_db

UNIT = 69000 * 1.001  # make_rec() 1주 매수 비용 (원)


def preview(api, rec, query: str = "") -> dict:
    body = api.get(f"/api/recommendations/{rec.id}/preview{query}")
    assert body.status_code == 200, body.json()
    return body.json()


def post(api, rec, body: dict):
    return api.post(f"/api/recommendations/{rec.id}/activate", body, format="json")


def set_cash(user, cash: float) -> None:
    PaperAccount.objects.filter(pk=account_for(user).pk).update(cash_krw=cash)


def total_limit(monkeypatch, limit: float) -> None:
    monkeypatch.setattr(engine, "engine_config", lambda: replace(CFG, max_total_invest_krw=limit))


# --- 입력 ---

def test_activation_needs_budget(api, fake, user):
    rec = make_rec()
    for body in ({}, {"budgetKrw": None}, {"budgetPercent": ""}, {"acknowledged": True}):
        r = post(api, rec, body)
        assert r.status_code == 400 and r.json() == {"detail": "투자 금액을 정해 주세요 (budgetPercent 또는 budgetKrw)."}
    assert not TradePlan.objects.exists()
    with pytest.raises(Rejected) as caught:
        executor.activate(rec, user)
    assert str(caught.value.detail) == executor.NO_BUDGET
    assert preview(api, rec)["quantity"] == 0  # 미리 보기는 없어도 된다


def test_both_budgets_is_400(api, fake):
    rec = make_rec()
    r = api.get(f"/api/recommendations/{rec.id}/preview?budgetPercent=25&budgetKrw=700000")
    assert r.status_code == 400 and r.json() == {"detail": views.BOTH_BUDGETS}
    r = post(api, rec, {"budgetPercent": 25, "budgetKrw": 700000})
    assert r.status_code == 400 and r.json() == {"detail": "budgetPercent와 budgetKrw 중 하나만 보냅니다."}
    assert not TradePlan.objects.exists()


@pytest.mark.parametrize("bad", [0, 101, -1, 2.5, True, False, "abc", "2.5", [25], {"value": 25}])
def test_bad_percent_is_400(api, fake, bad):
    rec = make_rec()
    r = post(api, rec, {"budgetPercent": bad})
    assert r.status_code == 400 and r.json() == {"detail": views.BAD_PERCENT}
    assert not TradePlan.objects.exists()


@pytest.mark.parametrize("bad", [float("inf"), float("nan"), 100.5, "", None])
def test_percent_parser_edges(bad):
    if bad in ("", None):
        assert views._percent(bad) is None  # 없음
    else:
        with pytest.raises(Rejected):
            views._percent(bad)


@pytest.mark.parametrize("bad", ["0", "101", "2.5", "abc", "true", "-5", "9" * 5000])
def test_bad_percent_query_is_400(api, fake, bad):
    rec = make_rec()
    r = api.get(f"/api/recommendations/{rec.id}/preview?budgetPercent={bad}")
    assert r.status_code == 400 and set(r.json()) == {"detail"}


def test_percent_accepts_integer_forms(api, fake):
    rec = make_rec()
    assert preview(api, rec, "?budgetPercent=25")["budgetPercent"] == 25  # 쿼리 문자열
    assert views._percent(25.0) == 25 and views._percent(" 7 ") == 7 and views._percent(100) == 100
    plan = post(api, rec, {"budgetPercent": 25.0}).json()  # 정수 값인 실수
    assert plan["budgetMode"] == "percent" and plan["budgetPercent"] == 25


# --- % → 원 · 수량 ---

def test_percent_is_converted_from_buying_power_with_floor(api, fake, user):
    set_cash(user, 9_999_999)
    rec = make_rec()
    p = preview(api, rec, "?budgetPercent=25")
    assert p["buyingPowerKrw"] == 9_999_999 and p["budgetKrw"] == 2_499_999  # floor(9,999,999 × 25 / 100)
    assert (p["budgetMode"], p["budgetPercent"]) == ("percent", 25)
    assert p["quantity"] == 36 and p["limitedBy"] == "내가 정한 금액"  # 2,499,999 ÷ 69,069
    assert p["amountKrw"] == pytest.approx(36 * 69000) and p["activatable"]


def test_percent_uses_buying_power_after_pending_buys(api, fake, user):
    """기준은 매수 가능 금액 = 현금 − 대기 매수 금액 (AccountSummary.buyingPowerKrw와 같다)."""
    post(api, make_rec(symbol="005935", name="삼성전자우", entry=59000, target=70000, stop=56000), {"budgetKrw": 1_000_000})
    summary = api.get("/api/account").json()
    p = preview(api, make_rec(), "?budgetPercent=50")
    assert p["buyingPowerKrw"] == summary["buyingPowerKrw"] < 10_000_000
    assert p["budgetKrw"] == float(int(summary["buyingPowerKrw"] * 50 / 100))


def test_percent_of_negative_buying_power_is_zero(api, fake, user):
    set_cash(user, -100)
    p = preview(api, make_rec(), "?budgetPercent=50")
    assert p["buyingPowerKrw"] == 0 and p["budgetKrw"] == 0
    assert p["reasonCodes"][-1] == "budget_too_small"  # 자산이 0 이하라 일일 손실 한도도 걸린다


def test_hundred_percent_fits_cash(api, fake):
    rec = make_rec()
    p = preview(api, rec, "?budgetPercent=100")
    assert p["activatable"] and p["quantity"] == 144  # 10,000,000 ÷ 69,069 — 건당 위험 한도로 줄이지 않는다
    assert p["largeLoss"] is True and p["maxLossRate"] == pytest.approx(144 * LOSS_PER_SHARE / 10_000_000)
    plan = post(api, rec, {"budgetPercent": 100}).json()
    assert plan["quantity"] == 144 and plan["budgetKrw"] == 10_000_000


@pytest.mark.parametrize("body,query", [({"budgetKrw": 700000}, "?budgetKrw=700000"),
                                        ({"budgetPercent": 30}, "?budgetPercent=30"),
                                        ({"budgetKrw": 5_000_000}, "?budgetKrw=5000000")])
def test_preview_quantity_is_activation_quantity(api, fake, body, query):
    rec = make_rec()
    shown = preview(api, rec, query)
    plan = post(api, rec, body).json()
    assert plan["quantity"] == shown["quantity"] and plan["budgetKrw"] == shown["budgetKrw"]
    checked = plan["events"][1]
    assert checked["kind"] == "risk_checked" and checked["details"]["quantity"] == shown["quantity"]


def test_us_preview_quantity_is_activation_quantity(api, fake):
    rec = make_rec(symbol="AAPL", name="Apple", market_="US", entry=190, target=230, stop=180, price_at_creation=200)
    shown = preview(api, rec, "?budgetKrw=600000")
    # $428.57… ÷ 1.002를 센트로 내린 $427.71, 수량 = $427.71 ÷ $190 (소수점 — 정수 주로 내리지 않는다)
    assert shown["quantity"] == pytest.approx(427.71 / 190) and shown["amountKrw"] == pytest.approx(427.71 * 1400)
    plan = post(api, rec, {"budgetKrw": 600000}).json()
    assert plan["status"] in ("entry_pending", "holding") and plan["quantity"] == shown["quantity"]


# --- 한도는 막기만 한다 ---

def test_cash_short_blocks_without_shrinking(api, fake):
    rec = make_rec()
    p = preview(api, rec, "?budgetKrw=20000000")
    assert not p["activatable"] and p["reasonCodes"] == ["cash_short"]
    assert p["quantity"] == 289 and p["amountKrw"] == pytest.approx(289 * 69000)  # 20,000,000 ÷ 69,069 — 줄이지 않는다
    assert p["reasons"] == [f"매수 금액 {289 * UNIT:,.0f}이 매수 가능 금액 10,000,000보다 큼"]
    r = post(api, rec, {"budgetKrw": 20_000_000})
    assert r.status_code == 400 and r.json()["reasonCodes"] == ["cash_short"]
    assert not TradePlan.objects.exists()


def test_total_limit_blocks_without_shrinking(api, fake, monkeypatch):
    total_limit(monkeypatch, 1_000_000)
    rec = make_rec()
    p = preview(api, rec, "?budgetKrw=1500000")
    assert not p["activatable"] and p["reasonCodes"] == ["total_limit"] and p["quantity"] == 21
    assert p["reasons"] == ["총 금액 한도 1,000,000원을 넘음 (남은 한도 1,000,000원)"]
    r = post(api, rec, {"budgetKrw": 1_500_000})
    assert r.status_code == 400 and r.json()["reasonCodes"] == ["total_limit"]
    assert preview(api, rec, "?budgetKrw=900000")["activatable"]  # 13주 = 897,897원


def test_budget_too_small_kr(api, fake, user):
    rec = make_rec()
    p = preview(api, rec, "?budgetKrw=50000")
    assert p["reasonCodes"] == ["budget_too_small"] and p["quantity"] == 0 and p["amountKrw"] == 0
    assert p["reasons"] == ["내가 정한 금액(50,000원)으로는 1주도 살 수 없음"]
    set_cash(user, 5_000_000)
    p = preview(api, rec, "?budgetPercent=1")  # 50,000원
    assert p["budgetKrw"] == 50_000 and p["reasonCodes"] == ["budget_too_small"]
    r = post(api, rec, {"budgetPercent": 1})
    assert r.status_code == 400 and r.json()["reasonCodes"] == ["budget_too_small"]


# --- 큰 손실 경고 ---

def test_large_loss_warns_without_blocking(api, fake):
    rec = make_rec()
    small = preview(api, rec, "?budgetKrw=700000")
    assert small["largeLoss"] is False and small["maxLossRate"] == pytest.approx(10 * LOSS_PER_SHARE / 10_000_000)
    big = preview(api, rec, "?budgetKrw=5000000")  # 72주 × 1주 손실 약 3,925원 > 자산의 1%
    assert big["quantity"] == 72 and big["activatable"] and big["largeLoss"] is True
    assert big["maxLossKrw"] == pytest.approx(72 * LOSS_PER_SHARE)
    assert big["maxLossRate"] == pytest.approx(72 * LOSS_PER_SHARE / 10_000_000)


def test_max_loss_rate_is_none_when_equity_is_not_positive(api, fake, monkeypatch):
    real = risk.service.summary
    monkeypatch.setattr(risk.service, "summary", lambda account, now: real(account, now) | {"equityKrw": 0.0})
    p = preview(api, make_rec(), "?budgetKrw=700000")
    assert p["equityKrw"] == 0 and p["maxLossRate"] is None and p["largeLoss"] is True


# --- 계획 · 사건 ---

def test_activated_event_and_plan_record_percent(api, fake):
    rec = make_rec()
    plan = post(api, rec, {"budgetPercent": 25, "acknowledged": True}).json()
    assert (plan["budgetMode"], plan["budgetPercent"], plan["budgetKrw"], plan["quantity"]) == ("percent", 25, 2_500_000, 36)
    activated, checked = plan["events"][:2]
    assert activated["details"] == {"via": "web", "budgetMode": "percent", "budgetPercent": 25, "budgetKrw": 2_500_000,
                                    "acknowledged": True}
    assert checked["message"] == (f"리스크 엔진 점검 통과: 내가 정한 금액(매수 가능 금액의 25%) 2,500,000원으로 36주 "
                                  f"(손익비 {rec.reward_risk:.2f})")
    assert set(checked["details"]) == {"approved", "quantity", "limitedBy", "rewardRisk", "reasons"}
    assert checked["details"]["limitedBy"] == "내가 정한 금액"
    stored = TradePlan.objects.get(pk=plan["id"])
    assert (stored.budget_mode, stored.budget_percent, stored.budget_krw) == ("percent", 25, 2_500_000)


def test_plan_payload_budget_fields(api, fake, user):
    new = post(api, make_rec(), {"budgetKrw": 700000}).json()
    old = plan_in("cancelled", make_rec(symbol="005935", name="삼성전자우", entry=59000, target=70000, stop=56000), user)
    plans = {p["id"]: p for p in api.get("/api/trade-plans?status=all").json()["results"]}
    assert (plans[new["id"]]["budgetMode"], plans[new["id"]]["budgetPercent"]) == ("amount", None)
    assert (plans[old.id]["budgetMode"], plans[old.id]["budgetPercent"], plans[old.id]["budgetKrw"]) == (None, None, None)
    detail = api.get(f"/api/trade-plans/{new['id']}").json()
    assert detail["budgetMode"] == "amount" and detail["budgetKrw"] == 700000


# --- 재주문: 같은 수량, 한도 안으로 줄이기만 ---

def test_requeue_shrinks_into_total_limit(api, fake, monkeypatch):
    total_limit(monkeypatch, 1_000_000)
    plan = TradePlan.objects.get(pk=post(api, make_rec(), {"budgetKrw": 700000}).json()["id"])
    assert plan.quantity == 10
    day_end(plan, fake)
    total_limit(monkeypatch, 500_000)  # 남은 한도 500,000원 → 7주 (막지 않고 줄인다)
    executor.step(plan, timezone.now())
    plan.refresh_from_db()
    assert plan.status == "entry_pending" and plan.quantity == 7
    event = PlanEvent.objects.get(plan=plan, kind="order_requeued")
    assert event.details["quantity"] == 7 and event.details["previousQuantity"] == 10


def test_requeue_preview_ignores_budget_arguments(fake, user):
    """재주문 점검의 금액은 그 계획과 같은 수량으로 정한다 (사용자 금액·% 인자를 쓰지 않는다)."""
    rec = make_rec()
    plan = plan_in("entry_pending", rec, user)  # 10주, 금액 기록 없음
    p = risk.preview(rec, user, 1_000, plan=plan, budget_percent=None)
    assert p["activatable"] and p["quantity"] == 10 and p["budgetMode"] is None
    assert p["budgetKrw"] == pytest.approx(10 * UNIT)
