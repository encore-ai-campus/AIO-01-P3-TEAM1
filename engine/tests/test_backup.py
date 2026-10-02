import sqlite3
from datetime import datetime, timedelta, timezone

from paper_engine.records import backup

from test_scheduler import FakeRedis

NOW = datetime(2026, 9, 29, 6, 0, tzinfo=timezone(timedelta(hours=9)))


class TypedRedis(FakeRedis):
    """백업에 쓰는 SCAN·TYPE·TTL을 더한 가짜 Redis."""

    def __init__(self):
        super().__init__()
        self.ttls = {}

    def set(self, k, v, nx=False, ex=None):
        ok = super().set(k, v, nx, ex)
        if ok and ex:
            self.ttls[k] = ex
        return ok

    def scan_keys(self, pattern):
        prefix = pattern.rstrip("*")
        return sorted(k for k in [*self.kv, *self.sets] if k.startswith(prefix))

    def type(self, k):
        return "set" if k in self.sets else "string"

    def ttl(self, k):
        return self.ttls.get(k, -1)

    def delete(self, *ks):
        for k in ks:
            self.sets.pop(k, None)
        return super().delete(*ks)


def test_backup_and_restore(tmp_path):
    db = tmp_path / "trading.db"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE t (x)")
    conn.execute("INSERT INTO t VALUES (1)")
    conn.commit()
    r = TypedRedis()
    r.set("paper:strategy:1", '{"id": 1}')
    r.set("paper:scan:s1:2026-09-29", "x", ex=100)
    r.sadd("paper:strategies", "1")
    r.set("other:key", "무시")

    lines = backup.run_backup(db, r, tmp_path / "b", NOW)
    assert lines[0].startswith("SQLite trading-20260929-060000.db") and "키 3개" in lines[1]
    copy = sqlite3.connect(tmp_path / "b" / "trading-20260929-060000.db")
    assert copy.execute("SELECT x FROM t").fetchall() == [(1,)]
    assert backup.backed_up_today(tmp_path / "b", NOW)
    assert not backup.backed_up_today(tmp_path / "b", NOW + timedelta(days=1))

    fresh = TypedRedis()
    assert backup.restore_redis(fresh, tmp_path / "b" / "redis-20260929-060000.json") == 3
    assert fresh.get("paper:strategy:1") == '{"id": 1}' and fresh.smembers("paper:strategies") == {"1"}
    assert fresh.ttls["paper:scan:s1:2026-09-29"] == 100 and "other:key" not in fresh.kv


def test_prune_keeps_recent(tmp_path):
    for day in ("20260910", "20260915", "20260929"):
        (tmp_path / f"trading-{day}-060000.db").write_text("x")
        (tmp_path / f"redis-{day}-060000.json").write_text("{}")
    assert backup.prune(tmp_path, NOW) == 2  # 14일 전(09-15)은 남긴다
    assert sorted(p.name[:17] for p in tmp_path.iterdir()) == [
        "redis-20260915-06", "redis-20260929-06", "trading-20260915-", "trading-20260929-"]


def test_restore_and_prune_touch_only_this_engines_keys_and_files(tmp_path):
    import json
    from datetime import datetime

    from paper_engine.records import backup
    from test_scheduler import FakeRedis

    r = FakeRedis()
    r.set("toss:strategy:1", "운영 중인 원본")
    path = tmp_path / "redis.json"
    path.write_text(json.dumps({"paper:strategy:1": {"type": "string", "value": "새 값"},
                                "toss:strategy:1": {"type": "string", "value": "덮어쓰면 안 됨"}}))
    assert backup.restore_redis(r, path) == 1
    assert r.get("paper:strategy:1") == "새 값" and r.get("toss:strategy:1") == "운영 중인 원본"
    for name in ("trading-20260901-060000.db", "redis-20260901-060000.json", "other-20260901-060000.db"):
        (tmp_path / name).write_text("x")
    assert backup.prune(tmp_path, datetime(2026, 10, 1)) == 2
    assert (tmp_path / "other-20260901-060000.db").exists()
