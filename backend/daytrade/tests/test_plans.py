"""POST·GET /api/day/plans — 만들기 순서(입력 → 실행 확인 → 잠김 → 세션·활성화 점검 → 추천 → 활성화)와
막히면 아무것도 남기지 않는 규칙, 세션별 목록.

autotrade의 리스크 계산·추천 만들기·활성화는 기록기로 바꿔 끼우고 단타 쪽이 무엇을 넘기는지 본다.
실제 autotrade로 끝까지 도는 경우는 test_flow.py.
"""
from datetime import timedelta

import pytest
from autotrade.executor import Blocked
from autotrade.models import Recommendation, TradePlan
from config.api import Rejected, Unavailable

from daytrade.service import ENTRY_CLOSED_TEXT, SUMMARY

from .conftest import at, login, unlock

pytestmark = pytest.mark.django_db

BODY = {"symbol": "005930", "entryPrice": 69000, "targetPrice": 80000, "stopPrice": 66000, "acknowledged": True}


def create(api, **changes):
    body = {**BODY, **changes}
    return api.post("/api/day/plans", {k: v for k, v in body.items() if v is not ...}, format="json")


def nothing_made():
    return not Recommendation.objects.exists() and not TradePlan.objects.exists()


def test_create_makes_day_recommendation_and_activates(api, user, unlocked, clock, fakes):
    now = clock("2026-09-22T08:30")  # 장 전 계획
    body = create(api, budgetKrw=2_000_000)
    assert body.status_code == 201, body.json()
    plan = body.json()
    assert plan["status"] == "entry_pending" and plan["quantity"] == 40 and plan["budgetKrw"] == 2_000_000
    assert plan["entryDeadline"] == "2026-09-22T15:15:00+09:00" and plan["source"] == "day"
    assert plan["recommendation"]["source"] == "day" and plan["recommendation"]["summary"] == SUMMARY
    assert plan["recommendation"]["validUntil"] == "2026-09-22T15:15:00+09:00" and "events" in plan
    [made] = fakes.created
    assert made["source"] == "day" and made["horizon"] == "DAY" and made["announce"] is False
    assert made["valid_until"] == at("2026-09-22T15:15") and made["now"] == now
    assert made["holding_days"] == 1 and made["probability"] is None and made["requested_by"] == user
    assert (made["symbol"], made["name"], made["market_"]) == ("005930", "삼성전자", "KR")
    assert (made["entry"], made["target"], made["stop"]) == (69000, 80000, 66000)
    assert (made["summary"], made["reasons"], made["risks"]) == (SUMMARY, [], [])
    [activated] = fakes.activated
    assert activated["acknowledged"] is True and activated["via"] == "web" and activated["budget_krw"] == 2_000_000
    assert activated["user"] == user and activated["now"] == now
    [checked] = fakes.evaluated
    assert checked["live_check"] is True and checked["horizon"] == "DAY" and checked["budget_krw"] == 2_000_000


def test_valid_until_uses_the_kst_date_near_midnight(api, unlocked, clock, fakes):
    clock("2026-09-22T00:10")  # = 2026-09-21 15:10 UTC
    assert create(api).status_code == 201
    assert fakes.created[0]["valid_until"] == at("2026-09-22T15:15")


@pytest.mark.parametrize("acknowledged", [..., False, "true", 1, None])
def test_acknowledged_must_be_true(api, unlocked, clock, fakes, acknowledged):
    body = create(api, acknowledged=acknowledged)
    assert body.status_code == 400 and set(body.json()) == {"detail"}
    assert "acknowledged" in body.json()["detail"]
    assert fakes.evaluated == [] and nothing_made()


def test_input_errors_come_before_lock(api, clock, fakes):
    body = create(api, symbol="AAPL")  # 잠겨 있어도 입력 오류가 먼저
    assert body.status_code == 400 and set(body.json()) == {"detail"}
    body = create(api, unknown=1)
    assert body.status_code == 400 and set(body.json()) == {"detail"}


@pytest.mark.parametrize("changes", [{"entryPrice": 10**400}, {"targetPrice": 10**400}, {"budgetKrw": 10**400}])
def test_huge_integers_are_400_and_make_nothing(api, unlocked, clock, fakes, changes):
    """float로 바꿀 수 없는 아주 긴 정수는 입력 오류 400 {"detail"} (OverflowError로 500이 되지 않는다)."""
    body = create(api, **changes)
    assert body.status_code == 400 and set(body.json()) == {"detail"}
    assert fakes.evaluated == [] and nothing_made()


def test_locked_is_400_and_makes_nothing(api, clock, fakes):
    body = create(api)
    assert body.status_code == 400 and body.json()["reasonCodes"] == ["day_trading_locked"]
    assert fakes.evaluated == [] and nothing_made()


@pytest.mark.parametrize("now", ["2026-09-22T15:15", "2026-09-22T16:00", "2026-09-19T10:00", "2026-10-09T10:00"])
def test_closed_session_is_400_day_entry_closed(api, unlocked, clock, fakes, now):
    clock(now)
    body = create(api)
    assert body.status_code == 400
    assert body.json() == {"detail": ENTRY_CLOSED_TEXT, "reasonCodes": ["day_entry_closed"]}
    assert nothing_made() and fakes.created == []


def test_risk_reasons_are_400_with_codes_in_order(api, unlocked, clock, fakes):
    clock("2026-09-22T15:20")
    fakes.result |= {"approved": False, "activatable": False, "reasons": ["손익비 낮음", "일일 매매 건수 한도(10건) 도달"],
                     "reasonCodes": ["reward_risk_low", "daily_trades_limit"]}
    body = create(api).json()
    assert body["reasonCodes"] == ["day_entry_closed", "reward_risk_low", "daily_trades_limit"]
    assert body["detail"] == f"{ENTRY_CLOSED_TEXT}; 손익비 낮음; 일일 매매 건수 한도(10건) 도달"
    assert nothing_made()


def test_activation_race_returns_codes_and_removes_recommendation(api, unlocked, clock, fakes):
    fakes.block = Blocked(["같은 종목에 진행 중인 내 계획이 있음"], ["plan_exists"])
    body = create(api)
    assert body.status_code == 400
    assert body.json() == {"detail": "같은 종목에 진행 중인 내 계획이 있음", "reasonCodes": ["plan_exists"]}
    assert len(fakes.created) == 1 and nothing_made()  # 만든 추천을 지운다


def test_activation_plain_rejection_is_detail_only(api, unlocked, clock, fakes):
    fakes.block = Rejected("활성화할 수 없음")
    body = create(api)
    assert body.status_code == 400 and body.json() == {"detail": "활성화할 수 없음"}
    assert nothing_made()


def test_broker_failure_during_activation_is_503_and_removes_recommendation(api, unlocked, clock, fakes):
    fakes.block = Unavailable("증권사 조회 실패")
    assert create(api).status_code == 503
    assert nothing_made()


# --- 목록 ---

def plan_on(user, deadline: str, horizon: str = "DAY", activated: str | None = None) -> TradePlan:
    """그 진입 기한(KST)의 계획 행 하나 (추천도 같이)."""
    rec = Recommendation.objects.create(
        source="day" if horizon == "DAY" else "demo", requested_by=user, symbol="005930", name="삼성전자",
        market="KR", currency="KRW", entry_price=69000, target_price=80000, stop_price=66000, holding_days=1,
        horizon=horizon, probability=0.5, target_return=0.1, stop_loss_rate=-0.04, reward_risk=2.5,
        expected_return=0.02, summary=SUMMARY, valid_until=at(deadline))
    activated_at = at(activated) if activated else at(deadline) - timedelta(hours=6)
    return TradePlan.objects.create(
        recommendation=rec, user=user, symbol="005930", name="삼성전자", market="KR", currency="KRW",
        status=TradePlan.CLOSED, quantity=10, entry_price=69000, target_price=80000, stop_price=66000,
        holding_days=1, horizon=horizon, entry_deadline=at(deadline), activated_at=activated_at)


def test_list_is_my_day_plans_of_that_session_newest_first(api, user, django_user_model, clock):
    clock("2026-09-22T14:00")
    first = plan_on(user, "2026-09-22T15:15", activated="2026-09-22T08:00")
    second = plan_on(user, "2026-09-22T15:15", activated="2026-09-22T10:00")
    plan_on(user, "2026-09-21T15:15")  # 어제 세션
    plan_on(user, "2026-09-22T15:15", horizon="SWING")  # 스윙 계획
    other, _ = login(django_user_model, "bob")
    plan_on(other, "2026-09-22T15:15")  # 남의 계획
    body = api.get("/api/day/plans")
    assert body.status_code == 200
    assert body.json()["date"] == "2026-09-22"
    assert [p["id"] for p in body.json()["results"]] == [second.id, first.id]
    yesterday = api.get("/api/day/plans?date=2026-09-21").json()
    assert yesterday["date"] == "2026-09-21" and len(yesterday["results"]) == 1
    assert api.get("/api/day/plans?date=2026-09-23").json() == {"date": "2026-09-23", "results": []}


def test_list_default_is_the_kst_date(api, user, clock):
    clock("2026-09-22T00:30")  # UTC로는 21일
    plan_on(user, "2026-09-22T15:15")
    body = api.get("/api/day/plans").json()
    assert body["date"] == "2026-09-22" and len(body["results"]) == 1


def test_list_is_visible_while_locked_and_rejects_bad_dates(api, user, clock):
    unlock(user)
    user.investor_profile.beginner_mode = True
    user.investor_profile.save()
    assert api.get("/api/day/plans").status_code == 200
    for bad in ("2026-9-22", "20260922", "abc", "2026-02-30"):
        body = api.get(f"/api/day/plans?date={bad}")
        assert body.status_code == 400 and set(body.json()) == {"detail"}


@pytest.mark.parametrize("day", ["0001-01-01", "0001-01-02", "9999-12-30", "9999-12-31"])
def test_list_edge_dates_are_200_and_empty(api, user, clock, day):
    """형식이 맞으면 달력 끝 날짜도 200 빈 목록 (그날 경계를 UTC로 나타낼 수 없어도 500이 되지 않는다)."""
    clock("2026-09-22T10:00")
    plan_on(user, "2026-09-22T15:15")
    body = api.get(f"/api/day/plans?date={day}")
    assert body.status_code == 200 and body.json() == {"date": day, "results": []}
