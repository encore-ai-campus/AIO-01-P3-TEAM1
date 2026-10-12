"""리포트 끝 알림 (컨셉 계획 B7 — docs/API.md "리포트 끝 알림", docs/DECISIONS.md 14-5). Claude 파일.

리포트 하나가 끝나면 신청자에게 알림이 한 번만 간다 (웹 알림 + Discord, notifications.service.notify):
- 완성(completed): 이 리포트로 추천이 있으면(먼저 autotrade.recommend.sources.from_report로 만들 수 있으면 만든다) 따로 보내지 않는다 —
  추천 알림(recommendation) 본문의 첫 줄 "리포트가 완성됐어요"가 그 역할이다. 추천이 없으면 report_completed (link /reports/{id}).
- 실패(failed, 엔진 재시작 정리 포함): report_failed (link /reports/{id}). 본문은 Trace의 마지막 workflow_failed.details.reason의
  쉬운 문장 (reports/output/text.py — 없거나 모르는 코드면 "리포트를 만들지 못했어요. 다시 만들 수 있어요").
- 자동 리포트(source "auto". 열이 없으면 "user"로 본다)는 건너뛴다 (팀 몫 — 팀 파일 auto.py의 after_finish).
- 종목 리포트(team "stock_report")만 본다. 매매 종목 선정 실행(stock_selection)은 source와 상관없이 건너뛴다
  (선정 결과는 auto.tick이 처리한다. 신청자가 없는 행에 보내면 팀 전체에 매 바퀴 다시 갈 수 있다).
- 중복 방지: 같은 사용자에게 같은 kind·같은 link의 알림이 이미 있으면 보내지 않는다 (두 경로가 겹치거나 엔진이 다시 떠도 한 번).

보내는 자리는 둘이다 — 팀 코드(runner)가 끝낸 뒤 부를 수 있는 notify_finished와, run_engine의 "리포트 알림" 단계(추천 수집 다음)가
매 바퀴 부르는 sweep_finished. 팀 코드가 notify_finished를 부르지 않아도 엔진 루프 한 바퀴 안에 간다.
"""
import logging
import threading
from datetime import datetime, timedelta

from autotrade.recommend import sources
from autotrade.models import Recommendation
from django.utils import timezone
from notifications.models import Notification

from . import text
from ..models import Report, TraceEvent

logger = logging.getLogger(__name__)

SWEEP_WINDOW = timedelta(hours=24)  # sweep이 보는 범위: 최근 24시간 안에 끝난 리포트
COMPLETED, FAILED = "report_completed", "report_failed"
AUTO = "auto"
_lock = threading.Lock()  # runner 스레드의 notify_finished와 엔진 루프의 sweep이 같은 리포트를 동시에 보내지 않게


def link_of(report: Report) -> str:
    return f"/reports/{report.id}"


def notify_finished(report) -> None:
    """끝난 리포트 하나(reports.models.Report)를 바로 처리한다. 예외를 밖으로 내지 않는다."""
    try:
        _handle(report, timezone.now())
    except Exception:  # 알림 실패가 리포트 실행을 막지 않게
        logger.exception("리포트 #%s 끝 알림 실패", getattr(report, "pk", None))


def sweep_finished(now: datetime, log) -> int:
    """최근 24시간 안에 끝난 리포트 중 아직 알림이 없는 것을 처리하고 보낸 알림 수를 돌려준다.

    이번에 만든 추천의 알림(recommendation)도 보낸 수에 센다. 한 리포트의 오류가 나머지를 막지 않는다.
    """
    reports = (Report.objects.filter(team=Report.STOCK_REPORT, status__in=Report.FINISHED,
                                     finished_at__gte=now - SWEEP_WINDOW, deleted_at__isnull=True)
               .select_related("user").order_by("id"))
    sent = 0
    for report in reports:
        try:
            if _handle(report, now):
                sent += 1
        except Exception as e:  # 한 건의 문제가 다른 리포트의 알림을 막지 않게
            log(f"[리포트 알림] 리포트 #{report.id} 알림 실패: {type(e).__name__}: {e}")
    if sent:
        log(f"[리포트 알림] 끝난 리포트 알림 {sent}개")
    return sent


def _handle(report: Report, now: datetime) -> bool:
    """끝난 리포트 하나 → 알림 (보냈으면 True). 대상이 아니거나 이미 보냈으면 False."""
    if report.status not in Report.FINISHED or getattr(report, "source", "user") == AUTO:
        return False
    if report.team != Report.STOCK_REPORT:  # 선정 실행은 종목 리포트가 아니다
        return False
    if report.user_id is None:  # 신청자가 없으면 보낼 사람이 없다 (notify(None)은 팀 전체이고, 중복 확인도 맞지 않아 매 바퀴 다시 간다)
        return False
    with _lock:
        if report.status == Report.COMPLETED:
            return _completed(report, now)
        return _failed(report)


def _sent(report: Report, kind: str) -> bool:
    return Notification.objects.filter(user=report.user_id, kind=kind, link=link_of(report)).exists()


def _completed(report: Report, now: datetime) -> bool:
    if Recommendation.objects.filter(report=report).exists():
        return False  # 추천 알림이 완성 알림을 대신한다 (이미 보냈다)
    if sources.from_report(report, now) is not None:
        return True  # 지금 만든 추천의 알림 (본문 첫 줄 "리포트가 완성됐어요")
    if Recommendation.objects.filter(report=report).exists():
        return False  # 그사이 다른 쪽(추천 수집)이 만들었다
    if _sent(report, COMPLETED):
        return False
    results = report.results if isinstance(report.results, dict) else {}
    draft = results.get("report_agent")
    verdict = str(draft.get("verdict", "")).lower() if isinstance(draft, dict) else None
    notice = text.completed(report.name, report.symbol, verdict)
    return bool(notice.send(report.user, COMPLETED, link=link_of(report)))


def _failed(report: Report) -> bool:
    if _sent(report, FAILED):
        return False
    notice = text.failed(report.name, report.symbol, failure_reason(report))
    return bool(notice.send(report.user, FAILED, link=link_of(report)))


def failure_reason(report: Report) -> str | None:
    """Trace의 마지막 workflow_failed 사건의 details.reason (없으면 None)."""
    event = (TraceEvent.objects.filter(report=report, action="workflow_failed").order_by("-step").first())
    reason = event.details.get("reason") if event is not None and isinstance(event.details, dict) else None
    return reason if isinstance(reason, str) else None
