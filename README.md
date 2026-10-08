# 모매매 — 자동 주식 추천, 거래 서비스

주식이 처음인 사람도 **AI 리포트를 만들고 · 읽고 검토하고 · 모의 자동매매로 실행해 보는** 팀 모의투자 웹 서비스다.
시세는 증권사 조회 API로만 받고(운영은 키움 REST, 로컬 개발은 토스 조회), 매매는 팀원별 가상 현금 계좌에서만 체결한다. **실제 주문은 내지 않는다** (실주문 코드 0건).

## 서비스 흐름 · AI Agent 워크플로우 · ERD

### 서비스 흐름

```mermaid
flowchart LR
    classDef code fill:#e8f1ff,stroke:#3b82f6,color:#0b2a5b
    classDef ai fill:#fff4e5,stroke:#f59e0b,color:#5a3300
    classDef decide fill:#eafaf0,stroke:#16a34a,stroke-width:3px,color:#0f3d22

    S["선별<br/>규칙 점수"]:::code --> R["AI 리포트<br/>근거·위험·목표가"]:::ai
    R --> K["리스크 엔진<br/>손익비·수량"]:::code --> REC["AI 추천"]:::code
    REC --> U["사용자가 리포트 검토<br/>웹 · A4 PDF<br/>계획 활성화"]:::decide
    U --> T["모의 자동매매"]:::code --> N["알림<br/>웹 · Discord"]:::code
```

- **AI는 제안만 한다.** 지표 계산·사실 검증·수량·한도·체결은 결정론적 코드(리스크 엔진, 모의 체결기)가 정한다.
- **최종 결정은 사람이 한다.** 사용자가 리포트를 읽고 직접 계획을 활성화해야 모의 자동매매가 시작된다.

### AI 리포트 Agent 워크플로우

```mermaid
flowchart LR
    classDef code fill:#e8f1ff,stroke:#3b82f6,color:#0b2a5b
    classDef ai fill:#fff4e5,stroke:#f59e0b,color:#5a3300
    classDef ok fill:#eafaf0,stroke:#22c55e,color:#0f3d22
    classDef fail fill:#fdecec,stroke:#ef4444,color:#5b0b0b

    IN["리포트 신청<br/>팀원 · 자동 선별"]:::code

    subgraph RS["① 조사 · 병렬 · 60초"]
        M["시세·차트<br/>market_agent · 필수"]:::ai
        F["재무·공시<br/>fundamental_agent · 필수"]:::ai
        NW["뉴스·심리<br/>news_agent · 선택"]:::ai
    end

    J{"Join Guard<br/>필수 결과·계약 통과?"}:::code
    W["② 작성 · 90초<br/>report_agent"]:::ai
    V{"③ 검토 · 60초<br/>review_agent"}:::ai
    RK["리스크 점검<br/>risk_agent"]:::ai
    OK["완료<br/>본문 · A4 PDF<br/>buy면 AI 추천"]:::ok
    X["실패 종료<br/>사유 코드 · 알림"]:::fail

    IN --> M & F & NW
    M & F & NW --> J
    J -- "통과" --> W --> V
    J -- "join_blocked" --> X
    V -- "RETRY ≤ 2<br/>수정 지시" --> W
    V -- "PASS" --> OK
    V -. "Handoff ≤ 1<br/>투자유의·고위험" .-> RK -.-> OK
    V -- "FAIL<br/>review_failed" --> X
```

- 정의는 YAML Registry(`backend/reports/team_definitions.yaml`·`worker_definitions.yaml`), Worker 출력 계약은 `contracts.py`.
- 모든 AI 호출은 `healing.py`를 거친다: 같은 모델 재시도 → 대체 모델 → Circuit Breaker. 호출 한 번은 **최대 4회** 시도한다 (주 모델 2회 + 대체 모델 2회). 진행은 `state.py`가 Shared State·Trace로 남기고 SSE로 화면에 보낸다.
- 실행은 `orchestrator.py`(병렬·Join Guard·부분 실패·검토 반복·Handoff Guard)와 `runner.py`(엔진 루프에서 한 번에 하나), Worker는 `agents/` (2026-10-07 구현).
  종목 선정까지 AI 팀으로 하는 하루 파이프라인(규칙 후보 30 → 선정 팀 → 선정 Guard → 자동 리포트 3개, `AUTO_REPORT=on`)은 [docs/AI_AGENT_WORKFLOW.md](docs/AI_AGENT_WORKFLOW.md).

### ERD

```mermaid
erDiagram
    auth_user ||--|| accounts_profile : "닉네임·공개"
    auth_user ||--o| investor_profiles : "주린이모드·진단"
    auth_user ||--|| paper_account : "모의 계좌"
    paper_account ||--o{ paper_orders : "주문"
    paper_orders ||--o{ paper_fills : "체결"
    paper_account ||--o{ equity_daily : "일별 자산"
    paper_account ||--o{ reservations : "장 밖 예약"
    auth_user ||--o{ jobs : "AI 분석 요청"
    auth_user |o--o{ reports : "리포트 신청"
    reports ||--o{ report_trace_events : "Trace"
    reports |o--o| recommendations : "리포트 출처"
    analysis_runs |o--o| recommendations : "분석 출처"
    recommendations ||--o{ trade_plans : "사람이 활성화"
    auth_user ||--o{ trade_plans : "활성화한 팀원"
    paper_orders |o--o{ trade_plans : "진입 주문"
    trade_plans ||--o{ trade_plan_events : "단계 사건"
    auth_user ||--o{ notifications : "웹 알림"
    auth_user ||--o| notification_settings : "Discord 설정"
    auth_user ||--o{ investment_theses : "산 이유"
    investment_theses ||--o{ thesis_checks : "펀더멘털 점검"

    auth_user {
        int id PK
        string username
    }
    accounts_profile {
        int user_id FK
        string nickname UK
        bool is_public
    }
    investor_profiles {
        int user_id FK
        bool beginner_mode
        string risk_profile
    }
    paper_account {
        int id PK
        int user_id FK
        float cash_krw
    }
    paper_orders {
        int id PK
        int account_id FK
        string symbol
        string status
        string style "swing, long"
    }
    paper_fills {
        int id PK
        int order_id FK
        string side
        float price
    }
    equity_daily {
        int account_id FK
        date day
        float equity_krw
    }
    reservations {
        int id PK
        int account_id FK
        int order_id FK
        string kind
    }
    jobs {
        int id PK
        int user_id FK
        string status
    }
    analysis_runs {
        int id PK
        string symbol
        string verdict
    }
    reports {
        int id PK
        int user_id FK "자동 리포트면 null"
        string source "user, auto"
        string status
        json results "Worker 결과"
    }
    report_trace_events {
        int id PK
        int report_id FK
        int step
        string action
    }
    recommendations {
        int id PK
        int report_id FK
        int analysis_id FK
        string source "report, analysis, demo"
        string status "open, expired"
    }
    trade_plans {
        int id PK
        int recommendation_id FK
        int user_id FK
        int order_id FK
        string status
    }
    trade_plan_events {
        int id PK
        int plan_id FK
        string kind
    }
    notifications {
        int id PK
        int user_id FK
        string kind
    }
    notification_settings {
        int user_id FK
        bool discord_enabled
    }
    investment_theses {
        int id PK
        int user_id FK
        string symbol
    }
    thesis_checks {
        int id PK
        int thesis_id FK
        string overall
    }
```

표 이름은 실제 `db_table`이고 열은 핵심만 적었다. 이 밖에 FK 없는 표: `notification_outbox`(Discord 보낼 글), `daily_move_notes`(오늘의 내 종목 뉴스), `analysis_run_files`(분석 파일 색인).
워크플로우가 쓰는 표의 자세한 열은 [docs/AI_AGENT_WORKFLOW.md](docs/AI_AGENT_WORKFLOW.md) 0장, 엔진 CLI의 기록 저장소(`data/trading.db`)는 `docs/DECISIONS.md` 4장.

## 기술 스택

| 영역 | 기술 | 어디에 쓰나 |
|---|---|---|
| 백엔드 | Python 3.12 · Django 5.2 · DRF · drf-spectacular · gunicorn | 웹 API(`backend/` 앱 7개, 세션 인증), OpenAPI `/api/schema/`, 엔진 루프 `run_engine` |
| 매매 엔진 | Python 표준 라이브러리만 | 선별·AI 교차검증·리스크 엔진·모의 체결(`engine/paper_engine`), 엔진 CLI |
| DB | SQLite · PostgreSQL 16 (psycopg) | 혼자 개발·테스트 / 공유 개발 DB·운영 — `.env`의 `POSTGRES_HOST`로 고른다 |
| 캐시·실시간 | Django LocMemCache · Redis 7 · SSE | 웹의 시세·조회 캐시 / 엔진 CLI 상주 루프·예약(`paper:` 키) / 리포트 진행 화면 |
| 프론트 | React 19 · TypeScript · Vite · Tailwind CSS 4 · TanStack Query · React Router · lightweight-charts · react-markdown | 화면 SPA(`frontend/`), 서버 상태 폴링, 차트, 리포트 본문 |
| AI | DevPass LLM Gateway (OpenAI 호환) | AI 교차검증 분석, 리포트 Worker 호출(`reports/healing.py`), 장기투자 뉴스 문장 |
| 외부 데이터 | 키움 REST · 토스(로컬 개발 전용) · DART OpenAPI · Google 뉴스 RSS | 시세·일봉·순위·종목 정보(조회만) · 공시·재무 · 뉴스 제목 |
| PDF·알림 | Chrome headless · Discord Webhook | 리포트 A4 PDF · 단계별 알림 (웹 알림은 DB) |
| 배포 | Docker Compose · nginx · GitHub Actions · GHCR · AWS EC2 | 운영 구성(nginx·web·engine·db·redis), 검사 → 이미지 → 서버 배포 → 실패 시 되돌리기 |
| 검사 도구 | uv · ruff · pytest · ESLint · Vitest · Testing Library · MSW | 파이썬 의존성·린트·테스트, 프론트 린트·테스트·가짜 API(`VITE_MOCK=1`) |

버전·구성의 자세한 내용은 [docs/TEAM_PAPER_TRADING_PLAN.md](docs/TEAM_PAPER_TRADING_PLAN.md) 2장.

## 지금 상태 (2026-10-07)

| 기능 | 상태 |
|---|---|
| 모의 계좌·주문 — 팀원별 계좌, 시장가·지정가, 장 밖 예약, 목표·손절 청산, 보유 방식 스윙·장기 | 동작 (장중 지정가 체결·자동 청산 실측은 아직) |
| 종목·차트 — 시세는 실시간, 계좌 평가·랭킹은 장마감 기준 | 동작 |
| AI 교차검증 분석 — 팀원별·팀 하루 한도 | 구현됨 (실제 AI 실행은 CLI 1건만 확인) |
| AI 리포트 — 신청·하루 한도, YAML Registry, State·Trace, SSE, A4 PDF, 쉬운 보기, 끝 알림 | 동작 (2026-10-07 구현: Orchestrator·Worker 11개·선정 팀·자동 리포트, 가짜 LLM 테스트로 확인 — 실제 모델 실행·장애 주입·복구 지표는 아직) |
| 추천 → 활성화 → 모의 자동매매 → 알림 | 시연판 (규칙 추천 `demo_recommend`로 끝까지 돈다. AI 리포트가 붙으면 리포트 출처 추천이 생긴다) |
| 장기투자 — "왜 샀나요?", 오늘의 내 종목 뉴스, 펀더멘털 점검 | 동작 (정해진 시각의 실제 실행 확인은 아직) |
| 주린이모드·화면 — 쉬운 보기, 하단 탭(홈·종목·리포트·모의투자·마이), 다크 모드 | 동작 |
| 알림 — 웹 알림, Discord Webhook | 웹 동작, Discord는 꺼 둠 |
| 엔진 CLI·백테스트 | 동작 (웹 계좌와 별개) |
| ~~단타 연습~~ | 2026-10-06 폐기 |

자세한 상태·근거는 [docs/TEAM_PAPER_TRADING_PLAN.md](docs/TEAM_PAPER_TRADING_PLAN.md), 남은 결정·확인은 [docs/결정필요사항.md](docs/결정필요사항.md).

## 설치

**팀원**: 호스트 PC 담당자에게 받은 `.env.team`을 AI 코딩 에이전트(Claude Code, Codex 등)에 주고 "이 `.env.team` 파일로 세팅해 줘"라고 하면
클론부터 서버 실행까지 진행한다. 이미 클론했으면 "`SETUP_PROMPT.md`를 읽고 그대로 진행해 줘" ([SETUP_PROMPT.md](SETUP_PROMPT.md)).
`.env`·`.env.team`에는 비밀 값이 들어가므로 커밋하지 않는다.

**Windows**: 먼저 [WSL2_SETUP.md](WSL2_SETUP.md)로 WSL2 Ubuntu와 VS Code 연결을 준비한다 (WSL이 아닌 Windows에서는 돌지 않는다).

직접 하려면 (macOS·Linux·WSL2):

```bash
cp .env.example .env              # 키를 채운다 (커밋하지 않는다)
uv sync                           # 엔진 + 백엔드 + 개발 도구
cd frontend && npm ci
```

## 웹 실행 (로컬 개발)

```bash
scripts/dev.sh            # (PostgreSQL 컨테이너 +) Django API + 엔진 루프 + 프론트엔드를 한 번에 (다시) 띄운다. 끝나면 주소와 DB 위치를 보여 준다
scripts/dev.sh stop       # 전부 내린다          · status · logs [backend|engine|frontend] · db (DB 셸) · db-stop · import-sqlite
```

- 프론트엔드는 `0.0.0.0`에 떠서 같은 네트워크의 휴대폰·다른 PC에서 `http://<이 PC의 IP>:5173`으로 볼 수 있다. Django는 이 PC에서만 접근한다.
- 8000·5173 포트가 사용 중이면 다음 빈 포트를 알아서 쓴다.
- DB는 `.env`의 `POSTGRES_HOST`로 고른다: 비어 있으면 SQLite(`backend/db.sqlite3`), `127.0.0.1`이면 이 PC에 PostgreSQL 컨테이너를 띄우고,
  호스트 PC의 IP면 팀이 같이 보는 개발 DB를 쓴다. 접속 방법은 [TEAM_DEV_PLAN.md](TEAM_DEV_PLAN.md) 12장.
- 로그인 아이디·비밀번호는 `team_accounts.txt`에 있다. 팀원마다 모의 계좌(초기 자금 `PAPER_CAPITAL_KRW`)가 하나씩 생긴다.

하나씩 직접 띄우려면:

```bash
cd backend && uv run python manage.py migrate                # DB 표
cd backend && uv run python manage.py create_team_accounts   # 팀원 계정 5개 → team_accounts.txt (git 제외, 다시 실행해도 안전)
cd backend && uv run python manage.py runserver              # Django API (기본 127.0.0.1:8000. .env에 DJANGO_DEBUG=on)
cd backend && uv run python manage.py run_engine             # 엔진 루프: 체결·청산·예약·일별 자산·AI 분석·추천 수집·리포트 알림·자동 추천·자동매매·장기투자·알림 발송
cd frontend && npm run dev                                   # 화면 (http://localhost:5173, /api·/admin을 127.0.0.1:8000으로 프록시)
```

- Django를 다른 포트에 띄웠으면 `VITE_API_TARGET=http://127.0.0.1:8001 npm run dev`.
- 백엔드 없이 화면만 볼 때는 `VITE_MOCK=1 npm run dev` (가짜 API).
- 시연용 추천(AI 아님): `cd backend && uv run python manage.py demo_recommend --symbol 005930` · 선별 상위로 `auto_recommend --force`.

## 검사

```bash
uv run ruff check . && uv run pytest     # 엔진·백엔드 (SQLite 메모리 DB, 외부 API는 전부 가짜 객체)
uv run pytest backtest                   # 백테스트
cd frontend && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build
```

push하면 GitHub Actions가 같은 검사를 돌린다. `main`은 검사를 통과해야 배포된다.

## 구조

```
engine/paper_engine/   매매 엔진 (선별, AI 교차검증, 리스크 엔진, 모의 체결, 기록, 리포트) — 표준 라이브러리만
backend/               Django: accounts(로그인·프로필·주린이모드) · trading(계좌·주문·시세·랭킹·run_engine) · analysis(AI 분석)
                       reports(AI 리포트: Registry·State·Trace·SSE·PDF·선별·출력 계약) · autotrade(추천·활성화·자동매매)
                       notifications(웹 알림·Discord) · longterm(장기투자)
frontend/              React + TypeScript + Vite + Tailwind CSS
backtest/              백테스트 (AI 없음, DB 없이 단독 실행)
deploy/                Docker Compose (개발용 Redis·PostgreSQL, 운영 nginx·web·engine·db·redis), 배포 스크립트
docs/                  설계·결정·API 계약·담당별 작업(tasks/)·작업 문서(works/)
```

엔진 자체 계좌(웹 계좌와 별개)는 CLI로 조작한다: `uv run python -m paper_engine --help` (명령은 [AGENTS.md](AGENTS.md) "실행").

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | 안전 규칙·명령·작업 방식 (AI 에이전트와 팀원 공통) |
| [SETUP_PROMPT.md](SETUP_PROMPT.md) · [WSL2_SETUP.md](WSL2_SETUP.md) | 클론 직후 설치·실행 (AI 에이전트용) · Windows의 WSL2·VS Code 준비 |
| [docs/TEAM_PAPER_TRADING_PLAN.md](docs/TEAM_PAPER_TRADING_PLAN.md) · [docs/결정필요사항.md](docs/결정필요사항.md) | 지금 상태·남은 작업 · 남은 결정과 다음 시작점 |
| [TEAM_DEV_PLAN.md](TEAM_DEV_PLAN.md) · [docs/tasks/](docs/tasks/) | 팀원이 이어서 할 일과 개발 환경 · 담당별 세부 작업과 담당 간 약속 |
| [docs/API.md](docs/API.md) · [docs/DECISIONS.md](docs/DECISIONS.md) | 웹 API 계약 · 공통 결정 |
| [docs/교육용문서.md](docs/교육용문서.md) · [docs/AI_AGENT_WORKFLOW.md](docs/AI_AGENT_WORKFLOW.md) | Agent 개념 · 종목 선정 Agent 워크플로우 설계 예시 (오류 복구 포함) |
| [docs/DESIGN.md](docs/DESIGN.md) · [docs/KIWOOM.md](docs/KIWOOM.md) | 엔진 설계 · 키움 API |
| [docs/화면배치.md](docs/화면배치.md) | 화면별 배치와 근거 |
| [docs/DEPLOY.md](docs/DEPLOY.md) | 배포와 CI/CD |
| [docs/프로젝트평가기준.md](docs/프로젝트평가기준.md) | 과제 평가 기준 |

## 배포와 CI/CD (Docker)

push하면 GitHub Actions가 검사한다 (린트 → 실주문 코드 검사 → 테스트 → 프론트 빌드 → 이미지 빌드와 기동 확인). `main`은 검사를 통과하면 이미지를 올리고
서버에 배포하며, 새 버전이 뜨지 않으면 직전 버전으로 되돌린다. 설정과 동작은 [docs/DEPLOY.md](docs/DEPLOY.md).

```bash
cd deploy && cp .env.docker.example .env.docker      # 값을 채운다 (커밋하지 않는다)
docker compose --env-file .env.docker up -d --build   # nginx · web · engine · db · redis
./smoke_test.sh                                       # 띄운 스택 확인
```
