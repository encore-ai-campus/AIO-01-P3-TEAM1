"""Shared State와 Trace를 바꾸는 유일한 경로 (docs/DECISIONS.md 9-4). Orchestrator만 부른다 (Worker는 결과만 돌려준다).

- 저장만 한다. Join·실패 정책·Handoff 같은 판단은 하지 않는다 (Orchestrator 몫, 아직 미구현).
- 함수마다 리포트 행을 잠그고(PostgreSQL select_for_update) DB의 최신 값에 고친 뒤, 넘겨받은 report 객체도 새 값으로 맞춘다.
- 순서: start(requested → running) → set_step · record · add_result · add_error · add_cost (running일 때만) → finish(completed|failed).
  끝난 리포트를 다시 바꾸려 하거나 값이 잘못되면 StateError. 끝난 뒤에는 Trace도 붙지 않는다 (SSE가 end를 보낸 뒤 빠지는 사건이 없다).
- 단계 id·Worker id는 리포트의 팀(report.team) 실행 계획으로 확인한다.
- 쓰기는 프로세스 안에서 한 번에 하나씩 한다 (_write_lock). 병렬 Worker 스레드와 호출기가 같이 불러도
  SQLite(공유 캐시·파일)가 "database table is locked"를 내지 않게 한다. PostgreSQL에서는 행 잠금이 그대로 지킨다.
"""
import threading
from functools import wraps

from django.db import IntegrityError, transaction
from django.db.models import Max
from django.utils import timezone

from . import registry
from ..models import Report, TraceEvent

RECORD_RETRIES = 5
TRACE_STATUSES = [value for value, _ in TraceEvent.STATUSES]
_write_lock = threading.RLock()


class StateError(ValueError):
    """상태를 바꿀 수 없음 (끝난 리포트, 순서 위반, 잘못된 값)."""


def _serialized(func):
    @wraps(func)
    def wrapper(*args, **kwargs):
        with _write_lock:
            return func(*args, **kwargs)
    return wrapper


@_serialized
def start(report: Report) -> Report:
    """requested → running. started_at을 남긴다."""
    with transaction.atomic():
        current = _locked(report, Report.REQUESTED)
        current.status, current.started_at = Report.RUNNING, timezone.now()
        current.save(update_fields=["status", "started_at"])
    return _sync(report, current)


@_serialized
def set_step(report: Report, step_id: str) -> Report:
    """지금 실행 중인 단계. 그 리포트 팀의 실행 계획(registry)에 있는 step id만."""
    if step_id not in _plan_ids(report, registry.step_ids):
        raise StateError(f"실행 계획에 없는 step id: {step_id}")
    with transaction.atomic():
        current = _locked(report, Report.RUNNING)
        current.current_step = step_id
        current.save(update_fields=["current_step"])
    return _sync(report, current)


@_serialized
def record(report: Report, actor: str, action: str, status: str, provider: str | None = None,
           model: str | None = None, latency_ms: int | None = None, details: dict | None = None) -> TraceEvent:
    """Trace 사건 하나를 남긴다. step은 리포트별 1부터 이어지고, 동시에 불러도 겹치지 않는다 (잠금 + 유일 제약 재시도).

    status는 started·completed·failed·blocked·skipped, details는 dict (오류와 추가 정보, JSON으로 저장할 수 있어야 한다).
    """
    for label, value in (("actor", actor), ("action", action)):
        if not isinstance(value, str) or not value:
            raise StateError(f"{label} 값이 없습니다.")
    if status not in TRACE_STATUSES:
        raise StateError(f"Trace status는 {', '.join(TRACE_STATUSES)} 중 하나입니다: {status}")
    if details is None:
        details = {}
    if not isinstance(details, dict):
        raise StateError("details는 dict여야 합니다.")
    if latency_ms is not None and (isinstance(latency_ms, bool) or not isinstance(latency_ms, int)):
        raise StateError("latency_ms는 정수(밀리초)여야 합니다.")
    for _ in range(RECORD_RETRIES):
        try:
            with transaction.atomic():
                current = _locked(report, Report.RUNNING)
                return TraceEvent.objects.create(
                    report=current, step=_next_step(current), actor=actor, action=action, status=status,
                    provider=provider, model=model, latency_ms=latency_ms, details=details, at=timezone.now())
        except IntegrityError:  # 같은 step을 다른 쪽이 먼저 썼다 → 번호를 다시 구한다
            continue
    raise StateError(f"Trace step 번호를 정하지 못했습니다 (리포트 #{report.pk}).")


@_serialized
def add_result(report: Report, agent: str, result) -> Report:
    """results[agent]에 결과를 넣고 completed_agents에 더한다 (같은 Worker를 다시 넣으면 결과만 바뀐다).

    출력 계약 검증은 부르는 쪽(Orchestrator) 몫이다. 계약을 통과한 결과만 넘긴다. result는 JSON으로 저장할 수 있어야 한다.
    """
    _check_agent(report, agent)
    with transaction.atomic():
        current = _locked(report, Report.RUNNING)
        current.results = {**current.results, agent: result}
        if agent not in current.completed_agents:
            current.completed_agents = [*current.completed_agents, agent]
        current.save(update_fields=["results", "completed_agents"])
    return _sync(report, current)


@_serialized
def add_error(report: Report, agent: str, message: str) -> Report:
    """errors[agent]에 오류 메시지를 넣고 failed_agents에 더한다."""
    _check_agent(report, agent)
    if not isinstance(message, str) or not message:
        raise StateError("오류 메시지가 비어 있습니다.")
    with transaction.atomic():
        current = _locked(report, Report.RUNNING)
        current.errors = {**current.errors, agent: message}
        if agent not in current.failed_agents:
            current.failed_agents = [*current.failed_agents, agent]
        current.save(update_fields=["errors", "failed_agents"])
    return _sync(report, current)


@_serialized
def add_cost(report: Report, usd: float) -> Report:
    """이 리포트의 LLM 비용 합(cost_usd)에 usd를 더한다 (Worker 하나가 끝날 때마다, 실패한 Worker의 비용도)."""
    if isinstance(usd, bool) or not isinstance(usd, (int, float)) or usd < 0 or usd != usd or usd == float("inf"):
        raise StateError(f"비용은 0 이상의 숫자여야 합니다: {usd!r}")
    with transaction.atomic():
        current = _locked(report, Report.RUNNING)
        current.cost_usd = (current.cost_usd or 0) + float(usd)
        current.save(update_fields=["cost_usd"])
    return _sync(report, current)


@_serialized
def finish(report: Report, status: str, content: str | None = None) -> Report:
    """전체 종료 (completed|failed). finished_at을 남기고 current_step을 비운다. content는 리포트 본문 (Markdown).

    시작 전(requested)에도 끝낼 수 있다 (예: 실행 전에 실패로 처리).
    """
    if status not in Report.FINISHED:
        raise StateError(f"종료 상태는 {' 또는 '.join(Report.FINISHED)}입니다: {status}")
    if content is not None and not isinstance(content, str):
        raise StateError("content는 문자열(Markdown)이어야 합니다.")
    with transaction.atomic():
        current = _locked(report, *Report.ACTIVE)
        current.status, current.finished_at, current.current_step = status, timezone.now(), None
        if content is not None:
            current.content = content
        current.save(update_fields=["status", "finished_at", "current_step", "content"])
    return _sync(report, current)


def _locked(report: Report, *allowed: str) -> Report:
    """DB의 최신 행을 잠가 읽고 상태를 확인한다. 트랜잭션 안에서 부른다."""
    current = Report.objects.select_for_update().filter(pk=report.pk).first()
    if current is None:
        raise StateError(f"리포트 #{report.pk}가 없습니다.")
    if current.status in Report.FINISHED:
        raise StateError(f"끝난 리포트(#{current.pk}, {current.status})는 바꿀 수 없습니다.")
    if current.status not in allowed:
        raise StateError(f"리포트 #{current.pk}는 {current.status} 상태라 이 작업을 할 수 없습니다 "
                         f"({' 또는 '.join(allowed)}일 때만).")
    return current


def _next_step(report: Report) -> int:
    return (report.trace_events.aggregate(last=Max("step"))["last"] or 0) + 1


def _plan_ids(report: Report, ids) -> list[str]:
    try:
        return ids(report.team)
    except registry.PlanError as e:
        raise StateError(f"리포트 #{report.pk}의 팀 실행 계획을 읽을 수 없습니다: {e}") from None


def _check_agent(report: Report, agent: str) -> None:
    if agent not in _plan_ids(report, registry.worker_ids):
        raise StateError(f"실행 계획에 없는 Worker: {agent}")


def _sync(report: Report, current: Report) -> Report:
    """넘겨받은 객체를 DB 값으로 맞춘다 (부르는 쪽이 같은 객체를 계속 쓴다)."""
    for field in ("status", "current_step", "results", "errors", "completed_agents", "failed_agents", "content",
                  "cost_usd", "started_at", "finished_at"):
        setattr(report, field, getattr(current, field))
    return report
