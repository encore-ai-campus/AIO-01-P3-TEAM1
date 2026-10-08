"""리포트 실행기. run_engine이 매 바퀴 호출하며 대기 신청의 만료와 실행을 맡는다."""

from __future__ import annotations

import logging
import threading
from datetime import timedelta

from django.db import connections, transaction
from django.utils import timezone

from . import orchestrator, state
from .models import Report

MAX_CONCURRENT = 1
SHUTDOWN_TIMEOUT_SEC = 10
REQUEST_MAX_AGE = timedelta(hours=24)
log = logging.getLogger(__name__)
_lock = threading.Lock()
_worker: threading.Thread | None = None


def tick() -> int | None:
    """24시간 지난 신청을 실패로 끝내고 유효한 신청 한 건을 실행한다."""
    global _worker
    with _lock:
        if _worker is not None and _worker.is_alive():
            return None
        if Report.objects.filter(status=Report.RUNNING).exists():
            return None
        cutoff = timezone.now() - REQUEST_MAX_AGE
        while expired := _expire_one(cutoff):
            _after_finish(expired)
        with transaction.atomic():
            if Report.objects.filter(status=Report.RUNNING).exists():
                return None
            report = (Report.objects.select_for_update(skip_locked=True)
                      .filter(status=Report.REQUESTED).order_by("created_at", "pk").first())
            if report is None:
                return None
            state.start(report)
        _worker = threading.Thread(target=_work, args=(report.pk,), name=f"report-{report.pk}", daemon=True)
        _worker.start()
        return report.pk


def _expire_one(cutoff) -> Report | None:
    """잠금으로 잡은 만료 신청 한 건만 실패 처리한다. 경계 시각은 아직 유효하다."""
    with transaction.atomic():
        report = (Report.objects.select_for_update(skip_locked=True)
                  .filter(status=Report.REQUESTED, created_at__lt=cutoff)
                  .order_by("created_at", "pk").first())
        if report is None:
            return None
        state.start(report)
        state.record(report, "orchestrator", "workflow_failed", "failed", details={
            "reason": "expired", "costUsd": report.cost_usd, "durationMs": 0,
        })
        state.finish(report, Report.FAILED)
        return report


def recover() -> int:
    """재시작 전 실행 중이던 리포트를 실패로 마감한다."""
    recovered = 0
    for report in Report.objects.filter(status=Report.RUNNING).order_by("pk"):
        try:
            state.record(report, "orchestrator", "workflow_failed", "failed", details={
                "reason": "engine_restarted", "costUsd": report.cost_usd, "durationMs": 0,
            })
            state.finish(report, Report.FAILED)
            _after_finish(report)
            recovered += 1
        except Exception:
            log.exception("리포트 #%s 복구 정리 실패", report.pk)
    return recovered


def shutdown() -> None:
    """현재 실행 스레드를 최대 10초 기다린다."""
    with _lock:
        worker = _worker
    if worker is not None and worker.is_alive():
        worker.join(SHUTDOWN_TIMEOUT_SEC)


def _work(report_id: int) -> None:
    try:
        report = Report.objects.get(pk=report_id)
        result = orchestrator.run_report(report)
        if result.status in Report.FINISHED:
            _after_finish(result)
    except Exception:
        log.exception("리포트 #%s 실행 실패", report_id)
        try:
            report = Report.objects.get(pk=report_id)
            if report.status == Report.RUNNING:
                state.record(report, "orchestrator", "workflow_failed", "failed", details={
                    "reason": "exception", "costUsd": report.cost_usd, "durationMs": 0,
                })
                state.finish(report, Report.FAILED)
                _after_finish(report)
        except Exception:
            log.exception("리포트 #%s 실패 상태 저장 실패", report_id)
    finally:
        connections.close_all()


def _after_finish(report: Report) -> None:
    try:
        from . import auto
    except ImportError:
        return
    callback = getattr(auto, "after_finish", None)
    if callback is not None:
        try:
            callback(report)
        except Exception:
            log.exception("리포트 #%s 종료 후 처리 실패", report.pk)
