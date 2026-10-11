"""AI 분석 API (docs/API.md "AI 분석"): 분석 목록·상세, 분석 요청과 한도, 작업 상태."""
from datetime import datetime
from zoneinfo import ZoneInfo

from accounts.models import Profile
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone
from drf_spectacular.types import OpenApiTypes
from drf_spectacular.utils import extend_schema
from rest_framework import status
from rest_framework.exceptions import NotFound
from rest_framework.response import Response
from rest_framework.views import APIView

from config import engine
from config.api import LimitExceeded, Rejected, Unavailable, page
from reports.limits import budget

from . import index, quota
from .jobs import SYMBOL
from .models import AnalysisRun, Job

KST = ZoneInfo("Asia/Seoul")
MINE = ("1", "true")  # ?mine= 의 참 값


def iso(value: datetime | None) -> str | None:
    return value.astimezone(KST).isoformat(timespec="seconds") if value else None


def nicknames() -> dict[str, str]:
    """로그인 아이디 → 닉네임. 요청자를 아이디 대신 닉네임으로 보여 준다 (아이디는 로그인 정보라 다른 팀원에게 내지 않는다)."""
    return dict(Profile.objects.values_list("user__username", "nickname"))


def summary(run: AnalysisRun, names: dict[str, str] | None = None) -> dict:
    """AnalysisSummary. requestedBy는 팀원이면 닉네임, 그 밖("cli", "strategy:<번호>")은 그대로.

    priceAtAnalysis는 분석 시각의 가격(엔진 스냅숏의 그때 가격)이다 — 장마감 기준이 아닌 일부러 둔 예외라
    화면이 "분석 시각 가격"으로 적는다 (docs/API.md 공통 규칙 "장마감 기준"). 지표의 기준일은 상세의 dataAsOf.
    """
    names = nicknames() if names is None else names
    return {
        "id": run.id, "symbol": run.symbol, "name": run.name, "market": run.market, "currency": run.currency,
        "analyzedAt": iso(run.analyzed_at), "verdict": run.verdict, "priceAtAnalysis": run.price_at_analysis,
        "best": run.best, "scenarioCount": run.scenario_count,
        "requestedBy": names.get(run.requested_by, run.requested_by),
        "costUsd": run.cost_usd,
    }


def job_view(job: Job) -> dict:
    """Job."""
    return {"id": job.id, "type": job.type, "status": job.status, "result": job.result, "error": job.error,
            "createdAt": iso(job.created_at), "startedAt": iso(job.started_at), "finishedAt": iso(job.finished_at)}


class AnalysesView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """분석 목록 (팀 전체 공용, 최신순). 새 실행 기록을 먼저 색인한다."""
        index.refresh()
        runs = AnalysisRun.objects.order_by("-analyzed_at", "-id")
        symbol = (request.query_params.get("symbol") or "").strip().upper()
        if symbol:
            runs = runs.filter(symbol=symbol)
        verdict = (request.query_params.get("verdict") or "").strip().upper()
        if verdict:
            if verdict not in (AnalysisRun.BUY, AnalysisRun.PASS):
                raise Rejected("verdict는 BUY 또는 PASS입니다.")
            runs = runs.filter(verdict=verdict)
        if (request.query_params.get("mine") or "").strip().lower() in MINE:
            # 내가 요청한 분석만: 실행 기록에는 요청자의 로그인 아이디가 남는다 (전략·CLI 실행은 빠진다). 응답은 닉네임 그대로
            runs = runs.filter(requested_by=request.user.username)
        names = nicknames()
        return page(request, runs, lambda run: summary(run, names))

    @extend_schema(request=OpenApiTypes.OBJECT, responses={202: OpenApiTypes.OBJECT})
    def post(self, request):
        """분석 요청 → 202 {"jobId"}. 같은 종목을 이미 기다리거나 실행 중이면 그 작업 번호를 돌려준다."""
        symbol = request.data.get("symbol") if isinstance(request.data, dict) else None
        symbol = symbol.strip().upper() if isinstance(symbol, str) else ""
        if not SYMBOL.fullmatch(symbol):
            raise Rejected("종목코드 형식이 올바르지 않습니다 (국내 6자리 코드 또는 미국 티커).")
        reason = quota.unavailable_reason(engine.engine_config())
        if reason:
            raise Unavailable(reason)
        with transaction.atomic():
            # 같은 사용자의 동시 요청(두 번 누름)을 줄 세운다
            get_user_model().objects.select_for_update().filter(pk=request.user.pk).first()
            active = Job.objects.filter(user=request.user, type=Job.ANALYZE, status__in=(Job.QUEUED, Job.RUNNING))
            same = next((job for job in active.order_by("id") if job.payload.get("symbol") == symbol), None)
            if same is not None:
                return Response({"jobId": same.id}, status=status.HTTP_202_ACCEPTED)
            usage = quota.usage(request.user, budget.used_usd(timezone.now()))
            if usage.used >= usage.limit:
                raise LimitExceeded(f"오늘 분석 요청 한도({usage.limit}회)를 다 썼습니다.")
            if usage.team_left <= 0:  # 팀 전체 예산은 리포트와 같이 쓴다 (분석 예상 비용 + 리포트 실제 비용)
                raise LimitExceeded(f"오늘 팀 전체 AI 비용 예산(${quota.budget_usd()}, 분석·리포트 합)을 다 썼습니다.")
            job = Job.objects.create(user=request.user, type=Job.ANALYZE, payload={"symbol": symbol})
        return Response({"jobId": job.id}, status=status.HTTP_202_ACCEPTED)


class AnalysisDetailView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request, pk: int):
        """분석 상세. 실행 기록 파일이 없어졌으면 요약만 채우고 나머지는 빈 목록."""
        run = AnalysisRun.objects.filter(pk=pk).first()
        if run is None:
            raise NotFound("분석을 찾을 수 없습니다.")
        data = summary(run) | {"scenarios": [], "news": [], "newsItems": [], "newsProvider": index.NEWS_PROVIDER,
                               "dataAsOf": None, "research": [], "indicators": {}, "errors": []}
        entry = index.load_entry(run.run_file, run.symbol)
        if entry is not None:
            data |= index.details(entry)
        return Response(data)


class QuotaView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request):
        """AnalysisQuota."""
        usage = quota.usage(request.user, budget.used_usd(timezone.now()))
        return Response({
            "usedToday": usage.used, "limitPerUser": usage.limit, "remaining": usage.remaining,
            "estimatedCostUsd": float(quota.COST_PER_ANALYSIS_USD),
            "enabled": quota.unavailable_reason(engine.engine_config()) is None,
        })


class JobView(APIView):
    @extend_schema(responses=OpenApiTypes.OBJECT)
    def get(self, request, pk: int):
        """작업 상태. 남의 작업은 404."""
        job = Job.objects.filter(pk=pk, user=request.user).first()
        if job is None:
            raise NotFound("작업을 찾을 수 없습니다.")
        return Response(job_view(job))
