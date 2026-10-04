"""단타 계획을 실제 autotrade·trading·엔진 코드로 끝까지: 미리 보기(DAY 한도, 장마감 기준) → 만들기(추천 source day + 활성화 +
style day 진입 지정가 주문, 장중 확인) → 같은 종목 다시 만들기 거절(아무것도 더 만들지 않음) → 목록·상태 →
엔진 루프(체결 확인 · 자동매매)의 체결과 15:15 정리(EOD·단타 진입 마감) → 복기.
"""
import math

import pytest
from autotrade import executor
from autotrade.models import Recommendation, TradePlan
from trading import service as trading
from trading.models import PaperOrder
from trading.store import account_for

from daytrade.service import SUMMARY

from .conftest import at


pytestmark = pytest.mark.django_db

BODY = {"symbol": "005930", "entryPrice": 69000, "targetPrice": 80000, "stopPrice": 66000}
# DAY 건당 위험 0.5% × 자산 1천만 ÷ 1주 손실(진입 수수료 포함 − 손절 1% 미끄러짐·매도 비용 반영)
DAY_QUANTITY = math.floor(10_000_000 * 0.005 / (69000 * 1.001 - 66000 * 0.99 * (1 - 0.001 - 0.002)))


def test_preview_uses_day_limits_and_close_price(api, unlocked, clock):
    body = api.post("/api/day/preview", BODY, format="json")
    assert body.status_code == 200, body.json()
    p = body.json()
    assert p["approved"] and p["activatable"] and p["reasons"] == [] and p["reasonCodes"] == []
    assert p["quantity"] == DAY_QUANTITY == 12
    assert p["priceBasis"] == "close" and p["lastPrice"] == pytest.approx(69300)  # 21일 종가 (22일 10:00 기준)
    assert p["lastPriceAsOf"] == "2026-09-21T15:30:00+09:00"
    assert p["costsAtTarget"]["totalKrw"] == pytest.approx((69000 + 80000) * 12 * 0.001 + 80000 * 12 * 0.002)


def test_create_activates_a_day_plan_with_a_day_order(api, user, unlocked, clock):
    body = api.post("/api/day/plans", BODY | {"acknowledged": True}, format="json")
    assert body.status_code == 201, body.json()
    plan = body.json()
    assert plan["status"] == "entry_pending" and plan["quantity"] == DAY_QUANTITY and plan["source"] == "day"
    assert plan["entryDeadline"] == "2026-09-22T15:15:00+09:00"
    assert [e["kind"] for e in plan["events"]][:3] == ["activated", "risk_checked", "order_placed"]
    assert plan["events"][0]["details"]["acknowledged"] is True
    rec = Recommendation.objects.get()
    assert rec.source == Recommendation.DAY and rec.horizon == "DAY" and rec.requested_by == user
    assert rec.valid_until == at("2026-09-22T15:15") and rec.holding_days == 1 and rec.summary == SUMMARY
    assert rec.probability == 0.5 and rec.probability_assumed
    order = PaperOrder.objects.get(pk=plan["orderId"])
    assert order.style == "day" and order.expire_date is None and order.requested_by == f"plan:{plan['id']}"
    assert (order.limit_price, order.target_price, order.stop_price) == (69000, 80000, 66000)

    again = api.post("/api/day/plans", BODY | {"acknowledged": True}, format="json")
    assert again.status_code == 400 and "plan_exists" in again.json()["reasonCodes"]
    assert Recommendation.objects.count() == 1 and TradePlan.objects.count() == 1

    listed = api.get("/api/day/plans").json()
    assert [p["id"] for p in listed["results"]] == [plan["id"]]
    assert api.get("/api/day/status").json()["today"]["orders"] == 1
    review = api.get("/api/day/review?date=2026-09-22").json()
    assert [i["plan"]["id"] for i in review["plans"]] == [plan["id"]] and review["plans"][0]["entryAt"] is None


def test_closed_session_makes_nothing(api, unlocked, clock):
    clock("2026-09-22T15:16")
    body = api.post("/api/day/plans", BODY | {"acknowledged": True}, format="json")
    assert body.status_code == 400 and "day_entry_closed" in body.json()["reasonCodes"]
    assert not Recommendation.objects.exists() and not TradePlan.objects.exists()


def test_live_price_past_target_blocks_creation_but_not_preview(api, unlocked, clock):
    clock.client.price["005930"] = 80_500  # 장중 80,500 ≥ 목표가, 21일 종가 79,695 < 목표가
    clock("2026-09-22T10:00")
    p = api.post("/api/day/preview", BODY, format="json").json()
    assert p["activatable"] and p["lastPrice"] == pytest.approx(79_695)
    body = api.post("/api/day/plans", BODY | {"acknowledged": True}, format="json")
    assert body.status_code == 400 and body.json()["reasonCodes"] == ["price_passed"]
    assert "80,500" not in body.json()["detail"]  # 장중 가격 숫자는 문장에 넣지 않는다
    assert not Recommendation.objects.exists() and not TradePlan.objects.exists()


def test_daily_trade_limit_counts_day_orders_only(api, user, unlocked, clock):
    for i in range(10):
        PaperOrder.objects.create(
            account=account_for(user), requested_by=f"plan:{100 + i}", symbol="000660", name="SK하이닉스",
            market="KR", currency="KRW", order_type="LIMIT", limit_price=190000, quantity=1, entry_price=190000,
            status="CANCELED", created_at=at("2026-09-22T09:00"), style="day" if i < 9 else "swing")
    assert "daily_trades_limit" not in api.post("/api/day/preview", BODY, format="json").json()["reasonCodes"]
    PaperOrder.objects.filter(style="swing").update(style="day")
    p = api.post("/api/day/preview", BODY, format="json").json()
    assert "daily_trades_limit" in p["reasonCodes"] and not p["activatable"]
    assert api.get("/api/day/status").json()["today"]["orders"] == 10


def _loop(now) -> None:
    """엔진 루프 한 바퀴의 체결 확인 + 자동매매 (run_engine 순서)."""
    trading.sync_accounts(now, lambda text: None)
    executor.tick(now, lambda text: None)


def test_a_day_fill_then_eod_close_is_reviewed(api, unlocked, clock):
    plan = api.post("/api/day/plans", BODY | {"acknowledged": True}, format="json").json()
    clock.client.price["005930"] = 68_900  # 지정가 69,000 이하 → 체결
    _loop(clock("2026-09-22T10:30"))
    assert TradePlan.objects.get(pk=plan["id"]).status == TradePlan.HOLDING
    clock.client.price["005930"] = 69_500  # 목표·손절 사이 → 15:15 장 마감 전 정리
    _loop(clock("2026-09-22T15:16"))
    closed = TradePlan.objects.get(pk=plan["id"])
    assert closed.status == TradePlan.CLOSED and closed.exit_reason == "EOD" and closed.exit_price == 69_500

    clock("2026-09-22T16:00")
    r = api.get("/api/day/review").json()  # 기준일 = 오늘 (15:40 이후)
    assert r["date"] == "2026-09-22"
    [item] = r["plans"]
    q = DAY_QUANTITY
    assert item["entryAt"] == "2026-09-22T10:30:00+09:00" and item["entryPrice"] == 68_900
    assert item["exitAt"] == "2026-09-22T15:16:00+09:00" and item["exitPrice"] == 69_500 and item["exitReason"] == "EOD"
    costs = 68_900 * q * 0.001 + 69_500 * q * 0.001 + 69_500 * q * 0.002
    assert item["costsKrw"] == pytest.approx(costs)
    assert item["pnlKrw"] == pytest.approx((69_500 - 68_900) * q - costs)
    assert r["totals"] == {"filled": 1, "wins": 1, "losses": 0, "pnlKrw": pytest.approx(item["pnlKrw"]),
                           "costsKrw": pytest.approx(costs)}


def test_unfilled_day_order_is_cancelled_at_cutoff_and_plan_expires(api, unlocked, clock):
    plan = api.post("/api/day/plans", BODY | {"acknowledged": True}, format="json").json()  # 70,000 > 지정가
    _loop(clock("2026-09-22T15:15"))
    expired = TradePlan.objects.get(pk=plan["id"])
    assert expired.status == TradePlan.EXPIRED
    assert PaperOrder.objects.get(pk=plan["orderId"]).note == "단타 진입 마감"
    r = api.get("/api/day/review?date=2026-09-22").json()
    assert r["plans"][0]["entryAt"] is None and r["totals"]["filled"] == 0 and r["totals"]["costsKrw"] == 0
