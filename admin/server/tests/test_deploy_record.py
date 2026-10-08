"""배포 기록 한 줄 받기 (API.md 5-2): 표준 입력 → 검사 → 파일 끝에 더하기."""
import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

from paper_admin import deploy_record

SCRIPT = Path(deploy_record.__file__)
GOOD = {"at": "2026-10-08T12:00:00+00:00", "server": "app", "tag": "500d087", "previous": "75d4b7e",
        "result": "success", "actor": "hwanseok", "commit": "PDF 버튼 고침", "runUrl": "https://github.com/o/r/actions/runs/1"}


def run(path: Path, payload) -> int:
    line = payload if isinstance(payload, str) else json.dumps(payload, ensure_ascii=False)
    return deploy_record.main(["deploy_record.py", str(path)], io.StringIO(line + "\n"))


def test_appends_one_line(tmp_path):
    path = tmp_path / "deploys.jsonl"
    assert run(path, GOOD) == 0
    assert run(path, {**GOOD, "tag": "v2", "previous": None, "result": "rolled_back"}) == 0
    lines = [json.loads(x) for x in path.read_text().splitlines()]
    assert lines[0] == GOOD and lines[1]["previous"] is None and len(lines) == 2


def test_unknown_keys_dropped(tmp_path):
    path = tmp_path / "deploys.jsonl"
    assert run(path, {**GOOD, "secret": "x", "extra": 1}) == 0
    assert set(json.loads(path.read_text())) == set(GOOD)


@pytest.mark.parametrize("bad", [
    {k: v for k, v in GOOD.items() if k != "tag"},
    {k: v for k, v in GOOD.items() if k != "at"},
    {**GOOD, "result": "ok"},
    {**GOOD, "server": "App_1"},
    {**GOOD, "server": "a" * 33},
    {**GOOD, "tag": "v1;rm -rf"},
    {**GOOD, "tag": "a" * 65},
    {**GOOD, "previous": "../x/y"},
    {**GOOD, "at": "yesterday"},
    {**GOOD, "at": "2026-10-08T12:00:00"},
    {**GOOD, "actor": 5},
    {**GOOD, "commit": "c" * 301},
    {**GOOD, "commit": "c" * 4100},
    "not json",
    "[1, 2]",
])
def test_rejects_bad(tmp_path, bad):
    path = tmp_path / "deploys.jsonl"
    assert run(path, bad) == 1
    assert not path.exists()


def test_rejects_two_lines(tmp_path):
    path = tmp_path / "deploys.jsonl"
    two = json.dumps(GOOD) + "\n" + json.dumps(GOOD)
    assert run(path, two) == 1 and not path.exists()


def test_standalone_script(tmp_path):
    """강제 명령처럼 패키지 밖에서 python3 스크립트로 돈다 (표준 라이브러리만)."""
    path = tmp_path / "deploys.jsonl"
    ok = subprocess.run([sys.executable, "-I", str(SCRIPT), str(path)], input=json.dumps(GOOD), text=True,
                        capture_output=True, cwd=tmp_path)
    assert ok.returncode == 0 and path.read_text().count("\n") == 1
    bad = subprocess.run([sys.executable, "-I", str(SCRIPT), str(path)], input="{}", text=True, capture_output=True,
                         cwd=tmp_path)
    assert bad.returncode == 1 and bad.stderr.startswith("거부")


def test_line_separator_in_commit_does_not_split_record(tmp_path):
    """커밋 제목의 U+2028(줄 구분 문자)이 기록을 두 줄로 쪼개지 않는다."""
    from paper_admin import deploys

    path = tmp_path / "deploys.jsonl"
    line = json.dumps({"at": "2026-10-08T01:00:00+00:00", "server": "app", "tag": "abc1234", "result": "success",
                       "commit": "제목\u2028둘째 줄"}, ensure_ascii=False)
    assert run(path, line) == 0
    records = deploys.read(path)
    assert len(records) == 1 and records[0]["commit"] == "제목\u2028둘째 줄"
