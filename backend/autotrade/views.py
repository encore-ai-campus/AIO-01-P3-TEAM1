"""AI 추천·매매 계획 API (docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림"). 로그인은 전역 설정이 확인한다 (안 했으면 401).

추천은 팀 전체 공용, 계획은 내 것만 (남의 계획은 404). 지운 추천은 목록·상세·미리 보기·활성화에서 없는 것과 같다 (hide.py).
활성화 점검에서 막히면 400 {"detail", "reasonCodes"} (Response를 직접 돌려준다 — config.api의 예외는 detail 밖을 버린다).
넣을 돈은 budgetPercent(1~100 정수) 또는 budgetKrw(양수, 원) 하나다 — 미리 보기는 없어도 되고, 활성화는 하나가 필수다 (2026-10-11).
시연용 수동 시작(manualStart, DECISIONS 31장): 미리 보기 쿼리·활성화 본문 — 손익비·기대값 사유만 건너뛴다.
"""
import math

from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from config.api import Rejected, page

from .recommend import demo
from .plans import executor, risk
from . import hide, payloads
from .models import Recommendation, TradePlan
from .tokens import check_token

SOURCES = (Recommendation.REPORT, Recommendation.ANALYSIS, Recommendation.DEMO)
BAD_TOKEN = "링크가 만료되었거나 올바르지 않습니다."
BAD_PERCENT = "budgetPercent는 1~100 사이의 정수여야 합니다."
BOTH_BUDGETS = "budgetPercent와 budgetKrw 중 하나만 보냅니다."
BAD_MANUAL = "manualStart는 true 또는 false여야 합니다."


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


def _percent(value) -> int | None:
    """budgetPercent: 없으면 None. 1~100 정수(JSON 정수, 정수 값인 실수, 쿼리 문자열 "25")가 아니면 400 (불리언·소수도 400)."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        text = value.strip()
        number = int(text) if text.isascii() and text.isdigit() and len(text) <= 3 else None  # 아주 긴 숫자열도 400
    elif isinstance(value, float):
        number = int(value) if value.is_integer() else None  # 2.5·nan·inf는 정수가 아니다
    elif isinstance(value, int) and not isinstance(value, bool):
        number = value
    else:
        number = None
    if number is None or not 1 <= number <= 100:
        raise Rejected(BAD_PERCENT)
    return number


def _budgets(data) -> tuple[float | None, int | None]:
    """(budgetKrw, budgetPercent). 둘 다 보내면 400 (둘 다 없으면 (None, None))."""
    krw, percent = _budget(data.get("budgetKrw")), _percent(data.get("budgetPercent"))
    if krw is not None and percent is not None:
        raise Rejected(BOTH_BUDGETS)
    return krw, percent


def _acknowledged(data: dict) -> bool:
    """acknowledged: 없으면 false, 불리언이 아니면 400 (활성화를 막지는 않는다 — B5)."""
    if "acknowledged" not in data:
        return False
    value = data["acknowledged"]
    if not isinstance(value, bool):
        raise Rejected("acknowledged는 true 또는 false여야 합니다.")
    return value


def _manual_query(value) -> bool:
    """미리 보기 ?manualStart=: 없음·빈 값·0·false는 False, 1·true는 True (대소문자·앞뒤 공백 무시), 그 밖은 400."""
    text = (value or "").strip().lower()
    if text in ("", "0", "false"):
        return False
    if text in ("1", "true"):
        return True
    raise Rejected(BAD_MANUAL)


def _manual_body(data: dict) -> bool:
    """활성화 본문 manualStart: 없으면 False, JSON 불리언이 아니면 400 (acknowledged와 같은 규칙 — 문자열·숫자·null도 400)."""
    if "manualStart" not in data:
        return False
    value = data["manualStart"]
    if not isinstance(value, bool):
        raise Rejected(BAD_MANUAL)
    return value


def _recommendation(rec_id: int) -> Recommendation:
    """지운 추천은 없는 것과 같다 (404)."""
    rec = Recommendation.objects.select_related("requested_by").filter(pk=rec_id, deleted_at__isnull=True).first()
    if rec is None:
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
        """추천 목록 (팀 전체 공용, 최신순). status=open(기본)|all, source, sourceId(source와 같이), symbol."""
        params = request.query_params
        recs = (Recommendation.objects.select_related("requested_by").filter(deleted_at__isnull=True)
                .order_by("-created_at", "-id"))
        wanted = params.get("status", "open")
        if wanted == "open":
            recs = recs.filter(status=Recommendation.OPEN, valid_until__gt=timezone.now())
        elif wanted != "all":
            raise Rejected("status는 open 또는 all입니다.")
        source = params.get("source", "")
        if source:
            if source not in SOURCES:
                raise Rejected("source는 report, analysis, demo 중 하나입니다.")
            recs = recs.filter(source=source)
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
        return Response(payloads.recommendation_for(_recommendation(rec_id), request.user))

    def delete(self, request, rec_id: int):
        """만든 팀원만 지운다 (숨김, 리포트 추천이면 출처 리포트도). 남의 것 403, 진행 중 계획이 있으면 400."""
        hide.delete_recommendation(_recommendation(rec_id), request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class RecommendationPreviewView(APIView):
    def get(self, request, rec_id: int):
        rec = _recommendation(rec_id)
        krw, percent = _budgets(request.query_params)
        manual = _manual_query(request.query_params.get("manualStart"))
        return Response(risk.preview(rec, request.user, krw, budget_percent=percent, manual_start=manual))


class RecommendationActivateView(APIView):
    def post(self, request, rec_id: int):
        rec = _recommendation(rec_id)
        data = _body(request)
        budget, percent = _budgets(data)
        if budget is None and percent is None:
            raise Rejected(executor.NO_BUDGET)
        acknowledged = _acknowledged(data)
        manual = _manual_body(data)
        token = data.get("token")
        via = "web"
        if token not in (None, ""):
            if not isinstance(token, str) or not check_token(rec, token):
                raise Rejected(BAD_TOKEN)
            via = "discord"
        try:
            plan = executor.activate(rec, request.user, budget, via, budget_percent=percent, acknowledged=acknowledged,
                                     manual_start=manual)
        except executor.Blocked as e:  # 실행 불가 사유 (코드 포함). MANUAL_NOT_NEEDED는 Blocked가 아니라 400 {"detail"}
            return Response(e.body(), status=status.HTTP_400_BAD_REQUEST)
        plan = _my_plan(request, plan.id)
        return Response(payloads.plan_detail(plan, request.user), status=status.HTTP_201_CREATED)


class DemoRecommendationView(APIView):
    def post(self, request):
        symbol = _body(request).get("symbol")
        if symbol is not None and (not isinstance(symbol, str)):
            raise Rejected("symbol은 문자열이어야 합니다.")
        rec = demo.recommend(request.user, (symbol or "").strip() or None)
        return Response(payloads.recommendation_for(_recommendation(rec.id), request.user),
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
