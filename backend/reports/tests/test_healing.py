"""LLM 호출기 뼈대 (docs/tasks/04-autohealing.md T4-3, docs/tasks/00-공통.md 7절): 한 번 부르고 실패면 LlmGaveUp.
실패 분류, 실패 Trace(agent_failed final:false), 출력 계약 검증, 제한 시간, 가짜 LLM(fake_llm)."""
import pytest

from paper_engine.llm import LlmError, LlmTimeout
from reports import contracts, healing, state
from reports.healing import ErrorType, LlmGaveUp

from .conftest import make_report

pytestmark = pytest.mark.django_db

WORKER = {"id": "market_agent", "provider": "devpass", "model": "gemini-3.8-flash",
          "fallbacks": ["gpt-5.6-luna"], "outputContract": "MarketResult"}
ANSWER = {"trend": "up"}


@pytest.fixture
def clock(monkeypatch):
    """가짜 시계 (초). healing.clock과 FakeLlm의 sleep이 같이 쓴다."""
    now = {"t": 1000.0}
    monkeypatch.setattr(healing, "clock", lambda: now["t"])
    return now


@pytest.fixture
def running(user):
    return state.start(make_report(user))


def caller(report, client, deadline=2000.0, worker=WORKER):
    return healing.make_caller(report, worker, None, client, deadline)


def trace(report):
    return [(e.actor, e.action, e.status, e.provider, e.model, e.latency_ms, e.details)
            for e in report.trace_events.order_by("step")]


def test_success(running, fake_llm, clock):
    client = fake_llm({"gemini-3.8-flash": [ANSWER]}, cost=0.02)
    llm = caller(running, client)
    reply = llm("시스템", "질문")
    assert reply == healing.LlmReply(data=ANSWER, provider="devpass", model="gemini-3.8-flash", attempts=1,
                                     recovered=False, latency_ms=0, recovery_ms=None, cost_usd=0.02)
    assert llm.calls == [reply] and llm.cost_usd == 0.02
    assert client.calls == [("gemini-3.8-flash", "시스템", "질문", 90)]
    assert trace(running) == []  # 성공 사건(agent_completed)은 Orchestrator가 남긴다


def test_cost_adds_up_over_calls(running, fake_llm, clock):
    llm = caller(running, fake_llm({"gemini-3.8-flash": [ANSWER, ANSWER]}, cost=0.25))
    llm("s", "u")
    llm("s", "u")
    assert llm.cost_usd == 0.5 and len(llm.calls) == 2


def test_latency(running, fake_llm, clock):
    def sleep(seconds):
        clock["t"] += seconds
    llm = caller(running, fake_llm({"gemini-3.8-flash": [{"__delay__": 1.5}, ANSWER]}, sleep=sleep))
    assert llm("s", "u").latency_ms == 1500


@pytest.mark.parametrize("item, error_type", [("timeout", ErrorType.TIMEOUT), ("server_error", ErrorType.SERVER_ERROR),
                                              ("bad_output", ErrorType.BAD_OUTPUT)])
def test_failure_gives_up_after_one_call(running, fake_llm, clock, item, error_type):
    client = fake_llm({"gemini-3.8-flash": [item, ANSWER], "gpt-5.6-luna": [ANSWER]})
    llm = caller(running, client)
    with pytest.raises(LlmGaveUp) as caught:
        llm("s", "u")
    gave_up = caught.value
    assert (gave_up.error_type, gave_up.attempts, gave_up.last_model) == (error_type, 1, "gemini-3.8-flash")
    assert gave_up.message.startswith("gemini-3.8-flash: ")
    assert len(client.calls) == 1 and llm.calls == []  # 뼈대는 재시도·대체 모델이 없다 (T4-4)
    assert trace(running) == [("market_agent", "agent_failed", "failed", "devpass", "gemini-3.8-flash", 0,
                               {"errorType": error_type.value, "attempt": 1, "injected": False, "final": False})]


def test_attempt_number_keeps_counting_in_one_run(running, fake_llm, clock):
    llm = caller(running, fake_llm({"gemini-3.8-flash": [ANSWER, "server_error"]}))
    llm("s", "u")
    with pytest.raises(LlmGaveUp):
        llm("s", "u")
    assert trace(running)[0][6]["attempt"] == 2


def test_contract_is_checked(running, fake_llm, clock, monkeypatch):
    seen = []

    def validate(name, data):
        seen.append((name, data))
        return {"trend": data["trend"]}  # 모르는 키는 지운다
    monkeypatch.setattr(contracts, "validate", validate)
    llm = caller(running, fake_llm({"gemini-3.8-flash": [{"trend": "up", "extra": 1}]}))
    assert llm("s", "u", contract="MarketResult").data == {"trend": "up"}
    assert seen == [("MarketResult", {"trend": "up", "extra": 1})]


def test_contract_violation_is_bad_output(running, fake_llm, clock):
    llm = caller(running, fake_llm({"gemini-3.8-flash": [{"trend": "bullish"}]}, cost=0.03))
    with pytest.raises(LlmGaveUp) as caught:
        llm("s", "u", contract="MarketResult")
    assert caught.value.error_type is ErrorType.BAD_OUTPUT
    assert llm.cost_usd == 0.03  # 계약 위반이어도 호출 비용은 들었다


def test_timeout_is_clamped_to_deadline(running, fake_llm, clock):
    client = fake_llm({"gemini-3.8-flash": [ANSWER, ANSWER]})
    llm = caller(running, client, deadline=1030.0)
    llm("s", "u")
    llm("s", "u", timeout=10)
    assert [call[3] for call in client.calls] == [30.0, 10]


def test_deadline_passed_does_not_call(running, fake_llm, clock):
    client = fake_llm({"gemini-3.8-flash": [ANSWER]})
    with pytest.raises(LlmGaveUp) as caught:
        caller(running, client, deadline=1000.0)("s", "u")
    assert (caught.value.error_type, caught.value.attempts) == (ErrorType.TIMEOUT, 0)
    assert client.calls == [] and trace(running) == []


def test_no_model(running, fake_llm, clock):
    client = fake_llm({})
    with pytest.raises(LlmGaveUp) as caught:
        caller(running, client, worker={"id": "news_agent", "provider": None, "model": None})("s", "u")
    assert (caught.value.error_type, caught.value.attempts, caught.value.last_model) == (ErrorType.UNKNOWN, 0, None)
    assert client.calls == []


def test_models_order():
    llm = healing.LlmCaller(None, {"id": "a", "model": "m1", "fallbacks": ["m2", "m1", "", "m3"]}, None, None, 0)
    assert llm.models == ["m1", "m2", "m3"]
    assert healing.LlmCaller(None, {"id": "a", "model": "m1", "fallbacks": None}, None, None, 0).models == ["m1"]


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


def test_fake_llm_delay_longer_than_timeout(fake_llm):
    slept = []
    client = fake_llm({"m": [{"__delay__": 5}, ANSWER]}, sleep=slept.append)
    with pytest.raises(LlmTimeout):
        client.complete_json_once("m", "s", "u", 3)
    assert slept == [3]


def test_fake_llm_unknown_model(fake_llm):
    with pytest.raises(AssertionError):
        fake_llm({}).complete_json_once("m", "s", "u", 3)
