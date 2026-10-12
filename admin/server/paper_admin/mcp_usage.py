"""F10 MCP 도구·호출 기록 (API.md 6장): 도구 목록 + 토큰 목록 + 감사 기록(audit.jsonl)의 토큰 요청.

토큰 원문·해시는 내지 않는다. 감사 기록은 파일 끝 4MB까지만 읽는다.
"""
import json
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

from . import mcp_tools
from .auth import TokenStore
from .util import iso, parse_time

TAIL_BYTES = 4 * 1024 * 1024
ENDPOINT = "/mcp"


def read_token_requests(path: Path, tail_bytes: int = TAIL_BYTES) -> list[dict]:
    """감사 기록에서 토큰 요청(via token, event request)만, 오래된 것부터. 깨진 줄은 건너뛴다."""
    try:
        with path.open("rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - tail_bytes))
            raw = f.read()
    except OSError:
        return []
    lines = raw.split(b"\n")
    if size > tail_bytes:
        lines = lines[1:]  # 잘린 첫 줄
    found = []
    for line in lines:
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if not isinstance(rec, dict) or rec.get("via") != "token" or rec.get("event") != "request":
            continue
        at = parse_time(rec.get("at"))
        status = rec.get("status")
        if at is None or not isinstance(status, int) or isinstance(status, bool):
            continue
        who, tool, req_path = rec.get("who"), rec.get("tool"), rec.get("path")
        found.append({"at": at, "who": who if isinstance(who, str) else None,
                      "tool": tool if isinstance(tool, str) and tool else None,
                      "path": req_path[:300] if isinstance(req_path, str) else "", "status": status})
    found.sort(key=lambda r: r["at"])
    return found


def status(tokens: TokenStore, audit_path: Path, now: datetime, hours: int, limit: int) -> dict:
    requests = read_token_requests(audit_path)
    since = now - timedelta(hours=hours)
    recent = [r for r in requests if r["at"] >= since]
    tool_calls = [r for r in recent if r["tool"]]

    last_used: dict[str, datetime] = {}
    for r in requests:
        if r["who"]:
            last_used[r["who"]] = r["at"]  # 오래된 것부터라 마지막 값이 가장 최근
    calls, errors = Counter(), Counter()
    for r in tool_calls:
        if r["who"]:
            calls[r["who"]] += 1
            errors[r["who"]] += r["status"] >= 400
    token_rows = [{"name": t["name"], "createdAt": iso(parse_time(t.get("createdAt"))),
                   "lastUsedAt": iso(last_used.get(t["name"])), "calls": calls[t["name"]], "errors": errors[t["name"]]}
                  for t in sorted(tokens.load(), key=lambda t: str(t["name"]))]

    by_calls, by_errors = Counter(), Counter()
    for r in tool_calls:
        by_calls[r["tool"]] += 1
        by_errors[r["tool"]] += r["status"] >= 400
    by_tool = [{"tool": k, "calls": by_calls[k], "errors": by_errors[k]}
               for k in sorted(by_calls, key=lambda k: (-by_calls[k], k))]

    return {
        "endpoint": ENDPOINT, "hours": hours,
        "tools": [t.as_dict() for t in mcp_tools.TOOLS],
        "tokens": token_rows,
        "summary": {"calls": len(tool_calls), "errors": sum(1 for r in tool_calls if r["status"] >= 400),
                    "invalid": sum(1 for r in recent if r["who"] is None), "byTool": by_tool},
        "calls": [{"at": iso(r["at"]), "who": r["who"], "tool": r["tool"], "path": r["path"], "status": r["status"],
                   "ok": r["status"] < 400} for r in reversed(recent)][:limit],
    }
