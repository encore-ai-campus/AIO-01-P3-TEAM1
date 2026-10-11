"""팀 전체 AI 하루 비용 예산: 분석 예상 비용 + 리포트 실제 비용 (KST 기준)."""

from datetime import datetime
from decimal import Decimal, InvalidOperation

from analysis import quota as analysis_quota
from analysis.models import Job
from config.api import LimitExceeded

from ..models import Report
from .quota import day_range


def daily_limit() -> Decimal:
    """분석 한도와 동일한 AI_DAILY_BUDGET_USD 설정을 사용한다."""
    try:
        value = Decimal(analysis_quota._env("AI_DAILY_BUDGET_USD") or analysis_quota.DEFAULT_BUDGET_USD)
    except InvalidOperation:
        value = analysis_quota.DEFAULT_BUDGET_USD
    if not value.is_finite():
        value = analysis_quota.DEFAULT_BUDGET_USD
    return max(value, Decimal(0))


def used_usd(now: datetime) -> Decimal:
    """시작 전에 실패한 분석만 빼고, 실패한 리포트도 실제 발생 비용은 센다."""
    start, end = day_range(now)
    analyses = (Job.objects.filter(type=Job.ANALYZE, created_at__gte=start, created_at__lt=end)
                .exclude(status=Job.FAILED, started_at__isnull=True).count())
    total = analyses * analysis_quota.COST_PER_ANALYSIS_USD
    # 사용자·자동 리포트와 성공·실패 여부에 관계없이 실제 저장된 비용을 합산한다.
    reports = Report.objects.filter(created_at__gte=start, created_at__lt=end)
    for report in reports:
        cost = report.cost_usd
        if cost is not None:
            amount = Decimal(str(cost))
            if amount.is_finite() and amount > 0:
                total += amount
    return total


def check(now: datetime) -> None:
    """예산을 이미 소진했으면 새 리포트 신청을 429로 막는다."""
    if used_usd(now) >= daily_limit():
        raise LimitExceeded("오늘 AI 비용 예산을 다 썼어요. 내일 0시에 다시 신청할 수 있어요.")
