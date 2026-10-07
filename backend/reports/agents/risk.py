"""증권사 투자 유의 정보와 검토 handoff를 점검하는 Worker."""

from __future__ import annotations

import time
from typing import Any

from reports.contracts import validate

from .base import WorkerContext, WorkerError
from .prompts import risk_user_prompt, system_prompt


def _snapshot_warnings(inputs: dict[str, dict]) -> list[Any]:
    market_result = inputs.get("market_agent") or {}
    warnings = market_result.get("warnings") or []
    return warnings if isinstance(warnings, list) else []


def _handoff_summary(handoff: dict | None) -> dict[str, Any] | None:
    if not handoff:
        return None
    return {key: handoff[key] for key in ("objective", "constraints") if key in handoff}


class RiskWorker:
    id = "risk_agent"
    output_contract = "RiskResult"

    def run(self, ctx: WorkerContext) -> dict:
        remaining = ctx.deadline - time.monotonic()
        if remaining <= 0:
            raise WorkerError("투자 위험 점검 제한 시간을 넘었습니다.")
        warnings = _snapshot_warnings(ctx.inputs)
        if ctx.client is not None:
            try:
                warnings.extend(ctx.client.warnings(ctx.symbol))
            except Exception as exc:
                raise WorkerError("증권사 투자 유의 정보를 조회하지 못했습니다.") from exc
        remaining = ctx.deadline - time.monotonic()
        if remaining <= 0:
            raise WorkerError("투자 위험 점검 제한 시간을 넘었습니다.")
        reply = ctx.llm(
            system_prompt(self.id),
            risk_user_prompt(
                symbol=ctx.symbol, name=ctx.name, market=ctx.market,
                warnings={"items": warnings}, handoff=_handoff_summary(ctx.handoff),
            ),
            contract=self.output_contract,
            timeout=remaining,
        )
        return validate(self.output_contract, reply.data)


WORKER = RiskWorker()
