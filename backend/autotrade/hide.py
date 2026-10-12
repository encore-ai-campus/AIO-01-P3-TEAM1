"""리포트·계획 제안 지우기 (docs/API.md "리포트·계획 제안 지우기", docs/DECISIONS.md 25장).

지우기는 숨김이다: deleted_at을 적고 API에서 뺀다. 행은 남으므로 AI 비용·하루 리포트 한도·복구 통계는 그대로 센다 (지워도 한도는 돌아오지 않는다).
만든 팀원만 지운다 — 리포트는 신청한 팀원, 추천은 requested_by. 리포트와 그 추천은 같이 숨긴다 (분석·시연 추천은 추천만).
그 추천으로 진행 중인 계획이 있으면(누구 것이든) 지우지 않는다. 활성화(executor._start)도 추천 행을 잠그고 숨김을 확인하므로 둘이 엇갈리지 않는다.
DELETE /api/reports/{id}(reports.views)와 DELETE /api/recommendations/{id}(views)가 같이 쓴다 (reports.output.alerts처럼 reports가 이 모듈을 부른다).
"""
from datetime import datetime

from django.db import transaction
from django.utils import timezone
from reports.models import Report
from rest_framework.exceptions import PermissionDenied

from config.api import Rejected

from .models import Recommendation, TradePlan

NOT_MY_REPORT = "내가 신청한 리포트만 지울 수 있어요."
NOT_MY_RECOMMENDATION = "내가 만든 계획 제안만 지울 수 있어요."
NOT_FINISHED = "아직 만드는 중인 리포트는 끝난 뒤에 지울 수 있어요."
LIVE_PLANS = "이 계획 제안으로 진행 중인 모의 자동매매가 있어 지울 수 없어요. 계획이 끝난 뒤에 지울 수 있어요."


def _mine(report: Report, user) -> bool:
    return (report.user_id is not None and report.user_id == user.pk and report.source == Report.USER
            and report.team == Report.STOCK_REPORT)


def can_delete_report(report: Report, user) -> bool:
    """ReportSummary.canDelete: 내가 신청했고 끝난 종목 리포트 (자동 리포트·선정 실행은 신청자가 없다)."""
    return report.deleted_at is None and _mine(report, user) and report.status in Report.FINISHED


def can_delete_recommendation(rec: Recommendation, user) -> bool:
    """Recommendation.canDelete: 내가 만든(requested_by) 추천."""
    return rec.deleted_at is None and rec.requested_by_id is not None and rec.requested_by_id == user.pk


def delete_report(report: Report, user, now: datetime | None = None) -> None:
    """리포트와 그 추천을 숨긴다. 남의 것이면 403, 끝나지 않았거나 진행 중 계획이 있으면 400 (아무것도 바꾸지 않는다)."""
    if not _mine(report, user):
        raise PermissionDenied(NOT_MY_REPORT)
    if report.status not in Report.FINISHED:
        raise Rejected(NOT_FINISHED)
    _hide(report, Recommendation.objects.filter(report=report), now or timezone.now())


def delete_recommendation(rec: Recommendation, user, now: datetime | None = None) -> None:
    """추천을 숨긴다 (리포트 추천이면 출처 리포트와 그 리포트의 추천도). 남의 것이면 403, 진행 중 계획이 있으면 400."""
    if not can_delete_recommendation(rec, user):
        raise PermissionDenied(NOT_MY_RECOMMENDATION)
    report = rec.report if rec.report_id else None
    recs = Recommendation.objects.filter(report=report) if report else Recommendation.objects.filter(pk=rec.pk)
    _hide(report, recs, now or timezone.now())


def _hide(report: Report | None, recs, now: datetime) -> None:
    with transaction.atomic():
        ids = list(recs.select_for_update().filter(deleted_at__isnull=True).values_list("id", flat=True))
        if TradePlan.objects.filter(recommendation_id__in=ids, status__in=TradePlan.LIVE).exists():
            raise Rejected(LIVE_PLANS)
        Recommendation.objects.filter(id__in=ids).update(deleted_at=now)
        if report is not None:
            Report.objects.filter(pk=report.pk, deleted_at__isnull=True).update(deleted_at=now)
