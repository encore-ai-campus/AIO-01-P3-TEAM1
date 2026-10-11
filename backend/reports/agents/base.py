"""리포트 Worker가 공통으로 따르는 인터페이스."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from paper_engine.config import Config
    from paper_engine.data.broker import BrokerClient
    from reports.autohealing.healing import LlmReply


class LlmCallerProtocol(Protocol):
    calls: list[LlmReply]
    cost_usd: float

    def __call__(
        self,
        system: str,
        user: str,
        *,
        contract: str | None = None,
        timeout: float | None = None,
    ) -> LlmReply: ...


class WorkerError(Exception):
    """LLM 외의 이유로 Worker가 결과를 만들 수 없을 때 발생한다."""


@dataclass
class WorkerContext:
    report_id: int
    task_id: str
    symbol: str
    name: str
    market: str
    worker_id: str
    attempt: int
    inputs: dict[str, dict]
    instructions: str | None
    handoff: dict | None
    llm: LlmCallerProtocol
    deadline: float
    cfg: Config
    client: BrokerClient | None
    # 팀 실행 전체가 같이 쓰는 입력 (Orchestrator가 실행 시작 때 한 번 만든다).
    # 선정 팀(stock_selection)은 {"market", "day", "candidates": [규칙 후보 ...]} — reports.autoreport.selection.team_inputs. 종목 리포트는 None
    team_inputs: dict | None = None
    # (2026-10-12) 검토 반복으로 다시 실행되는 검토 Worker에만 주는 값 (docs/DECISIONS.md 30장). 그 밖에는 None.
    # {"round": n, "review": 직전 ReviewResult, "draft": 그 검토가 본 target 초안}. 선정 검토가 읽는다 (종목 리포트 검토·작성 Worker는 읽지 않는다)
    retry: dict | None = None


class Worker(Protocol):
    id: str
    output_contract: str

    def run(self, ctx: WorkerContext) -> dict: ...
