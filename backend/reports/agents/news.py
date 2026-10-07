"""뉴스·증권사 리포트 헤드라인을 Guard로 정리하는 심리 Worker."""

from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from paper_engine.data import broker_reports
from paper_engine.data.news import fetch_news

from reports.contracts import validate

from .base import WorkerContext, WorkerError
from .prompts import news_user_prompt, system_prompt

NEWS_LIMIT = 15
REPORT_LIMIT = 10


def _deadline(ctx: WorkerContext) -> float:
    remaining = ctx.deadline - time.monotonic()
    if remaining <= 0:
        raise WorkerError("뉴스·심리 분석 제한 시간을 넘었습니다.")
    return remaining


def _guard() -> Callable[[str], tuple[str, list[str]]]:
    try:
        from reports.guards import clean_text
    except ImportError as exc:
        raise WorkerError("입력 Guard가 준비되지 않아 외부 뉴스 자료를 사용할 수 없습니다.") from exc
    return clean_text


def _clean_item(
    item: dict[str, Any], fields: tuple[str, ...], clean_text: Callable[[str], tuple[str, list[str]]], path: str,
) -> tuple[dict[str, Any], list[str]]:
    cleaned = dict(item)
    guarded = []
    for field in fields:
        value = item.get(field)
        if not isinstance(value, str):
            continue
        text, reasons = clean_text(value)
        cleaned[field] = text
        guarded.extend(f"{path}.{field}: {reason}" for reason in reasons)
    return cleaned, guarded


def _collect(ctx: WorkerContext) -> tuple[dict[str, Any], list[str]]:
    market = ctx.market.upper()
    if market not in ("KR", "US"):
        return {"availability": f"지원하지 않는 뉴스 시장입니다: {market}", "news": [], "brokerReports": []}, []

    query = ctx.name if market == "KR" else f"{ctx.name} {ctx.symbol} stock"
    errors = []
    try:
        news = fetch_news(query, market, limit=NEWS_LIMIT)
    except Exception as exc:
        news = []
        errors.append(f"뉴스 조회 실패: {type(exc).__name__}")
    _deadline(ctx)
    reports = broker_reports.stock_reports(ctx.name, ctx.symbol, market, limit=REPORT_LIMIT)
    _deadline(ctx)

    if not news and not reports:
        reason = "; ".join(errors) or "조회된 뉴스와 증권사 리포트가 없습니다."
        return {"availability": reason, "news": [], "brokerReports": []}, []

    clean_text = _guard()
    cleaned_news, cleaned_reports, guarded = [], [], []
    for index, item in enumerate(news):
        cleaned, reasons = _clean_item(item, ("title", "source"), clean_text, f"news[{index}]")
        if cleaned.get("title"):
            cleaned_news.append(cleaned)
        guarded.extend(reasons)
    for index, item in enumerate(reports):
        cleaned, reasons = _clean_item(
            item, ("title", "source", "broker"), clean_text, f"brokerReports[{index}]",
        )
        if cleaned.get("title"):
            cleaned_reports.append(cleaned)
        guarded.extend(reasons)
    return {
        "availability": "; ".join(errors) or "자료 조회 완료",
        "news": cleaned_news,
        "brokerReports": cleaned_reports,
    }, list(dict.fromkeys(guarded))


def _source_headlines(materials: dict[str, Any]) -> list[dict[str, Any]]:
    rows = []
    for item in materials["news"][:5]:
        published = item.get("publishedAt")
        rows.append({
            "date": str(published)[:10] if published else None,
            "title": item["title"],
            "source": item.get("source") or None,
        })
    return rows


def _verified_headlines(llm_rows: Any, source_rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not isinstance(llm_rows, list):
        return []
    allowed = {(row["date"], row["title"]): row for row in source_rows}
    verified = []
    for row in llm_rows:
        if not isinstance(row, dict):
            continue
        source = allowed.get((row.get("date"), row.get("title")))
        if source:
            verified.append({**source, "impact": row.get("impact")})
    return verified


def _evidence(materials: dict[str, Any]) -> list[str]:
    evidence = [
        f"뉴스 {str(item.get('publishedAt') or '')[:10]} · {item['title']}"
        + (f" · {item['source']}" if item.get("source") else "")
        for item in materials["news"]
    ]
    evidence.extend(
        f"증권사 리포트 {str(item.get('publishedAt') or '')[:10]} · {item['title']}"
        for item in materials["brokerReports"]
    )
    if not evidence:
        evidence.append(f"뉴스·증권사 리포트 자료 없음 ({materials['availability']})")
    return evidence[:8]


class NewsWorker:
    id = "news_agent"
    output_contract = "NewsResult"

    def run(self, ctx: WorkerContext) -> dict:
        _deadline(ctx)
        materials, guarded = _collect(ctx)
        source_headlines = _source_headlines(materials)
        reply = ctx.llm(
            system_prompt(self.id),
            news_user_prompt(symbol=ctx.symbol, name=ctx.name, market=ctx.market, data=materials),
            contract=self.output_contract,
            timeout=_deadline(ctx),
        )
        result = dict(reply.data)
        result.update({
            "headlines": _verified_headlines(result.get("headlines"), source_headlines),
            "evidence": _evidence(materials),
        })
        validated = validate(self.output_contract, result)
        if guarded:
            validated["_guarded"] = guarded
        return validated


WORKER = NewsWorker()
