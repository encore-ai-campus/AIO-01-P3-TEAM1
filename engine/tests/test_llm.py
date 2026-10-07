"""LLM 게이트웨이 클라이언트: 재시도 없는 호출 complete_json_once (docs/tasks/04-autohealing.md T4-2)와 기존 complete_json.
HTTP는 가짜 (게이트웨이를 부르지 않는다)."""
import io
import json
import urllib.error

import pytest

from paper_engine import llm
from paper_engine.llm import LlmClient, LlmError, LlmTimeout


class Gateway:
    """urllib.request.urlopen 대신. 받은 요청을 적고, 대본(응답 dict 또는 예외)을 차례로 낸다."""

    def __init__(self, *script):
        self.script, self.requests = list(script), []

    def __call__(self, req, timeout):
        self.requests.append((json.loads(req.data), timeout, req.get_header("Authorization")))
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return io.BytesIO(json.dumps(item).encode())


def answer(content, cost=0.01):
    return {"choices": [{"message": {"content": content}}], "usage": {"cost": cost}}


def http_error(code):
    return urllib.error.HTTPError("https://x", code, "err", {}, io.BytesIO(b"busy"))


@pytest.fixture
def gateway(monkeypatch):
    def install(*script):
        fake = Gateway(*script)
        monkeypatch.setattr(llm.urllib.request, "urlopen", fake)
        return fake
    monkeypatch.setattr(llm.time, "sleep", lambda seconds: None)
    return install


def test_once_returns_data_and_cost(gateway):
    fake = gateway(answer('결과: ```json\n{"trend": "up"}\n```', cost=0.02))
    client = LlmClient("key-1")
    assert client.complete_json_once("gemini-3.8-flash", "시스템", "질문", 30) == ({"trend": "up"}, 0.02)
    body, timeout, auth = fake.requests[0]
    assert body == {"model": "gemini-3.8-flash", "messages": [{"role": "system", "content": "시스템"},
                                                             {"role": "user", "content": "질문"}]}
    assert (timeout, auth) == (30, "Bearer key-1")
    assert client.cost == 0.02


def test_once_cost_adds_to_client_total(gateway):
    gateway(answer('{"a": 1}', cost=0.25), answer('{"a": 2}', cost=0.5))
    client = LlmClient("k")
    assert [client.complete_json_once("m", "s", "u")[1] for _ in range(2)] == [0.25, 0.5]
    assert client.cost == 0.75


def test_once_without_usage_costs_zero(gateway):
    gateway({"choices": [{"message": {"content": '{"a": 1}'}}]})
    assert LlmClient("k").complete_json_once("m", "s", "u") == ({"a": 1}, 0.0)


@pytest.mark.parametrize("error, kind, text", [
    (http_error(503), LlmError, "HTTP 503: busy"),
    (http_error(429), LlmError, "HTTP 429: busy"),
    (TimeoutError(), LlmTimeout, "30초 안에 응답 없음"),
    (urllib.error.URLError(TimeoutError()), LlmTimeout, "30초 안에 응답 없음"),
])
def test_once_does_not_retry(gateway, error, kind, text):
    fake = gateway(error, answer('{"a": 1}'))
    with pytest.raises(kind) as caught:
        LlmClient("k").complete_json_once("m", "s", "u", 30)
    assert str(caught.value) == text  # 모델 이름을 앞에 붙이지 않는다 (healing.classify가 문장 앞부분을 본다)
    assert caught.value.cost == 0.0 and len(fake.requests) == 1


def test_once_connection_failure(gateway):
    gateway(urllib.error.URLError("name resolution"))
    with pytest.raises(LlmError) as caught:
        LlmClient("k").complete_json_once("m", "s", "u")
    assert str(caught.value).startswith("요청 실패")


@pytest.mark.parametrize("content, text", [("JSON이 아닌 답", "JSON 객체가 없는 응답"), ("", "빈 응답"),
                                           ("[1, 2]", "JSON 객체가 없는 응답")])
def test_once_bad_output_keeps_cost(gateway, content, text):
    fake = gateway(answer(content, cost=0.03))
    client = LlmClient("k")
    with pytest.raises(LlmError) as caught:
        client.complete_json_once("m", "s", "u")
    assert str(caught.value).startswith(text)
    assert caught.value.cost == 0.03 and client.cost == 0.03 and len(fake.requests) == 1


def test_complete_json_still_retries(gateway):
    """기존 complete_json(엔진 분석이 쓴다)은 그대로: 서버 오류면 한 번 더."""
    fake = gateway(http_error(503), answer('{"a": 1}'))
    assert LlmClient("k").complete_json("m", "s", "u") == {"a": 1}
    assert len(fake.requests) == 2


def test_complete_json_gives_up_with_model_name(gateway):
    gateway(answer("x"), answer("y"))
    with pytest.raises(LlmError) as caught:
        LlmClient("k").complete_json("gpt-5.6-luna", "s", "u")
    assert str(caught.value).startswith("gpt-5.6-luna: JSON 객체가 없는 응답")
