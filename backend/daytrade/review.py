"""단타 결정론 복기 (docs/API.md "단타 연습" DayReview). DB 사실(계획·모의 주문·체결·사건)만으로 만든다.

AI 복기(day_review)는 추천 워크플로우 팀 몫이라 여기 없다 (화면은 "AI 복기 — 준비 중").
진입·청산은 그 계획이 낸 모의 주문(요청자 plan:<계획 id>)의 체결에서 읽고, 체결 기록이 없으면 계획에 복사된 값을 쓴다.
"""
from collections import defaultdict
from datetime import date

from autotrade import executor, payloads
from autotrade.models import PlanEvent, TradePlan
from paper_engine.records.account import CLOSED
from trading.models import PaperFill, PaperOrder
from trading.store import iso

from .service import session_plans


def _by_plan(rows, plans: dict[str, TradePlan]) -> dict[int, list]:
    """요청자(plan:<id>)로 계획별로 나눈다."""
    out: dict[int, list] = defaultdict(list)
    for row in rows:
        plan = plans.get(row.requested_by if isinstance(row, PaperOrder) else row.order.requested_by)
        if plan is not None:
            out[plan.id].append(row)
    return out


def _item(plan: TradePlan, orders: list[PaperOrder], fills: list[PaperFill], events: list[PlanEvent]) -> dict:
    """DayReviewItem 하나."""
    buy = next((f for f in fills if f.side == "BUY"), None)
    sell = next((f for f in reversed(fills) if f.side == "SELL"), None)
    pnl = plan.pnl_krw
    if pnl is None:  # 계획은 엔진 루프가 곧 따라간다. 주문이 이미 청산됐으면 그 손익을 쓴다
        pnl = next((o.pnl_krw for o in orders if o.status == CLOSED and o.pnl_krw is not None), None)
    return {
        "plan": payloads.plan(plan),
        "entryAt": iso(buy.filled_at) if buy else iso(plan.filled_at),
        "entryPrice": buy.price if buy else plan.fill_price,
        "exitAt": iso(sell.filled_at) if sell else iso(plan.closed_at),
        "exitPrice": sell.price if sell else plan.exit_price,
        "exitReason": sell.reason if sell else plan.exit_reason,
        "pnlKrw": pnl,
        "costsKrw": sum((f.commission + f.tax) * (f.fx_rate or 1.0) for f in fills),
        "events": [payloads.event(e) for e in events],
    }


def review(user, day: date) -> dict:
    """DayReview: 그 세션(day)의 내 단타 계획(활성화 순)과 합계. 쿼리 수는 계획 수와 무관하다."""
    plans = list(session_plans(user, day).order_by("activated_at", "id"))
    by_requester = {executor.requester(p): p for p in plans}
    orders = PaperOrder.objects.filter(account__user=user, requested_by__in=list(by_requester)).order_by("id")
    fills = (PaperFill.objects.filter(order__account__user=user, order__requested_by__in=list(by_requester))
             .select_related("order").order_by("filled_at", "id"))
    events: dict[int, list] = defaultdict(list)
    for e in PlanEvent.objects.filter(plan__in=plans).order_by("plan_id", "step"):
        events[e.plan_id].append(e)
    plan_orders, plan_fills = _by_plan(orders, by_requester), _by_plan(fills, by_requester)
    items = [_item(p, plan_orders[p.id], plan_fills[p.id], events[p.id]) for p in plans]
    closed = [i["pnlKrw"] for i in items if i["pnlKrw"] is not None]
    return {
        "date": f"{day}",
        "plans": items,
        "totals": {
            "filled": sum(1 for i in items if i["entryAt"] is not None),
            "wins": sum(1 for pnl in closed if pnl > 0),
            "losses": sum(1 for pnl in closed if pnl <= 0),
            "pnlKrw": sum(closed),
            "costsKrw": sum(i["costsKrw"] for i in items),
        },
    }
