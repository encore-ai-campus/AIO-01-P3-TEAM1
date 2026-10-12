"""AI 리포트 응답 형식 (docs/API.md "AI 리포트" 타입: ReportSummary · ReportDetail · SharedState · TraceEvent). API와 SSE가 같이 쓴다."""
from datetime import datetime
from zoneinfo import ZoneInfo

from accounts.models import Profile
from autotrade import hide
from config import engine
from rest_framework import status
from rest_framework.exceptions import APIException

from .orchestration import registry
from .autohealing import stats
from .guardrails.contracts import ONE_LINER_MAX, OPINIONS
from .models import Report, TraceEvent

KST = ZoneInfo("Asia/Seoul")
AUTO_REQUESTER = "자동"               # 자동 리포트(신청자 없음)의 requestedBy


class PlanBroken(APIException):
    """YAML Registry가 잘못됨 (서버 설정 오류) → 500 {"detail"}."""
    status_code = status.HTTP_500_INTERNAL_SERVER_ERROR
    default_detail = "실행 계획이 잘못되었습니다."


def iso(value: datetime | None) -> str | None:
    return value.astimezone(KST).isoformat(timespec="seconds") if value else None


def plan(team: str = registry.TEAM) -> dict:
    """팀의 ExecutionPlan (기본은 종목 리포트). 모르는 팀은 부르기 전에 막는다 (여기서는 설정 오류로 500)."""
    try:
        return registry.execution_plan(team)
    except registry.PlanError as e:
        raise PlanBroken(f"실행 계획이 잘못되었습니다: {e}") from None


def nicknames() -> dict[int, str]:
    """사용자 번호 → 닉네임. 요청자를 아이디 대신 닉네임으로 보여 준다 (아이디는 로그인 정보라 다른 팀원에게 내지 않는다)."""
    return dict(Profile.objects.values_list("user_id", "nickname"))


def conclusion(report: Report) -> dict:
    """AI 의견과 한 줄 요약 {"opinion", "oneLiner"} (컨셉 계획 B3, docs/API.md "목록 카드의 결론", Claude 몫).

    status가 completed일 때만 results.report_agent의 verdict·oneLiner를 그대로 낸다. 대기·실행 중·실패면 둘 다 None
    (실행 중 초안은 검토 전이거나 RETRY로 다시 쓰이는 중이고, 실패한 리포트의 초안은 검토를 통과하지 않았다).
    출력 계약을 지난 값이지만 모양이 틀리면(모르는 의견·문자열이 아님·빈 문자열) 그 값만 None, 한 줄 요약은 80자까지.
    """
    results = report.results if isinstance(report.results, dict) else {}
    draft = results.get("report_agent") if report.status == Report.COMPLETED else None
    if not isinstance(draft, dict):
        return {"opinion": None, "oneLiner": None}
    verdict, line = draft.get("verdict"), draft.get("oneLiner")
    return {"opinion": verdict if verdict in OPINIONS else None,
            "oneLiner": (line.strip()[:ONE_LINER_MAX] or None) if isinstance(line, str) else None}


def requester(report: Report, names: dict[int, str]) -> str:
    """신청한 팀원의 닉네임 (없으면 아이디). 자동 리포트이거나 신청자가 없으면 "자동"."""
    if report.source == Report.AUTO or report.user_id is None:
        return AUTO_REQUESTER
    return names.get(report.user_id) or report.user.get_username()


def chaos_enabled(report: Report) -> bool:
    """장애 주입을 켜고 신청했는지."""
    return isinstance(report.chaos, dict) and report.chaos.get("enabled") is True


def has_pdf(report: Report) -> bool:
    """만든 PDF(Chrome이 없으면 HTML) 파일이 pdf_path에 있는지. pdf_path는 PAPER_ROOT 기준 상대 경로."""
    return bool(report.pdf_path) and (engine.ROOT / report.pdf_path).is_file()


def summary(report: Report, names: dict[int, str] | None = None, user=None) -> dict:
    """ReportSummary. report.user를 쓰므로 목록은 select_related("user")로 읽는다. canDelete는 user가 지울 수 있는지 (autotrade/hide.py).

    team은 "stock_report"(종목 리포트) | "stock_selection"(하루 한 번의 매매 종목 선정 실행 — opinion·oneLiner는 늘 None).
    """
    names = nicknames() if names is None else names
    return {
        "id": report.id, "symbol": report.symbol, "name": report.name, "market": report.market,
        "status": report.status, "currentStep": report.current_step,
        "source": report.source, "team": report.team, "requestedBy": requester(report, names),
        "chaosEnabled": chaos_enabled(report), "costUsd": report.cost_usd, "hasPdf": has_pdf(report),
        "canDelete": user is not None and hide.can_delete_report(report, user),
        **conclusion(report),  # B3 opinion·oneLiner (Claude). 담당 4의 새 필드는 이 위에 더한다 (docs/DECISIONS.md 14-2)
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


def detail(report: Report, user=None) -> dict:
    """ReportDetail (Snapshot): 요약 + 본문 + Shared State + Trace(step 오름차순) + 그 리포트 팀의 실행 계획."""
    events = list(report.trace_events.order_by("step"))
    return summary(report, user=user) | {
        "content": report.content, "state": shared_state(report),
        "trace": [trace_event(event) for event in events], "plan": plan(report.team),
        "chaos": report.chaos, "recovery": stats.report_recovery(events),
    }
