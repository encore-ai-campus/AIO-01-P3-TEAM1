"""배포 기록 한 줄 받기 (API.md 5-2). 표준 라이브러리만 쓴다.

관리 서버 호스트의 authorized_keys 강제 명령: `python3 deploy_record.py <deploys.jsonl 경로>`.
표준 입력의 JSON 한 줄을 검사해 잠그고(fcntl.flock) 파일 끝에 더한다. 틀리면 쓰지 않고 종료 코드 1.
"""
import fcntl
import json
import os
import re
import sys
from datetime import datetime

MAX_LINE = 4096
MAX_TEXT = 300
RESULTS = ("success", "rolled_back", "rollback_failed", "failed", "blocked")
SERVER = re.compile(r"[a-z0-9-]{1,32}")
TAG = re.compile(r"[0-9A-Za-z._-]{1,64}")
KEYS = ("at", "server", "tag", "previous", "result", "actor", "commit", "runUrl")


def _text(data: dict, key: str, required: bool = False) -> str | None:
    value = data.get(key)
    if value is None:
        if required:
            raise ValueError(f"{key} 없음")
        return None
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise ValueError(f"{key} 형식이 틀림")
    return value


def validate(line: str) -> dict:
    """JSON 한 줄 → 정리한 기록. 틀리면 ValueError (짧은 사유)."""
    if len(line.encode("utf-8")) > MAX_LINE:
        raise ValueError("4KB 초과")
    try:
        data = json.loads(line)
    except ValueError:
        raise ValueError("JSON이 아님") from None
    if not isinstance(data, dict):
        raise ValueError("JSON 객체가 아님")
    record = {key: _text(data, key, required=key in ("at", "server", "tag", "result")) for key in KEYS}
    try:
        at = datetime.fromisoformat(record["at"].replace("Z", "+00:00"))
    except ValueError:
        raise ValueError("at 형식이 틀림") from None
    if at.tzinfo is None:
        raise ValueError("at에 시간대가 없음")
    if not SERVER.fullmatch(record["server"]):
        raise ValueError("server 형식이 틀림")
    for key in ("tag", "previous"):
        if record[key] is not None and not TAG.fullmatch(record[key]):
            raise ValueError(f"{key} 형식이 틀림")
    if record["result"] not in RESULTS:
        raise ValueError("result 값이 틀림")
    return record


def append(path: str, record: dict) -> None:
    line = json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n"
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o640)
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        try:
            f.write(line)
            f.flush()
            os.fsync(f.fileno())
        finally:
            fcntl.flock(f, fcntl.LOCK_UN)


def main(argv: list[str], stdin=None) -> int:
    if len(argv) != 2:
        print("사용법: deploy_record.py <deploys.jsonl 경로>", file=sys.stderr)
        return 1
    stdin = stdin if stdin is not None else sys.stdin
    raw = stdin.read(MAX_LINE * 2)
    line = raw.strip("\r\n")
    try:
        if "\n" in line:
            raise ValueError("한 줄이 아님")
        record = validate(line)
    except ValueError as e:
        print(f"거부: {e}", file=sys.stderr)
        return 1
    append(argv[1], record)
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
