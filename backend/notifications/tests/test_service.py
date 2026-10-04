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


def test_notify_recipient_lookup_error_keeps_outer_transaction(webhook, alice, monkeypatch, capsys):
    from django.db import connection

    def bad_sql(users):
        with connection.cursor() as cursor:
            cursor.execute("SELECT * FROM no_such_table")

    monkeypatch.setattr(service, "_recipients", bad_sql)
    with transaction.atomic():  # PostgreSQL에서는 savepoint가 없으면 바깥 트랜잭션이 깨져 다음 쿼리가 실패한다
        assert service.notify(alice, "system", "제목", "본문") == []
        assert Notification.objects.count() == 0
    assert "알림 받는 사람을 정하지 못함" in capsys.readouterr().err


def test_notify_defuses_mentions_in_text_and_embed(webhook, alice):
    discord(alice, ALICE_ID)
    embed = {"title": "@here 급등", "description": "<@111111111111111111> 보세요",
             "fields": [{"name": "근거", "value": "@everyone <@&222> <@!333333333333333333>", "inline": True}]}
    service.notify(alice, "recommendation", "AI 추천 @everyone", "요약 <@111111111111111111> @here",
                   embed=embed)
    (m,) = OutboxMessage.objects.all()
    zw = service.ZERO_WIDTH_SPACE
    first, *rest = m.content.split("\n")
    assert first == f"<@{ALICE_ID}>"  # 우리가 붙인 멘션 줄만 울린다
    assert rest == [f"**AI 추천 @{zw}everyone**", f"요약 <@{zw}111111111111111111> @{zw}here"]
    assert m.embed["title"] == f"@{zw}here 급등" and m.embed["description"] == f"<@{zw}111111111111111111> 보세요"
    assert m.embed["fields"][0]["value"] == f"@{zw}everyone <@{zw}&222> <@{zw}!333333333333333333>"
    assert m.embed["fields"][0]["inline"] is True
    assert service.defuse("메일 a@b.com, 가격 @ 70,000") == "메일 a@b.com, 가격 @ 70,000"  # 멘션이 아니면 그대로


def test_fit_embed_respects_discord_limits():
    fields = [{"name": "n" * 300, "value": "v" * 2000, "inline": True} for _ in range(30)]
    e = service.fit_embed({"title": "t" * 300, "description": "d" * 5000, "color": 1, "fields": fields,
                           "footer": {"text": "f" * 3000}})
    assert len(e["title"]) == 256 and e["title"].endswith("…") and e["color"] == 1
    assert len(e["footer"]["text"]) == 2048
    assert len(e["fields"]) <= 25 and all(len(f["name"]) <= 256 and len(f["value"]) <= 1024 for f in e["fields"])
    total = (len(e["title"]) + len(e["description"]) + len(e["footer"]["text"])
             + sum(len(f["name"]) + len(f["value"]) for f in e["fields"]))
    assert total <= 6000 and e["description"]
    small = {"title": "삼성전자", "description": "요약", "fields": [{"name": "진입가", "value": "69,000원"}]}
    assert service.fit_embed(small) == small  # 제한 안이면 그대로


def test_notify_trims_long_embed(webhook, alice):
    service.notify(alice, "recommendation", "추천", "본문", embed={"title": "삼성전자", "description": "가" * 5000})
    (m,) = OutboxMessage.objects.all()
    assert len(m.embed["description"]) == 4096


def test_notify_with_openclaw_only_is_pending(alice, monkeypatch):
    from paper_engine.config import Config

    from config import engine
    monkeypatch.setattr(engine, "engine_config", lambda: Config(None, None, None, openclaw_target="channel:1"))
    assert not service.webhook_configured() and service.discord_configured()
    service.notify(alice, "system", "제목", "본문")
    assert OutboxMessage.objects.get().status == "pending"  # 엔진 루프가 openclaw로 보낸다
