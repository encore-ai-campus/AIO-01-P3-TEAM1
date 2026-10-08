"""notifications 테스트 공용: 엔진 설정(Webhook 있음·없음), 사용자, 가짜 notifier. 실제 Discord로 보내지 않는다."""
import pytest
from paper_engine.config import Config
from paper_engine.notify import WebhookNotifier

from config import engine

WEBHOOK = "https://discord.com/api/webhooks/987654321/super-secret-token"
SECRET = "super-secret-token"
BASE = "https://paper.example.com"


@pytest.fixture(autouse=True)
def public_base(monkeypatch):
    monkeypatch.setenv("PUBLIC_BASE_URL", BASE + "/")


@pytest.fixture(autouse=True)
def config(monkeypatch):
    """엔진 설정. 기본은 Webhook 없음. set_webhook(WEBHOOK)으로 바꾼다.

    Discord 알림을 끈 동안(docs/DECISIONS.md 24장) make_notifier는 늘 콘솔이므로, 보내는 경로(편지함·발송)를 계속 시험하려고
    set_webhook은 Webhook 연결을 engine.notifier에 직접 끼운다. 끈 상태 자체는 test_service·test_notifications_api의 "disabled" 테스트가 본다.
    """
    state = {"cfg": Config(None, None, None)}
    monkeypatch.setattr(engine, "engine_config", lambda: state["cfg"])

    def set_webhook(url):
        state["cfg"] = Config(None, None, None, discord_webhook_url=url)
        monkeypatch.setattr(engine, "notifier", lambda: WebhookNotifier(url))
    return set_webhook


@pytest.fixture
def webhook(config):
    config(WEBHOOK)


@pytest.fixture
def make_user(django_user_model):
    def make(username, **kw):
        return django_user_model.objects.create_user(username=username, password="x", **kw)
    return make


@pytest.fixture
def alice(make_user):
    return make_user("alice")


@pytest.fixture
def bob(make_user):
    return make_user("bob")
