"""추천·계획 응답 형식 (docs/API.md 타입: Recommendation · TradePlan · TradePlanDetail · PlanEvent).

목록의 myPlan·planCount·requestedBy는 항목마다 조회하지 않고 recommendations()가 한 번에 모은다.
"""
from datetime import datetime

from accounts.models import Profile
from django.db.models import Count
from django.utils import timezone
from trading.store import iso

from . import hide
from .plans import risk
from .models import PlanEvent, Recommendation, TradePlan


def _source_id(rec: Recommendation) -> int | None:
    return {Recommendation.REPORT: rec.report_id, Recommendation.ANALYSIS: rec.analysis_id}.get(rec.source)


def _status(rec: Recommendation, now: datetime) -> str:
    """DB가 아직 open이어도 validUntil이 지났으면 expired로 보여 준다 (엔진 루프가 곧 바꾼다)."""
    return Recommendation.EXPIRED if rec.status == Recommendation.EXPIRED or now >= rec.valid_until else rec.status


def _expired_reason(rec: Recommendation, status: str) -> str | None:
    """expiredReason: expired면 까닭 (예전 행·엔진 루프가 아직 바꾸지 않은 행은 기한), open이면 None."""
    return (rec.expired_reason or Recommendation.DEADLINE) if status == Recommendation.EXPIRED else None


def recommendation(rec: Recommendation, nickname: str | None, my_plan: dict | None, plan_count: int,
                   now: datetime | None = None, user=None) -> dict:
    """Recommendation. blockedBy는 리스크 엔진과 같은 계산 (risk.blocked_by). canDelete는 user가 만든 추천인지."""
    now = now or timezone.now()
    status = _status(rec, now)
    return {
        "id": rec.id, "source": rec.source, "sourceId": _source_id(rec), "requestedBy": nickname,
        "symbol": rec.symbol, "name": rec.name, "market": rec.market, "currency": rec.currency,
        "priceAtCreation": rec.price_at_creation, "entryPrice": rec.entry_price, "targetPrice": rec.target_price,
        "stopPrice": rec.stop_price, "holdingDays": rec.holding_days, "targetReturn": rec.target_return,
        "stopLossRate": rec.stop_loss_rate, "rewardRisk": rec.reward_risk, "probability": rec.probability,
        "probabilityAssumed": rec.probability_assumed, "expectedReturn": rec.expected_return,
        "confidence": rec.confidence, "summary": rec.summary, "reasons": rec.reasons, "risks": rec.risks,
        "riskLevel": rec.risk_level, "status": status, "expiredReason": _expired_reason(rec, status),
        "validUntil": iso(rec.valid_until), "createdAt": iso(rec.created_at),
        "myPlan": my_plan, "planCount": plan_count, "blockedBy": risk.blocked_by(rec, now),
        "canDelete": user is not None and hide.can_delete_recommendation(rec, user),
    }


def recommendations(recs: list[Recommendation], user) -> list[dict]:
    """Recommendation 목록. 닉네임·내 계획·계획 수를 쿼리 몇 번으로 모은다 (목록 크기와 무관).

    recs는 select_related("requested_by")로 읽는다."""
    ids = [r.id for r in recs]
    users = {r.requested_by_id for r in recs if r.requested_by_id}
    names = dict(Profile.objects.filter(user_id__in=users).values_list("user_id", "nickname")) if users else {}
    counts = dict(TradePlan.objects.filter(recommendation_id__in=ids).values("recommendation_id")
                  .annotate(n=Count("id")).values_list("recommendation_id", "n"))
    mine: dict[int, dict] = {}
    for plan_id, rec_id, status in (TradePlan.objects.filter(user=user, recommendation_id__in=ids)
                                    .order_by("id").values_list("id", "recommendation_id", "status")):
        current = mine.get(rec_id)
        if current is None or current["status"] not in TradePlan.LIVE or status in TradePlan.LIVE:
            mine[rec_id] = {"id": plan_id, "status": status}  # 진행 중인 것, 없으면 가장 최근 것
    now = timezone.now()
    return [recommendation(r, _nickname(r, names), mine.get(r.id), counts.get(r.id, 0), now, user) for r in recs]


def _nickname(rec: Recommendation, names: dict[int, str]) -> str | None:
    """신청자 닉네임 (아이디는 로그인 정보라 다른 팀원에게 내지 않는다. 프로필이 없을 때만 아이디)."""
    if not rec.requested_by_id:
        return None
    return names.get(rec.requested_by_id) or rec.requested_by.get_username()


def recommendation_for(rec: Recommendation, user) -> dict:
    return recommendations([rec], user)[0]


def plan(p: TradePlan) -> dict:
    """TradePlan. p.recommendation을 쓰므로 목록은 select_related("recommendation")로 읽는다."""
    return {
        "id": p.id, "recommendationId": p.recommendation_id, "symbol": p.symbol, "name": p.name,
        "market": p.market, "currency": p.currency, "source": p.recommendation.source, "status": p.status,
        "via": p.via, "manualStart": p.manual_start,  # 시연용 수동 시작 (DECISIONS 31장)
        "quantity": p.quantity, "budgetMode": p.budget_mode, "budgetPercent": p.budget_percent,
        "budgetKrw": p.budget_krw, "entryPrice": p.entry_price,
        "targetPrice": p.target_price, "stopPrice": p.stop_price, "holdingDays": p.holding_days,
        "entryDeadline": iso(p.entry_deadline), "orderId": p.order_id, "fillPrice": p.fill_price,
        "filledAt": iso(p.filled_at), "exitPrice": p.exit_price, "exitReason": p.exit_reason,
        "closedAt": iso(p.closed_at), "pnlKrw": p.pnl_krw, "failureReason": p.failure_reason,
        "activatedAt": iso(p.activated_at), "updatedAt": iso(p.updated_at),
    }


def event(e: PlanEvent) -> dict:
    """PlanEvent."""
    return {"step": e.step, "kind": e.kind, "message": e.message, "details": e.details, "at": iso(e.at)}


def plan_detail(p: TradePlan, user) -> dict:
    """TradePlanDetail: 계획 + 추천 + 사건(step 오름차순)."""
    return plan(p) | {"recommendation": recommendation_for(p.recommendation, user),
                      "events": [event(e) for e in p.events.order_by("step")]}
