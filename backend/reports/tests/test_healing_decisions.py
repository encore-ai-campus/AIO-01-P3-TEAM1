"""2026-10-08 Q1·Q2·Q8 결정에 따른 LLM 호출 순서."""

from paper_engine.llm import LlmError, LlmTimeout

from reports import healing

PRIMARY = "gemini-3.8-flash"
FALLBACK = "gpt-5.6-luna"


class ScriptedClient:
    def __init__(self, script):
        self.script = {model: list(items) for model, items in script.items()}
        self.calls = []

    def complete_json_once(self, model, system, user, timeout):
        self.calls.append((model, timeout))
        item = self.script[model].pop(0)
        if item == "timeout":
            raise LlmTimeout("응답 없음")
        if item == "server_error":
            raise LlmError("HTTP 503: busy")
        return item, 0.01


def caller(client, *, deadline=100, worker_id="news_agent"):
    return healing.LlmCaller(
        report=object(),
        worker={
            "id": worker_id,
            "provider": "devpass",
            "model": PRIMARY,
            "fallbacks": [FALLBACK],
        },
        chaos=None,
        client=client,
        deadline=deadline,
    )


def test_timeout_goes_directly_to_fallback(monkeypatch):
    events = []
    monkeypatch.setattr(healing, "clock", lambda: 10.0)
    monkeypatch.setattr(healing.state, "record", lambda *args, **kwargs: events.append((args, kwargs)))
    client = ScriptedClient({PRIMARY: ["timeout"], FALLBACK: [{"ok": True}]})

    reply = caller(client)("system", "user")

    assert [model for model, _ in client.calls] == [PRIMARY, FALLBACK]
    assert reply.model == FALLBACK and reply.attempts == 2 and reply.recovered is True
    assert [args[2] for args, _ in events] == ["agent_failed", "agent_failover"]
    assert events[0][1]["details"]["attempt"] == 1


def test_each_call_is_limited_by_remaining_stage_time(monkeypatch):
    monkeypatch.setattr(healing, "clock", lambda: 100.0)
    monkeypatch.setattr(healing.state, "record", lambda *args, **kwargs: None)
    client = ScriptedClient({PRIMARY: [{"ok": True}]})
    llm = caller(client, deadline=107.5)

    llm("system", "user", timeout=90)

    assert client.calls == [(PRIMARY, 7.5)]


def test_server_error_retry_attempt_is_scoped_to_worker_run(monkeypatch):
    events = []
    monkeypatch.setattr(healing, "clock", lambda: 10.0)
    monkeypatch.setattr(healing, "sleep", lambda seconds: None)
    monkeypatch.setattr(healing.state, "record", lambda *args, **kwargs: events.append((args, kwargs)))
    first_client = ScriptedClient({PRIMARY: ["server_error", {"ok": True}]})

    first = caller(first_client)("system", "user")
    second = caller(ScriptedClient({PRIMARY: [{"ok": True}]}))("system", "user")

    assert first.attempts == 2
    assert second.attempts == 1
    retry = next(kwargs["details"] for args, kwargs in events if args[2] == "agent_retry")
    assert retry["attempt"] == 2
