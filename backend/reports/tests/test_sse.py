"""SSE (GET /api/reports/{id}/events). 가짜 시계로 기다리지 않고, 스트림은 끝까지 읽어 검사한다.

가짜 sleep이 시간을 앞으로 보내고, hooks[n]이 있으면 n번째 sleep에서 불러 DB를 바꾼다 (그사이 Orchestrator가 State·Trace를 바꾼 것처럼).
"""
import json

import pytest

from reports import sse
from reports.orchestration import state

from .conftest import make_report

pytestmark = pytest.mark.django_db


@pytest.fixture
def clock(monkeypatch):
    fake = {"now": 0.0, "sleeps": [], "hooks": {}}

    def sleep(seconds):
        fake["sleeps"].append(seconds)
        fake["now"] += seconds
        hook = fake["hooks"].get(len(fake["sleeps"]))
        if hook:
            hook()
    monkeypatch.setattr(sse, "clock", lambda: fake["now"])
    monkeypatch.setattr(sse, "sleep", sleep)
    return fake


def read(response) -> list[tuple]:
    """스트림을 끝까지 읽어 (event, id, data) 목록으로. 주석 줄은 ("comment", None, 내용)."""
    assert response.status_code == 200 and response.streaming
    text = b"".join(response.streaming_content).decode()
    assert text.endswith("\n\n")
    messages = []
    for block in text[:-2].split("\n\n"):
        if block.startswith(":"):
            messages.append(("comment", None, block))
            continue
        fields = dict(line.split(": ", 1) for line in block.split("\n"))
        assert set(fields) <= {"event", "id", "data"}
        messages.append((fields["event"], fields.get("id"), json.loads(fields["data"])))
    return messages


def events_url(report, query=""):
    return f"/api/reports/{report.id}/events{query}"


@pytest.fixture
def finished(user):
    """끝난 리포트: Trace 3개."""
    report = state.start(make_report(user))
    state.record(report, "orchestrator", "workflow_started", "started")
    state.record(report, "market_agent", "agent_completed", "completed", provider="openai", model="gpt-x",
                 latency_ms=500)
    state.add_result(report, "market_agent", {"trend": "up"})
    state.record(report, "orchestrator", "workflow_completed", "completed")
    return state.finish(report, "completed", content="# 끝")


def test_login_and_not_found_are_json(client, api, user):
    report = make_report(user)
    client.logout()
    response = client.get(events_url(report))
    assert response.status_code == 401 and response["Content-Type"] == "application/json"
    assert response.json() == {"detail": "로그인이 필요합니다."}
    client.force_login(user)
    response = client.get("/api/reports/999/events")
    assert response.status_code == 404 and response.json() == {"detail": "리포트를 찾을 수 없습니다."}


def test_finished_report_sends_state_trace_end(api, finished, clock):
    response = api.get(events_url(finished))
    assert response["Content-Type"] == "text/event-stream"
    assert (response["Cache-Control"], response["X-Accel-Buffering"]) == ("no-cache", "no")
    messages = read(response)
    assert [(event, event_id) for event, event_id, _ in messages] == [
        ("state", None), ("trace", "1"), ("trace", "2"), ("trace", "3"), ("end", None)]
    assert messages[0][2] == {"taskId": f"report-{finished.id}", "status": "completed", "currentStep": None,
                              "results": {"market_agent": {"trend": "up"}}, "errors": {},
                              "completedAgents": ["market_agent"], "failedAgents": []}
    snapshot = api.get(f"/api/reports/{finished.id}").json()
    assert [data for event, _, data in messages if event == "trace"] == snapshot["trace"]  # Snapshot과 같은 형식
    assert messages[-1][2] == {"status": "completed"}
    assert clock["sleeps"] == []  # 끝났으면 기다리지 않고 바로 닫는다


@pytest.mark.parametrize("query, headers, steps", [
    ("?after=1", {}, ["2", "3"]),
    ("?after=3", {}, []),
    ("?after=0", {"Last-Event-ID": "2"}, ["3"]),  # 다시 붙을 때의 Last-Event-ID가 우선
    ("", {"Last-Event-ID": "1"}, ["2", "3"]),
    ("?after=abc", {}, ["1", "2", "3"]),  # 잘못된 값은 처음부터
])
def test_after_and_last_event_id(api, finished, clock, query, headers, steps):
    messages = read(api.get(events_url(finished, query), headers=headers))
    assert [event_id for event, event_id, _ in messages if event == "trace"] == steps
    assert messages[0][0] == "state" and messages[-1] == ("end", None, {"status": "completed"})


def test_streams_changes_until_end(api, user, clock):
    report = make_report(user)

    def begin():
        state.start(report)
        state.set_step(report, "parallel_research")
        state.record(report, "market_agent", "agent_started", "started")

    def progress():
        state.record(report, "market_agent", "agent_completed", "completed", latency_ms=700)
        state.add_result(report, "market_agent", {"trend": "up"})

    def end():
        state.record(report, "orchestrator", "workflow_failed", "failed", details={"reason": "필수 Worker 실패"})
        state.finish(report, "failed")
    clock["hooks"] = {1: begin, 2: progress, 4: end}  # 3번째 sleep 동안은 바뀐 것이 없다

    messages = read(api.get(events_url(report)))
    assert [(event, event_id, data.get("status")) for event, event_id, data in messages] == [
        ("state", None, "requested"),                                   # 연결하자마자 현재 상태
        ("state", None, "running"), ("trace", "1", "started"),
        ("state", None, "running"), ("trace", "2", "completed"),       # results가 바뀌었다
        ("state", None, "failed"), ("trace", "3", "failed"),
        ("end", None, "failed"),
    ]
    assert messages[1][2]["currentStep"] == "parallel_research"
    assert messages[3][2]["completedAgents"] == ["market_agent"]
    assert messages[4][2]["latencyMs"] == 700
    assert messages[6][2]["details"] == {"reason": "필수 Worker 실패"}
    assert clock["sleeps"] == [sse.POLL_SEC] * 4


def test_keep_alive_and_close_after_stream_time(api, user, clock):
    report = make_report(user)  # requested 그대로: 바뀌는 것이 없다
    messages = read(api.get(events_url(report)))
    assert messages[0][0] == "state"
    assert messages[1:] == [("comment", None, ": keep-alive")] * 3  # 15·30·45초. 60초에 end 없이 닫는다
    assert clock["now"] == sse.STREAM_SEC and len(clock["sleeps"]) == 60


def test_intervals_are_module_constants(api, user, clock, monkeypatch):
    monkeypatch.setattr(sse, "POLL_SEC", 0.5)
    monkeypatch.setattr(sse, "KEEPALIVE_SEC", 1.0)
    monkeypatch.setattr(sse, "STREAM_SEC", 3.0)
    messages = read(api.get(events_url(make_report(user))))
    assert [event for event, _, _ in messages] == ["state", "comment", "comment"]  # 1·2초
    assert clock["sleeps"] == [0.5] * 6
