"""팀 채널 알림: openclaw message send로 알림·파일만 보낸다 (명령·컨펌 없음). openclaw는 실행하지 않는다."""
import subprocess

from paper_engine.notify import (DISCORD_MAX_LEN, ConsoleNotifier, Notifier, OpenclawNotifier, make_notifier,
                                 split_message)

TARGET = "channel:999"


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
    for n in (ConsoleNotifier(), OpenclawNotifier(TARGET, run=Runner())):
        assert not hasattr(n, "confirm") and not hasattr(n, "ask")
    assert {"send", "log", "send_file"} <= set(dir(Notifier))


def test_make_notifier_falls_back_to_console(capsys):
    assert isinstance(make_notifier(None), ConsoleNotifier)
    n = make_notifier(TARGET, "oc")
    assert isinstance(n, OpenclawNotifier) and n._bin == "oc" and n._target == TARGET
    ConsoleNotifier().send_file("x.pdf", "요약")
    assert capsys.readouterr().out == "요약\n첨부: x.pdf\n"
