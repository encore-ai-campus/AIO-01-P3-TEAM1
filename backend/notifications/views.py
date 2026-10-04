"""알림 API (docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림"): 내 웹 알림, 읽음 표시, 알림 설정, 시험 알림."""
import re
from datetime import timedelta

from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from config.api import LimitExceeded, Rejected, page

from . import payloads, service
from .models import Notification

SETTINGS_KEYS = ("discordUserId", "discordEnabled")
DISCORD_USER_ID = re.compile(r"[0-9]{17,20}")  # ASCII 숫자만 (\d는 다른 문자의 숫자도 받는다)
MAX_READ_IDS = 500
TEST_TITLE = "알림 시험"
TEST_BODY = "알림이 잘 도착하는지 확인하는 시험 알림입니다."
TEST_INTERVAL = timedelta(minutes=1)  # 팀원별 시험 알림 간격 (팀 Discord 채널 도배 방지)
TEST_TOO_SOON = "시험 알림은 1분에 한 번만 보낼 수 있습니다. 잠시 뒤에 다시 시도하세요."
TEST_DETAIL = {
    "queued": "웹 알림을 만들고 Discord로 보낼 메시지를 넣었습니다. 엔진 루프가 곧 보냅니다.",
    "not_configured": "웹 알림을 만들었습니다. 서버에 Discord 설정(Webhook)이 없어 Discord로는 보내지 않습니다.",
    "disabled": "웹 알림을 만들었습니다. Discord 알림을 꺼 두어 Discord로는 보내지 않습니다.",
}

# OpenAPI 문서용 (응답은 payloads가 만든다)
NOTIFICATION_PAGE_SCHEMA = inline_serializer("NotificationPage", {
    "count": serializers.IntegerField(), "unreadCount": serializers.IntegerField(),
    "results": inline_serializer("Notification", {
        "id": serializers.IntegerField(), "kind": serializers.CharField(), "title": serializers.CharField(),
        "body": serializers.CharField(), "link": serializers.CharField(allow_null=True),
        "createdAt": serializers.DateTimeField(), "readAt": serializers.DateTimeField(allow_null=True),
    }, many=True),
})
READ_SCHEMA = inline_serializer("NotificationRead", {
    "ids": serializers.ListField(child=serializers.IntegerField(), required=False),
    "all": serializers.BooleanField(required=False),
})
SETTINGS_SCHEMA = inline_serializer("NotificationSettings", {
    "discordUserId": serializers.CharField(allow_null=True), "discordEnabled": serializers.BooleanField(),
    "webhookConfigured": serializers.BooleanField(),
})
SETTINGS_PATCH_SCHEMA = inline_serializer("NotificationSettingsPatch", {
    "discordUserId": serializers.CharField(allow_null=True, allow_blank=True, required=False),
    "discordEnabled": serializers.BooleanField(required=False),
})
TEST_SCHEMA = inline_serializer("NotificationTest", {
    "detail": serializers.CharField(), "discord": serializers.ChoiceField(choices=list(TEST_DETAIL)),
})


class NotificationListView(APIView):
    @extend_schema(responses=NOTIFICATION_PAGE_SCHEMA)
    def get(self, request):
        """내 알림 (최신순). `unread=1`이면 안 읽은 것만. unreadCount는 필터와 상관없이 안 읽은 수."""
        mine = Notification.objects.filter(user=request.user)
        unread = mine.filter(read_at__isnull=True)
        items = unread if request.query_params.get("unread") in ("1", "true") else mine
        response = page(request, items.order_by("-created_at", "-id"), payloads.notification_json)
        response.data["unreadCount"] = unread.count()
        return response


class NotificationReadView(APIView):
    @extend_schema(request=READ_SCHEMA, responses={204: None})
    def post(self, request):
        """읽음 표시. `{"ids": [...]}` 또는 `{"all": true}`. 남의 알림 id는 무시한다."""
        data = request.data if isinstance(request.data, dict) else None
        if data is None:
            raise Rejected("요청 본문은 JSON 객체여야 합니다.")
        unread = Notification.objects.filter(user=request.user, read_at__isnull=True)
        if data.get("all") is True:
            unread.update(read_at=timezone.now())
            return Response(status=status.HTTP_204_NO_CONTENT)
        ids = data.get("ids")
        if not (isinstance(ids, list) and all(isinstance(i, int) and not isinstance(i, bool) for i in ids)):
            raise Rejected("ids(알림 번호 목록) 또는 all: true를 보내세요.")
        if len(ids) > MAX_READ_IDS:
            raise Rejected(f"ids는 한 번에 {MAX_READ_IDS}개까지입니다.")
        if ids:
            unread.filter(id__in=ids).update(read_at=timezone.now())
        return Response(status=status.HTTP_204_NO_CONTENT)


class NotificationSettingsView(APIView):
    @extend_schema(responses=SETTINGS_SCHEMA)
    def get(self, request):
        return Response(payloads.settings_json(service.settings_of(request.user), service.webhook_configured()))

    @extend_schema(request=SETTINGS_PATCH_SCHEMA, responses=SETTINGS_SCHEMA)
    def patch(self, request):
        """준 항목만 바꾼다. discordUserId는 숫자 17~20자리, 빈 문자열·null이면 지운다."""
        data = request.data
        if not isinstance(data, dict):
            raise Rejected("요청 본문은 JSON 객체여야 합니다.")
        unknown = sorted(set(data) - set(SETTINGS_KEYS))
        if unknown:
            raise Rejected(f"알 수 없는 항목입니다: {', '.join(unknown)}")
        setting = service.settings_of(request.user)
        fields = []
        if "discordUserId" in data:
            value = data["discordUserId"]
            if value is not None and not isinstance(value, str):
                raise Rejected("discordUserId는 문자열이어야 합니다 (숫자 17~20자리).")
            value = (value or "").strip()
            if value and not DISCORD_USER_ID.fullmatch(value):
                raise Rejected("Discord 사용자 ID는 숫자 17~20자리입니다. Discord 개발자 모드에서 '사용자 ID 복사'로 얻습니다.")
            setting.discord_user_id = value or None
            fields.append("discord_user_id")
        if "discordEnabled" in data:
            if not isinstance(data["discordEnabled"], bool):
                raise Rejected("discordEnabled는 true 또는 false여야 합니다.")
            setting.discord_enabled = data["discordEnabled"]
            fields.append("discord_enabled")
        if fields:
            setting.save(update_fields=[*fields, "updated_at"])
        return Response(payloads.settings_json(setting, service.webhook_configured()))


class NotificationTestView(APIView):
    @extend_schema(request=None, responses={202: TEST_SCHEMA})
    def post(self, request):
        """시험 알림: 웹 알림 하나를 만들고, 가능하면 Discord로도 보낸다 (엔진 루프가 보낸다). 팀원별 1분에 한 번 (넘으면 429)."""
        recent = Notification.objects.filter(user=request.user, kind="system", title=TEST_TITLE,
                                             created_at__gt=timezone.now() - TEST_INTERVAL)
        if recent.exists():
            raise LimitExceeded(TEST_TOO_SOON)
        setting = service.settings_of(request.user)
        if not service.discord_configured():
            discord = "not_configured"
        elif not setting.discord_enabled:
            discord = "disabled"
        else:
            discord = "queued"
        service.notify(request.user, "system", TEST_TITLE, TEST_BODY, link="/my", discord=discord == "queued",
                       link_label="My Page")
        return Response({"detail": TEST_DETAIL[discord], "discord": discord}, status=status.HTTP_202_ACCEPTED)
