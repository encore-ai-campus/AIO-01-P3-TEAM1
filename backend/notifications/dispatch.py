"""Discord 발송 (docs/DECISIONS.md 12-4): 보낼 편지함의 pending 메시지를 엔진 루프에서 보낸다.

Webhook이면 deliver의 결과로 sent·failed를 기록한다 (재시도·첨부 없이 글만은 WebhookNotifier가 한다).
Webhook이 아니면(openclaw·콘솔) send·send_file로 넘기고 openclaw는 sent, 콘솔은 skipped로 둔다.
한 메시지의 오류가 나머지를 막지 않는다. last_error에 Webhook 주소를 넣지 않는다.

메시지마다 pending → sending 조건부 UPDATE로 먼저 잡고 보낸다 (엔진 루프가 둘이어도 한 번만 보낸다).
한 바퀴에 TIME_BUDGET_SEC를 넘게 쓰면 남은 메시지는 다음 바퀴로 미룬다 (Discord가 느려도 체결·손절 확인이 밀리지 않게).
"""
import re
import time
from datetime import datetime, timedelta
from pathlib import Path

from django.db.models import F
from django.utils import timezone
from paper_engine.notify import ConsoleNotifier

from config import engine

from .models import OutboxMessage

BATCH_SIZE = 20  # 한 번에 보낼 최대 메시지 수 (엔진 루프 한 바퀴가 Discord 응답을 너무 오래 기다리지 않게)
TIME_BUDGET_SEC = 15  # 한 바퀴에 발송에 쓸 시간. 메시지 하나를 시작하기 전에 확인한다
STALE_SENDING = timedelta(minutes=10)  # sending으로 이만큼 남아 있으면 보내다 죽은 것으로 보고 pending으로 되돌린다
_WEBHOOK_PATH = re.compile(r"/api/webhooks/[^\s'\"]+")


def tick(now: datetime | None = None, log=print) -> int:
    """pending 메시지를 오래된 순으로 최대 BATCH_SIZE개, 시간 예산 안에서 보낸다. 처리한 수를 돌려준다."""
    now = now or timezone.now()
    OutboxMessage.objects.filter(status=OutboxMessage.SENDING, claimed_at__lt=now - STALE_SENDING).update(
        status=OutboxMessage.PENDING)
    ids = list(OutboxMessage.objects.filter(status=OutboxMessage.PENDING).order_by("created_at", "id")
               .values_list("id", flat=True)[:BATCH_SIZE])
    if not ids:
        return 0
    notifier = engine.notifier()
    started, done = time.monotonic(), 0
    for i, message_id in enumerate(ids):
        if done and time.monotonic() - started >= TIME_BUDGET_SEC:
            log(f"Discord 알림 발송 시간 {TIME_BUDGET_SEC}초를 넘어 남은 {len(ids) - i}개는 다음 바퀴에 보냄")
            break
        claimed = OutboxMessage.objects.filter(pk=message_id, status=OutboxMessage.PENDING).update(
            status=OutboxMessage.SENDING, claimed_at=now, attempts=F("attempts") + 1)
        if not claimed:  # 다른 엔진 루프가 먼저 잡았다
            continue
        message = OutboxMessage.objects.get(pk=message_id)
        try:
            _send(notifier, message, now)
        except Exception as e:  # 한 메시지의 오류가 나머지를 막지 않게
            message.status, message.last_error = OutboxMessage.FAILED, _scrub(f"{type(e).__name__}: {e}")
        if message.status == OutboxMessage.FAILED:
            log(f"Discord 알림 #{message.id} 보내기 실패: {message.last_error}")
        message.save(update_fields=["status", "last_error", "sent_at"])
        done += 1
    return done


def _send(notifier, message: OutboxMessage, now: datetime) -> None:
    deliver = getattr(notifier, "deliver", None)
    if callable(deliver):  # Discord Webhook
        result = deliver(message.content, path=message.file_path or None,
                         embeds=[message.embed] if message.embed else None)
        if result.ok:
            message.status, message.sent_at = OutboxMessage.SENT, now
            message.last_error = "첨부 없이 글만 보냄" if message.file_path and not result.attached else None
        else:
            message.status, message.last_error = OutboxMessage.FAILED, _scrub(result.error or "알 수 없는 오류")
        return
    if message.file_path:
        notifier.send_file(Path(message.file_path), message.content)
    else:
        notifier.send(message.content)
    if isinstance(notifier, ConsoleNotifier):
        message.status, message.last_error = OutboxMessage.SKIPPED, "Discord 설정이 없어 콘솔에만 남김"
    else:
        message.status, message.sent_at, message.last_error = OutboxMessage.SENT, now, None


def _scrub(text: str) -> str:
    """오류 문자열에서 Webhook 주소를 지운다."""
    url = engine.engine_config().discord_webhook_url
    if url:
        text = text.replace(url, "<webhook>")
    return _WEBHOOK_PATH.sub("/api/webhooks/<비밀 값>", text)[:500]
