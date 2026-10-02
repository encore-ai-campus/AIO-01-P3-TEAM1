#!/usr/bin/env bash
# 띄워 둔 스택(docker-compose.yml)이 nginx를 거쳐 제대로 도는지 확인한다. CI와 이 PC에서 쓴다 (운영 서버에서는 돌리지 않는다).
#
#   cd deploy && docker compose --env-file .env.docker up -d && ./smoke_test.sh
#
# 확인하는 것: 상태 확인 주소, 화면(SPA)과 정적 파일, 로그인 없이는 401, CSRF + 로그인 + 내 정보 + 로그아웃,
# 엔진 컨테이너의 리포트 PDF 생성(Chromium). 증권사·AI 키가 없어도 통과한다 (외부 호출을 하지 않는다).
# 시험용 계정을 하나 만들었다가 끝나면 지운다.
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env.docker}"
port="$(sed -n 's/^HTTP_PORT=//p' "$ENV_FILE" | tail -1)"
BASE="${BASE_URL:-http://127.0.0.1:${port:-80}}"
compose() { docker compose --env-file "$ENV_FILE" -f docker-compose.yml "$@"; }

jar="$(mktemp)"
user="smoke-$(date +%s)-$$"
password="$(head -c 24 /dev/urandom | base64 | tr -d '/+=')"
cleanup() {
  rm -f "$jar"
  compose exec -T -e SMOKE_USER="$user" web python manage.py shell -c \
    "import os; from django.contrib.auth import get_user_model; get_user_model().objects.filter(username=os.environ['SMOKE_USER']).delete()" \
    > /dev/null 2>&1 || true
}
trap cleanup EXIT

fail() { echo "실패: $*" >&2; exit 1; }
code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@"; }
expect() { # 설명, 기대 상태 코드, curl 인자...
  local what="$1" want="$2" got; shift 2
  got="$(code "$@")"
  [ "$got" = "$want" ] || fail "$what → $got (기대 $want)"
  echo "통과: $what ($got)"
}

echo "대상: $BASE"
for _ in $(seq 1 60); do [ "$(code "$BASE/api/health")" = 200 ] && break; sleep 2; done

expect "nginx 상태 확인 /healthz" 200 "$BASE/healthz"
expect "API 상태 확인 /api/health" 200 "$BASE/api/health"
expect "화면 /" 200 "$BASE/"
expect "화면 경로(SPA) /stocks/005930" 200 "$BASE/stocks/005930"
asset="$(curl -s -m 10 "$BASE/" | grep -o '/assets/[^"]*\.js' | head -1)"
[ -n "$asset" ] || fail "화면에 빌드된 스크립트가 없다"
expect "빌드 파일 $asset" 200 "$BASE$asset"
expect "관리자 화면 정적 파일" 200 "$BASE/static/admin/css/base.css"
expect "로그인 없이 /api/auth/me" 401 "$BASE/api/auth/me"
expect "로그인 없이 /api/account" 401 "$BASE/api/account"

compose exec -T -e SMOKE_USER="$user" -e SMOKE_PASSWORD="$password" web python manage.py shell -c \
  "import os; from django.contrib.auth import get_user_model; get_user_model().objects.create_user(os.environ['SMOKE_USER'], password=os.environ['SMOKE_PASSWORD'])" \
  > /dev/null || fail "시험용 계정을 만들지 못했다"

# 브라우저처럼 Origin을 붙인다: nginx가 Host를 그대로 넘기지 않으면 Django의 CSRF 검사에서 403이 난다
expect "CSRF 쿠키 받기" 200 -c "$jar" "$BASE/api/auth/csrf"
token="$(awk '$6 == "csrftoken" {print $7}' "$jar")"
[ -n "$token" ] || fail "csrftoken 쿠키가 없다"
body="{\"username\": \"$user\", \"password\": \"$password\"}"
expect "CSRF 토큰 없이 로그인" 403 -b "$jar" -H "Origin: $BASE" -H 'Content-Type: application/json' -d "$body" "$BASE/api/auth/login"
expect "로그인" 200 -b "$jar" -c "$jar" -H "Origin: $BASE" -H "X-CSRFToken: $token" -H 'Content-Type: application/json' \
  -d "$body" "$BASE/api/auth/login"
expect "로그인 후 /api/auth/me" 200 -b "$jar" "$BASE/api/auth/me"
expect "로그인 후 /api/reports/plan (DB + 리포트 구성 파일)" 200 -b "$jar" "$BASE/api/reports/plan"
token="$(awk '$6 == "csrftoken" {print $7}' "$jar")"
expect "로그아웃" 204 -b "$jar" -c "$jar" -H "Origin: $BASE" -H "X-CSRFToken: $token" -X POST "$BASE/api/auth/logout"

# 엔진 컨테이너: 읽기 전용·권한 없는 사용자로 Chromium이 한글 PDF를 만드는지
compose exec -T engine python -c "
import os, subprocess
from pathlib import Path
from paper_engine import report
out = report._render_pdf('<html><body><h1>리포트 확인</h1></body></html>', Path('/tmp/smoke.pdf'), os.environ.get('CHROME_BIN'), subprocess.run)
assert out.suffix == '.pdf' and out.read_bytes()[:4] == b'%PDF', out
" || fail "엔진 컨테이너에서 PDF를 만들지 못했다"
echo "통과: 엔진 컨테이너 PDF 생성"

echo "모두 통과"
