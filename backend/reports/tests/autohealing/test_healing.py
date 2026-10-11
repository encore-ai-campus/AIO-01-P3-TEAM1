"""LLM 호출기 (docs/tasks/04-autohealing.md T4-3·T4-4·T4-5, docs/tasks/00-공통.md 7절):
실패 분류, 같은 모델 재시도 1번(주 모델 timeout은 바로 대체 모델 — 2026-10-08) → 대체 모델 하나(FALLBACK_POOL에서 고름), 전체 4번·deadline 안,
Circuit Breaker, 복구 Trace(agent_failed final:false · agent_retry · agent_failover), 비용, 가짜 LLM(fake_llm)."""
from types import SimpleNamespace

import pytest

from config import engine
from paper_engine.llm import LlmClient, LlmError, LlmTimeout
from reports.guardrails import contracts
from reports.autohealing import healing
from reports.orchestration import state
from reports.autohealing.healing import ErrorType, LlmGaveUp

from ..conftest import make_report

pytestmark = pytest.mark.django_db

PRIMARY, FALLBACK = "gemini-3.8-flash", "gpt-5.6-luna"   # PRIMARY의 대체 모델 = 후보 중 PRIMARY가 아닌 첫 모델
WORKER = {"id": "market_agent", "provider": "devpass", "model": PRIMARY, "fallbacks": ["deepseek-v4.1-flash"],
          "outputContract": "MarketResult"}
ANSWER = {"trend": "up"}


@pytest.fixture
def clock(monkeypatch):
    """가짜 시계 (초). healing.clock·healing.sleep이 같이 쓴다. slept에 쉰 시간을 적는다."""
    now = {"t": 1000.0, "slept": []}

    def sleep(seconds):
        now["slept"].append(seconds)
        now["t"] += seconds
    monkeypatch.setattr(healing, "clock", lambda: now["t"])
    monkeypatch.setattr(healing, "sleep", sleep)
    return now


@pytest.fixture
def running(user):
    return state.start(make_report(user))


def caller(report, client, deadline=2000.0, worker=WORKER):
    return healing.make_caller(report, worker, None, client, deadline)


def trace(report):
    """(action, model, details) 순서대로."""
    return [(e.action, e.model, e.details) for e in report.trace_events.order_by("step")]


def failed(error_type, attempt):
    return {"errorType": error_type, "attempt": attempt, "injected": False, "final": False}


def gave_up(llm, *args, **kwargs) -> LlmGaveUp:
    with pytest.raises(LlmGaveUp) as caught:
        llm(*args, **kwargs)
    return caught.value


class Client:
    """시도마다 시계를 움직이는 가짜 (fake_llm은 시간을 쓰지 않는다). items: (걸린 초, 결과)."""

    def __init__(self, clock, *items):
        self.clock, self.items, self.calls = clock, list(items), []

    def complete_json_once(self, model, system, user, timeout):
        self.calls.append((model, timeout))
        seconds, item = self.items.pop(0)
        self.clock["t"] += min(seconds, timeout)
        if item == "timeout" or seconds >= timeout:
            raise LlmTimeout(f"{timeout}초 안에 응답 없음")
        return dict(item), 0.0


# --- 정상 ---

def test_success_first_try(running, fake_llm, clock):
    client = fake_llm({PRIMARY: [ANSWER]}, cost=0.02)
    llm = caller(running, client)
    reply = llm("시스템", "질문")
    assert reply == healing.LlmReply(data=ANSWER, provider="devpass", model=PRIMARY, attempts=1, recovered=False,
                                     latency_ms=0, recovery_ms=None, cost_usd=0.02)
    assert llm.calls == [reply] and llm.cost_usd == 0.02
    assert client.calls == [(PRIMARY, "시스템", "질문", 60)]  # 호출 제한 60초
    assert trace(running) == []  # 성공 사건(agent_completed)은 Orchestrator가 남긴다


def test_yaml_fallbacks_are_not_used(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["server_error", "server_error"], FALLBACK: [ANSWER]})
    assert caller(running, client)("s", "u").model == FALLBACK  # WORKER의 fallbacks(deepseek)가 아니다


# --- 같은 모델 재시도 → 대체 모델 ---

@pytest.mark.parametrize("item, error_type", [("server_error", "server_error"), ("bad_output", "bad_output")])
def test_retry_same_model_once(running, fake_llm, clock, item, error_type):
    client = fake_llm({PRIMARY: [item, ANSWER]})
    reply = caller(running, client)("s", "u")
    backoff_ms = healing.RETRY_BACKOFF_SEC * 1000 if item == "server_error" else 0
    assert (reply.model, reply.attempts, reply.recovered, reply.recovery_ms) == (PRIMARY, 2, True, backoff_ms)
    assert [call[0] for call in client.calls] == [PRIMARY, PRIMARY]
    assert trace(running) == [("agent_failed", PRIMARY, failed(error_type, 1)),
                              ("agent_retry", PRIMARY, {"attempt": 2, "reason": error_type})]


def test_server_error_waits_before_retry(running, fake_llm, clock):
    caller(running, fake_llm({PRIMARY: ["server_error", ANSWER]}))("s", "u")
    assert clock["slept"] == [healing.RETRY_BACKOFF_SEC]


@pytest.mark.parametrize("item", ["timeout", "bad_output"])
def test_no_wait_for_other_errors(running, fake_llm, clock, item):
    caller(running, fake_llm({PRIMARY: [item, ANSWER], FALLBACK: [ANSWER]}))("s", "u")
    assert clock["slept"] == []


# --- timeout (2026-10-08: 주 모델은 바로 대체 모델, 대체 모델은 한 번 더) ---

def test_primary_timeout_goes_straight_to_fallback(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["timeout"], FALLBACK: [ANSWER]})
    reply = caller(running, client)("s", "u")
    assert (reply.model, reply.attempts, reply.recovered) == (FALLBACK, 2, True)
    assert [call[0] for call in client.calls] == [PRIMARY, FALLBACK]  # 주 모델을 다시 기다리지 않는다
    assert trace(running) == [("agent_failed", PRIMARY, failed("timeout", 1)),
                              ("agent_failover", FALLBACK, {"from": PRIMARY, "to": FALLBACK, "reason": "timeout"})]


def test_fallback_timeout_is_retried_once(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["timeout"], FALLBACK: ["timeout", ANSWER]})
    reply = caller(running, client)("s", "u")
    assert (reply.model, reply.attempts) == (FALLBACK, 3)
    assert [call[0] for call in client.calls] == [PRIMARY, FALLBACK, FALLBACK]
    assert trace(running)[2:] == [("agent_failed", FALLBACK, failed("timeout", 2)),
                                  ("agent_retry", FALLBACK, {"attempt": 3, "reason": "timeout"})]


def test_primary_timeout_is_retried_when_no_fallback_left(running, fake_llm, clock):
    for model in healing.FALLBACK_POOL:
        if model != PRIMARY:
            open_breaker(model)
    client = fake_llm({PRIMARY: ["timeout", ANSWER]})
    reply = caller(running, client)("s", "u")
    assert (reply.model, reply.attempts) == (PRIMARY, 2)  # 넘어갈 모델이 없으면 같은 모델로 한 번 더
    assert [event[0] for event in trace(running)] == ["agent_failed", "agent_retry"]


def test_bad_output_tells_the_problem(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["bad_output", "bad_output"], FALLBACK: [ANSWER]})
    caller(running, client)("s", "질문")
    prompts = [call[2] for call in client.calls]
    assert prompts[0] == "질문" and prompts[2] == "질문"  # 대체 모델에는 원래 질문
    assert prompts[1].startswith("질문\n\n이전 응답의 문제: JSON 객체가 없는 응답") and prompts[1].endswith("JSON 객체만 출력하세요.")


def test_failover_after_two_failures(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["bad_output", "bad_output"], FALLBACK: [ANSWER]}, cost=0.05)
    reply = caller(running, client)("s", "u")
    assert (reply.model, reply.attempts, reply.recovered) == (FALLBACK, 3, True)
    assert trace(running) == [
        ("agent_failed", PRIMARY, failed("bad_output", 1)),
        ("agent_retry", PRIMARY, {"attempt": 2, "reason": "bad_output"}),
        ("agent_failed", PRIMARY, failed("bad_output", 2)),
        ("agent_failover", FALLBACK, {"from": PRIMARY, "to": FALLBACK, "reason": "bad_output"}),
    ]


def test_unknown_goes_straight_to_fallback(running, fake_llm, clock):
    class Client:
        calls = []

        def complete_json_once(self, model, system, user, timeout):
            self.calls.append(model)
            if model == PRIMARY:
                raise LlmError("HTTP 400: bad request")
            return ANSWER, 0.0
    client = Client()
    assert caller(running, client)("s", "u").model == FALLBACK
    assert client.calls == [PRIMARY, FALLBACK]
    assert trace(running)[1] == ("agent_failover", FALLBACK, {"from": PRIMARY, "to": FALLBACK, "reason": "unknown"})


def test_gives_up_after_four_attempts(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["bad_output", "bad_output"], FALLBACK: ["server_error", "bad_output"]})
    llm = caller(running, client)
    error = gave_up(llm, "s", "u")
    assert (error.error_type, error.attempts, error.last_model) == (ErrorType.BAD_OUTPUT, 4, FALLBACK)
    assert error.message.startswith(f"market_agent: {FALLBACK}: JSON 객체가 없는 응답")
    assert len(client.calls) == 4 and llm.calls == []
    assert [event[0] for event in trace(running)] == ["agent_failed", "agent_retry", "agent_failed", "agent_failover",
                                                     "agent_failed", "agent_retry", "agent_failed"]


def test_contract_violation_is_retried(running, fake_llm, clock):
    client = fake_llm({PRIMARY: [{"trend": "bullish"}, {"trend": "bullish"}], FALLBACK: [{"trend": "bullish"}] * 2})
    error = gave_up(caller(running, client), "s", "u", contract="MarketResult")
    assert (error.error_type, error.attempts) == (ErrorType.BAD_OUTPUT, 4)


def test_contract_is_checked(running, fake_llm, clock, monkeypatch):
    seen = []

    def validate(name, data):
        seen.append((name, data))
        return {"trend": data["trend"]}  # 모르는 키는 지운다
    monkeypatch.setattr(contracts, "validate", validate)
    llm = caller(running, fake_llm({PRIMARY: [{"trend": "up", "extra": 1}]}))
    assert llm("s", "u", contract="MarketResult").data == {"trend": "up"}
    assert seen == [("MarketResult", {"trend": "up", "extra": 1})]


def test_fallback_of_a_pool_model(running, fake_llm, clock):
    worker = {**WORKER, "model": FALLBACK}  # 주 모델이 후보에 있으면 다음 후보로
    client = fake_llm({FALLBACK: ["timeout", "timeout"], PRIMARY: [ANSWER]})
    assert caller(running, client, worker=worker)("s", "u").model == PRIMARY


def test_attempt_number_keeps_counting_in_one_run(running, fake_llm, clock):
    llm = caller(running, fake_llm({PRIMARY: [ANSWER, "server_error", ANSWER]}))
    llm("s", "u")
    llm("s", "u")
    assert trace(running)[0][2]["attempt"] == 2 and trace(running)[1][2]["attempt"] == 3


# --- 비용 ---

def test_cost_counts_failed_attempts(running, clock):
    class Client:
        def complete_json_once(self, model, system, user, timeout):
            if not hasattr(self, "done"):
                self.done = True
                error = LlmError("JSON 객체가 없는 응답: 'hi'")
                error.cost = 0.04
                raise error
            return ANSWER, 0.01
    llm = caller(running, Client())
    assert llm("s", "u").cost_usd == pytest.approx(0.05) and llm.cost_usd == pytest.approx(0.05)


def test_cost_adds_up_over_calls(running, fake_llm, clock):
    llm = caller(running, fake_llm({PRIMARY: [ANSWER, ANSWER]}, cost=0.25))
    llm("s", "u")
    llm("s", "u")
    assert llm.cost_usd == 0.5 and len(llm.calls) == 2


# --- 제한 시간 ---

def test_timeout_is_clamped_to_deadline(running, fake_llm, clock):
    client = fake_llm({PRIMARY: [ANSWER, ANSWER]})
    llm = caller(running, client, deadline=1030.0)
    llm("s", "u")
    llm("s", "u", timeout=10)
    assert [call[3] for call in client.calls] == [30.0, 10]


def test_stops_at_deadline(running, clock):
    """단계 제한 60초에 호출 제한 60초: timeout 한 번이면 대체 모델로 넘어가도 부를 시간이 없다 (그래서 단계 제한을 늘린다)."""
    client = Client(clock, (60, "timeout"), (1, ANSWER))
    error = gave_up(caller(running, client, deadline=1060.0), "s", "u")
    assert (error.error_type, error.attempts, error.last_model) == (ErrorType.TIMEOUT, 1, FALLBACK)
    assert client.calls == [(PRIMARY, 60)]
    assert [event[0] for event in trace(running)] == ["agent_failed", "agent_failover"]


def test_primary_hang_recovers_in_65_seconds(running, clock):
    """주 모델이 계속 멈춰도 60초 뒤 바로 대체 모델 (같은 모델을 또 60초 기다리면 125초)."""
    client = Client(clock, (60, "timeout"), (5, ANSWER))
    reply = caller(running, client, deadline=1180.0)("s", "u")
    assert (reply.model, reply.attempts, reply.latency_ms, reply.recovery_ms) == (FALLBACK, 2, 65000, 5000)
    assert client.calls == [(PRIMARY, 60), (FALLBACK, 60)]


def test_recovers_within_180_seconds(running, clock):
    """주 모델 timeout → 대체 모델도 timeout → 대체 모델 한 번 더: 180초 안에 든다."""
    client = Client(clock, (60, "timeout"), (60, "timeout"), (5, ANSWER))
    reply = caller(running, client, deadline=1180.0)("s", "u")
    assert (reply.model, reply.attempts, reply.latency_ms, reply.recovery_ms) == (FALLBACK, 3, 125000, 65000)
    assert client.calls == [(PRIMARY, 60), (FALLBACK, 60), (FALLBACK, 60)]


def test_last_call_gets_what_is_left(running, clock):
    client = Client(clock, (60, "timeout"), (60, "timeout"), (40, ANSWER))
    error = gave_up(caller(running, client, deadline=1150.0), "s", "u")
    assert client.calls[-1] == (FALLBACK, 30.0)  # 남은 30초만 기다린다
    assert (error.error_type, error.attempts, error.last_model) == (ErrorType.TIMEOUT, 3, FALLBACK)


def test_deadline_passed_does_not_call(running, fake_llm, clock):
    client = fake_llm({PRIMARY: [ANSWER]})
    error = gave_up(caller(running, client, deadline=1000.0), "s", "u")
    assert (error.error_type, error.attempts) == (ErrorType.TIMEOUT, 0)
    assert client.calls == [] and trace(running) == []


def test_no_backoff_past_deadline(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["server_error", ANSWER]})
    error = gave_up(caller(running, client, deadline=1001.5), "s", "u")
    assert (error.error_type, error.attempts) == (ErrorType.SERVER_ERROR, 1)
    assert clock["slept"] == [] and len(client.calls) == 1


# --- Circuit Breaker ---

def open_breaker(model):
    for _ in range(healing.BREAKER_FAILURES):
        healing.breaker.failed(model, 1000.0)


def test_breaker_opens_after_three_failures(running, fake_llm, clock):
    client = fake_llm({PRIMARY: ["server_error", "server_error"], FALLBACK: [ANSWER, ANSWER]})
    llm = caller(running, client)
    healing.breaker.failed(PRIMARY, clock["t"])  # 앞서 한 번 실패했다
    llm("s", "u")  # 두 번 더 실패 → 연속 3번 → 차단
    assert healing.breaker.is_open(PRIMARY, clock["t"])
    reply = llm("s", "u")
    assert reply.model == FALLBACK and reply.attempts == 1
    assert [call[0] for call in client.calls] == [PRIMARY, PRIMARY, FALLBACK, FALLBACK]  # 주 모델을 부르지 않았다
    assert trace(running)[-1] == ("agent_failover", FALLBACK, {"from": PRIMARY, "to": FALLBACK,
                                                              "reason": "circuit_open"})


def test_breaker_open_during_call_skips_retry(running, fake_llm, clock):
    healing.breaker.failed(PRIMARY, clock["t"])
    healing.breaker.failed(PRIMARY, clock["t"])
    client = fake_llm({PRIMARY: ["timeout"], FALLBACK: [ANSWER]})
    assert caller(running, client)("s", "u").model == FALLBACK  # 세 번째 실패로 차단 → 같은 모델 재시도 없이 넘어간다
    assert [event[0] for event in trace(running)] == ["agent_failed", "agent_failover"]
    assert trace(running)[1][2]["reason"] == "timeout"


def test_breaker_closes_after_open_time(running, fake_llm, clock):
    open_breaker(PRIMARY)
    clock["t"] = 1000.0 + healing.BREAKER_OPEN_SEC
    client = fake_llm({PRIMARY: [ANSWER]})
    assert caller(running, client)("s", "u").model == PRIMARY
    assert not healing.breaker.is_open(PRIMARY, clock["t"])


def test_breaker_reopens_on_next_failure(running, fake_llm, clock):
    open_breaker(PRIMARY)
    clock["t"] = 1000.0 + healing.BREAKER_OPEN_SEC
    caller(running, fake_llm({PRIMARY: ["timeout"], FALLBACK: [ANSWER]}))("s", "u")
    assert healing.breaker.is_open(PRIMARY, clock["t"])  # 다시 실패하면 바로 차단


def test_success_resets_breaker(running, fake_llm, clock):
    healing.breaker.failed(PRIMARY, clock["t"])
    healing.breaker.failed(PRIMARY, clock["t"])
    caller(running, fake_llm({PRIMARY: [ANSWER]}))("s", "u")
    healing.breaker.failed(PRIMARY, clock["t"])
    assert not healing.breaker.is_open(PRIMARY, clock["t"])  # 성공으로 0이 됐다 → 1번째 실패


def test_open_fallback_is_skipped(running, fake_llm, clock):
    open_breaker(FALLBACK)
    client = fake_llm({PRIMARY: ["timeout", "timeout"], "deepseek-v4.1-flash": [ANSWER]})
    assert caller(running, client)("s", "u").model == "deepseek-v4.1-flash"


def test_gives_up_when_everything_is_open(running, fake_llm, clock):
    for model in (PRIMARY, *healing.FALLBACK_POOL):
        open_breaker(model)
    client = fake_llm({})
    error = gave_up(caller(running, client), "s", "u")
    assert (error.error_type, error.attempts, error.last_model) == (ErrorType.UNKNOWN, 0, PRIMARY)
    assert client.calls == [] and trace(running) == []


def test_gives_up_when_no_fallback_left(running, fake_llm, clock):
    for model in healing.FALLBACK_POOL:
        if model != PRIMARY:
            open_breaker(model)
    error = gave_up(caller(running, fake_llm({PRIMARY: ["timeout", "timeout"]})), "s", "u")
    assert (error.error_type, error.attempts) == (ErrorType.TIMEOUT, 2)


def test_fallback_for():
    assert healing.fallback_for(PRIMARY, 0) == FALLBACK
    assert healing.fallback_for(FALLBACK, 0) == PRIMARY
    assert healing.fallback_for("claude-opus-5-5", 0) == FALLBACK
    assert healing.fallback_for(PRIMARY, 0, {FALLBACK}) == "deepseek-v4.1-flash"
    open_breaker("deepseek-v4.1-flash")
    assert healing.fallback_for(PRIMARY, 1000.0, {FALLBACK}) is None


# --- 그 밖 ---

def test_no_model(running, fake_llm, clock):
    client = fake_llm({})
    error = gave_up(caller(running, client, worker={"id": "news_agent", "provider": None, "model": None}), "s", "u")
    assert (error.error_type, error.attempts, error.last_model) == (ErrorType.UNKNOWN, 0, None)
    assert client.calls == []


@pytest.mark.parametrize("error, error_type", [
    (LlmTimeout("90초 안에 응답 없음"), ErrorType.TIMEOUT),
    (LlmError("HTTP 503: busy"), ErrorType.SERVER_ERROR),
    (LlmError("HTTP 500: x"), ErrorType.SERVER_ERROR),
    (LlmError("HTTP 429: rate limit"), ErrorType.SERVER_ERROR),
    (LlmError("요청 실패: <urlopen error [Errno -2]>"), ErrorType.SERVER_ERROR),
    (LlmError("빈 응답"), ErrorType.BAD_OUTPUT),
    (LlmError("JSON 객체가 없는 응답: 'hi'"), ErrorType.BAD_OUTPUT),
    (LlmError("JSON 파싱 실패 (x): '{'"), ErrorType.BAD_OUTPUT),
    (LlmError("JSON 최상위가 객체가 아님"), ErrorType.BAD_OUTPUT),
    (contracts.ContractError("trend: 값이 틀렸습니다"), ErrorType.BAD_OUTPUT),
    (LlmError("HTTP 400: bad request"), ErrorType.UNKNOWN),
    (LlmError("HTTP 401: unauthorized"), ErrorType.UNKNOWN),
    (KeyError("choices"), ErrorType.UNKNOWN),
])
def test_classify(error, error_type):
    assert healing.classify(error) is error_type


def test_llm_client_uses_devpass_key(monkeypatch):
    key = {"value": None}
    monkeypatch.setattr(engine, "engine_config", lambda: SimpleNamespace(llm_api_key=key["value"]))
    monkeypatch.setattr(healing, "_client", None)
    assert healing.llm_client() is None  # 키가 없으면 None
    key["value"] = "key-1"
    first = healing.llm_client()
    assert isinstance(first, LlmClient) and healing.llm_client() is first  # 프로세스에 하나
    key["value"] = "key-2"
    assert healing.llm_client() is not first  # 키가 바뀌면 새로


def test_fake_llm_delay_longer_than_timeout(fake_llm):
    slept = []
    client = fake_llm({"m": [{"__delay__": 5}, ANSWER]}, sleep=slept.append)
    with pytest.raises(LlmTimeout):
        client.complete_json_once("m", "s", "u", 3)
    assert slept == [3]


def test_fake_llm_unknown_model(fake_llm):
    with pytest.raises(AssertionError):
        fake_llm({}).complete_json_once("m", "s", "u", 3)
