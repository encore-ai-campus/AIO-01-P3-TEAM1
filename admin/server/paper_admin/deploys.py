"""F5 배포 기록: deploys.jsonl을 읽는다 (깨진 줄은 건너뜀)."""
from pathlib import Path

from .deploy_record import validate
from .util import iso, parse_time

LEVEL_BY_RESULT = {"rollback_failed": "down", "failed": "warn", "rolled_back": "warn", "blocked": "warn", "success": "ok"}
RESULT_TEXT = {"success": "성공", "rolled_back": "되돌림", "rollback_failed": "되돌리기 실패", "failed": "실패",
               "blocked": "검사 실패로 막힘"}


def read(path: Path) -> list[dict]:
    """기록 최신순. 시각이 같으면 파일에서 뒤에 있는 것이 최신."""
    try:
        lines = path.read_text(encoding="utf-8", errors="replace").split("\n")  # splitlines는 U+2028 등에서도 끊는다
    except OSError:
        return []
    records = []
    for n, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            rec = validate(line)
        except ValueError:
            continue
        records.append((parse_time(rec["at"]), n, rec))
    records.sort(key=lambda x: (x[0], x[1]), reverse=True)
    return [{**rec, "at": iso(at)} for at, _, rec in records]


def _server(records: list[dict]) -> dict:
    """한 서버의 기록(최신순) → DeployServer."""
    current = current_at = None
    for rec in records:
        if rec["result"] in ("failed", "blocked"):
            continue
        if rec["result"] == "success":
            current, current_at = rec["tag"], rec["at"]
        elif rec["result"] == "rolled_back":
            current, current_at = rec["previous"], rec["at"]
        else:  # rollback_failed: 지금 무엇이 도는지 알 수 없다
            current, current_at = None, rec["at"]
        break
    return {"server": records[0]["server"], "current": current, "currentAt": current_at, "last": records[0]}


def deploys(path: Path, limit: int) -> dict:
    records = read(path)
    by_server: dict[str, list[dict]] = {}
    for rec in records:
        by_server.setdefault(rec["server"], []).append(rec)
    servers = [_server(by_server[name]) for name in sorted(by_server)]
    return {"servers": servers, "records": records[:limit], "total": len(records)}


def level(data: dict) -> tuple[str, str]:
    """개요: 서버별 최신 기록 중 가장 나쁜 것."""
    if not data["servers"]:
        return "unknown", "배포 기록 없음"
    order = {"down": 0, "warn": 1, "ok": 2}
    worst = min(data["servers"], key=lambda s: order[LEVEL_BY_RESULT[s["last"]["result"]]])
    lv = LEVEL_BY_RESULT[worst["last"]["result"]]
    if lv == "ok":
        parts = [f"{s['server']} {(s['current'] or '알 수 없음')[:7]}" for s in data["servers"]]
        return "ok", "지금 버전 " + " · ".join(parts)
    last = worst["last"]
    return lv, f"{last['server']} 최근 배포 {RESULT_TEXT[last['result']]} ({last['tag'][:7]})"
