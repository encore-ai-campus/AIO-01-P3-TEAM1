"""단타 연습 계획 (horizon DAY — docs/API.md "단타 연습"): 리스크 점검·잠금·진입 시각, style day 주문(기한 없음),
재주문 없음, "단타 진입 마감" 취소 → expired, EOD 청산 → closed, 웹만 알림, 단타 추천은 만든 사람만.

지금 시각은 clock fixture로 고정한다 (기본 2026-09-22(화) 10:00 KST, 국내 정규장 중). 엔진의 15:15 정리 자체는 엔진 테스트 몫이라
여기서는 그 결과(주문 note·exit_reason)를 주문 행에 바로 써서 계획이 따라가는지 본다.
"""
from datetime import datetime, timedelta

import pytest
from accounts.models import InvestorProfile
from django.utils import timezone
from trading.models import PaperOrder
from trading.store import AccountStore

from autotrade import executor, risk, sources
from autotrade.models import PlanEvent, Recommendation, TradePlan

from .conftest import KST, close_of, login

pytestmark = pytest.mark.django_db

PREVIEW_KEYS = {"approved", "activatable", "reasons", "reasonCodes", "quantity", "amountKrw", "expectedProfitKrw",
                "maxLossKrw", "limitedBy", "budgetKrw", "lastPrice", "lastPriceAsOf", "priceBasis"}


def unlock(user, now=None):
    InvestorProfile.objects.create(user=user, beginner_mode=False, day_quiz_passed_at=now or timezone.now())


def cutoff(now: datetime) -> datetime:
    return now.astimezone(KST).replace(hour=15, minute=15, second=0, microsecond=0)


def day_rec(user, entry=69000, target=80000, stop=66000, **kw) -> Recommendation:
    """backend/daytrade가 부르는 모양 그대로 (source day, horizon DAY, 그날 15:15까지, 알리지 않음)."""
    return sources.create(Recommendation.DAY, symbol="005930", name="삼성전자", market_="KR", entry=entry, target=target,
                          stop=stop, holding_days=1, summary="단타 연습 계획 (직접 입력, AI 아님)", requested_by=user,
                          horizon="DAY", valid_until=cutoff(timezone.now()), announce=False, **kw)


def evaluate(user, **kw):
    values = dict(symbol="005930", name="삼성전자", market="KR", currency="KRW", entry=69000, target=80000, stop=66000,
                  holding_days=1, horizon="DAY")
    return risk.evaluate(user, **(values | kw))


# --- 리스크 점검 (evaluate) ---

def test_evaluate_day_uses_day_limits_and_close_basis(clock, user):
    unlock(user)
    p = evaluate(user)
    assert set(p) == PREVIEW_KEYS and p["activatable"] and p["reasonCodes"] == [] and p["priceBasis"] == "close"
    loss = 69000 * 1.001 - 66000 * 0.99 * 0.997
    assert p["quantity"] == int(10_000_000 * 0.005 // loss) == 12  # 건당 위험 0.5% (SWING은 1%)
    assert p["lastPrice"] == close_of(70000) and p["lastPriceAsOf"] == "2026-09-21T15:30:00+09:00"
    swing = evaluate(user, horizon="SWING", holding_days=10)
    assert swing["quantity"] == 25


def test_evaluate_day_lock_and_entry_window(clock, user):
    p = evaluate(user)  # 프로필 행이 없으면 주린이모드 켬 + 퀴즈 미통과 → 잠김
    assert not p["activatable"] and p["reasonCodes"] == ["day_trading_locked"]
    unlock(user)
    clock("2026-09-22T15:14:59")
    assert evaluate(user)["activatable"]
    for closed in ("2026-09-22T15:15:00", "2026-09-26T10:00:00", "2026-10-09T10:00:00"):  # 15:15 이후 · 토요일 · 한글날
        clock(closed)
        p = evaluate(user)
        assert p["reasonCodes"] == ["day_entry_closed"] and not p["activatable"], closed
    clock("2026-09-23T00:00:00")  # 국내 거래일 0시부터 (장 전 계획)
    assert evaluate(user)["activatable"]


def test_day_trade_limits_count_only_their_own_style(clock, user, monkeypatch):
    unlock(user)
    seen = []

    def paper_today(self, day, style=None):
        seen.append((day, style))
        return 10, 0.0
    monkeypatch.setattr(AccountStore, "paper_today", paper_today)
    assert evaluate(user)["reasonCodes"] == ["daily_trades_limit"]  # 하루 단타 주문 10건
    assert evaluate(user, horizon="SWING", holding_days=10)["activatable"]  # 스윙에는 건수 한도가 없다
    assert seen == [("2026-09-22", "day"), ("2026-09-22", "swing")]


# --- 단타 추천·계획 ---

def test_day_recommendation_is_silent_and_activates_as_day_order(clock, user, sent):
    unlock(user)
    rec = day_rec(user)
    assert rec.horizon == "DAY" and rec.valid_until == cutoff(clock.client.now) and rec.price_at_creation == close_of(70000)
    assert sent.calls == []  # 단타 추천은 알리지 않는다
    plan = executor.activate(rec, user, None, "web", acknowledged=True)
    assert plan.horizon == "DAY" and plan.status == "entry_pending" and plan.quantity == 12
    assert plan.entry_deadline == rec.valid_until
    order = PaperOrder.objects.get(pk=plan.order_id)
    assert order.style == "day" and order.expire_date is None and order.limit_price == 69000
    assert PlanEvent.objects.get(plan=plan, kind="activated").details == {"via": "web", "budgetKrw": None,
                                                                         "acknowledged": True}
    assert sent.kinds == ["plan_activated", "order_placed"]
    assert all(call["discord"] is False for call in sent.calls)  # 단타 계획 알림은 웹만
    assert "15:15" in sent.calls[0]["body"] and "모의" in sent.calls[0]["body"]


@pytest.mark.parametrize("note", [executor.DAY_CUTOFF, executor.DAY_END])
def test_day_entry_cancelled_by_engine_expires_without_requeue(clock, user, sent, note):
    unlock(user)
    plan = executor.activate(day_rec(user), user, None, "web", acknowledged=True)
    PaperOrder.objects.filter(pk=plan.order_id).update(status="CANCELED", note=note, closed_at=timezone.now())
    executor.step(plan, clock("2026-09-22T15:16:00"))
    plan.refresh_from_db()
    assert plan.status == "expired" and plan.failure_reason == "단타 진입 마감까지 지정가에 체결되지 않음"
    assert PaperOrder.objects.filter(requested_by=f"plan:{plan.id}").count() == 1  # 다시 주문하지 않는다
    assert sent.kinds[-1] == "expired" and "단타 진입 마감(15:15)" in sent.calls[-1]["body"]
    assert sent.calls[-1]["discord"] is False


def test_day_entry_cancelled_before_cutoff_still_never_requeues(clock, user):
    unlock(user)
    plan = executor.activate(day_rec(user), user, None, "web", acknowledged=True)
    PaperOrder.objects.filter(pk=plan.order_id).update(status="CANCELED", note=executor.DAY_END)
    executor.step(plan, timezone.now())  # 기한(15:15) 전이어도 단타는 다시 주문하지 않는다
    plan.refresh_from_db()
    assert plan.status == "expired" and not PlanEvent.objects.filter(plan=plan, kind="order_requeued").exists()


def test_day_holding_closed_eod(clock, user, sent):
    unlock(user)
    plan = executor.activate(day_rec(user, entry=70000, target=82000, stop=67000), user, None, "web", acknowledged=True)
    assert plan.status == "holding"  # 지정가 = 지금 가격 → 바로 체결
    now = clock("2026-09-22T15:15:30")
    PaperOrder.objects.filter(pk=plan.order_id).update(status="CLOSED", exit_reason="EOD", exit_price=70100,
                                                       closed_at=now, pnl_krw=-1500.0)
    executor.step(plan, now)
    plan.refresh_from_db()
    assert plan.status == "closed" and plan.exit_reason == "EOD" and plan.exit_price == 70100
    event = PlanEvent.objects.get(plan=plan, kind="closed")
    assert event.message == "삼성전자 70,100원에 청산 (장 마감 전 정리) · 실현 손익 -1,500원"
    call = sent.calls[-1]
    assert call["kind"] == "closed" and call["discord"] is False and call["expert_title"] == "삼성전자 청산 · 장 마감 전 정리"
    assert call["body"].startswith("단타 연습이라 장 마감 전에 모의 계좌에서")


def test_day_activation_after_cutoff_is_blocked(clock, user):
    unlock(user)
    rec = day_rec(user)
    clock("2026-09-22T15:20:00")
    with pytest.raises(executor.Blocked) as caught:
        executor.activate(rec, user, None, "web", acknowledged=True)
    assert "day_entry_closed" in caught.value.codes and "expired" in caught.value.codes
    assert len(caught.value.codes) == len(caught.value.reasons) and not TradePlan.objects.exists()


def test_create_horizon_valid_until_and_announce(clock, user, sent):
    with pytest.raises(ValueError):
        sources.create(Recommendation.DEMO, symbol="005930", name="삼성전자", market_="KR", entry=69000, target=80000,
                       stop=66000, horizon="LONG")
    until = timezone.now() + timedelta(hours=1)
    quiet = sources.create(Recommendation.DEMO, symbol="005935", name="삼성전자우", market_="KR", entry=59000,
                           target=70000, stop=56000, valid_until=until, announce=False)
    assert quiet.valid_until == until and quiet.horizon == "SWING" and sent.calls == []
    loud = sources.create(Recommendation.DEMO, symbol="005935", name="삼성전자우", market_="KR", entry=59000,
                          target=70000, stop=56000)
    assert loud.valid_until == timezone.now() + timedelta(days=3) and sent.kinds == ["recommendation"]


# --- 단타 추천은 만든 사람만 (API) ---

def test_day_recommendations_are_owner_only(clock, api, user, sent, django_user_model):
    unlock(user)
    mine = day_rec(user)
    team = sources.create(Recommendation.DEMO, symbol="005935", name="삼성전자우", market_="KR", entry=59000,
                          target=70000, stop=56000)
    bob, bob_api = login(django_user_model, "bob")
    assert [r["id"] for r in api.get("/api/recommendations").json()["results"]] == [team.id]  # 팀 목록에 없다
    days = api.get("/api/recommendations?source=day").json()["results"]
    assert [r["id"] for r in days] == [mine.id] and days[0]["horizon"] == "DAY" and days[0]["source"] == "day"
    assert bob_api.get("/api/recommendations?source=day").json()["count"] == 0
    assert bob_api.get(f"/api/recommendations/{mine.id}").status_code == 404
    assert bob_api.get(f"/api/recommendations/{mine.id}/preview").status_code == 404
    assert bob_api.post(f"/api/recommendations/{mine.id}/activate", {}, format="json").status_code == 404
    assert api.get(f"/api/recommendations/{mine.id}").json()["horizon"] == "DAY"
    body = api.post(f"/api/recommendations/{mine.id}/activate", {"acknowledged": True}, format="json")
    assert body.status_code == 400 and "reasonCodes" not in body.json()  # 입력 오류 (만들 때 이미 활성화된다)
    assert not TradePlan.objects.exists() and sent.kinds == ["recommendation"]  # 시연 추천만 알렸다
