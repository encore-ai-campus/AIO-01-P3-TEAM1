"""AI 리포트 실행기 (docs/tasks/00-공통.md 8절, 03-orchestrator.md T3-4·T3-12). run_engine 루프가 매 바퀴 tick()을 부른다.

requested 리포트를 오래된 것부터 하나 잡아 백그라운드 스레드에서 orchestrator.run_report로 끝까지 돌린다.
동시에 하나만 돈다 (MAX_CONCURRENT — LLM 비용 상한). 끝난 리포트마다 reports.autoreport.auto.after_finish(report)를 부른다
(자동 리포트의 PDF·Discord. 담당 1 — 없으면 건너뛴다). 팀원 리포트의 끝 알림은 run_engine의 "리포트 알림"(alerts)이 보낸다.
엔진 루프는 하나만 돈다는 전제다: 뜰 때 recover()가 이전 실행이 남긴 running 리포트를 engine_restarted로 끝낸다.
STALE_REQUEST_HOURS보다 오래 기다린 requested는 실행하지 않고 expired로 끝낸다 (실행기를 처음 켜거나 엔진이 오래 꺼져 있던 뒤
묵은 신청이 실제 LLM 비용으로 한꺼번에 돌지 않게 — 계획서 Q5, docs/DECISIONS.md 19장). 신청한 팀원은 실패 알림으로 다시 만들 수 있다.
"""
import logging
import threading
from datetime import timedelta

from django.db import connections, transaction
from django.utils import timezone

from . import orchestrator, state
from ..models import Report

MAX_CONCURRENT = 1      # 동시에 도는 리포트 수 (이 모듈은 스레드 하나만 둔다)
SHUTDOWN_WAIT_SEC = 10  # 엔진을 끌 때 도는 리포트를 기다리는 시간
STALE_REQUEST_HOURS = 24  # 이보다 오래 기다린 requested는 실행하지 않는다 (expired)

log = logging.getLogger(__name__)
_worker: threading.Thread | None = None  # 지금 도는 리포트 스레드 (테스트·--once가 기다릴 때 쓴다)


def running() -> bool:
    return _worker is not None and _worker.is_alive()


def tick() -> int:
    """도는 리포트가 없으면 가장 오래된 requested 하나를 스레드로 시작한다. 시작한 수(0|1). 예외를 내지 않고, 일이 없으면 조용하다."""
    global _worker
    if running():  # MAX_CONCURRENT = 1. SQLite는 select_for_update를 무시하므로 이것이 같은 리포트를 두 번 잡지 않게 한다
        return 0
    try:
        expire_stale()
        report_id = _claim()
    except Exception:
        log.exception("리포트 실행 대기열 확인 실패")
        return 0
    if report_id is None:
        return 0
    _worker = threading.Thread(target=_run, args=(report_id,), name=f"report-{report_id}", daemon=True)
    _worker.start()
    return 1


def run_next() -> int | None:
    """가장 오래된 requested 리포트 하나를 부른 스레드에서 끝까지 돌린다 (엔진 루프 없이 — manage.py auto_report --wait·시연).
    돌린 리포트 id, 없으면 None. 끝난 뒤 after_finish도 부른다. 상주 엔진 루프와 같이 쓰지 않는다."""
    report_id = _claim()
    if report_id is not None:
        _execute(report_id)
    return report_id


def recover() -> int:
    """엔진 루프를 시작할 때 부른다. running으로 남은 리포트(주인 없는 실행)를 engine_restarted로 끝내고 그 수를 돌려준다."""
    count = 0
    for report in Report.objects.filter(status=Report.RUNNING).order_by("created_at", "id"):
        try:
            state.record(report, orchestrator.ORCHESTRATOR, "workflow_failed", "failed",
                         details={"reason": orchestrator.ENGINE_RESTARTED})
            state.finish(report, Report.FAILED)
        except Exception:
            log.exception("리포트 #%s를 엔진 재시작으로 정리하지 못함", report.pk)
            continue
        count += 1
        _after_finish(report)
    return count


def expire_stale(now=None) -> int:
    """STALE_REQUEST_HOURS보다 오래 기다린 requested 리포트를 실행하지 않고 실패(사유 expired)로 끝낸다. 끝낸 수."""
    cutoff = (now or timezone.now()) - timedelta(hours=STALE_REQUEST_HOURS)
    count = 0
    for report in Report.objects.filter(status=Report.REQUESTED, created_at__lt=cutoff).order_by("created_at", "id"):
        try:
            state.start(report)
            state.record(report, orchestrator.ORCHESTRATOR, "workflow_failed", "failed",
                         details={"reason": orchestrator.EXPIRED, "staleHours": STALE_REQUEST_HOURS})
            state.finish(report, Report.FAILED)
        except Exception:  # 다른 쪽이 먼저 시작했거나 끝냈으면 건너뛴다
            log.exception("오래 기다린 리포트 #%s를 정리하지 못함", report.pk)
            continue
        count += 1
        _after_finish(report)
    return count


def shutdown(timeout: float = SHUTDOWN_WAIT_SEC) -> None:
    """엔진 루프를 끝낼 때 부른다. 도는 리포트를 timeout초까지 기다린다 (못 끝나면 다음 시작의 recover()가 정리한다)."""
    worker = _worker
    if worker is not None and worker.is_alive():
        worker.join(timeout)
        if worker.is_alive():
            log.warning("리포트 실행(%s)이 %s초 안에 끝나지 않았습니다. 다음 시작 때 정리합니다.", worker.name, timeout)


def wait(timeout: float | None = None) -> None:
    """도는 리포트가 끝날 때까지 기다린다 (run_engine --once)."""
    worker = _worker
    if worker is not None and worker.is_alive():
        worker.join(timeout)


def _claim() -> int | None:
    """가장 오래된 requested 리포트의 id (다른 프로세스가 잠근 행은 건너뛴다). 실제 시작(requested → running)은 state.start가 한다."""
    with transaction.atomic():
        report = (Report.objects.select_for_update(skip_locked=True).filter(status=Report.REQUESTED)
                  .order_by("created_at", "id").only("id").first())
    return None if report is None else report.pk


def _run(report_id: int) -> None:
    try:
        _execute(report_id)
    finally:
        connections.close_all()  # 이 스레드의 DB 연결


def _execute(report_id: int) -> None:
    try:
        report = Report.objects.filter(pk=report_id).first()
        if report is None:
            return
        orchestrator.run_report(report)
        if report.status in Report.FINISHED:  # 이 실행이 끝낸 리포트만 (다른 쪽이 먼저 시작했으면 건너뛴다)
            _after_finish(report)
    except Exception:
        log.exception("리포트 #%s 실행 실패", report_id)


def _after_finish(report: Report) -> None:
    """자동 리포트의 끝 처리(reports.autoreport.auto.after_finish, 담당 1). 없으면 건너뛰고, 예외는 로그만 남긴다."""
    try:
        from ..autoreport import auto

        hook = getattr(auto, "after_finish", None)
        if hook is not None:
            hook(report)
    except Exception:
        log.exception("리포트 #%s 끝 처리(after_finish) 실패", report.pk)
