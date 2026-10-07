"""AI 리포트 Worker 사이에서 주고받는 출력 계약 검증."""

from __future__ import annotations

import re
from collections.abc import Callable
from typing import Any


class ContractError(ValueError):
    """LLM 출력이 선언된 계약을 지키지 않았을 때 발생한다."""


NAMES = (
    "MarketResult",
    "FundamentalResult",
    "NewsResult",
    "ReportDraft",
    "ReviewResult",
    "RiskResult",
)

SUMMARY_MAX = 600
LIST_ITEM_MAX = 200


def _error(path: str, message: str) -> ContractError:
    return ContractError(f"`{path}`{message}")


def _object(value: Any, path: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _error(path, "는 JSON 객체여야 합니다.")
    return value


def _required(data: dict[str, Any], key: str, path: str = "") -> Any:
    if key not in data:
        name = f"{path}.{key}" if path else key
        raise _error(name, " 필드가 필요합니다.")
    return data[key]


def _string(value: Any, path: str, *, limit: int = LIST_ITEM_MAX, nullable: bool = False) -> str | None:
    if nullable and value is None:
        return None
    if not isinstance(value, str):
        raise _error(path, "는 문자열이어야 합니다.")
    return value[:limit]


def _number(
    value: Any,
    path: str,
    *,
    nullable: bool = False,
    minimum: float | None = None,
    maximum: float | None = None,
) -> int | float | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _error(path, "는 숫자여야 합니다.")
    if minimum is not None and value < minimum:
        raise _error(path, f"는 {minimum} 이상이어야 합니다: {value!r}")
    if maximum is not None and value > maximum:
        raise _error(path, f"는 {maximum} 이하여야 합니다: {value!r}")
    return value


def _integer(
    value: Any,
    path: str,
    *,
    nullable: bool = False,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int | None:
    if nullable and value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int):
        raise _error(path, "는 정수여야 합니다.")
    if minimum is not None and value < minimum:
        raise _error(path, f"는 {minimum} 이상이어야 합니다: {value!r}")
    if maximum is not None and value > maximum:
        raise _error(path, f"는 {maximum} 이하여야 합니다: {value!r}")
    return value


def _enum(value: Any, path: str, choices: tuple[str, ...]) -> str:
    if not isinstance(value, str) or value not in choices:
        joined = "/".join(choices)
        raise _error(path, f"는 {joined} 중 하나여야 합니다: {value!r}")
    return value


def _strings(value: Any, path: str, *, maximum: int, minimum: int = 0, item_limit: int = LIST_ITEM_MAX) -> list[str]:
    if not isinstance(value, list):
        raise _error(path, "는 문자열 목록이어야 합니다.")
    if len(value) < minimum:
        raise _error(path, f"는 항목이 {minimum}개 이상이어야 합니다.")
    return [_string(item, f"{path}[{index}]", limit=item_limit) for index, item in enumerate(value[:maximum])]


def _records(
    value: Any,
    path: str,
    *,
    maximum: int,
    validator: Callable[[dict[str, Any], str], dict[str, Any]],
) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise _error(path, "는 객체 목록이어야 합니다.")
    return [validator(_object(item, f"{path}[{index}]"), f"{path}[{index}]")
            for index, item in enumerate(value[:maximum])]


def _market(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "trend": _enum(_required(data, "trend"), "trend", ("up", "down", "sideways")),
        "summary": _string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "price": _number(_required(data, "price"), "price"),
        "changePct": _number(_required(data, "changePct"), "changePct"),
        "asOf": _string(data.get("asOf"), "asOf", nullable=True),
        "rsi": _number(_required(data, "rsi"), "rsi", nullable=True),
        "volatilityPct": _number(_required(data, "volatilityPct"), "volatilityPct", nullable=True),
        "volumeRank": _integer(_required(data, "volumeRank"), "volumeRank", nullable=True),
        "support": _number(_required(data, "support"), "support", nullable=True),
        "resistance": _number(_required(data, "resistance"), "resistance", nullable=True),
        "signals": _strings(_required(data, "signals"), "signals", maximum=5),
        "evidence": _strings(_required(data, "evidence"), "evidence", maximum=8),
    }


def _metrics(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {key: _number(_required(data, key, path), f"{path}.{key}", nullable=True)
            for key in ("per", "pbr", "roe", "revenueGrowthPct", "opMarginPct")}


def _filing(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "date": _string(_required(data, "date", path), f"{path}.date"),
        "title": _string(_required(data, "title", path), f"{path}.title"),
        "impact": _enum(_required(data, "impact", path), f"{path}.impact", ("positive", "negative", "neutral")),
    }


def _fundamental(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "summary": _string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "metrics": _metrics(_object(_required(data, "metrics"), "metrics"), "metrics"),
        "recentFilings": _records(_required(data, "recentFilings"), "recentFilings", maximum=5, validator=_filing),
        "evidence": _strings(_required(data, "evidence"), "evidence", maximum=8),
    }


def _headline(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {key: _string(_required(data, key, path), f"{path}.{key}")
            for key in ("date", "title", "source", "impact")}


def _news(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "sentiment": _enum(_required(data, "sentiment"), "sentiment", ("positive", "negative", "neutral")),
        "score": _number(_required(data, "score"), "score", minimum=-1, maximum=1),
        "summary": _string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "headlines": _records(_required(data, "headlines"), "headlines", maximum=5, validator=_headline),
        "evidence": _strings(_required(data, "evidence"), "evidence", maximum=8),
    }


def _targets(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "entry": _number(_required(data, "entry", path), f"{path}.entry", nullable=True),
        "target": _number(_required(data, "target", path), f"{path}.target", nullable=True),
        "stop": _number(_required(data, "stop", path), f"{path}.stop", nullable=True),
        "holdingDays": _integer(_required(data, "holdingDays", path), f"{path}.holdingDays",
                                nullable=True, minimum=1, maximum=20),
        "probability": _number(_required(data, "probability", path), f"{path}.probability",
                               nullable=True, minimum=0, maximum=1),
    }


def _report(data: dict[str, Any]) -> dict[str, Any]:
    plain = _strings(_required(data, "plainSummary"), "plainSummary", maximum=3, minimum=1, item_limit=100)
    for index, item in enumerate(plain):
        if re.search(r"[0-9]", item):
            raise _error(f"plainSummary[{index}]", "에는 숫자(0-9)를 넣을 수 없습니다.")
    return {
        "title": _string(_required(data, "title"), "title"),
        "verdict": _enum(_required(data, "verdict"), "verdict", ("buy", "hold", "avoid")),
        "oneLiner": _string(_required(data, "oneLiner"), "oneLiner", limit=80),
        "plainSummary": plain,
        "markdown": _string(_required(data, "markdown"), "markdown", limit=20_000),
        "reasons": _strings(_required(data, "reasons"), "reasons", maximum=3),
        "risks": _strings(_required(data, "risks"), "risks", maximum=3),
        "targets": _targets(_object(_required(data, "targets"), "targets"), "targets"),
        "confidence": _number(_required(data, "confidence"), "confidence", minimum=0, maximum=100),
        "citations": _strings(_required(data, "citations"), "citations", maximum=10),
    }


def _issue(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {key: _string(_required(data, key, path), f"{path}.{key}") for key in ("claim", "problem", "fix")}


def _handoff(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    data = _object(value, "handoff")
    return {
        "to": _enum(_required(data, "to", "handoff"), "handoff.to", ("risk_agent",)),
        "reason": _string(_required(data, "reason", "handoff"), "handoff.reason"),
    }


def _review(data: dict[str, Any]) -> dict[str, Any]:
    verdict = _enum(_required(data, "verdict"), "verdict", ("PASS", "RETRY", "FAIL"))
    instructions = _string(_required(data, "instructions"), "instructions", nullable=True, limit=SUMMARY_MAX)
    if verdict == "RETRY" and not instructions:
        raise _error("instructions", "는 verdict가 RETRY일 때 비어 있을 수 없습니다.")
    return {
        "verdict": verdict,
        "score": _number(_required(data, "score"), "score", minimum=0, maximum=100),
        "issues": _records(_required(data, "issues"), "issues", maximum=10, validator=_issue),
        "instructions": instructions,
        "handoff": _handoff(_required(data, "handoff")),
    }


def _risk(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "level": _enum(_required(data, "level"), "level", ("low", "medium", "high")),
        "flags": _strings(_required(data, "flags"), "flags", maximum=10),
        "warnings": _strings(_required(data, "warnings"), "warnings", maximum=5),
        "summary": _string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
    }


_VALIDATORS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "MarketResult": _market,
    "FundamentalResult": _fundamental,
    "NewsResult": _news,
    "ReportDraft": _report,
    "ReviewResult": _review,
    "RiskResult": _risk,
}

_DESCRIPTIONS = {
    "MarketResult": "trend(up/down/sideways), summary, price, changePct, asOf(null 가능), rsi, volatilityPct, "
                    "volumeRank, support, resistance, signals(최대 5), evidence(최대 8)",
    "FundamentalResult": "summary, metrics(per/pbr/roe/revenueGrowthPct/opMarginPct; null 가능), "
                         "recentFilings(date/title/impact; 최대 5), evidence(최대 8)",
    "NewsResult": "sentiment(positive/negative/neutral), score(-1~1), summary, "
                  "headlines(date/title/source/impact; 최대 5), evidence(최대 8)",
    "ReportDraft": "title, verdict(buy/hold/avoid), oneLiner(80자), plainSummary(1~3개, 항목당 100자, 숫자 금지), "
                   "markdown, reasons(최대 3), risks(최대 3), targets(entry/target/stop/holdingDays/probability), "
                   "confidence(0~100), citations(최대 10)",
    "ReviewResult": "verdict(PASS/RETRY/FAIL), score(0~100), issues(claim/problem/fix; 최대 10), "
                    "instructions(RETRY이면 필수), handoff(null 또는 risk_agent와 reason)",
    "RiskResult": "level(low/medium/high), flags(최대 10), warnings(최대 5), summary",
}


def validate(name: str, data: Any) -> dict[str, Any]:
    """계약 이름에 맞게 출력값을 검증하고 허용된 키만 반환한다."""
    try:
        validator = _VALIDATORS[name]
    except KeyError as exc:
        raise ContractError(f"모르는 출력 계약입니다: {name!r}") from exc
    return validator(_object(data, name))


def describe(name: str) -> str:
    """프롬프트에 넣을 수 있는 간결한 계약 설명을 반환한다."""
    try:
        return _DESCRIPTIONS[name]
    except KeyError as exc:
        raise ContractError(f"모르는 출력 계약입니다: {name!r}") from exc
