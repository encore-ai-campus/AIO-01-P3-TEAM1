"""GET /api/day/status — 잠금 · 세션 · DAY 한도 · 오늘 쓴 양 (style day 주문만, KST 날짜)."""
import pytest
from rest_framework.test import APIClient
from trading.models import DAY, SWING, PaperOrder
from trading.store import account_for

from .conftest import at, unlock

pytestmark = pytest.mark.django_db

LIMITS = {"riskPerTrade": 0.005, "maxDailyLoss": 0.02, "maxDailyTrades": 10, "minRewardRisk": 2.0}


def order(user, created: str, style: str = DAY, status: str = "CANCELED", closed: str | None = None,
          pnl_krw: float | None = None) -> PaperOrder:
    """체결·현금과 무관한 주문 행 (세기만 볼 때). 시각은 KST."""
    return PaperOrder.objects.create(
        account=account_for(user), requested_by="plan:1", symbol="005930", name="삼성전자", market="KR",
        currency="KRW", order_type="LIMIT", limit_price=69000, quantity=10, entry_price=69000, status=status,
        created_at=at(created), closed_at=at(closed) if closed else None, pnl_krw=pnl_krw, style=style)


def test_locked_by_default(api, clock):
    body = api.get("/api/day/status")
    assert body.status_code == 200, body.json()
    s = body.json()
    assert s["unlocked"] is False and s["lockReasons"] == ["beginner_mode", "quiz_not_passed"]
    assert s["limits"] == LIMITS
    assert s["today"] == {"orders": 0, "lossKrw": 0.0, "lossLimitKrw": pytest.approx(200_000)}  # 1천만 × 2%
    assert s["session"] == {"date": "2026-09-22", "acceptingPlans": True, "opensAt": "2026-09-22T09:00:00+09:00",
                            "entryCutoffAt": "2026-09-22T15:15:00+09:00", "closeAt": "2026-09-22T15:30:00+09:00",
                            "isOpen": True}


def test_unlocked_and_partly_locked(api, user, clock):
    unlock(user)
    s = api.get("/api/day/status").json()
    assert s["unlocked"] is True and s["lockReasons"] == []
    user.investor_profile.beginner_mode = True
    user.investor_profile.save()
    s = api.get("/api/day/status").json()
    assert s["unlocked"] is False and s["lockReasons"] == ["beginner_mode"]


def test_today_counts_only_day_orders_of_the_kst_day(api, user, clock):
    clock("2026-09-22T14:00")
    order(user, "2026-09-22T00:30")  # 22일 00:30 KST = 21일 15:30 UTC — 22일 주문이다
    order(user, "2026-09-22T09:10", status="CLOSED", closed="2026-09-22T10:00", pnl_krw=-30_000)
    order(user, "2026-09-22T09:20", status="CLOSED", closed="2026-09-22T11:00", pnl_krw=12_000)  # 이익은 상계하지 않는다
    order(user, "2026-09-21T23:59")  # 어제(KST)
    order(user, "2026-09-21T10:00", status="CLOSED", closed="2026-09-21T15:20", pnl_krw=-50_000)  # 어제 손실
    order(user, "2026-09-22T09:30", style=SWING, status="CLOSED", closed="2026-09-22T10:30", pnl_krw=-70_000)
    s = api.get("/api/day/status").json()
    assert s["today"]["orders"] == 3 and s["today"]["lossKrw"] == pytest.approx(30_000)


def test_session_after_cutoff_and_on_weekend(api, clock):
    clock("2026-09-22T15:20")
    s = api.get("/api/day/status").json()["session"]
    assert not s["acceptingPlans"] and s["isOpen"] and s["date"] == "2026-09-23"
    clock("2026-09-19T11:00")
    s = api.get("/api/day/status").json()["session"]
    assert not s["acceptingPlans"] and not s["isOpen"] and s["date"] == "2026-09-21"


def test_status_without_calendar_still_answers(api, clock):
    clock.client.calendar_fails = True
    body = api.get("/api/day/status")
    assert body.status_code == 200 and body.json()["session"]["date"] == "2026-09-22"


def test_status_needs_login(clock):
    assert APIClient().get("/api/day/status").status_code == 401
