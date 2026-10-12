"""복구 셈법 (API.md 3장). 서비스 `backend/reports/autohealing/stats.py`(담당 4, T4-7)의 `incidents`·`report_recovery`·`recovery_stats`와 같은 규칙.

한 Worker의 실행(run) = agent_started부터 다음 agent_completed 또는 포기(agent_failed, final이 false가 아님)까지.
장애 1건 = 한 run의 첫 agent_failed(final: false). 포기로 끝나면 복구 못 함, 끝나지 않은 run의 장애는 장애 건수에만 든다.
기준 사례: recovery_cases.json (서비스 테스트 backend/reports/tests/autohealing/test_recovery_cases.py도 같은 파일로 stats를 본다).
"""
from collections import Counter
from dataclasses import dataclass
from datetime import datetime

from .util import iso, parse_time

COUNTED_ACTIONS = ("agent_started", "agent_failed", "agent_completed", "workflow_failed")
ERROR_TYPES = ("timeout", "server_error", "bad_output", "unknown")


@dataclass
class Incident:
    worker: str
    error_type: str
    injected: bool
    at: datetime
    step: int
    recovered: bool | None = None   # True 복구 · False 포기 · None 진행 중 (run이 끝나지 않음)
    recovery_ms: int | None = None

    def as_dict(self) -> dict:
        return {"worker": self.worker, "errorType": self.error_type, "injected": self.injected,
                "recovered": self.recovered, "recoveryMs": self.recovery_ms, "at": iso(self.at)}


def _details(event: dict) -> dict:
    d = event.get("details")
    return d if isinstance(d, dict) else {}


def incidents(events: list[dict]) -> list[Incident]:
    """한 리포트의 Trace(step 순서) → 장애 건 목록 (첫 실패 순서). 서비스 stats.incidents와 같다."""
    found: list[Incident] = []
    open_runs: dict[str, Incident] = {}  # actor → 이번 run의 장애 (첫 실패가 있을 때만)
    for e in sorted(events, key=lambda x: int(x["step"])):
        actor, action, details = str(e.get("actor") or ""), e.get("action"), _details(e)
        if action == "agent_started":
            open_runs.pop(actor, None)  # 새 run. 앞 run의 장애는 진행 중(None)으로 남는다
        elif action == "agent_failed" and details.get("final") is False:
            if actor not in open_runs:
                error_type = details.get("errorType")
                incident = Incident(worker=actor, error_type=error_type if error_type in ERROR_TYPES else "unknown",
                                    injected=details.get("injected") is True, at=parse_time(e.get("at")), step=int(e["step"]))
                open_runs[actor] = incident
                found.append(incident)
        elif action == "agent_completed":
            incident = open_runs.pop(actor, None)
            if incident is not None:
                incident.recovered = True
                incident.recovery_ms = max(int((parse_time(e.get("at")) - incident.at).total_seconds() * 1000), 0)
        elif action == "agent_failed":  # final이 false가 아니면 포기
            incident = open_runs.pop(actor, None)
            if incident is not None:
                incident.recovered = False
    return found


def summary(found: list[Incident]) -> dict:
    """한 리포트의 RecoverySummary. recoveryMs는 복구된 건의 복구 시간 합 (서비스 stats.report_recovery와 같다)."""
    recovered = [i for i in found if i.recovered]
    return {"failures": len(found), "recovered": len(recovered),
            "unrecovered": sum(1 for i in found if i.recovered is False),
            "injected": sum(i.injected for i in found),
            "recoveryMs": sum(i.recovery_ms for i in recovered) if recovered else None}


def fail_reason(events: list[dict]) -> str | None:
    """workflow_failed.details.reason (마지막 것)."""
    reason = None
    for e in sorted(events, key=lambda x: int(x["step"])):
        if e.get("action") == "workflow_failed":
            value = _details(e).get("reason")
            reason = str(value) if value is not None else None
    return reason


def _grouped(pairs: list[tuple[str, bool | None]], label: str) -> list[dict]:
    """값별 {label, failures, recovered}. 장애가 많은 순 (같으면 이름순)."""
    failures, recovered = Counter(), Counter()
    for key, ok in pairs:
        failures[key] += 1
        recovered[key] += ok is True
    order = sorted(failures, key=lambda k: (-failures[k], k))
    return [{label: k, "failures": failures[k], "recovered": recovered[k]} for k in order]


def stats(reports: list[dict], per_report: dict[int, list[Incident]], *, first: str, last: str, days: int) -> dict:
    """기간 지표 RecoveryStats (서비스 stats.recovery_stats와 같은 형식: from·to는 KST 날짜).
    reports는 기간 안의 리포트 행, per_report는 리포트 id → 장애 건."""
    rows = [(r, i) for r in reports for i in per_report.get(r["id"], [])]
    all_inc = [i for _, i in rows]
    recovered = [i for i in all_inc if i.recovered]
    recent = sorted(rows, key=lambda x: (x[1].at, x[0]["id"]), reverse=True)[:20]
    return {
        "from": first, "to": last, "days": days,
        "reports": len(reports),
        "reportsWithFailures": len({r["id"] for r, _ in rows}),
        "failures": len(all_inc), "recovered": len(recovered),
        "unrecovered": sum(1 for i in all_inc if i.recovered is False),
        "injected": sum(i.injected for i in all_inc),
        "autoRecoveryRate": round(len(recovered) / len(all_inc) * 100, 1) if all_inc else None,
        "meanRecoveryMs": round(sum(i.recovery_ms for i in recovered) / len(recovered)) if recovered else None,
        "byErrorType": _grouped([(i.error_type, i.recovered) for i in all_inc], "errorType"),
        "byWorker": _grouped([(i.worker, i.recovered) for i in all_inc], "worker"),
        "recent": [{"reportId": r["id"], "symbol": r["symbol"], "worker": i.worker, "errorType": i.error_type,
                    "injected": i.injected, "recovered": i.recovered is True, "recoveryMs": i.recovery_ms,
                    "at": iso(i.at)}
                   for r, i in recent],
    }
