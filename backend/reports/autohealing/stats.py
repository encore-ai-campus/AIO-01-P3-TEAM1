"""장애·복구 요약과 복구 지표 (docs/tasks/04-autohealing.md T4-7, docs/API.md `RecoverySummary`·`RecoveryStats`).

셈법은 docs/tasks/00-공통.md 9절 (화면 frontend/src/lib/recovery.ts와 같은 규칙 — 바꾸면 둘 다 고친다):
- Worker의 실행(run) = 그 actor의 agent_started부터 다음 agent_completed 또는 포기(agent_failed, final이 false가 아님)까지.
- 장애 1건 = 한 run 안의 첫 agent_failed(final: false). 같은 run의 뒤 실패는 같은 건의 시도다.
- 복구됨 = 그 run이 agent_completed로 끝남. 복구 시간 = agent_completed.at − 첫 agent_failed.at. 포기로 끝나면 복구 못 함.
- 아직 끝나지 않은 run의 장애는 장애 건수에만 든다 (복구도 포기도 아니다).
- injected = 그 건의 첫 실패가 주입이면 true.
이 셈법의 자동 복구율 이름은 **호출 장애 자동 복구율**이다 (DR 결과표의 시나리오 자동 복구율과 다르다).
"""
from collections import Counter
from datetime import datetime, timedelta

from django.utils import timezone

from ..models import Report, TraceEvent

ERROR_TYPES = ("timeout", "server_error", "bad_output", "unknown")
RECENT = 20
MAX_DAYS = 90
ACTIONS = ("agent_started", "agent_failed", "agent_completed")  # 셈에 쓰는 사건


def _details(event: TraceEvent) -> dict:
    return event.details if isinstance(event.details, dict) else {}


def _error_type(details: dict) -> str:
    value = details.get("errorType")
    return value if value in ERROR_TYPES else "unknown"


def incidents(events) -> list[dict]:
    """리포트 하나의 Trace(step 순서) → 장애 건 목록 (첫 실패 순서).
    {"worker", "errorType", "injected", "recovered": True·False·None(진행 중), "recoveryMs", "at": 첫 실패 시각, "model": 최종 답한 모델}."""
    found: list[dict] = []
    open_runs: dict[str, dict] = {}   # actor → 이번 run의 장애 (첫 실패가 있을 때만)
    for event in sorted(events, key=lambda e: e.step):
        details = _details(event)
        if event.action == "agent_started":
            open_runs.pop(event.actor, None)
        elif event.action == "agent_failed" and details.get("final") is False:
            if event.actor not in open_runs:
                incident = {"worker": event.actor, "errorType": _error_type(details),
                            "injected": details.get("injected") is True, "recovered": None, "recoveryMs": None,
                            "at": event.at, "model": None}
                open_runs[event.actor] = incident
                found.append(incident)
        elif event.action == "agent_completed":
            incident = open_runs.pop(event.actor, None)
            if incident is not None:
                incident["recovered"] = True
                incident["recoveryMs"] = max(int((event.at - incident["at"]).total_seconds() * 1000), 0)
                incident["model"] = event.model
        elif event.action == "agent_failed":  # final이 false가 아니면 포기
            incident = open_runs.pop(event.actor, None)
            if incident is not None:
                incident["recovered"] = False
    return found


def report_recovery(events) -> dict:
    """RecoverySummary: 리포트 하나의 장애·복구 요약."""
    events = sorted(events, key=lambda e: e.step)
    found = incidents(events)
    done = [i for i in found if i["recovered"]]
    models = {}
    for event in events:
        if event.action == "agent_completed" and event.model:
            models[event.actor] = event.model  # Worker id → 최종적으로 답한 모델
    return {"failures": len(found), "recovered": len(done),
            "unrecovered": sum(1 for i in found if i["recovered"] is False),
            "injected": sum(1 for i in found if i["injected"]),
            "recoveryMs": sum(i["recoveryMs"] for i in done) if done else None, "models": models}


def recovery_stats(days: int, now: datetime | None = None) -> dict:
    """RecoveryStats: 최근 days일(오늘 포함, KST 날짜) 안에 만든 리포트의 장애·복구 지표. 쿼리 두 번 (리포트·사건)."""
    from ..payloads import KST, iso  # payloads가 이 모듈을 쓰므로 함수 안에서

    if isinstance(days, bool) or not isinstance(days, int) or not 1 <= days <= MAX_DAYS:
        raise ValueError(f"days는 1~{MAX_DAYS}입니다.")
    today = (now or timezone.now()).astimezone(KST).date()
    first = today - timedelta(days=days - 1)
    start = datetime(first.year, first.month, first.day, tzinfo=KST)
    end = datetime(today.year, today.month, today.day, tzinfo=KST) + timedelta(days=1)
    reports = {r.id: r for r in Report.objects.filter(created_at__gte=start, created_at__lt=end).only("id", "symbol")}
    by_report: dict[int, list[TraceEvent]] = {rid: [] for rid in reports}
    for event in TraceEvent.objects.filter(report_id__in=list(reports), action__in=ACTIONS).order_by("report_id", "step"):
        by_report[event.report_id].append(event)

    rows = []   # 모든 장애 건 (+ 리포트 id·종목)
    for rid, events in by_report.items():
        for incident in incidents(events):
            rows.append({**incident, "reportId": rid, "symbol": reports[rid].symbol})
    done = [r for r in rows if r["recovered"]]
    failures, recovered = len(rows), len(done)
    return {
        "from": first.isoformat(), "to": today.isoformat(), "days": days,
        "reports": len(reports), "reportsWithFailures": len({r["reportId"] for r in rows}),
        "failures": failures, "recovered": recovered,
        "unrecovered": sum(1 for r in rows if r["recovered"] is False),
        "injected": sum(1 for r in rows if r["injected"]),
        "autoRecoveryRate": round(recovered / failures * 100, 1) if failures else None,
        "meanRecoveryMs": round(sum(r["recoveryMs"] for r in done) / recovered) if recovered else None,
        "byErrorType": _breakdown(rows, "errorType"),
        "byWorker": _breakdown(rows, "worker"),
        "recent": [{"reportId": r["reportId"], "symbol": r["symbol"], "worker": r["worker"], "errorType": r["errorType"],
                    "injected": r["injected"], "recovered": r["recovered"] is True, "recoveryMs": r["recoveryMs"],
                    "at": iso(r["at"])}
                   for r in sorted(rows, key=lambda r: (r["at"], r["reportId"]), reverse=True)[:RECENT]],
    }


def _breakdown(rows: list[dict], field: str) -> list[dict]:
    """field 값별 {field: 값, failures, recovered}. 장애가 많은 순 (같으면 이름순)."""
    total, ok = Counter(r[field] for r in rows), Counter(r[field] for r in rows if r["recovered"])
    return [{field: k, "failures": total[k], "recovered": ok[k]} for k in sorted(total, key=lambda k: (-total[k], k))]
