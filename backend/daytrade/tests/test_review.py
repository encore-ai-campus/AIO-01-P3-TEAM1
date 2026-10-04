"""GET /api/day/review — DB 사실(계획·그 계획의 모의 주문·체결·사건)만으로 만드는 결정론 복기."""
import pytest
from autotrade.models import PlanEvent, Recommendation, TradePlan
from trading.models import DAY, PaperFill, PaperOrder
from trading.store import account_for

from .conftest import at, login

pytestmark = pytest.mark.django_db

DEADLINE = "2026-09-22T15:15"


def plan(user, status: str, activated: str, deadline: str = DEADLINE, horizon: str = "DAY", **fields) -> TradePlan:
    rec = Recommendation.objects.create(
        source="day" if horizon == "DAY" else "demo", requested_by=user, symbol="005930", name="삼성전자",
        market="KR", currency="KRW", entry_price=69000, target_price=72000, stop_price=68000, holding_days=1,
        horizon=horizon, probability=0.5, target_return=0.04, stop_loss_rate=-0.014, reward_risk=2.1,
        expected_return=0.01, summary="단타 연습 계획 (직접 입력, AI 아님)", valid_until=at(deadline))
    return TradePlan.objects.create(
        recommendation=rec, user=user, symbol="005930", name="삼성전자", market="KR", currency="KRW", status=status,
        quantity=10, entry_price=69000, target_price=72000, stop_price=68000, holding_days=1, horizon=horizon,
        entry_deadline=at(deadline), activated_at=at(activated), **fields)


def order(p: TradePlan, status: str, **fields) -> PaperOrder:
    return PaperOrder.objects.create(
        account=account_for(p.user), requested_by=f"plan:{p.id}", symbol=p.symbol, name=p.name, market="KR",
        currency="KRW", order_type="LIMIT", limit_price=69000, quantity=10, entry_price=69000, status=status,
        created_at=p.activated_at, style=DAY, **fields)


def fill(o: PaperOrder, side: str, price: float, when: str, reason: str) -> PaperFill:
    amount = price * 10
    commission, tax = amount * 0.001, (amount * 0.002 if side == "SELL" else 0.0)
    return PaperFill.objects.create(
        account=o.account, order=o, side=side, price=price, quantity=10, amount=amount, commission=commission,
        tax=tax, fx_rate=1.0, cash_change_krw=-amount - commission if side == "BUY" else amount - commission - tax,
        reason=reason, filled_at=at(when))


def event(p: TradePlan, step: int, kind: str, when: str) -> None:
    PlanEvent.objects.create(plan=p, step=step, kind=kind, message=kind, details={}, at=at(when))


@pytest.fixture
def session_day(user):
    """2026-09-22 세션: 목표가 청산 1 · 장 마감 전 정리(EOD) 손실 1 · 체결 없이 만료 1 (활성화 순)."""
    win = plan(user, TradePlan.CLOSED, "2026-09-22T08:50", fill_price=69000, filled_at=at("2026-09-22T09:05"),
               exit_price=72000, exit_reason="TARGET", closed_at=at("2026-09-22T10:30"), pnl_krw=29_400)
    o = order(win, "CLOSED", fill_price=69000, filled_at=at("2026-09-22T09:05"), exit_price=72000,
              exit_reason="TARGET", closed_at=at("2026-09-22T10:30"), pnl_krw=29_400)
    fill(o, "BUY", 69000, "2026-09-22T09:05", "ENTRY")
    fill(o, "SELL", 72000, "2026-09-22T10:30", "TARGET")
    for step, kind, when in ((2, "risk_checked", "2026-09-22T08:50"), (1, "activated", "2026-09-22T08:50"),
                             (3, "order_placed", "2026-09-22T08:50"), (4, "filled", "2026-09-22T09:05"),
                             (5, "closed", "2026-09-22T10:30")):
        event(win, step, kind, when)
    expired = plan(user, TradePlan.EXPIRED, "2026-09-22T11:00", failure_reason="진입 기한까지 지정가에 체결되지 않음")
    order(expired, "CANCELED", note="단타 진입 마감")
    eod = plan(user, TradePlan.CLOSED, "2026-09-22T10:00", fill_price=69000, filled_at=at("2026-09-22T10:10"),
               exit_price=68800, exit_reason="EOD", closed_at=at("2026-09-22T15:15:05"), pnl_krw=-3_456)
    o = order(eod, "CLOSED", pnl_krw=-3_456)
    fill(o, "BUY", 69000, "2026-09-22T10:10", "ENTRY")
    fill(o, "SELL", 68800, "2026-09-22T15:15:05", "EOD")
    return win, eod, expired


def test_review_reads_facts_in_activation_order(api, clock, session_day):
    win, eod, expired = session_day
    clock("2026-09-22T16:00")
    body = api.get("/api/day/review?date=2026-09-22")
    assert body.status_code == 200, body.json()
    r = body.json()
    assert r["date"] == "2026-09-22"
    assert [i["plan"]["id"] for i in r["plans"]] == [win.id, eod.id, expired.id]
    first, second, third = r["plans"]
    assert first["entryAt"] == "2026-09-22T09:05:00+09:00" and first["entryPrice"] == 69000
    assert first["exitAt"] == "2026-09-22T10:30:00+09:00" and first["exitPrice"] == 72000
    assert first["exitReason"] == "TARGET" and first["pnlKrw"] == 29_400
    assert first["costsKrw"] == pytest.approx(690 + 720 + 1440)  # 매수 수수료 + 매도 수수료 + 거래세
    assert [e["step"] for e in first["events"]] == [1, 2, 3, 4, 5]
    assert first["events"][0]["kind"] == "activated" and first["plan"]["status"] == "closed"
    assert second["exitReason"] == "EOD" and second["exitPrice"] == 68800 and second["pnlKrw"] == -3_456
    assert third["entryAt"] is None and third["exitAt"] is None and third["pnlKrw"] is None
    assert third["costsKrw"] == 0 and third["exitReason"] is None and third["events"] == []
    totals = r["totals"]
    assert totals["filled"] == 2 and totals["wins"] == 1 and totals["losses"] == 1
    assert totals["pnlKrw"] == pytest.approx(29_400 - 3_456)
    assert totals["costsKrw"] == pytest.approx(first["costsKrw"] + second["costsKrw"])


def test_holding_plan_has_no_exit_yet(api, user, clock):
    p = plan(user, TradePlan.HOLDING, "2026-09-22T09:00", fill_price=69000, filled_at=at("2026-09-22T09:01"))
    fill(order(p, "EXIT_WATCHING"), "BUY", 69000, "2026-09-22T09:01", "ENTRY")
    clock("2026-09-22T11:00")
    r = api.get("/api/day/review?date=2026-09-22").json()
    [item] = r["plans"]
    assert item["entryPrice"] == 69000 and item["exitAt"] is None and item["pnlKrw"] is None
    assert item["costsKrw"] == pytest.approx(690)
    assert r["totals"] == {"filled": 1, "wins": 0, "losses": 0, "pnlKrw": 0, "costsKrw": pytest.approx(690)}


def test_closed_order_before_plan_catches_up_uses_order_pnl(api, user, clock):
    p = plan(user, TradePlan.HOLDING, "2026-09-22T09:00", fill_price=69000, filled_at=at("2026-09-22T09:01"))
    o = order(p, "CLOSED", pnl_krw=0.0)  # 엔진 루프가 계획을 아직 closed로 바꾸지 않음. 본전도 손실 쪽으로 센다
    fill(o, "BUY", 69000, "2026-09-22T09:01", "ENTRY")
    fill(o, "SELL", 69000, "2026-09-22T09:30", "STOP")
    clock("2026-09-22T11:00")
    r = api.get("/api/day/review?date=2026-09-22").json()
    assert r["plans"][0]["pnlKrw"] == 0.0 and r["plans"][0]["exitReason"] == "STOP"
    assert r["totals"]["wins"] == 0 and r["totals"]["losses"] == 1


def test_review_skips_other_sessions_users_and_swing(api, user, django_user_model, clock, session_day):
    plan(user, TradePlan.CLOSED, "2026-09-21T09:00", deadline="2026-09-21T15:15", pnl_krw=100)
    plan(user, TradePlan.CLOSED, "2026-09-22T09:00", horizon="SWING", pnl_krw=100)
    other, _ = login(django_user_model, "bob")
    plan(other, TradePlan.CLOSED, "2026-09-22T09:00", pnl_krw=100)
    clock("2026-09-22T16:00")
    assert len(api.get("/api/day/review?date=2026-09-22").json()["plans"]) == 3
    assert [i["pnlKrw"] for i in api.get("/api/day/review?date=2026-09-21").json()["plans"]] == [100]


def test_default_date_is_the_kr_basis_day(api, clock, session_day):
    clock("2026-09-22T15:39")  # 그날 장마감 + 10분 전 → 기준일은 21일
    body = api.get("/api/day/review").json()
    assert body["date"] == "2026-09-21" and body["plans"] == []
    clock("2026-09-22T15:40")
    body = api.get("/api/day/review").json()
    assert body["date"] == "2026-09-22" and len(body["plans"]) == 3


def test_review_date_rules(api, clock):
    clock("2026-09-22T00:30")  # UTC로는 21일이지만 오늘(KST)은 22일
    assert api.get("/api/day/review?date=2026-09-22").status_code == 200
    body = api.get("/api/day/review?date=2026-09-23")
    assert body.status_code == 400 and set(body.json()) == {"detail"}
    for bad in ("2026/09/22", "abc", "2026-13-01"):
        assert api.get(f"/api/day/review?date={bad}").status_code == 400
    assert api.get("/api/day/review?date=9999-12-31").status_code == 400  # 오늘보다 뒤


@pytest.mark.parametrize("day", ["0001-01-01", "0001-01-02"])
def test_review_of_the_first_dates_is_empty(api, clock, session_day, day):
    """달력 처음 날짜도 형식이 맞으면 200 빈 복기 (그날 경계를 UTC로 나타낼 수 없어도 500이 되지 않는다)."""
    clock("2026-09-22T16:00")
    body = api.get(f"/api/day/review?date={day}")
    assert body.status_code == 200
    assert body.json() == {"date": day, "plans": [],
                           "totals": {"filled": 0, "wins": 0, "losses": 0, "pnlKrw": 0, "costsKrw": 0}}


def test_review_query_count_does_not_grow_with_plans(api, user, clock, session_day, django_assert_max_num_queries):
    clock("2026-09-22T16:00")
    with django_assert_max_num_queries(6):
        assert api.get("/api/day/review?date=2026-09-22").status_code == 200
