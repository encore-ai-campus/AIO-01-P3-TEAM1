"""F4·F6·F7·F8·F9 지표 (API.md 2장). 열은 API.md 4장에 있는 것만 이름으로 고른다. 날짜 묶음(KST)은 Python에서 한다."""
from collections import Counter, defaultdict
from datetime import datetime, timedelta

from . import recovery
from .db import Database, in_params
from .util import KST, age_sec, clean_json, clean_text, iso, kst_date, kst_day_start, ms_between, num, parse_time, usd

REPORT_COLS = ("id, user_id, team, symbol, name, market, source, status, chaos, cost_usd, "
               "created_at, started_at, finished_at")
COUNTED = in_params("act", recovery.COUNTED_ACTIONS)
ERROR_WINDOW = timedelta(minutes=30)
STALE_SENDING = timedelta(minutes=10)
PENDING_OLD = timedelta(minutes=10)
STUCK = {("analysis", "RUNNING"): timedelta(minutes=15), ("analysis", "QUEUED"): timedelta(minutes=10),
         ("report", "running"): timedelta(minutes=20), ("report", "requested"): timedelta(minutes=30)}
LEVEL_ORDER = {"down": 0, "warn": 1, "unknown": 2, "ok": 3}


# ---------- F4 엔진 ----------

def engine_row(db: Database) -> dict | None:
    rows = db.query("SELECT name, version, host, pid, started_at, beat_at, halted, broker_ready, last_tick_ms, "
                    "step_errors, limits FROM engine_status WHERE name = %(name)s", {"name": "run_engine"})
    return rows[0] if rows else None


def limits_of(row: dict | None) -> dict:
    raw = row.get("limits") if row else None
    if not isinstance(raw, dict):
        return {}
    return {str(k): v for k, v in raw.items() if v is None or (isinstance(v, (int, float, str)) and not isinstance(v, bool))}


def engine(db: Database, now: datetime, stale_after: int) -> dict:
    row = engine_row(db)
    if row is None:
        return {"level": "down", "found": False, "version": None, "host": None, "startedAt": None, "beatAt": None,
                "ageSec": None, "stale": True, "staleAfterSec": stale_after, "halted": None, "brokerReady": None,
                "lastTickMs": None, "errors": [], "limits": {}}
    beat = row["beat_at"]
    age = age_sec(beat, now)
    stale = age is None or age > stale_after
    errors = []
    for e in row.get("step_errors") if isinstance(row.get("step_errors"), list) else []:
        if isinstance(e, dict):
            at = parse_time(e.get("at"))
            errors.append({"at": iso(at) if at else clean_text(e.get("at")) or "", "step": clean_text(e.get("step")) or "",
                           "error": clean_text(e.get("error")) or "", "_at": at})
    errors = sorted(errors, key=lambda e: e["_at"] or datetime.min.replace(tzinfo=now.tzinfo), reverse=True)[:20]
    recent_error = any(e["_at"] and e["_at"] >= now - ERROR_WINDOW for e in errors)
    level = "down" if stale else "warn" if row.get("halted") or recent_error else "ok"
    return {
        "level": level, "found": True, "version": row.get("version"), "host": row.get("host"),
        "startedAt": iso(row.get("started_at")), "beatAt": iso(beat),
        "ageSec": round(age) if age is not None else None, "stale": stale, "staleAfterSec": stale_after,
        "halted": row.get("halted"), "brokerReady": row.get("broker_ready"), "lastTickMs": row.get("last_tick_ms"),
        "errors": [{k: v for k, v in e.items() if k != "_at"} for e in errors],
        "limits": limits_of(row),
    }


def _ago(sec: float | None) -> str:
    if sec is None:
        return "알 수 없음"
    sec = int(sec)
    if sec < 60:
        return f"{sec}초 전"
    if sec < 3600:
        return f"{sec // 60}분 전"
    return f"{sec // 3600}시간 전"


def engine_summary(data: dict) -> str:
    if not data["found"]:
        return "엔진 상태 기록 없음"
    version = (data["version"] or "?")[:7]
    if data["stale"]:
        return f"멈춤: 마지막 동작 {_ago(data['ageSec'])} · 버전 {version}"
    extra = " · 중단 스위치 켜짐" if data["halted"] else ""
    if data["level"] == "warn" and not data["halted"]:
        extra = " · 최근 30분 단계 오류"
    return f"마지막 동작 {_ago(data['ageSec'])} · 버전 {version}{extra}"


# ---------- F6 리포트 · F7 복구 ----------

def chaos_on(value) -> bool:
    return isinstance(value, dict) and value.get("enabled") is True


def reports_since(db: Database, since: datetime) -> list[dict]:
    return db.query(f"SELECT {REPORT_COLS} FROM reports WHERE created_at >= %(since)s "
                    "ORDER BY created_at DESC, id DESC", {"since": since})


def trace_since(db: Database, since: datetime) -> dict[int, list[dict]]:
    """기간 안 리포트들의 복구 셈법에 필요한 사건 (리포트 id → 사건)."""
    frag, params = COUNTED
    rows = db.query("SELECT e.report_id, e.step, e.actor, e.action, e.details, e.at FROM report_trace_events e "
                    f"JOIN reports r ON r.id = e.report_id WHERE r.created_at >= %(since)s AND e.action IN {frag}",
                    {"since": since, **params})
    by_report: dict[int, list[dict]] = defaultdict(list)
    for r in rows:
        by_report[int(r["report_id"])].append(r)
    return by_report


def report_row(r: dict, events: list[dict]) -> tuple[dict, list[recovery.Incident]]:
    found = recovery.incidents(events)
    s = recovery.summary(found)
    cost = num(r.get("cost_usd"))
    row = {
        "id": int(r["id"]), "team": r["team"], "symbol": r["symbol"], "name": r["name"], "source": r["source"],
        "status": r["status"], "chaos": chaos_on(r.get("chaos")), "failReason": clean_text(recovery.fail_reason(events)),
        "failures": s["failures"], "recovered": s["recovered"], "unrecovered": s["unrecovered"], "injected": s["injected"],
        "costUsd": usd(cost) if cost is not None else None,
        "createdAt": iso(r["created_at"]), "startedAt": iso(r.get("started_at")), "finishedAt": iso(r.get("finished_at")),
        "durationMs": ms_between(r.get("started_at"), r.get("finished_at")),
    }
    return row, found


def _matches(row: dict, kind: str) -> bool:
    checks = {"failed": row["status"] == "failed", "recovered": row["recovered"] > 0, "chaos": row["chaos"]}
    return any(checks.values()) if kind == "all" else checks[kind]


def day_window(now: datetime, days: int) -> tuple[datetime, str, str]:
    """오늘(KST)을 포함한 최근 days일: 첫날 0시(KST)와 첫날·오늘 날짜 (서비스 stats.recovery_stats와 같은 기간)."""
    today = now.astimezone(KST).date()
    first = today - timedelta(days=days - 1)
    return datetime(first.year, first.month, first.day, tzinfo=KST), first.isoformat(), today.isoformat()


def report_list(db: Database, now: datetime, days: int, kind: str, team: str, limit: int) -> dict:
    since, first, last = day_window(now, days)
    reports = reports_since(db, since)
    trace = trace_since(db, since)
    rows = [report_row(r, trace.get(int(r["id"]), []))[0] for r in reports if not team or r["team"] == team]
    rows = [r for r in rows if _matches(r, kind)]
    return {"from": first, "to": last, "days": days, "kind": kind, "count": len(rows), "results": rows[:limit]}


def trace_kind(action: str, details: dict) -> str:
    if action == "agent_retry":
        return "retry"
    if action == "agent_failover":
        return "failover"
    if action == "agent_failed":
        return "failure" if details.get("final") is False else "give_up"  # final이 false가 아니면 포기 (서비스 stats와 같다)
    if action == "agent_completed" and details.get("recovered") is True:
        return "recovered"
    if action == "agent_skipped":
        return "skipped"
    if action.startswith(("join_", "handoff_")) or action == "review_retry":
        return "guard"
    if action.startswith("workflow_"):
        return "workflow"
    return "other"


def report_trace(db: Database, report_id: int) -> dict | None:
    rows = db.query(f"SELECT {REPORT_COLS} FROM reports WHERE id = %(id)s", {"id": report_id})
    if not rows:
        return None
    events = db.query("SELECT step, actor, action, status, provider, model, latency_ms, details, at "
                      "FROM report_trace_events WHERE report_id = %(id)s ORDER BY step", {"id": report_id})
    events.sort(key=lambda e: int(e["step"]))
    row, found = report_row(rows[0], events)
    items = []
    for e in events:
        details = e["details"] if isinstance(e.get("details"), dict) else {}
        items.append({"step": int(e["step"]), "at": iso(e["at"]), "actor": e["actor"], "action": e["action"],
                      "status": e["status"], "provider": e.get("provider"), "model": e.get("model"),
                      "latencyMs": e.get("latency_ms"), "details": clean_json(details),
                      "kind": trace_kind(str(e["action"]), details)})
    s = recovery.summary(found)
    return {"report": row, "recovery": s, "events": items}


def recovery_stats(db: Database, now: datetime, days: int) -> dict:
    since, first, last = day_window(now, days)
    reports = reports_since(db, since)
    trace = trace_since(db, since)
    per_report = {int(r["id"]): recovery.incidents(trace.get(int(r["id"]), [])) for r in reports}
    rows = [{"id": int(r["id"]), "symbol": r["symbol"]} for r in reports]
    return recovery.stats(rows, per_report, first=first, last=last, days=days)


def recovery_level(stats: dict) -> tuple[str, str]:
    if stats["failures"] == 0:
        return "unknown", "장애 없음"
    rate = f"자동 복구율 {stats['autoRecoveryRate']}%"
    if stats["unrecovered"] > 0:
        return "warn", f"복구 못한 장애 {stats['unrecovered']}건 · {rate}"
    mean = stats["meanRecoveryMs"]
    running = stats["failures"] - stats["recovered"] - stats["unrecovered"]  # 끝나지 않은 run의 장애
    return "ok", " · ".join([rate] + ([f"평균 {mean:,}ms"] if mean is not None else []) + ([f"진행 중 {running}건"] if running else []))


def reports_level(db: Database, now: datetime) -> tuple[str, str]:
    rows = reports_since(db, now - timedelta(hours=24))
    failed = [r for r in rows if r["status"] == "failed" and not chaos_on(r.get("chaos"))]
    if failed:
        return "warn", f"최근 24시간 실패 {len(failed)}건 (장애 주입 제외)"
    return "ok", f"최근 24시간 실패 없음 · 리포트 {len(rows)}건"


# ---------- F8 비용 ----------

ANALYSIS_COST_USD = 0.3  # 엔진이 limits.analysisCostUsd를 알려 주지 않을 때 (서비스 analysis.quota.COST_PER_ANALYSIS_USD)

def counts_for_quota(r: dict) -> bool:
    """서비스 reports.limits.quota.counts와 같은 셈: 자동 리포트는 빼고, failed는 장애 주입을 켰을 때만 센다."""
    if (r.get("source") or "user") == "auto":
        return False
    if r["status"] != "failed":
        return True
    return chaos_on(r.get("chaos"))


def _pct(total: float, budget: float | None) -> float | None:
    return round(total / budget * 100, 1) if budget else None


def costs(db: Database, now: datetime, days: int) -> dict:
    today = kst_day_start(now)
    start = today - timedelta(days=days - 1)
    dates = [(start + timedelta(days=i)).date().isoformat() for i in range(days)]
    daily = {d: {"date": d, "reportsUsd": 0.0, "analysisUsd": 0.0, "longtermUsd": 0.0, "totalUsd": 0.0,
                 "reports": 0, "analyses": 0} for d in dates}
    reports = reports_since(db, start)
    for r in reports:
        day = daily.get(kst_date(r["created_at"]))
        if day:
            day["reports"] += 1
            day["reportsUsd"] += num(r.get("cost_usd")) or 0.0
    for r in db.query("SELECT id, symbol, analyzed_at, cost_usd FROM analysis_runs WHERE analyzed_at >= %(since)s",
                      {"since": start}):
        day = daily.get(kst_date(r["analyzed_at"]))
        if day:
            day["analyses"] += 1
            day["analysisUsd"] += num(r.get("cost_usd")) or 0.0
    for r in db.query("SELECT id, symbol, created_at, cost_usd FROM daily_move_notes WHERE created_at >= %(since)s",
                      {"since": start}):
        day = daily.get(kst_date(r["created_at"]))
        if day:
            day["longtermUsd"] += num(r.get("cost_usd")) or 0.0
    keys = ("reportsUsd", "analysisUsd", "longtermUsd")
    for day in daily.values():
        day["totalUsd"] = sum(day[k] for k in keys)
        for k in (*keys, "totalUsd"):
            day[k] = usd(day[k])
    rows = [daily[d] for d in dates]
    totals = {k: usd(sum(d[k] for d in rows)) for k in (*keys, "totalUsd")}

    limits = limits_of(engine_row(db))
    budget = num(limits.get("aiDailyBudgetUsd"))
    budget = budget if budget and budget > 0 else None
    today_total = daily[dates[-1]]["totalUsd"]
    jobs = db.query("SELECT id, type, user_id, status, created_at, started_at FROM jobs WHERE created_at >= %(since)s",
                    {"since": today})
    analyses_used = sum(1 for j in jobs if j["type"] == "analyze" and not (j["status"] == "FAILED" and j["started_at"] is None))
    # 예산 사용액 = 서비스 reports.limits.budget.used_usd와 같은 셈: 오늘 분석 요청 수 × 건당 예상 비용 + 오늘 만든 리포트의 실제 비용
    per_analysis = num(limits.get("analysisCostUsd"))
    budget_used = usd(analyses_used * (per_analysis if per_analysis is not None else ANALYSIS_COST_USD)
                      + daily[dates[-1]]["reportsUsd"])
    per_user = Counter(r["user_id"] for r in reports
                       if r["created_at"] >= today and r.get("user_id") is not None and counts_for_quota(r))
    return {
        "from": iso(start), "to": iso(now), "days": days, "daily": rows, "totals": totals,
        "today": {
            "date": dates[-1], "totalUsd": today_total, "budgetUsd": budget, "budgetUsedUsd": budget_used,
            "budgetPct": _pct(budget_used, budget),
            "analyses": {"used": analyses_used, "limit": _int_or_none(limits.get("analysesTotal"))},
            "reportsPerUser": {"maxUsed": max(per_user.values(), default=0),
                               "limit": _int_or_none(limits.get("reportsPerUser")),
                               # 서비스 기본값은 한도 없음(null) — 키가 없으면 모름과 나눈다
                               "unlimited": "reportsPerUser" in limits and limits["reportsPerUser"] is None},
        },
    }


def _int_or_none(value) -> int | None:
    n = num(value)
    return int(n) if n is not None else None


def costs_level(data: dict) -> tuple[str, str]:
    t = data["today"]
    spent = f"오늘 ${t['totalUsd']:.2f}"
    if t["budgetUsd"] is None:
        return "unknown", f"{spent} · 예산을 모름"
    text = f"{spent} / 예산 ${t['budgetUsd']:g} ({t['budgetPct']}%)"
    pct = t["budgetPct"]
    return ("down" if pct >= 100 else "warn" if pct >= 80 else "ok"), text


# ---------- F9 알림·작업 ----------

def alerts(db: Database, now: datetime, hours: int) -> dict:
    since = now - timedelta(hours=hours)
    outbox = db.query("SELECT id, kind, status, attempts, last_error, created_at, claimed_at, sent_at "
                      "FROM notification_outbox WHERE (status = %(failed)s AND created_at >= %(since)s) "
                      "OR status IN (%(pending)s, %(sending)s)",
                      {"failed": "failed", "pending": "pending", "sending": "sending", "since": since})
    failed = [r for r in outbox if r["status"] == "failed"]
    pending_old = [r for r in outbox if r["status"] == "pending" and r["created_at"] < now - PENDING_OLD]
    sending_stuck = [r for r in outbox if r["status"] == "sending"
                     and (r["claimed_at"] is None or r["claimed_at"] < now - STALE_SENDING)]
    problem = sorted(failed + pending_old + sending_stuck, key=lambda r: (r["created_at"], r["id"]), reverse=True)[:50]
    rows = [{"id": int(r["id"]), "kind": r["kind"], "status": r["status"], "attempts": int(r["attempts"] or 0),
             "lastError": clean_text(r.get("last_error")), "createdAt": iso(r["created_at"]),
             "claimedAt": iso(r.get("claimed_at")), "ageSec": round(age_sec(r["created_at"], now))} for r in problem]
    stuck = stuck_jobs(db, now)
    level = "warn" if failed or pending_old or sending_stuck or stuck else "ok"
    return {"hours": hours, "level": level,
            "discord": {"failed": len(failed), "pendingOld": len(pending_old), "sendingStuck": len(sending_stuck),
                        "rows": rows},
            "stuck": stuck}


def _job_symbol(payload) -> str:
    return str(payload.get("symbol") or "?") if isinstance(payload, dict) else "?"


def stuck_jobs(db: Database, now: datetime) -> list[dict]:
    found = []
    for j in db.query("SELECT id, type, payload, status, created_at, started_at FROM jobs "
                      "WHERE status IN (%(q)s, %(r)s)", {"q": "QUEUED", "r": "RUNNING"}):
        since = j["started_at"] if j["status"] == "RUNNING" else j["created_at"]
        since = since or j["created_at"]
        if since < now - STUCK[("analysis", j["status"])]:
            found.append({"kind": "analysis", "id": int(j["id"]), "status": j["status"],
                          "label": f"분석 {_job_symbol(j.get('payload'))}", "since": since})
    for r in db.query("SELECT id, team, symbol, name, status, created_at, started_at FROM reports "
                      "WHERE status IN (%(q)s, %(r)s)", {"q": "requested", "r": "running"}):
        since = (r["started_at"] if r["status"] == "running" else None) or r["created_at"]
        if since < now - STUCK[("report", r["status"])]:
            label = f"선정 {r['symbol']}" if r["team"] == "stock_selection" else f"리포트 {r['name']}({r['symbol']})"
            found.append({"kind": "report", "id": int(r["id"]), "status": r["status"], "label": label, "since": since})
    found.sort(key=lambda s: (s["since"], s["kind"], s["id"]))
    return [{**s, "since": iso(s["since"]), "ageSec": round(age_sec(s["since"], now))} for s in found]


def alerts_summary(data: dict) -> str:
    d = data["discord"]
    parts = []
    if d["failed"]:
        parts.append(f"Discord 실패 {d['failed']}건")
    if d["pendingOld"]:
        parts.append(f"오래된 대기 {d['pendingOld']}건")
    if d["sendingStuck"]:
        parts.append(f"멈춘 발송 {d['sendingStuck']}건")
    if data["stuck"]:
        parts.append(f"멈춘 작업 {len(data['stuck'])}건")
    return " · ".join(parts) if parts else f"최근 {data['hours']}시간 문제 없음"
