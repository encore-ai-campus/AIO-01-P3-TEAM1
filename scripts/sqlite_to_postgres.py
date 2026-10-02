"""로컬 SQLite(backend/db.sqlite3)의 데이터를 지금 설정된 PostgreSQL로 옮긴다 (한 번만 하는 작업).

    scripts/dev.sh import-sqlite          # 권장: DB 컨테이너를 띄우고 마이그레이션까지 한 뒤 이 스크립트를 돌린다
    cd backend && uv run python ../scripts/sqlite_to_postgres.py [--force]

- 대상은 .env의 POSTGRES_* 설정이 가리키는 PostgreSQL이다. 표는 미리 만들어져 있어야 한다 (manage.py migrate).
- 계정(비밀번호 해시 포함), 프로필, 모의 계좌·주문·체결·예약·일별 자산, 분석 색인·작업, 리포트·Trace를 옮긴다.
  로그인 세션, 관리자 화면 기록, 권한·콘텐츠 유형 표(마이그레이션이 다시 만든다)는 옮기지 않는다.
- 대상에 이미 계정이 있으면 멈춘다. --force를 주면 대상의 데이터를 지우고 다시 옮긴다.
- SQLite 파일은 그대로 둔다 (지우지 않는다).
"""
import os
import sys
import tempfile
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1] / "backend"
sys.path.insert(0, str(BACKEND))
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "config.settings")

from django.conf import settings  # noqa: E402

SOURCE = BACKEND / "db.sqlite3"
# 연결을 만들기 전에 원본 SQLite를 두 번째 DB로 더한다
settings.DATABASES["sqlite"] = {"ENGINE": "django.db.backends.sqlite3", "NAME": SOURCE}

import django  # noqa: E402

django.setup()

from django.apps import apps  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.db import connections  # noqa: E402

EXCLUDE = ["contenttypes", "auth.permission", "sessions", "admin.logentry"]
SKIP_APPS = {"contenttypes", "sessions", "admin"}


def models():
    return [m for m in apps.get_models() if m._meta.app_label not in SKIP_APPS and m._meta.label_lower != "auth.permission"]


def counts(alias: str) -> dict[str, int]:
    return {m._meta.label: m.objects.using(alias).count() for m in models()}


def main() -> int:
    force = "--force" in sys.argv[1:]
    target = settings.DATABASES["default"]
    if "postgresql" not in target["ENGINE"]:
        print("대상이 PostgreSQL이 아닙니다. .env에 POSTGRES_HOST 등을 넣은 뒤 다시 실행하세요.")
        return 1
    if not SOURCE.exists() or SOURCE.stat().st_size == 0:
        print(f"옮길 SQLite 파일이 없습니다: {SOURCE}")
        return 1
    tables = set(connections["default"].introspection.table_names())
    if "auth_user" not in tables:
        print("대상 DB에 표가 없습니다. 먼저 `cd backend && uv run python manage.py migrate`를 실행하세요.")
        return 1

    before = counts("sqlite")
    existing = {label: n for label, n in counts("default").items() if n}
    if existing and not force:
        print(f"대상 DB에 이미 데이터가 있어 멈춥니다: {existing}")
        print("대상의 데이터를 지우고 다시 옮기려면 --force를 주세요.")
        return 1
    if existing:
        call_command("flush", database="default", interactive=False, verbosity=0)

    with tempfile.TemporaryDirectory() as tmp:
        dump = Path(tmp) / "sqlite-dump.json"
        os.chmod(tmp, 0o700)  # 비밀번호 해시가 들어 있다
        call_command("dumpdata", database="sqlite", exclude=EXCLUDE, output=str(dump), verbosity=0)
        call_command("loaddata", str(dump), database="default", verbosity=0)  # 번호(sequence)도 이어지게 맞춘다

    after = counts("default")
    width = max(len(label) for label in before)
    print(f"{'표'.ljust(width)}  SQLite  PostgreSQL")
    ok = True
    for label in sorted(before):
        mark = "" if before[label] == after[label] else "  ← 다름"
        ok = ok and not mark
        if before[label] or after[label]:
            print(f"{label.ljust(width)}  {before[label]:6d}  {after[label]:10d}{mark}")
    print(f"\n{target['HOST']}:{target['PORT']} / {target['NAME']}로 옮겼습니다." if ok else "\n행 수가 다른 표가 있습니다. 확인하세요.")
    return 0 if ok else 2


if __name__ == "__main__":
    sys.exit(main())
