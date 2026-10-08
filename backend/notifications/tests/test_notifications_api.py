"""알림 API (docs/API.md): 내 알림·읽음 표시·알림 설정·시험 알림. 남의 알림은 보지도 바꾸지도 못한다."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from django.test import Client

from notifications.models import Notification, NotificationSetting, OutboxMessage

from .conftest import SECRET

pytestmark = pytest.mark.django_db

T0 = datetime(2026, 10, 5, tzinfo=timezone.utc)


@pytest.fixture
def client(alice):
    c = Client()
    c.force_login(alice)
    return c


def note(user, i, read=False) -> Notification:
    return Notification.objects.create(user=user, kind="filled", title=f"알림 {i}", body="본문", link=f"/plans/{i}",
                                       created_at=T0 + timedelta(minutes=i), read_at=T0 if read else None)


def post(client, url, data=None):
    return client.post(url, data or {}, content_type="application/json")


def patch(client, data):
    return client.patch("/api/notification-settings", data, content_type="application/json")


def age_test_notifications():
    """시험 알림은 1분에 한 번: 앞서 보낸 것을 2분 전으로 돌린다."""
    Notification.objects.update(created_at=datetime.now(timezone.utc) - timedelta(minutes=2))


def test_login_required():
    c = Client()
    assert c.get("/api/notifications").status_code == 401
    assert post(c, "/api/notifications/read", {"all": True}).status_code == 401
    assert c.get("/api/notification-settings").status_code == 401
    assert post(c, "/api/notification-settings/test").status_code == 401


def test_list_is_mine_newest_first_with_unread_count(client, alice, bob):
    for i in range(3):
        note(alice, i, read=(i == 0))
    note(bob, 9)
    body = client.get("/api/notifications").json()
    assert body["count"] == 3 and body["unreadCount"] == 2
    assert [n["title"] for n in body["results"]] == ["알림 2", "알림 1", "알림 0"]
    first = body["results"][0]
    assert set(first) == {"id", "kind", "title", "body", "link", "createdAt", "readAt"}
    assert first["link"] == "/plans/2" and first["readAt"] is None and first["createdAt"].endswith("+09:00")
    unread = client.get("/api/notifications?unread=1").json()
    assert unread["count"] == 2 and unread["unreadCount"] == 2
    paged = client.get("/api/notifications?limit=1&offset=1").json()
    assert paged["count"] == 3 and [n["title"] for n in paged["results"]] == ["알림 1"]


def test_read_ids_ignores_others_and_all(client, alice, bob):
    mine = [note(alice, i) for i in range(3)]
    theirs = note(bob, 9)
    assert post(client, "/api/notifications/read", {"ids": [mine[0].id, theirs.id, 99999]}).status_code == 204
    theirs.refresh_from_db()
    assert theirs.read_at is None  # 남의 알림은 그대로
    assert client.get("/api/notifications").json()["unreadCount"] == 2
    assert post(client, "/api/notifications/read", {"all": True}).status_code == 204
    assert client.get("/api/notifications").json()["unreadCount"] == 0
    theirs.refresh_from_db()
    assert theirs.read_at is None


@pytest.mark.parametrize("data", [{}, {"ids": "1"}, {"ids": [1, "2"]}, {"ids": [True]}, {"all": False},
                                  {"ids": list(range(501))}])
def test_read_rejects_bad_body(client, data):
    response = post(client, "/api/notifications/read", data)
    assert response.status_code == 400 and response.json()["detail"]


def test_settings_default_and_webhook_flag(client, config):
    assert client.get("/api/notification-settings").json() == {
        "discordUserId": None, "discordEnabled": True, "webhookConfigured": False}
    config("https://discord.com/api/webhooks/1/" + SECRET)
    response = client.get("/api/notification-settings")
    # Discord 알림을 끈 동안(DECISIONS 24장)은 Webhook이 있어도 false — 화면이 Discord 묶음을 접는다 (켜면 True)
    assert response.json()["webhookConfigured"] is False and SECRET not in response.content.decode()


def test_settings_patch_validates_discord_user_id(client, alice):
    response = patch(client, {"discordUserId": " 123456789012345678 ", "discordEnabled": False})
    assert response.status_code == 200
    assert response.json() == {"discordUserId": "123456789012345678", "discordEnabled": False,
                               "webhookConfigured": False}
    assert NotificationSetting.objects.get(user=alice).discord_user_id == "123456789012345678"
    arabic, fullwidth = "\u0661" * 18, "\uff11" * 18  # 유니코드 숫자(아랍·전각)는 받지 않는다
    for bad in ("1234", "12345678901234567890123", "12345678901234567a", 123456789012345678, ["1"], arabic, fullwidth):
        response = patch(client, {"discordUserId": bad})
        assert response.status_code == 400, bad
        assert "숫자 17~20자리" in response.json()["detail"]
    assert patch(client, {"discordUserId": "12345678901234567"}).json()["discordUserId"] == "12345678901234567"
    assert patch(client, {"discordUserId": ""}).json()["discordUserId"] is None
    patch(client, {"discordUserId": "12345678901234567890"})
    assert patch(client, {"discordUserId": None}).json()["discordUserId"] is None
    assert patch(client, {"discordEnabled": "yes"}).status_code == 400
    response = patch(client, {"webhook": "x"})
    assert response.status_code == 400 and "알 수 없는 항목" in response.json()["detail"]
    assert patch(client, json.dumps([1])).status_code == 400


def test_settings_test_endpoint_states(client, alice, config):
    response = post(client, "/api/notification-settings/test")
    assert response.status_code == 202 and response.json()["discord"] == "not_configured"
    assert response.json()["detail"] and Notification.objects.filter(user=alice, kind="system").count() == 1
    assert not OutboxMessage.objects.exists()

    config("https://discord.com/api/webhooks/1/" + SECRET)
    patch(client, {"discordUserId": "123456789012345678"})
    age_test_notifications()
    response = post(client, "/api/notification-settings/test")
    assert response.status_code == 202 and response.json()["discord"] == "queued"
    (m,) = OutboxMessage.objects.all()
    assert m.status == "pending" and m.content.startswith("[모매매 · 모의투자] **알림 시험**\n<@123456789012345678>")
    assert SECRET not in response.content.decode() and SECRET not in m.content

    patch(client, {"discordEnabled": False})
    age_test_notifications()
    response = post(client, "/api/notification-settings/test")
    assert response.json()["discord"] == "disabled" and OutboxMessage.objects.count() == 1
    assert Notification.objects.filter(user=alice).count() == 3


def test_settings_test_endpoint_is_limited_per_user(client, alice, bob):
    assert post(client, "/api/notification-settings/test").status_code == 202
    response = post(client, "/api/notification-settings/test")
    assert response.status_code == 429 and "1분에 한 번" in response.json()["detail"]
    assert Notification.objects.filter(user=alice).count() == 1  # 막힌 요청은 알림을 만들지 않는다
    other = Client()
    other.force_login(bob)
    assert post(other, "/api/notification-settings/test").status_code == 202  # 팀원별로 센다
    Notification.objects.filter(user=alice, kind="system").update(read_at=T0)  # 읽음 여부와 상관없이 시각으로 센다
    assert post(client, "/api/notification-settings/test").status_code == 429
    age_test_notifications()
    assert post(client, "/api/notification-settings/test").status_code == 202


def test_settings_test_endpoint_not_configured_while_discord_disabled(client, monkeypatch):
    """Discord 알림을 끈 동안(DECISIONS 24장)은 openclaw·Webhook 설정이 있어도 "not_configured" — 웹 알림만 남는다.
    켜면 예전 기대값: openclaw만 있으면 "queued", 편지함은 pending."""
    from paper_engine.config import Config

    from config import engine
    monkeypatch.setattr(engine, "engine_config", lambda: Config(None, None, None, openclaw_target="channel:1",
                                                                  discord_webhook_url="https://discord.com/api/webhooks/1/x"))
    response = post(client, "/api/notification-settings/test")
    assert response.json()["discord"] == "not_configured" and not OutboxMessage.objects.exists()
    assert client.get("/api/notification-settings").json()["webhookConfigured"] is False
