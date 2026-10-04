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


def test_tick_stops_at_time_budget(use, monkeypatch):
    fake = use(FakeWebhook())
    monkeypatch.setattr(dispatch, "TIME_BUDGET_SEC", 0)  # 메시지 하나를 보내면 예산을 넘는다
    for i in range(3):
        queue(str(i))
    logs = []
    assert dispatch.tick(NOW, logs.append) == 1
    assert len(fake.calls) == 1 and OutboxMessage.objects.filter(status="pending").count() == 2
    assert logs == ["Discord 알림 발송 시간 0초를 넘어 남은 2개는 다음 바퀴에 보냄"]
    assert dispatch.tick(NOW, print) == 1 and dispatch.tick(NOW, print) == 1
    assert OutboxMessage.objects.filter(status="sent").count() == 3


def test_tick_slow_webhook_defers_rest(use, monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(dispatch.time, "monotonic", lambda: clock[0])

    class Slow(FakeWebhook):
        def deliver(self, text, **kw):
            clock[0] += 8  # Discord가 느리다
            return super().deliver(text, **kw)

    fake = use(Slow())
    for i in range(5):
        queue(str(i))
    assert dispatch.tick(NOW, print) == 2  # 8초 + 8초 = 16초 ≥ 15초에서 멈춘다
    assert [c[0] for c in fake.calls] == ["0", "1"]


def test_tick_claims_before_sending(use):
    """다른 엔진 루프가 먼저 잡은(sending) 메시지는 보내지 않는다. 보내는 동안은 sending이다."""
    seen = []

    class Watching(FakeWebhook):
        def deliver(self, text, **kw):
            seen.append(OutboxMessage.objects.get(content=text).status)
            return super().deliver(text, **kw)

    fake = use(Watching())
    mine, taken = queue("mine"), queue("taken")
    original = OutboxMessage.objects.filter

    def racing_filter(*args, **kwargs):  # 내가 잡기 직전에 다른 루프가 taken을 잡는다
        if kwargs.get("pk") == taken.pk and kwargs.get("status") == "pending":
            OutboxMessage.objects.filter(pk=taken.pk).update(status="sending", claimed_at=NOW)
        return original(*args, **kwargs)

    with pytest.MonkeyPatch.context() as mp:
        mp.setattr(OutboxMessage.objects, "filter", racing_filter)
        assert dispatch.tick(NOW, print) == 1
    assert [c[0] for c in fake.calls] == ["mine"] and seen == ["sending"]
    mine.refresh_from_db()
    taken.refresh_from_db()
    assert (mine.status, mine.attempts, mine.claimed_at) == ("sent", 1, NOW)
    assert (taken.status, taken.attempts) == ("sending", 0)


def test_tick_releases_stale_sending(use):
    fake = use(FakeWebhook())
    dead = queue("dead", status="sending", claimed_at=NOW - timedelta(minutes=11), attempts=1)
    busy = queue("busy", status="sending", claimed_at=NOW - timedelta(minutes=5), attempts=1)
    assert dispatch.tick(NOW, print) == 1
    dead.refresh_from_db()
    busy.refresh_from_db()
    assert (dead.status, dead.attempts) == ("sent", 2) and busy.status == "sending"
    assert [c[0] for c in fake.calls] == ["dead"]
