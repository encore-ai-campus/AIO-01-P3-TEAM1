"""응답 형식 (docs/API.md Notification · NotificationSettings). 키는 camelCase, 시각은 오프셋이 붙은 ISO 문자열."""
from datetime import datetime

from django.utils import timezone

from .models import Notification, NotificationSetting


def iso(value: datetime | None) -> str | None:
    return timezone.localtime(value).isoformat() if value else None


def notification_json(n: Notification) -> dict:
    return {"id": n.id, "kind": n.kind, "title": n.title, "body": n.body, "link": n.link,
            "createdAt": iso(n.created_at), "readAt": iso(n.read_at)}


def settings_json(setting: NotificationSetting, webhook_configured: bool) -> dict:
    """Webhook 주소는 넣지 않는다 (있는지만)."""
    return {"discordUserId": setting.discord_user_id, "discordEnabled": setting.discord_enabled,
            "webhookConfigured": webhook_configured}
