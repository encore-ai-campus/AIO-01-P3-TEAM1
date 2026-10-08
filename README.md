# 모매매 관리 서버 (관리자 페이지 · 관리자 백엔드 · MCP)

모의매매 서비스 "모매매"([SHS5029/paper_trading](https://github.com/SHS5029/paper_trading))를 운영하는 사람이 보는 **조회 전용** 관리 서버다.
서비스와 다른 저장소·다른 서버에서 돌고, 서비스 DB는 SSH 터널 + 읽기 전용 계정으로만 읽는다.
계획은 서비스 저장소의 `OPS_ADMIN_PLAN.md`, API 계약은 이 저장소의 `API.md`다 (API를 바꾸면 `API.md`를 먼저 고친다).

2026-10-08 서비스 저장소의 `admin/`에서 이 저장소로 옮겼다 (원래 커밋 `ea086b9`).

## 1. 구성

| 폴더 | 내용 | 실행 |
|---|---|---|
| `server/` | 관리자 백엔드 FastAPI(`paper_admin.api`)와 MCP 서버(`paper_admin.mcp_server`). 숫자(F2~F9)는 백엔드에서만 만들고 MCP는 백엔드를 부른다 | uv 프로젝트 |
| `web/` | 관리자 화면 (React + Vite). `/api/admin/*`만 부른다 | npm 패키지 |
| `deploy/` | 관리 서버 compose(web·api·mcp·tunnel), 서버 배포 스크립트, 서비스 DB 읽기 전용 계정 SQL | |
| `recovery_cases.json` | 복구 셈법 기준 사례. 서비스 저장소에 같은 사본이 있다 (`API.md` 3장) | |
| `.github/workflows/` | `ci.yml`(검사), `deploy.yml`(main: 검사 → 이미지 → 관리 서버 배포) | |

```
브라우저·Claude Code ─▶ 관리 서버 :80 web(nginx) ─┬─ /            관리자 화면
                                                  ├─ /api/admin/  api (FastAPI)
                                                  └─ /mcp         mcp (MCP, 사람별 토큰)
api ─▶ tunnel(SSH) ─▶ 서비스 서버 127.0.0.1:15432 (PostgreSQL, 읽기 전용 계정 paper_admin_ro)
서비스 GitHub Actions ─SSH(강제 명령 키)─▶ 관리 서버 deploy_record.py ─▶ records/deploys.jsonl (F5 배포 기록)
```

서비스 저장소가 관리 서버를 위해 하는 일:

- **엔진 상태**: `run_engine`이 30초마다 `engine_status` 행을 고친다 (`backend/trading/heartbeat.py`). 버전은 운영 compose의 `APP_VERSION`(= 이미지 태그).
- **배포 기록**: 서비스 `deploy.yml`의 "관리 서버에 배포 기록" 작업이 결과 한 줄을 이 서버로 보낸다.
- **DB 읽기**: 서비스 compose가 DB를 서버 안 `127.0.0.1:${DB_LOCAL_PORT:-15432}`에만 연다.

## 2. 개발

```bash
cd server && uv sync && uv run ruff check . && uv run pytest -q
cd web && npm ci && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build
cd web && VITE_MOCK=1 npm run dev          # 가짜 API(MSW)로 화면만 (admin / admin1234)
```

실제 DB로 띄워 볼 때 (서비스 DB를 건드리지 않게 확인용 PostgreSQL에서, 서비스 저장소를 옆에 받아 둔다):

```bash
docker run -d --name paper-admin-pg -e POSTGRES_DB=paper -e POSTGRES_USER=paper -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55432:5432 postgres:16
(cd ../paper_trading/backend && POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 POSTGRES_DB=paper POSTGRES_USER=paper POSTGRES_PASSWORD=dev \
  DJANGO_SECRET_KEY=dev-only DJANGO_DEBUG=on uv run python manage.py migrate)
docker exec -i paper-admin-pg psql -U paper -d paper -v ro_password=ro-dev < deploy/readonly_role.sql
cd server && ADMIN_DATABASE_URL=postgresql://paper_admin_ro:ro-dev@127.0.0.1:55432/paper \
  ADMIN_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))") ADMIN_DATA_DIR=./data \
  uv run uvicorn paper_admin.api:app --port 8100
cd web && npm run dev                      # /api/admin → 127.0.0.1:8100 (VITE_API_TARGET로 바꾼다)
ADMIN_TEST_PG_DSN=postgresql://paper_admin_ro:ro-dev@127.0.0.1:55432/paper uv run pytest -q -m pg   # server: 읽기 전용 통합 테스트
```

## 3. 관리 서버 준비 (한 번)

### 3-1. 서버

- Ubuntu + Docker Engine·Compose. 메모리 1GB면 된다 (`t3.micro` + swap 2GB). 이미지는 GitHub Actions가 만들어 GHCR에 올리므로 서버에서 빌드하지 않는다.
- 보안 그룹 인바운드: **22**(관리자 SSH, GitHub Actions 배포·배포 기록 — 키 로그인만), **80**(관리자 화면·MCP — 5장).
- 폴더: `~/paper_admin/{.env, secrets/, records/, app/, deploy_record.py}`. `.env`는 `deploy/.env.example`을 복사해 채우고 `chmod 600`.
  `app/`(compose.yml·remote_deploy.sh)과 `deploy_record.py`는 배포 작업이 올린다.

### 3-2. 서비스 서버 쪽 (서비스 서버 관리자가 한 번)

1. 서비스 `main`에 엔진 상태 표(`trading` 0004)와 compose의 `DB_LOCAL_PORT`가 배포됐는지 확인한다.
2. 읽기 전용 계정을 만든다 (비밀번호는 셸 기록에 남기지 않는다):
   ```bash
   read -rs RO_PASSWORD && export RO_PASSWORD     # 관리 서버 .env의 ADMIN_DB_PASSWORD와 같은 값
   docker exec -i -e RO_PASSWORD paper-trading-db-1 sh -c 'psql -v ON_ERROR_STOP=1 -v ro_password="$RO_PASSWORD" -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
     < readonly_role.sql
   ```
   서비스 마이그레이션이 `auth_user`의 열을 바꾸다 이 뷰 때문에 실패하면 `DROP VIEW admin_staff_accounts;` → 마이그레이션 → 이 SQL을 다시 돌린다.
3. 터널 전용 사용자를 만들고 관리 서버의 터널 키를 **그 포트로만** 열어 준다:
   ```bash
   sudo adduser --disabled-password --shell /usr/sbin/nologin --gecos "" admin-tunnel
   sudo install -d -m 700 -o admin-tunnel -g admin-tunnel /home/admin-tunnel/.ssh
   # /home/admin-tunnel/.ssh/authorized_keys (0600, 소유 admin-tunnel) 한 줄:
   # restrict,port-forwarding,permitopen="127.0.0.1:15432",command="/bin/false" ssh-ed25519 AAAA... paper-admin-tunnel
   ```

### 3-3. 관리 서버 쪽 키

- 터널 키: 관리 서버에서 `ssh-keygen -t ed25519 -N "" -f ~/paper_admin/secrets/tunnel_key -C paper-admin-tunnel`, 공개 키를 3-2의 3에 넣는다.
  `ssh-keyscan -t ed25519 <서비스 서버 주소> > ~/paper_admin/secrets/known_hosts` (지문은 서비스 서버의 `/etc/ssh/ssh_host_ed25519_key.pub`과 맞춰 본다).
  터널 컨테이너는 uid 1000으로 키를 읽는다 (EC2 Ubuntu의 ubuntu 사용자도 1000이라 0600 그대로 된다).
- 배포 기록 키 (서비스 저장소가 쓴다): `ssh-keygen -t ed25519 -N "" -f deploy_record_key -C deploy-record`. 관리 서버 `~/.ssh/authorized_keys`에 한 줄:
  ```
  restrict,command="python3 /home/ubuntu/paper_admin/deploy_record.py /home/ubuntu/paper_admin/records/deploys.jsonl" ssh-ed25519 AAAA... deploy-record
  ```
  이 키로는 배포 기록 한 줄을 더하는 것 말고 아무것도 못 한다. **서비스 저장소**에 넣는다:
  변수 `ADMIN_RECORD_HOST`(관리 서버 주소), `ADMIN_RECORD_HOST_KEY`(관리 서버 `/etc/ssh/ssh_host_ed25519_key.pub` 한 줄), `ADMIN_RECORD_USER`(기본 ubuntu),
  `DEPLOY_SERVER_NAME`(기본 `app`) · 비밀 값 `ADMIN_RECORD_SSH_KEY`(개인 키). 개인 키 파일은 넣은 뒤 지운다.

## 4. 검사·배포 (GitHub Actions)

| 작업 | 언제 | 하는 일 |
|---|---|---|
| `ci.yml` | main 아닌 브랜치 push·PR, 그리고 `deploy.yml` 안에서 | server 린트·테스트, web 린트·타입·테스트·빌드, schema(서비스 마이그레이션을 건 PostgreSQL에서 읽기 전용 계정으로 모든 경로 200·쓰기 실패, 기준 사례 사본 비교) |
| `deploy.yml` | main push | 검사 → 이미지 3개(`ghcr.io/shs5029/paper-admin-{server,web,tunnel}:<커밋>`) → 관리 서버에 compose·스크립트 올리고 `remote_deploy.sh` (새 버전이 2분 안에 뜨지 않으면 직전 버전으로 되돌림) |

이 저장소의 설정 (Settings → Secrets and variables → Actions):

| 종류 | 이름 | 값 |
|---|---|---|
| 변수 | `DEPLOY_ENABLED` | `true`면 배포한다 (없으면 검사만) |
| 변수 | `ADMIN_HOST` · `ADMIN_USER` | 관리 서버 주소 · SSH 사용자(기본 ubuntu) |
| 변수 | `ADMIN_HOST_KEY` | 관리 서버 `/etc/ssh/ssh_host_ed25519_key.pub` 한 줄 |
| 비밀 값 | `ADMIN_DEPLOY_SSH_KEY` | 배포용 개인 키 (관리 서버 ubuntu의 `authorized_keys`에 공개 키). 관리자 개인 키와 따로 만든다 |
| 비밀 값 | `SERVICE_REPO_KEY` | 서비스 저장소의 **읽기 전용** deploy key 개인 키 (schema 작업이 서비스 마이그레이션을 받는다). 없으면 schema 작업은 건너뛴다 |

서버에서 보기: `ssh ubuntu@<관리 서버> "cd ~/paper_admin/app && docker compose --env-file ../.env ps && docker compose --env-file ../.env logs --tail 50 api tunnel"`
(배포 기록: `~/paper_admin/app/deploy_history.log`, 지금 태그: `.deployed_tag`).

## 5. 쓰기

- **화면**: `http://<관리 서버 퍼블릭 IP>/` 에서 서비스의 **staff 계정**으로 로그인한다 (staff가 아니면 들어오지 못한다).
- **공개 범위 (2026-10-08 사용자 결정)**: 80번을 모두에게 연다 (`ADMIN_HTTP_BIND=0.0.0.0`, `ADMIN_HTTP_PORT=80`). 처음 계획(SSH 터널로만, 밖에 여는 포트 22뿐)에서 바뀌었다.
  - HTTPS가 아니어서 로그인 비밀번호와 세션 쿠키가 암호화되지 않고 오간다. 공용 와이파이에서는 쓰지 않는다. 도메인을 붙이면 HTTPS로 바꾸고 `ADMIN_COOKIE_SECURE=on`.
  - 막는 것: staff 로그인, 아이디마다 10분에 5번(관리자 백엔드), IP마다 분당 10번(nginx `limit_req`), 조회 전용(DB 계정 권한).
  - 다시 터널로만 쓰려면 `.env`에서 `ADMIN_HTTP_BIND=127.0.0.1`, 보안 그룹 80을 닫고 `ssh -N -L 8080:127.0.0.1:80 ubuntu@<관리 서버>`.
- **MCP (Claude Code 등)**: 사람마다 토큰을 만든다 — 원문은 한 번만 보인다.
  ```bash
  ssh ubuntu@<관리 서버> "cd ~/paper_admin/app && docker compose --env-file ../.env exec api python -m paper_admin.tokens add <이름>"
  claude mcp add --transport http paper-admin http://<관리 서버 퍼블릭 IP>/mcp --header "Authorization: Bearer <토큰>"
  ```
  도구 호출은 감사 기록(`docker compose --env-file ../.env exec api tail /data/audit.jsonl`)에 누가 어떤 도구를 불렀는지 남는다.
  토큰 목록·지우기: `python -m paper_admin.tokens list` · `revoke <이름>`.
  화면의 **MCP 도구·호출** 메뉴(`/tools`, API.md 6장)에서 도구 9개와 부르는 경로, 토큰별 마지막 사용, 토큰으로 들어온 호출 기록(누가·도구·응답 코드, 틀린 토큰 포함)을 본다.

## 6. 완료 기준 확인 (계획 6장)

| 기준 | 확인 방법 |
|---|---|
| F1~F9 화면, 관리자가 아니면 못 들어옴 | 화면 각 메뉴 · staff가 아닌 계정으로 로그인 → 401 |
| back을 멈추면 2분 안에 F3·F4에 표시 | 서비스 서버에서 `docker compose stop web engine` → F3은 다음 확인(30초)에 실패, F4는 마지막 동작 뒤 120초에 "멈춤" |
| MCP로 리포트 하나의 실행 기록을 시간순으로 | `report_trace` 도구 (`report_id`) |
| 쓰기 불가 (DB 권한으로도) | `readonly_role.sql`: SELECT만·열 단위·읽기 전용 트랜잭션 — `ci.yml`의 schema 작업이 INSERT·UPDATE 실패를 확인한다 |
| 밖으로 열린 포트 | 22·80 (5장 결정으로 바뀜) · 보안 그룹 인바운드와 서버의 `ss -ltnp` |
