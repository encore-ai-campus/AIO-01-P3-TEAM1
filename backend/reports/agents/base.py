"""리포트 Worker가 공통으로 따르는 인터페이스."""

from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Protocol

if TYPE_CHECKING:
    from paper_engine.config import Config
    from paper_engine.data.broker import BrokerClient


class LlmCallerProtocol(Protocol):
    def __call__(
        self,
        system: str,
        user: str,
        *,
        contract: str | None = None,
        timeout: float | None = None,
    ) -> Any: ...


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


class Worker(Protocol):
    id: str
    output_contract: str

    def run(self, ctx: WorkerContext) -> dict: ...
