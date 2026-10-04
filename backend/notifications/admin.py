"""관리 화면. Webhook 주소는 DB에 없으므로 여기에도 나오지 않는다."""
from django.contrib import admin

from .models import Notification, NotificationSetting, OutboxMessage


@admin.register(Notification)
class NotificationAdmin(admin.ModelAdmin):
    list_display = ("id", "created_at", "user", "kind", "title", "link", "read_at")
    list_filter = ("kind",)
    search_fields = ("user__username", "title")
    ordering = ("-created_at",)


@admin.register(NotificationSetting)
class NotificationSettingAdmin(admin.ModelAdmin):
    list_display = ("user", "discord_user_id", "discord_enabled", "updated_at")
    list_filter = ("discord_enabled",)
    search_fields = ("user__username", "discord_user_id")


@admin.register(OutboxMessage)
class OutboxMessageAdmin(admin.ModelAdmin):
    list_display = ("id", "created_at", "kind", "status", "attempts", "sent_at", "last_error")
    list_filter = ("status", "kind")
    search_fields = ("content",)
    ordering = ("-created_at",)
