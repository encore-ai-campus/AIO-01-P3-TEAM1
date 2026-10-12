"""AI 리포트 API (docs/API.md "AI 리포트"): 실행 계획, 리포트 목록·신청, 하루 한도, 상세(Snapshot). SSE는 sse.py.

신청은 requested 행만 만든다 (실행은 엔진 루프의 reports.orchestration.runner — docs/DECISIONS.md 9-1).
팀(Report.team)이 둘이다: 팀원이 신청하는 종목 리포트(stock_report)와 하루 한 번 자동으로 도는 매매 종목 선정
(stock_selection — 엔진이 만든다, docs/design/AI_AGENT_WORKFLOW.md). 목록·계획은 기본이 종목 리포트이고 ?team=으로 고른다.
신청은 늘 종목 리포트이고, 선정 실행에는 PDF가 없다.
지운 리포트(deleted_at — 신청한 팀원이 지움, autotrade/hide.py)는 목록·상세·PDF·SSE에서 없는 것과 같다 (비용·한도·복구 통계는 그대로 센다).
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

from accounts.modes import beginner_mode_of
from autotrade import hide
from config.api import Rejected, page

from .limits import budget, quota
from .autohealing import chaos
from .orchestration import registry
from .models import Report
from .payloads import detail, iso, nicknames, plan, summary
from .output.pdf import ensure_report_file

KST = ZoneInfo("Asia/Seoul")
TEAM_CHOICE = "team은 stock_report 또는 stock_selection입니다."
SOURCE_CHOICE = "source는 user 또는 auto입니다."
VIEWS = ("easy", "expert")   # PDF 판 (화면의 ?view와 같은 값)
VIEW_CHOICE = "view는 easy 또는 expert입니다."


def choice(request, key: str, choices, message: str, default: str | None = None) -> str | None:
    """쿼리 값 하나 (앞뒤 공백·대소문자 무시). 없거나 비었으면 default, choices 밖이면 400 {"detail": message}."""
    value = (request.query_params.get(key) or "").strip().lower()
    if not value:
        return default
    if value not in choices:
        raise Rejected(message)
    return value


class PlanView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """ExecutionPlan (YAML Registry에서 읽고 검증한 실행 계획). ?team= (기본 stock_report, 모르는 팀이면 400)."""
        return Response(plan(choice(request, "team", registry.TEAMS, TEAM_CHOICE, registry.TEAM)))


class ReportsView(APIView):
    @extend_schema(operation_id="reports_list", responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """리포트 목록 (팀 전체 공용, 최신순). ?symbol=로 종목을, ?mine=1이면 내가 신청한 것만 (같이 쓸 수 있다).

        ?team= (기본 stock_report — 선정 실행은 ?team=stock_selection일 때만 나온다), ?source=user|auto. 모르는 값이면 400.
        """
        team = choice(request, "team", registry.TEAMS, TEAM_CHOICE, registry.TEAM)
        source = choice(request, "source", (Report.USER, Report.AUTO), SOURCE_CHOICE)
        reports = (Report.objects.select_related("user").filter(team=team, deleted_at__isnull=True)
                   .order_by("-created_at", "-id"))
        if source:
            reports = reports.filter(source=source)
        symbol = (request.query_params.get("symbol") or "").strip().upper()
        if symbol:
            reports = reports.filter(symbol=symbol)
        if request.query_params.get("mine") == "1":  # B8 (Claude). 자동 리포트는 신청자가 없어 빠진다
            reports = reports.filter(user=request.user)
        names = nicknames()
        return page(request, reports, lambda report: summary(report, names, request.user))

    @extend_schema(request=OpenApiTypes.OBJECT, responses={201: OpenApiTypes.OBJECT, 200: OpenApiTypes.OBJECT})
    def post(self, request):
        """리포트 신청 → 201 ReportDetail. 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 그것을 200으로
        (한도를 넘었어도). 하루 한도를 넘으면 429 {"detail", "limit", "used"}.

        순서 (docs/tasks/00-공통.md 2절 — 각 담당이 자기 한 줄을 이 자리 순서대로 더한다):
        입력 검사(종목 → 4의 chaos.parse) → 같은 종목 진행 중이면 200 → Claude의 quota.check → 2의 budget.check → 생성.
        """
        now = timezone.now()  # 한도를 센 시각과 생성 시각을 같게 (자정 무렵 신청이 다른 날로 세이지 않게)
        symbol = request.data.get("symbol") if isinstance(request.data, dict) else None
        if not isinstance(symbol, str) or not symbol.strip():
            raise Rejected("종목코드를 입력하세요.")
        item = market.stock_item(symbol)  # 증권사 조회 불가면 Unavailable(503)
        if item is None:
            raise Rejected("종목을 찾을 수 없습니다.")
        chaos_config = chaos.parse(request.data.get("chaos"))  # 4: 장애 주입 설정 (잘못되면 400, 없거나 꺼져 있으면 None)
        with transaction.atomic():
            # 같은 사용자의 동시 신청(두 번 누름)을 줄 세운다 — 한도 검사도 이 잠금 안에서 한다
            get_user_model().objects.select_for_update().filter(pk=request.user.pk).first()
            active = Report.objects.select_related("user").filter(
                user=request.user, team=Report.STOCK_REPORT, symbol=item["symbol"], status__in=Report.ACTIVE,
            ).order_by("id").first()
            if active is not None:
                return Response(detail(active, request.user), status=status.HTTP_200_OK)
            try:
                quota.check(request.user, now)  # Claude: 하루 리포트 횟수 한도 (D-7)
            except quota.Exceeded as e:  # 본문에 limit·used가 있어 Response를 직접 (config.api는 detail 외 필드를 버린다)
                return Response(e.body(), status=e.status_code)
            budget.check(now)  # 팀 전체 AI 비용 예산
            report = Report.objects.create(user=request.user, team=Report.STOCK_REPORT, symbol=item["symbol"],
                                           name=item["name"], market=item["market"], chaos=chaos_config,
                                           created_at=now)
        return Response(detail(report, request.user), status=status.HTTP_201_CREATED)


class QuotaView(APIView):
    @extend_schema(operation_id="reports_quota", responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """ReportQuota: 오늘(KST) 내 리포트 한도 {"limit", "used", "remaining", "resetsAt"} (D-7). 무제한이면 limit·remaining이 null."""
        used = quota.usage(request.user)
        return Response({"limit": used.limit, "used": used.used, "remaining": used.remaining,
                         "resetsAt": iso(used.resets_at)})


def visible(pk: int) -> Report:
    """지우지 않은 리포트 하나 (없거나 지웠으면 404)."""
    report = Report.objects.select_related("user").filter(pk=pk, deleted_at__isnull=True).first()
    if report is None:
        raise NotFound("리포트를 찾을 수 없습니다.")
    return report


class ReportDetailView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request, pk: int):
        """ReportDetail (Snapshot: 새로고침·연결 복구에 쓴다)."""
        return Response(detail(visible(pk), request.user))

    @extend_schema(responses={204: None})
    def delete(self, request, pk: int):
        """신청한 팀원이 끝난 리포트를 지운다 (숨김, 그 리포트의 추천도). 남의 것·자동 403, 끝나지 않음·진행 중 계획 400."""
        hide.delete_report(visible(pk), request.user)
        return Response(status=status.HTTP_204_NO_CONTENT)


class PdfView(APIView):
    @extend_schema(responses=OpenApiTypes.BINARY)
    def get(self, request, pk: int):
        """A4 PDF. 처음 부르면 만들어 PAPER_ROOT/reports/<id>.v<양식 판>.pdf에 두고 다음부터 그 파일을 준다
        (양식이 바뀌어 판이 오르면 예전 파일 대신 새로 만든다 — pdf.TEMPLATE_VERSION).
        Chrome이 없으면 같은 내용의 HTML(text/html). 완성 전(completed가 아님)이면 409. 선정 실행(stock_selection)이면 404.

        ?view=easy|expert (화면의 ?view와 같은 값, 앞뒤 공백·대소문자 무시): easy는 주린이모드 쉬운 판 `<id>.v<판>.easy.pdf`,
        expert는 자세한 판. 없으면 요청한 사람의 주린이모드(켬 → easy, docs/DECISIONS.md 20장). 그 밖의 값은 400 — 리포트를 찾기 전에 본다.
        Report.pdf_path는 자동 리포트가 Discord로 보낸 파일(쉬운 판)이다 — PDF API는 그 열을 쓰지 않는다 (쓰면 ?view=expert에도 쉬운 판이 나간다).
        """
        view = choice(request, "view", VIEWS, VIEW_CHOICE)
        report = visible(pk)
        if report.team == Report.STOCK_SELECTION:  # 종목 리포트 양식이 아니다 (선정 결과는 선별 표지 — auto.after_finish)
            raise NotFound("선정 실행은 PDF가 없습니다.")
        if report.status != Report.COMPLETED:
            return Response({"detail": "리포트가 아직 완성되지 않았습니다."}, status=status.HTTP_409_CONFLICT)
        easy = beginner_mode_of(request.user) if view is None else view == "easy"
        path = ensure_report_file(report, list(report.trace_events.order_by("step")), easy=easy)
        content_type = "application/pdf" if path.suffix == ".pdf" else "text/html; charset=utf-8"
        return FileResponse(open(path, "rb"), content_type=content_type)


class ScreeningView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """ScreeningResult: 그날(기본 오늘, KST)의 선별 결과 (reports/autoreport/auto.py가 남긴 파일). 없으면 404 (docs/tasks/01 T1-7)."""
        from .autoreport import auto  # 선별 파일 읽기 (선별 자체는 엔진 루프·관리 명령이 한다)

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


class RecoveryStatsView(APIView):
    @extend_schema(operation_id="reports_recovery_stats", responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """RecoveryStats: 최근 days일(기본 7, 1~90, 오늘 포함) 리포트의 호출 장애 자동 복구 지표 (담당 4, T4-7)."""
        from .autohealing import stats  # 셈법은 stats.py (docs/tasks/00-공통.md 9절)

        text = (request.query_params.get("days") or "7").strip()
        days = int(text) if text.isdecimal() else 0  # isdigit은 '²'도 참이라 int()가 실패한다
        if not 1 <= days <= stats.MAX_DAYS:
            raise Rejected(f"days는 1~{stats.MAX_DAYS} 사이의 정수입니다.")
        return Response(stats.recovery_stats(days))
