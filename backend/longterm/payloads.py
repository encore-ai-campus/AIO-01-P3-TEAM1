"""장기투자 응답 모양 (docs/API.md "장기투자" 타입: DailyMove, Thesis, ThesisCheck, FundamentalsView). 키는 camelCase."""
from datetime import datetime

from django.utils import timezone
from paper_engine.judge import fundamentals_check as fc

from .models import DailyMoveNote, InvestmentThesis, ThesisCheck


def iso(value: datetime | None) -> str | None:
    return timezone.localtime(value).isoformat() if value else None


def daily_move_json(note: DailyMoveNote) -> dict:
    return {
        "symbol": note.symbol, "name": note.name, "market": note.market, "date": f"{note.day}",
        "asOf": iso(note.as_of), "close": note.close, "prevClose": note.prev_close, "changeRate": note.change_rate,
        "marketProxy": {"symbol": note.proxy_symbol, "name": note.proxy_name, "changeRate": note.proxy_change_rate},
        "excessChangeRate": note.excess_change_rate, "sectorChangeRate": None, "volatility20": note.volatility20,
        "flows": note.flows, "headline": note.headline, "summary": list(note.summary or []),
        "drivers": list(note.drivers or []), "uncertain": note.uncertain, "method": note.method,
        "evidence": list(note.evidence or []), "missing": list(note.missing or []), "createdAt": iso(note.created_at),
    }


def check_json(check: ThesisCheck | None) -> dict | None:
    if check is None:
        return None
    return {
        "id": check.id, "checkedAt": iso(check.checked_at), "trigger": check.trigger, "period": check.period,
        "receivedAt": f"{check.received_at}" if check.received_at else None, "overall": check.overall,
        "previousOverall": check.previous_overall, "rows": list(check.rows or []), "newBad": list(check.new_bad or []),
        "notified": check.notified, "caption": fc.CAPTION,
    }


def thesis_json(thesis: InvestmentThesis, last: ThesisCheck | None) -> dict:
    return {
        "symbol": thesis.symbol, "name": thesis.name, "market": thesis.market, "reasons": list(thesis.reasons or []),
        "axes": list(thesis.axes or []), "baseline": dict(thesis.baseline or {}),
        "baselinePeriod": thesis.baseline_period, "active": thesis.active, "lastCheck": check_json(last),
        "createdAt": iso(thesis.created_at), "updatedAt": iso(thesis.updated_at),
    }


def fundamentals_json(item: dict, *, applicable: bool, reason: str | None, result: dict | None,
                      thesis: dict | None) -> dict:
    """FundamentalsView. result는 fundamentals_check.evaluate 결과 (자료가 없으면 None — 값이 null인 9행)."""
    if not applicable:
        rows, overall, as_of = [], fc.NA, None
    else:
        result = result or fc.evaluate(None)
        rows, overall = result["rows"], result["overall"]
        as_of = ({"period": result["period"], "receivedAt": result["receivedAt"]}
                 if result["period"] or result["receivedAt"] else None)
    return {
        "symbol": item["symbol"], "name": item["name"], "market": item["market"], "applicable": applicable,
        "reason": reason, "overall": overall, "rows": rows, "asOf": as_of, "source": fc.SOURCE,
        "caption": fc.CAPTION, "thesis": thesis,
    }
