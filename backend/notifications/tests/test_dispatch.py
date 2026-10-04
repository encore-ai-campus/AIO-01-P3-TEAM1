"""dispatch.tick: 보낼 편지함의 pending 메시지를 Discord로 보낸다 (가짜 notifier·가짜 urlopen)."""
import urllib.error
from datetime import datetime, timedelta, timezone

import pytest
from paper_engine.notify import ConsoleNotifier, DeliveryResult, WebhookNotifier

from config import engine
from notifications import dispatch
from notifications.models import OutboxMessage

from .conftest import SECRET, WEBHOOK

pytestmark = pytest.mark.django_db

NOW = datetime(2026, 10, 5, 1, 0, tzinfo=timezone.utc)


class FakeWebhook:
    def __init__(self, *results):
        self.results, self.calls = list(results), []

    def deliver(self, text, *, path=None, embeds=None):
        self.calls.append((text, path, embeds))
        result = self.results.pop(0) if self.results else DeliveryResult(True, path is not None)
        if isinstance(result, BaseException):
            raise result
        return result


class FakeOpenclaw:
    def __init__(self):
        self.sent, self.files = [], []

    def send(self, text):
        self.sent.append(text)

    def log(self, text):
        pass

    def send_file(self, path, caption=""):
        self.files.append((path, caption))


@pytest.fixture
def use(monkeypatch):
    def install(notifier):
        monkeypatch.setattr(engine, "notifier", lambda: notifier)
        return notifier
    return install


def queue(content="**제목**", **kw) -> OutboxMessage:
    return OutboxMessage.objects.create(kind="system", content=content, **kw)


def test_tick_marks_sent_and_passes_embed(use):
    fake = use(FakeWebhook())
    m = queue(embed={"title": "삼성전자"})
    assert dispatch.tick(NOW, print) == 1
    m.refresh_from_db()
    assert (m.status, m.attempts, m.sent_at, m.last_error) == ("sent", 1, NOW, None)
    assert fake.calls == [("**제목**", None, [{"title": "삼성전자"}])]
    assert dispatch.tick(NOW, print) == 0  # 보낸 것은 다시 보내지 않는다


def test_tick_records_failure_and_logs(use):
    use(FakeWebhook(DeliveryResult(False, False, "HTTP 404")))
    m = queue()
    logs = []
    dispatch.tick(NOW, logs.append)
    m.refresh_from_db()
    assert (m.status, m.attempts, m.sent_at, m.last_error) == ("failed", 1, None, "HTTP 404")
    assert logs == [f"Discord 알림 #{m.id} 보내기 실패: HTTP 404"]


def test_tick_attachment_fallback_to_text_only(use, tmp_path):
    fake = use(FakeWebhook(DeliveryResult(True, False, None)))
    m = queue(file_path=str(tmp_path / "r.pdf"))
    dispatch.tick(NOW, print)
    m.refresh_from_db()
    assert m.status == "sent" and m.last_error == "첨부 없이 글만 보냄"
    assert fake.calls[0][1] == str(tmp_path / "r.pdf")


def test_tick_with_real_webhook_keeps_secret_out_of_db(use, webhook):
    """실제 WebhookNotifier + 가짜 urlopen: 재시도·실패, last_error에 주소가 없다."""
    calls = []

    def urlopen(request, timeout=None):
        calls.append(request)
        raise urllib.error.URLError(f"failed to reach {WEBHOOK}")

    use(WebhookNotifier(WEBHOOK, urlopen=urlopen, sleep=lambda s: None))
    m = queue()
    dispatch.tick(NOW, print)
    m.refresh_from_db()
    assert m.status == "failed" and len(calls) == 2
    assert SECRET not in m.last_error and m.last_error.startswith("연결 실패")


def test_tick_one_error_does_not_block_others(use, webhook):
    fake = use(FakeWebhook(RuntimeError(f"boom {WEBHOOK}"), DeliveryResult(True, False, None)))
    first, second = queue("1"), queue("2")
    assert dispatch.tick(NOW, print) == 2
    first.refresh_from_db()
    second.refresh_from_db()
    assert first.status == "failed" and SECRET not in first.last_error and "RuntimeError" in first.last_error
    assert second.status == "sent" and len(fake.calls) == 2


def test_tick_console_is_skipped_and_openclaw_is_sent(use, tmp_path, capsys):
    use(ConsoleNotifier())
    m = queue("콘솔 내용")
    dispatch.tick(NOW, print)
    m.refresh_from_db()
    assert m.status == "skipped" and m.sent_at is None and m.attempts == 1 and "콘솔 내용" in capsys.readouterr().out

    oc = use(FakeOpenclaw())
    text, report = queue("글"), queue("첨부", file_path=str(tmp_path / "r.pdf"))
    dispatch.tick(NOW, print)
    text.refresh_from_db()
    report.refresh_from_db()
    assert (text.status, text.sent_at, report.status) == ("sent", NOW, "sent")
    assert oc.sent == ["글"] and oc.files == [(tmp_path / "r.pdf", "첨부")]


def test_tick_sends_oldest_first_at_most_20(use):
    fake = use(FakeWebhook())
    base = datetime(2026, 10, 5, tzinfo=timezone.utc)
    for i in range(25):
        queue(str(i), created_at=base - timedelta(minutes=i))  # 뒤에 넣은 것이 더 오래됐다
    assert dispatch.tick(NOW, print) == 20
    assert [c[0] for c in fake.calls] == [str(i) for i in range(24, 4, -1)]
    assert OutboxMessage.objects.filter(status="pending").count() == 5
    assert dispatch.tick(NOW, print) == 5


def test_tick_without_pending_does_not_build_notifier(monkeypatch):
    monkeypatch.setattr(engine, "notifier", lambda: pytest.fail("만들면 안 된다"))
    queue(status="sent")
    assert dispatch.tick(NOW, print) == 0
