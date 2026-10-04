"""notify: 사용자별 웹 알림 + Discord 보낼 편지함 메시지 하나 (docs/DECISIONS.md 12-4)."""
import pytest
from django.db import transaction

from notifications import service
from notifications.models import Notification, NotificationSetting, OutboxMessage

from .conftest import BASE

pytestmark = pytest.mark.django_db

ALICE_ID = "123456789012345678"
BOB_ID = "98765432109876543"


def discord(user, user_id=None, enabled=True):
    NotificationSetting.objects.create(user=user, discord_user_id=user_id, discord_enabled=enabled)


def test_notify_one_user_makes_web_row_and_outbox_message(webhook, alice):
    created = service.notify(alice, "filled", "삼성전자 진입 체결", "71,000원 × 28주", link="/plans/3")
    (n,) = created
    assert n.pk and (n.user, n.kind, n.title, n.body, n.link, n.read_at) == (
        alice, "filled", "삼성전자 진입 체결", "71,000원 × 28주", "/plans/3", None)
    assert list(Notification.objects.all()) == created
    (m,) = OutboxMessage.objects.all()
    assert m.status == "pending" and m.kind == "filled" and m.attempts == 0 and m.embed is None
    assert m.content == f"**삼성전자 진입 체결**\n71,000원 × 28주\n▶ 웹에서 보기: {BASE}/plans/3"


def test_notify_list_mentions_enabled_users_with_discord_id(webhook, alice, bob, make_user):
    carol, dave = make_user("carol"), make_user("dave")
    discord(alice, ALICE_ID)
    discord(bob, BOB_ID)
    discord(carol, "111111111111111111", enabled=False)  # Discord를 껐다: 멘션하지 않는다
    created = service.notify([alice, bob, carol, dave, alice], "closed", "청산", "목표가 도달")
    assert sorted(n.user.username for n in created) == ["alice", "bob", "carol", "dave"]  # 같은 사람은 한 번
    (m,) = OutboxMessage.objects.all()
    assert m.content == f"<@{ALICE_ID}> <@{BOB_ID}>\n**청산**\n목표가 도달"  # 링크가 없으면 링크 줄도 없다


def test_notify_none_means_all_active_users_without_mentions(webhook, alice, bob, make_user):
    make_user("gone", is_active=False)
    discord(alice, ALICE_ID)
    created = service.notify(None, "recommendation", "새 추천", "삼성전자", link="/recommendations/1")
    assert sorted(n.user.username for n in created) == ["alice", "bob"]
    (m,) = OutboxMessage.objects.all()
    assert m.content.startswith("**새 추천**") and "<@" not in m.content


def test_notify_skips_outbox_when_everyone_turned_discord_off_or_discord_false(webhook, alice, bob):
    discord(alice, ALICE_ID, enabled=False)
    discord(bob, enabled=False)
    assert len(service.notify([alice, bob], "system", "제목", "본문")) == 2
    assert len(service.notify(alice, "system", "웹만", "본문", discord=False)) == 1
    assert not OutboxMessage.objects.exists() and Notification.objects.count() == 3
    assert service.notify([], "system", "아무도", "없음") == [] and not OutboxMessage.objects.exists()


def test_notify_without_webhook_records_skipped_and_prints(alice, capsys):
    assert not service.webhook_configured()
    service.notify(alice, "system", "제목", "본문")
    (m,) = OutboxMessage.objects.all()
    assert m.status == "skipped" and m.last_error == service.NO_WEBHOOK and m.sent_at is None
    assert "**제목**" in capsys.readouterr().out
    assert Notification.objects.count() == 1  # 웹 알림은 그대로 남는다


def test_notify_uses_discord_link_label_and_embed(webhook, alice):
    embed = {"title": "삼성전자", "description": "진입 71,000", "color": 3447003}
    (n,) = service.notify(alice, "recommendation", "새 추천", "삼성전자 진입 71,000원", link="/recommendations/7",
                          discord_link="/recommendations/7?t=signed.token", link_label="계획 활성화", embed=embed)
    assert n.link == "/recommendations/7"  # 웹 알림은 서명 링크를 쓰지 않는다
    (m,) = OutboxMessage.objects.all()
    assert m.content.endswith(f"▶ 계획 활성화: {BASE}/recommendations/7?t=signed.token") and m.embed == embed


def test_notify_never_raises(webhook, alice, monkeypatch, capsys):
    def boom(*args, **kwargs):
        raise RuntimeError("DB 끊김")

    monkeypatch.setattr(OutboxMessage.objects, "create", boom)
    with transaction.atomic():  # 호출한 쪽의 트랜잭션도 깨지지 않는다
        created = service.notify(alice, "system", "제목", "본문")
        assert len(created) == 1 and Notification.objects.count() == 1
    assert "Discord 보낼 편지함 넣기 실패" in capsys.readouterr().err

    monkeypatch.setattr(Notification.objects, "bulk_create", boom)
    assert service.notify(alice, "system", "제목", "본문") == []
    monkeypatch.setattr(service, "_recipients", boom)
    assert service.notify(alice, "system", "제목", "본문") == []
    assert "알림 받는 사람을 정하지 못함" in capsys.readouterr().err


def test_public_url_and_settings_of(alice, monkeypatch):
    assert service.public_url("/plans/3") == f"{BASE}/plans/3"
    assert service.public_url("plans/3?x=1") == f"{BASE}/plans/3?x=1"
    assert service.public_url(None) == BASE
    assert service.public_url("https://elsewhere.example/x") == "https://elsewhere.example/x"
    monkeypatch.delenv("PUBLIC_BASE_URL")
    monkeypatch.setattr(service, "_dotenv", lambda: {})
    assert service.public_url("/a") == "http://localhost:5173/a"
    setting = service.settings_of(alice)
    assert (setting.discord_user_id, setting.discord_enabled) == (None, True)
    assert service.settings_of(alice).pk == setting.pk  # 한 번만 만든다
