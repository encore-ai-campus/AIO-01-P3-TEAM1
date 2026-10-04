"""단타 연습 API (docs/API.md "단타 연습"). 로그인은 전역 설정이 확인한다 (안 했으면 401).

잠겨도(주린이모드 켬·퀴즈 미통과) 상태·계획 목록·복기는 볼 수 있다. 미리 보기·계획 만들기는 잠기면
400 {"detail", "reasonCodes": ["day_trading_locked"]}. 실행 불가 사유가 있는 400은 본문에 reasonCodes가 있어 Response를 직접 돌려준다.
"""
from autotrade import payloads
from autotrade.executor import Blocked
from autotrade.models import TradePlan
from django.utils import timezone
from rest_framework import status
from rest_framework.response import Response
from rest_framework.views import APIView

from config.api import Rejected

from . import review, service
from .session import basis_day, kst_date


def _blocked(e: Blocked) -> Response:
    """실행 불가 사유가 있는 400 (docs/API.md "실행 불가 사유 코드" — reasonCodes[i]가 detail을 이은 사유 i번째의 코드)."""
    return Response({"detail": "; ".join(e.reasons), "reasonCodes": e.codes}, status=status.HTTP_400_BAD_REQUEST)


class DayStatusView(APIView):
    def get(self, request):
        return Response(service.status(request.user, timezone.now()))


class DayPreviewView(APIView):
    def post(self, request):
        try:
            return Response(service.preview(request.user, request.data, timezone.now()))
        except Blocked as e:
            return _blocked(e)


class DayPlansView(APIView):
    def get(self, request):
        """그 세션의 내 단타 계획 (최신순). date 기본 = 오늘(KST)."""
        day = service.parse_date(request.query_params.get("date"), kst_date(timezone.now()))
        plans = service.session_plans(request.user, day).order_by("-activated_at", "-id")
        return Response({"date": f"{day}", "results": [payloads.plan(p) for p in plans]})

    def post(self, request):
        try:
            plan = service.create_plan(request.user, request.data, timezone.now())
        except Blocked as e:
            return _blocked(e)
        plan = TradePlan.objects.select_related("recommendation__requested_by", "user").get(pk=plan.pk)
        return Response(payloads.plan_detail(plan, request.user), status=status.HTTP_201_CREATED)


class DayReviewView(APIView):
    def get(self, request):
        """결정론 복기. date 기본 = KR 장마감 기준일. 오늘(KST)보다 뒤 날짜는 400."""
        now = timezone.now()
        day = service.parse_date(request.query_params.get("date"), basis_day(now))
        if day > kst_date(now):
            raise Rejected("오늘보다 뒤 날짜는 복기할 수 없습니다.")
        return Response(review.review(request.user, day))
