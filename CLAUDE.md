# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 현재 상태 (2026-10-02)

- **계획서가 단일 기준이다.** 구조·명령·결정이 이 파일과 다르면 계획서를 따르고, 계획이 바뀌면 이 파일과 `AGENTS.md`도 함께 고친다.
  작업자 간 공통 결정(설정 키, 클라이언트 인터페이스, 모의 계좌 표, Redis 키, 작업 큐·API 형식)은 `docs/DECISIONS.md`.
- 저장소 위치는 이 디렉터리(`Team_trading_1001`, git 초기화, 커밋 없음). 원본 `toss_trading` 복사본은 `personal_project_files/`
  (참고용, git 제외, 고치지 않는다. 실주문 코드가 들어 있다). 원본 `data/`·`runs/`·`.cache/`·`.env`는 복사되지 않았다.
- 끝난 단계: 0(재배치, 패키지 `paper_engine`), 1(토스 경로 → 클라이언트 메서드), 2(`docs/DECISIONS.md`),
  3(키움 API 문서 확인 → `docs/KIWOOM.md`. **실제 앱키 실측은 아직** — 8장 미확인 목록, `scripts/kiwoom_check.py`),
  4A(`KiwoomClient`, `data/calendar.py`), 4B(실주문·컨펌·Discord 명령 삭제, 모의 계좌 `agents/executor.py`·`records/account.py`·`trading.py`),
  Django·React는 **빈 페이지만** (`/`, `/api/health`, `/api/schema/`, `/admin/`).
- **웹 1차 (2026-10-02)**: 팀원 로그인, 팀원별 모의 계좌·주문(실시간 시세 폴링), AI 분석 종목 대시보드, My Page, 랭킹보드.
  백엔드 `accounts`(로그인·프로필·팀 계정 생성) · `trading`(계좌·주문·시세·랭킹·`run_engine`) · `analysis`(분석 색인·분석 작업),
  프론트는 Tailwind CSS. API 계약은 `docs/API.md`, 결정은 `docs/DECISIONS.md` 8장.
- **AI 리포트 (2026-10-02, 구조만)**: 종목별 리포트 신청과 Agents Orchestration Trace 시각화 (`/reports`). 백엔드 `reports` 앱은
  YAML Registry(실행 계획)·Shared State·Trace 저장·Snapshot·SSE까지만 있다. **Agent와 Orchestrator 실행 코드는 없다** (팀이 구현한다.
  개념은 루트의 `교육용문서.md`, 붙일 자리는 `docs/DECISIONS.md` 9-4). 신청한 리포트는 `requested`로 남는다.
- 남은 단계: 4C 나머지(엔진 기록 저장소를 Django ORM으로, 전략·선별·통계·시장·리포트 API), 4D 나머지 화면, 4E(Docker·CI/CD), 5 통합, 7 EC2 배포.
  엔진 자체 기록(AI 시나리오 추적, 엔진 계좌)은 아직 SQLite `data/trading.db`, 전략·예약·선별 결과는 Redis(`paper:*`), 엔진 조작은 엔진 CLI다.
- 키움 순위는 당일(1d)만 된다 → 백테스트 유니버스는 당일 상위 + 시장 기록(`rankings` 표) 누적분. 미국(`MARKETS=US`)은 실측 전까지 끈다.
- **로컬 개발 환경에서만** `.env`의 `BROKER=toss`(+ `CLIENT_ID`, `CLIENT_SECRET`)로 토스 조회 클라이언트 `data/toss.py`를 쓸 수 있다
  (2026-10-02 복구, 키움 앱키가 없어도 로컬에서 돌려 보기 위함). 조회만 하고, 운영(EC2)은 키움만 쓴다. `docs/DECISIONS.md` 3-1장.

## 목표

`toss_trading`을 복제해 팀 토이 프로젝트용 **키움 REST API 기반 모의매매 웹 서비스**로 바꾼다.
키움은 시세·일봉·순위 조회만 쓰고(계좌·주문 TR은 만들지 않음), 주문은 가상 현금 계좌에서 체결을 흉내 낸다.
팀원별 로그인, React 웹 화면, Django 백엔드, DB(로컬 개발 SQLite / EC2 운영 PostgreSQL), Redis, AWS EC2 + Docker Compose, GitHub Actions 배포.

## 깨면 안 되는 규칙

- **실주문 코드 0건.** `orders.py`, `create_order`, `LIVE_TRADING`, `--live`, `--bypass`가 코드 검색에서 나오면 안 된다 (계획서 7장 검증 항목).
  `tossinvest`는 로컬 개발용 조회 클라이언트 `engine/paper_engine/data/toss.py`의 주소 한 곳에만 있어야 한다.
  그 클라이언트에 계좌·주문 메서드를 넣지 않는다 (토큰 발급 말고는 GET만, 계좌 헤더 없음).
- **토스 조회는 로컬 개발 환경 전용이다.** 운영(EC2)은 키움만 쓴다. `BROKER=toss`는 `POSTGRES_HOST`가 있으면 `load_config`가 거부한다.
  EC2의 `.env`와 운영 compose에 `BROKER`, `CLIENT_ID`, `CLIENT_SECRET`을 넣지 않는다.
- **AI는 제안만 한다.** 지표 계산, 사실 검증, 수량·한도·체결 가능 여부는 결정론적 코드가 판단한다. 최소 손익비 2.0은 AI 프롬프트에 노출하지 않는다.
- **엔진 내부 데이터 형식은 토스 형식을 유지한다.** 키움 응답 → 내부 형식 변환은 `data/kiwoom.py`의 `KiwoomClient` 안에서만 한다.
  - 일봉 `openPrice/highPrice/lowPrice/closePrice/volume/timestamp`, 순위 `rank/symbol/tradingAmount/price.lastPrice/price.changeRate`, 종목 `securityType/status/...`
  - 그래야 선별·백테스트·스냅샷 코드를 수정 없이 쓴다. `KiwoomClient`는 `TossClient` 조회 메서드와 이름·반환 형식이 같아야 한다
    (`test_toss.py`가 두 클라이언트의 공개 메서드 이름·인자가 같은지 검사한다). 클라이언트는 `data/broker.make_client(cfg, …)`로만 만든다.
- **엔진(`engine/`)은 표준 라이브러리 원칙을 유지한다.** Django·DRF·psycopg·gunicorn 등 외부 의존성은 `backend/`에서만 추가한다.
- **원본 데이터를 가져오지 않는다.** `data/`, `runs/`, `.cache/`, `backtest/cache/`, `.env`는 복사 금지 (원본 DB에 실포지션이 있다).
- **운영 중인 `toss_trading`에 영향을 주지 않는다.** systemd `toss-trading`, Redis `toss:*` 키, `~/.openclaw/` 설정을 건드리지 않는다.
  토스 토큰은 client당 1개만 유효하다. 원본과 같은 `CLIENT_ID`로 여기서 토큰을 받으면 원본의 토큰이 무효가 되므로 개발용 client를 따로 쓴다.
- 비밀 정보(키움·DevPass·DART·data.go.kr 키, Django 비밀키, DB 비밀번호, 봇 토큰)는 EC2의 `.env`에만 둔다. 저장소에는 `.env.example`(개발용 기본값)만.
  토스 키(`CLIENT_ID`, `CLIENT_SECRET`)는 개발자 로컬 `.env`에만 둔다.
- **DB는 로컬 개발 환경에서 SQLite, EC2에 올렸을 때 PostgreSQL.** Django 설정이 `POSTGRES_HOST` 유무로 고른다(없으면 `backend/db.sqlite3`).
  같은 모델·마이그레이션을 쓰므로 PostgreSQL 전용 기능은 쓰지 않는다. CI는 PostgreSQL로 검사한다.

## 아키텍처

```
브라우저 ─HTTPS─▶ nginx ─┬─ /            React 빌드 파일
                         └─ /api, /admin  Django + DRF (gunicorn) ─┬─▶ DB: EC2 PostgreSQL / 로컬 SQLite (기록·계좌·전략·작업)
엔진: python manage.py run_engine ─────────────────────────────────┴─▶ Redis (작업 큐·잠금·캐시·생존 신호)
  └─▶ 키움 REST, DART, SEC EDGAR, Google News, DevPass LLM Gateway, openclaw → Discord 팀 채널(알림만)
```

- **웹은 짧은 요청만** 처리한다 (조회, 주문 등록, 전략 수정). 현재가·일봉 조회와 시장가 체결은 웹이 1초 캐시로 직접 하고
  (`backend/config/engine.py`의 `broker_client()` 하나), 오래 걸리는 일(AI 분석)은 `jobs` 표에 넣어 `run_engine`이 처리한다.
  웹은 작업 번호로 상태를 조회한다. 지정가 체결·목표/손절 청산·예약 실행·일별 자산 기록도 `run_engine` 루프가 한다.
- **엔진 = 기존 `serve` 루프를 Django 관리 명령으로 감싼 것.** 선별·분석·리스크·체결 로직은 그대로 두고 저장소 계층(`records/store.py`)만 Django ORM으로 바꾼다.
- **API 명세가 프론트 타입의 원천이다.** `drf-spectacular`로 OpenAPI 생성 → `openapi-typescript`로 TS 타입 생성. CI가 둘이 맞는지 비교한다.
- 실행 기록 JSON·PDF는 EC2 디스크 볼륨(`runs/`, `reports/`)에 두고 DB에는 경로만 저장한다.

### 엔진 흐름 (원본에서 유지)

선별(`judge/screen.py`, 거래대금 상위 100 → 규칙 점수) → 웹 조사(`agents/researcher.py`) → 시나리오 제안(`agents/proposer.py`)
→ 사실 검증(`judge/fact_check.py`) → 상호 채점(`agents/critic.py`) → 판정(`judge/verdict.py`) → 리스크 엔진(`judge/risk.py`)
→ 최종 승인(`agents/approver.py`) → 모의 주문. 사실 검증을 통과한 **모든** 시나리오를 `trades`/`predictions`에 기록하고
`records/paper.py`가 완성된 일봉으로 결과를 판정해 모델별 성적(Brier)을 추적한다. 세부 기준은 계획서 2장.

### 모의 계좌 (새로 구현, 계획서 3-2)

- **웹 계좌는 팀원별 1개** (2026-10-02 확정), 초기 자금은 각자 `PAPER_CAPITAL_KRW`(기본 1천만원). Django DB에 두고 체결 규칙은 엔진
  `PaperExecutor`를 그대로 쓴다 (계좌 하나로 좁힌 ORM 저장소를 넘긴다). 엔진 자체 SQLite 계좌(팀 공용 1개)는 엔진 CLI·전략용으로 남는다.
  미국 종목은 체결 시점 환율로 원화 환산.
- 주문 상태: `ENTRY_PENDING` → `EXIT_WATCHING` → `CLOSED` / `CANCELED`. 주문마다 요청자(팀원 계정 또는 "전략 N")를 기록한다.
- 체결은 정규장 안에서만: 시장가는 현재 확인 가격에 즉시, 지정가 매수는 가격 ≤ 지정가면 체결·당일 미체결 시 취소,
  목표·손절·기한 청산은 원본 `executor._check_local_exit`(2회 연속 확인)를 재사용. 정규장 밖 시장가는 다음 장 시작 예약으로.
- 평가액 = 현금 + 보유 평가액, 매수 가능액 = 현금 − 대기 매수 금액 (`backtest/sim.py` 방식).
- 실계좌를 보던 곳(보유 조회, 일일 리포트 계좌 요약, 분석 대상 제외, 리스크 엔진 입력)은 전부 모의 계좌로 바꾼다.

### 장 달력

키움에는 달력 API가 없다 (확인함). `data/calendar.py`의 `MarketCalendar`가 토스와 같은 형식을 만든다.
국내는 09:00~15:30 + data.go.kr 특일정보(`DATA_GOKR_API`) + KRX 연말 휴장, 미국은 NYSE 휴장·조기 폐장 규칙 + `zoneinfo`.
미국 시장 지원이 부족하면 `MARKETS=KR`로 국내만 먼저 한다.

## 저장소 구조

```
pyproject.toml uv 작업 공간 (engine, backend). 루트에서 uv sync / uv run pytest
engine/       paper_engine 패키지 (원본 src/toss_trading). data/kiwoom.py·calendar.py, data/toss.py(로컬 개발 전용 조회)·broker.py(클라이언트 선택),
              agents/executor.py(모의 체결기),
              records/(store·account·paper·market_log·backup), trading.py(주문 창구 Desk), symbols.py. 테스트 engine/tests/
backend/      Django: config/(설정, engine.py 엔진 접점, api.py 오류·페이지 공통), accounts/(로그인·프로필·create_team_accounts),
              trading/(팀원별 계좌·주문·시세·랭킹·run_engine), analysis/(AI 분석 색인·분석 작업),
              reports/(AI 리포트: YAML Registry·State·Trace·SSE, Agent 미구현). 앱 테스트는 backend/<앱>/tests/
frontend/     React + TypeScript + Vite + Tailwind CSS, React Router, TanStack Query, lightweight-charts, MSW(가짜 API)
backtest/     백테스트 (DB 없이 단독 실행)
deploy/       compose.dev.yml (Redis, --profile postgres로 PostgreSQL). 계획: docker-compose.yml, nginx, Dockerfile
scripts/      kiwoom_check.py (키움 읽기 전용 실측)
docs/         DESIGN.md(엔진 설계), DECISIONS.md(공통 결정), API.md(웹 API 계약), KIWOOM.md(TR·매핑·호출 제한·미확인 항목)
```
(계획: `.github/workflows/` ci.yml, deploy.yml)

## 명령

```bash
uv sync                                            # 루트에서 (엔진 + 백엔드 + 개발 도구)
docker compose -f deploy/compose.dev.yml up -d     # Redis (DB는 로컬 SQLite. 운영과 같은 PostgreSQL이 필요하면 --profile postgres)
cd backend && uv run python manage.py migrate      # DB 표 (로컬 SQLite)
cd backend && uv run python manage.py create_team_accounts   # 팀원 계정 5개 → 저장소 루트 team_accounts.txt (git 제외, 다시 실행해도 안전)
cd backend && uv run python manage.py runserver    # Django (DJANGO_DEBUG=on 또는 DJANGO_SECRET_KEY 필요)
cd backend && uv run python manage.py run_engine   # 웹 엔진 루프: 지정가 체결·목표/손절 청산·예약 실행·일별 자산·AI 분석 작업
cd frontend && npm run dev                         # Vite가 /api, /admin을 127.0.0.1:8000으로 프록시 (다른 포트면 VITE_API_TARGET=..., VITE_MOCK=1이면 가짜 API)
uv run python -m paper_engine serve                # 엔진 자체 상주 루프 (전략·시장 기록·일일 리포트. 웹과 별개)

# 엔진 CLI (웹 화면 전까지의 조작 수단): account · orders [--all] · fills · buy <종목> <수량> [--limit P] [--target P --stop P [--days N]] [--by 이름]
#   sell <주문번호> · cancel · modify · reservations · sync · halt/resume · analyze <종목> [--buy] · scan KR [--no-ai] · record KR · daily-report
uv run python -m paper_engine --help

# 검사 (ci.yml과 같은 순서)
uv run ruff check . && uv run pytest               # 엔진·백엔드 (외부 API는 전부 가짜 객체)
uv run pytest backtest
cd frontend && npm ci && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build

# 단일 테스트
uv run pytest engine/tests/<파일>.py::<테스트명>
cd frontend && npx vitest run src/<파일>.test.tsx
```

키움 읽기 전용 실측 확인 (앱키·IP 등록 후): `scripts/kiwoom_check.py`, 스냅샷 `005930`, 선별 `scan KR --no-ai`, 시장 기록 `record KR`, 백테스트 `--market KR`.

## 작업 순서와 협업 규칙

- 단계 0 복제·재배치 → 1 토스 경로 직접 호출을 클라이언트 메서드로 이동 → 2 **공통 결정 문서**(DB 표, OpenAPI 초안, 설정 키, 작업 큐 형식)
  → 3 키움 API 확인 → 4A~4E 병렬(키움 클라이언트 / 모의 엔진 / Django / React / 인프라) → 5 통합 → 6 독립 리뷰 → 7 EC2 배포.
- **단계 1은 클라이언트 교체 전에, 토스 상태에서 먼저 한다.** 대상: 장 달력 `market_calendar`, 전체 종목 `listed_stocks`,
  순위+기준 시각 `rankings_with_time`, 일봉 페이지 `candles_before` (원본 파일·줄 번호는 계획서 3-1).
- 병렬 작업자에게 넘기기 전에 단계 2의 공통 결정을 메인이 확정한다. 여러 작업자가 같은 파일을 수정하지 않게 나눈다.
- `main`에 직접 push해도 된다. PR·리뷰 필수 규칙과 브랜치 보호는 두지 않는다 (2026-10-02 결정). push 전에 테스트를 돌린다.
- 배포(`deploy.yml`): GHCR 이미지(태그=커밋 해시) → EC2 `docker compose pull` → `migrate` → `up -d` → `/api/health` 확인, 실패 시 이전 태그로 되돌림.
- EC2는 자동 할당 공인 IP라 **인스턴스를 중지하면 IP가 바뀐다** (키움 IP 등록, GitHub Secrets, 접속 주소를 다시 맞춰야 함).

## 미정 항목 (기본값으로 진행)

초기 자금(팀원별 1천만원), 미국 시장 포함 여부(키움 확인 후), AI 비용 한도(`AI_DAILY_BUDGET_USD` 하루 $10, 팀원별 하루 5종목),
도메인(없으면 IP + HTTP), GitHub 저장소 위치. 바뀌면 계획서 5장과 이 파일을 함께 갱신한다.
