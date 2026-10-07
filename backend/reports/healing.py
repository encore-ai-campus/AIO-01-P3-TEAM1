"""리포트 Worker의 LLM 호출기 (docs/tasks/00-공통.md 7절, 04-autohealing.md T4-3~T4-6).

Orchestrator가 Worker마다 `make_caller`로 호출기를 만들어 `ctx.llm`에 넣고, Worker는 `ctx.llm(system, user, contract=...)`로 부른다.
호출기는 실패를 분류(ErrorType)하고 Trace에 `agent_failed(final: false)`를 남긴다. 모든 모델이 실패하면 `LlmGaveUp`.
Trace는 `state.record`로만 남긴다 (`add_result`·`add_error`·`finish`는 Orchestrator 몫).

지금(T4-3 뼈대)은 주 모델을 **한 번만** 부르고 실패하면 바로 포기한다.
재시도·대체 모델(T4-4), Circuit Breaker(T4-5), 장애 주입(T4-6)은 `__call__` 안에 더한다 — 서명은 바꾸지 않는다.
"""
import threading
import time
from dataclasses import dataclass
from enum import Enum

from config import engine
from paper_engine.llm import TIMEOUT_SEC, LlmClient, LlmError, LlmTimeout

from . import contracts, state
from .models import Report

clock = time.monotonic  # 테스트가 가짜 시계로 바꾼다 (deadline도 같은 시계 기준)
_client_lock = threading.Lock()
_client: tuple[str, LlmClient] | None = None  # (키, 클라이언트) — llm_client()


class ErrorType(str, Enum):
    TIMEOUT = "timeout"            # 제한 시간 안에 응답 없음 → (T4-4) 같은 모델로 다시 하지 않고 다음 모델로
    SERVER_ERROR = "server_error"  # HTTP 429·5xx·연결 실패 → (T4-4) 잠깐 쉬고 같은 모델 재시도
    BAD_OUTPUT = "bad_output"      # JSON 아님·빈 응답·출력 계약 위반 → (T4-4) 오류를 알려 주고 같은 모델 재요청
    UNKNOWN = "unknown"            # 그 밖 (HTTP 400·401 등)


@dataclass
class LlmReply:
    data: dict                 # 응답 JSON (contract를 줬으면 검증·정리를 통과한 것)
    provider: str | None
    model: str                 # 실제로 답한 모델
    attempts: int              # 이 호출에 쓴 시도 수 (1이면 한 번에 성공)
    recovered: bool            # attempts > 1
    latency_ms: int            # 첫 시도 시작부터 성공까지
    recovery_ms: int | None    # 첫 실패부터 성공까지 (실패가 없었으면 None). agent_completed.details.recoveryMs가 된다
    cost_usd: float


class LlmGaveUp(Exception):
    """모든 모델이 실패함. Orchestrator가 잡아 `agent_failed(final: true)`와 `add_error`를 남긴다."""

    def __init__(self, error_type: ErrorType, attempts: int, last_model: str | None, message: str):
        super().__init__(message)
        self.error_type, self.attempts, self.last_model, self.message = error_type, attempts, last_model, message


def classify(error: Exception) -> ErrorType:
    """실패 하나를 분류한다. 엔진 LlmClient의 예외 문장(`engine/paper_engine/llm.py`)을 기준으로 한다."""
    if isinstance(error, LlmTimeout):
        return ErrorType.TIMEOUT
    if isinstance(error, contracts.ContractError):
        return ErrorType.BAD_OUTPUT
    if isinstance(error, LlmError):
        text = str(error)
        if text.startswith("HTTP "):
            code = text[5:8]
            return ErrorType.SERVER_ERROR if code == "429" or code.startswith("5") else ErrorType.UNKNOWN
        if text.startswith("요청 실패"):  # 연결 실패
            return ErrorType.SERVER_ERROR
        if text.startswith(("빈 응답", "JSON")):  # extract_json의 실패
            return ErrorType.BAD_OUTPUT
    return ErrorType.UNKNOWN


class LlmCaller:
    """리포트 하나의 Worker 하나에 묶인 호출기. Orchestrator가 만들어 ctx.llm에 넣는다."""

    def __init__(self, report: Report, worker: dict, chaos: dict | None, client, deadline: float):
        self.report, self.worker, self.chaos, self.client, self.deadline = report, worker, chaos, client, deadline
        self.calls: list[LlmReply] = []   # 성공한 호출 기록 (Orchestrator가 agent_completed의 attempts·model을 여기서 읽는다)
        self.cost_usd = 0.0
        self.attempt = 0                  # 이 Worker 실행에서의 전체 시도 번호 (agent_failed.details.attempt)

    @property
    def worker_id(self) -> str:
        return self.worker["id"]

    @property
    def provider(self) -> str | None:
        return self.worker.get("provider")

    @property
    def models(self) -> list[str]:
        """부를 순서: [주 모델] + 대체 모델 (비었거나 겹치는 이름은 뺀다)."""
        names = [self.worker.get("model"), *(self.worker.get("fallbacks") or [])]
        return list(dict.fromkeys(name for name in names if name))

    def __call__(self, system: str, user: str, *, contract: str | None = None,
                 timeout: float | None = None) -> LlmReply:
        models = self.models
        if not models:
            raise LlmGaveUp(ErrorType.UNKNOWN, 0, None, f"{self.worker_id}: 모델이 정해지지 않았습니다.")
        model = models[0]
        started = clock()
        limit = min(timeout or TIMEOUT_SEC, self.deadline - started)
        if limit <= 0:
            raise LlmGaveUp(ErrorType.TIMEOUT, 0, model, f"{self.worker_id}: 제한 시간이 지나 부르지 않았습니다.")
        self.attempt += 1
        cost = 0.0
        try:
            try:
                data, cost = self.client.complete_json_once(model, system, user, limit)
            except LlmError as e:
                cost = e.cost  # 응답을 받은 뒤의 실패(빈 응답·JSON 아님)도 비용은 들었다
                raise
            finally:
                self.cost_usd += cost
            if contract is not None:
                data = contracts.validate(contract, data)
        except Exception as e:  # 분류할 수 없는 예외도 한 번의 실패로 남기고 포기한다
            error_type = classify(e)
            self._failed(model, error_type, started)
            raise LlmGaveUp(error_type, 1, model, f"{model}: {e}") from e
        reply = LlmReply(data=data, provider=self.provider, model=model, attempts=1, recovered=False,
                         latency_ms=_ms(clock() - started), recovery_ms=None, cost_usd=cost)
        self.calls.append(reply)
        return reply

    def _failed(self, model: str, error_type: ErrorType, started: float, injected: bool = False) -> None:
        state.record(self.report, self.worker_id, "agent_failed", "failed", provider=self.provider, model=model,
                     latency_ms=_ms(clock() - started),
                     details={"errorType": error_type.value, "attempt": self.attempt, "injected": injected,
                              "final": False})


def make_caller(report: Report, worker: dict, chaos: dict | None, client, deadline: float) -> LlmCaller:
    """Worker 하나(실행 계획의 `workers[]` 항목)의 호출기. client는 `complete_json_once`가 있는 LLM 클라이언트
    (실제로는 `llm_client()`, 테스트는 fake_llm)."""
    return LlmCaller(report, worker, chaos, client, deadline)


def llm_client() -> LlmClient | None:
    """리포트 Worker가 쓰는 DevPass LLM Gateway 클라이언트 (.env의 DEVPASS_APIKEY). 키가 없으면 None.

    프로세스에 하나만 두고 키가 바뀌면 새로 만든다. 모든 Worker가 같은 게이트웨이를 쓴다 (YAML provider: devpass).
    """
    global _client
    key = engine.engine_config().llm_api_key
    if not key:
        return None
    with _client_lock:
        if _client is None or _client[0] != key:
            _client = (key, LlmClient(key))
        return _client[1]


def _ms(seconds: float) -> int:
    return max(int(seconds * 1000), 0)
