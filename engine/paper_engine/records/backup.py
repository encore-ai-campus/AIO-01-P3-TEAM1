"""백업. SQLite 기록 저장소와 Redis의 paper:* 데이터를 날짜별로 남긴다.

  data/backups/trading-YYYYMMDD-HHMMSS.db     SQLite 온라인 백업 (쓰는 중에도 일관된 사본)
  data/backups/redis-YYYYMMDD-HHMMSS.json     Redis paper:* 키 (문자열·집합, 남은 TTL 포함)

serve가 하루 한 번 만들고 KEEP_DAYS보다 오래된 백업은 지운다. 위치는 .env의 BACKUP_DIR로 바꿀 수 있다
(다른 디스크에 두는 것을 권장). 복원:
  SQLite: serve를 멈추고 백업 파일을 data/trading.db로 복사
  Redis:  python -m paper_engine backup --restore-redis <파일>  (같은 키는 덮어쓴다)
"""
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path

from .redis_client import Redis

KEEP_DAYS = 14
REDIS_PATTERN = "paper:*"


def backup_sqlite(db_path: Path, out_dir: Path, stamp: str) -> Path:
    out = out_dir / f"trading-{stamp}.db"
    src = sqlite3.connect(db_path)
    dst = sqlite3.connect(out)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return out


def export_redis(redis: Redis, out_dir: Path, stamp: str) -> tuple[Path, int]:
    data = {}
    for key in redis.scan_keys(REDIS_PATTERN):
        kind = redis.type(key)
        if kind == "string":
            value = redis.get(key)
        elif kind == "set":
            value = sorted(redis.smembers(key))
        else:
            continue  # 쓰지 않는 형식
        data[key] = {"type": kind, "value": value, "ttl": redis.ttl(key)}
    out = out_dir / f"redis-{stamp}.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1))
    return out, len(data)


def restore_redis(redis: Redis, path: Path) -> int:
    """백업 JSON의 paper:* 키만 복원한다. 다른 접두사의 키(원본 서비스 등)는 건너뛰어 같은 Redis를 쓰는
    다른 서비스의 키를 덮어쓰지 않는다."""
    data = json.loads(path.read_text())
    data = {k: v for k, v in data.items() if k.startswith(REDIS_PATTERN.rstrip("*"))}
    for key, item in data.items():
        redis.delete(key)
        if item["type"] == "string":
            ttl = item.get("ttl", -1)
            redis.set(key, item["value"], ex=ttl if ttl and ttl > 0 else None)
        else:
            for member in item["value"]:
                redis.sadd(key, member)
    return len(data)


def run_backup(db_path: Path, redis: Redis | None, out_dir: Path, now: datetime) -> list[str]:
    """백업을 만들고 오래된 백업을 지운다. 만든 내용을 한 줄씩 돌려준다."""
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = f"{now:%Y%m%d-%H%M%S}"
    lines = []
    db = backup_sqlite(db_path, out_dir, stamp)
    lines.append(f"SQLite {db.name} ({db.stat().st_size:,} bytes)")
    if redis:
        path, count = export_redis(redis, out_dir, stamp)
        lines.append(f"Redis {path.name} (키 {count}개)")
    removed = prune(out_dir, now)
    if removed:
        lines.append(f"{KEEP_DAYS}일 지난 백업 {removed}개 삭제")
    return lines


def prune(out_dir: Path, now: datetime) -> int:
    cutoff = f"{now - timedelta(days=KEEP_DAYS):%Y%m%d}"
    removed = 0
    # 이 엔진이 만든 백업만 지운다 (같은 폴더에 다른 서비스의 백업이 있어도 건드리지 않는다)
    paths = [*out_dir.glob("trading-????????-??????.db"), *out_dir.glob("redis-????????-??????.json")]
    for path in paths:
        day = path.stem.rsplit("-", 2)[-2]
        if day < cutoff:
            path.unlink()
            removed += 1
    return removed


def backed_up_today(out_dir: Path, now: datetime) -> bool:
    return any(out_dir.glob(f"trading-{now:%Y%m%d}-*.db"))
