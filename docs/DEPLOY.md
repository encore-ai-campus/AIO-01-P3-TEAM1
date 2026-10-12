# 배포와 CI/CD

Docker 기반 파이프라인이다. **2026-10-06에 EC2를 연결했다** — 이제 `main`에 push하면 검사를 통과한 커밋이 자동 배포된다 (서버 현황은 0장).
정한 것: 배포 대상은 **AWS EC2(Ubuntu)에 SSH로 접속**, 배포 폴더는 **`/home/ubuntu/paper_trading`**, 서버의 `.env.docker`는 서버에서만 고친다.

## 0. 서버 현황 (2026-10-06)

| 항목 | 값 |
|---|---|
| 주소 | `52.78.101.101` (`ec2-52-78-101-101.ap-northeast-2.compute.amazonaws.com`, 서울). 자동 할당 공인 IP라 인스턴스를 중지했다 시작하면 바뀐다 (9장) |
| 사양 | Ubuntu 26.04 LTS, 2 vCPU · 메모리 3.7GB(`t3.medium`급), 디스크 28GB |
| Docker | Docker Engine 29.8 + Compose v5.6 (docs.docker.com 저장소). `ubuntu`가 `docker` 그룹. 컨테이너 로그는 10MB × 5개로 돌린다 (`/etc/docker/daemon.json`) |
| SSH | 키 로그인만 (비밀번호·root 로그인 꺼짐). 관리자 접속 키는 저장소 루트의 `encore.pem`(git 제외, 팀장 PC에만). 파이프라인은 배포 전용 키(`DEPLOY_SSH_KEY`)를 쓴다 — 개인 키는 GitHub 비밀 값에만 있다 |
| GitHub | 변수 `DEPLOY_HOST`·`DEPLOY_USER`·`DEPLOY_DIR`·`DEPLOY_HOST_KEY`(ed25519)·`DEPLOY_ENABLED=true`, 비밀 값 `DEPLOY_SSH_KEY` |
| `.env.docker` | 0600. `DJANGO_SECRET_KEY`·`POSTGRES_PASSWORD`는 서버용 새 값, AI(DevPass)·DART 키는 팀 값. **비어 있음: `KIWOOM_APPKEY`·`KIWOOM_SECRETKEY`, `DATA_GOKR_API`, `DISCORD_WEBHOOK_URL`** |
| 시세 (임시) | **2026-10-06 사용자 결정으로 키움 키를 받기 전까지 토스 조회를 쓴다**: 로컬 `.env`의 `BROKER=toss`·`CLIENT_ID`·`CLIENT_SECRET`과 `DJANGO_DEBUG=on`(토스는 이때만 켜진다)을 넣었다. 토스 개발자 화면에 서버 IP를 등록했다. 이전 파일은 서버의 `.env.docker.bak-20261006-061018`. 안전 규칙(AGENTS.md, `docs/DECISIONS.md` 3-1 — 운영은 키움만, 토스 키는 EC2에 두지 않음)과 어긋나는 임시 상태라 **키움 키를 받으면 `BROKER`·`CLIENT_*`를 지우고 `DJANGO_DEBUG=off`로 되돌린다**. 토스 토큰은 클라이언트당 하나만 유효해서 같은 `CLIENT_ID`를 쓰는 다른 곳(이 PC의 `scripts/dev.sh` 등)과 서로 토큰을 무효로 만든다 (`token-revoked`) |
| 첫 배포 | 2026-10-06 Actions `Deploy` #37420279822 (수동 실행, 커밋 `d3325f2`): 검사 → 이미지 → 서버 배포 → 상태 확인 성공 |
| 자동 리포트 | **2026-10-07 18:44 KST 켬**: `.env.docker`에 `AUTO_REPORT=on`·`AUTO_REPORT_TOP=3`·`AUTO_REPORT_AT=08:00` (`AUTO_RECOMMEND=off` 그대로). 국내 거래일 08:00 이후 하루 한 번 선정 팀 → 종목 리포트. 이전 파일은 서버의 `.env.docker.bak-20261007-094439` (서버 시각 UTC). 켠 직후 그날 치 선정(#8)이 바로 돌았다 |
| 계정 | 개발 DB의 팀원 5개·관리자 1개(`team_accounts.txt`·`admin_account.txt`와 같은 아이디·비밀번호)를 2026-10-06에 운영 DB로 복사했다 (비밀번호 해시째, 닉네임·공개 설정 포함) |
| 남은 일 | 보안 그룹(`launch-wizard-1`)에 HTTP 80 열기 (그 전에는 밖에서 접속되지 않는다), 키움 키 + 키움에 서버 IP 등록 → 토스 임시 설정 되돌리기 |

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
4. 실행 번호, 커밋, 시각, 링크를 보고서에 적는다 (`docs/plans/TEAM_DEV_PLAN.md` 7장).

서버에서 새 버전이 뜨지 않을 때의 되돌리기는 2026-10-02에 이 PC에서 확인했다 (로컬 레지스트리에 정상 이미지와 web이 죽는 이미지를 올려
`remote_deploy.sh`를 실행: 정상 → 성공, 고장 → 실패로 끝나고 정상 버전으로 복귀).

## 9. 알아 둘 것

- **서버 IP가 바뀌면** (자동 할당 공인 IP는 인스턴스를 중지했다 시작하면 바뀐다): `DEPLOY_HOST`, `.env.docker`의 `DJANGO_ALLOWED_HOSTS`,
  키움 IP 등록, 팀원 접속 주소를 고친다. `DEPLOY_HOST_KEY`는 그대로 둔다 (서버를 새로 만들었을 때만 바뀐다).
- **HTTPS는 아직 없다** (도메인 없이 IP + HTTP로 시작하는 계획). 도메인이 생기면 nginx 앞에 인증서를 붙이고 Django의 보안 쿠키 설정을 켠다.
- **web은 프로세스 하나에 스레드 16개**로 돈다. 시세 캐시와 증권사 호출 간격 조절이 프로세스별이라 프로세스를 늘리면 증권사 호출이 늘어난다
  (`docs/DECISIONS.md` 8-6). 늘리려면 먼저 캐시를 Redis로 옮긴다.
- **엔진 컨테이너에 openclaw는 없다.** 엔진의 Discord 알림(`OPENCLAW_TARGET`)은 콘솔로 나간다. 리포트 발송 방법은 `docs/plans/TEAM_DEV_PLAN.md` 6-4에서 정한다.
- **비공개 저장소**라 Actions 실행 시간이 계정 한도에서 빠진다 (검사 한 번에 몇 분). 문서만 고친 커밋도 검사가 돈다.
- 엔진 이미지는 Chromium과 한글 글꼴 때문에 크다 (1GB 이상). 서버 디스크가 작으면 `docker system df`로 확인한다.
