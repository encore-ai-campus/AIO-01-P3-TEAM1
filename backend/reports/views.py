"""AI 리포트 API (docs/API.md "AI 리포트"): 실행 계획, 리포트 목록·신청, 상세(Snapshot). SSE는 sse.py.

신청은 requested 행만 만든다. 실행(Agent·Orchestrator)은 아직 없다 (docs/DECISIONS.md 9-1).
"""
from datetime import date
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.db import transaction
from django.http import FileResponse
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView
from trading import market

from config.api import Rejected, page

from .models import Report
from .payloads import detail, nicknames, plan, summary
from .pdf import ensure_report_file

KST = ZoneInfo("Asia/Seoul")


class PlanView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """ExecutionPlan (YAML Registry에서 읽고 검증한 실행 계획)."""
        return Response(plan())


class ReportsView(APIView):
    @extend_schema(operation_id="reports_list", responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """리포트 목록 (팀 전체 공용, 최신순). ?symbol=로 종목을 고른다."""
        reports = Report.objects.select_related("user").order_by("-created_at", "-id")
        symbol = (request.query_params.get("symbol") or "").strip().upper()
        if symbol:
            reports = reports.filter(symbol=symbol)
        names = nicknames()
        return page(request, reports, lambda report: summary(report, names))

    @extend_schema(request=OpenApiTypes.OBJECT, responses={201: OpenApiTypes.OBJECT, 200: OpenApiTypes.OBJECT})
    def post(self, request):
        """리포트 신청 → 201 ReportDetail. 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 그것을 200으로."""
        symbol = request.data.get("symbol") if isinstance(request.data, dict) else None
        if not isinstance(symbol, str) or not symbol.strip():
            raise Rejected("종목코드를 입력하세요.")
        item = market.stock_item(symbol)  # 증권사 조회 불가면 Unavailable(503)
        if item is None:
            raise Rejected("종목을 찾을 수 없습니다.")
        with transaction.atomic():
            # 같은 사용자의 동시 신청(두 번 누름)을 줄 세운다
            get_user_model().objects.select_for_update().filter(pk=request.user.pk).first()
            active = Report.objects.select_related("user").filter(
                user=request.user, symbol=item["symbol"], status__in=Report.ACTIVE).order_by("id").first()
            if active is not None:
                return Response(detail(active), status=status.HTTP_200_OK)
            report = Report.objects.create(user=request.user, symbol=item["symbol"], name=item["name"],
                                           market=item["market"])
        return Response(detail(report), status=status.HTTP_201_CREATED)


class ReportDetailView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request, pk: int):
        """ReportDetail (Snapshot: 새로고침·연결 복구에 쓴다)."""
        report = Report.objects.select_related("user").filter(pk=pk).first()
        if report is None:
            raise NotFound("리포트를 찾을 수 없습니다.")
        return Response(detail(report))


class PdfView(APIView):
    @extend_schema(responses=OpenApiTypes.BINARY)
    def get(self, request, pk: int):
        """A4 PDF. 처음 부르면 만들어 PAPER_ROOT/reports/<id>.pdf에 두고 다음부터 그 파일을 준다.
        Chrome이 없으면 같은 내용의 HTML(text/html). 완성 전(completed가 아님)이면 409.

        (Report.pdf_path 열이 생기면 고정 경로 대신 그 열을 쓴다 — docs/tasks/05-프론트.md T5-14)
        """
        report = Report.objects.filter(pk=pk).first()
        if report is None:
            raise NotFound("리포트를 찾을 수 없습니다.")
        if report.status != Report.COMPLETED:
            return Response({"detail": "리포트가 아직 완성되지 않았습니다."}, status=status.HTTP_409_CONFLICT)
        path = ensure_report_file(report, list(report.trace_events.order_by("step")))
        content_type = "application/pdf" if path.suffix == ".pdf" else "text/html; charset=utf-8"
        return FileResponse(open(path, "rb"), content_type=content_type)


class ScreeningView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """ScreeningResult: 그날(기본 오늘, KST)의 선별 결과 (reports/auto.py가 남긴 파일). 없으면 404 (docs/tasks/01 T1-7)."""
        from . import auto  # 선별 파일 읽기 (선별 자체는 엔진 루프·관리 명령이 한다)

        market_ = (request.query_params.get("market") or "KR").strip().upper()
        if market_ not in ("KR", "US"):
            raise Rejected("market은 KR 또는 US입니다.")
        text = (request.query_params.get("date") or "").strip()
        try:
            day = date.fromisoformat(text) if text else timezone.now().astimezone(KST).date()
        except ValueError:
            raise Rejected("date는 YYYY-MM-DD 형식입니다.") from None
        result = auto.load(market_, day)
        if result is None:
            raise NotFound(f"{day} {market_} 선별 결과가 없습니다.")
        return Response(result)
