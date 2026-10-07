"""조사 결과와 리포트 초안을 대조하는 검토 Worker."""

from __future__ import annotations

import time

from reports.contracts import validate

from .base import WorkerContext, WorkerError
from .prompts import review_user_prompt, system_prompt


class ReviewWorker:
    id = "review_agent"
    output_contract = "ReviewResult"

    def run(self, ctx: WorkerContext) -> dict:
        remaining = ctx.deadline - time.monotonic()
        if remaining <= 0:
            raise WorkerError("리포트 검토 제한 시간을 넘었습니다.")
        if "report_agent" not in ctx.inputs:
            raise WorkerError("검토할 리포트 초안이 없습니다.")
        reply = ctx.llm(
            system_prompt(self.id),
            review_user_prompt(
                symbol=ctx.symbol, name=ctx.name, market=ctx.market, inputs=ctx.inputs,
            ),
            contract=self.output_contract,
            timeout=remaining,
        )
        return validate(self.output_contract, reply.data)


WORKER = ReviewWorker()
