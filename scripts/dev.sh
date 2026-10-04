#!/usr/bin/env bash
# 로컬 개발 서버를 한 번에 띄우고 다시 띄운다: Django API, 엔진 루프(run_engine), 프론트엔드(Vite).
#
#   scripts/dev.sh              # 전부 (다시) 띄운다. 이미 떠 있으면 내리고 다시 띄운다 (= restart)
#   scripts/dev.sh stop         # 전부 내린다
#   scripts/dev.sh status       # 떠 있는지, 주소, DB 위치
#   scripts/dev.sh logs [backend|engine|frontend]   # 로그 따라 보기 (Ctrl+C로 끝)
#   scripts/dev.sh db           # DB 셸 (PostgreSQL 컨테이너면 psql, 아니면 SQLite backend/db.sqlite3)
#   scripts/dev.sh import-sqlite [--force]   # SQLite의 데이터를 PostgreSQL로 옮긴다 (한 번만)
#   scripts/dev.sh db-stop      # PostgreSQL 컨테이너를 내린다 (stop은 DB를 내리지 않는다. 데이터는 볼륨에 남는다)
#
# - 프론트엔드는 0.0.0.0에 띄운다 (같은 네트워크의 휴대폰·다른 PC에서 http://<이 PC의 IP>:5173 으로 접속).
#   Django는 127.0.0.1에만 띄우고 프론트엔드(Vite)가 /api, /admin을 넘겨준다. 이 PC의 IP는 DJANGO_ALLOWED_HOSTS에 더해 준다.
# - 포트를 다른 프로그램이 쓰고 있으면 다음 빈 포트를 쓴다 (프론트의 API 주소도 거기에 맞춘다).
# - DB: .env의 POSTGRES_HOST가 비어 있으면 SQLite, 127.0.0.1이면 이 PC의 PostgreSQL 컨테이너(deploy/compose.dev.yml)를 띄워 쓴다.
#   POSTGRES_BIND=0.0.0.0이면 같은 네트워크에서 DB에 접속할 수 있다 (개발할 때만. 접속 방법은 status에 나온다).
# - 띄우기 전에 DB 마이그레이션을 적용한다. 로그와 PID는 .cache/dev/ 에 둔다 (git 제외).
# - 엔진 루프는 하나만 돌아야 한다. 그래서 이 저장소에서 손으로 띄워 둔 runserver·run_engine·vite도 같이 내리고 다시 띄운다.
#   POSTGRES_HOST가 다른 PC를 가리키면(팀이 같이 보는 개발 DB) 엔진 루프를 띄우지 않고 마이그레이션도 알아서 적용하지 않는다.
#
# 바꿀 수 있는 값 (환경 변수): BACKEND_PORT(기본 8000), FRONTEND_PORT(5173), FRONTEND_HOST(0.0.0.0)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
RUN_DIR="$ROOT/.cache/dev"
SERVICES="backend engine frontend"
BACKEND_PORT="${BACKEND_PORT:-8000}"
FRONTEND_PORT="${FRONTEND_PORT:-5173}"
FRONTEND_HOST="${FRONTEND_HOST:-0.0.0.0}"
# 이 저장소에서 손으로 띄운 개발 서버를 찾는 패턴 (작업 폴더가 저장소 안인 것만 내린다)
OURS='manage\.py (runserver|run_engine)|/vite( |$)|vite\.js( |$)'

mkdir -p "$RUN_DIR"
cd "$ROOT"

say() { printf '%s\n' "$*"; }
die() { printf '오류: %s\n' "$*" >&2; exit 1; }

# --- 프로세스 ---

alive() { kill -0 "$1" 2>/dev/null; }

pid_of() { # 서비스 이름 → 살아 있는 PID (없으면 빈 값)
  local file="$RUN_DIR/$1.pid" pid
  [ -f "$file" ] || return 0
  pid="$(cat "$file" 2>/dev/null || true)"
  if [ -n "$pid" ] && alive "$pid"; then printf '%s' "$pid"; fi
}

tree() { # PID와 그 자식들 (uv → python → 자동 재시작 자식처럼 여러 겹이다)
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do tree "$child"; done
  printf '%s\n' "$1"
}

stop_pids() { # 끝내 달라고 한 뒤 5초 기다리고, 남으면 강제로 끝낸다
  local pids="$*" pid left i
  [ -n "$pids" ] || return 0
  for pid in $pids; do kill "$pid" 2>/dev/null || true; done
  for i in 1 2 3 4 5 6 7 8 9 10; do
    left=""
    for pid in $pids; do if alive "$pid"; then left="$left $pid"; fi; done
    [ -n "$left" ] || return 0
    sleep 0.5
  done
  for pid in $left; do kill -9 "$pid" 2>/dev/null || true; done
}

cwd_of() { # 프로세스의 작업 폴더
  if [ -e "/proc/$1/cwd" ]; then readlink "/proc/$1/cwd" 2>/dev/null || true
  else lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
  fi
}

leftovers() { # 이 저장소에서 떠 있는 개발 서버 프로세스 (손으로 띄운 것 포함)
  local pid dir
  for pid in $(pgrep -f "$OURS" 2>/dev/null || true); do
    [ "$pid" != "$$" ] || continue
    dir="$(cwd_of "$pid")"
    case "$dir" in "$ROOT"|"$ROOT"/*) printf '%s\n' "$pid" ;; esac
  done
}

port_busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1; }

free_port() { # 원하는 포트부터 차례로 빈 포트를 찾는다
  local port="$1" tries=0
  while port_busy "$port"; do
    tries=$((tries + 1))
    [ "$tries" -lt 20 ] || die "$1부터 20개 포트가 모두 사용 중입니다."
    port=$((port + 1))
  done
  printf '%s' "$port"
}

local_ips() { # 이 PC의 IPv4 주소들 (127.* 제외). 무선·유선·VPN 주소가 여러 개일 수 있다
  { ifconfig 2>/dev/null || ip -4 addr 2>/dev/null || true; } \
    | awk '$1 == "inet" { sub(/\/.*/, "", $2); if ($2 !~ /^127\./) print $2 }' | sort -u
}

wait_http() { # 주소가 응답할 때까지 (최대 $2초)
  local i=0
  while [ "$i" -lt "$2" ]; do
    if curl -fsS -o /dev/null -m 2 "$1" 2>/dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  return 1
}

launch() { # 이름, 작업 폴더, 명령... → 로그로 내보내며 백그라운드로 띄우고 PID를 적는다
  local name="$1" dir="$2"; shift 2
  local log="$RUN_DIR/$name.log"
  : > "$log"
  # PYTHONUNBUFFERED: 파이썬 출력이 파일로 갈 때 버퍼에 쌓이지 않고 바로 로그에 남게 (엔진 루프의 체결·청산 기록을 바로 본다)
  ( cd "$dir" && PYTHONUNBUFFERED=1 exec nohup "$@" >> "$log" 2>&1 < /dev/null ) &
  printf '%s\n' "$!" > "$RUN_DIR/$name.pid"
}

# --- DB (PostgreSQL 컨테이너) ---

dotenv() { # .env의 값 하나 (환경 변수가 있으면 그것). 없으면 빈 값
  local value
  eval "value=\${$1:-}"
  if [ -z "$value" ] && [ -f "$ROOT/.env" ]; then
    value="$(grep -E "^$1=" "$ROOT/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "\"'" || true)"
  fi
  printf '%s' "$value"
}

compose() { docker compose --env-file "$ROOT/.env" -f "$ROOT/deploy/compose.dev.yml" --profile postgres "$@"; }

local_postgres() { # 이 PC의 컨테이너를 쓰도록 설정돼 있는지
  case "$(dotenv POSTGRES_HOST)" in 127.0.0.1|localhost) return 0 ;; *) return 1 ;; esac
}

remote_postgres() { # 다른 PC의 DB(팀이 같이 보는 개발 DB)를 쓰도록 설정돼 있는지
  [ -n "$(dotenv POSTGRES_HOST)" ] && ! local_postgres
}

db_up() { # 컨테이너를 띄우고 접속을 받을 때까지 기다린다
  local_postgres || return 0
  command -v docker >/dev/null 2>&1 || die "docker가 없습니다 (POSTGRES_HOST가 이 PC를 가리키면 PostgreSQL 컨테이너가 필요합니다)."
  [ "$(dotenv POSTGRES_PASSWORD)" != "" ] || die ".env에 POSTGRES_PASSWORD가 없습니다."
  compose up -d db > "$RUN_DIR/db.log" 2>&1 < /dev/null || { tail -20 "$RUN_DIR/db.log" >&2; die "PostgreSQL 컨테이너를 띄우지 못했습니다 (.cache/dev/db.log)"; }
  local i=0
  while [ "$i" -lt 40 ]; do
    if compose exec -T db pg_isready -q -U "$(dotenv POSTGRES_USER)" -d "$(dotenv POSTGRES_DB)" >/dev/null 2>&1 < /dev/null; then return 0; fi
    sleep 1; i=$((i + 1))
  done
  die "PostgreSQL이 접속을 받지 않습니다 (docker logs 확인)."
}

migrate() {
  if remote_postgres; then
    # 공유 DB에는 알아서 적용하지 않는다 (모델을 바꾼 사람이 팀에 알린 뒤 직접 한다)
    (cd backend && uv run python manage.py migrate --check) > "$RUN_DIR/migrate.log" 2>&1 \
      || say "주의: 공유 DB에 적용되지 않은 마이그레이션이 있거나 DB에 접속하지 못했습니다 (.cache/dev/migrate.log). 팀에 알린 뒤 cd backend && uv run python manage.py migrate"
    return 0
  fi
  say "DB 마이그레이션을 적용합니다"
  (cd backend && uv run python manage.py migrate --noinput) > "$RUN_DIR/migrate.log" 2>&1 \
    || { tail -20 "$RUN_DIR/migrate.log" >&2; die "마이그레이션 실패 (.cache/dev/migrate.log)"; }
}

import_sqlite() {
  local_postgres || die ".env의 POSTGRES_HOST가 이 PC(127.0.0.1)를 가리킬 때만 옮깁니다."
  db_up
  migrate
  (cd backend && uv run python ../scripts/sqlite_to_postgres.py "$@")
}

db_shell() {
  if local_postgres; then
    db_up
    local tty=""
    [ -t 0 ] || tty="-T"   # 입력을 파이프로 줄 때 (예: echo '\dt' | scripts/dev.sh db)
    exec docker compose --env-file "$ROOT/.env" -f "$ROOT/deploy/compose.dev.yml" --profile postgres \
      exec $tty db psql -U "$(dotenv POSTGRES_USER)" -d "$(dotenv POSTGRES_DB)"
  fi
  cd backend && exec uv run python manage.py dbshell
}

# --- 명령 ---

stop_all() {
  local name pid pids="" extra
  for name in $SERVICES; do
    pid="$(pid_of "$name")"
    if [ -n "$pid" ]; then pids="$pids $(tree "$pid")"; fi
  done
  stop_pids $pids
  extra="$(leftovers)"   # 손으로 띄웠거나 PID 파일이 없어진 것
  if [ -n "$extra" ]; then
    say "이 저장소에서 따로 떠 있던 개발 서버도 내립니다: $(printf '%s ' $extra)"
    stop_pids $extra
  fi
  for name in $SERVICES; do rm -f "$RUN_DIR/$name.pid"; done
  rm -f "$RUN_DIR/ports"
}

start_all() {
  command -v uv >/dev/null 2>&1 || die "uv가 없습니다 (https://docs.astral.sh/uv/)."
  command -v npm >/dev/null 2>&1 || die "npm이 없습니다 (Node.js 설치 필요)."
  [ -f "$ROOT/.env" ] || say "참고: .env가 없습니다. cp .env.example .env 후 키를 채우세요 (없으면 시세·AI 기능이 꺼집니다)."
  [ -d "$ROOT/.venv" ] || { say "파이썬 환경을 만듭니다 (uv sync)"; uv sync; }
  [ -d "$ROOT/frontend/node_modules" ] || { say "프론트엔드 패키지를 받습니다 (npm ci)"; (cd frontend && npm ci); }

  local ips hosts existing backend_port frontend_port
  ips="$(local_ips | tr '\n' ',' | sed 's/,$//')"
  # 다른 기기에서 http://<IP>:포트 로 들어오면 Django가 그 Host를 받아야 한다 (.env의 값에 이 PC의 IP들을 더한다)
  existing="$(dotenv DJANGO_ALLOWED_HOSTS)"
  hosts="localhost,127.0.0.1${existing:+,$existing}${ips:+,$ips}"
  export DJANGO_ALLOWED_HOSTS="$hosts"

  db_up
  migrate

  backend_port="$(free_port "$BACKEND_PORT")"
  [ "$backend_port" = "$BACKEND_PORT" ] || say "포트 $BACKEND_PORT 는 다른 프로그램이 쓰고 있어 Django를 $backend_port 에 띄웁니다"
  frontend_port="$(free_port "$FRONTEND_PORT")"
  [ "$frontend_port" = "$FRONTEND_PORT" ] || say "포트 $FRONTEND_PORT 는 다른 프로그램이 쓰고 있어 프론트엔드를 $frontend_port 에 띄웁니다"
  printf 'backend=%s\nfrontend=%s\nips=%s\n' "$backend_port" "$frontend_port" "$ips" > "$RUN_DIR/ports"

  launch backend "$ROOT/backend" uv run python manage.py runserver "127.0.0.1:$backend_port"
  if remote_postgres; then
    say "다른 PC의 DB($(dotenv POSTGRES_HOST))를 쓰는 중이라 엔진 루프는 띄우지 않습니다 (엔진 루프는 DB가 있는 호스트 PC에서만 돌립니다)"
  else
    launch engine "$ROOT/backend" uv run python manage.py run_engine
  fi
  launch frontend "$ROOT/frontend" env "VITE_API_TARGET=http://127.0.0.1:$backend_port" \
    npx vite --host "$FRONTEND_HOST" --port "$frontend_port" --strictPort

  wait_http "http://127.0.0.1:$backend_port/api/health" 40 || { tail -20 "$RUN_DIR/backend.log" >&2; die "Django가 뜨지 않았습니다 (.cache/dev/backend.log)"; }
  wait_http "http://127.0.0.1:$frontend_port/" 40 || { tail -20 "$RUN_DIR/frontend.log" >&2; die "프론트엔드가 뜨지 않았습니다 (.cache/dev/frontend.log)"; }
  remote_postgres || [ -n "$(pid_of engine)" ] || { tail -20 "$RUN_DIR/engine.log" >&2; die "엔진 루프가 바로 끝났습니다 (.cache/dev/engine.log)"; }
  status
}

db_info() { # 지금 설정이 가리키는 DB와 접속 방법 (비밀번호는 찍지 않는다)
  local host port name user bind ip
  host="$(dotenv POSTGRES_HOST)"
  if [ -z "$host" ]; then
    say "  SQLite 파일: $ROOT/backend/db.sqlite3  (이 PC에서만)"
    say "  접속: scripts/dev.sh db   또는   sqlite3 backend/db.sqlite3"
    return 0
  fi
  port="$(dotenv POSTGRES_PORT)"; name="$(dotenv POSTGRES_DB)"; user="$(dotenv POSTGRES_USER)"; bind="$(dotenv POSTGRES_BIND)"
  say "  PostgreSQL: DB $name / 사용자 $user / 포트 ${port:-5432}  (비밀번호는 .env의 POSTGRES_PASSWORD)"
  if local_postgres; then
    if compose ps --status running --quiet db 2>/dev/null | grep -q .; then say "  컨테이너: 실행 중"; else say "  컨테이너: 꺼져 있음 (scripts/dev.sh 로 띄운다)"; fi
    say "  이 PC:        scripts/dev.sh db   또는   psql -h 127.0.0.1 -p ${port:-5432} -U $user $name"
    if [ "$bind" = "0.0.0.0" ]; then
      for ip in $(local_ips); do say "  같은 네트워크: psql -h $ip -p ${port:-5432} -U $user $name   (DBeaver 등도 같은 값)"; done
    else
      say "  같은 네트워크에서는 접속할 수 없음 (.env에 POSTGRES_BIND=0.0.0.0을 넣고 scripts/dev.sh db-stop 후 다시 띄우면 열린다. 개발할 때만)"
    fi
  else
    say "  호스트: $host  (다른 PC의 DB를 쓰는 중. 엔진 루프는 그 PC에서만 돌린다)"
  fi
}

status() {
  local name pid backend_port="" frontend_port="" ips="" ip
  if [ -f "$RUN_DIR/ports" ]; then
    backend_port="$(sed -n 's/^backend=//p' "$RUN_DIR/ports")"
    frontend_port="$(sed -n 's/^frontend=//p' "$RUN_DIR/ports")"
    ips="$(sed -n 's/^ips=//p' "$RUN_DIR/ports" | tr ',' ' ')"
  fi
  say ""
  for name in $SERVICES; do
    pid="$(pid_of "$name")"
    if [ -n "$pid" ]; then say "  $name: 실행 중 (PID $pid, 로그 .cache/dev/$name.log)"
    elif [ "$name" = engine ] && remote_postgres; then say "  $name: 띄우지 않음 (다른 PC의 DB를 쓰는 중. 엔진 루프는 그 PC에서만 돈다)"
    else say "  $name: 꺼져 있음"; fi
  done
  if [ -n "$(pid_of frontend)" ] && [ -n "$frontend_port" ]; then
    say ""
    say "화면"
    say "  이 PC:        http://localhost:$frontend_port"
    for ip in $ips; do say "  같은 네트워크: http://$ip:$frontend_port  (휴대폰·다른 PC)"; done
    say "  관리자 화면:   http://localhost:$frontend_port/admin/  (계정: cd backend && uv run python manage.py createsuperuser)"
    say "  API(Django):  http://127.0.0.1:$backend_port  (이 PC에서만)"
  fi
  say ""
  say "DB"
  db_info
  say ""
}

logs() {
  local name="${1:-}" files="" n
  if [ -n "$name" ]; then
    case " $SERVICES " in *" $name "*) ;; *) die "로그 이름은 $SERVICES 중 하나입니다." ;; esac
    files="$RUN_DIR/$name.log"
  else
    for n in $SERVICES; do files="$files $RUN_DIR/$n.log"; done
  fi
  exec tail -n 40 -f $files
}

case "${1:-start}" in
  start|restart|"") stop_all; start_all ;;
  stop) stop_all; say "모두 내렸습니다." ;;
  status) status ;;
  logs) logs "${2:-}" ;;
  db) db_shell ;;
  db-stop) local_postgres || die "이 PC의 PostgreSQL 컨테이너를 쓰지 않습니다."; compose stop db; say "PostgreSQL 컨테이너를 내렸습니다 (데이터는 볼륨에 남습니다)." ;;
  import-sqlite) shift; import_sqlite "$@" ;;
  -h|--help|help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//' ;;
  *) die "모르는 명령: $1 (start | stop | status | logs | db | db-stop | import-sqlite)" ;;
esac
