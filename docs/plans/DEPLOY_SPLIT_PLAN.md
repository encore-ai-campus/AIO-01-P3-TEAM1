# 배포 분리 계획: front · back · infra 서버 3대 (AWS 계정 3개)

> 상태: **계획** (2026-10-07). 코드와 서버는 아직 바꾸지 않았다. 지금 운영은 EC2 한 대에서 컨테이너 5개를 돌린다 (`docs/DEPLOY.md`).
> 채택하면 8장의 문서를 고치고, 이 파일은 `docs/`로 옮기거나 지운다.

## 0. 한눈에

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

## 1. 전제 (확정할 것)

| # | 가정 | 가정과 다를 때 |
|---|---|---|
| P1 | infra는 상태를 가진 것(PostgreSQL·Redis)만 둔다. 모니터링·CI 실행기는 넣지 않는다 | 2장 표에 열을 더한다 |
| P2 | 세 계정 모두 서울 리전(`ap-northeast-2`)을 쓴다 | 리전 간 피어링은 되지만 보안 그룹에서 상대 SG를 가리킬 수 없어 CIDR로 연다. 지연도 늘어난다 |
| P3 | 지금처럼 도메인·HTTPS 없이 front 공인 IP + HTTP로 시작한다 | 도메인이 생기면 인증서는 front에만 붙인다 |
| P4 | 각 계정 주인(팀원)이 자기 계정의 네트워크·인스턴스를 만들고, 서버 안의 작업(Docker, `.env.docker`)은 팀장이 SSH로 한다 | 5장의 담당만 바꾼다 |

## 2. 서버별 구성

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

## 3. 네트워크 (계정이 달라서 생기는 일)

### 3-1. VPC와 주소: 계정마다 VPC를 새로 만든다

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

### 3-2. 피어링 2개

| 연결 | 요청하는 계정 | 수락하는 계정 | 라우팅 테이블에 더할 경로 |
|---|---|---|---|
| front ↔ back | A | B | A: `10.20.0.0/16` → 피어링, B: `10.10.0.0/16` → 피어링 |
| back ↔ infra | C | B | C: `10.20.0.0/16` → 피어링, B: `10.30.0.0/16` → 피어링 |

- 요청하는 쪽은 상대의 **계정 ID와 VPC ID**를 알아야 한다. 수락은 상대 계정의 콘솔에서 한다 (요청한 뒤 7일 안에).
- front ↔ infra 피어링은 만들지 않는다. 피어링은 back을 거쳐 이어지지 않으므로 front에서 infra로 가는 길이 생기지 않는다.
- 사설 IP로만 부르므로 피어링의 DNS 옵션은 켜지 않아도 된다.

### 3-3. 보안 그룹

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

### 3-4. 피어링을 할 수 없을 때 (권장하지 않음)

계정 주인끼리 피어링을 맞추지 못하면 서버끼리 공인 IP로 연결하고, 보안 그룹의 출처를 상대의 탄력적 IP/32로 좁혀야 한다.
그런데 엔진의 Redis 클라이언트(`engine/paper_engine/records/redis_client.py`)는 TLS(`rediss://`)를 지원하지 않는다. 이대로면 Redis 비밀번호와 데이터가
암호화되지 않은 채 인터넷을 지난다. 이 방법을 쓰려면 back ↔ infra 사이에 WireGuard 터널을 두고 PostgreSQL과 Redis를 그 터널로 보내야 하며, infra에도 탄력적 IP가 있어야 한다.

## 4. 바꿀 것 (구현 계획)

### 4-1. compose 파일을 서버별로 나눈다

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

### 4-2. nginx: 백엔드 주소를 템플릿으로 받는다

- `deploy/nginx/default.conf`를 `default.conf.template`으로 바꾸고, `proxy_pass http://web:8000` 네 곳을 `http://${BACKEND_UPSTREAM}`으로 고친다.
  nginx 이미지는 시작할 때 `/etc/nginx/templates/*.template`의 환경 변수를 채워 `/etc/nginx/conf.d/`에 쓴다. `deploy/nginx/Dockerfile`의 `COPY` 경로도 함께 고친다.
- 컨테이너 파일 시스템이 읽기 전용이므로 `/etc/nginx/conf.d`를 tmpfs로 둔다 (nginx-unprivileged에서 되는지 구현할 때 확인한다).
- 컨테이너 이름 대신 사설 IP를 쓰므로, 지금처럼 web을 다시 띄운 뒤 nginx도 다시 시작해야 502가 사라지는 문제(`docs/DEPLOY.md` 0장)가 없어진다.
  back이 꺼져 있어도 front는 뜬다 (화면은 나오고 API만 502가 난다).
- `/static/`도 back으로 넘기고(4-3) `static` 볼륨은 없앤다.

### 4-3. Django 관리자 화면의 정적 파일

지금은 web이 시작할 때 `collectstatic`으로 `static` 볼륨을 채우고 nginx가 그 볼륨의 파일을 내준다. front와 back이 다른 서버가 되면 볼륨을 같이 쓸 수 없다.

- backend 의존성에 **WhiteNoise**를 더해 web이 `/static/`을 직접 내주게 한다. front nginx는 `/static/`도 back으로 넘긴다
  (관리자 화면에서만 쓰는 파일이라 양이 적다).
- `collectstatic`은 컨테이너가 시작할 때마다 돌리지 않고 web 이미지를 빌드할 때 한 번 돌린다: `RUN DJANGO_DEBUG=on python manage.py collectstatic --noinput`.
  빌드할 때는 `POSTGRES_HOST`가 비어 있으므로 settings가 개발용 키로 뜬다 (`backend/config/settings.py:20-25`).

### 4-4. 서버 배포 스크립트 `deploy/remote_deploy.sh`

`ROLE` 값 하나로 서버를 나눈다. 흐름(이미지 받기 → 띄우기 → 상태 확인 → 실패하면 직전 태그로 되돌리기)은 그대로다.

| ROLE | 받는 이미지 | 상태 확인 | 남기는 이미지 |
|---|---|---|---|
| front | nginx | `127.0.0.1:${HTTP_PORT}/healthz`, `/` | nginx 지금 버전·직전 버전 |
| back | web, engine | `http://${BIND_IP}:8000/api/health` (`Host: localhost`) + DB·Redis 연결 | web·engine 지금 버전·직전 버전 |

- `/api/health`는 DB와 Redis를 보지 않는다 (`backend/config/urls.py:13`). DB는 migrate가 성공해야 web이 뜨므로 배포할 때 확인된다.
  Redis는 지금 아무도 확인하지 않으므로 back 확인 단계에 `docker compose exec -T engine python -c "<REDIS_URL로 PING>"`을 더한다 (API는 바꾸지 않는다).
- 사설 IP를 `DJANGO_ALLOWED_HOSTS`에 넣지 않고 확인 요청에 `Host: localhost`를 붙인다.

### 4-5. GitHub Actions `deploy.yml`

```
main push ─▶ 검사(ci.yml) ─▶ 이미지 올리기(3개, 지금과 같다) ─▶ back 배포 ─▶ front 배포 ─▶ 전체 확인 ─▶ Discord 알림
                                                             └─ 실패: back은 직전 버전으로 되돌리고 front는 배포하지 않는다
```

- SSH 준비, 파일 올리기, 레지스트리 로그인을 재사용 워크플로 `.github/workflows/deploy-target.yml`로 뺀다. 입력은 `role`, 서버 주소, 호스트 키이고
  비밀 값은 배포 키다. `deploy.yml`은 이 워크플로를 두 번 부른다. 호스트 키 별칭은 서버마다 다르게 둔다 (`paper-front`, `paper-back`).
- **순서는 back → front다.** back이 실패하면 back은 직전 버전으로 돌아가고 front는 배포하지 않는다. front가 실패하면 front만 되돌아가고 back은 새 버전으로 남는다.
  그래서 API는 직전 버전 프론트와도 한 번은 맞아야 한다 (되돌릴 수 없는 DB 마이그레이션을 두 번에 나눠 배포하는 규칙과 같은 생각이다).
- 마지막으로 실행기에서 front 공인 주소로 `/api/health`를 불러 front → back 연결을 확인한다. front 보안 그룹에 80이 열려 있어야 한다
  (지금 서버는 아직 닫혀 있다 — `docs/DEPLOY.md` 0장).
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

### 4-6. CI `ci.yml`

- compose 검사: 한 대짜리 파일과 서버별 파일 3개 모두 `config --quiet`로 검사한다.
- 기동 확인: 지금처럼 한 대짜리 구성으로 `smoke_test.sh`를 돌린다.
- **나눠 띄우기 확인을 더한다**: 실행기 하나에서 infra·back·front를 서로 다른 compose 프로젝트 3개로 띄우고 공유 네트워크 하나로 묶는다.
  서로의 주소는 컨테이너 이름이 아니라 환경 변수(`BACKEND_UPSTREAM`, `POSTGRES_HOST`, `REDIS_URL`)로만 준다.
  서버별 파일이 다른 파일의 컨테이너 이름에 기대고 있지 않은지 확인하려는 것이다.

### 4-7. `.env.docker`를 서버별로 나눈다

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

## 5. 계정별 준비

### 5-1. 계정 주인이 할 일 (계정마다)

1. 서울 리전에 VPC(3-1의 CIDR), 공개 서브넷(AZ ID `apne2-az1`), 인터넷 게이트웨이, 경로를 만든다.
2. 보안 그룹을 만든다 (3-3).
3. 인스턴스: 지금 서버와 같은 Ubuntu 26.04 LTS를 2장의 크기로 띄운다. 사설 IP를 지정하고 루트 디스크는 gp3로 한다.
4. front와 back에는 탄력적 IP를 만들어 붙인다.
5. 피어링을 요청하거나 수락하고 라우팅 경로를 더한다 (3-2).
6. 키 페어는 계정 주인이 만든다. 팀장의 관리자 공개 키를 `~/.ssh/authorized_keys`에 더한다 (개인 키는 주고받지 않는다).
7. AWS Budgets로 월 예산 알림을 건다 (계정마다 요금을 내는 사람이 다르다).
8. 팀장에게 계정 ID, VPC ID, 보안 그룹 ID, 공인 IP를 넘긴다. **계정 ID는 저장소에 적지 않고** 팀 비공개 채널로 넘긴다. 저장소 문서에는 CIDR과 사설 IP만 적는다.

### 5-2. 서버 안에서 할 일 (팀장, 세 서버 모두)

`docs/DEPLOY.md` 4장과 같다: Docker Engine과 Compose를 설치하고, `ubuntu`를 `docker` 그룹에 넣고, 로그 회전(`/etc/docker/daemon.json`, 10MB × 5)을 설정하고,
배포 폴더와 서버별 `.env.docker`(권한 0600)를 만들고, 호스트 키를 확인한다. 여기에 더할 것:

- back과 infra에는 swap 파일을 만든다. 메모리가 작은 사양이라 Chromium이나 PostgreSQL이 갑자기 메모리를 더 쓸 때 OOM으로 죽지 않게 하려는 것이다.
- infra에는 DB 백업을 둔다: 매일 cron으로 `pg_dump`를 돌려 서버 디스크에 7개까지 남기고, 계정 C에 EBS 스냅샷 정책(Data Lifecycle Manager)을 건다.
  지금은 서버가 한 대라 백업을 손으로만 했다.

### 5-3. 담당 표 (정해서 채운다)

| 서버 | AWS 계정 주인 | 크레딧·프리 티어가 끝나는 날 | 서버 안 작업 |
|---|---|---|---|
| front | | | 팀장 |
| back | | | 팀장 |
| infra | | | 팀장 |

계정 하나가 멈추면(크레딧 소진, 결제 실패, 계정 정지) 그 서버가 통째로 내려간다. infra가 멈추면 서비스 전체가 멈추고, back이 멈추면 화면만 뜨고 기능은 모두 멈추며,
front가 멈추면 아예 접속할 수 없다. 발표·평가일까지 세 계정이 모두 살아 있는지 날짜를 적어 둔다.

## 6. 옮기는 순서 (EC2 한 대 → 세 대)

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
| 9 | 시세 API에 back의 탄력적 IP를 등록한다 (키움. 지금 임시로 쓰는 토스도 등록 IP가 바뀐다 — `docs/DEPLOY.md` 0장) | back 로그에 시세 오류 없음 |
| 10 | 팀원에게 새 주소를 알린다. 예전 서버는 **중지만** 하고 일주일 뒤 종료한다 (DB 덤프는 보관). 예전 `DEPLOY_*` 변수를 지운다 | |

**되돌리기**: 7~8단계에서 막히면 예전 서버의 web·engine·nginx를 다시 띄우고(DB 컨테이너는 그대로 있다) 예전 변수로 돌린다.
그 사이 새 DB에 쓰인 데이터는 잃게 되므로 7~8단계는 팀원 접속을 막아 둔 상태로 짧게 끝낸다.

## 7. 완료 기준

- [ ] CI: compose 파일 4개 검사, 한 대짜리 smoke, 나눠 띄우기 확인이 모두 통과한다
- [ ] `main`에 한 번 push하면 back → front 배포와 전체 확인이 성공한다 (Actions 실행 번호를 기록한다)
- [ ] back에 고장 난 이미지를 넣으면 back은 되돌아가고, front 배포는 건너뛰고, Discord로 실패 알림이 온다 (평가 체크리스트의 배포 차단·롤백 항목)
- [ ] 막혀야 하는 길이 모두 시간 초과로 끝난다: 인터넷 → back 8000, 인터넷 → infra 5432·6379·22, front → infra 5432
- [ ] infra의 Redis를 멈추면 예약 기능에 오류가 나고, 다시 켜면 다음 호출에서 다시 연결된다
- [ ] DB 백업 cron이 하루 한 번 파일을 남긴다
- [ ] 8장의 문서를 반영한다

## 8. 채택하면 고칠 문서

- `docs/DEPLOY.md`: 0장 서버 현황(서버 3대), 1~7장 전체 (이 계획의 4~6장이 바탕이다)
- `docs/DECISIONS.md` 11장: 서버 3대·계정 3개, 피어링, back → front 순서, infra 손 배포라는 결정과 그 이유
- `AGENTS.md`: 구조의 `deploy/` 줄과 실행의 운영 구성 명령. `docs/plans/TEAM_PAPER_TRADING_PLAN.md` 2-2의 CI/CD·서버 줄, `README.md`의 기술 스택
- 배포 및 장애 복구 보고서(평가 산출물 2)의 "배포 구성" 표: 2장 표를 그대로 쓴다

## 9. 알아 둘 것

- **지연**: 지금은 web → DB가 같은 서버 안이지만, 나누면 요청마다 네트워크를 한 번 더 지난다. 세 서버를 같은 AZ ID에 두면 늘어나는 지연이 작다.
  AZ가 다르면 요청 하나에 들어가는 쿼리 수만큼 지연이 늘어난다.
- **관리할 서버가 세 대가 된다.** 보안 업데이트, 디스크 정리, 인스턴스 상태 확인을 세 번씩 해야 한다.
- **비용**: 인스턴스 값은 지금과 비슷하지만(2장) 공인 IPv4 3개와 디스크 3개분이 늘어난다. 계정마다 요금을 따로 낸다.
- **토스 임시 설정**: 지금 운영이 임시로 쓰는 토스 조회(`docs/DEPLOY.md` 0장)는 back으로 옮겨진다. 키움 키를 받으면 되돌리는 일은 그대로 남는다.
