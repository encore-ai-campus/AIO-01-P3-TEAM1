"""조사 결과를 종합해 리포트 초안을 작성하는 Worker."""

from __future__ import annotations

import time

from reports.contracts import validate

from .base import WorkerContext, WorkerError
from .prompts import report_user_prompt, system_prompt


class ReportWorker:
    id = "report_agent"
    output_contract = "ReportDraft"

    def run(self, ctx: WorkerContext) -> dict:
        remaining = ctx.deadline - time.monotonic()
        if remaining <= 0:
            raise WorkerError("리포트 작성 제한 시간을 넘었습니다.")
        reply = ctx.llm(
            system_prompt(self.id),
            report_user_prompt(
                symbol=ctx.symbol, name=ctx.name, market=ctx.market,
                inputs=ctx.inputs, instructions=ctx.instructions,
            ),
            contract=self.output_contract,
            timeout=remaining,
        )
        return validate(self.output_contract, reply.data)


WORKER = ReportWorker()
