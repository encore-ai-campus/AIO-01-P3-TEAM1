# AGENTS.md

키움 REST API 시세로 돌리는 **팀 모의매매 웹 서비스**다. 원본은 토스증권 실주문까지 내던 개인용 스윙 매매 자동화(`toss_trading`)이고,
이 저장소는 그것을 복제해 실주문을 없애고 가상 현금 계좌로 체결을 흉내 내도록 바꾼 것이다.
계획은 `TEAM_PAPER_TRADING_PLAN.md`, 작업자 간 공통 결정은 `docs/DECISIONS.md`, 웹 API 계약은 `docs/API.md`, 엔진 설계는 `docs/DESIGN.md`, 키움 API는 `docs/KIWOOM.md`.

## 안전 규칙 (반드시 준수)

- **실주문 코드 0건.** 증권사 주문·계좌 API를 부르는 코드를 만들지 않는다. 키움은 시세·일봉·순위·종목 정보 조회 TR만 쓴다.
  `orders.py`, `create_order`, `LIVE_TRADING`, `--live`, `--bypass`가 코드 검색에서 나오면 안 된다.
  `tossinvest`는 로컬 개발용 조회 클라이언트 `engine/paper_engine/data/toss.py`의 주소 한 곳에만 있어야 한다.
- **토스 조회는 로컬 개발 환경 전용이다.** `.env`의 `BROKER=toss`(+ `CLIENT_ID`, `CLIENT_SECRET`)로 켜고, 운영(EC2)은 키움만 쓴다
  (`POSTGRES_HOST`가 있으면 `BROKER=toss`를 거부한다). `data/toss.py`에 계좌·주문 메서드를 넣지 않는다 (토큰 발급 말고는 GET만).
  설명은 `docs/DECISIONS.md` 3-1장.
- **AI는 제안만 한다.** 지표 계산, 사실 검증, 수량·한도·체결 가능 여부는 결정론적 코드(리스크 엔진, 모의 체결기)가 판단한다.
  최소 손익비 2.0은 AI 프롬프트에 노출하지 않는다.
- **엔진 내부 데이터 형식은 토스 형식을 유지한다.** 키움 응답 → 내부 형식 변환은 `engine/paper_engine/data/kiwoom.py` 안에서만 한다.
  조회 클라이언트는 `data/broker.make_client`로만 만들고, `KiwoomClient`와 `TossClient`의 공개 메서드 이름·인자·반환 형식은 같게 둔다.
- **엔진(`engine/`)은 표준 라이브러리만 쓴다.** Django·DRF·psycopg·gunicorn 등 외부 의존성은 `backend/`에만 추가한다.
- **운영 중인 원본 `toss_trading`에 영향을 주지 않는다.** Redis 키 접두사는 `paper:`만 쓴다 (`toss:*` 금지).
  토스 토큰은 client당 1개만 유효하다. 원본과 같은 `CLIENT_ID`로 토큰을 받으면 원본의 토큰이 무효가 되므로 개발용 client를 따로 쓴다.
  `personal_project_files/`는 원본 복사본(참고용, git 제외)이다. 고치지 않고, 그 안의 데이터를 가져오지 않는다.
- 커밋은 사용자가 요청할 때만 한다. `main`에 직접 push해도 된다 (PR·리뷰 필수 아님). push 전에 테스트를 돌린다.

## DB

- **로컬 개발 환경(이 PC)은 SQLite, EC2에 올렸을 때는 PostgreSQL을 쓴다.**
  - Django(`backend/config/settings.py`)는 `POSTGRES_HOST`가 비어 있으면 SQLite(`backend/db.sqlite3`), 있으면 PostgreSQL을 쓴다.
    로컬 `.env`는 `POSTGRES_HOST`를 비워 두고, EC2의 `.env`에서만 `POSTGRES_HOST=db`와 비밀번호를 채운다.
  - 같은 Django 모델·마이그레이션을 두 DB에 쓰므로 PostgreSQL 전용 기능(JSONB 연산자, ArrayField, `DISTINCT ON` 등)은 쓰지 않는다.
    운영과의 차이는 CI(PostgreSQL 서비스 컨테이너)에서 잡는다.
  - 로컬에서 운영과 같은 PostgreSQL로 확인해야 할 때만 `docker compose -f deploy/compose.dev.yml --profile postgres up -d`로 띄우고
    `POSTGRES_HOST=127.0.0.1`을 준다. 기본 `up`은 Redis만 띄운다.
- 엔진의 기록 저장소는 지금 SQLite 파일(`data/trading.db`, `records/store.py`)이다. 다음 단계(4C)에서 Django ORM으로 옮기면
  위 규칙(로컬 SQLite, EC2 PostgreSQL)을 그대로 따른다. 표 이름·열은 `docs/DECISIONS.md` 4장.
- 원본 DB(`data/trading.db`)에는 실포지션이 있었으므로 절대 가져오지 않는다.

## 비밀 정보

- 키움 앱키·시크릿, DevPass, DART, data.go.kr, Django 비밀키, DB 비밀번호, 봇 토큰은 `.env`에만 둔다 (운영 값은 EC2의 `.env`).
  토스 키(`CLIENT_ID`, `CLIENT_SECRET`)는 개발자 로컬 `.env`에만 둔다 (EC2에 넣지 않는다).
  저장소에는 `.env.example`(개발용 기본값)만 둔다. 항목 설명은 `docs/DECISIONS.md` 2장.
- 토큰·시크릿을 로그·출력·커밋에 남기지 않는다.

## 구조

```
engine/paper_engine/   매매 엔진 (선별, AI 교차검증, 리스크 엔진, 모의 체결, 기록, 리포트). engine/tests/
backend/               Django: config/(설정, engine.py 엔진 접점, api.py 공통), accounts/(로그인·프로필·팀 계정),
                       trading/(팀원별 계좌·주문·시세·랭킹·run_engine), analysis/(AI 분석 색인·작업),
                       reports/(AI 리포트 구조: YAML Registry·Shared State·Trace·SSE. Agent·Orchestrator는 미구현). 테스트는 backend/<앱>/tests/
frontend/              React + TypeScript + Vite + Tailwind CSS (로그인·홈·종목·내 주식·AI 분석·AI 리포트·랭킹·My Page)
backtest/              백테스트 (AI 없음, DB 없이 단독 실행)
deploy/compose.dev.yml 로컬 Redis (+ 선택 PostgreSQL)
docs/                  DESIGN.md, DECISIONS.md, API.md, KIWOOM.md
```

## 실행

```bash
uv sync                                            # 엔진 + 백엔드 + 개발 도구 (루트에서)
uv run ruff check . && uv run pytest               # 엔진·백엔드 테스트 (외부 API는 전부 가짜 객체)
uv run pytest backtest                             # 백테스트 테스트
uv run python -m paper_engine --help               # 엔진 CLI
uv run python -m paper_engine serve                # 엔진 상주 루프 (모의 체결 확인, 시장·자산 기록, 리포트, 예약, 전략)
docker compose -f deploy/compose.dev.yml up -d     # 로컬 Redis
cd backend && uv run python manage.py migrate      # DB 표 (로컬 SQLite)
cd backend && uv run python manage.py create_team_accounts   # 팀원 계정 5개 → team_accounts.txt (git 제외)
cd backend && uv run python manage.py runserver    # Django (로컬 SQLite, .env에 DJANGO_DEBUG=on 또는 DJANGO_SECRET_KEY)
cd backend && uv run python manage.py run_engine   # 웹 엔진 루프 (지정가 체결·청산·예약·일별 자산·AI 분석 작업)
cd frontend && npm ci && npm run dev               # Vite (/api, /admin을 127.0.0.1:8000으로 프록시. 다른 포트면 VITE_API_TARGET=..., VITE_MOCK=1이면 가짜 API)
cd frontend && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build
```

웹(팀원별 계좌)과 별개로, 엔진 자체 계좌(전략·AI 자동 매수용)는 엔진 CLI로 조작한다 (요청자는 `--by 이름`):

```bash
uv run python -m paper_engine account                                   # 현금, 평가액, 손익, 보유
uv run python -m paper_engine buy 005930 10 --target 77000 --stop 66000 --by alice   # 정규장 밖 시장가는 다음 정규장 예약
uv run python -m paper_engine orders [--all] · fills · sell <주문번호> · cancel <주문번호> · modify <주문번호> --target P
uv run python -m paper_engine sync                                      # 체결·청산을 지금 한 번 확인
uv run python -m paper_engine halt | resume                             # 새 모의 매수 중단 스위치
uv run python -m paper_engine analyze 005930 --buy --by alice           # AI 교차검증 (약 $0.3/종목), 승인되면 모의 매수
```

## 작업 방식

- 코드 변경 전 관련 파일을 먼저 읽고 기존 스타일을 따른다.
- 키움 API 동작은 추측하지 말고 문서와 실제 응답으로 확인한다 (`docs/KIWOOM.md`, `scripts/kiwoom_check.py`).
- AI 리포트의 Agent·Orchestrator를 구현할 때: 개념은 루트의 `교육용문서.md`, State·Trace는 `backend/reports/state.py`의 함수로만 바꾼다
  (`docs/DECISIONS.md` 9-4). Guard 사건의 `details`에는 대상(`step`, `to`)을 넣는다 (`docs/API.md`).
- 웹 API를 바꾸면 `docs/API.md`를 먼저 고친다 (백엔드와 프론트가 같이 따르는 계약). 테스트는 실제 증권사·AI를 부르지 않는다
  (루트 `conftest.py`가 키를 비운다. 가짜 클라이언트를 `config.engine`에 끼운다).
- 계획이 바뀌면 `TEAM_PAPER_TRADING_PLAN.md`, `CLAUDE.md`, 이 파일을 함께 고친다.
