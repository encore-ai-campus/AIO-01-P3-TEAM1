# AGENTS.md

**토스증권 API 시세(조회 전용)**로 돌리는 **팀 모의매매 웹 서비스**다. 처음 계획한 키움 REST API 대신 토스 API를 쓴다 (키움 클라이언트는 코드에 남아 있어 `BROKER=kiwoom`으로 바꿀 수 있다). 원본은 토스증권 실주문까지 내던 개인용 스윙 매매 자동화(`toss_trading`)이고,
이 저장소는 그것을 복제해 실주문을 없애고 가상 현금 계좌로 체결을 흉내 내도록 바꾼 것이다.
지금 상태·기술 스택·남은 작업은 `docs/plans/TEAM_PAPER_TRADING_PLAN.md`, 팀원이 이어서 개발할 일과 개발 환경 안내는 `docs/plans/TEAM_DEV_PLAN.md`, 과제 평가 기준은 `docs/evaluation/프로젝트평가기준.md`, 클론 직후 설치·실행 절차는 `docs/guides/SETUP_PROMPT.md`(Windows는 먼저 `docs/guides/WSL2_SETUP.md`), 작업자 간 공통 결정은 `docs/DECISIONS.md`, 웹 API 계약은 `docs/API.md`, 담당별 세부 작업과 담당 간 약속은 `docs/tasks/`(서비스 최종 흐름 AI 추천 → 계획 활성화 → 자동매매 → 알림은 `06-추천·자동매매.md`), 배포와 CI/CD는 `docs/DEPLOY.md`, 엔진 설계는 `docs/design/DESIGN.md`, 키움 API는 `docs/KIWOOM.md`, 화면별 배치와 근거는 `docs/design/화면배치.md`(모션·다크모드·색 토큰 규칙은 `docs/DECISIONS.md` 15장).
합의된 계획(2026-10-04, 팀장 결정 — `docs/DECISIONS.md` 13장): 서비스 이름 **"모매매"**(2026-10-07 바뀜, 전 이름 "종이배"·"AI 리포트 데스크" — `docs/DECISIONS.md` 18장·15-7) — 초보자도 리포트를 만들고·검토하고·모의 자동매매로 실행한다(`docs/plans/컨셉변경계획.md`),
주린이모드(계정 저장)와 투자 방식 확장 장기·스윙(`docs/plans/투자서비스확장계획.md`, **선물·단타는 폐기** — `docs/DECISIONS.md` 16장), AI 교차검증 분석은 사용자 화면에 남긴다. 조사 근거·약관 검토는 `docs/research/`.
구현 상태(2026-10-06): 장마감 기준 가격(시세는 2026-10-06부터 실시간 — `docs/DECISIONS.md` 17장)·보유 방식(스윙·장기)·장기투자(오늘의 내 종목 뉴스·펀더멘털 점검)·주린이모드·리포트 끝 알림·하루 리포트 한도는 만들었다
(`docs/API.md`의 "구현: 2026-10-05 (Claude)", 결정 `docs/DECISIONS.md` 14장). 리포트 Agent 워크플로우(Orchestrator·Worker 11개·매매 종목 선정 팀)·자동 리포트는 2026-10-07 사용자 요청으로 Claude가 구현했다 (`docs/DECISIONS.md` 19장 — 장애 주입·복구 지표·비용 예산은 팀 몫). (2026-10-05에 만든 단타 연습은 2026-10-06 사용자 결정으로 모두 지웠다 — `docs/DECISIONS.md` 16장.)
**남은 결정·확인 목록과 다음 세션 시작점은 `docs/결정필요사항.md`** (결정하면 상태를 고치고 원래 문서에 옮긴다).

## 안전 규칙 (반드시 준수)

- **실주문 코드 0건.** 증권사 주문·계좌 API를 부르는 코드를 만들지 않는다. 토스 API는 시세·일봉·순위·종목 정보 조회만 쓴다 (키움도 조회 TR만).
  `orders.py`, `create_order`, `LIVE_TRADING`, `--live`, `--bypass`가 코드 검색에서 나오면 안 된다.
  `tossinvest`는 토스 조회 클라이언트 `engine/paper_engine/data/toss.py`의 주소 한 곳에만 있어야 한다.
- **시세 조회는 키움 API 대신 토스 API를 쓴다.** 로컬 개발과 운영(EC2) 모두 `.env`(운영은 `.env.docker`)의 `BROKER=toss`(+ `CLIENT_ID`, `CLIENT_SECRET`)로 켠다.
  `DJANGO_DEBUG=off`인 운영은 `ALLOW_TOSS_BROKER=on`이 있어야 `BROKER=toss`를 받는다 (`docs/DECISIONS.md` 3-1·23장). `data/toss.py`에 계좌·주문 메서드를 넣지 않는다 (토큰 발급 말고는 GET만).
  설명은 `docs/DECISIONS.md` 3-1장.
- **AI는 제안만 한다.** 지표 계산, 사실 검증, 수량·한도·체결 가능 여부는 결정론적 코드(리스크 엔진, 모의 체결기)가 판단한다.
  AI 추천을 활성화한 매매 계획(`backend/autotrade`)도 같다: 넣을 돈은 사용자가 정하고(매수 가능 금액의 % 또는 원, 2026-10-11 — `docs/DECISIONS.md` 28장),
  수량 계산·한도 점검·활성화 여부는 리스크 엔진, 주문·체결은 `trading.service`와 모의 체결기.
  예외: 시연용 수동 시작(사용자가 '수동매매 (시연용)'을 누르고 확인한 계획만)은 손익비·기대값 점검만 건너뛴다 (2026-10-12 — `docs/DECISIONS.md` 31장).
  최소 손익비(스윙 1.5)는 AI 프롬프트에 노출하지 않는다. 손절가는 AI가 아니라 코드가 정한다 (`engine/paper_engine/judge/stops.py`).
- **엔진 내부 데이터 형식은 토스 형식을 유지한다.** 키움 응답 → 내부 형식 변환은 `engine/paper_engine/data/kiwoom.py` 안에서만 한다.
  조회 클라이언트는 `data/broker.make_client`로만 만들고, `KiwoomClient`와 `TossClient`의 공개 메서드 이름·인자·반환 형식은 같게 둔다.
- **엔진(`engine/`)은 표준 라이브러리만 쓴다.** Django·DRF·psycopg·gunicorn 등 외부 의존성은 `backend/`에만 추가한다.
- **운영 중인 원본 `toss_trading`에 영향을 주지 않는다.** Redis 키 접두사는 `paper:`만 쓴다 (`toss:*` 금지).
  토스 토큰은 client당 1개만 유효하다. 원본과 같은 `CLIENT_ID`로 토큰을 받으면 원본의 토큰이 무효가 되므로 개발용 client를 따로 쓴다.
  `personal_project_files/`는 원본 복사본(참고용, git 제외)이다. 고치지 않고, 그 안의 데이터를 가져오지 않는다.
- **구현 작업이 끝나면 따로 묻지 않고 자기 변경만 커밋해 `main`에 push한다** (2026-10-07 사용자 결정, 모든 세션). PR·리뷰는 필수가 아니다.
  push 전에 테스트를 돌리고, 최신 `main`을 받아 합친다. 여러 세션이 같은 작업 트리를 쓰므로 다른 세션의 파일·hunk는 스테이지하지 않는다
  (같은 파일을 고쳤으면 자기 hunk만 고르고, 커밋 순서를 메시지로 맞춘다). 계획서·문서만 고친 작업은 사용자가 요청할 때만 커밋한다.
  push하면 GitHub Actions가 같은 검사를 돌리고(`ci.yml`), `main`은 검사를 통과해야 배포된다 (`deploy.yml`, `docs/DEPLOY.md`).

## DB

- **DB는 `.env`의 `POSTGRES_HOST`로 고른다**: 비어 있으면 SQLite(`backend/db.sqlite3`, 혼자 개발할 때의 기본값), 있으면 PostgreSQL.
  - 팀이 같이 보는 개발 DB: `POSTGRES_HOST=127.0.0.1`이면 `scripts/dev.sh`가 이 PC에 PostgreSQL 컨테이너(`deploy/compose.dev.yml`)를 띄운다.
    `POSTGRES_BIND=0.0.0.0`이면 같은 네트워크에서 DB에 접속할 수 있다 (**개발할 때만**). 접속 방법은 `docs/plans/TEAM_DEV_PLAN.md` 12장, `scripts/dev.sh status`.
  - EC2 운영은 `POSTGRES_HOST=db`와 비밀번호를 EC2의 `.env`에만 둔다. 운영에서는 DB 포트를 밖으로 열지 않는다.
  - 같은 Django 모델·마이그레이션을 두 DB에 쓰므로 PostgreSQL 전용 기능(JSONB 연산자, ArrayField, `DISTINCT ON` 등)은 쓰지 않는다.
  - **테스트는 SQLite 메모리 DB에서 돈다** (`.env`가 공유 PostgreSQL을 가리켜도 그 서버를 건드리지 않는다).
    PostgreSQL로 검사할 때만 `TEST_WITH_POSTGRES=1 uv run pytest backend` (CI).
  - SQLite에 쌓인 데이터를 PostgreSQL로 옮길 때는 `scripts/dev.sh import-sqlite` (한 번만).
- 엔진의 기록 저장소는 지금 SQLite 파일(`data/trading.db`, `records/store.py`)이다. 다음 단계(4C)에서 Django ORM으로 옮기면
  위 규칙(`POSTGRES_HOST`로 고름)을 그대로 따른다. 표 이름·열은 `docs/DECISIONS.md` 4장.
- 원본 DB(`data/trading.db`)에는 실포지션이 있었으므로 절대 가져오지 않는다.

## 비밀 정보

- 키움 앱키·시크릿, DevPass, DART, data.go.kr, Django 비밀키, DB 비밀번호, 봇 토큰은 `.env`에만 둔다 (운영 값은 EC2의 `.env`).
  토스 키(`CLIENT_ID`, `CLIENT_SECRET`)도 `.env`에만 둔다 (운영 값은 EC2의 `.env.docker`).
  저장소에는 `.env.example`(개발용 기본값)만 둔다. 항목 설명은 `docs/DECISIONS.md` 2장.
- 토큰·시크릿을 로그·출력·커밋에 남기지 않는다.

## 구조

```
engine/paper_engine/   매매 엔진 (표준 라이브러리만): agents/(AI 교차검증 Agent·모의 체결기 executor), data/(조회 클라이언트·장 달력·뉴스·공시),
                       judge/(리스크 엔진·손절), records/(기록 저장소·계좌), longterm/(장기투자), 선별·일일 리포트·LLM 호출. engine/tests/
backend/               Django 앱. 앱 루트에는 Django 자리(models·migrations·admin·apps·urls·views·payloads·management/)와 앱 공통 모듈만 두고
                       기능 코드는 기능 폴더에 둔다 (`docs/DECISIONS.md` 29장). 테스트는 backend/<앱>/tests/ (reports는 같은 기능 폴더로 나눔)
  config/              설정, engine.py(엔진 접점), api.py(공통)
  accounts/            로그인·프로필·팀 계정, 투자자 프로필·주린이모드
  trading/             팀원별 계좌·주문·시세·랭킹, run_engine(웹 엔진 루프)
  analysis/            AI 교차검증 분석 색인·작업
  reports/             AI 리포트. 루트: models·views·urls·sse(SSE)·payloads·management/(auto_report)
    agents/            Worker — Orchestrator는 agents.WORKERS만 본다. base·prompts(공통),
                       report_team/(종목 리포트 팀: 시세·재무·뉴스 → 작성 → 검토 → 리스크. 등록 team.py),
                       selection_team/(매매 종목 선정 팀: 뉴스·공시·수급 → 선정 → 선정 검토. 등록 team.py)
    orchestration/     Orchestrator·실행기(runner)·YAML Registry(registry, worker_/team_definitions.yaml)·Shared State·Trace(state)
    guardrails/        입력·Join·Handoff Guard(guards)·출력 계약(contracts)·결과 후처리(tidy)
    autohealing/       호출 복구: 재시도·대체 모델·Circuit Breaker(healing)·장애 주입(chaos)·복구 지표(stats)
    autoreport/        자동 리포트 하루 파이프라인(auto, AUTO_REPORT)·선정 Guard(selection)·설정(conf)
    output/            A4 PDF(pdf·쉬운 판 문장 easy_text)·리포트 끝 알림(alerts·문장 text)
    limits/            하루 리포트 한도(quota)·팀 AI 하루 비용 예산(budget)
  autotrade/           AI 추천 → 계획 활성화 → 모의 자동매매. 루트: conf·text(알림 문장)·tokens(Discord 링크 서명)·hide(제안 지우기)
    recommend/         추천 만들기: sources(리포트·분석 → 추천)·demo(시연 규칙 추천)·auto(매일 자동 추천)
    plans/             계획 진행: risk(리스크 미리 보기·수량)·executor(주문·체결 대기·보유 감시·청산·재주문)
  notifications/       웹 알림·Discord Webhook 보낼 편지함 (Discord 발송은 2026-10-08부터 꺼 둠, `docs/DECISIONS.md` 24장)
  longterm/            장기투자: 오늘의 내 종목 뉴스·산 이유와 펀더멘털 점검
frontend/src/          React + TypeScript + Vite + Tailwind CSS (하단 탭 홈·종목·리포트·모의투자·마이, 주린이모드 쉬운 보기, AI 교차검증 분석, 랭킹,
                       화면 모드(다크 — 마이·PC 메뉴, 브라우저 저장))
  pages/               화면 (라우터와 1:1)
  components/          루트에는 여러 화면이 같이 쓰는 부품만(ui.tsx·Icon·Layout·Term·toast·ToastProvider·RequireAuth·DeleteAction·AssetCard),
                       기능 부품은 기능 폴더(reports/·plan/·autotrade/·home/·my/·longterm/·analysis/·stock/·charts/·brand/·admin/·errors/·motion/)
  api/ hooks/ lib/     API 호출·타입 / React 훅 / 계산·문장. 색은 src/index.css 토큰만 (test/colors.test.ts가 검사)
  test/                화면 단위 테스트·setup.ts·도우미. 한 파일만 보는 단위 테스트는 그 파일 옆 (lib/*.test.ts)
  mocks/               VITE_MOCK=1일 때 브라우저의 가짜 API (MSW)
backtest/              백테스트 (AI 없음, DB 없이 단독 실행)
deploy/                compose.dev.yml(로컬 Redis + 선택 PostgreSQL), docker-compose.yml(운영: nginx·web·engine·db·redis),
                       Dockerfile(web·engine), nginx/, .env.docker.example, remote_deploy.sh(서버 배포·되돌리기), smoke_test.sh
.github/workflows/     ci.yml(검사), deploy.yml(main: 검사 → 이미지 → 서버 배포 → 관리 서버 배포 기록. admin/만 바뀌면 안 돈다),
                       admin-ci.yml(관리 서버 검사), admin-deploy.yml(main의 admin/ 변경: 검사 → 이미지 → 관리 서버 배포)
admin/                 관리 서버 (조회 전용, 서비스와 따로 둔 서버·검사·배포): API.md(계약), server/(FastAPI 관리자 백엔드 + MCP, 자기 uv 프로젝트),
                       web/(관리자 화면, 자기 npm 패키지), deploy/(compose·읽기 전용 DB 계정 SQL·remote_deploy.sh), recovery_cases.json(복구 셈법
                       기준 사례 — backend/reports 테스트도 읽는다). 서비스 코드와 서로 import하지 않는다 (README.md).
                       2026-10-08 별도 저장소 SHS5029/paper_admin으로 뺐다가 같은 날 다시 합침 (그 저장소는 더 쓰지 않는다)
docs/                  기준 문서 API.md·DECISIONS.md·DEPLOY.md·KIWOOM.md·결정필요사항.md·교육용문서.md, guides/(설치)·plans/(계획서)·design/(설계)·
                       records/(시험 기록)·evaluation/(평가 기준·기여)·deliverables/(산출물)·tasks/(담당별 작업·공통 약속)·research/·works/ — 지도는 docs/README.md
```

## 실행

```bash
uv sync                                            # 엔진 + 백엔드 + 개발 도구 (루트에서)
uv run ruff check . && uv run pytest               # 엔진·백엔드 테스트 (외부 API는 전부 가짜 객체)
uv run pytest backtest                             # 백테스트 테스트
uv run python -m paper_engine --help               # 엔진 CLI
uv run python -m paper_engine serve                # 엔진 상주 루프 (모의 체결 확인, 시장·자산 기록, 리포트, 예약, 전략)
docker compose -f deploy/compose.dev.yml up -d     # 로컬 Redis
scripts/dev.sh                                     # 웹 전부 (다시) 띄우기: (PostgreSQL 컨테이너 +) Django + run_engine + 프론트(0.0.0.0)
scripts/dev.sh status | stop | logs | db | db-stop | import-sqlite     # 주소·DB 접속 방법 · 내리기 · 로그 · DB 셸 · DB 내리기 · SQLite→PostgreSQL
cd backend && uv run python manage.py migrate      # DB 표. 아래는 하나씩 직접 띄울 때
cd backend && uv run python manage.py create_team_accounts   # 팀원 계정 5개 → team_accounts.txt (git 제외)
cd backend && uv run python manage.py runserver    # Django (.env에 DJANGO_DEBUG=on. PostgreSQL을 쓰면 DJANGO_SECRET_KEY도 필요)
cd backend && uv run python manage.py run_engine   # 웹 엔진 루프 (체결·청산·예약·일별 자산·AI 분석 작업·리포트 실행·자동 리포트·추천 수집·리포트 알림·자동 추천·자동매매·장기투자·알림 발송)
cd backend && uv run python manage.py demo_recommend --symbol 005930   # 시연용 규칙 추천 (AI 아님). auto_recommend --force는 선별 상위로
cd frontend && npm ci && npm run dev               # Vite (/api, /admin을 127.0.0.1:8000으로 프록시. 다른 포트면 VITE_API_TARGET=..., VITE_MOCK=1이면 가짜 API)
cd frontend && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build
cd deploy && docker compose --env-file .env.docker up -d --build && ./smoke_test.sh   # 운영 구성을 이 PC에서 (docs/DEPLOY.md 3장)
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
- AI 리포트의 Agent·Orchestrator를 구현할 때: 개념은 `docs/교육용문서.md`, State·Trace는 `backend/reports/orchestration/state.py`의 함수로만 바꾼다
  (`docs/DECISIONS.md` 9-4). Guard 사건의 `details`에는 대상(`step`, `to`)을 넣는다 (`docs/API.md`).
- 웹 API를 바꾸면 `docs/API.md`를 먼저 고친다 (백엔드와 프론트가 같이 따르는 계약). 테스트는 실제 증권사·AI를 부르지 않는다
  (루트 `conftest.py`가 키를 비운다. 가짜 클라이언트를 `config.engine`에 끼운다).
- 검사 명령이나 실행에 필요한 설정 키를 바꾸면 `.github/workflows/ci.yml`, `deploy/.env.docker.example`도 같이 고친다.
  새 파일·폴더가 이미지에 들어가야 하면 루트 `.dockerignore`와 `deploy/Dockerfile`의 `COPY`를 확인한다.
- 계획이 바뀌면 `docs/plans/TEAM_PAPER_TRADING_PLAN.md`와 이 파일을 함께 고친다.
- `docs/works/`의 작업 문서는 파일 이름을 `브랜치명_작업유형_작업내용_날짜.md`로 쓴다.
  브랜치명은 작업한 브랜치(리뷰는 리뷰한 브랜치)이고 `/`는 `-`로 바꾼다 (`feat/2-worker` → `feat-2-worker`).
  작업유형은 `리뷰` 또는 `완료보고서`, 작업내용은 공백 없이 짧게, 날짜는 작성일 `YYYY-MM-DD`.
  예: `yubeen_리뷰_T3-1레지스트리_2026-10-07.md`, `Hwanseok_완료보고서_Worker계약_2026-10-07.md`.
