"""Discord 발송 (docs/DECISIONS.md 12-4): 보낼 편지함의 pending 메시지를 엔진 루프에서 보낸다.

Webhook이면 deliver의 결과로 sent·failed를 기록한다 (재시도·첨부 없이 글만은 WebhookNotifier가 한다).
Webhook이 아니면(openclaw·콘솔) send·send_file로 넘기고 openclaw는 sent, 콘솔은 skipped로 둔다.
한 메시지의 오류가 나머지를 막지 않는다. last_error에 Webhook 주소를 넣지 않는다.
"""
import re
from datetime import datetime
from pathlib import Path

from django.utils import timezone
from paper_engine.notify import ConsoleNotifier

from config import engine

from .models import OutboxMessage

BATCH_SIZE = 20  # 한 번에 보낼 최대 메시지 수 (엔진 루프 한 바퀴가 Discord 응답을 너무 오래 기다리지 않게)
_WEBHOOK_PATH = re.compile(r"/api/webhooks/[^\s'\"]+")


def tick(now: datetime | None = None, log=print) -> int:
    """pending 메시지를 오래된 순으로 최대 BATCH_SIZE개 보낸다. 처리한 수를 돌려준다."""
    messages = list(OutboxMessage.objects.filter(status=OutboxMessage.PENDING).order_by("created_at", "id")
                    [:BATCH_SIZE])
    if not messages:
        return 0
    now = now or timezone.now()
    notifier = engine.notifier()
    for message in messages:
        message.attempts += 1
        try:
            _send(notifier, message, now)
        except Exception as e:  # 한 메시지의 오류가 나머지를 막지 않게
            message.status, message.last_error = OutboxMessage.FAILED, _scrub(f"{type(e).__name__}: {e}")
        if message.status == OutboxMessage.FAILED:
            log(f"Discord 알림 #{message.id} 보내기 실패: {message.last_error}")
        message.save(update_fields=["status", "attempts", "last_error", "sent_at"])
    return len(messages)


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
