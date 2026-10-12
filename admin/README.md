# 모매매 관리 서버 (관리자 페이지 · 관리자 백엔드 · MCP)

모의매매 서비스 "모매매"를 운영하는 사람이 보는 **조회 전용** 관리 서버다.
서비스와 다른 서버에서 돌고, 서비스 DB는 SSH 터널 + 읽기 전용 계정으로만 읽는다.
계획은 루트 `docs/plans/OPS_ADMIN_PLAN.md`, API 계약은 이 폴더의 `API.md`다 (API를 바꾸면 `API.md`를 먼저 고친다).
서비스 코드(`frontend/`, `backend/`)와 서로 import하지 않으며, 검사(`.github/workflows/admin-ci.yml`)와 배포(`admin-deploy.yml`)도 서비스와 따로다.

2026-10-08 이 저장소의 `admin/`으로 만들고(`ea086b9`), 같은 날 별도 저장소 SHS5029/paper_admin으로 옮겼다가 다시 이 폴더로 합쳤다 (이력 포함).
이 문서의 경로는 `admin/` 기준이다 (`server/` = `admin/server/`).

- 화면·기능·MCP: [1. 화면 구성](#1-화면-구성) · [2. 기능](#2-기능) · [3. MCP 서버](#3-mcp-서버) · [4. 도구 설명](#4-도구-설명)
- 실행·세팅: [5. 저장소 구성](#5-저장소-구성) · [6. 개발](#6-개발) · [7. 관리 서버 준비](#7-관리-서버-준비-한-번) · [8. 검사·배포](#8-검사배포-github-actions) · [9. 접속·공개 범위](#9-접속공개-범위) · [10. 완료 기준 확인](#10-완료-기준-확인-계획-6장)

## 1. 화면 구성

`http://<관리 서버>/`에서 서비스의 **staff 계정**으로 로그인한다 (staff가 아니면 들어오지 못한다). 로그인하면 모든 메뉴가 같은 틀 안에 열린다.

- **왼쪽 메뉴**: 아래 표의 9개.
- **위쪽 막대**: 로그인한 아이디 · 마지막 갱신 시각 · **새로 고침**(지금 보이는 조회를 모두 다시 받는다) · 로그아웃.
- **DB 끊김 알림**: 서비스 DB(터널)에 붙지 못하면 위에 "서비스 DB에 연결할 수 없습니다"를 띄운다. DB가 필요 없는 서비스 상태·배포 기록은 그대로 보인다.
- **자동 갱신**: 화면이 보일 때만 다시 받는다. 15초 — 개요·서비스 상태·엔진 상태·MCP 도구·호출, 60초 — 나머지.
- **상태 표시**: `ok` 정상 · `warn` 주의 · `down` 멈춤 · `unknown` 모름. 기준은 [2장](#2-기능), 값은 백엔드가 정하므로 화면과 MCP가 같은 상태를 본다.

| 메뉴 | 경로 | 기능 | 고르는 값 | 화면에 있는 것 |
|---|---|---|---|---|
| 개요 | `/` | F2 | – | 전체 상태, 7개 항목을 나쁜 것부터 한 줄씩 요약하고 "자세히"로 각 메뉴에 간다 |
| 서비스 상태 | `/service` | F3 | – | 지금 상태 · 실패 시작 시각 · 24시간 가동률 · 24시간 평균 응답, 최근 확인 60번(api·page 각각 결과·코드·응답 시간) |
| 엔진 상태 | `/engine` | F4 | – | 동작 중/멈춤과 마지막 동작 시각, 버전 · 호스트 · 시작 시각 · 새 모의 매수 중단 스위치 · 증권사 조회 키 · 마지막 한 바퀴, 한도, 최근 단계 오류 |
| 배포 기록 | `/deploys` | F5 | 표시 개수 20·50·100·200건 | 서버별 지금 버전, 배포 기록(시각 · 서버 · 결과 · 태그 · 직전 · 누가 · 커밋 · 실행 링크) |
| 리포트 장애 | `/reports` | F6 | 기간 1·7·30·90일, 종류(전체·실패·복구됨·장애 주입), 팀(종목 리포트·종목 선정) | 리포트 목록(상태 · 장애 주입 · 실패 사유 · 장애/복구/미복구 · 비용 · 걸린 시간). 줄을 누르면 리포트 상세 |
| └ 리포트 상세 | `/reports/:id` | F6 | – | 리포트 요약, 복구 요약, 실행 기록(step · actor · action · 종류 · 모델 · latency · 상세) 시간순 |
| 복구 지표 | `/recovery` | F7 | 기간 1·7·30·90일 | 자동 복구율 · 평균 복구 시간 · 장애 · 복구 · 미복구 · 장애 주입, errorType별 · Worker별, 최근 장애 20건 |
| AI 비용 | `/costs` | F8 | 기간 7·14·30·90일 | 오늘 예산 사용 · 실제 비용 · 분석 요청 · 리포트 한도, 일별 비용(리포트 · 분석 · 장기투자)과 기간 합계 |
| 알림·작업 실패 | `/alerts` | F9 | 기간 24·72·168시간 | Discord 발송 실패 · 오래된 대기 · 멈춘 발송과 그 목록, 멈춘 분석·리포트 작업 |
| MCP 도구·호출 | `/tools` | F10 | 기간 24·72·168시간, 도구 | 연결 주소와 `claude mcp add` 명령, 도구 호출 · 실패 응답 · 틀린 토큰 수, 도구 목록, 토큰별 마지막 사용, 호출 기록 |

`cd web && VITE_MOCK=1 npm run dev`로 가짜 API(MSW)를 붙여 화면만 띄워 볼 수 있다 (admin / admin1234, [6장](#6-개발)).

## 2. 기능

모든 기능은 **조회만** 한다. 쓰기 요청은 로그인·로그아웃뿐이고, 서비스 DB에는 읽기 전용 계정으로 열 단위 SELECT만 한다.
숫자와 상태는 관리자 백엔드 한 곳에서만 만들고, 화면과 MCP는 그것을 부른다. 비밀 값·개인 정보(비밀번호 해시, 세션, 토큰, 알림 본문, 리포트 본문, 사용자 이름)는 내지 않는다.

| 번호 | 기능 | 하는 일 | 상태 기준 (`down` · `warn` · `unknown`) |
|---|---|---|---|
| F1 | 관리자 로그인 | 서비스의 staff 계정으로만 로그인한다. 세션 12시간, 같은 아이디로 10분에 5번 실패하면 10분 막는다. staff를 빼거나 비밀번호를 바꾸면 바로 로그아웃된다 | – |
| F2 | 개요 | 아래 F3~F9 7개 항목의 상태를 모아 나쁜 것부터 한 줄씩 보여 준다. 전체 상태는 그중 가장 나쁜 것 | 항목 중 가장 나쁜 것 |
| F3 | 서비스 상태 | 관리 서버가 30초마다 서비스의 `/api/health`(api)와 `/`(page)를 불러 응답 여부·시간을 남기고, 24시간 가동률·평균 응답을 낸다 | down: 마지막 확인 실패 · warn: 10분 안에 실패, 또는 api 응답 2,000ms 초과 · unknown: 아직 확인 전 |
| F4 | 엔진 상태 | 서비스 엔진(`run_engine`)이 30초마다 고치는 `engine_status` 행을 읽는다. 120초 넘게 동작이 없으면 "멈춤" | down: 행 없음 또는 멈춤 · warn: 중단 스위치 켜짐, 또는 30분 안에 단계 오류 |
| F5 | 배포 기록 | 서비스 GitHub Actions가 보낸 배포 결과(성공 · 되돌림 · 되돌리기 실패 · 실패 · 검사 실패로 막힘)를 최신순으로 보고, 서버별 지금 버전을 계산한다 | down: 최신 기록이 되돌리기 실패 · warn: 최신 기록이 실패·되돌림·막힘 · unknown: 기록 없음 |
| F6 | 리포트 장애 | AI 리포트 중 실패했거나 복구된 장애가 있거나 장애 주입을 켠 것을 모으고, 리포트 하나의 실행 기록(재시도 · 대체 모델 전환 · 포기)을 시간순으로 보여 준다 | warn: 24시간 안에 장애 주입 없이 실패로 끝난 리포트 |
| F7 | 복구 지표 | 기간 안 자동 복구율 · 평균 복구 시간 · errorType별 · Worker별 장애 수. 서비스 `reports.autohealing.stats`와 같은 셈법이다 (`recovery_cases.json`, `API.md` 3장) | warn: 7일 안 미복구 장애 · unknown: 7일 안 장애 0건 |
| F8 | AI 비용 | 날짜별 리포트 · 분석 · 장기투자 비용과 오늘 예산 사용액(서비스가 새 리포트를 막는 셈과 같다) · 분석 요청 수 · 한 사람 리포트 수 | down: 예산 100% 이상 · warn: 80% 이상 · unknown: 예산을 모름 |
| F9 | 알림·작업 실패 | Discord 알림 발송 실패 · 10분 넘은 대기 · 10분 넘게 멈춘 발송, 오래 멈춘 작업(분석 RUNNING 15분 · QUEUED 10분, 리포트 running 20분 · requested 30분) | warn: 하나라도 있음 |
| F10 | MCP 도구·호출 | MCP 도구 9개와 부르는 경로, 토큰별 만든 시각 · 마지막 사용 · 호출 수, 토큰으로 들어온 호출 기록(누가 · 도구 · 응답 코드, 틀린 토큰 포함) | – |

자세한 응답 형식과 기준값은 `API.md` 2장(형식·레벨), 6장(F10)이다.

## 3. MCP 서버

Claude Code 같은 MCP 클라이언트에서 관리 서버의 상태를 묻는 **조회 전용** 서버다 (`server/paper_admin/mcp_server.py`). 쓰기 도구는 없다.

- **주소**: `http://<관리 서버>/mcp` — nginx가 mcp 컨테이너(`:8101`)로 넘긴다. streamable HTTP, stateless, JSON 응답.
- **동작**: DB에 붙지 않는다. 도구를 부르면 받은 Bearer 토큰과 `X-Admin-Tool: <도구 이름>` 헤더를 붙여 관리자 API를 GET하고, 받은 JSON을 그대로 돌려준다. 그래서 숫자는 화면과 같다.
- **인증**: 모든 요청에 **사람별 토큰**이 필요하다. 미들웨어가 `GET /api/admin/me`로 토큰을 확인하고(맞은 토큰은 60초 기억), 없거나 틀리면 `401`.
  토큰은 관리 서버의 `ADMIN_DATA_DIR/mcp_tokens.json`에 SHA-256 해시로만 둔다.
- **오류**: 관리자 API가 200이 아니면 도구 오류로 돌려준다 (예: `관리자 API 503: 서비스 DB에 연결할 수 없습니다`). 관리자 API를 15초 기다린다.
- **기록**: 도구 호출마다 감사 기록(`ADMIN_DATA_DIR/audit.jsonl`)에 누가 · 도구 · 경로 · 응답 코드가 남고, 화면의 **MCP 도구·호출**(`/tools`)에서 본다.

연결 (토큰 원문은 만들 때 한 번만 보인다):

```bash
ssh ubuntu@<관리 서버> "cd ~/paper_admin/app && docker compose --env-file ../.env exec api python -m paper_admin.tokens add <이름>"
claude mcp add --transport http paper-admin http://<관리 서버 퍼블릭 IP>/mcp --header "Authorization: Bearer <토큰>"
```

- 토큰 목록·지우기: 같은 자리에서 `python -m paper_admin.tokens list` · `revoke <이름>`.
- 감사 기록 원본: `docker compose --env-file ../.env exec api tail /data/audit.jsonl`.

## 4. 도구 설명

도구 목록은 `server/paper_admin/mcp_tools.py` 한 곳에 있고, MCP 서버와 화면(`/tools`)이 같은 목록을 쓴다. 9개 모두 읽기 전용(`readOnlyHint`)이다.

| 도구 | 인자 (기본값 · 범위) | 돌려주는 것 | 관리자 API · 화면 |
|---|---|---|---|
| `overview` | – | 서비스 · 엔진 · 배포 · 리포트 장애 · 복구 지표 · AI 비용 · 알림을 나쁜 것부터 한 줄씩 요약 | `/api/admin/overview` · 개요 |
| `service_status` | – | 서비스 주소(`/api/health`, `/`)의 응답 여부 · 응답 시간, 최근 24시간 가동률 · 평균 응답, 최근 확인 60번 | `/api/admin/service` · 서비스 상태 |
| `engine_status` | – | 엔진 루프의 마지막 동작 시각(2분 넘으면 멈춤) · 버전 · 중단 스위치 · 최근 단계 오류 · 한도 | `/api/admin/engine` · 엔진 상태 |
| `deploy_history` | `limit` 50 (1~200) | 서버별 지금 버전과 배포 기록(성공 · 실패 · 되돌림) 최신순 | `/api/admin/deploys` · 배포 기록 |
| `report_failures` | `days` 7 (1~90), `kind` `all` (`all`·`failed`·`recovered`·`chaos`), `team` 빈 값 (`stock_report`·`stock_selection`·빈 값=둘 다), `limit` 100 (1~500) | 기간 안 AI 리포트의 실패 · 복구 · 장애 주입 목록 | `/api/admin/reports` · 리포트 장애 |
| `report_trace` | `report_id` (필수) | 리포트 하나의 실행 기록(재시도 · 대체 모델 전환 · 포기) 시간순과 복구 요약 | `/api/admin/reports/{report_id}/trace` · 리포트 상세 |
| `recovery_stats` | `days` 7 (1~90) | 기간 안 자동 복구율 · 평균 복구 시간 · errorType별 · Worker별 장애 수 · 최근 장애 20건 | `/api/admin/recovery` · 복구 지표 |
| `ai_costs` | `days` 14 (1~90) | 날짜별 AI 비용(리포트 · 분석 · 장기투자)과 오늘 예산 · 한도 대비 사용량 | `/api/admin/costs` · AI 비용 |
| `alerts_and_jobs` | `hours` 24 (1~168) | Discord 알림 발송 실패 · 오래된 대기 · 멈춘 발송과 오래 멈춘 분석 · 리포트 작업 | `/api/admin/alerts` · 알림·작업 실패 |

이렇게 쓴다:

- "지금 뭐가 문제야?" → `overview`로 나쁜 항목을 찾고, 그 항목의 도구로 자세히 본다.
- "리포트 1234는 왜 실패했어?" → `report_trace(report_id=1234)`.
- "이번 주 장애 주입은 다 복구됐어?" → `report_failures(kind="chaos")` + `recovery_stats(days=7)`.
- "방금 배포가 잘 됐어?" → `deploy_history(limit=5)` + `engine_status` (엔진 버전이 새 태그인지).

## 5. 저장소 구성

| 폴더 | 내용 | 실행 |
|---|---|---|
| `server/` | 관리자 백엔드 FastAPI(`paper_admin.api`)와 MCP 서버(`paper_admin.mcp_server`). 숫자(F2~F9)는 백엔드에서만 만들고 MCP는 백엔드를 부른다 | uv 프로젝트 |
| `web/` | 관리자 화면 (React + Vite). `/api/admin/*`만 부른다 | npm 패키지 |
| `deploy/` | 관리 서버 compose(web·api·mcp·tunnel), 서버 배포 스크립트, 서비스 DB 읽기 전용 계정 SQL | |
| `recovery_cases.json` | 복구 셈법 기준 사례. 관리자 백엔드와 서비스 테스트(`backend/reports/tests/autohealing/test_recovery_cases.py`)가 같은 파일을 읽는다 (`API.md` 3장) | |
| (루트) `.github/workflows/` | `admin-ci.yml`(검사), `admin-deploy.yml`(main: 검사 → 이미지 → 관리 서버 배포) | |

```
브라우저·Claude Code ─▶ 관리 서버 :80 web(nginx) ─┬─ /            관리자 화면
                                                  ├─ /api/admin/  api (FastAPI)
                                                  └─ /mcp         mcp (MCP, 사람별 토큰)
api ─▶ tunnel(SSH) ─▶ 서비스 서버 127.0.0.1:15432 (PostgreSQL, 읽기 전용 계정 paper_admin_ro)
서비스 GitHub Actions ─SSH(강제 명령 키)─▶ 관리 서버 deploy_record.py ─▶ records/deploys.jsonl (F5 배포 기록)
```

서비스 쪽(`backend/`·`deploy/`)이 관리 서버를 위해 하는 일:

- **엔진 상태**: `run_engine`이 30초마다 `engine_status` 행을 고친다 (`backend/trading/heartbeat.py`). 버전은 운영 compose의 `APP_VERSION`(= 이미지 태그).
- **배포 기록**: 서비스 `deploy.yml`의 "관리 서버에 배포 기록" 작업이 결과 한 줄을 이 서버로 보낸다.
- **DB 읽기**: 서비스 compose가 DB를 서버 안 `127.0.0.1:${DB_LOCAL_PORT:-15432}`에만 연다.

## 6. 개발

`admin/`에서:

```bash
cd server && uv sync && uv run ruff check . && uv run pytest -q
cd web && npm ci && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build
cd web && VITE_MOCK=1 npm run dev          # 가짜 API(MSW)로 화면만 (admin / admin1234)
```

실제 DB로 띄워 볼 때 (서비스 DB를 건드리지 않게 확인용 PostgreSQL에서):

```bash
docker run -d --name paper-admin-pg -e POSTGRES_DB=paper -e POSTGRES_USER=paper -e POSTGRES_PASSWORD=dev -p 127.0.0.1:55432:5432 postgres:16
(cd ../backend && POSTGRES_HOST=127.0.0.1 POSTGRES_PORT=55432 POSTGRES_DB=paper POSTGRES_USER=paper POSTGRES_PASSWORD=dev \
  DJANGO_SECRET_KEY=dev-only DJANGO_DEBUG=on uv run python manage.py migrate)
docker exec -i paper-admin-pg psql -U paper -d paper -v ro_password=ro-dev < deploy/readonly_role.sql
cd server && ADMIN_DATABASE_URL=postgresql://paper_admin_ro:ro-dev@127.0.0.1:55432/paper \
  ADMIN_SECRET_KEY=$(python3 -c "import secrets; print(secrets.token_urlsafe(48))") ADMIN_DATA_DIR=./data \
  uv run uvicorn paper_admin.api:app --port 8100
cd web && npm run dev                      # /api/admin → 127.0.0.1:8100 (VITE_API_TARGET로 바꾼다)
ADMIN_TEST_PG_DSN=postgresql://paper_admin_ro:ro-dev@127.0.0.1:55432/paper uv run pytest -q -m pg   # server: 읽기 전용 통합 테스트
```

## 7. 관리 서버 준비 (한 번)

### 7-1. 서버

- Ubuntu + Docker Engine·Compose. 메모리 1GB면 된다 (`t3.micro` + swap 2GB). 이미지는 GitHub Actions가 만들어 GHCR에 올리므로 서버에서 빌드하지 않는다.
- 보안 그룹 인바운드: **22**(관리자 SSH, GitHub Actions 배포·배포 기록 — 키 로그인만), **80**(관리자 화면·MCP — 9장).
- 폴더: `~/paper_admin/{.env, secrets/, records/, app/, deploy_record.py}`. `.env`는 `deploy/.env.example`을 복사해 채우고 `chmod 600`.
  `app/`(compose.yml·remote_deploy.sh)과 `deploy_record.py`는 배포 작업이 올린다.

### 7-2. 서비스 서버 쪽 (서비스 서버 관리자가 한 번)

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

### 7-3. 관리 서버 쪽 키

- 터널 키: 관리 서버에서 `ssh-keygen -t ed25519 -N "" -f ~/paper_admin/secrets/tunnel_key -C paper-admin-tunnel`, 공개 키를 7-2의 3에 넣는다.
  `ssh-keyscan -t ed25519 <서비스 서버 주소> > ~/paper_admin/secrets/known_hosts` (지문은 서비스 서버의 `/etc/ssh/ssh_host_ed25519_key.pub`과 맞춰 본다).
  터널 컨테이너는 uid 1000으로 키를 읽는다 (EC2 Ubuntu의 ubuntu 사용자도 1000이라 0600 그대로 된다).
- 배포 기록 키 (서비스 배포 `deploy.yml`의 `record` 작업이 쓴다): `ssh-keygen -t ed25519 -N "" -f deploy_record_key -C deploy-record`. 관리 서버 `~/.ssh/authorized_keys`에 한 줄:
  ```
  restrict,command="python3 /home/ubuntu/paper_admin/deploy_record.py /home/ubuntu/paper_admin/records/deploys.jsonl" ssh-ed25519 AAAA... deploy-record
  ```
  이 키로는 배포 기록 한 줄을 더하는 것 말고 아무것도 못 한다. 저장소 설정에 넣는다:
  변수 `ADMIN_RECORD_HOST`(관리 서버 주소), `ADMIN_RECORD_HOST_KEY`(관리 서버 `/etc/ssh/ssh_host_ed25519_key.pub` 한 줄), `ADMIN_RECORD_USER`(기본 ubuntu),
  `DEPLOY_SERVER_NAME`(기본 `app`) · 비밀 값 `ADMIN_RECORD_SSH_KEY`(개인 키). 개인 키 파일은 넣은 뒤 지운다.

## 8. 검사·배포 (GitHub Actions)

| 작업 | 언제 | 하는 일 |
|---|---|---|
| `admin-ci.yml` | `admin/`·서비스 모델·마이그레이션·`reports/autohealing/stats.py`가 바뀐 main 아닌 브랜치 push·PR, 그리고 `admin-deploy.yml` 안에서 | server 린트·테스트, web 린트·타입·테스트·빌드, schema(서비스 마이그레이션을 건 PostgreSQL에서 읽기 전용 계정으로 모든 경로 200·쓰기 실패) |
| `admin-deploy.yml` | 같은 경로가 바뀐 main push | 검사 → 이미지 3개(`ghcr.io/shs5029/paper-trading-admin-{server,web,tunnel}:<커밋>`) → 관리 서버에 compose·스크립트 올리고 `remote_deploy.sh` (새 버전이 2분 안에 뜨지 않으면 직전 버전으로 되돌림) |

서비스 검사·배포(`ci.yml`, `deploy.yml`)와 따로 돈다. `admin/`만 바뀐 main push는 서비스를 다시 배포하지 않는다 (`deploy.yml`의 `paths-ignore`).

저장소 설정 (Settings → Secrets and variables → Actions):

| 종류 | 이름 | 값 |
|---|---|---|
| 변수 | `ADMIN_DEPLOY_ENABLED` | `true`면 배포한다 (없으면 검사만). 서비스 배포의 `DEPLOY_ENABLED`와 따로다 |
| 변수 | `ADMIN_HOST` · `ADMIN_USER` | 관리 서버 주소 · SSH 사용자(기본 ubuntu) |
| 변수 | `ADMIN_HOST_KEY` | 관리 서버 `/etc/ssh/ssh_host_ed25519_key.pub` 한 줄 |
| 비밀 값 | `ADMIN_DEPLOY_SSH_KEY` | 배포용 개인 키 (관리 서버 ubuntu의 `authorized_keys`에 공개 키). 관리자 개인 키와 따로 만든다 |

서버에서 보기: `ssh ubuntu@<관리 서버> "cd ~/paper_admin/app && docker compose --env-file ../.env ps && docker compose --env-file ../.env logs --tail 50 api tunnel"`
(배포 기록: `~/paper_admin/app/deploy_history.log`, 지금 태그·이미지 이름: `.deployed_tag`·`.deployed_prefix`).

## 9. 접속·공개 범위

- **화면**: `http://<관리 서버 퍼블릭 IP>/` 에서 서비스의 **staff 계정**으로 로그인한다 (staff가 아니면 들어오지 못한다).
- **MCP**: 토큰 만들기와 연결은 [3장](#3-mcp-서버).
- **공개 범위 (2026-10-08 사용자 결정)**: 80번을 모두에게 연다 (`ADMIN_HTTP_BIND=0.0.0.0`, `ADMIN_HTTP_PORT=80`). 처음 계획(SSH 터널로만, 밖에 여는 포트 22뿐)에서 바뀌었다.
  - HTTPS가 아니어서 로그인 비밀번호와 세션 쿠키가 암호화되지 않고 오간다. 공용 와이파이에서는 쓰지 않는다. 도메인을 붙이면 HTTPS로 바꾸고 `ADMIN_COOKIE_SECURE=on`.
  - 막는 것: staff 로그인, 아이디마다 10분에 5번(관리자 백엔드), IP마다 분당 10번(nginx `limit_req`), 조회 전용(DB 계정 권한).
  - 다시 터널로만 쓰려면 `.env`에서 `ADMIN_HTTP_BIND=127.0.0.1`, 보안 그룹 80을 닫고 `ssh -N -L 8080:127.0.0.1:80 ubuntu@<관리 서버>`.

## 10. 완료 기준 확인 (계획 6장)

| 기준 | 확인 방법 |
|---|---|
| F1~F9 화면, 관리자가 아니면 못 들어옴 | 화면 각 메뉴 · staff가 아닌 계정으로 로그인 → 401 |
| back을 멈추면 2분 안에 F3·F4에 표시 | 서비스 서버에서 `docker compose stop web engine` → F3은 다음 확인(30초)에 실패, F4는 마지막 동작 뒤 120초에 "멈춤" |
| MCP로 리포트 하나의 실행 기록을 시간순으로 | `report_trace` 도구 (`report_id`) |
| 쓰기 불가 (DB 권한으로도) | `readonly_role.sql`: SELECT만·열 단위·읽기 전용 트랜잭션 — `admin-ci.yml`의 schema 작업이 INSERT·UPDATE 실패를 확인한다 |
| 밖으로 열린 포트 | 22·80 (9장 결정으로 바뀜) · 보안 그룹 인바운드와 서버의 `ss -ltnp` |
