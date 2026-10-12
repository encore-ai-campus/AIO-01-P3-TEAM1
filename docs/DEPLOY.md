# 배포와 CI/CD

Docker 기반 파이프라인이다. **2026-10-06에 EC2를 연결했다** — 이제 `main`에 push하면 검사를 통과한 커밋이 자동 배포된다 (서버 현황은 0장).
정한 것: 배포 대상은 **AWS EC2(Ubuntu)에 SSH로 접속**, 배포 폴더는 **`/home/ubuntu/paper_trading`**, 서버의 `.env.docker`는 서버에서만 고친다.
관리 서버(EC2 ②, `admin/`)의 계획과 정한 것은 부록 A, 검토만 하고 채택하지 않은 서버 3대 분리 안은 부록 B다 (2026-10-12 합침 — `docs/DECISIONS.md` 32장).

## 0. 서버 현황 (2026-10-06 연결, 2026-10-12 갱신)

| 항목 | 값 |
|---|---|
| 주소 | `52.78.101.101` (`ec2-52-78-101-101.ap-northeast-2.compute.amazonaws.com`, 서울). 자동 할당 공인 IP라 인스턴스를 중지했다 시작하면 바뀐다 (9장) |
| 사양 | Ubuntu 26.04 LTS, 2 vCPU · 메모리 3.7GB(`t3.medium`급), 디스크 28GB |
| Docker | Docker Engine 29.8 + Compose v5.6 (docs.docker.com 저장소). `ubuntu`가 `docker` 그룹. 컨테이너 로그는 10MB × 5개로 돌린다 (`/etc/docker/daemon.json`) |
| SSH | 키 로그인만 (비밀번호·root 로그인 꺼짐). 관리자 접속 키는 저장소 루트의 `encore.pem`(git 제외, 팀장 PC에만). 파이프라인은 배포 전용 키(`DEPLOY_SSH_KEY`)를 쓴다 — 개인 키는 GitHub 비밀 값에만 있다 |
| GitHub | 변수 `DEPLOY_HOST`·`DEPLOY_USER`·`DEPLOY_DIR`·`DEPLOY_HOST_KEY`(ed25519)·`DEPLOY_ENABLED=true`, 비밀 값 `DEPLOY_SSH_KEY` |
| `.env.docker` | 0600. `DJANGO_SECRET_KEY`·`POSTGRES_PASSWORD`는 서버용 새 값, AI(DevPass)·DART 키는 팀 값. **비어 있음: `KIWOOM_APPKEY`·`KIWOOM_SECRETKEY`, `DATA_GOKR_API`, `DISCORD_WEBHOOK_URL`** |
| 시세 (임시) | **2026-10-06 사용자 결정으로 키움 키를 받기 전까지 토스 조회를 쓴다**. 2026-10-08부터 서버 `.env.docker`는 `BROKER=toss`·`CLIENT_ID`·`CLIENT_SECRET`·`ALLOW_TOSS_BROKER=on`, `DJANGO_DEBUG=off`다 (`docs/DECISIONS.md` 3-1 예외·23장 — 토스 때문에 운영 DEBUG를 켜 두지 않는다). 토스 개발자 화면에 서버 IP를 등록했다. 이전 파일은 서버의 `.env.docker.bak-20261006-061018`·`.env.docker.bak-20261008-030638`. 안전 규칙(`docs/DECISIONS.md` 3-1 — 운영은 키움만)과 어긋나는 임시 상태라 **키움 키를 받으면 `BROKER`·`CLIENT_*`·`ALLOW_TOSS_BROKER`를 지운다**. 토스 토큰은 클라이언트당 하나만 유효해서 같은 `CLIENT_ID`를 쓰는 다른 곳(이 PC의 `scripts/dev.sh` 등)과 서로 토큰을 무효로 만든다 (`token-revoked`) |
| 첫 배포 | 2026-10-06 Actions `Deploy` #37420279822 (수동 실행, 커밋 `d3325f2`): 검사 → 이미지 → 서버 배포 → 상태 확인 성공 |
| 자동 리포트 | **2026-10-07 18:44 KST 켬**: `.env.docker`에 `AUTO_REPORT=on`·`AUTO_REPORT_TOP=3`·`AUTO_REPORT_AT=08:00` (`AUTO_RECOMMEND=off` 그대로). 국내 거래일 08:00 이후 하루 한 번 선정 팀 → 종목 리포트. 이전 파일은 서버의 `.env.docker.bak-20261007-094439` (서버 시각 UTC). 켠 직후 그날 치 선정(#8)이 바로 돌았다 |
| 계정 | 개발 DB의 팀원 5개·관리자 1개(`team_accounts.txt`·`admin_account.txt`와 같은 아이디·비밀번호)를 2026-10-06에 운영 DB로 복사했다 (비밀번호 해시째, 닉네임·공개 설정 포함) |
| 남은 일 | 키움 키 + 키움에 서버 IP 등록 → 토스 임시 설정 되돌리기. HTTPS(443)는 없다 — 보안 그룹 `launch-wizard-1`은 2026-10-08부터 HTTP 80만 연다 |

`.env.docker`를 고친 뒤에는 서버에서 다시 띄우고 nginx도 다시 시작한다 (web이 새로 만들어지면 nginx가 예전 web 주소를 붙들고 있어 502가 난다):
`cd /home/ubuntu/paper_trading && export IMAGE_PREFIX=ghcr.io/shs5029/paper-trading IMAGE_TAG=$(cat .deployed_tag) && docker compose --env-file .env.docker up -d && docker compose --env-file .env.docker restart nginx`.

## 1. 흐름

```
push / PR ─▶ ci.yml ── 파이썬: ruff → 실주문 코드 0건 → pytest(SQLite) → 백테스트 → 마이그레이션 확인 → pytest(PostgreSQL)
                    ├─ 프론트: eslint → tsc → vitest → vite build
                    └─ 컨테이너: compose 검사 → 이미지 3개 빌드 → 스택 기동 → smoke_test.sh   (위 둘이 통과해야 돈다)

main에 push ─▶ deploy.yml ── 검사(ci.yml 전체) ──통과──▶ 이미지 올리기(GHCR, 태그 = 커밋 해시)
                                   │                          └─▶ 서버 배포(SSH): 받기 → 마이그레이션 → 띄우기 → 상태 확인
                                   └─ 실패 ─▶ 뒤 단계가 돌지 않는다 (배포 차단)        └─ 실패 ─▶ 직전 버전으로 되돌림
                            └─▶ 관리 서버 배포 기록 (success·rolled_back·rollback_failed·failed·blocked. 관리 서버 변수가 있을 때)
```

- 검사는 증권사·AI를 부르지 않고 저장소 비밀 값도 쓰지 않는다 (테스트는 가짜 객체, DB는 작업 안에서 띄운 것).
- 이미지 올리기와 서버 배포는 저장소 변수 `DEPLOY_ENABLED`가 `true`일 때만 돈다.
- 결과는 Actions 실행 결과(실행한 사람에게 GitHub 기본 실패 알림)와 관리 서버의 배포 기록으로 본다. 파이프라인 Discord 알림은 두지 않는다 (2026-10-08 사용자 결정, `docs/DECISIONS.md` 24장).

## 2. 파일

| 파일 | 내용 |
|---|---|
| `.github/workflows/ci.yml` | 검사. `main`이 아닌 브랜치의 push와 PR에서 돌고, `deploy.yml`이 불러 쓴다 |
| `.github/workflows/deploy.yml` | `main` push: 검사 → 이미지 올리기 → 서버 배포 → 관리 서버 배포 기록. Actions 화면에서 직접 실행할 수도 있다 |
| `deploy/Dockerfile` | 앱 이미지. `web`(Django + gunicorn)과 `engine`(`run_engine` + 리포트 PDF용 Chromium·한글 글꼴) 두 가지로 빌드한다 |
| `deploy/nginx/Dockerfile`, `default.conf` | React 빌드 파일을 내주고 `/api`, `/admin`을 web으로 넘긴다 (SSE 경로는 버퍼링 끔) |
| `deploy/docker-compose.yml` | 운영 구성: nginx · web · engine · migrate(한 번 돌고 끝) · db(PostgreSQL 16) · redis |
| `deploy/.env.docker.example` | 컨테이너용 설정의 틀. 복사한 `.env.docker`(git 제외)에 값을 채운다 |
| `deploy/remote_deploy.sh` | 서버에서 도는 배포 스크립트: 받기 → 띄우기 → 상태 확인 → 실패하면 되돌리기 |
| `deploy/smoke_test.sh` | 띄운 스택을 nginx를 거쳐 확인한다 (CI와 로컬용. 시험 계정을 만들었다 지우므로 운영 서버에서는 돌리지 않는다) |
| `.dockerignore` (저장소 루트) | 빌드 컨텍스트에서 `.env`, 계정 파일, 실행 데이터, 테스트를 뺀다 |

컨테이너는 root가 아닌 사용자로 돌고, 파일 시스템은 읽기 전용이다 (쓰는 곳은 `/data` 볼륨과 `/tmp`뿐).
DB와 Redis 포트는 밖으로 열지 않는다. 밖에서 들어오는 길은 nginx 하나다.

## 3. 이 PC에서 운영 구성 띄워 보기

```bash
cd deploy
cp .env.docker.example .env.docker      # DJANGO_SECRET_KEY, POSTGRES_PASSWORD를 채운다. 80을 쓸 수 없으면 HTTP_PORT=8088처럼
docker compose --env-file .env.docker up -d --build
./smoke_test.sh                          # 상태 확인, 화면, CSRF·로그인, 엔진의 PDF 생성
docker compose --env-file .env.docker down        # 데이터까지 지우려면 down -v
```

`scripts/dev.sh`로 띄운 개발 서버·개발 DB와는 따로 돈다 (프로젝트 이름 `paper-trading`, 개발 DB는 `paper-dev`).

## 4. 서버 준비 (한 번)

계획한 사양은 Ubuntu, `t3.medium`, 디스크 30GB 이상이다 (`docs/plans/TEAM_PAPER_TRADING_PLAN.md` 2-2).

1. **방화벽(보안 그룹)**: 80(HTTP)을 연다. 22(SSH)는 GitHub Actions가 접속할 수 있어야 한다 — GitHub 실행기의 IP는 고정이 아니므로
   22를 전체에 열고 **키 로그인만 허용**한다 (비밀번호 로그인 끔). DB(5432)와 Redis(6379)는 열지 않는다.
2. **Docker 설치** (Docker Engine + Compose 플러그인. docs.docker.com의 Ubuntu 설치 절차). 배포에 쓰는 사용자를 `docker` 그룹에 넣는다:
   `sudo usermod -aG docker $USER` 후 다시 로그인.
3. **배포 전용 SSH 키**: 자기 PC에서 `ssh-keygen -t ed25519 -f paper_deploy_key -N ''`. 공개 키(`paper_deploy_key.pub`)를 서버의
   `~/.ssh/authorized_keys`에 더한다. 개인 키는 GitHub 비밀 값으로만 넣고(5장) PC에서는 지운다. 서버 접속에 쓰는 개인 키를 그대로 넣지 않는다.
4. **배포 폴더와 `.env.docker`**: 서버에 폴더를 만들고(`mkdir -p /home/ubuntu/paper_trading`) `deploy/.env.docker.example`을 복사해
   `.env.docker`로 저장한 뒤 값을 채운다. `chmod 600 .env.docker`. 이 파일은 파이프라인이 만들거나 바꾸지 않는다.
   - `DJANGO_SECRET_KEY`, `POSTGRES_PASSWORD`: 긴 임의 값 (`python3 -c "import secrets; print(secrets.token_urlsafe(48))"`)
   - `DJANGO_ALLOWED_HOSTS`: 접속에 쓰는 공인 IP·도메인
   - `KIWOOM_APPKEY`, `KIWOOM_SECRETKEY`, `DEVPASS_APIKEY`, `ANALYSTS` 등: 팀에서 쓰는 값. 키움은 앱키에 서버 IP 등록이 필요할 수 있다
   - `BROKER`, `CLIENT_ID`, `CLIENT_SECRET`(토스 조회)은 넣지 않는다 (개발 전용. `DJANGO_DEBUG=off`에서는 꺼진다)
5. **서버의 호스트 키 확인**: 서버에서 `cat /etc/ssh/ssh_host_ed25519_key.pub`. 이 한 줄을 5장의 `DEPLOY_HOST_KEY`에 넣는다
   (파이프라인은 이 키와 맞는 서버에만 접속한다. 접속하면서 키를 받아 와 믿지 않는다).

## 5. GitHub 설정

저장소 → Settings → Secrets and variables → Actions.

| 종류 | 이름 | 값 |
|---|---|---|
| 변수 | `DEPLOY_HOST` | 서버의 공인 IP 또는 도메인 |
| 변수 | `DEPLOY_USER` | SSH 로그인 사용자 (Ubuntu AMI는 `ubuntu`, Amazon Linux는 `ec2-user`) |
| 변수 | `DEPLOY_DIR` | 서버의 배포 폴더 전체 경로 (`~` 없이): `/home/ubuntu/paper_trading` |
| 변수 | `DEPLOY_HOST_KEY` | 4장 5번의 호스트 공개 키 한 줄 (`ssh-ed25519 AAAA...`) |
| 변수 | `DEPLOY_PORT` | (선택) SSH 포트. 비우면 22 |
| 비밀 값 | `DEPLOY_SSH_KEY` | 4장 3번의 개인 키 파일 내용 전체 |
| 변수 | `DEPLOY_ENABLED` | 위를 다 넣은 뒤 `true`. 이 값이 `true`가 아니면 검사만 돈다 |
| 변수·비밀 값 | `ADMIN_RECORD_HOST`, `ADMIN_RECORD_HOST_KEY`, `ADMIN_RECORD_USER`, `DEPLOY_SERVER_NAME` · `ADMIN_RECORD_SSH_KEY` | (선택) 관리 서버에 배포 결과 한 줄을 남긴다 (`record` 작업). 관리 서버를 준비했을 때만 — `admin/README.md` 7-3 |

`gh`로 넣을 때 (값이 화면에 남지 않게 파일·입력으로 준다):

```bash
gh variable set DEPLOY_HOST --body "<IP>"
gh variable set DEPLOY_USER --body "ubuntu"
gh variable set DEPLOY_DIR --body "/home/ubuntu/paper_trading"
gh variable set DEPLOY_HOST_KEY --body "ssh-ed25519 AAAA..."
gh secret set DEPLOY_SSH_KEY < paper_deploy_key
gh variable set DEPLOY_ENABLED --body "true"
```

이미지는 GHCR(`ghcr.io/<저장소 소유자>/paper-trading-{nginx,web,engine}:<커밋 해시>`)에 올라간다. 따로 만들 토큰은 없다:
워크플로의 `GITHUB_TOKEN`으로 올리고, 서버에는 그 토큰(작업이 끝나면 못 쓰게 됨)으로 잠깐 로그인해 받은 뒤 로그아웃한다.

## 6. 배포가 하는 일과 되돌리기

`deploy.yml`이 `docker-compose.yml`과 `remote_deploy.sh`를 서버의 배포 폴더에 올리고 실행한다.

1. 새 태그의 이미지 3개를 받는다. 받지 못하면 아무것도 바꾸지 않고 실패로 끝난다 (돌던 버전 그대로).
2. `docker compose up -d`: `migrate`가 성공해야 web·engine이 뜨고, web이 `/api/health`에 답해야 nginx가 뜬다.
3. nginx를 거쳐 `/api/health`와 `/`를 확인한다 (최대 2분).
4. 성공하면 태그를 `.deployed_tag`에 적고, 지금 버전과 직전 버전 이미지만 남기고 지운다.
5. 2~3에서 실패하면 로그를 남기고 **직전에 성공한 태그로 다시 띄운 뒤 실패로 끝난다.** 결과는 `deploy_history.log`에 한 줄씩 쌓인다.
6. 마지막에 `DEPLOY_RESULT=<success|rolled_back|rollback_failed|failed> PREVIOUS=<직전 태그>` 줄을 출력한다. `deploy.yml`의 `record` 작업이 이 결과(검사 실패면 `blocked`)를 관리 서버의 배포 기록으로 보낸다 (`admin/API.md` 5-2).

- DB 마이그레이션은 되돌리지 않는다. 되돌릴 수 없는 모델 변경(열 삭제 등)은 "코드가 안 쓰게 하는 배포"와 "지우는 배포"로 나눈다.
- 손으로 직전 버전으로 돌리기 (서버에서, 이미지가 남아 있는 직전 태그에 한해):
  `cd <배포 폴더> && IMAGE_PREFIX=ghcr.io/<소유자>/paper-trading IMAGE_TAG=<커밋 해시> bash remote_deploy.sh`
- 더 예전 버전은 그 커밋을 `git revert`해서 `main`에 push한다 (같은 파이프라인으로 나간다).

## 7. 첫 배포 뒤 서버에서

```bash
cd <배포 폴더>
dc() { IMAGE_PREFIX=ghcr.io/<소유자>/paper-trading IMAGE_TAG=$(cat .deployed_tag) docker compose --env-file .env.docker "$@"; }
dc exec web python manage.py create_team_accounts --out /data/team_accounts.txt   # 팀원 계정 5개 (비밀번호는 파일에만)
dc exec web cat /data/team_accounts.txt
dc exec web python manage.py createsuperuser        # 관리자 화면(/admin)
dc ps                                               # 상태
dc logs -f engine                                   # 로그 (web, nginx, migrate도 같은 식)
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > backup.sql     # DB 백업
```

## 8. 배포 차단을 확인하는 방법 (평가 체크리스트)

1. 테스트 하나를 일부러 깨뜨려 `main`에 push한다 (예: `assert False`를 넣은 커밋).
2. Actions에서 `Deploy` 실행을 연다: `검사`가 실패하고 `이미지 올리기`, `서버 배포`가 건너뛰어진 것을 확인한다. 관리 서버의 배포 기록에는 `blocked`가 남는다.
3. 서버의 `.deployed_tag`와 화면이 그대로인 것을 확인하고, 되돌리는 커밋을 push한다.
4. 실행 번호, 커밋, 시각, 링크를 보고서에 적는다 (`docs/plans/TEAM_PAPER_TRADING_PLAN.md` 부록 A7).

서버에서 새 버전이 뜨지 않을 때의 되돌리기는 2026-10-02에 이 PC에서 확인했다 (로컬 레지스트리에 정상 이미지와 web이 죽는 이미지를 올려
`remote_deploy.sh`를 실행: 정상 → 성공, 고장 → 실패로 끝나고 정상 버전으로 복귀).

## 9. 알아 둘 것

- **서버 IP가 바뀌면** (자동 할당 공인 IP는 인스턴스를 중지했다 시작하면 바뀐다): `DEPLOY_HOST`, `.env.docker`의 `DJANGO_ALLOWED_HOSTS`,
  키움 IP 등록, 팀원 접속 주소를 고친다. `DEPLOY_HOST_KEY`는 그대로 둔다 (서버를 새로 만들었을 때만 바뀐다).
- **HTTPS는 아직 없다** (도메인 없이 IP + HTTP로 시작하는 계획). 도메인이 생기면 nginx 앞에 인증서를 붙이고 Django의 보안 쿠키 설정을 켠다.
- **web은 프로세스 하나에 스레드 16개**로 돈다. 시세 캐시와 증권사 호출 간격 조절이 프로세스별이라 프로세스를 늘리면 증권사 호출이 늘어난다
  (`docs/DECISIONS.md` 8-6). 늘리려면 먼저 캐시를 Redis로 옮긴다.
- **엔진 컨테이너에 openclaw는 없다.** 엔진의 Discord 알림(`OPENCLAW_TARGET`)은 콘솔로 나간다. 리포트 발송 방법은 `docs/plans/TEAM_PAPER_TRADING_PLAN.md` 부록 A6-4에서 정한다.
- **비공개 저장소**라 Actions 실행 시간이 계정 한도에서 빠진다 (검사 한 번에 몇 분). 문서만 고친 커밋도 검사가 돈다.
- 엔진 이미지는 Chromium과 한글 글꼴 때문에 크다 (1GB 이상). 서버 디스크가 작으면 `docker system df`로 확인한다.

---

## 부록 A. 관리자 페이지 계획서 (구현됨 — `admin/`)

> 옛 `docs/plans/OPS_ADMIN_PLAN.md` (2026-10-12 이 문서에 합침 — `docs/DECISIONS.md` 32장). 이 부록 안의 "n장"·"n-m"은 부록 An·An-m을 가리킨다.

> 상태: 계획 (2026-10-07). 서비스와 따로 두는 관리 서버에서 도는 관리자 페이지에 꼭 있어야 할 기능만 적는다.
> **구현 (2026-10-08)**: 코드는 `admin/`(계약 `admin/API.md`, 설치·사용 `admin/README.md`), 정한 것은 8장. 관리 서버는 http://54.116.203.153 에서 돈다.

### A1. 구성

| 구성 요소 | 하는 일 |
|---|---|
| 관리자 프론트 | 관리자 화면 |
| 관리자 백엔드 | 서비스 DB를 읽어 화면과 MCP에 숫자를 준다. 기술은 자유롭게 고른다 (Django가 아니어도 된다) |
| MCP 서버 | 같은 데이터를 AI 도구(Claude Code 등)에서 조회할 수 있게 한다 |

세 가지는 서비스와 따로 두는 관리 서버에서 함께 실행한다.

- 조회가 중심이다. 쓰기 기능은 없다 (4장). 예외 둘: 관리자 화면의 MCP 토큰 만들기 — 관리 서버 자기 파일에만 쓴다 (2026-10-12, `admin/API.md` 6-1).
  **장애 주입 신청**(F11) — 서비스 DB에 쓰지 않고, 서명한 요청을 SSH 터널로 서비스 내부 API에 보낸다 (2026-10-12, `docs/DECISIONS.md` 35장, `admin/API.md` 7장).
- 숫자는 관리자 백엔드 한 곳에서만 만든다. 그래서 화면과 MCP가 같은 숫자를 보여 준다.
- 인터넷에 열지 않는다. 관리자는 SSH 터널로 접속한다.

### A2. 관리자 페이지 필수 기능

| # | 기능 | 화면에서 보는 것 |
|---|---|---|
| F1 | 로그인·권한 | 서비스의 관리자(staff) 계정으로만 로그인한다. 그 밖의 계정은 거부한다 |
| F2 | 개요 | F3~F9를 한 화면에 요약하고, 문제가 있는 항목을 먼저 보여 준다 |
| F3 | 서비스 상태 | 서비스 주소가 응답하는지와 응답 시간 |
| F4 | 엔진 상태 | 엔진이 마지막으로 동작한 시각(2분 넘게 동작이 없으면 "멈춤"), 실행 중인 버전, 새 모의 매수 중단 스위치, 최근 단계 오류 |
| F5 | 배포 기록 | 서버별 지금 버전과, 배포 성공·실패·되돌림 목록 |
| F6 | 리포트 장애 | 기간별 실패·복구·장애 주입 리포트 목록. 하나를 고르면 실행 기록(재시도, 대체 모델 전환, 포기)을 시간순으로 보여 준다 |
| F7 | 복구 지표 | 자동 복구율과 평균 복구시간 (담당 4의 셈법 그대로, `docs/tasks/00-공통.md` 9절) |
| F8 | AI 비용 | 날짜별 비용 합계(리포트·분석·장기투자)와 하루 한도 대비 사용량 |
| F9 | 알림·작업 실패 | Discord 발송 실패, 오래 멈춰 있는 엔진 작업 |
| F11 | 장애 주입 (2026-10-12) | 종목·프리셋(복구 시연·정책 시연)·직접 설정으로 장애 주입 실행을 신청하고, 최근 장애 주입 실행을 본다. 리포트 상세에서 같은 설정으로 다시 신청한다. 서비스 화면에는 장애 주입이 없다 (`docs/DECISIONS.md` 35장) |

### A3. MCP 서버 필수 도구

- F2~F9와 같은 데이터를 도구로 제공한다: 개요, 서비스 상태, 엔진 상태, 배포 기록, 리포트 장애 목록, 리포트 실행 기록, 복구 지표, AI 비용, 알림·작업 실패.
- 모든 도구는 조회 전용이다 (F11 장애 주입도 MCP 도구로 만들지 않는다 — AI 도구가 비용이 드는 실행을 일으키지 않게).
- 사람마다 따로 토큰을 주고, 누가 어떤 도구를 불렀는지 기록한다.

### A4. 하지 않는 것

- 쓰기 작업: 중단 스위치 켜고 끄기, 계정 관리, 리포트 다시 실행, 주문. 이런 일은 지금 쓰는 수단(서비스 웹, Django 관리자 `/admin`, 엔진 CLI)으로 한다.
  (장애 주입 신청은 2026-10-12부터 관리 서버에서만 한다 — F11, `docs/DECISIONS.md` 35장)
- 컨테이너 로그 수집 (로그는 SSH로 본다).
- 비밀번호, 세션, 비밀 키 같은 개인 정보와 비밀 값 표시.

### A5. 먼저 필요한 것

| 필요한 것 | 쓰는 기능 | 이유 |
|---|---|---|
| 엔진이 상태를 남기기 | F4 | 지금 운영 엔진 루프(`run_engine`)는 생존 신호나 상태를 남기지 않는다. 30초마다 상태를 DB에 기록하게 한다 |
| 배포 결과를 관리 서버로 모으기 | F5 | 배포 기록이 서버마다 파일로 흩어져 있다. GitHub Actions가 배포할 때마다 결과 한 줄을 관리 서버에 남기게 한다 |
| 관리 서버에서 서비스 DB로 가는 길 | F1, F4, F6~F9 | 운영 DB 포트는 밖으로 열지 않는다. 서비스 서버 안(`127.0.0.1`)에만 열고 관리 서버가 SSH 터널(그 포트만 허용한 전용 키)로 붙는다 |
| 엔진 쪽 한도 값 | F8 | 하루 한도(`AI_DAILY_BUDGET_USD` 등)는 서비스 설정에만 있다. 엔진 상태 기록에 비밀이 아닌 한도 값을 같이 남긴다 |
| DB 읽기 전용 계정 | F1, F4, F6~F9 | 필요한 표만 SELECT할 수 있는 계정을 만든다 |
| 복구 지표 셈법 | F7 | 담당 4의 T4-7. 관리자 백엔드가 Django가 아니면 같은 셈법을 옮겨 구현하고, 같은 숫자가 나오는지 테스트로 확인한다 |

관리자 백엔드를 Django가 아닌 기술로 만들면 F1의 로그인에서 Django 비밀번호 해시 형식(`pbkdf2_sha256$반복 횟수$솔트$해시`)을 직접 검증해야 한다.

### A6. 완료 기준

- [ ] F1~F9가 화면에서 동작하고, 관리자가 아닌 계정은 들어오지 못한다
- [ ] 서비스 back을 멈추면 2분 안에 F3·F4에 문제가 표시된다
- [ ] MCP에서 리포트 하나의 실행 기록을 시간순으로 조회할 수 있다
- [ ] 관리자 페이지와 MCP가 서비스 DB에 쓰기를 할 수 없다 (DB 계정 권한으로도 막혀 있다). 장애 주입 신청(F11)은 세션 쿠키로만, 서비스 내부 API로만 한다 (MCP 토큰이면 `403`)
- [ ] 관리 서버에서 밖으로 열린 포트가 SSH(22)와 관리자 화면(80)뿐이다 (8장 공개 범위 결정으로 바뀜)

### A7. 유저 프론트와 분리

관리자 프론트는 유저 프론트(`frontend/`)와 완전히 따로 둔다.

| 나누는 것 | 방법 |
|---|---|
| 코드 | 저장소 루트의 `admin/`: 프론트 `admin/web/`(자기 `package.json`), 백엔드·MCP `admin/server/`(자기 uv 프로젝트), 배포 `admin/deploy/`. `frontend/`·`backend/`와 서로 import하지 않는다 |
| API | 관리자 백엔드의 `/api/admin/*`만 부른다. 서비스 API는 부르지 않는다. 계약은 `admin/API.md`에 따로 쓴다 |
| 빌드·검사 | CI에 관리자 앱 작업(린트·타입·테스트·빌드)을 따로 둔다. 관리자 앱을 고쳐도 유저 앱 검사·배포에 영향이 없다 |
| 배포 | 관리 서버에만 올린다. 유저 번들에 관리자 코드가 들어가지 않는다 |
| 화면 규칙 | 유저 앱의 규칙(주린이모드, 금지 표현, 모바일 하단 탭, 모션)을 따르지 않는다. 표와 필터 위주로 단순하게 만든다 |
| 로그인 | 서비스 staff 계정을 그대로 쓴다 (2026-10-08 정함, F1). 관리 서버는 staff 행만 내는 뷰 `admin_staff_accounts`만 읽을 수 있어 staff가 아닌 사용자의 비밀번호 해시는 읽지 못한다 |

#### A7-1. 작업 순서

1. 관리자 API 계약 `admin/API.md`
2. 관리자 앱 `admin/`: F1~F9 화면, 가짜 API(MSW)로 개발·테스트, CI 작업
3. 관리자 백엔드와 5장의 선행 작업
4. MCP 서버
5. 관리 서버에 배포

### A8. 구현하며 정한 것 (2026-10-08)

| 항목 | 정한 것 | 이유 |
|---|---|---|
| 관리자 백엔드 기술 | Python FastAPI + psycopg (Django 아님). MCP는 공식 MCP Python SDK의 streamable HTTP | 서비스 코드에 기대지 않고 가볍게. 팀이 아는 언어 |
| MCP와 숫자 | MCP 서버는 DB에 붙지 않고 관리자 백엔드 API를 부른다 (호출자의 토큰과 도구 이름을 넘긴다) | 숫자를 한 곳에서만 만든다. 토큰 확인·감사 기록도 백엔드 한 곳 |
| 로그인·토큰 | 서비스 staff 계정(Django 해시를 직접 검증) · MCP는 사람별 토큰(관리 서버에 해시만, 화면의 토큰 생성 또는 CLI로 만든다), 호출마다 감사 기록 | 7장 로그인 결정 |
| DB 권한 | 읽기 전용 계정에 필요한 열만 SELECT (`admin/deploy/readonly_role.sql`) + 읽기 전용 트랜잭션 | 쓰기와 개인 정보(본문·사용자 표)를 권한으로 막는다 |
| 엔진 상태 | `engine_status` 표 (`trading` 0004), `run_engine`이 30초마다. 버전은 이미지 태그(`APP_VERSION`) | 5장 |
| 배포 기록 | `deploy.yml`의 `record` 작업이 강제 명령 키로 관리 서버에 한 줄 (`검사 실패`도 `blocked`로) | 그 키로는 기록 한 줄만 쓸 수 있다 |
| 복구 셈법 | `admin/recovery_cases.json` 기준 사례를 관리자 백엔드와 서비스(`reports.autohealing.stats`) 테스트가 같이 읽는다 | 5장 "같은 숫자" |
| 검사·배포 | `admin-ci.yml`(서비스 스키마에서 읽기 전용 확인 포함)·`admin-deploy.yml`(main의 `admin/` 변경 → GHCR 이미지 `paper-trading-admin-*` → 관리 서버). 서비스 `ci.yml`·`deploy.yml`과 따로 돌고, `admin/`만 바뀐 push는 서비스를 다시 배포하지 않는다 | 7장 |
| 저장소 (2026-10-08 사용자 결정) | 같은 날 `admin/`을 별도 비공개 저장소 `SHS5029/paper_admin`으로 뺐다가, 다시 이 저장소의 `admin/`으로 합쳤다 (`git subtree`로 그 저장소 이력 포함). 그 저장소의 배포는 끄고(`DEPLOY_ENABLED=false`) 더 쓰지 않는다 | 한 저장소에서 서비스와 같이 고치고 검사한다. 검사·배포는 위처럼 따로 |
| 공개 범위 (2026-10-08 사용자 결정) | 관리자 화면·MCP를 관리 서버 퍼블릭 IP의 80번으로 **모두에게** 연다 (처음 계획은 SSH 터널로만, 밖에 여는 포트 22뿐). HTTPS 없음 — 도메인을 붙이면 HTTPS로 바꾼다. 로그인은 IP별(nginx)·아이디별(백엔드) 속도 제한 | 퍼블릭 IP 링크로 바로 열기 |

---

## 부록 B. 배포 분리 계획: front · back · infra 서버 3대 (AWS 계정 3개) (채택 안 함)

> 옛 `docs/plans/DEPLOY_SPLIT_PLAN.md` (2026-10-12 이 문서에 합침 — `docs/DECISIONS.md` 32장). 이 부록 안의 "n장"·"n-m"은 부록 Bn·Bn-m을 가리킨다.

> 상태: **채택 안 함** (2026-10-07 계획). 코드와 서버는 이 계획대로 바꾸지 않았다. 운영은 EC2 한 대에서 컨테이너 5개를 돌리고(본문), 관리 서버만 따로 둔다(부록 A).
> 채택하게 되면 B8의 문서를 고친다.

### B0. 한눈에

```
                    인터넷
                      │ 80 (HTTPS를 붙이면 443)
          ┌───────────▼───────────┐  계정 A · VPC 10.10.0.0/16 · 탄력적 IP (접속 주소)
          │ front   10.10.1.10    │  nginx: React 빌드 파일, /api·/admin·/static → back
          └───────────┬───────────┘
                      │ 피어링 A↔B · 8000만
          ┌───────────▼───────────┐  계정 B · VPC 10.20.0.0/16 · 탄력적 IP (키움 IP 등록)
          │ back    10.20.1.10    │  migrate(한 번) → web(Django + gunicorn), engine(run_engine + Chromium)
          └───────────┬───────────┘
                      │ 피어링 B↔C · 5432·6379만
          ┌───────────▼───────────┐  계정 C · VPC 10.30.0.0/16
          │ infra   10.30.1.10    │  PostgreSQL 16, Redis 7
          └───────────────────────┘
```

정한 것 (이유는 각 장에 적었다):

1. **나누는 단위**: front = nginx, back = web + engine, infra = PostgreSQL + Redis. web과 engine은 `/data`를 같이 쓰므로 한 서버에 둔다 (2장).
2. **서버 사이 통신은 계정 간 VPC 피어링으로 한다** (같은 리전, 같은 AZ ID). 피어링은 다른 피어링을 거쳐 이어지지 않으므로(non-transitive) front에서 DB로 가는 길이 아예 없다 (3장).
3. **비밀 값은 back과 infra에만 둔다.** front에는 비밀 값이 하나도 없다.
4. **GitHub Actions는 지금처럼 SSH로 배포한다** (서버마다 배포 키를 따로 둔다). AWS 권한이 필요 없으므로 계정이 달라도 그대로 쓸 수 있다.
   순서는 back → front이고, infra는 손으로 배포한다 (4-5).
5. 레지스트리(GHCR), 이미지 3개, 커밋 해시 태그, 서버 스크립트의 되돌리기 방식은 그대로 둔다.

### B1. 전제 (확정할 것)

| # | 가정 | 가정과 다를 때 |
|---|---|---|
| P1 | infra는 상태를 가진 것(PostgreSQL·Redis)만 둔다. 모니터링·CI 실행기는 넣지 않는다 | 2장 표에 열을 더한다 |
| P2 | 세 계정 모두 서울 리전(`ap-northeast-2`)을 쓴다 | 리전 간 피어링은 되지만 보안 그룹에서 상대 SG를 가리킬 수 없어 CIDR로 연다. 지연도 늘어난다 |
| P3 | 지금처럼 도메인·HTTPS 없이 front 공인 IP + HTTP로 시작한다 | 도메인이 생기면 인증서는 front에만 붙인다 |
| P4 | 각 계정 주인(팀원)이 자기 계정의 네트워크·인스턴스를 만들고, 서버 안의 작업(Docker, `.env.docker`)은 팀장이 SSH로 한다 | 5장의 담당만 바꾼다 |

### B2. 서버별 구성

| | front | back | infra |
|---|---|---|---|
| 컨테이너 | nginx | migrate(한 번) · web · engine | db(`postgres:16`) · redis(`redis:7`) |
| 이미지 | `paper-trading-nginx` | `paper-trading-web`, `paper-trading-engine` | Docker Hub 공식 이미지 |
| 받는 연결 | 인터넷에서 80 | front에서 8000 | back에서 5432·6379 |
| 나가는 연결 | back 8000 | infra, 키움·DevPass·DART·data.go.kr·SEC·뉴스 RSS·Discord | 이미지·패키지 받기뿐 |
| 비밀 값 | 없음 | Django 비밀키, DB·Redis 비밀번호, 키움·AI·DART·Discord | DB·Redis 비밀번호 |
| 공인 IP | 탄력적 IP (접속 주소) | 탄력적 IP (키움 IP 등록, 배포 SSH 주소) | 자동 할당 (바뀌어도 된다) |
| 배포 | Actions (`main` push마다) | Actions (`main` push마다) | 손으로 (이미지 버전·설정을 바꿀 때만) |
| 사양 (제안) | `t3.micro`, gp3 10GB | `t3.small` + swap 2GB, gp3 20GB | `t3.micro` + swap 1GB, gp3 20GB |

**사양 근거**: 2026-10-07 지금 운영 서버에서 `docker stats`로 한 번 잰 값이다 (사용자가 거의 없는 상태).
nginx 3MB, web 78MB, engine 59MB, db 32MB, redis 5MB. 호스트 전체 사용량은 907MB / 3.8GB, 이미지는 3.4GB(지금 버전 + 직전 버전)다.

- back은 engine이 리포트 PDF를 만들 때 Chromium이 수백 MB를 더 쓴다. engine 이미지도 1GB가 넘는데 두 버전을 남겨 두므로 메모리 2GB에 swap을 더하고 디스크는 20GB로 잡는다.
- 잰 순간 web의 CPU 사용률이 43%(코어 하나 기준)였다. t3는 기본 성능을 넘으면 CPU 크레딧을 쓴다. 지금 서버의 CloudWatch `CPUCreditBalance`를
  며칠 지켜본 뒤 back 크기를 정한다 (크레딧이 계속 줄면 `t3.medium`).
- t3 요금은 크기에 비례한다(micro 1 : small 2 : medium 4). 그래서 micro + small + micro는 지금의 `t3.medium` 한 대와 비슷하다.
  늘어나는 비용은 공인 IPv4(시간당 요금, 3개)와 디스크 3개분이다.

**web과 engine을 나누지 않는 이유**: 둘이 `/data` 볼륨(`PAPER_ROOT`)을 같이 쓴다. 이 볼륨에는 AI 실행 기록(`runs/`, web이 색인해 화면에 보여 준다),
리포트 PDF(`reports/`), 자동 추천 표시(`runs/autotrade/`), 중단 스위치와 주문 잠금(`data/`)이 들어 있다 (`docs/DECISIONS.md` 11장).
둘을 나누려면 공유 파일 시스템(EFS 등)이 있어야 하는데, 계정이 다르면 그만큼 더 복잡해진다.

### B3. 네트워크 (계정이 달라서 생기는 일)

#### B3-1. VPC와 주소: 계정마다 VPC를 새로 만든다

모든 계정의 기본 VPC는 `172.31.0.0/16`으로 주소가 같다. 주소가 겹치는 VPC끼리는 피어링할 수 없으므로 계정마다 아래 주소로 VPC를 새로 만든다.

| 서버 | 계정 | VPC CIDR | 공개 서브넷 | 사설 IP (고정) | AZ ID |
|---|---|---|---|---|---|
| front | A | `10.10.0.0/16` | `10.10.1.0/24` | `10.10.1.10` | `apne2-az1` |
| back | B | `10.20.0.0/16` | `10.20.1.0/24` | `10.20.1.10` | `apne2-az1` |
| infra | C | `10.30.0.0/16` | `10.30.1.0/24` | `10.30.1.10` | `apne2-az1` |

- 서브넷마다 인터넷 게이트웨이로 가는 경로(`0.0.0.0/0`)를 둔다. 공개 서브넷 하나로 충분하고, NAT 게이트웨이는 비싸서 쓰지 않는다.
- **AZ는 이름이 아니라 ID로 맞춘다.** `ap-northeast-2a`라는 이름이 가리키는 실제 AZ는 계정마다 다르다. 서브넷을 만들 때 AZ ID(`apne2-az1`)를 보고 고른다.
  같은 AZ 안에서 피어링으로 주고받는 데이터에는 전송 요금이 붙지 않고 지연도 가장 짧다 (web은 DB를 자주 부른다).
- 사설 IP는 인스턴스를 만들 때 지정한다. 중지했다 시작해도 바뀌지 않는다 (종료하고 새로 만들면 다시 지정한다).

#### B3-2. 피어링 2개

| 연결 | 요청하는 계정 | 수락하는 계정 | 라우팅 테이블에 더할 경로 |
|---|---|---|---|
| front ↔ back | A | B | A: `10.20.0.0/16` → 피어링, B: `10.10.0.0/16` → 피어링 |
| back ↔ infra | C | B | C: `10.20.0.0/16` → 피어링, B: `10.30.0.0/16` → 피어링 |

- 요청하는 쪽은 상대의 **계정 ID와 VPC ID**를 알아야 한다. 수락은 상대 계정의 콘솔에서 한다 (요청한 뒤 7일 안에).
- front ↔ infra 피어링은 만들지 않는다. 피어링은 back을 거쳐 이어지지 않으므로 front에서 infra로 가는 길이 생기지 않는다.
- 사설 IP로만 부르므로 피어링의 DNS 옵션은 켜지 않아도 된다.

#### B3-3. 보안 그룹

| 서버 | 받는 포트 | 출처 |
|---|---|---|
| front | 80/tcp | `0.0.0.0/0` (HTTPS를 붙이면 443도) |
| front | 22/tcp | `0.0.0.0/0`: Actions 실행기 IP가 고정이 아니어서다. 키 로그인만 받는다 (지금 서버와 같다) |
| back | 8000/tcp | front의 보안 그룹(`<계정 A ID>/sg-…`) 또는 `10.10.1.0/24` |
| back | 22/tcp | `0.0.0.0/0`, 키 로그인만 |
| infra | 5432/tcp, 6379/tcp | back의 보안 그룹(`<계정 B ID>/sg-…`) 또는 `10.20.1.0/24` |
| infra | 22/tcp | back의 보안 그룹만. 관리자는 back을 거쳐 들어간다: `ssh -J ubuntu@<back IP> ubuntu@10.30.1.10` |

- 같은 리전에서 피어링했으면 상대 계정의 보안 그룹을 출처로 쓸 수 있다. 그게 안 되면 상대 서브넷 CIDR을 쓴다. 나가는 연결은 모두 허용한다 (기본값).
- EC2 인스턴스 안에서는 공인 IP가 보이지 않고, 밖에서 오는 연결도 사설 IP로 들어온다. 그래서 컨테이너 포트를 사설 IP에만 연결해도
  (`10.30.1.10:5432:5432`) 인터넷에서 막히지는 않는다. **막는 것은 보안 그룹이다.** 사설 IP에 연결하면 Docker 브리지 같은 다른 인터페이스로 포트가 열리지 않는 정도의 효과만 있다.

#### B3-4. 피어링을 할 수 없을 때 (권장하지 않음)

계정 주인끼리 피어링을 맞추지 못하면 서버끼리 공인 IP로 연결하고, 보안 그룹의 출처를 상대의 탄력적 IP/32로 좁혀야 한다.
그런데 엔진의 Redis 클라이언트(`engine/paper_engine/records/redis_client.py`)는 TLS(`rediss://`)를 지원하지 않는다. 이대로면 Redis 비밀번호와 데이터가
암호화되지 않은 채 인터넷을 지난다. 이 방법을 쓰려면 back ↔ infra 사이에 WireGuard 터널을 두고 PostgreSQL과 Redis를 그 터널로 보내야 하며, infra에도 탄력적 IP가 있어야 한다.

### B4. 바꿀 것 (구현 계획)

#### B4-1. compose 파일을 서버별로 나눈다

```
deploy/
  front/compose.yml   front/.env.docker.example     nginx
  back/compose.yml    back/.env.docker.example      migrate · web · engine
  infra/compose.yml   infra/.env.docker.example     db · redis
  docker-compose.yml  위 셋을 include한 한 대짜리 구성 (CI와 이 PC에서 확인할 때. smoke_test.sh가 쓴다)
  remote_deploy.sh    ROLE=front|back
```

- 서버 주소는 환경 변수로 받는다. 기본값은 한 대짜리 구성의 컨테이너 이름으로 둔다: `BACKEND_UPSTREAM=${BACKEND_UPSTREAM:-web:8000}`,
  `POSTGRES_HOST=${POSTGRES_HOST:-db}`, `REDIS_URL=${REDIS_URL:-redis://redis:6379/0}`. 각 서버의 `.env.docker`에는 상대 서버의 사설 IP를 적는다.
- 서버를 넘는 `depends_on`(nginx → web, migrate → db)에는 `required: false`를 붙인다 (Compose 2.20 이상). 한 대짜리 구성에서는 앞 컨테이너를 기다리고,
  서버에 혼자 띄울 때는 기다리지 않는다.
- 지금의 `x-app` 공통 설정(read_only, cap_drop ALL, no-new-privileges)은 back으로, db·redis 설정은 infra로 그대로 옮긴다.
- back은 web의 8000만 `${BIND_IP}:8000:8000`으로 연다. engine과 migrate는 포트를 열지 않는다.
- infra는 `${BIND_IP}:5432:5432`, `${BIND_IP}:6379:6379`로 연다. **Redis에 비밀번호를 건다**:
  `redis-server --appendonly yes --requirepass "$REDIS_PASSWORD"` (지금은 같은 서버 안이라 비밀번호가 없다).
  back에는 `REDIS_URL=redis://:<비밀번호>@10.30.1.10:6379/0`을 적는다. 엔진 클라이언트는 URL에 든 비밀번호로 `AUTH`를 보낸다 (`redis_client.py:22`, `:33`).
  비밀번호가 URL에 들어가므로 `%`·`@`·`/`가 섞이지 않게 `secrets.token_urlsafe`로 만든다.

#### B4-2. nginx: 백엔드 주소를 템플릿으로 받는다

- `deploy/nginx/default.conf`를 `default.conf.template`으로 바꾸고, `proxy_pass http://web:8000` 네 곳을 `http://${BACKEND_UPSTREAM}`으로 고친다.
  nginx 이미지는 시작할 때 `/etc/nginx/templates/*.template`의 환경 변수를 채워 `/etc/nginx/conf.d/`에 쓴다. `deploy/nginx/Dockerfile`의 `COPY` 경로도 함께 고친다.
- 컨테이너 파일 시스템이 읽기 전용이므로 `/etc/nginx/conf.d`를 tmpfs로 둔다 (nginx-unprivileged에서 되는지 구현할 때 확인한다).
- 컨테이너 이름 대신 사설 IP를 쓰므로, 지금처럼 web을 다시 띄운 뒤 nginx도 다시 시작해야 502가 사라지는 문제(0장)가 없어진다.
  back이 꺼져 있어도 front는 뜬다 (화면은 나오고 API만 502가 난다).
- `/static/`도 back으로 넘기고(4-3) `static` 볼륨은 없앤다.

#### B4-3. Django 관리자 화면의 정적 파일

지금은 web이 시작할 때 `collectstatic`으로 `static` 볼륨을 채우고 nginx가 그 볼륨의 파일을 내준다. front와 back이 다른 서버가 되면 볼륨을 같이 쓸 수 없다.

- backend 의존성에 **WhiteNoise**를 더해 web이 `/static/`을 직접 내주게 한다. front nginx는 `/static/`도 back으로 넘긴다
  (관리자 화면에서만 쓰는 파일이라 양이 적다).
- `collectstatic`은 컨테이너가 시작할 때마다 돌리지 않고 web 이미지를 빌드할 때 한 번 돌린다: `RUN DJANGO_DEBUG=on python manage.py collectstatic --noinput`.
  빌드할 때는 `POSTGRES_HOST`가 비어 있으므로 settings가 개발용 키로 뜬다 (`backend/config/settings.py:20-25`).

#### B4-4. 서버 배포 스크립트 `deploy/remote_deploy.sh`

`ROLE` 값 하나로 서버를 나눈다. 흐름(이미지 받기 → 띄우기 → 상태 확인 → 실패하면 직전 태그로 되돌리기)은 그대로다.

| ROLE | 받는 이미지 | 상태 확인 | 남기는 이미지 |
|---|---|---|---|
| front | nginx | `127.0.0.1:${HTTP_PORT}/healthz`, `/` | nginx 지금 버전·직전 버전 |
| back | web, engine | `http://${BIND_IP}:8000/api/health` (`Host: localhost`) + DB·Redis 연결 | web·engine 지금 버전·직전 버전 |

- `/api/health`는 DB와 Redis를 보지 않는다 (`backend/config/urls.py:13`). DB는 migrate가 성공해야 web이 뜨므로 배포할 때 확인된다.
  Redis는 지금 아무도 확인하지 않으므로 back 확인 단계에 `docker compose exec -T engine python -c "<REDIS_URL로 PING>"`을 더한다 (API는 바꾸지 않는다).
- 사설 IP를 `DJANGO_ALLOWED_HOSTS`에 넣지 않고 확인 요청에 `Host: localhost`를 붙인다.

#### B4-5. GitHub Actions `deploy.yml`

```
main push ─▶ 검사(ci.yml) ─▶ 이미지 올리기(3개, 지금과 같다) ─▶ back 배포 ─▶ front 배포 ─▶ 전체 확인 ─▶ Discord 알림
                                                             └─ 실패: back은 직전 버전으로 되돌리고 front는 배포하지 않는다
```

- SSH 준비, 파일 올리기, 레지스트리 로그인을 재사용 워크플로 `.github/workflows/deploy-target.yml`로 뺀다. 입력은 `role`, 서버 주소, 호스트 키이고
  비밀 값은 배포 키다. `deploy.yml`은 이 워크플로를 두 번 부른다. 호스트 키 별칭은 서버마다 다르게 둔다 (`paper-front`, `paper-back`).
- **순서는 back → front다.** back이 실패하면 back은 직전 버전으로 돌아가고 front는 배포하지 않는다. front가 실패하면 front만 되돌아가고 back은 새 버전으로 남는다.
  그래서 API는 직전 버전 프론트와도 한 번은 맞아야 한다 (되돌릴 수 없는 DB 마이그레이션을 두 번에 나눠 배포하는 규칙과 같은 생각이다).
- 마지막으로 실행기에서 front 공인 주소로 `/api/health`를 불러 front → back 연결을 확인한다. front 보안 그룹에 80이 열려 있어야 한다
  (지금 서버는 아직 닫혀 있다 — 0장).
- 저장소 변수와 비밀 값의 이름 앞에는 역할을 붙인다. 비공개 저장소에서는 GitHub 요금제에 따라 Environment별 비밀 값을 쓰지 못할 수 있어서다.

| 종류 | 이름 | 값 |
|---|---|---|
| 변수 | `FRONT_DEPLOY_HOST`, `BACK_DEPLOY_HOST` | 각 서버의 탄력적 IP |
| 변수 | `FRONT_DEPLOY_HOST_KEY`, `BACK_DEPLOY_HOST_KEY` | 각 서버의 `/etc/ssh/ssh_host_ed25519_key.pub` 한 줄 |
| 비밀 값 | `FRONT_DEPLOY_SSH_KEY`, `BACK_DEPLOY_SSH_KEY` | 서버마다 따로 만든 배포 전용 키 (하나가 새도 다른 서버는 안전하다) |
| 변수 | `DEPLOY_USER`, `DEPLOY_DIR`, `DEPLOY_PORT`, `DEPLOY_ENABLED` | 지금 값 그대로 (세 서버 모두 Ubuntu, `/home/ubuntu/paper_trading`) |
| 변수 | `PUBLIC_URL` | front 주소 (전체 확인용) |

- 지금 쓰는 `DEPLOY_HOST`, `DEPLOY_HOST_KEY`, `DEPLOY_SSH_KEY`는 옮기기가 끝난 뒤(6장 10단계)에 지운다. 그 전까지는 되돌릴 때 쓴다.
- **infra는 Actions가 배포하지 않는다.** 고정 태그의 공식 이미지만 쓰므로 바뀌는 일이 드물고, 22번 포트도 back에서만 열려 있다.
  `deploy/infra/compose.yml`을 고치면 관리자가 back을 거쳐 파일을 올리고 `docker compose up -d`를 실행한다.

#### B4-6. CI `ci.yml`

- compose 검사: 한 대짜리 파일과 서버별 파일 3개 모두 `config --quiet`로 검사한다.
- 기동 확인: 지금처럼 한 대짜리 구성으로 `smoke_test.sh`를 돌린다.
- **나눠 띄우기 확인을 더한다**: 실행기 하나에서 infra·back·front를 서로 다른 compose 프로젝트 3개로 띄우고 공유 네트워크 하나로 묶는다.
  서로의 주소는 컨테이너 이름이 아니라 환경 변수(`BACKEND_UPSTREAM`, `POSTGRES_HOST`, `REDIS_URL`)로만 준다.
  서버별 파일이 다른 파일의 컨테이너 이름에 기대고 있지 않은지 확인하려는 것이다.

#### B4-7. `.env.docker`를 서버별로 나눈다

| 키 | front | back | infra |
|---|---|---|---|
| `HTTP_PORT` | ○ | | |
| `BACKEND_UPSTREAM` (`10.20.1.10:8000`) | ○ | | |
| `BIND_IP` | | ○ (`10.20.1.10`) | ○ (`10.30.1.10`) |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | | ○ | ○ (back과 같은 값) |
| `POSTGRES_HOST` (`10.30.1.10`), `POSTGRES_PORT` | | ○ | |
| `REDIS_PASSWORD` | | | ○ |
| `REDIS_URL` (`redis://:<REDIS_PASSWORD>@10.30.1.10:6379/0`) | | ○ | |
| `DJANGO_*`, 키움, AI, DART, data.go.kr, Discord, `PUBLIC_BASE_URL`, 모의 계좌·추천·리포트·장기투자 키 | | ○ | |

- `DJANGO_ALLOWED_HOSTS`와 `PUBLIC_BASE_URL`에는 front 주소를 적는다. nginx가 브라우저가 보낸 Host를 그대로 넘기기 때문이다 (`deploy/nginx/default.conf` 첫 주석).
- 지금 `docker-compose.yml`이 컨테이너에 넣는 `POSTGRES_HOST: db`와 `REDIS_URL`은 서버별 compose 파일에서 빼고, 위 표처럼 `.env.docker`에서 받는다.
- 설정 키가 바뀌므로 AGENTS.md 규칙에 따라 `.github/workflows/ci.yml`의 환경 파일 만들기 단계와 `.env.docker.example`들을 같이 고친다.

### B5. 계정별 준비

#### B5-1. 계정 주인이 할 일 (계정마다)

1. 서울 리전에 VPC(3-1의 CIDR), 공개 서브넷(AZ ID `apne2-az1`), 인터넷 게이트웨이, 경로를 만든다.
2. 보안 그룹을 만든다 (3-3).
3. 인스턴스: 지금 서버와 같은 Ubuntu 26.04 LTS를 2장의 크기로 띄운다. 사설 IP를 지정하고 루트 디스크는 gp3로 한다.
4. front와 back에는 탄력적 IP를 만들어 붙인다.
5. 피어링을 요청하거나 수락하고 라우팅 경로를 더한다 (3-2).
6. 키 페어는 계정 주인이 만든다. 팀장의 관리자 공개 키를 `~/.ssh/authorized_keys`에 더한다 (개인 키는 주고받지 않는다).
7. AWS Budgets로 월 예산 알림을 건다 (계정마다 요금을 내는 사람이 다르다).
8. 팀장에게 계정 ID, VPC ID, 보안 그룹 ID, 공인 IP를 넘긴다. **계정 ID는 저장소에 적지 않고** 팀 비공개 채널로 넘긴다. 저장소 문서에는 CIDR과 사설 IP만 적는다.

#### B5-2. 서버 안에서 할 일 (팀장, 세 서버 모두)

본문 4장과 같다: Docker Engine과 Compose를 설치하고, `ubuntu`를 `docker` 그룹에 넣고, 로그 회전(`/etc/docker/daemon.json`, 10MB × 5)을 설정하고,
배포 폴더와 서버별 `.env.docker`(권한 0600)를 만들고, 호스트 키를 확인한다. 여기에 더할 것:

- back과 infra에는 swap 파일을 만든다. 메모리가 작은 사양이라 Chromium이나 PostgreSQL이 갑자기 메모리를 더 쓸 때 OOM으로 죽지 않게 하려는 것이다.
- infra에는 DB 백업을 둔다: 매일 cron으로 `pg_dump`를 돌려 서버 디스크에 7개까지 남기고, 계정 C에 EBS 스냅샷 정책(Data Lifecycle Manager)을 건다.
  지금은 서버가 한 대라 백업을 손으로만 했다.

#### B5-3. 담당 표 (정해서 채운다)

| 서버 | AWS 계정 주인 | 크레딧·프리 티어가 끝나는 날 | 서버 안 작업 |
|---|---|---|---|
| front | | | 팀장 |
| back | | | 팀장 |
| infra | | | 팀장 |

계정 하나가 멈추면(크레딧 소진, 결제 실패, 계정 정지) 그 서버가 통째로 내려간다. infra가 멈추면 서비스 전체가 멈추고, back이 멈추면 화면만 뜨고 기능은 모두 멈추며,
front가 멈추면 아예 접속할 수 없다. 발표·평가일까지 세 계정이 모두 살아 있는지 날짜를 적어 둔다.

### B6. 옮기는 순서 (EC2 한 대 → 세 대)

점검 시간은 **장이 끝나고 엔진의 하루 작업까지 끝난 뒤**(평일 18:30 이후. 펀더멘털 점검이 `THESIS_CHECK_AT=18:00`에 돈다)나 주말로 잡는다.
장중에는 엔진이 체결과 청산을 확인하고 있다.

| 단계 | 할 일 | 끝났는지 확인하는 방법 |
|---|---|---|
| 1 | 1장 전제를 확정하고 5-3 담당 표를 채운다 | |
| 2 | 4장의 코드 변경을 브랜치에서 한다 | CI 통과 (한 대짜리 smoke, 나눠 띄우기 확인) |
| 3 | 세 계정의 네트워크와 서버를 준비한다 (5장) | back에서 `nc -zv 10.30.1.10 5432`, front에서 `nc -zv 10.20.1.10 8000`. 연결 거부(refused)면 경로가 열린 것이고, 시간 초과면 경로나 보안 그룹 문제다 |
| 4 | infra를 띄운다 (빈 DB) | back에서 `pg_isready -h 10.30.1.10`, Redis `PING` |
| 5 | `DEPLOY_ENABLED=false`로 바꾼다 (옮기는 동안 push가 지금 서버에 배포되지 않게) | |
| 6 | 지금 서버에서 engine·web·nginx를 멈추고 `pg_dump` → infra에 복원한다. `appdata` 볼륨(`/data`)은 tar로 묶어 back으로 복사한다 | 계정·주문·리포트 수가 같은지 비교 |
| 7 | 브랜치를 `main`에 합치고 4-5의 변수를 넣은 뒤 `DEPLOY_ENABLED=true`로 바꾸고 Actions `Deploy`를 직접 실행한다 | back → front → 전체 확인 성공 |
| 8 | 화면을 확인한다: 로그인, 시세, 주문, 리포트 PDF·실행 Event(SSE), 알림 | |
| 9 | 시세 API에 back의 탄력적 IP를 등록한다 (키움. 지금 임시로 쓰는 토스도 등록 IP가 바뀐다 — 0장) | back 로그에 시세 오류 없음 |
| 10 | 팀원에게 새 주소를 알린다. 예전 서버는 **중지만** 하고 일주일 뒤 종료한다 (DB 덤프는 보관). 예전 `DEPLOY_*` 변수를 지운다 | |

**되돌리기**: 7~8단계에서 막히면 예전 서버의 web·engine·nginx를 다시 띄우고(DB 컨테이너는 그대로 있다) 예전 변수로 돌린다.
그 사이 새 DB에 쓰인 데이터는 잃게 되므로 7~8단계는 팀원 접속을 막아 둔 상태로 짧게 끝낸다.

### B7. 완료 기준

- [ ] CI: compose 파일 4개 검사, 한 대짜리 smoke, 나눠 띄우기 확인이 모두 통과한다
- [ ] `main`에 한 번 push하면 back → front 배포와 전체 확인이 성공한다 (Actions 실행 번호를 기록한다)
- [ ] back에 고장 난 이미지를 넣으면 back은 되돌아가고, front 배포는 건너뛰고, Discord로 실패 알림이 온다 (평가 체크리스트의 배포 차단·롤백 항목)
- [ ] 막혀야 하는 길이 모두 시간 초과로 끝난다: 인터넷 → back 8000, 인터넷 → infra 5432·6379·22, front → infra 5432
- [ ] infra의 Redis를 멈추면 예약 기능에 오류가 나고, 다시 켜면 다음 호출에서 다시 연결된다
- [ ] DB 백업 cron이 하루 한 번 파일을 남긴다
- [ ] 8장의 문서를 반영한다

### B8. 채택하면 고칠 문서

- 본문: 0장 서버 현황(서버 3대), 1~7장 전체 (이 계획의 4~6장이 바탕이다)
- `docs/DECISIONS.md` 11장: 서버 3대·계정 3개, 피어링, back → front 순서, infra 손 배포라는 결정과 그 이유
- `AGENTS.md`: 구조의 `deploy/` 줄과 실행의 운영 구성 명령. `docs/plans/TEAM_PAPER_TRADING_PLAN.md` 2-2의 CI/CD·서버 줄, `README.md`의 기술 스택
- 배포 및 장애 복구 보고서(평가 산출물 2)의 "배포 구성" 표: 2장 표를 그대로 쓴다

### B9. 알아 둘 것

- **지연**: 지금은 web → DB가 같은 서버 안이지만, 나누면 요청마다 네트워크를 한 번 더 지난다. 세 서버를 같은 AZ ID에 두면 늘어나는 지연이 작다.
  AZ가 다르면 요청 하나에 들어가는 쿼리 수만큼 지연이 늘어난다.
- **관리할 서버가 세 대가 된다.** 보안 업데이트, 디스크 정리, 인스턴스 상태 확인을 세 번씩 해야 한다.
- **비용**: 인스턴스 값은 지금과 비슷하지만(2장) 공인 IPv4 3개와 디스크 3개분이 늘어난다. 계정마다 요금을 따로 낸다.
- **토스 임시 설정**: 지금 운영이 임시로 쓰는 토스 조회(0장)는 back으로 옮겨진다. 키움 키를 받으면 되돌리는 일은 그대로 남는다.
