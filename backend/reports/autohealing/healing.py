"""리포트 Worker의 LLM 호출기 (docs/tasks/00-공통.md 7절, 04-autohealing.md T4-3~T4-6).

Orchestrator가 Worker마다 `make_caller`로 호출기를 만들어 `ctx.llm`에 넣고, Worker는 `ctx.llm(system, user, contract=...)`로 부른다.
Trace는 `state.record`로만 남긴다 (`add_result`·`add_error`·`finish`는 Orchestrator 몫).

한 번의 `ctx.llm(...)` 안에서 (2026-10-07 결정, 2026-10-08 timeout 규칙 바뀜 — 00-공통.md 7절):
- 주 모델(YAML `model`)을 부르고, 실패하면 종류를 나눈다(ErrorType). unknown이 아니면 **같은 모델로 한 번** 더 한다
  (server_error는 RETRY_BACKOFF_SEC 쉬고, bad_output은 문제를 user 끝에 붙여서).
  단 **주 모델의 timeout**은 이미 제한 시간을 다 기다렸으므로 다시 부르지 않고 바로 대체 모델로 간다 (넘어갈 대체 모델이 없을 때만 같은 모델로 한 번 더).
- 그래도 실패하면 **대체 모델 하나**로 넘어간다: FALLBACK_POOL 순서에서 주 모델이 아니고 Circuit Breaker로 막히지 않은 첫 모델.
  YAML의 `fallbacks`는 쓰지 않는다. 대체 모델은 timeout이어도 같은 모델로 한 번 더 할 수 있다.
- 시도는 모델마다 MAX_ATTEMPTS_PER_MODEL, 전체 MAX_ATTEMPTS(첫 시도 + 재시도 3번), Worker `deadline` 안에서만. 넘으면 `LlmGaveUp`.
- Circuit Breaker: 모델별 연속 실패 BREAKER_FAILURES번이면 BREAKER_OPEN_SEC 동안 그 모델을 건너뛴다 (이 프로세스 메모리).
  장애 주입을 켠 리포트는 그 리포트 전용 Breaker(`ReportBreaker`)에서 센다 — 일부러 낸 실패가 다른 리포트의 모델을 막지 않게.
장애 주입(T4-6, `chaos.py`)은 `_once`의 실제 호출 직전 한 곳에서만 한다. 복구 경로에는 "주입이면"이라는 분기를 두지 않는다
(주입된 실패도 그 리포트의 Circuit Breaker가 센다). 주입 여부는 Trace `agent_failed.details.injected`에만 남는다.
"""
import threading
import time
from dataclasses import dataclass
from enum import Enum

from config import engine
from paper_engine.llm import LlmClient, LlmError, LlmTimeout

from . import chaos as injection
from ..guardrails import contracts
from ..orchestration import state
from ..models import Report

FALLBACK_POOL = ("gpt-5.6-luna", "gemini-3.8-flash", "deepseek-v4.1-flash")  # 대체 모델 후보 (이 순서로 고른다)
CALL_TIMEOUT_SEC = 60       # 호출 한 번의 제한 시간 (Worker deadline이 더 가까우면 그때까지)
MAX_ATTEMPTS = 4            # 한 번의 ctx.llm(...)에서 전체 시도 수 (첫 시도 + 재시도 3번)
MAX_ATTEMPTS_PER_MODEL = 2  # 모델마다 (첫 시도 + 같은 모델 재시도 1번)
RETRY_BACKOFF_SEC = 2       # server_error 뒤 같은 모델로 다시 부르기 전에 쉬는 시간
BREAKER_FAILURES = 3        # 모델별 연속 실패가 이만큼이면 차단
BREAKER_OPEN_SEC = 300      # 차단을 유지하는 시간

clock, sleep = time.monotonic, time.sleep  # 테스트가 가짜 시계로 바꾼다 (deadline도 같은 시계 기준)
_client_lock = threading.Lock()
_client: tuple[str, LlmClient] | None = None  # (키, 클라이언트) — llm_client()


class ErrorType(str, Enum):
    TIMEOUT = "timeout"            # 제한 시간 안에 응답 없음
    SERVER_ERROR = "server_error"  # HTTP 429·5xx·연결 실패
    BAD_OUTPUT = "bad_output"      # JSON 아님·빈 응답·출력 계약 위반
    UNKNOWN = "unknown"            # 그 밖 (HTTP 400·401 등) → 같은 모델로 다시 하지 않는다


RETRY_SAME_MODEL = (ErrorType.TIMEOUT, ErrorType.SERVER_ERROR, ErrorType.BAD_OUTPUT)


@dataclass
class LlmReply:
    data: dict                 # 응답 JSON (contract를 줬으면 검증·정리를 통과한 것)
    provider: str | None
    model: str                 # 실제로 답한 모델
    attempts: int              # 이 호출에 쓴 시도 수 (1이면 한 번에 성공)
    recovered: bool            # attempts > 1
    latency_ms: int            # 첫 시도 시작부터 성공까지
    recovery_ms: int | None    # 첫 실패부터 성공까지 (실패가 없었으면 None). agent_completed.details.recoveryMs가 된다
    cost_usd: float            # 이 호출의 비용 (실패한 시도 포함)


class LlmGaveUp(Exception):
    """모든 시도가 실패함. Orchestrator가 잡아 `agent_failed(final: true)`와 `add_error`를 남긴다."""

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


class CircuitBreaker:
    """모델별 연속 실패 수와 차단 시각. 엔진 프로세스 하나에 하나 (Worker 스레드들이 같이 쓴다).

    차단 시간이 지나면 다시 부를 수 있고, 그 호출이 또 실패하면 바로 다시 차단한다 (연속 실패 수가 남아 있으므로).
    """

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
            self._failures[model] = self._failures.get(model, 0) + 1
            if self._failures[model] >= BREAKER_FAILURES:
                self._opened[model] = now

    def succeeded(self, model: str) -> None:
        with self._lock:
            self._failures.pop(model, None)
            self._opened.pop(model, None)

    def reset(self) -> None:
        """테스트용."""
        with self._lock:
            self._failures.clear()
            self._opened.clear()


breaker = CircuitBreaker()


class ReportBreaker(CircuitBreaker):
    """장애 주입을 켠 리포트 하나의 Circuit Breaker. 실패·성공은 이 리포트 안에서만 세고(그 리포트의 Worker끼리는 같이 쓴다),
    전역 `breaker`에서 열린 차단(진짜 장애)은 따른다. 일부러 낸 실패로 다른 사용자·자동 리포트의 모델이 막히지 않게 한다."""

    def is_open(self, model: str, now: float) -> bool:
        return breaker.is_open(model, now) or super().is_open(model, now)


_report_breaker_lock = threading.Lock()


def breaker_for(report: Report, chaos: dict | None) -> CircuitBreaker:
    """이 리포트의 호출기가 쓸 Circuit Breaker: 장애 주입을 켰으면 그 리포트 전용, 아니면 전역 `breaker`.

    리포트 전용 Breaker는 Report 객체에 붙여 둔다 — Orchestrator가 한 실행 동안 같은 객체로 모든 Worker의 호출기를 만들고,
    실행이 끝나 객체가 사라지면 같이 사라진다 (pk가 같은 다른 객체와는 나누지 않는다).
    """
    if not injection.is_on(chaos):
        return breaker
    with _report_breaker_lock:
        own = report.__dict__.get("_chaos_breaker")
        if own is None:
            own = report._chaos_breaker = ReportBreaker()
        return own


def fallback_for(primary: str | None, now: float, tried: set[str] = frozenset(),
                 circuit: CircuitBreaker | None = None) -> str | None:
    """대체 모델: FALLBACK_POOL 순서에서 주 모델·이미 쓴 모델이 아니고 차단되지 않은 첫 모델. 없으면 None.
    circuit은 차단을 볼 Circuit Breaker (기본은 전역 `breaker`)."""
    circuit = breaker if circuit is None else circuit
    for model in FALLBACK_POOL:
        if model != primary and model not in tried and not circuit.is_open(model, now):
            return model
    return None


class LlmCaller:
    """리포트 하나의 Worker 하나에 묶인 호출기. Orchestrator가 만들어 ctx.llm에 넣는다."""

    def __init__(self, report: Report, worker: dict, chaos: dict | None, client, deadline: float):
        self.report, self.worker, self.chaos, self.client, self.deadline = report, worker, chaos, client, deadline
        self.breaker = breaker_for(report, chaos)
        self.calls: list[LlmReply] = []   # 성공한 호출 기록 (Orchestrator가 agent_completed의 attempts·model을 여기서 읽는다)
        self.cost_usd = 0.0
        self.attempt = 0                  # 이 Worker 실행에서의 전체 시도 번호 (agent_failed.details.attempt)

    @property
    def worker_id(self) -> str:
        return self.worker["id"]

    @property
    def provider(self) -> str | None:
        return self.worker.get("provider")

    def __call__(self, system: str, user: str, *, contract: str | None = None,
                 timeout: float | None = None) -> LlmReply:
        primary = self.worker.get("model")
        if not primary:
            raise LlmGaveUp(ErrorType.UNKNOWN, 0, None, f"{self.worker_id}: 모델이 정해지지 않았습니다.")
        started = clock()
        model, tried = primary, {primary}
        if self.breaker.is_open(primary, started):
            model = self._failover(primary, "circuit_open", tried)
            if model is None:
                raise LlmGaveUp(ErrorType.UNKNOWN, 0, primary,
                                f"{self.worker_id}: {primary}이(가) 차단됐고 넘어갈 대체 모델이 없습니다.")
        prompt, attempts, on_model, cost = user, 0, 0, 0.0
        first_failure: float | None = None
        error_type, last_error = ErrorType.TIMEOUT, "제한 시간이 지나 부르지 않았습니다."
        while attempts < MAX_ATTEMPTS:
            limit = min(timeout or CALL_TIMEOUT_SEC, self.deadline - clock())
            if limit <= 0:
                break
            attempts, on_model = attempts + 1, on_model + 1
            self.attempt += 1
            begun = clock()
            try:
                data, spent = self._once(model, system, prompt, limit, contract)
            except _Failed as failure:
                cost += failure.cost
                error_type, last_error = failure.error_type, f"{model}: {failure.error}"
                first_failure = clock() if first_failure is None else first_failure  # 복구 시간은 첫 agent_failed부터 (9절)
                self.breaker.failed(model, clock())
                self._record("agent_failed", "failed", model, begun,
                             {"errorType": error_type.value, "attempt": self.attempt, "injected": failure.injected,
                              "final": False})
                if attempts >= MAX_ATTEMPTS:
                    break
                if error_type is ErrorType.TIMEOUT and model == primary:
                    # 주 모델 timeout: 같은 모델을 또 기다리지 않고 대체 모델 먼저 (2026-10-08). 고를 모델이 없으면 아래 재시도로
                    next_model = self._failover(model, error_type.value, tried)
                    if next_model is not None:
                        model, prompt, on_model = next_model, user, 0
                        continue
                if error_type in RETRY_SAME_MODEL and on_model < MAX_ATTEMPTS_PER_MODEL \
                        and not self.breaker.is_open(model, clock()):
                    if not self._wait_before_retry(error_type):
                        break
                    self._record("agent_retry", "started", model, None,
                                 {"attempt": self.attempt + 1, "reason": error_type.value})
                    if error_type is ErrorType.BAD_OUTPUT:
                        prompt = f"{user}\n\n이전 응답의 문제: {failure.error}\nJSON 객체만 출력하세요."
                    continue
                next_model = self._failover(model, error_type.value, tried)
                if next_model is None:
                    break
                model, prompt, on_model = next_model, user, 0
                continue
            cost += spent
            self.breaker.succeeded(model)
            now = clock()
            reply = LlmReply(data=data, provider=self.provider, model=model, attempts=attempts,
                             recovered=attempts > 1, latency_ms=_ms(now - started),
                             recovery_ms=None if first_failure is None else _ms(now - first_failure), cost_usd=cost)
            self.calls.append(reply)
            return reply
        raise LlmGaveUp(error_type, attempts, model, f"{self.worker_id}: {last_error}")

    def _once(self, model: str, system: str, user: str, limit: float, contract: str | None) -> tuple[dict, float]:
        """실제 호출 한 번 (+ 출력 계약 검증). 실패는 _Failed로 바꿔 올린다. 비용은 실패해도 self.cost_usd에 더한다.

        장애 주입은 여기, 실제 호출 직전 한 곳에서만 한다 (T4-6): 주입된 실패는 부르지 않고(비용 0) 진짜와 같은 예외로 만든다.
        """
        injected = injection.should_fail(self.chaos, self.worker_id, model, model == self.worker.get("model"),
                                         self.attempt)
        if injected is not None:
            error_type = ErrorType(injected)
            raise _Failed(error_type, _injected_error(error_type, limit), 0.0, injected=True)
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
        except Exception as e:  # 분류할 수 없는 예외도 한 번의 실패로 센다
            raise _Failed(classify(e), e, cost) from e
        return data, cost

    def _wait_before_retry(self, error_type: ErrorType) -> bool:
        """server_error면 잠깐 쉰다. 쉬고 나면 deadline이 지나는 경우는 False (더 부르지 않는다)."""
        if error_type is not ErrorType.SERVER_ERROR:
            return True
        if self.deadline - clock() <= RETRY_BACKOFF_SEC:
            return False
        sleep(RETRY_BACKOFF_SEC)
        return True

    def _failover(self, frm: str, reason: str, tried: set[str]) -> str | None:
        """대체 모델로 넘어간다 (agent_failover). 대체 모델은 하나뿐이라 이미 넘어갔거나 고를 모델이 없으면 None."""
        to = fallback_for(self.worker.get("model"), clock(), tried, self.breaker) if len(tried) == 1 else None
        if to is None:
            return None
        tried.add(to)
        self._record("agent_failover", "started", to, None, {"from": frm, "to": to, "reason": reason})
        return to

    def _record(self, action: str, status: str, model: str, begun: float | None, details: dict) -> None:
        state.record(self.report, self.worker_id, action, status, provider=self.provider, model=model,
                     latency_ms=None if begun is None else _ms(clock() - begun), details=details)


class _Failed(Exception):
    def __init__(self, error_type: ErrorType, error: Exception, cost: float, injected: bool = False):
        super().__init__(str(error))
        self.error_type, self.error, self.cost, self.injected = error_type, error, cost, injected


def _injected_error(error_type: ErrorType, limit: float) -> Exception:
    """주입한 실패의 예외. 진짜 LlmClient가 내는 것과 같은 모양이라 classify가 같은 종류로 나눈다.
    timeout은 실제로 기다리지 않는다 (시험·시연 시간을 줄인다)."""
    if error_type is ErrorType.TIMEOUT:
        return LlmTimeout(f"{limit:g}초 안에 응답 없음 (주입)")
    if error_type is ErrorType.SERVER_ERROR:
        return LlmError("HTTP 503: 주입된 서버 오류")
    return LlmError("JSON 객체가 없는 응답: (주입된 깨진 응답)")


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
