"""팀 채널 알림: Discord Webhook 또는 openclaw로 알림·파일만 보낸다 (명령·컨펌 없음).

openclaw는 실행하지 않고, Webhook은 가짜 urlopen으로 받는다 (실제 Discord로 보내지 않는다).
"""
import email.message
import io
import json
import subprocess
import urllib.error

from paper_engine.config import Config
from paper_engine.notify import (DISCORD_FILE_LIMIT, DISCORD_MAX_LEN, WEBHOOK_USER_AGENT, ConsoleNotifier,
                                 DeliveryResult, Notifier, OpenclawNotifier, WebhookNotifier, make_notifier,
                                 split_message)

TARGET = "channel:999"
WEBHOOK = "https://discord.com/api/webhooks/123456/secret-token-abc"


def test_split_message_keeps_lines_under_limit():
    text = "\n".join(["a" * 900] * 5)
    chunks = split_message(text)
    assert [len(c) for c in chunks] == [1801, 1801, 900]
    assert "\n".join(chunks) == text


def test_split_message_cuts_long_line_and_drops_blank_edges():
    chunks = split_message("\n" + "x" * (DISCORD_MAX_LEN + 5) + "\nend\n")
    assert chunks == ["x" * DISCORD_MAX_LEN, "xxxxx\nend"]
    assert split_message("\n") == []


class Runner:
    def __init__(self, returncode=0, error=None):
        self.calls, self.returncode, self.error = [], returncode, error

    def __call__(self, args, **kw):
        self.calls.append(args)
        if self.error:
            raise self.error
        return subprocess.CompletedProcess(args, self.returncode, "", "gateway down")


def test_send_uses_openclaw_per_chunk_to_team_channel():
    run = Runner()
    OpenclawNotifier(TARGET, "/opt/openclaw", run=run).send("\n" + "\n".join(["a" * 1500] * 2))
    assert len(run.calls) == 2
    assert run.calls[0][:7] == ["/opt/openclaw", "message", "send", "--channel", "discord", "--target", TARGET]
    assert run.calls[0][-1] == "--json" and run.calls[0][run.calls[0].index("--message") + 1] == "a" * 1500


def test_send_failure_does_not_raise(capsys):
    OpenclawNotifier(TARGET, run=Runner(returncode=1)).send("hello")
    assert "gateway down" in capsys.readouterr().err
    OpenclawNotifier(TARGET, run=Runner(error=FileNotFoundError("openclaw"))).send("hello")
    assert "openclaw 실행 실패" in capsys.readouterr().err
    OpenclawNotifier(TARGET, run=Runner(error=subprocess.TimeoutExpired("openclaw", 60))).send("hello")
    assert "openclaw 실행 실패" in capsys.readouterr().err


def test_send_file_attaches_media_and_reports_failure(tmp_path, capsys):
    run = Runner()
    n = OpenclawNotifier(TARGET, run=run)
    n.send_file(tmp_path / "r.pdf", "요약")
    assert run.calls[0][run.calls[0].index("--media") + 1] == str(tmp_path / "r.pdf")
    assert run.calls[0][run.calls[0].index("--message") + 1] == "요약"
    n.log("상세")
    assert len(run.calls) == 1 and "상세" in capsys.readouterr().out  # log는 보내지 않는다

    run = Runner(returncode=1)
    OpenclawNotifier(TARGET, run=run).send_file(tmp_path / "r.pdf", "요약")
    assert "--media" in run.calls[0] and "--media" not in run.calls[1]
    assert "파일 전송 실패. 위치:" in run.calls[1][run.calls[1].index("--message") + 1]


def test_notifier_has_no_confirm_or_ask():
    for n in (ConsoleNotifier(), OpenclawNotifier(TARGET, run=Runner()), WebhookNotifier(WEBHOOK)):
        assert not hasattr(n, "confirm") and not hasattr(n, "ask")
    assert {"send", "log", "send_file"} <= set(dir(Notifier))


def test_make_notifier_is_console_while_discord_disabled(capsys):
    """2026-10-08 Discord 알림을 껐다 (docs/DECISIONS.md 24장): Webhook·openclaw 설정이 있어도 콘솔.

    다시 켜면 예전 기대값으로 되돌린다: openclaw만 있으면 OpenclawNotifier(_bin "oc", _target TARGET),
    Webhook이 있으면 WebhookNotifier(_url WEBHOOK)가 먼저.
    """
    base = Config("key", "secret", None)
    assert isinstance(make_notifier(base), ConsoleNotifier)
    n = make_notifier(Config("key", "secret", None, openclaw_target=TARGET, openclaw_bin="oc"))
    assert isinstance(n, ConsoleNotifier)
    n = make_notifier(Config("key", "secret", None, openclaw_target=TARGET, discord_webhook_url=WEBHOOK))
    assert isinstance(n, ConsoleNotifier)
    assert "secret-token" not in repr(n) and "secret-token" not in repr(
        Config("key", "secret", None, discord_webhook_url=WEBHOOK))  # 비밀 값은 repr에 나오지 않는다
    ConsoleNotifier().send_file("x.pdf", "요약")
    assert capsys.readouterr().out == "요약\n첨부: x.pdf\n"


# --- Discord Webhook ---

class Response:
    def __init__(self):
        self.closed = False

    def read(self):
        return b""

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.closed = True


def http_error(code: int, headers: dict | None = None, body: bytes = b"") -> urllib.error.HTTPError:
    msg = email.message.Message()
    for key, value in (headers or {}).items():
        msg[key] = value
    return urllib.error.HTTPError(WEBHOOK, code, "error", msg, io.BytesIO(body))


class Opener:
    """가짜 urlopen. outcomes를 차례로 쓴다 (예외면 던지고, 없으면 성공)."""

    def __init__(self, *outcomes):
        self.outcomes, self.requests, self.timeouts = list(outcomes), [], []

    def __call__(self, request, timeout=None):
        self.requests.append(request)
        self.timeouts.append(timeout)
        outcome = self.outcomes.pop(0) if self.outcomes else None
        if isinstance(outcome, BaseException):
            raise outcome
        return Response()

    def payloads(self) -> list[dict]:
        return [payload_of(r) for r in self.requests]


def payload_of(request) -> dict:
    """JSON 본문이나 multipart의 payload_json을 읽는다."""
    body, kind = request.data, request.get_header("Content-type")
    if kind == "application/json":
        return json.loads(body)
    boundary = kind.split("boundary=")[1].encode()
    part = body.split(b"--" + boundary)[1]
    return json.loads(part.split(b"\r\n\r\n", 1)[1].rsplit(b"\r\n", 1)[0])


def webhook(opener, sleeps=None):
    return WebhookNotifier(WEBHOOK, urlopen=opener, timeout=3,
                           sleep=(sleeps.append if sleeps is not None else lambda s: None))


def test_webhook_posts_json_with_user_mentions_only():
    opener = Opener()
    result = webhook(opener).deliver("<@123456789012345678> 체결", embeds=[{"title": "삼성전자"}])
    assert result == DeliveryResult(True, False, None)
    (request,) = opener.requests
    assert request.full_url == WEBHOOK and request.get_method() == "POST"
    assert request.get_header("User-agent") == WEBHOOK_USER_AGENT and opener.timeouts == [3]
    assert json.loads(request.data) == {"content": "<@123456789012345678> 체결", "embeds": [{"title": "삼성전자"}],
                                        "allowed_mentions": {"parse": ["users"]}}


def test_webhook_splits_long_text_and_puts_embed_and_file_on_last_chunk(tmp_path):
    report = tmp_path / "r.pdf"
    report.write_bytes(b"%PDF-1.4 data")
    opener = Opener()
    text = "\n".join(["a" * 1500] * 3)
    result = webhook(opener).deliver(text, path=report, embeds=[{"title": "t"}])
    assert result == DeliveryResult(True, True, None)
    assert [p["content"] for p in opener.payloads()] == ["a" * 1500] * 3
    assert [r.get_header("Content-type") for r in opener.requests[:2]] == ["application/json"] * 2
    assert "embeds" not in opener.payloads()[0] and opener.payloads()[2]["embeds"] == [{"title": "t"}]
    last = opener.requests[2]
    assert last.get_header("Content-type").startswith("multipart/form-data; boundary=")
    assert b'name="files[0]"; filename="r.pdf"' in last.data and b"%PDF-1.4 data" in last.data
    assert b"Content-Type: application/pdf" in last.data
    assert opener.payloads()[2]["attachments"] == [{"id": 0, "filename": "r.pdf"}]
    assert opener.payloads()[2]["allowed_mentions"] == {"parse": ["users"]}


def test_webhook_sends_text_only_when_file_is_too_big(tmp_path):
    big = tmp_path / "big.pdf"
    with big.open("wb") as f:
        f.truncate(DISCORD_FILE_LIMIT + 1)
    opener = Opener()
    result = webhook(opener).deliver("리포트", path=big)
    assert result == DeliveryResult(True, False, None)
    (request,) = opener.requests
    assert request.get_header("Content-type") == "application/json"
    assert json.loads(request.data)["content"] == "리포트\n(첨부 생략: big.pdf, 8MB 초과)"


def test_webhook_retries_once_then_text_only_then_fails(tmp_path):
    report = tmp_path / "r.pdf"
    report.write_bytes(b"pdf")
    sleeps = []
    opener = Opener(http_error(500), http_error(502))  # 첨부 두 번 실패 → 글만 성공
    result = webhook(opener, sleeps).deliver("요약", path=report)
    assert result == DeliveryResult(True, False, None)
    kinds = [r.get_header("Content-type").split(";")[0] for r in opener.requests]
    assert kinds == ["multipart/form-data", "multipart/form-data", "application/json"]
    assert opener.payloads()[2]["content"] == "요약\n(첨부 전송 실패: r.pdf)" and sleeps == [1]

    opener = Opener(http_error(404), http_error(404), http_error(404))
    result = webhook(opener).deliver("요약", path=report)
    assert result == DeliveryResult(False, False, "HTTP 404") and len(opener.requests) == 3

    opener = Opener(urllib.error.URLError(TimeoutError("timed out")), None)  # 글만: 실패 → 재시도 성공
    assert webhook(opener).deliver("글").ok and len(opener.requests) == 2

    opener = Opener(TimeoutError(), urllib.error.URLError(OSError("connection refused")))
    result = webhook(opener).deliver("글")
    assert result.ok is False and result.error == "연결 실패: connection refused" and len(opener.requests) == 2


def test_webhook_waits_retry_after_on_429_up_to_5_seconds():
    sleeps = []
    opener = Opener(http_error(429, {"Retry-After": "2.5"}), None)
    assert webhook(opener, sleeps).deliver("글").ok and sleeps == [2.5]
    sleeps = []
    opener = Opener(http_error(429, body=b'{"retry_after": 60}'), http_error(429))
    result = webhook(opener, sleeps).deliver("글")
    assert result == DeliveryResult(False, False, "HTTP 429") and sleeps == [5] and len(opener.requests) == 2


def test_webhook_errors_never_contain_the_url(tmp_path, capsys):
    opener = Opener(urllib.error.URLError(f"cannot reach {WEBHOOK}"), urllib.error.URLError(f"cannot reach {WEBHOOK}"))
    result = webhook(opener).deliver("글")
    assert result == DeliveryResult(False, False, "연결 실패: cannot reach <webhook>")
    opener = Opener(OSError("boom /api/webhooks/123456/secret-token-abc?wait=true"),
                    OSError("boom /api/webhooks/123456/secret-token-abc?wait=true"))
    result = webhook(opener).deliver("글")
    assert result.ok is False and "secret-token" not in result.error and "/api/webhooks/<비밀 값>" in result.error
    broken = webhook(lambda request, timeout=None: (_ for _ in ()).throw(ValueError(WEBHOOK)))
    result = broken.deliver("글")  # 예상하지 못한 예외도 밖으로 내지 않고 주소를 지운다
    assert result.ok is False and "secret-token" not in result.error

    n = webhook(Opener(http_error(403), http_error(403), http_error(403)))
    n.send("hello")
    n.send_file(tmp_path / "없는파일.pdf", "요약")  # 파일이 없으면 글만
    out = capsys.readouterr()
    assert "hello" in out.out and "[Webhook 전송 실패] HTTP 403" in out.err and "secret-token" not in out.out + out.err


def test_webhook_log_and_send_file_console(tmp_path, capsys):
    opener = Opener()
    n = webhook(opener)
    n.log("상세")
    assert opener.requests == [] and "상세" in capsys.readouterr().out  # log는 보내지 않는다
    report = tmp_path / "r.html"
    report.write_text("<html>")
    n.send_file(report, "요약")
    assert payload_of(opener.requests[0])["content"] == "요약" and b'filename="r.html"' in opener.requests[0].data
    assert f"첨부: {report}" in capsys.readouterr().out
    n.send_file(report, "")  # 캡션이 없어도 첨부만 보낸다
    assert "content" not in payload_of(opener.requests[1])


# --- 보유 기간 이름 (모르는 값은 그대로) ---

def test_horizon_labels_fall_back_to_raw_value():
    from paper_engine.judge.risk import AccountContext, assess
    from paper_engine.judge.scenario import Scenario
    from paper_engine.notify import HORIZON_LABEL, format_report, horizon_label

    assert HORIZON_LABEL == {"SWING": "스윙", "LONG_TERM": "장기"}
    assert horizon_label("LONG_TERM") == "장기" and horizon_label("WEEKLY") == "WEEKLY"
    s = Scenario(symbol="005930", currency="KRW", horizon="LONG_TERM", entry_price=100_000, target_price=104_000,
                 stop_price=98_000, probability=0.5, holding_days=1)
    text = format_report(s, assess(s, AccountContext(equity_krw=10_000_000, buying_power=10_000_000,
                                                     commission_rate=0.0)), "삼성전자")
    assert "삼성전자 (005930) 장기 매수" in text
