"""AI 리포트 실행 Event 전달 (SSE, docs/API.md "AI 리포트" SSE 형식).

DRF 뷰가 아니라 일반 Django 뷰다 (DRF의 응답 형식 협상을 거치지 않게). 상태와 Trace의 저장소는 DB이고 SSE는 전달만 한다:
DB를 POLL_SEC마다 다시 읽어 새 사건(`trace`)과 바뀐 상태(`state`)를 보내고, 끝났으면 `end`를 보낸 뒤 닫는다.
한 연결은 STREAM_SEC 뒤 닫는다 (브라우저 EventSource가 Last-Event-ID로 다시 붙는다).
"""
import json
import time

from django.http import JsonResponse, StreamingHttpResponse
from django.views.decorators.http import require_GET

from .models import Report
from .payloads import shared_state, trace_event

POLL_SEC, KEEPALIVE_SEC, STREAM_SEC = 1.0, 15.0, 60.0
clock, sleep = time.monotonic, time.sleep  # 테스트가 가짜 시계로 바꾼다


@require_GET
def events(request, pk: int):
    """GET /api/reports/{id}/events. 미로그인 401·없는 리포트 404는 JSON으로 (API 공통 오류 형식)."""
    if not request.user.is_authenticated:
        return _error("로그인이 필요합니다.", 401)
    if not Report.objects.filter(pk=pk, deleted_at__isnull=True).exists():  # 지운 리포트도 없는 것과 같다
        return _error("리포트를 찾을 수 없습니다.", 404)
    response = StreamingHttpResponse(stream(pk, _after(request)), content_type="text/event-stream")
    response["Cache-Control"] = "no-cache"
    response["X-Accel-Buffering"] = "no"  # nginx가 모아 두지 않고 바로 넘기게
    return response


def _error(detail: str, status: int) -> JsonResponse:
    return JsonResponse({"detail": detail}, status=status, json_dumps_params={"ensure_ascii": False})  # DRF 응답처럼


def _after(request) -> int:
    """이미 받은 마지막 step. 다시 붙을 때 브라우저가 보내는 Last-Event-ID가 ?after=보다 우선한다. 없거나 잘못되면 0."""
    for value in (request.headers.get("Last-Event-ID"), request.GET.get("after")):
        try:
            return max(int(value), 0)
        except (TypeError, ValueError):
            continue
    return 0


def stream(pk: int, after: int):
    """연결하자마자 현재 state, 그다음 after보다 큰 trace를 step 순서로. 이후 바뀐 것만 보낸다."""
    started = last_sent = clock()
    last_state = None
    while True:
        # 상태를 사건보다 먼저 읽는다. 끝난 리포트에는 Trace가 더 붙지 않으므로(state.record) 끝난 것을 본 뒤 읽은 사건이 전부다
        report = Report.objects.filter(pk=pk, deleted_at__isnull=True).first()
        if report is None:  # 지워졌다 (숨김 포함)
            return
        state = shared_state(report)
        if state != last_state:
            yield frame("state", state)
            last_state, last_sent = state, clock()
        for event in report.trace_events.filter(step__gt=after).order_by("step"):
            yield frame("trace", trace_event(event), event_id=event.step)
            after, last_sent = event.step, clock()
        if report.status in Report.FINISHED:
            yield frame("end", {"status": report.status})
            return
        now = clock()
        if now - started >= STREAM_SEC:
            return
        if now - last_sent >= KEEPALIVE_SEC:
            yield ": keep-alive\n\n"
            last_sent = now
        sleep(POLL_SEC)


def frame(event: str, data: dict, event_id: int | None = None) -> str:
    """SSE 메시지 하나. data는 한 줄 JSON (문자열 안의 줄바꿈은 JSON이 \\n으로 바꾼다)."""
    lines = [f"event: {event}"]
    if event_id is not None:
        lines.append(f"id: {event_id}")
    lines.append(f"data: {json.dumps(data, ensure_ascii=False)}")
    return "\n".join(lines) + "\n\n"
