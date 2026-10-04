"""AI 추천·매매 계획 API (docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림"). 로그인은 전역 설정이 확인한다 (안 했으면 401).

추천은 팀 전체 공용, 계획은 내 것만 (남의 계획은 404). 단, 단타 연습 추천(source day)은 만든 사람만 본다:
목록에는 source=day일 때만 내 것이, 남의 day 추천은 404, day 추천은 이 활성화 경로로 활성화하지 않는다 (400 — 만들 때 이미 활성화된다).
활성화 점검에서 막히면 400 {"detail", "reasonCodes"} (Response를 직접 돌려준다 — config.api의 예외는 detail 밖을 버린다).
"""
import math

from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from config.api import Rejected, page

from . import demo, executor, payloads, risk
from .models import Recommendation, TradePlan
from .tokens import check_token

SOURCES = (Recommendation.REPORT, Recommendation.ANALYSIS, Recommendation.DEMO, Recommendation.DAY)
BAD_TOKEN = "링크가 만료되었거나 올바르지 않습니다."
DAY_NOT_HERE = "단타 연습 계획은 만들 때 이미 시작돼요. 이 경로로 활성화하지 않습니다."


def _body(request) -> dict:
    if not isinstance(request.data, dict):
        raise Rejected("요청 본문은 JSON 객체여야 합니다.")
    return request.data


def _budget(value) -> float | None:
    """budgetKrw: 없으면 None, 양수가 아니면 400."""
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        raise Rejected("budgetKrw는 양수여야 합니다.")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        raise Rejected("budgetKrw는 숫자여야 합니다.") from None
    if not math.isfinite(number) or number <= 0:
        raise Rejected("budgetKrw는 양수여야 합니다.")
    return number


def _acknowledged(data: dict) -> bool:
    """acknowledged: 없으면 false, 불리언이 아니면 400 (활성화를 막지는 않는다 — B5)."""
    if "acknowledged" not in data:
        return False
    value = data["acknowledged"]
    if not isinstance(value, bool):
        raise Rejected("acknowledged는 true 또는 false여야 합니다.")
    return value


def _recommendation(rec_id: int, user) -> Recommendation:
    """추천 하나. 없거나 남의 단타 연습 추천이면 404."""
    rec = Recommendation.objects.select_related("requested_by").filter(pk=rec_id).first()
    if rec is None or (rec.source == Recommendation.DAY and rec.requested_by_id != user.pk):
        raise NotFound("추천을 찾을 수 없습니다.")
    return rec


def _my_plan(request, plan_id: int) -> TradePlan:
    plan = (TradePlan.objects.select_related("recommendation__requested_by", "user")
            .filter(pk=plan_id, user=request.user).first())
    if plan is None:
        raise NotFound("계획을 찾을 수 없습니다.")
    return plan


class RecommendationsView(APIView):
    def get(self, request):
        """추천 목록 (팀 전체 공용, 최신순). status=open(기본)|all, source, sourceId(source와 같이), symbol.

        단타 연습 추천(day)은 source=day일 때만, 내 것만 나온다."""
        params = request.query_params
        recs = Recommendation.objects.select_related("requested_by").order_by("-created_at", "-id")
        wanted = params.get("status", "open")
        if wanted == "open":
            recs = recs.filter(status=Recommendation.OPEN, valid_until__gt=timezone.now())
        elif wanted != "all":
            raise Rejected("status는 open 또는 all입니다.")
        source = params.get("source", "")
        if source:
            if source not in SOURCES:
                raise Rejected("source는 report, analysis, demo, day 중 하나입니다.")
            recs = recs.filter(source=source)
            if source == Recommendation.DAY:
                recs = recs.filter(requested_by=request.user)
        else:
            recs = recs.exclude(source=Recommendation.DAY)
        source_id = params.get("sourceId", "")
        if source_id:
            if source not in (Recommendation.REPORT, Recommendation.ANALYSIS):
                raise Rejected("sourceId는 source(report 또는 analysis)와 같이 보냅니다.")
            try:
                number = int(source_id)
            except ValueError:
                raise Rejected("sourceId는 정수여야 합니다.") from None
            recs = recs.filter(**{"report_id" if source == Recommendation.REPORT else "analysis_id": number})
        symbol = params.get("symbol", "").strip().upper()
        if symbol:
            recs = recs.filter(symbol=symbol)
        response = page(request, recs, lambda r: r)
        response.data["results"] = payloads.recommendations(response.data["results"], request.user)
        return response


class RecommendationView(APIView):
    def get(self, request, rec_id: int):
        return Response(payloads.recommendation_for(_recommendation(rec_id, request.user), request.user))


class RecommendationPreviewView(APIView):
    def get(self, request, rec_id: int):
        rec = _recommendation(rec_id, request.user)
        return Response(risk.preview(rec, request.user, _budget(request.query_params.get("budgetKrw"))))


class RecommendationActivateView(APIView):
    def post(self, request, rec_id: int):
        rec = _recommendation(rec_id, request.user)
        if rec.source == Recommendation.DAY:
            raise Rejected(DAY_NOT_HERE)
        data = _body(request)
        budget = _budget(data.get("budgetKrw"))
        acknowledged = _acknowledged(data)
        token = data.get("token")
        via = "web"
        if token not in (None, ""):
            if not isinstance(token, str) or not check_token(rec, token):
                raise Rejected(BAD_TOKEN)
            via = "discord"
        try:
            plan = executor.activate(rec, request.user, budget, via, acknowledged=acknowledged)
        except executor.Blocked as e:  # 실행 불가 사유 (코드 포함)
            return Response(e.body(), status=status.HTTP_400_BAD_REQUEST)
        plan = _my_plan(request, plan.id)
        return Response(payloads.plan_detail(plan, request.user), status=status.HTTP_201_CREATED)


class DemoRecommendationView(APIView):
    def post(self, request):
        symbol = _body(request).get("symbol")
        if symbol is not None and (not isinstance(symbol, str)):
            raise Rejected("symbol은 문자열이어야 합니다.")
        rec = demo.recommend(request.user, (symbol or "").strip() or None)
        return Response(payloads.recommendation_for(_recommendation(rec.id, request.user), request.user),
                        status=status.HTTP_201_CREATED)


class TradePlansView(APIView):
    def get(self, request):
        """내 계획 (최신순). status=active(기본, 진행 중 셋)|all."""
        plans = (TradePlan.objects.filter(user=request.user).select_related("recommendation")
                 .order_by("-activated_at", "-id"))
        wanted = request.query_params.get("status", "active")
        if wanted == "active":
            plans = plans.filter(status__in=TradePlan.LIVE)
        elif wanted != "all":
            raise Rejected("status는 active 또는 all입니다.")
        return page(request, plans, payloads.plan)


class TradePlanView(APIView):
    def get(self, request, plan_id: int):
        return Response(payloads.plan_detail(_my_plan(request, plan_id), request.user))


class TradePlanCancelView(APIView):
    def post(self, request, plan_id: int):
        plan = executor.cancel(_my_plan(request, plan_id), request.user)
        return Response(payloads.plan_detail(_my_plan(request, plan.id), request.user))
