"""웹 알림 · 알림 설정 · Discord 보낼 편지함 (docs/DECISIONS.md 12-4).

다른 앱 모델에 FK를 걸지 않는다 (autotrade와 순환·마이그레이션 의존을 만들지 않게). 연결은 `link` 경로로 한다.
"""
from django.conf import settings
from django.db import models
from django.utils import timezone


class Notification(models.Model):
    """받는 사람별 웹 알림 하나. 다른 앱은 service.notify로만 만든다."""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="notifications")
    kind = models.CharField(max_length=30)                # docs/API.md NotificationKind
    title = models.CharField(max_length=200)
    body = models.TextField(blank=True, default="")
    link = models.CharField(max_length=500, null=True, blank=True)  # 웹 경로 ("/plans/3")
    created_at = models.DateTimeField(default=timezone.now)
    read_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "notifications"
        indexes = [models.Index(fields=["user", "created_at"]), models.Index(fields=["user", "read_at"])]

    def __str__(self) -> str:
        return f"#{self.id} {self.kind} {self.title}"


class NotificationSetting(models.Model):
    """팀원별 알림 설정 (My Page). 행이 없으면 기본값(멘션 없음, Discord 켬)으로 본다."""
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE,
                                related_name="notification_setting")
    discord_user_id = models.CharField(max_length=20, null=True, blank=True)  # 숫자 17~20자리. 있으면 <@ID>로 멘션
    discord_enabled = models.BooleanField(default=True)  # 내 알림을 Discord로도 보낼지 (웹 알림은 항상 남는다)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "notification_settings"

    def __str__(self) -> str:
        return f"{self.user} Discord {'켬' if self.discord_enabled else '끔'}"


class OutboxMessage(models.Model):
    """Discord로 보낼 메시지 하나. 웹 요청이 pending으로 넣고 엔진 루프의 dispatch.tick()이 보낸다.

    sending: dispatch.tick이 보내려고 잡았음 (claimed_at). 오래 남아 있으면(엔진이 죽음) pending으로 되돌린다.
    skipped: 보내지 않음 (Discord 설정이 없어 콘솔에만 남김). last_error에는 Webhook 주소를 넣지 않는다.
    """
    PENDING, SENDING, SENT, FAILED, SKIPPED = "pending", "sending", "sent", "failed", "skipped"
    STATUSES = [(s, s) for s in (PENDING, SENDING, SENT, FAILED, SKIPPED)]

    kind = models.CharField(max_length=30)
    content = models.TextField()                          # 멘션 + 제목 + 본문 + 링크 (2,000자를 넘으면 보낼 때 나눈다)
    embed = models.JSONField(null=True, blank=True)       # Discord embed 하나
    file_path = models.CharField(max_length=500, null=True, blank=True)  # 첨부할 파일 (8MB 넘으면 글만)
    status = models.CharField(max_length=10, choices=STATUSES, default=PENDING)
    attempts = models.IntegerField(default=0)
    last_error = models.TextField(null=True, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    claimed_at = models.DateTimeField(null=True, blank=True)  # sending으로 잡은 시각
    sent_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        db_table = "notification_outbox"
        indexes = [models.Index(fields=["status", "created_at"])]

    def __str__(self) -> str:
        return f"#{self.id} {self.kind} {self.status}"
