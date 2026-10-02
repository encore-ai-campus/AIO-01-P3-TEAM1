"""AI 리포트 응답 형식 (docs/API.md "AI 리포트" 타입: ReportSummary · ReportDetail · SharedState · TraceEvent). API와 SSE가 같이 쓴다."""
from datetime import datetime
from zoneinfo import ZoneInfo

from accounts.models import Profile
from rest_framework import status
from rest_framework.exceptions import APIException

from . import registry
from .models import Report, TraceEvent

KST = ZoneInfo("Asia/Seoul")


class PlanBroken(APIException):
    """YAML Registry가 잘못됨 (서버 설정 오류) → 500 {"detail"}."""
    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    default_detail = "실행 계획이 잘못되었습니다."


def iso(value: datetime | None) -> str | None:
    return value.astimezone(KST).isoformat(timespec="seconds") if value else None


def plan() -> dict:
    """ExecutionPlan."""
    try:
        return registry.execution_plan()
    except registry.PlanError as e:
        raise PlanBroken(f"실행 계획이 잘못되었습니다: {e}") from None


def nicknames() -> dict[int, str]:
    """사용자 번호 → 닉네임. 요청자를 아이디 대신 닉네임으로 보여 준다 (아이디는 로그인 정보라 다른 팀원에게 내지 않는다)."""
    return dict(Profile.objects.values_list("user_id", "nickname"))


def summary(report: Report, names: dict[int, str] | None = None) -> dict:
    """ReportSummary. report.user를 쓰므로 목록은 select_related("user")로 읽는다."""
    names = nicknames() if names is None else names
    return {
        "id": report.id, "symbol": report.symbol, "name": report.name, "market": report.market,
        "status": report.status, "currentStep": report.current_step,
        "requestedBy": names.get(report.user_id) or report.user.get_username(),
        "createdAt": iso(report.created_at), "startedAt": iso(report.started_at), "finishedAt": iso(report.finished_at),
    }


def shared_state(report: Report) -> dict:
    """SharedState."""
    return {
        "taskId": f"report-{report.id}", "status": report.status, "currentStep": report.current_step,
        "results": report.results, "errors": report.errors,
        "completedAgents": report.completed_agents, "failedAgents": report.failed_agents,
    }


def trace_event(event: TraceEvent) -> dict:
    """TraceEvent."""
    return {
        "step": event.step, "actor": event.actor, "action": event.action, "status": event.status,
        "provider": event.provider, "model": event.model, "latencyMs": event.latency_ms, "details": event.details,
        "at": iso(event.at),
    }


def detail(report: Report) -> dict:
    """ReportDetail (Snapshot): 요약 + 본문 + Shared State + Trace(step 오름차순) + 실행 계획."""
    return summary(report) | {
        "content": report.content, "state": shared_state(report),
        "trace": [trace_event(event) for event in report.trace_events.order_by("step")], "plan": plan(),
    }
