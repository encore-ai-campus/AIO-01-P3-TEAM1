# 관리 서버 (관리자 페이지 · 관리자 백엔드 · MCP)

계획은 루트 `OPS_ADMIN_PLAN.md`, API 계약은 `API.md`다. 서비스와 따로 두는 관리 서버에서 돌고, **조회만 한다**.
서비스 코드(`frontend/`, `backend/`)와 서로 import하지 않으며, 검사(`.github/workflows/admin-ci.yml`)와 배포도 따로다.

## 1. 구성

| 폴더 | 내용 | 실행 |
|---|---|---|
| `server/` | 관리자 백엔드 FastAPI(`paper_admin.api`)와 MCP 서버(`paper_admin.mcp_server`). 숫자(F2~F9)는 백엔드에서만 만들고 MCP는 백엔드를 부른다 | uv 프로젝트 (루트 작업 공간과 따로) |
| `web/` | 관리자 화면 (React + Vite). `/api/admin/*`만 부른다 | npm 패키지 (`frontend/`와 따로) |
| `deploy/` | 관리 서버의 compose(web·api·mcp·tunnel), 서비스 DB 읽기 전용 계정 SQL, 올리기 스크립트 | |
| `recovery_cases.json` | 복구 셈법 기준 사례 (관리자 백엔드와 서비스 테스트가 같은 숫자인지 본다) | |

서비스 쪽에서 관리 서버를 위해 하는 일 (계획 5장):

- **엔진 상태**: `run_engine`이 30초마다 `engine_status` 행(마지막 동작 시각·버전·중단 스위치·최근 단계 오류·하루 한도)을 고친다 (`backend/trading/heartbeat.py`).
  버전은 운영 compose가 넣는 `APP_VERSION`(= 이미지 태그).
- **배포 기록**: `deploy.yml`의 "관리 서버에 배포 기록" 작업이 결과 한 줄을 관리 서버로 보낸다 (`remote_deploy.sh`가 `DEPLOY_RESULT=` 줄을 남긴다).
- **DB 읽기**: 서비스 compose가 DB를 서버 안 `127.0.0.1:${DB_LOCAL_PORT:-15432}`에만 열고, 관리 서버가 SSH 터널 + 읽기 전용 계정으로 붙는다.

## 2. 개발

```bash
cd admin/server && uv sync && uv run ruff check . && uv run pytest -q
cd admin/web && npm ci && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build
cd admin/web && VITE_MOCK=1 npm run dev          # 가짜 API(MSW)로 화면만 (admin / admin1234)
```

실제 DB로 띄워 볼 때 (서비스 DB를 건드리지 않게 확인용 PostgreSQL에서):

```bash
docker run -d --name paper-admin-pg -e POSTGRES_DB=paper -e POSTGRES_USER=paper -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55432:5432 postgres:16
(cd backend && POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 POSTGRES_DB=paper POSTGRES_USER=paper POSTGRES_PASSWORD=dev \
  DJANGO_SECRET_KEY=dev-only DJANGO_DEBUG=on uv run python manage.py migrate)
docker exec -i paper-admin-pg psql -U paper -d paper -v ro_password=ro-dev < admin/deploy/readonly_role.sql
cd admin/server && ADMIN_DATABASE_URL=postgresql://paper_admin_ro:ro-dev@127.0.0.1:55432/paper \
  ADMIN_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))") ADMIN_DATA_DIR=./data \
  uv run uvicorn paper_admin.api:app --port 8100
cd admin/web && npm run dev                      # /api/admin → 127.0.0.1:8100 (VITE_API_TARGET로 바꾼다)
ADMIN_TEST_PG_DSN=postgresql://paper_admin_ro:ro-dev@127.0.0.1:55432/paper uv run pytest -q -m pg   # admin/server: 읽기 전용 통합 테스트
```

## 3. 관리 서버 준비 (한 번)

### 3-1. 서버

- Ubuntu + Docker Engine·Compose (서비스 서버와 같다 — `docs/DEPLOY.md` 4장). 메모리 1GB면 된다 (`t3.micro` + swap).
- **보안 그룹 인바운드는 22번뿐**이다. 화면(8080)과 MCP도 `127.0.0.1`에만 열린다. 22번은 GitHub Actions(배포 기록)가 들어와야 해서 `0.0.0.0/0`, 키 로그인만.
- 폴더: `~/paper_admin/{.env, secrets/, records/}`. `.env`는 `deploy/.env.example`을 복사해 채우고 `chmod 600`.

### 3-2. 서비스 서버 쪽 (서비스 서버 관리자가 한 번)

1. 서비스 `main`에 이 변경(엔진 상태 표 `trading` 0004, compose의 `DB_LOCAL_PORT`)이 배포됐는지 확인한다.
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
- 배포 기록 키: 이 PC에서 `ssh-keygen -t ed25519 -N "" -f deploy_record_key -C deploy-record`. 관리 서버 `~/.ssh/authorized_keys`에 한 줄:
  ```
  restrict,command="python3 /home/ubuntu/paper_admin/deploy_record.py /home/ubuntu/paper_admin/records/deploys.jsonl" ssh-ed25519 AAAA... deploy-record
  ```
  이 키로는 배포 기록 한 줄을 더하는 것 말고 아무것도 못 한다. GitHub 저장소에 넣는다:
  변수 `ADMIN_RECORD_HOST`(관리 서버 주소), `ADMIN_RECORD_HOST_KEY`(관리 서버 `/etc/ssh/ssh_host_ed25519_key.pub` 한 줄), `ADMIN_RECORD_USER`(기본 ubuntu),
  `DEPLOY_SERVER_NAME`(기본 `app`) · 비밀 값 `ADMIN_RECORD_SSH_KEY`(개인 키). 개인 키 파일은 넣은 뒤 지운다. `ADMIN_RECORD_HOST`가 비어 있으면 그 작업은 돌지 않는다.

### 3-4. 올리기·업데이트

```bash
admin/deploy/push.sh ubuntu@<관리 서버 주소> -i ~/.ssh/<관리자 키>     # rsync → deploy_record.py 복사 → compose 빌드·기동
ssh ubuntu@<관리 서버> "cd ~/paper_admin/src/deploy && docker compose --env-file ../../.env logs --tail 50 api tunnel"
```

### 3-5. 쓰기

- **화면**: `ssh -N -L 8080:127.0.0.1:8080 ubuntu@<관리 서버>` 뒤 `http://localhost:8080`에서 서비스의 staff 계정으로 로그인한다 (staff가 아니면 들어오지 못한다).
- **MCP (Claude Code 등)**: 사람마다 토큰을 만든다 — 원문은 한 번만 보인다.
  ```bash
  ssh ubuntu@<관리 서버> "cd ~/paper_admin/src/deploy && docker compose --env-file ../../.env exec api python -m paper_admin.tokens add <이름>"
  claude mcp add --transport http paper-admin http://localhost:8080/mcp --header "Authorization: Bearer <토큰>"
  ```
  같은 SSH 터널을 열어 둔 채 쓴다. 도구 호출은 관리 서버의 감사 기록(`docker compose exec api tail /data/audit.jsonl`)에 누가 어떤 도구를 불렀는지 남는다.
  토큰 목록·지우기: `python -m paper_admin.tokens list` · `revoke <이름>`.

## 4. 완료 기준 확인 (계획 6장)

| 기준 | 확인 방법 |
|---|---|
| F1~F9 화면, 관리자가 아니면 못 들어옴 | 화면 각 메뉴 · staff가 아닌 계정으로 로그인 → 401 |
| back을 멈추면 2분 안에 F3·F4에 표시 | 서비스 서버에서 `docker compose stop web engine` → F3은 다음 확인(30초)에 실패, F4는 마지막 동작 뒤 120초에 "멈춤" |
| MCP로 리포트 하나의 실행 기록을 시간순으로 | `report_trace` 도구 (`report_id`) |
| 쓰기 불가 (DB 권한으로도) | `readonly_role.sql`: SELECT만·열 단위·읽기 전용 트랜잭션 — `admin-ci.yml`의 schema 작업이 INSERT·UPDATE 실패를 확인한다 |
| 밖으로 열린 포트가 22뿐 | 보안 그룹 인바운드 · 서버에서 `ss -ltnp` (8080은 127.0.0.1) |
