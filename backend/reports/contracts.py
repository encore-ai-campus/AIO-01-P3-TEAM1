"""AI 리포트 Worker 사이에서 주고받는 출력 계약 검증."""

from __future__ import annotations

import math
from collections.abc import Callable
from typing import Any

from paper_engine.wording import forbidden_phrases


class ContractError(ValueError):
    """LLM 출력이 선언된 계약을 지키지 않았을 때 발생한다."""


SUMMARY_MAX = 600
LIST_ITEM_MAX = 200
ONE_LINER_MAX = 80
MAX_ITEMS = 3
MIN_HOLDING_DAYS = 1
MAX_HOLDING_DAYS = 20
OPINIONS = ("buy", "hold", "avoid")
RISK_LEVELS = ("low", "medium", "high")


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


def _required_string(value: Any, path: str, *, limit: int | None = LIST_ITEM_MAX) -> str:
    if not isinstance(value, str):
        raise _error(path, "는 문자열이어야 합니다.")
    value = value.strip()
    if not value:
        raise _error(path, "는 비어 있을 수 없습니다.")
    return value if limit is None else value[:limit]


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
    if not math.isfinite(value):
        raise _error(path, "는 유한한 숫자여야 합니다.")
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
        shown = repr(value)[:80]
        raise _error(path, f"는 {joined} 중 하나여야 합니다: {shown}")
    return value


def _strings(value: Any, path: str, *, maximum: int, minimum: int = 0, item_limit: int = LIST_ITEM_MAX) -> list[str]:
    if not isinstance(value, list):
        raise _error(path, "는 문자열 목록이어야 합니다.")
    if len(value) < minimum:
        raise _error(path, f"는 항목이 {minimum}개 이상이어야 합니다.")
    return [_required_string(item, f"{path}[{index}]", limit=item_limit)
            for index, item in enumerate(value[:maximum])]


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
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "price": _number(_required(data, "price"), "price", nullable=True),
        "changePct": _number(_required(data, "changePct"), "changePct", nullable=True),
        "asOf": _string(data.get("asOf"), "asOf", nullable=True),
        "rsi": _number(_required(data, "rsi"), "rsi", nullable=True),
        "volatilityPct": _number(_required(data, "volatilityPct"), "volatilityPct", nullable=True),
        "volumeRank": _integer(_required(data, "volumeRank"), "volumeRank", nullable=True),
        "support": _number(_required(data, "support"), "support", nullable=True),
        "resistance": _number(_required(data, "resistance"), "resistance", nullable=True),
        "signals": _strings(_required(data, "signals"), "signals", maximum=5),
        "evidence": _strings(_required(data, "evidence"), "evidence", maximum=8),
    }


def _metrics(value: Any, path: str) -> dict[str, Any] | None:
    if value is None:
        return None
    data = _object(value, path)
    return {key: _number(_required(data, key, path), f"{path}.{key}", nullable=True)
            for key in ("per", "pbr", "roe", "revenueGrowthPct", "opMarginPct")}


def _filing(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "date": _required_string(_required(data, "date", path), f"{path}.date"),
        "title": _required_string(_required(data, "title", path), f"{path}.title"),
        "impact": _enum(_required(data, "impact", path), f"{path}.impact", ("positive", "negative", "neutral")),
    }


def _fundamental(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "metrics": _metrics(_required(data, "metrics"), "metrics"),
        "recentFilings": _records(_required(data, "recentFilings"), "recentFilings", maximum=5, validator=_filing),
        "evidence": _strings(_required(data, "evidence"), "evidence", maximum=8),
    }


def _headline(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "date": _string(_required(data, "date", path), f"{path}.date", nullable=True),
        "title": _required_string(_required(data, "title", path), f"{path}.title"),
        "source": _string(_required(data, "source", path), f"{path}.source", nullable=True),
        "impact": _required_string(_required(data, "impact", path), f"{path}.impact"),
    }


def _news(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "sentiment": _enum(_required(data, "sentiment"), "sentiment", ("positive", "negative", "neutral")),
        "score": _number(_required(data, "score"), "score", nullable=True, minimum=-1, maximum=1),
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "headlines": _records(_required(data, "headlines"), "headlines", maximum=5, validator=_headline),
        "evidence": _strings(_required(data, "evidence"), "evidence", maximum=8),
    }


def _targets(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "entry": _number(_required(data, "entry", path), f"{path}.entry", nullable=True),
        "target": _number(_required(data, "target", path), f"{path}.target", nullable=True),
        "stop": _number(_required(data, "stop", path), f"{path}.stop", nullable=True),
        "holdingDays": _integer(_required(data, "holdingDays", path), f"{path}.holdingDays",
                                nullable=True, minimum=MIN_HOLDING_DAYS, maximum=MAX_HOLDING_DAYS),
        "probability": _number(_required(data, "probability", path), f"{path}.probability",
                               nullable=True, minimum=0, maximum=1),
    }


def _report(data: dict[str, Any]) -> dict[str, Any]:
    plain = _strings(_required(data, "plainSummary"), "plainSummary", maximum=3, minimum=1, item_limit=100)
    for index, item in enumerate(plain):
        if any(character.isdigit() for character in item):
            raise _error(f"plainSummary[{index}]", "에는 숫자를 넣을 수 없습니다.")
        prohibited = forbidden_phrases(item)
        if prohibited:
            raise _error(f"plainSummary[{index}]", f"에는 권유 표현을 넣을 수 없습니다: {prohibited[0]}")
    title = _required_string(_required(data, "title"), "title")
    one_liner = _required_string(_required(data, "oneLiner"), "oneLiner", limit=ONE_LINER_MAX)
    prohibited = forbidden_phrases(one_liner)
    if prohibited:
        raise _error("oneLiner", f"에는 권유 표현을 넣을 수 없습니다: {prohibited[0]}")
    return {
        "title": title,
        "verdict": _enum(_required(data, "verdict"), "verdict", OPINIONS),
        "oneLiner": one_liner,
        "plainSummary": plain,
        "markdown": _required_string(_required(data, "markdown"), "markdown", limit=None),
        "reasons": _strings(_required(data, "reasons"), "reasons", maximum=MAX_ITEMS),
        "risks": _strings(_required(data, "risks"), "risks", maximum=MAX_ITEMS),
        "targets": _targets(_object(_required(data, "targets"), "targets"), "targets"),
        "confidence": _number(_required(data, "confidence"), "confidence", nullable=True, minimum=0, maximum=100),
        "citations": _strings(_required(data, "citations"), "citations", maximum=10),
    }


def _issue(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {key: _required_string(_required(data, key, path), f"{path}.{key}")
            for key in ("claim", "problem", "fix")}


def _handoff(value: Any) -> dict[str, Any] | None:
    if value is None:
        return None
    data = _object(value, "handoff")
    return {
        "to": _enum(_required(data, "to", "handoff"), "handoff.to", ("risk_agent",)),
        "reason": _required_string(_required(data, "reason", "handoff"), "handoff.reason"),
    }


def _review(data: dict[str, Any]) -> dict[str, Any]:
    verdict = _enum(_required(data, "verdict"), "verdict", ("PASS", "RETRY", "FAIL"))
    instructions = _string(_required(data, "instructions"), "instructions", nullable=True, limit=None)
    if verdict == "RETRY" and not (instructions or "").strip():
        raise _error("instructions", "는 verdict가 RETRY일 때 비어 있을 수 없습니다.")
    return {
        "verdict": verdict,
        "score": _number(_required(data, "score"), "score", nullable=True, minimum=0, maximum=100),
        "issues": _records(_required(data, "issues"), "issues", maximum=10, validator=_issue),
        "instructions": instructions,
        "handoff": _handoff(_required(data, "handoff")),
    }


def _risk(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "level": _enum(_required(data, "level"), "level", RISK_LEVELS),
        "flags": _strings(_required(data, "flags"), "flags", maximum=10),
        "warnings": _strings(_required(data, "warnings"), "warnings", maximum=5),
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
    }


_VALIDATORS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "MarketResult": _market,
    "FundamentalResult": _fundamental,
    "NewsResult": _news,
    "ReportDraft": _report,
    "ReviewResult": _review,
    "RiskResult": _risk,
}

NAMES = tuple(_VALIDATORS)

_CONTRACT_FIELDS = {
    "MarketResult": (
        ("trend", "up/down/sideways 중 하나"), ("summary", "문자열"),
        ("price", "키 필수, 숫자 또는 null"), ("changePct", "키 필수, 숫자 또는 null"),
        ("asOf", "ISO 문자열 또는 null, 생략하면 null"), ("rsi", "키 필수, 숫자 또는 null"),
        ("volatilityPct", "키 필수, 숫자 또는 null"), ("volumeRank", "정수 또는 null"),
        ("support", "키 필수, 숫자 또는 null"), ("resistance", "키 필수, 숫자 또는 null"),
        ("signals", "문자열 목록, 최대 5개"), ("evidence", "문자열 목록, 최대 8개"),
    ),
    "FundamentalResult": (
        ("summary", "문자열"),
        ("metrics", "null 또는 per/pbr/roe/revenueGrowthPct/opMarginPct 객체, 각 값은 숫자 또는 null"),
        ("recentFilings", "date/title/impact 객체 목록, 최대 5개"),
        ("recentFilings[].impact", "positive/negative/neutral 중 하나"),
        ("evidence", "문자열 목록, 최대 8개"),
    ),
    "NewsResult": (
        ("sentiment", "positive/negative/neutral 중 하나"), ("score", "null 또는 -1~1"),
        ("summary", "문자열"),
        ("headlines", "date/title/source/impact 객체 목록, 최대 5개; date와 source는 null 가능"),
        ("evidence", "문자열 목록, 최대 8개"),
    ),
    "ReportDraft": (
        ("title", "문자열"), ("verdict", "buy/hold/avoid 중 하나"), ("oneLiner", "최대 80자"),
        ("plainSummary", "1~3개 문자열, 항목당 100자, 숫자와 권유 표현 금지"), ("markdown", "문자열"),
        ("reasons", "문자열 목록, 최대 3개"), ("risks", "문자열 목록, 최대 3개"),
        ("targets.entry/target/stop", "키 필수, 숫자 또는 null"),
        ("targets.holdingDays", "null 또는 1~20 정수"), ("targets.probability", "null 또는 0~1"),
        ("confidence", "null 또는 0~100"), ("citations", "문자열 목록, 최대 10개"),
    ),
    "ReviewResult": (
        ("verdict", "PASS/RETRY/FAIL 중 하나"), ("score", "null 또는 0~100"),
        ("issues", "claim/problem/fix 객체 목록, 최대 10개"),
        ("instructions", "문자열 또는 null, verdict가 RETRY이면 비어 있지 않은 문자열 필수"),
        ("handoff", "null 또는 to=risk_agent와 reason 객체"),
    ),
    "RiskResult": (
        ("level", "low/medium/high 중 하나"), ("flags", "문자열 목록, 최대 10개"),
        ("warnings", "문자열 목록, 최대 5개"), ("summary", "문자열"),
    ),
}


def _description(fields: tuple[tuple[str, str], ...]) -> str:
    return "; ".join(f"{field}는 {rule}" for field, rule in fields)


_DESCRIPTIONS = {name: _description(_CONTRACT_FIELDS[name]) for name in NAMES}


def validate(name: str, data: Any) -> dict[str, Any]:
    """계약 이름에 맞게 출력값을 검증하고 허용된 키만 반환한다."""
    try:
        validator = _VALIDATORS[name]
    except KeyError:
        raise KeyError(f"모르는 출력 계약입니다: {name!r}") from None
    return validator(_object(data, name))


def describe(name: str) -> str:
    """프롬프트에 넣을 수 있는 간결한 계약 설명을 반환한다."""
    try:
        return _DESCRIPTIONS[name]
    except KeyError:
        raise KeyError(f"모르는 출력 계약입니다: {name!r}") from None
