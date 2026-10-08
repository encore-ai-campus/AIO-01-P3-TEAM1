"""리포트 Worker용 LLM 호출기와 fallback 복구 정책."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass
from enum import Enum

from config import engine
from paper_engine.llm import LlmClient, LlmError, LlmTimeout

from . import contracts, state
from .models import Report

CALL_TIMEOUT_SEC = 60
MAX_ATTEMPTS = 4
MAX_ATTEMPTS_PER_MODEL = 2
RETRY_BACKOFF_SEC = 2
BREAKER_FAILURES = 3
BREAKER_OPEN_SEC = 300

clock, sleep = time.monotonic, time.sleep
_client_lock = threading.Lock()
_client: tuple[str, LlmClient] | None = None


class ErrorType(str, Enum):
    TIMEOUT = "timeout"
    SERVER_ERROR = "server_error"
    BAD_OUTPUT = "bad_output"
    UNKNOWN = "unknown"


# timeout은 기다린 시간이 이미 길기 때문에 같은 모델 재시도 대상에서 제외한다(Q1).
RETRY_SAME_MODEL = (ErrorType.SERVER_ERROR, ErrorType.BAD_OUTPUT)


@dataclass
class LlmReply:
    data: dict
    provider: str | None
    model: str
    attempts: int
    recovered: bool
    latency_ms: int
    recovery_ms: int | None
    cost_usd: float


class LlmGaveUp(Exception):
    """단계 제한 안에서 주 모델과 fallback이 모두 실패했다."""

    def __init__(self, error_type: ErrorType, attempts: int, last_model: str | None, message: str):
        super().__init__(message)
        self.error_type = error_type
        self.attempts = attempts
        self.last_model = last_model
        self.message = message


def classify(error: Exception) -> ErrorType:
    if isinstance(error, LlmTimeout):
        return ErrorType.TIMEOUT
    if isinstance(error, contracts.ContractError):
        return ErrorType.BAD_OUTPUT
    if isinstance(error, LlmError):
        message = str(error)
        if message.startswith("HTTP "):
            code = message[5:8]
            return ErrorType.SERVER_ERROR if code == "429" or code.startswith("5") else ErrorType.UNKNOWN
        if message.startswith("요청 실패"):
            return ErrorType.SERVER_ERROR
        if message.startswith(("빈 응답", "JSON")):
            return ErrorType.BAD_OUTPUT
    return ErrorType.UNKNOWN


class CircuitBreaker:
    def __init__(self):
        self._lock = threading.Lock()
        self._failures: dict[str, int] = {}
        self._opened: dict[str, float] = {}

    def is_open(self, model: str, now: float) -> bool:
        with self._lock:
            opened = self._opened.get(model)
            return opened is not None and now - opened < BREAKER_OPEN_SEC

    def failed(self, model: str, now: float) -> None:
        with self._lock:
            failures = self._failures.get(model, 0) + 1
            self._failures[model] = failures
            if failures >= BREAKER_FAILURES:
                self._opened[model] = now

    def succeeded(self, model: str) -> None:
        with self._lock:
            self._failures.pop(model, None)
            self._opened.pop(model, None)

    def reset(self) -> None:
        with self._lock:
            self._failures.clear()
            self._opened.clear()


breaker = CircuitBreaker()


class LlmCaller:
    """Worker 실행 하나에 묶인 호출기.

    ``attempt``는 이 Worker 실행 안의 LLM 호출 순번이다. 검토 RETRY로 Worker가
    다시 실행되면 Orchestrator가 새 호출기를 만들므로 다시 0부터 시작한다(Q8).
    """

    def __init__(self, report: Report, worker: dict, chaos: dict | None, client, deadline: float):
        self.report = report
        self.worker = worker
        self.chaos = chaos
        self.client = client
        self.deadline = deadline
        self.calls: list[LlmReply] = []
        self.cost_usd = 0.0
        self.attempt = 0

    @property
    def worker_id(self) -> str:
        return self.worker["id"]

    @property
    def provider(self) -> str | None:
        return self.worker.get("provider")

    def __call__(self, system: str, user: str, *, contract: str | None = None,
                 timeout: float | None = None) -> LlmReply:
        models = self._models()
        if not models:
            raise LlmGaveUp(ErrorType.UNKNOWN, 0, None, f"{self.worker_id}: 모델이 정해지지 않았습니다.")

        started = clock()
        first_failure: float | None = None
        total_cost = 0.0
        last_type = ErrorType.TIMEOUT
        last_message = "단계 제한 시간이 지났습니다."
        last_model: str | None = None

        for index, model in enumerate(models):
            last_model = model
            if breaker.is_open(model, clock()):
                self._record("agent_failover", "started", model, None, {
                    "from": model,
                    "to": self._next_available(models, index + 1),
                    "reason": "circuit_open",
                })
                continue

            on_model = 0
            prompt = user
            while self.attempt < MAX_ATTEMPTS and on_model < MAX_ATTEMPTS_PER_MODEL:
                limit = self._call_limit(timeout)
                if limit <= 0:
                    last_type = ErrorType.TIMEOUT
                    break

                self.attempt += 1
                on_model += 1
                begun = clock()
                try:
                    data, cost = self._once(model, system, prompt, limit, contract)
                except _Failed as failure:
                    total_cost += failure.cost
                    last_type = failure.error_type
                    last_message = f"{model}: {failure.error}"
                    first_failure = clock() if first_failure is None else first_failure
                    breaker.failed(model, clock())
                    self._record("agent_failed", "failed", model, begun, {
                        "errorType": last_type.value,
                        "attempt": self.attempt,
                        "injected": False,
                        "final": False,
                    })

                    # Q1: timeout은 이 모델을 다시 부르지 않고 곧바로 fallback으로 간다.
                    if last_type is ErrorType.TIMEOUT:
                        break
                    if last_type not in RETRY_SAME_MODEL or on_model >= MAX_ATTEMPTS_PER_MODEL:
                        break
                    if not self._wait_before_retry(last_type):
                        last_type = ErrorType.TIMEOUT
                        break
                    self._record("agent_retry", "started", model, None, {
                        "attempt": self.attempt + 1,
                        "reason": last_type.value,
                    })
                    if last_type is ErrorType.BAD_OUTPUT:
                        prompt = f"{user}\n\n이전 응답의 문제: {failure.error}\nJSON 객체만 출력하세요."
                    continue

                total_cost += cost
                breaker.succeeded(model)
                ended = clock()
                reply = LlmReply(
                    data=data,
                    provider=self.provider,
                    model=model,
                    attempts=self.attempt,
                    recovered=self.attempt > 1,
                    latency_ms=_ms(ended - started),
                    recovery_ms=None if first_failure is None else _ms(ended - first_failure),
                    cost_usd=total_cost,
                )
                self.calls.append(reply)
                return reply

            target = self._next_available(models, index + 1)
            if target is not None and self.attempt < MAX_ATTEMPTS and self._call_limit(timeout) > 0:
                self._record("agent_failover", "started", target, None, {
                    "from": model,
                    "to": target,
                    "reason": last_type.value,
                })

        raise LlmGaveUp(last_type, self.attempt, last_model, f"{self.worker_id}: {last_message}")

    def _models(self) -> list[str]:
        values = [self.worker.get("model"), *(self.worker.get("fallbacks") or [])]
        return list(dict.fromkeys(model for model in values if model))

    def _next_available(self, models: list[str], start: int) -> str | None:
        now = clock()
        return next((model for model in models[start:] if not breaker.is_open(model, now)), None)

    def _call_limit(self, requested: float | None) -> float:
        limits = [CALL_TIMEOUT_SEC, self.deadline - clock()]
        if requested is not None:
            limits.append(requested)
        return min(limits)

    def _once(self, model: str, system: str, user: str, limit: float,
              contract: str | None) -> tuple[dict, float]:
        cost = 0.0
        try:
            try:
                data, cost = self.client.complete_json_once(model, system, user, limit)
            except LlmError as error:
                cost = error.cost
                raise
            finally:
                self.cost_usd += cost
            if contract is not None:
                data = contracts.validate(contract, data)
        except Exception as error:
            raise _Failed(classify(error), error, cost) from error
        return data, cost

    def _wait_before_retry(self, error_type: ErrorType) -> bool:
        if error_type is not ErrorType.SERVER_ERROR:
            return self.deadline > clock()
        if self.deadline - clock() <= RETRY_BACKOFF_SEC:
            return False
        sleep(RETRY_BACKOFF_SEC)
        return self.deadline > clock()

    def _record(self, action: str, status: str, model: str, begun: float | None, details: dict) -> None:
        state.record(
            self.report,
            self.worker_id,
            action,
            status,
            provider=self.provider,
            model=model,
            latency_ms=None if begun is None else _ms(clock() - begun),
            details=details,
        )


class _Failed(Exception):
    def __init__(self, error_type: ErrorType, error: Exception, cost: float):
        super().__init__(str(error))
        self.error_type = error_type
        self.error = error
        self.cost = cost


def make_caller(report: Report, worker: dict, chaos: dict | None, client, deadline: float) -> LlmCaller:
    return LlmCaller(report, worker, chaos, client, deadline)


def llm_client() -> LlmClient | None:
    """설정된 DevPass 키의 프로세스 공용 클라이언트. 키가 없으면 None."""
    global _client
    key = engine.engine_config().llm_api_key
    if not key:
        return None
    with _client_lock:
        if _client is None or _client[0] != key:
            _client = (key, LlmClient(key))
        return _client[1]


def _ms(seconds: float) -> int:
    return max(int(seconds * 1_000), 0)
