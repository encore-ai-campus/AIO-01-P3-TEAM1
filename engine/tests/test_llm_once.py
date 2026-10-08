"""재시도 없는 LLM 호출은 복구 정책을 상위 호출기에 맡긴다."""

import io
import json
import urllib.error

import pytest

from paper_engine import llm
from paper_engine.llm import LlmClient, LlmError, LlmTimeout


class Gateway:
    def __init__(self, *script):
        self.script = list(script)
        self.requests = []

    def __call__(self, request, timeout):
        self.requests.append((json.loads(request.data), timeout))
        item = self.script.pop(0)
        if isinstance(item, BaseException):
            raise item
        return io.BytesIO(json.dumps(item).encode())


def answer(content, cost=0.01):
    return {"choices": [{"message": {"content": content}}], "usage": {"cost": cost}}


def test_complete_json_once_returns_data_and_cost(monkeypatch):
    gateway = Gateway(answer('{"ok": true}', 0.02))
    monkeypatch.setattr(llm.urllib.request, "urlopen", gateway)

    assert LlmClient("key").complete_json_once("model", "system", "user", 12.5) == ({"ok": True}, 0.02)
    assert gateway.requests[0][1] == 12.5


@pytest.mark.parametrize("error, kind", [
    (TimeoutError(), LlmTimeout),
    (urllib.error.HTTPError("https://x", 503, "err", {}, io.BytesIO(b"busy")), LlmError),
])
def test_complete_json_once_never_retries(monkeypatch, error, kind):
    gateway = Gateway(error, answer('{"ok": true}'))
    monkeypatch.setattr(llm.urllib.request, "urlopen", gateway)

    with pytest.raises(kind):
        LlmClient("key").complete_json_once("model", "system", "user", 10)

    assert len(gateway.requests) == 1


def test_bad_output_keeps_spent_cost(monkeypatch):
    gateway = Gateway(answer("not json", 0.03))
    monkeypatch.setattr(llm.urllib.request, "urlopen", gateway)
    client = LlmClient("key")

    with pytest.raises(LlmError) as caught:
        client.complete_json_once("model", "system", "user")

    assert caught.value.cost == 0.03
    assert client.cost == 0.03
