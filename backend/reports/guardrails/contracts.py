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
PLAIN_ITEM_MAX = 100   # plainSummary 항목 하나의 길이 상한
MAX_ITEMS = 3
MIN_HOLDING_DAYS = 1
MAX_HOLDING_DAYS = 20
OPINIONS = ("buy", "hold", "avoid")
RISK_LEVELS = ("low", "medium", "high")
# 코드만 붙이는 ReviewResult 선택 키 (2026-10-12, docs/DECISIONS.md 30장): 선정 검토의 마지막 검토가 지적을 남긴 채 통과했다는 표시.
# 값이 정확히 true일 때만 남는다. LLM에는 알리지 않는다 (_DESCRIPTIONS에 넣지 않는다 — 검토 Worker가 LLM이 보낸 값을 지운다)
REVIEW_ACCEPTED = "acceptedWithNotes"
# 매매 종목 선정 팀 (docs/design/AI_AGENT_WORKFLOW.md 2장)
SENTIMENTS = ("positive", "negative", "neutral")
FILING_SEVERITIES = ("none", "low", "high")
FLOW_SIGNALS = ("accumulating", "mixed", "distributing")
MAX_CANDIDATES = 40   # 선정 팀 조사 결과의 항목 상한 (규칙 후보는 30개)
MAX_SELECTION = 5     # selector_agent가 내는 순위 수 상한
SYMBOL_MAX = 20
THEME_MAX = 30


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
        # 가격 기준 (2026-10-08, docs/API.md "리포트 시세"): live = 장 중 현재가, close = 직전 정규장 종가. 코드가 채운다 (없으면 null = close)
        "priceBasis": None if data.get("priceBasis") is None else _enum(data["priceBasis"], "priceBasis", ("live", "close")),
        "rsi": _number(_required(data, "rsi"), "rsi", nullable=True),
        "volatilityPct": _number(_required(data, "volatilityPct"), "volatilityPct", nullable=True),
        "volumeRank": _integer(_required(data, "volumeRank"), "volumeRank", nullable=True),
        "support": _number(_required(data, "support"), "support", nullable=True),
        "resistance": _number(_required(data, "resistance"), "resistance", nullable=True),
        "stop": _number(data.get("stop"), "stop", nullable=True),  # 코드가 정한 손절 가격 (LLM은 쓰지 않아도 된다)
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
    plain = _strings(_required(data, "plainSummary"), "plainSummary", maximum=3, minimum=1, item_limit=PLAIN_ITEM_MAX)
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
    result = {
        "verdict": verdict,
        "score": _number(_required(data, "score"), "score", nullable=True, minimum=0, maximum=100),
        "issues": _records(_required(data, "issues"), "issues", maximum=10, validator=_issue),
        "instructions": instructions,
        "handoff": _handoff(_required(data, "handoff")),
    }
    if data.get(REVIEW_ACCEPTED) is True:  # 그 밖의 값이면 키를 만들지 않는다 (옛 결과·종목 리포트 검토는 글자 그대로)
        result[REVIEW_ACCEPTED] = True
    return result


def _risk(data: dict[str, Any]) -> dict[str, Any]:
    return {
        "level": _enum(_required(data, "level"), "level", RISK_LEVELS),
        "flags": _strings(_required(data, "flags"), "flags", maximum=10),
        "warnings": _strings(_required(data, "warnings"), "warnings", maximum=5),
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
    }


def _symbol(data: dict[str, Any], path: str) -> str:
    return _required_string(_required(data, "symbol", path), f"{path}.symbol", limit=SYMBOL_MAX)


def _unique_symbols(items: list[dict[str, Any]], path: str) -> list[dict[str, Any]]:
    seen: set[str] = set()
    for index, item in enumerate(items):
        if item["symbol"] in seen:
            raise _error(f"{path}[{index}].symbol", f"가 중복됐습니다: {item['symbol']}")
        seen.add(item["symbol"])
    return items


def _candidate_news_item(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "symbol": _symbol(data, path),
        "sentiment": _enum(_required(data, "sentiment", path), f"{path}.sentiment", SENTIMENTS),
        "materials": _strings(_required(data, "materials", path), f"{path}.materials", maximum=MAX_ITEMS),
        "concerns": _strings(_required(data, "concerns", path), f"{path}.concerns", maximum=MAX_ITEMS),
        "theme": _theme(_required(data, "theme", path), f"{path}.theme"),
        "evidence": _strings(_required(data, "evidence", path), f"{path}.evidence", maximum=MAX_ITEMS),
    }


def _theme(value: Any, path: str) -> str | None:
    theme = _string(value, path, limit=THEME_MAX, nullable=True)
    return (theme or "").strip() or None


def _candidate_news(data: dict[str, Any]) -> dict[str, Any]:
    items = _records(_required(data, "items"), "items", maximum=MAX_CANDIDATES, validator=_candidate_news_item)
    return {
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "items": _unique_symbols(items, "items"),
    }


def _filing_check_item(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "symbol": _symbol(data, path),
        "severity": _enum(_required(data, "severity", path), f"{path}.severity", FILING_SEVERITIES),
        "signals": _strings(_required(data, "signals", path), f"{path}.signals", maximum=MAX_ITEMS),
        "evidence": _strings(_required(data, "evidence", path), f"{path}.evidence", maximum=MAX_ITEMS),
    }


def _filing_check(data: dict[str, Any]) -> dict[str, Any]:
    items = _records(_required(data, "items"), "items", maximum=MAX_CANDIDATES, validator=_filing_check_item)
    return {
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "items": _unique_symbols(items, "items"),
    }


def _flow_item(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "symbol": _symbol(data, path),
        "signal": _enum(_required(data, "signal", path), f"{path}.signal", FLOW_SIGNALS),
        "note": _string(_required(data, "note", path), f"{path}.note", nullable=True),
    }


def _flow(data: dict[str, Any]) -> dict[str, Any]:
    items = _records(_required(data, "items"), "items", maximum=MAX_CANDIDATES, validator=_flow_item)
    return {
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "items": _unique_symbols(items, "items"),
    }


def _selection_pick(data: dict[str, Any], path: str) -> dict[str, Any]:
    return {
        "symbol": _symbol(data, path),
        "rank": _integer(_required(data, "rank", path), f"{path}.rank", minimum=1, maximum=MAX_SELECTION),
        "reason": _required_string(_required(data, "reason", path), f"{path}.reason"),
        "evidence": _strings(_required(data, "evidence", path), f"{path}.evidence", maximum=MAX_ITEMS),
    }


def _selection(data: dict[str, Any]) -> dict[str, Any]:
    """선정안: 순위 1~5개와 근거. 가격은 받지 않는다 (진입·목표·손절은 종목 리포트가 정한다)."""
    picks = _records(_required(data, "picks"), "picks", maximum=MAX_SELECTION, validator=_selection_pick)
    if not picks:
        raise _error("picks", "는 항목이 1개 이상이어야 합니다.")
    _unique_symbols(picks, "picks")
    ranks = [pick["rank"] for pick in picks]
    if len(set(ranks)) != len(ranks):
        raise _error("picks", f"의 rank가 중복됐습니다: {ranks}")
    return {
        "summary": _required_string(_required(data, "summary"), "summary", limit=SUMMARY_MAX),
        "picks": sorted(picks, key=lambda pick: pick["rank"]),
    }


_VALIDATORS: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {
    "MarketResult": _market,
    "FundamentalResult": _fundamental,
    "NewsResult": _news,
    "ReportDraft": _report,
    "ReviewResult": _review,
    "RiskResult": _risk,
    "CandidateNewsResult": _candidate_news,
    "FilingCheckResult": _filing_check,
    "FlowResult": _flow,
    "SelectionDraft": _selection,
}

NAMES = tuple(_VALIDATORS)

_DESCRIPTIONS = {
    "MarketResult": "trend(up/down/sideways), summary, price·changePct·asOf·rsi·volatilityPct·volumeRank·support·"
                    "resistance(키 필수, 값 null 가능; volumeRank는 정수), priceBasis(live/close, null 가능), "
                    "signals(최대 5), evidence(최대 8)",
    "FundamentalResult": "summary, metrics(null 가능 또는 per/pbr/roe/revenueGrowthPct/opMarginPct; 각 값 null 가능), "
                         "recentFilings(date/title/impact[positive/negative/neutral]; 최대 5), evidence(최대 8)",
    "NewsResult": "sentiment(positive/negative/neutral), score(null 또는 -1~1), summary, "
                  "headlines(date[null 가능]/title/source[null 가능]/impact; 최대 5), evidence(최대 8)",
    "ReportDraft": "title, verdict(buy/hold/avoid), oneLiner(80자), plainSummary(1~3개, 항목당 100자, 숫자 금지), "
                   "markdown, reasons(최대 3), risks(최대 3), targets(entry/target/stop[null 가능], "
                   "holdingDays[null 또는 1~20 정수], probability[null 또는 0~1]), confidence(null 또는 0~100), "
                   "citations(최대 10)",
    "ReviewResult": "verdict(PASS/RETRY/FAIL), score(null 또는 0~100), issues(claim/problem/fix; 최대 10), "
                    "instructions(RETRY이면 필수), handoff(null 또는 risk_agent와 reason)",
    "RiskResult": "level(low/medium/high), flags(최대 10), warnings(최대 5), summary",
    "CandidateNewsResult": "summary, items(후보마다 하나, 최대 40; symbol, sentiment(positive/negative/neutral), "
                           "materials(재료 최대 3), concerns(악재 최대 3), theme(짧은 테마 이름 또는 null), "
                           "evidence(뉴스 제목·매체·날짜 최대 3)). symbol은 중복 없이",
    "FilingCheckResult": "summary, items(후보마다 하나, 최대 40; symbol, severity(none/low/high), "
                         "signals(위험 신호 최대 3), evidence(공시 제목·날짜 최대 3)). symbol은 중복 없이",
    "FlowResult": "summary, items(후보마다 하나, 최대 40; symbol, signal(accumulating/mixed/distributing), "
                  "note(한 줄 해석 또는 null)). symbol은 중복 없이",
    "SelectionDraft": "summary, picks(1~5개; symbol, rank(1~5 정수, 중복 없이), reason(고른 이유), "
                      "evidence(조사 결과에서 가져온 근거 최대 3)). 가격·목표가·손절가는 쓰지 않는다",
}


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
