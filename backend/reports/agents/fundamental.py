"""DART·data.go.kr 자료를 사용하는 재무·공시 Worker."""

from __future__ import annotations

import math
import time
from datetime import date
from typing import Any

from config import engine
from paper_engine.data.dart import DartClient
from paper_engine.data.fina_stat import FinaStatClient, history_fundamentals

from reports.contracts import validate

from .base import WorkerContext, WorkerError
from .prompts import fundamental_user_prompt, system_prompt


def _deadline(ctx: WorkerContext) -> float:
    remaining = ctx.deadline - time.monotonic()
    if remaining <= 0:
        raise WorkerError("재무·공시 분석 제한 시간을 넘었습니다.")
    return remaining


def _number(value: Any, *, percent: bool = False) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if not math.isfinite(number):
        return None
    return round(number * 100 if percent else number, 4)


def _metrics(fundamentals: dict | None) -> dict[str, float | None] | None:
    if not fundamentals:
        return None
    ratios = fundamentals.get("ratios") or {}
    reported = fundamentals.get("reported") or {}
    return {
        "per": _number(ratios.get("per")),
        "pbr": _number(ratios.get("pbr")),
        "roe": _number(reported.get("roe"), percent=True),
        "revenueGrowthPct": _number(ratios.get("annualRevenueGrowth"), percent=True),
        "opMarginPct": _number(ratios.get("operatingMargin"), percent=True),
    }


def _price(ctx: WorkerContext) -> float | None:
    value = (ctx.inputs.get("market_agent") or {}).get("price")
    return _number(value)


def _filings(disclosures: dict | None) -> list[dict[str, Any]]:
    if not isinstance(disclosures, dict):
        return []
    return [
        {"date": item.get("date"), "title": item.get("title"), "filer": item.get("filer")}
        for item in (disclosures.get("items") or [])[:5]
        if item.get("date") and item.get("title")
    ]


def _verified_filings(llm_rows: Any, source_rows: list[dict[str, Any]]) -> list[dict[str, str]]:
    if not isinstance(llm_rows, list):
        return []
    allowed = {(row["date"], row["title"]) for row in source_rows}
    verified = []
    for row in llm_rows:
        if not isinstance(row, dict) or (row.get("date"), row.get("title")) not in allowed:
            continue
        verified.append({"date": row["date"], "title": row["title"], "impact": row.get("impact")})
    return verified


def _evidence(fundamentals: dict | None, filings: list[dict[str, Any]], reason: str | None) -> list[str]:
    evidence = []
    if fundamentals:
        source = fundamentals.get("source") or "재무 자료"
        report = fundamentals.get("report") or {}
        label = report.get("label")
        received = report.get("receivedAt")
        evidence.append(" · ".join(part for part in (str(source), label, received) if part))
        history = fundamentals.get("annualHistory") or {}
        years = [str(row.get("year")) for row in history.get("years") or [] if row.get("year")]
        if years:
            evidence.append(f"data.go.kr 연간 재무 {years[-1]}~{years[0]}")
    evidence.extend(f"공시 {row['date']} · {row['title']}" for row in filings)
    if not evidence:
        evidence.append(f"재무·공시 자료 없음 ({reason or '조회 결과 없음'})")
    return evidence[:8]


def _materials(ctx: WorkerContext) -> tuple[dict[str, Any], dict | None, list[dict[str, Any]], str | None]:
    if ctx.market.upper() != "KR":
        reason = "DART 재무·공시는 국내 종목만 지원합니다."
        return {"availability": reason, "fundamentals": None, "recentFilings": []}, None, [], reason
    if not ctx.cfg.dart_api_key:
        reason = "DART_API_KEY가 없어 자료를 조회하지 못했습니다."
        return {"availability": reason, "fundamentals": None, "recentFilings": []}, None, [], reason

    dart = DartClient(ctx.cfg.dart_api_key, engine.CACHE_DIR)
    fundamentals = disclosures = history = None
    errors = []
    try:
        fundamentals = dart.fundamentals(ctx.symbol, _price(ctx), date.today())
        disclosures = dart.disclosures(ctx.symbol, date.today())
    except Exception as exc:
        errors.append(f"DART 조회 실패: {type(exc).__name__}")
    _deadline(ctx)

    if ctx.cfg.data_gokr_api_key:
        try:
            corporate_number = dart.jurir_no(ctx.symbol)
            if corporate_number:
                history = FinaStatClient(ctx.cfg.data_gokr_api_key).annual_history(corporate_number)
                if fundamentals and history:
                    fundamentals["annualHistory"] = history
                elif history:
                    fundamentals = history_fundamentals(history, _price(ctx))
        except Exception as exc:
            errors.append(f"data.go.kr 조회 실패: {type(exc).__name__}")
        _deadline(ctx)

    filings = _filings(disclosures)
    reason = "; ".join(errors) or (None if fundamentals or filings else "조회된 자료가 없습니다.")
    materials = {
        "availability": reason or "자료 조회 완료",
        "fundamentals": fundamentals,
        "metrics": _metrics(fundamentals),
        "recentFilings": filings,
    }
    return materials, fundamentals, filings, reason


class FundamentalWorker:
    id = "fundamental_agent"
    output_contract = "FundamentalResult"

    def run(self, ctx: WorkerContext) -> dict:
        _deadline(ctx)
        materials, fundamentals, filings, reason = _materials(ctx)
        reply = ctx.llm(
            system_prompt(self.id),
            fundamental_user_prompt(
                symbol=ctx.symbol, name=ctx.name, market=ctx.market, data=materials,
            ),
            contract=self.output_contract,
            timeout=_deadline(ctx),
        )
        result = dict(reply.data)
        result.update({
            "metrics": _metrics(fundamentals),
            "recentFilings": _verified_filings(result.get("recentFilings"), filings),
            "evidence": _evidence(fundamentals, filings, reason),
        })
        return validate(self.output_contract, result)


WORKER = FundamentalWorker()
