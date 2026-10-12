# 모매매 — 팀 모의투자 웹 서비스

작성 2026-10-06(화). 1장은 2026-10-12에 다시 맞췄다. 2026-10-12 `docs/결정필요사항.md`를 4장으로, `docs/plans/TEAM_DEV_PLAN.md`를 부록 A로 합쳤다 (`docs/DECISIONS.md` 32장).
**"지금 상태"는 이 문서 1장이 원본이다** — 루트 `README.md`의 요약 표, 부록 A3, 4-0은 여기를 가리킨다.
2~3장은 2026-10-06에 정한 기술 스택과 남은 작업(핵심 AI Agent 워크플로우·프론트엔드 개선·기능 개선·테스트 후 완성도 다듬기)이다. 배포·운영은 팀장(담당 1)이 맡는다(`docs/DEPLOY.md`).
옛 판(2026-10-01 "토스 → 키움 전환 계획")은 `git show d3325f2:docs/plans/TEAM_PAPER_TRADING_PLAN.md`로 본다. `docs/DECISIONS.md`·`docs/design/DESIGN.md`의 "계획서 n장·단계 n"은 그 판을 가리킨다.
결정의 역사는 `docs/DECISIONS.md`, 남은 결정·확인(U 목록)은 4장, 팀원에게 처음 나눠 준 개발 계획·개발 환경·시연 순서는 부록 A에 있다.
근거는 파일·함수 이름이나 문서 절로 단다. 실행해서 본 사실은 확인 방법을 붙인다. 코드·로그에서 미루어 본 것은 "추측", 문서에 없는 제안은 "제안"이라고 적는다.

---

## 1. 지금 상태

### 1-1. 한 문장 소개

**모매매**(2026-10-07 이름 바뀜 — 전 이름 "종이배", `docs/DECISIONS.md` 18장)는 주식이 처음인 사람도 AI 리포트를 만들고·검토하고·모의 자동매매로 실행해 보는 팀 모의투자 웹 서비스다. 시세는 증권사 조회 API로만 받고, 매매는 팀원별 가상 현금 계좌에서만 체결한다(**실주문 코드 0건**).
부제는 "여러 AI가 함께 검증하는 모의투자"다(2026-10-08 바뀜, `frontend/src/lib/plainText.ts` `SERVICE_TAGLINE`). 컨셉은 `docs/DECISIONS.md` 13장, 이름은 18장, 로고(ㅁ 블록 셋)·부제는 27장.

### 1-2. 기능별 상태 (2026-10-12)

**동작** = 실제 데이터로 돈다 · **시연판** = 규칙 입력으로 끝까지 돈다(AI 아님). 운영 확인은 2026-10-08 운영 E2E 점검(`docs/records/기록.md` F장)과 산출물 2·3이 근거다.

| 영역 | 된 것 | 상태 | 근거 (`DECISIONS` 절) |
|---|---|---|---|
| 모의 계좌·주문 | 팀원별 계좌(1천만원), 시장가·지정가, 장 밖 예약, 지정가는 장 끝에 취소, 목표·손절은 2회 연속 확인 뒤 청산, 보유 방식 swing·long | 동작. 장중 지정가 체결·자동 청산 실측은 아직(U8) | 8-1·8-3·14-3 |
| 시세·평가 | 종목 시세는 실시간(토스 조회), 계좌 평가·랭킹은 직전 정규장 종가(KR은 거래일 15:40에 넘어간다), 종목 화면의 보유 평가는 실시간 | 동작 | 14-1·17·28장, `backend/trading/market.py` |
| 종목·차트 | 검색, 완성 일봉, 매수 유의, 펀더멘털 신호등(`MARKETS=KR`) | 동작 | 14-3 |
| AI 교차검증 분석 | 웹 요청 → `run_engine`이 엔진 `analyze` 하위 프로세스를 돌린다. 팀원별·팀 하루 한도 | 구현됨. 실제 AI 실행은 CLI 1건(10/2, $0.30)만 확인 | 8-4 |
| AI 리포트 | 신청, YAML Registry, Orchestrator·Join/Handoff Guard·검토 반복, Worker 11개(종목 리포트 6 + 매매 종목 선정 5), State·Trace·SSE, A4 PDF·쉬운 판, 끝 알림 | **운영에서 실제 모델로 동작** (19장. 10/8 운영 점검: 리포트 1건 122초·$0.196). 하루 파이프라인(선정 팀 → 선정 Guard → 자동 리포트 3개)은 운영에서 켬(`AUTO_REPORT=on`, 국내 거래일 08:00). 선정 팀의 마지막 검토는 코드가 판정(30장) | 9장·19·22·26·30장 |
| AutoHealing | 재시도·대체 모델·Circuit Breaker, 장애 주입, 복구 지표 API, 팀 하루 AI 예산 | 구현·테스트 완료(10/8 합침). 운영 시험 DR-LLM-01·DR-CRT-01 통과(리포트 #61 — 산출물 2) | 9장·19장, 부록 A8 |
| 추천 → 활성화 → 모의 자동매매 → 알림 | 출처 report·analysis·demo, 리스크 엔진(손익비 1.5, 손절가는 코드가 정함), 넣을 돈은 사용자가 정함, 진입 지정가·재주문·목표·손절·기한 청산 | 운영 점검 통과(리포트 → 계획 제안 → 실행 → 체결 → 멈추기 → 알림). 손익비·기대값으로만 막힌 계획은 "수동매매 (시연용)"으로 시작(31장, U27) | 12·21·28·31장, `docs/tasks/00-공통.md` 부록 A6 |
| 장기투자 | 장기 보유, "왜 샀나요?", 오늘의 내 종목 뉴스(16:30), 펀더멘털 점검(18:00), 웹 알림 | 동작. 정해진 시각의 실제 실행 확인은 아직(U15) | 14-3 |
| ~~단타 연습~~ | – | **폐기 (2026-10-06, 사용자 결정)**. 코드·API·화면에서 모두 지웠다 | 16장 |
| 주린이모드·화면 | 계정 저장, 7문항 진단, 홈 3단계 안내, 쉬운 보기, 실행 확인 체크리스트, 하단 탭 다섯, 다크 모드, 로고 | 동작 | 14-7·15·20·27장 |
| 알림 | 웹 알림, Discord Webhook 보낼 편지함 | 웹은 동작, Discord는 꺼 둠 | 12-4·24장 |
| 관리 서버 (EC2 ②) | 서비스·엔진 상태, 배포 기록, 리포트 장애, 복구 지표, AI 비용, MCP(조회 전용), 장애 주입 신청(F11 — 2026-10-12 서비스에서 옮김, DECISIONS 35장) | 동작 (2026-10-08) | `docs/DEPLOY.md` 부록 A, `admin/README.md` |
| CI/CD | 검사 → 이미지 → 서버 배포 → 상태 확인, 실패하면 되돌리기, 검사 실패 시 배포 차단 | 동작 | 11장, `docs/DEPLOY.md`, 산출물 3 |
| 엔진 CLI·백테스트 | 엔진 자체 계좌(SQLite)와 CLI, AI 없는 백테스트 | 동작. 웹 계좌와 별개 | `AGENTS.md` "실행" |

### 1-3. 비어 있는 것·막힌 것

- **키움 키가 없다(U9).** 로컬과 운영 모두 토스 조회를 임시로 쓴다 — 운영은 `ALLOW_TOSS_BROKER=on`·`DJANGO_DEBUG=off`(3-1 예외·23장). 키움 클라이언트는 코드에 있지만 실측 0건이다(`docs/design/DESIGN.md` 부록 A8).
- **토스 client를 로컬과 운영이 같이 쓴다.** 한쪽이 토큰을 새로 받으면 다른 쪽 토큰이 무효가 된다(U4 → U19). 운영을 확인하기 전에는 로컬 엔진을 내린다. `AGENTS.md` 안전 규칙("개발용 client를 따로 쓴다")과 어긋난다.
- **장중 실측이 남았다.** 지정가 체결·자동 청산·재주문(U8), 장기투자의 정해진 시각 실행(U15)의 실측 기록이 없다.
- **운영 빈자리**: HTTPS 없이 HTTP 80만 연다. `DATA_GOKR_API`(U14)가 비어 대체공휴일을 모른다. Discord는 꺼 두었다(24장). 운영 web 이미지에는 Chrome이 없어 PDF는 엔진이 미리 만든다(20장, U22).
- **알려진 한계(U16, 고칠지 미정)**: ① 가격 상한이 없다 — `/api/orders`는 목표 1e308 같은 값을 201로 저장한다 ④ 장기투자 뉴스가 `DAILY_MOVE_MODEL` 없이 `APPROVER`를 쓴다(종목당 약 $0.02).
- **약관**: 토스 시세를 웹 화면으로 다른 사람에게 보이는 지금 방식(로컬 Vite 공유·운영 서버)은 토스 FAQ의 제3자 배포 금지에 걸린다(U13). 키움 교육용 다중 표시 문의가 남았다(U10·U12).
- **발표 뒤 결정**: 시연용 수동 시작을 둘지(U27), 손익비가 낮은 계획에도 가는 "새 매매 계획 제안" 알림(U28).

### 1-4. 품질

- **테스트**(2026-10-12 로컬): ruff, pytest 2,299개(엔진 + 백엔드, SQLite 메모리 DB)·backtest 12개, 프론트 eslint·tsc·vitest 749개(41파일)가 통과한다.
- **CI**: push마다 `ci.yml`(ruff → 실주문 코드 0건 → pytest(SQLite) → 백테스트 → 마이그레이션 확인 → pytest(PostgreSQL 16) · eslint → tsc → vitest → build · 이미지 → compose 기동 확인). `main`은 검사를 통과해야 배포된다(`deploy.yml`, 산출물 3).
- **안전 검사**: CI가 실주문 문자열과 `orders.py`를 막고(`.github/workflows/ci.yml` "실주문 코드 0건 확인" 단계), 루트 `conftest.py`가 증권사·Discord 키를 비운다.

### 1-5. 데이터·시세

- **시세**: 토스 조회(로컬은 `BROKER=toss` + `DJANGO_DEBUG=on`, 운영은 `ALLOW_TOSS_BROKER=on` — `engine/paper_engine/config.py` `load_config`). 운영의 원래 계획은 키움 REST 조회 TR만이다(`docs/design/DESIGN.md` 부록 A4).
- **DB**: 공유 개발 DB는 호스트 PC의 PostgreSQL 16 컨테이너(포트 5434), 운영 DB는 EC2의 PostgreSQL. 계정은 둘 다 6개(팀 5 + 관리자 1 — 운영은 2026-10-06에 개발 DB에서 복사).
- **그 밖의 자료**: DART(키 있음), data.go.kr(키 없음), Google 뉴스 RSS(제목·매체·시각), SEC EDGAR(US를 꺼 두어 안 씀).

---

## 2. 기술 스택 (README)

### 2-1. 구조

```
브라우저 ─▶ nginx (HTTP_PORT → 8080. HTTPS 없음. 리포트 SSE는 버퍼링을 끈다)
nginx ─┬─ /, /assets    → React 빌드 파일 (SPA)
       └─ /api, /admin  → web: Django + DRF (gunicorn 워커 1 · 스레드 16)
web · engine · migrate ─▶ db: PostgreSQL 16 (혼자 개발할 때는 SQLite). migrate가 먼저 성공해야 web·engine이 뜬다
engine = python manage.py run_engine (5초 루프, 단계마다 오류 격리)
  체결 확인 → 예약 실행 → 일별 자산 → 분석 작업 → 리포트 실행 → 자동 리포트 → 추천 수집 → 리포트 알림 → 자동 추천 → 자동매매 → 장기투자 → 알림 발송
redis 7 = compose가 띄운다. 엔진 CLI(serve·장 밖 예약·info·daily-report·backup)만 쓰고 web·run_engine은 쓰지 않는다
외부 ─▶ 키움 REST(운영) · 토스(로컬 전용) · DART · data.go.kr · Google 뉴스 RSS · DevPass LLM Gateway
알림 ─▶ 웹 알림(DB) + Discord Webhook 보낼 편지함 (engine이 보낸다. 지금 꺼짐)
CI/CD: push ─▶ ci.yml 검사 ─▶ [DEPLOY_ENABLED] GHCR 이미지 3개 ─▶ SSH 배포·되돌리기 ─▶ 관리 서버 배포 기록
```

근거: `deploy/docker-compose.yml`, `backend/trading/management/commands/run_engine.py`, `docs/DECISIONS.md` 8-2·8-4·11장. Redis를 여는 곳은 엔진 CLI(`engine/paper_engine/__main__.py:135-136·586-588·1064`)뿐이다(`backend`에는 redis 참조가 없다 — 코드 검색).

### 2-2. 구성

| 층 | 기술 | 버전 | 비고 |
|---|---|---|---|
| 언어·도구 | Python, uv 작업 공간(engine·backend), pytest·pytest-django·ruff | 3.12, uv 0.8(이미지), 9.1.1·4.14.0·0.16.10 | 잠금 패키지 29개(작업 공간 3개 포함). ruff E·F·W, line-length 120(E501은 끔) |
| 엔진 | `engine/paper_engine` | 의존성 0 | 표준 라이브러리만. Redis RESP2·LLM HTTP·PDF(Chrome headless)를 직접 구현 |
| 백엔드 | Django·DRF·drf-spectacular·psycopg[binary]·gunicorn·PyYAML | 5.2.17·3.18.1·0.30.0·3.3.6·26.2.0·6.0.3 | 앱 7개, 세션 인증 + CSRF, OpenAPI `/api/schema/` |
| DB | SQLite / PostgreSQL | 16 | `POSTGRES_HOST`로 고른다. PostgreSQL 전용 기능 금지 |
| 캐시·실시간 | LocMemCache, TanStack Query 폴링, 리포트만 SSE | – | WebSocket 없음. 폴링 간격은 `frontend/src/api/queries.ts` |
| 프론트 | React·react-router·TanStack Query·Tailwind CSS·lightweight-charts·react-markdown·Pretendard | 19.3.0·8.4.0·5.104.0·4.3.3·5.2.1·10.1.0·1.3.9 | Vite SPA. 타입은 `docs/API.md`를 보고 손으로 쓴다 |
| 프론트 도구 | TypeScript·Vite·Vitest·jsdom·Testing Library·MSW·ESLint | 6.0.3·8.3.2·4.1.11·29.1.1·16.3.3·2.15.0·10.11.0 | Node 22(CI). `VITE_MOCK=1`이면 브라우저 안 가짜 API |
| 컨테이너 | nginx-unprivileged·python:3.12-slim-bookworm·node:22-alpine(빌드)·postgres·redis·Chromium | nginx 1.27·python 3.12·uv 0.8은 메이저.마이너, node 22·postgres 16·redis 7은 메이저 태그 | 다이제스트 고정 없음. read_only, cap_drop ALL, uid 10001. Chromium은 engine 이미지에만 |
| CI/CD·서버 | GitHub Actions·GHCR·SSH 배포·되돌리기. 운영은 AWS EC2 Ubuntu `t3.medium`(메모리 4GB: Chrome PDF·PostgreSQL·엔진을 한 서버에서)·디스크 30GB 이상(계획) | Actions 실행기 ubuntu-24.04, EC2 Ubuntu 26.04 LTS | `DEPLOY_ENABLED=true`, EC2 연결됨(2026-10-06 첫 배포 성공, 보안 그룹 80은 남음 — `docs/DEPLOY.md` 0장) |
| AI | DevPass LLM Gateway(OpenAI 호환, 웹 검색 도구) | – | 분석 모델은 `.env`, 리포트 Worker 모델은 `worker_definitions.yaml`(지금 null) |
| 외부 데이터 | 키움 REST(운영)·토스(로컬)·DART·data.go.kr·SEC EDGAR·Google 뉴스 RSS | – | 조회만. 계좌·주문 TR 없음 |

근거: `uv.lock`, `frontend/package-lock.json`, `deploy/Dockerfile`·`deploy/nginx/Dockerfile`·`deploy/docker-compose.yml`, `pyproject.toml` `[tool.ruff]`, `.github/workflows/ci.yml`.

### 2-3. 저장소 구조

```
engine/paper_engine/  엔진 — data/(broker·kiwoom·toss·dart·calendar·news …) agents/(executor=모의 체결기 …) judge/ records/ longterm/
backend/              config/ accounts/ trading/(run_engine) analysis/ reports/ autotrade/ notifications/ longterm/ — 앱 루트는 Django 자리, 기능 코드는 기능 폴더
                      reports/  = agents/(report_team·selection_team) orchestration/ guardrails/ autohealing/ autoreport/ output/ limits/
                      autotrade/ = recommend/ plans/   (2026-10-11 정리 — docs/DECISIONS.md 29장)
frontend/src/         pages/ components/(공용 부품 + 기능 폴더) api/ hooks/ lib/ test/(화면 테스트) mocks/(가짜 API)
backtest/ · deploy/(compose, Dockerfile, nginx/, remote_deploy.sh, smoke_test.sh) · scripts/(dev.sh, kiwoom_check.py) · .github/workflows/ · docs/
테스트: engine/tests/, backend/<앱>/tests/(reports는 코드와 같은 기능 폴더), frontend/src/test/(화면 단위)와 파일 옆 *.test.ts(단위)
```

git에서 빼는 것은 `.gitignore`에 있다(`data/`·`runs/`·`reports/`·`.cache/`, `.env`·`.env.docker`, 계정 파일). `.env.example`은 커밋한다. `frontend/.env.local`은 무시되지 않으니 커밋하지 않게 조심한다(`.gitignore`에 더하는 것은 제안). 실행 데이터는 `PAPER_ROOT` 아래에 둔다.

### 2-4. 개발 환경과 검사 (절차는 `docs/guides/SETUP_PROMPT.md`, 명령 전체는 `AGENTS.md` "실행")

```bash
uv sync                                    # 엔진 + 백엔드 + 개발 도구
scripts/dev.sh                             # (PostgreSQL 컨테이너 +) Django + run_engine + Vite를 다시 띄운다. status·stop·logs·db
cd backend && uv run python manage.py create_team_accounts   # SQLite로 혼자 할 때만 (공유 DB에서는 계정이 새로 생긴다)
cd frontend && VITE_MOCK=1 npm run dev     # 서버 없이 가짜 API로 화면만
uv run ruff check . && uv run pytest && uv run pytest backtest          # push 전 검사 (CI와 같다)
cd frontend && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build
TEST_WITH_POSTGRES=1 uv run pytest backend    # CI용. .env가 공유 DB를 가리키면 그 서버에 테스트 DB를 만든다
```

macOS·Linux·WSL2에서만 돈다. 공유 개발 DB는 `.env`에 `POSTGRES_HOST=<호스트 IP>`·`POSTGRES_PORT=5434`·`POSTGRES_PASSWORD`·`DJANGO_SECRET_KEY`를 넣어 붙는다(부록 A12). 그때 `dev.sh`는 엔진 루프를 띄우지 않는다 — **엔진 루프는 호스트 PC 하나만** 돈다.
모델을 바꾸면 팀에 알리고 손으로 migrate한 뒤 바로 push한다(같은 절). 포트가 차 있으면 다음 빈 포트를 쓴다.

### 2-5. 설정·비밀 값

- **로컬**: 루트 `.env`. 키 이름·기본값은 `.env.example`, 설명은 `docs/DECISIONS.md` 2장·12-5·14-8. 프론트는 `frontend/.env.local`의 `VITE_API_TARGET`·`VITE_MOCK`.
- **운영**: 서버의 `deploy/.env.docker`와 GitHub 변수·비밀 값 — `docs/DEPLOY.md` 4~5장(팀장).
- **AI 모델·한도**: 분석은 `.env`의 `ANALYSTS`·`RESEARCHERS`·`APPROVER`·`REQUIRED_MODELS`, 장기투자 뉴스는 `DAILY_MOVE_MODEL`(없으면 `APPROVER`). 한도는 `AI_DAILY_BUDGET_USD`(팀 하루 $10)·`AI_DAILY_ANALYSES_PER_USER`(5)·`AI_DAILY_REPORTS_PER_USER`(3).
- 키·토큰은 `.env`에만 두고 문서·로그·커밋에 남기지 않는다. 설정 키를 바꾸면 `ci.yml`·`deploy/.env.docker.example`도 고친다.

### 2-6. 꼭 지킬 규칙 (원본: `AGENTS.md` 안전 규칙·DB, `docs/tasks/00-공통.md`, `docs/DECISIONS.md` 15장, `docs/API.md` 공통 규칙)

1. **실주문 코드 0건.** 키움은 조회 TR만. `orders.py`·`create_order`·`LIVE_TRADING`·`--live`·`--bypass`는 코드에 나오면 안 된다(CI가 막는다). `tossinvest`는 `engine/paper_engine/data/toss.py` 한 곳에만.
2. **토스 조회는 로컬 개발 전용**(토큰 발급 말고 GET만), 운영은 키움만. Redis 키는 `paper:`만, 토스 client는 따로(U19).
3. **AI는 제안만 한다.** 수량·한도·활성화는 리스크 엔진, 주문·체결은 `trading.service`와 모의 체결기. 최소 손익비(스윙 1.5)는 프롬프트에 넣지 않는다. 손절가는 AI가 아니라 코드가 정한다 (`judge/stops.py`).
   예외: 시연용 수동 시작(사용자가 '수동매매 (시연용)'을 누르고 확인한 계획만)은 손익비·기대값 점검만 건너뛴다 (2026-10-12 — `docs/DECISIONS.md` 31장).
4. **엔진은 표준 라이브러리만**, 외부 패키지는 `backend/`에만. 키움 응답 → 내부(토스) 형식 변환은 `data/kiwoom.py` 안에서만.
5. **DB**: 같은 모델·마이그레이션을 SQLite·PostgreSQL에 쓴다(PostgreSQL 전용 기능 금지).
6. **계약을 먼저 고친다**: 웹 API는 `docs/API.md`, 워크플로우 약속은 `00-공통.md`. State·Trace는 `backend/reports/orchestration/state.py` 함수로만. "Claude" 파일(`00-공통.md` 2절)은 팀원이 고치지 않고 팀장에게 알린다.
7. **화면**: 색은 `frontend/src/index.css` 토큰만(`colors.test.ts`가 검사), 금지 표현은 `engine/paper_engine/wording.py` 하나, 면책 문장은 하나, 주문·체결 쉬운 문장에는 "모의", 주어는 "AI 의견"·"안전장치".
8. **테스트는 실제 증권사·AI·Discord를 부르지 않는다.** 팀 코드는 브랜치 `feat/<담당>-<주제>` → PR(설명에 "03 T3-5"처럼 문서 항목) → CI 초록 + 다른 담당 1명 확인 → 합친다(급하면 1). 매일 아침 `main`을 자기 브랜치에 합친다(`00-공통.md` 12절). `main` 직접 push는 문서·작은 고침만(`docs/tasks/00-공통.md` 부록 A1 "주의").

### 2-7. 문서 지도

| 문서 | 무엇 |
|---|---|
| `AGENTS.md` · `docs/guides/SETUP_PROMPT.md` | 작업 규칙·실행 명령의 원본 · 클론 직후 설치 절차 |
| 부록 A | 워크플로우·AutoHealing 설계(4~5장), 장애 시험(8장), 산출물(9장), 역할(11장), 개발 환경(12장). 3장은 10/2 기준 |
| 4장 | 남은 결정·확인(U1~U24)과 다음 세션 시작점 |
| `docs/DECISIONS.md` · `docs/API.md` | 공통 결정 1~18장 · 웹 API 계약(AI 리포트 469줄~, 추천·자동매매 663줄~, 장기투자 917줄~) |
| `docs/tasks/00-공통.md`(부록 A1~A6 포함) | 00 공통 약속(파일 소유·서명·Trace·출력 계약·사유 코드), 01~05 담당별 할 일, 06 추천·자동매매 |
| `docs/design/DESIGN.md` · `docs/design/DESIGN.md` 부록 A · `docs/DEPLOY.md` | 엔진 설계 · 키움 TR · CI/CD·서버 준비 |
| `docs/plans/컨셉변경계획.md` · `docs/plans/컨셉변경계획.md` 부록 A · `docs/design/DESIGN.md` 부록 B | 컨셉·계약 변경 B(8장)·사용성 시험(12장) · 장기·스윙 확장(단타·선물은 폐기) · 화면 배치 |
| `docs/evaluation/프로젝트평가기준.md` · `docs/records/기록.md` A장 · `docs/교육용문서.md` · `docs/research/` | 평가 가이드 · 정규장 실측 S0~S19 · 리포트 화면의 교육 자료 · 약관·시세·장기투자 조사 |

---

## 3. 남은 작업

담당: 1 팀장·통합 · 2 Worker · 3 Orchestrator · 4 AutoHealing · 5 프론트(부록 A11) · Claude = Claude가 만든 파일(팀장이 요청할 때) · 전원.
번호: U = 4장 · B = 계약 변경(`docs/plans/컨셉변경계획.md` 8장) · T = `docs/tasks/` 작업 · D·E = `docs/DECISIONS.md` 13장 · DR = 장애 시험(부록 A8) · S = 개장 시험 · Q = 3-1 설계 쟁점 · P0·P1 = 우선순위.

### 3-0. 일정

| 날짜 | 할 일 | 근거 |
|---|---|---|
| 10/6(화)~10/7(수) | 워크플로우 구현 — 뼈대 PR 5개부터(원래 10/5 오전). 10/7은 새 화면 작업 없이 실제 Agent 통합, 저녁 복도 시험 | `docs/tasks/00-공통.md` 13절, 부록 A5 |
| 10/8(목) | 실제 Trace로 화면 맞추기, 1의 발표 시나리오 데이터(T1-26, P0)와 정규장 체결 장면 촬영, **15:00 화면 동결** — 그 배포본이 10/9 시험의 최종본 | `docs/plans/컨셉변경계획.md` 10장, `docs/tasks/00-공통.md` 부록 A1 |
| 10/9(금, 한글날) | 오전 장애 주입 시험, 오후 사용성 시험(리포트 실행기가 1건씩이라 시간대를 나눈다) | `docs/plans/컨셉변경계획.md` 10장 |
| 10/10~10/11 | 문구만 고친다. 산출물 3종(① 3·2, ② 4, ③ 1), 시연 영상·발표 자료(5) | 같은 문서 :303, 부록 A9 |
| 10/12(월) | 리허설(20분), 필요하면 체결 장면 다시 찍기 | 같은 문서 :304 |
| 10/13(화) 15:00 | 발표(팀당 20분) | `docs/evaluation/프로젝트평가기준.md` |

남은 정규장은 10/6 오후·10/7·10/8·10/12다. 늦어지면 UI·UX 추가 항목 → Handoff(T3-7) → 자동 리포트 화면 설정 순으로 줄인다. 신청 → 리포트 흐름, 대체 모델 복구와 그 시각화, 배포, 장애 시험 결과표, 주린이모드·쉬운 보기·계획 카드 상태와 실행 불가 사유·실제 금액·체크리스트·용어 바꾸기는 줄이지 않는다(부록 A2, `docs/plans/컨셉변경계획.md` 10장).

### 3-1. 핵심 AI Agent 워크플로우 (담당 2·3·4, 자동 리포트는 1)

앞(신청·Registry·State·Trace·SSE·화면)과 뒤(추천 수집·끝 알림 `reports/output/alerts.py`·PDF·한도)는 이어져 있고 가운데(Agent 실행)만 비어 있다. `completed` 리포트의 `report_agent.verdict`가 `"buy"`이고 `0 < stop < entry < target`이면 엔진 루프가 추천을 만든다(`backend/autotrade/recommend/sources.py`).
약속의 원본은 `docs/tasks/00-공통.md`(파일 소유 2절·Trace 9절·출력 계약 10절)와 `docs/API.md` "AI 리포트" 절이다. 바꾸려면 문서를 먼저 고친다. PR 규칙은 2-6 규칙 8.
**개발 환경**: 팀원 PC에는 증권사 조회 키가 없다고 보고 만든다(토스는 개발자 로컬 전용·client당 토큰 1개, 팀원용 키움 키는 대기 — 부록 A13, U9). 그래서 신청 API는 503(`backend/reports/views.py`), market_agent는 `WorkerError`다. 각자 SQLite에서 가짜 조회 클라이언트·`fake_llm`·`fake_worker`로 만들고, 실제 자료·모델 통합(T2-10·T3-10·T4-10)은 호스트 PC에서 1과 같이 한다.

**먼저 정할 설계 쟁점** — 정하면 `00-공통.md`·`API.md`에 적는다(목록은 U21).

| # | 쟁점 | 지금 | 정할 사람 · 막는 작업 |
|---|---|---|---|
| Q1 | timeout 규칙 (**2026-10-07 정함**: 같은 모델 1회 → 대체 모델 하나, 호출 한 번 최대 4회 — 00-공통 7절. **2026-10-08 바뀜**: 주 모델 timeout은 같은 모델을 다시 기다리지 않고 바로 대체 모델, 대체 모델 timeout은 같은 모델로 한 번 더) | `00-공통.md` 7절·T4-4는 "다음 모델로", 부록 A5-1·DR-LLM-01·예시 재생 ③은 "같은 모델 1회 → 대체 모델"이다. 하나로 정하고 다른 쪽을 고친다 | 4(5와) · T4-4 전 |
| Q2 | 제한 시간 | 호출 제한 90초(`engine/paper_engine/llm.py`)가 단계 `timeout` 60초(`team_definitions.yaml`)보다 길어 시간 초과 뒤 대체 모델로 넘어갈 시간이 없다(추측). 검토 재작성·Handoff에는 제한 시간이 없다. 버린 Worker 스레드가 `finish` 뒤에 기록하면 `StateError`다(`docs/tasks/00-공통.md` 부록 A3 주의) | 4·3 · T4-4·T3-5 전 |
| Q3 | 필수 Worker 시간 초과의 사유 코드 (**2026-10-07 정함**: 단계 제한 시간 초과면 `timeout`, 00-공통 9절) | `join_blocked`인지 `timeout`인지(9절 표) | 3 · T3-5 |
| Q4 | 검토 단계 입력 | 문서는 "Join Guard가 초안·조사 결과를 검토에 넘긴다", YAML `review`에는 join이 없다 | 3 · T3-5 전 |
| Q5 | runner를 켜는 시점 (**2026-10-07 정함**: 24시간 넘게 기다린 `requested`는 실행하지 않고 실패 사유 `expired`로 끝낸다 — DECISIONS 19장) | 묵은 `requested` 3건이 켜는 순간 실제 비용으로 돌고 끝 알림이 간다(같은 사람·종목 신청에는 이 행이 200으로 온다). 처리(끝내기·나이 제한·실행)를 정한다. 통합 전에는 별도 설정 키로 `runner.tick`을 막는다(제안 — `AGENTS_IMPLEMENTED`는 화면 SSE 깃발, `registry.py`) | 3·1 · ⑤ 전(오늘) |
| Q6 | 시험 수단 | `errorTypes` 셋으로는 DR-CRT-01·02·DR-SEC-01을 못 만든다. Circuit Breaker(모델별·프로세스 전역 5분, T4-5)가 시나리오끼리 간섭한다 → 사이에 5분 대기나 재시작(제안). 리포트 한도 3건 → 시험 한도를 올리거나 계정을 나눈다(제안) | 4·1 · T4-6·T4-10 전 |
| Q7 | 장애 분류·셈법 | `LlmError`에 상태 코드가 없어 server_error·bad_output을 나누기 어렵다 → 구조화된 오류(제안). LLM 실패 없는 실패(Worker 오류·단계 시간 초과)를 장애로 셀지 정한다 | 4 · T4-2·T4-7 전 |
| Q8 | 그 밖 | `attempt`의 두 뜻, `chaos.parse` 인자, 권유 표현을 계약 검증에 넣을지(넣으면 재요청 = 장애 1건), 0002 새 열의 `db_default`(제안 — 옛 코드가 도는 공유 DB 대비, 본보기 `trading/migrations/0002_order_style.py`), 산출물 위치(`docs/deliverables/` 대 `docs/설계서.md`(지금 `docs/deliverables/01_멀티에이전트_아키텍처_설계서.md`)·`장애복구보고서.md`·`파이프라인보고서.md`) — 산출물 위치는 2026-10-09 `docs/deliverables/`(`01_`·`02_`·`03_` 번호 파일)로 정함 | 2·3·4·1 · 0002 전, 산출물은 10/8 전 |

**담당별 구현** (따로 적지 않은 파일은 `backend/reports/` 아래)

| 담당 | 파일 | 할 일 |
|---|---|---|
| 2 | `guardrails/contracts.py`, `agents/`(base·WORKERS·prompts·`report_team/` Worker 6개) | 계약 6개(B1 `plainSummary` 숫자 금지·1~3개·100자, `MarketResult.asOf` 선택, `targets` 다섯 값). 프롬프트 요건(T2-7): "목표 가격 ○○원의 근거", "이 의견이 틀리는 경우", 소문자 `"buy"`, 권유형 금지. market은 장마감 기준, 일봉이 없으면 `WorkerError`. fundamental은 DART 키가 없으면 "자료 없음". news는 `guards.clean_text`(3)를 거친다 |
| 2 | `orchestration/worker_definitions.yaml` 값, `limits/budget.py`, `views.py` 한 줄 | 모델·대체 모델(3의 스키마 뒤), 비용 예산 `check(now)`(0002 뒤), 실제 모델 1회(T2-10), 설계서 ① 역할 표(T2-11) |
| 3 | `orchestration/registry.py`·`team_definitions.yaml` | 스키마 `fallbacks`·`retry`, review `retry {target: report_agent, max_rounds: 2}`(T3-1) |
| 3 | `orchestration/orchestrator.py`, `guardrails/guards.py`, FakeWorker | `run_report` 정상 경로 → Join·부분 실패(T3-5) → 검토 반복(T3-6) → Handoff(T3-7) → 입력 Guard `clean_text`(T3-8 — 2의 news와 DR-SEC-01이 쓴다) → 비용 `state.add_cost`(T3-9) |
| 3 | `orchestration/runner.py`, `run_engine.py` 세 곳 | `tick`(분석 작업 다음)·`recover`(시작)·`shutdown`(끝), 실패 사유 코드(T3-4·T3-12). T3-5 뒤 `AGENTS_IMPLEMENTED = True`, 실제 통합(T3-10), 설계서 ① 총괄(T3-11) |
| 4 | `models.py`, `migrations/0002_*.py`, `payloads.py` | 새 열(user null 허용·source·chaos·cost_usd·pdf_path·색인)과 새 필드. Claude의 B3 `opinion`·`oneLiner`는 지우지 않는다(T4-1) |
| 4 | `engine/paper_engine/llm.py`, `autohealing/healing.py`, fake_llm | `complete_json_once`(T4-2), `LlmCaller`·`make_caller`, 재시도·대체 모델(T4-4), Circuit Breaker(T4-5) |
| 4 | `autohealing/chaos.py`·`stats.py`, `views.py`·`urls.py` 한 줄씩 | 장애 주입(T4-6), `GET /api/reports/recovery-stats`(T4-7), 보고서 ②·DR 설정표(T4-9·T4-10), recovery 문장(T4-11) |
| 1 | `autoreport/auto.py`, `auto_report` 명령, `run_engine.py` 한 줄 | 자동 리포트 B9(P1): `request`·`tick`(T1-4, 0002 뒤), `after_finish`의 PDF·발송(T1-5 — Discord는 U7 보류라 지금은 콘솔), `auto_report`(T1-6), 목록 `?source=`(T1-7). 발표 전에 할지는 U20 |

**순서**(`00-공통.md` 13절): ① 3 registry 스키마 → ② 4 0002·payloads → ③ 2 contracts·`agents/base` → ④ 4 healing 서명·fake_llm → ⑤ 3 `run_report` 정상 경로·runner(완료 기준 `run_engine --once`로 requested → completed, `docs/tasks/00-공통.md` 부록 A3. 공유 DB에 붙이기 전에 Q5).
YAML 모델 값은 ① 뒤, budget·`add_cost`·chaos 저장·B9는 ② 뒤, `AGENTS_IMPLEMENTED = True`는 T3-5 뒤, 실제 통합은 2의 Worker와 4의 호출기 뒤, DR 시험은 통합 뒤다.
**체크포인트(제안 — 뼈대가 하루 늦어 02~04의 일정을 하루씩 민다)**: 10/6 ①~⑤ 합치기 → 10/7 오전 T3-5·T3-6·T4-4~T4-6·Worker 6개 → 10/7 오후 호스트 PC에서 실제 통합 → 10/8 오전 T3-7~T3-9·T4-7·T4-10 설정표, 15:00 전 실제 Trace로 화면 확인 → 10/8~10/11 산출물.

**완료 기준**

- [ ] 실제 리포트 1건이 몇 분 안에 나오고 노드가 대기 → 실행 중 → 완료로 바뀐다(SSE). 검토 결과로 경로가 갈리고 RETRY는 상한을 넘지 않는다. Trace만 보고 끝난 이유를 설명할 수 있다(부록 A5). 끝나고 5초 안에 `/recommendations`에 추천이 뜬다(`docs/tasks/00-공통.md` 부록 A2 "받는 것 · 주는 것").
- [ ] 장애 주입을 켜도 끝까지 나오고, 어느 모델이 실패하고 어느 모델이 대신 답했는지 보인다. 같은 seed는 같은 판정이다. 선택 Worker가 전부 실패하면 건너뛰고, 필수면 실패로 끝내고 사유를 화면·알림에 낸다(부록 A5).
- [ ] `/ops`가 실측을 그린다. 자동 복구율은 시나리오 / 호출 장애 두 이름으로 나눠 적는다.
- [ ] 가짜 LLM 테스트: 정상·선택 실패·Join 차단·RETRY 뒤 PASS·RETRY 한도·Handoff 거절·재시도·대체 모델. `uv run pytest backend/reports -q`가 1분 안(지금 139개), CI 초록(`docs/tasks/00-공통.md` 11절).
- [ ] 산출물: 설계서 ①(3·2), 보고서 ②(4), 보고서 ③(1). 실제 구조와 시험 결과만 쓴다(`docs/evaluation/프로젝트평가기준.md`).

**주의**

- 0002에서 user를 null로 열면 `payloads.summary`의 `get_username()`이 깨진다(`payloads.py`). user가 없는 리포트의 끝 알림은 활성 사용자 전체에게 간다(코드로 확인: `alerts.py` → `backend/notifications/service.py`. 건너뛰는 것은 `source == "auto"`뿐 — `alerts.py`).
- 비용: 리포트는 동시에 1건, 하루 예산 $10을 분석·리포트·대체 모델·자동 리포트가 같이 쓴다. 한 리포트는 최대 Worker 실행 10번·LLM 시도 40번이다(Worker 실행마다 LLM 호출 한 번 × 최대 4회 시도로 본 계산). 실제 호출은 T2-10·T3-10·T4-10에서만 한다.
- 루트 `conftest.py`는 `DEVPASS_APIKEY`·`DART_API_KEY`를 비우지 않는다 → 팀 테스트는 가짜 `engine_config`와 `fake_llm`을 꼭 끼운다. 스레드가 DB를 쓰는 테스트에는 `django_db(transaction=True)`가 필요할 것이다(추측). 새 이름에 CI 금지 문자열을 쓰지 않는다.

### 3-2. 프론트엔드 개선 (담당 5)

새 화면은 거의 없고 **실제 데이터로 맞추기**가 남았다. 5는 Claude의 "합쳤다" 알림 뒤 그 위에서 다듬는다(`00-공통.md` 2절).
규칙: 색은 토큰만, 라이트·다크 × 390·1280 확인, 공용 부품은 `ui.tsx`·`components/motion/`, 배치를 바꾸면 `docs/design/DESIGN.md` 부록 B도 고친다, 상태를 색만으로 구분하지 않는다(`docs/DECISIONS.md` 15-3·15-6).
다른 담당의 화면 몫(부록 A11 ②): 1 발표 흐름 점검, 2 리포트 문장 품질, 3 진행 단계 표시가 실제 Trace와 맞는지, 4 자동 복구 문장·지표 화면.

| 할 일 | 담당 | 언제 | 근거 |
|---|---|---|---|
| 실제 Trace·`recovery`로 T5-3~T5-6 확인, 신뢰 패널 둘째 줄을 T4-11과 맞추기, 같은 리포트의 `/ops`·RunSummary 수치 대조(`recovery.ts`와 `stats.py`가 같은 셈법) | 5, 4 | 10/7 확인, 10/8 오전 수정 | `docs/tasks/00-공통.md` 부록 A5 |
| T5-10 본문 꾸미기(판정·한 줄 결론을 머리로, 근거·리스크 목록, 리스크 경고 블록 — 2의 `markdown` 형식을 보고). PDF는 실제 결과로 눈 확인, 0002 뒤 `pdf_path` 열로 | 5 | 10/8 | 같은 문서 :49-50,111 |
| T5-19 교차검증 분석 배치 확정, T5-22 홈·종목 상세·모의투자 다듬기 | 5 | 10/8 15:00 전 | 같은 문서 :120,123 |
| 실기기(iOS Safari·Android Chrome): 시트, 숫자 키패드, 토스트·연결 띠(safe-area), 차트 핀치, 홈 화면 아이콘 | 5 | 동결 전 | 4장 |
| 발표 화면 약 8분(쉬운 보기 2:30 → `?view=expert` 4:00 → 파이프라인 1:30), 프로젝터는 "밝게", 가짜 API 화면이면 표시 | 5 | 10/12 리허설 | `docs/plans/컨셉변경계획.md` 11장 |

팀장 할 일: 5에게 "합쳤다" 알리기와 팀에 이름 변경 공지(U18·U3). 상승·하락 글자(3.71:1)와 색 바탕 흰 글자 버튼(3.2~3.7:1)이 WCAG AA 4.5:1에 못 미치는데, 브랜드 색으로 고칠지 정한다(`docs/DECISIONS.md` 15장).

### 3-3. 기능 개선

다른 담당의 논의 몫(부록 A11 ③): 2 뉴스 출처 대안·장기투자 AI 문장, ~~3 단타 AI 팀(`day_plan`·`day_review`) 설계~~(단타 폐기, 2026-10-06), 4 키움 실시간 도입 조건, 5 화면 개선 아이디어.

**발표 전** — 화면을 크게 바꾸지 않는 작은 일만, 10/8 15:00 전에.

| 할 일 | 담당 | 근거 |
|---|---|---|
| U16①: 가격 입력 상한(예: 직전 종가의 몇 배)을 trading `views._number`에 둔다. `docs/API.md`를 먼저 고친다(U16 결정 뒤 — 제안. daytrade `_price`는 단타 폐기로 없어졌다) | Claude | `backend/trading/views.py` |
| U16④: `DAILY_MOVE_MODEL`에 싼 모델 지정(U16 결정 뒤 — 제안) | 1 | 4장 U16 |
| 예약 결과 알림: 예약이 실행되지 않거나 지워져도 엔진 콘솔에만 남는다. `docs/API.md`부터(우선순위 낮음) | Claude | 부록 A10, `backend/trading/service.py` |
| 목표·손절 수정 화면(`PATCH /api/orders/{id}`는 있다). 여유 있을 때만 — 줄일 때 가장 먼저 뺀다 | 5 | 부록 A10, `docs/API.md` |

**발표 뒤** — 그때까지는 알려진 한계로 적는다.

- ETF 거래세 면제(엔진이 모든 국내 매도에 0.20% — 4장), 키움 실시간(4, 키 필요 — 단타 (b)용이었고 단타 폐기와 함께 필요 없어졌다), 뉴스 출처 공시·수치 중심(2).
- 직접 주문의 체결 알림(1-2), 지난 AI 리포트 성적(컨셉 P1), 진단 문항·점수표 조정(E-2 — 10/9 뒤 "문구만" 규칙과 부딪힌다).
- 부록 A10-3 "시간이 남으면"(관심 종목, 홈 시장 요약, PWA, 서버 푸시 등). CSP를 넣으면 테마 인라인 스크립트의 sha256을 허용한다(`docs/DECISIONS.md` 15장).
- 범위 밖으로 정한 것: 모의 계좌 되돌리기, 성향으로 수량 배수(D-6), 선물(폐기), Discord 활성화 버튼(링크로 대신), 분할·추가 매수.

### 3-4. 테스트 후 완성도 다듬기

| 시험 | 언제 | 담당 | 무엇 | 기록 위치 |
|---|---|---|---|---|
| 정규장 실측 U8·U15(S0~S19) | 10/6 오후(15:30 전 준비 시 S14~S17 — 단타 시나리오 S6·S7·S11~S13·S18은 삭제로 시험하지 않음), 10/7·10/8, 예비 10/12 (제안 — 팀장 결정) | 1 | 예약 실행·체결·재주문, 15:40 기준 전환, 16:30 뉴스, 18:00 점검, 웹에서 분석 1건(제안). 준비는 아래 | `docs/records/기록.md` A4 표 → `docs/tasks/00-공통.md` 부록 A6 "확인한 것" |
| 복도 시험 | 10/7 저녁 | 5 진행, 1 준비 | 팀 밖 1~2명, 과제 ②만 | `docs/records/기록.md` |
| 장애 주입 시험(DR 14개) | 10/9 오전 | 4(LLM·CRT·SEC, 결과 모음), 1(DB·PROC·NOTI·NET·CI) | 시나리오마다 ID·주입 장애·기대·실제·복구 시간·수동 개입·판정·증빙. 실패와 고친 것도 | 보고서 ② 결과표 |
| 사용성 시험 | 10/9 오후 | 5 진행, 1 준비 | 팀 밖 5명, 과제 넷(리포트 만들기 · 손절 손실 말하기 · 자동매매 시작 · "사라는 말인가요?"), 과제당 5분, 성공 기준은 미리(`docs/plans/컨셉변경계획.md` 12장) | 참가자 P1~P5 원표, `docs/records/기록.md` |
| 동결 전 회귀 | 10/8 15:00 전 | 전원 | 2-4의 검사 + 아래 수동 확인 | CI 실행 기록 |

**정규장 실측 준비**: `scripts/dev.sh`로 다시 띄우고 시험 계정을 만든다. 호스트 PC는 전원에 꽂고 덮개를 열어 둔다(배터리로 덮개를 닫으면 `caffeinate`가 있어도 잠든다 — `pmset -g log` 10/6 09:48). 접속 IP가 바뀌지 않는 네트워크에서 한다(제안). S9가 기대하는 "체결 알림"은 직접 주문에 없다(1-2) → 기대 결과를 고친다.

**점검 기준**

- **표현**: 규칙은 2-6 규칙 7, 금지 표현 원본은 `engine/paper_engine/wording.py`(권유 17·인과 5·예측 7). 화면 고정 문구는 검사 대상이 아니고 프론트 테스트 6개는 목록 일부만 복사한다 → 프론트 전체 문자열을 이 목록으로 훑는 테스트 하나(제안). 장중 가격·배 은어 금지, 연습용은 "(AI 아님)"(`docs/API.md`). 발표 영상(유튜브)의 모든 화면·알림이 대상이다.
- **수치**: 시험한 값만 쓴다. 사용성은 "n/5"와 원표(백분율·평균 금지), 자동 복구율은 두 이름, 평균 복구시간은 첫 `agent_failed`부터 그 Worker의 `agent_completed`까지. "예시" 수치(`/ops`·예시 Trace·선별)는 캡처에 쓰지 않는다.
- **동결 직전 수동 확인**: 발표 흐름 한 번(3-2), 라이트·다크 × 390·1280, 시험·발표 계정 주린이모드 켬·"밝게", 완성 리포트 3건 이상("보통 ○분" 문장의 조건, `frontend/src/lib/reports.ts`), "예시"·"가짜 API" 표시.
- **제출 전**: `docs/evaluation/프로젝트평가기준.md` 6장 체크리스트(증빙, 지표 기준, 실패 사례·수동 개입, 배포 차단, 실행 ID·커밋, 문서·구현·시험 일치, 비밀 값 없음, 배포 환경 시연).

**제보와 심각도** — 정해진 것은 "500이면 `backend.log` 오류 줄을 붙여 1에게, 화면 문구·흐름은 5에게, 찾은 문제와 고친 것은 `docs/records/기록.md`에"뿐이다(`docs/records/기록.md` A4, 부록 A9).
제안: 1이 오늘 `docs/records/기록.md`에 표 머리(날짜·제보자·화면/API·재현 단계·기대·실제·증빙·등급·담당·상태)를 만든다. 받는 사람은 500·데이터 1, 화면 5, 워크플로우 2·3·4. 등급도 제안이다.

| 등급 | 예 | 처리 |
|---|---|---|
| 치명 | 안전 규칙 위반, 돈 숫자 틀림, 500, 과제를 진행할 수 없음 | 바로 고친다. 동결 뒤에도 예외로 허용 |
| 높음 | 사용성 과제 실패의 원인, DR FAIL, 시연 화면 깨짐 | 10/8 15:00 전에. 그 뒤면 문구로 우회 |
| 중간·낮음 | 그 밖 | 10/10~11에 문구로, 아니면 3-3 "발표 뒤"로 |

**문서·점검표 정리**: 화면 문구 점검표(5 — 성공 기준에 있는데 파일이 없다, `docs/plans/컨셉변경계획.md` 12장). 문서 불일치(1·Claude): PDF 양식 판(`docs/API.md`·`docs/DECISIONS.md` 14장는 2, 코드는 3), `backend/config/settings.py` 주석, `engine/paper_engine/__main__.py` 알림 순서, `README.md` 소개, 부록 A3 "시세 1초 폴링", `docs/records/기록.md` A0의 토스 client 공유(U19).

**막힌 것·정할 것**

- **U19 토스 client(1, 제안)**: 개발용 토스 client를 따로 받는다. 그 전까지는 실측·시험 시간 밖에 `run_engine`을 내린다. 키움 키를 받는 즉시 `BROKER`를 키움으로 바꾼다.
- **시험 환경(U13, 팀장)**: 호스트 PC·토스 조회로 팀 밖 사람에게 열면 약관에 걸린다. 가짜 API는 공휴일을 모르고 계획이 6초마다 진행해 과제 ③의 기준이 달라진다(`frontend/src/mocks/clock.ts`).
- **시험 계정**: `시험1~3`으로 5명을 받으면 앞 사람의 리포트·계획이 남고, 같은 종목 계획은 `plan_exists`로 막히고, 리포트 한도 3건을 같이 쓴다 → 시험자 사이에 정리하거나 계정을 5개로(제안). 완성 리포트가 늦으면 가짜 API 예시로 대신할지 10/7 저녁에 정한다(제안).
- **증빙 빈칸**: DR-API-01·02는 담당도 주입 수단도 없다(가이드의 예시가 DR-API-01이다). 가이드 7단계의 "정상 요청" 줄도 8장 표에 없다. DR-LLM-04·DR-NOTI-01·DR-CI-01은 Discord 알림이 증빙인데 실채널이 보류(U7)다 → 실채널을 열지, 웹 알림으로 판정할지 정한다.
- **10/6 사례**: 토스 403은 엔진을 다시 띄우지 않았는데 10:48 뒤로 멈췄다. 원인(공인 IP 변경·네트워크 이동 — 추측)과 사람의 개입 여부는 확인이 필요하다. 보고서 ②에 쓰려면 그날 네트워크를 바꿨는지부터 확인한다. 호스트 PC 절전으로 엔진 루프가 멈춘 일(09:48~12:34)은 "사람이 조치해야 하는 운영 위험"으로 적을 수 있다(제안).

---

## 4. 남은 결정·확인 — 다음 세션 시작점

> 옛 `docs/결정필요사항.md` (2026-10-12 이 문서에 합침 — `docs/DECISIONS.md` 32장). 이 장 안의 "n장"은 4-n을 가리킨다.

작성 2026-10-04, 2차 갱신 같은 날, **3차 갱신 2026-10-05** (확정된 변경 전부 + 확장 1·2단계 구현, 장마감 기준, 팀원 할 일 단순화), **4차 갱신 2026-10-06** (계획서를 지금 상태·기술 스택·남은 작업으로 다시 씀, 10/6 개장 시험 못 함, U19~U22), **5차 정리 2026-10-07** (0장 지금 상태와 2장 끝난 결정 표를 계획서·`docs/DECISIONS.md` 링크로 줄임, U24 이름 "모매매"), 2026-10-08 U24 로고·부제 결정(27장). 발표 10/13까지 평일은 10/5~10/8·10/12이고, **10/5(월)는 개천절 대체공휴일로 휴장**이다.
**다음 세션은 이 장부터 읽는다.**
갱신 규칙: 결정하거나 확인하면 표의 "상태"를 바꾸고(날짜·누가), 결과를 원래 문서(`docs/DECISIONS.md`, `docs/API.md`, `docs/tasks/`, 각 계획 문서)에 옮긴다.
끝난 줄은 지우지 말고 "완료"로 둔다 (수행 과정·개선 이력의 근거가 된다).

---

### 4-0. 지금 어디까지 왔나

**지금 상태는 이 문서 1장 한 곳에서 관리한다** (2026-10-07 정리 — 이 장의 상태 표는 계획서와 겹치고 일부 낡아서 지웠다. 예전 표는 `git show a015d6b:docs/결정필요사항.md`).
이 문서에는 아직 정하지 않았거나 확인하지 못한 것(1장 U 목록)과 다음에 할 일(5장)만 둔다.

10/6 이후 바뀐 것: 서비스 이름 "모매매"(U24, `docs/DECISIONS.md` 18장), 리포트 Worker 출력 계약·인터페이스(`acdb038`), Registry T3-1(`78778e9`·`fcf4d5a`), 담당 4의 마이그레이션 0002·LLM 호출기 `healing.py`(T4-1~T4-5, PR #1·#2)가 들어왔다 (그때 Worker 구현·Orchestrator는 없었다 — 2026-10-07 구현, `docs/DECISIONS.md` 19장).

**2026-10-11 디렉터리 정리** (`docs/DECISIONS.md` 29장): 문서는 종류별 폴더(지도는 루트 `README.md` "문서" 절 — 2026-10-12 합침, `docs/DECISIONS.md` 32장), `backend/reports`·`backend/autotrade`·`frontend/src`는 기능 폴더로 옮겼다 (구조는 `AGENTS.md` "구조").
정리 전에 갈라진 팀원 브랜치(`origin/yubeen` 등)는 main을 합칠 때 옮긴 경로를 따라간다 — git이 이름 바뀜을 알아보지만, 그 브랜치에서 새로 만든 파일
(예: `backend/reports/tests/test_healing_decisions.py`)은 맞는 기능 폴더(`tests/autohealing/`)로 옮기고 import를 새 경로로 쓴다.

---

### 4-1. 가장 먼저 (10/5~10/6)

| # | 할 일·결정 | 왜 | 누가 | 상태 |
|---|---|---|---|---|
| U1 | **push 여부**: 앞선 커밋들(`git log origin/main..HEAD`)을 `main`에 올릴지 | 팀원이 받아야 10/5 작업이 이 위에서 시작된다 | 사용자 | **완료** (2026-10-04, 사용자 요청으로 push) |
| U2 | **컨셉 계획 합의**와 계약 변경 B1·B3 | 담당 2·4의 10/5 오전 뼈대 PR에 처음부터 넣어야 한다 | 팀 | **완료** (2026-10-04, 팀장 권한으로 회의 생략·모든 제안 동의. D-1만 바꿈. `docs/DECISIONS.md` 13장, `docs/API.md`·`docs/tasks/`에 옮김) |
| U3 | **팀 공지**: 공유 개발 DB에 새 표(추천·계획·사건·알림·알림 설정·보낼 편지함)가 생겼고, 하단 탭·`/ops`가 바뀌었다. **+ 컨셉 확정("AI 리포트 데스크"), 새 할 일(`docs/tasks/` "2026-10-04 합의" 절), 선물 폐기, 10/5 휴장** | 팀원 화면·DB·할 일이 바뀌었다 (부록 A12-3 규칙, 15장) | 담당 1 | 미정 |
| U4 | **토스 토큰**: 2026-10-04 18:10:31에 `.cache/toss_token.json`이 새로 쓰였고 엔진 로그에 "token-revoked"가 있었다 | 같은 client를 쓰는 다른 프로세스가 있는지 | 사용자 | **완료** (2026-10-04 사용자 확인: 같은 client를 쓰는 다른 프로세스가 있어서 생긴 일. 어느 쪽이든 새로 발급하면 다른 쪽이 무효가 된다 → 실시간 확인 호출은 최소로). 2026-10-06 13시대에도 재발급이 되풀이됨(엔진 로그 13:02 `token-revoked`, `.cache/toss_token.json` 여러 번 갱신) → U19 |
| U5 | **뉴스 출처 이용 조건** (C1·E-3) | Google 뉴스 RSS는 "개인 피드 리더, 개인·비상업"만 허용. 지금의 AI 분석·리포트에도 해당 | 사용자·담당 1 | **완료** (2026-10-04 사용자: **네이버 폐기**). 검토 근거: 사용자는 "네이버로 구현해도 됨"이었으나 **네이버 검색 API 약관(2026-09-07 개정) 특약 2.3이 "AI 입력"을 명시적으로 금지**하고 신규 신청도 7/30에 끝났다 → **전환하지 않고**, 발표까지 Google RSS 유지 + 출처 표시·노출 최소화, 발표 뒤 공시·수치 중심으로 (`DECISIONS` 13-3) |
| U6 | **발표용 관리자 계정** | `/ops`는 staff만 연다 | 담당 1 | **완료** (2026-10-04: 개발 DB에 superuser 1개, 저장소 루트 `admin_account.txt`(0600, git 제외). 실제 로그인 API로 `isStaff: true` 확인. 운영 DB는 EC2에서 따로) |
| U7 | **Discord 실제 채널 시험** | 아직 실제 채널로 보낸 적 없다 | 담당 1 | **보류** (2026-10-04 사용자: 아직 하지 말고 둔다. 코드는 그대로, `DISCORD_WEBHOOK_URL` 비움) |
| U8 | **정규장 실측**: 시연 추천 → 활성화 → 체결 → (가능하면) 청산·재주문을 실제 시세로 한 번 | 장중 체결·청산은 단위 테스트로만 확인했다 | 담당 1 | **10/6(화)로 미룸** (10/5 대체공휴일 휴장. 토스 장 달력이 반영함을 확인: `/api/market`의 `opensAt` = 2026-10-06 09:00) — T1-27. **10/6 오전 못 함**: 시험 계정을 만들지 않았다(계정 6개 그대로). 호스트 PC(노트북)는 10/5 22:42 전원에 꽂힌 채 덮개만 닫혔고(DarkWake — 엔진 로그가 없어 09:00 뒤 엔진이 돌았는지는 알 수 없다), 10/6 09:48 전원이 빠져 절전에 들어간 뒤 12:34까지 짧은 깨어남을 되풀이했다(`pmset -g log`). 깨어 있던 사이 토스 조회는 DNS 오류(10:01~10:19, 11:03~12:35)와 403 "IP address not allowed"(10:17~10:48 — 다른 네트워크 탓으로 추측)로 실패했고 12:36부터 정상이다(`.cache/dev/engine.log`). 13시 기준 Django·Vite는 내려가 있고 엔진만 10/5 06:15 코드로 돈다. 다시 할 날은 계획서 3-4(제안: 10/6 오후·10/7·10/8, 예비 10/12 — 팀장 결정) |
| U9 | **키움 키 첫 실측** (C3): `scripts/kiwoom_check.py` | 운영·모든 확장의 전제 | 담당 1 | **대기** (2026-10-04 사용자: 키는 곧 발급. 그때까지 로컬은 토스 조회 유지) — T1-28 |
| U10 | **시세 표시 약관** (C2) | 지금 폴링 서비스에도 해당 | 담당 1 | **원문 확인 끝**: 키움 약관 제5조 ③ "개인의 업무에 한하여 … 제3자에게 제공해서는 아니 된다", 토스 FAQ "비상업적인 용도라 하더라도 제 3자에게 배포하는 행위는 엄격히 금지". **남은 일**: 키움에 교육용 다중 표시 문의, 발표 전 대응(U12) |
| U11 | **로컬 `.env`의 `DART_API_KEY`가 두 줄**이고 두 번째 줄이 비어 있다. 엔진은 뒤의 값을 쓰므로(`config.load_env`) **지금 DART 조회가 꺼져 있다** | AI 분석 근거(공시·재무)가 빠진다 | 사용자 | **완료** (2026-10-05: 빈 두 번째 줄 두 개(DART·SEC 연락처)를 주석 처리, 값은 그대로. 실제 DART 조회 확인) |
| U12 | **약관 대응 (발표 전)**: 공개 시연 영상의 시세·뉴스 화면은 가짜 데이터(`VITE_MOCK=1`), 화면 하단 출처 문구, 뉴스에 매체명·시각·"Google 뉴스 검색 결과" 표시(API 변경 → `docs/API.md` 먼저), 배포 URL 검색엔진 색인 막기, 시험 계정은 시험 기간만 | 키 정지·차단이 현실적 위험 (`docs/research/조사.md` A9-2) | 담당 1·5 | **대부분 완료** (2026-10-05: 화면 아래 출처 줄, 분석 뉴스에 매체·시각·"Google 뉴스 검색 결과", 검색엔진 색인 막기(meta·robots.txt·nginx). **영상은 사용자 결정으로 가짜 데이터 대신 실제 데이터 + 장마감 기준 표시**. 남음: 키움에 교육용 다중 표시 문의, 시험 계정은 시험 기간만) |
| U13 | **토스 조회를 팀원에게 보이는 지금 방식** (`scripts/dev.sh`가 0.0.0.0으로 띄움) | 토스 FAQ상 제3자 배포 금지 — 혼자 127.0.0.1까지만 회색 | 사용자 | 미정 — 키움 키를 받으면 바로 바꾼다. 그 전에 팀원에게 보여야 하면 가짜 API(`VITE_MOCK=1`)도 방법 |
| U14 | **운영(키움) 휴장일**: 키움 경로는 장 달력을 코드로 만들어 `DATA_GOKR_API`(특일정보)가 없으면 대체공휴일을 모른다 (2026-10-05를 개장일로 계산함을 확인) | 운영에서 휴장일에 장이 열린 것으로 본다 | 담당 1 | 미정 — 운영 `.env`에 `DATA_GOKR_API`(특일정보 활용신청 포함) |
| U15 | **10/6(화) 정규장 실측 넓히기** — 시나리오 `docs/records/기록.md` A장(S0~S19): U8에 더해 ~~단타 연습(계획 만들기 → 체결 → 15:15 강제 정리 `EOD`)~~(단타 폐기로 시험하지 않음, 2026-10-06), 장 마감 뒤 16:30 오늘의 내 종목 뉴스 자동 실행, 18:00 펀더멘털 점검 | 장중·장 마감 뒤 자동 작업은 실제 시각에 돌려 본 적이 없다 (10/5는 휴장) | 담당 1 | 미정 — 결과를 `docs/tasks/00-공통.md` 부록 A6 "확인한 것"에. **10/6 오전 못 함**(U8과 같은 이유) — 다시 할 날은 계획서 3-4 |
| U16 | **알려진 한계** (2026-10-05 리뷰·실측): ① ~~`/api/day/preview`에 비정상적으로 큰 가격(1e308)을 주면 500~~(단타 폐기로 없어짐, 2026-10-06 — `/api/orders`는 같은 값을 저장한다) ② ~~수능일(정규장 10:00~16:30)은 분봉이 15:30까지만~~(분봉 삭제로 없어짐) ③ ~~토스 1분봉의 15:30 봉이 일봉 종가와 다를 수 있다(10/2 삼성전자: 분봉 275,250 · 종가 276,000)~~(분봉 삭제로 없어짐) ④ 오늘의 내 종목 뉴스의 LLM이 `DAILY_MOVE_MODEL`이 없어 `APPROVER`(claude-opus-5-5)를 쓴다 — 실측 종목당 약 $0.02 | 발표 전에 고칠지 정할 것 | 사용자·담당 1 | 미정 (④는 `DAILY_MOVE_MODEL`에 싼 모델 지정 검토) |
| U17 | **2026-10-05 구현의 커밋·push 여부** | 팀원이 받아야 같은 코드로 개발한다. 공유 DB는 이미 새 마이그레이션이 적용됐다 | 사용자 | **완료** (2026-10-05 사용자 요청으로 `main`에 push, `d5376b8`) |
| U18 | **2026-10-05 UI/UX 개선 + 서비스 이름 "종이배"·로고의 커밋·push 여부** | 프론트 약 160개 파일(새 파일 36개 — `git status --short`의 `??`를 함께 add), 백엔드 4개(Discord 머리말·PDF 이름과 테스트), 문서. DB·API 계약 변경 없음. 담당 5의 원래 파일(Layout·LoginPage·ReportPage·components/reports 등)을 포함하므로 합친 뒤 5에게 알린다(`docs/DECISIONS.md` 14-2·15-6). 팀에는 이름 변경(종이배)도 알린다 | 사용자 | **완료** (2026-10-05 사용자 요청으로 `main`에 push). **남은 일**: 담당 5에 "합쳤다" 알림, 팀에 이름 변경 공지 |
| U19 | **토스 client 분리**: 같은 client를 쓰는 다른 곳과 토큰이 서로 무효가 된다 (U4, 2026-10-06에도 되풀이) | `AGENTS.md` 안전 규칙("개발용 client를 따로 쓴다")과 어긋난다 | 사용자·담당 1 | 미정 — 제안: 개발용 토스 client를 따로 받는다, 그 전까지는 실측·시험 시간 밖에 `run_engine`을 내린다, 키움 키를 받는 즉시 `BROKER`를 키움으로 (계획서 3-4) |
| U20 | **자동 리포트 B9 구현 시점** (~~와 단타 AI 팀~~ — 단타 AI는 2026-10-06 단타 폐기로 필요 없음): 문서는 B9를 담당 1의 발표 전 일(P1, 부록 A11 ①)로 둔다 (~~단타 AI(`day_plan`·`day_review`)를 담당 3의 설계 논의(11장 ③)로 둔다~~) | 계획서 첫 초안이 근거 없이 둘 다 "발표 뒤"로 적었다(2026-10-06 검증에서 고침). 미룰 이유(제안): Discord 보류(U7)로 B9의 발송처가 없고 비용이 매일 든다 (~~단타 AI는 `registry.py`의 `TEAM = "stock_report"` 고정을 같이 바꿔야 한다~~ — 단타 폐기) | 팀장 | **구현 (2026-10-07, 사용자 "추천 워크플로우 전부 구현")** — `AUTO_REPORT`(기본 off)로 켠다. 운영에서 켤지는 U26 |
| U21 | **워크플로우 설계 쟁점 Q1~Q8** (timeout 규칙, 제한 시간, 사유 코드, 검토 입력, runner를 켜는 시점, 시험 수단, 장애 셈법, 그 밖) | 코드보다 먼저 정해야 뼈대·T3-5·T4-4가 막히지 않는다 | 담당 2·3·4(Q5는 1과) | **Q1·Q2·Q3·Q4·Q5는 2026-10-07 구현으로 정해졌다** (Q1 같은 모델 1회 → 대체 모델 · 호출 한 번 최대 4회, Q2 단계 180초, Q3 `timeout`, Q4 검토는 조사+초안, Q5 24시간 넘은 신청은 `expired` — `docs/DECISIONS.md` 19장). Q6~Q8은 4의 장애 주입·지표와 같이 미정. **Q1 다시 정함 (2026-10-08, 사용자 — 절충안)**: 주 모델 timeout은 같은 모델을 다시 기다리지 않고 바로 대체 모델, 대체 모델 timeout은 같은 모델로 한 번 더 (`docs/DECISIONS.md` 19장, `00-공통.md` 7절). 시험 결과는 `docs/records/기록.md` H장 |
| U22 | **운영 PDF**: web 이미지에 Chromium이 없어 운영 구성의 PDF 내려받기가 HTML로 나간다 (`deploy/Dockerfile` web 단계, `backend/reports/views.py`). smoke 시험은 engine 컨테이너만 본다 | 로컬(맥의 Chrome)에서는 PDF가 나와 눈 확인으로는 찾기 어렵다 | 담당 1 | 미정 — web 이미지에 Chromium을 넣을지, 엔진이 끝난 리포트의 PDF를 미리 만들지(appdata 볼륨 공유), smoke에 web PDF 확인을 더할지 |
| U23 | **단타 기능 삭제** (2026-10-05에 구현한 단타 연습·단타 퀴즈·분봉·`horizon`·`day` 보유 방식·`EOD`를 모두 없앤다) | 사용자가 단타를 하지 않기로 했다. 투자 방식은 스윙·장기 둘 | 사용자 | **결정 (2026-10-06, 사용자)** — 코드·마이그레이션 4개(`trading/0003`·`autotrade/0003`·`autotrade/0004`·`accounts/0004`)·문서를 같이 고쳤다. 공유 개발 DB·운영 DB의 migrate는 팀원이 받은 뒤에 (16-2). 기록은 `docs/DECISIONS.md` 16장. U15·U16·U20·E-6의 단타 항목은 "폐기로 필요 없음"으로 바꿨다 |
| U25 | **추천 워크플로우 실제 모델 첫 실행** (2026-10-07 구현은 가짜 LLM 테스트로만 확인) | 프롬프트가 계약을 자주 어기면(숫자 든 쉬운 요약, 후보 밖 종목, 진입가가 종가에서 5% 넘게 떨어짐) 재요청·검토 RETRY가 늘어 비용·실패가 는다. 리포트 1건 약 $0.3~0.5 | 담당 2·3(T2-10·T3-10) | 미정 — 호스트 PC에서 종목 리포트 1건, `manage.py auto_report --force --wait` 1회. 결과를 `docs/tasks/00-공통.md` 부록 A2에 |
| U26 | **운영에서 `AUTO_REPORT`를 켤지** — 켜면 거래일마다 선정 팀 1회 + 종목 리포트 3건(약 $1~2/일)이 돌고 Discord로 나간다 | Discord Webhook 보류(U7)면 발송은 콘솔로만 남는다. `AUTO_RECOMMEND=demo`와 같이 켜지 않는다 | 사용자 | 미정 — 기본 off. 켜면 EC2 `.env.docker`에 `AUTO_REPORT=on` |
| U24 | **새 이름 "모매매"에 로고·부제를 맞출지** — 이름은 2026-10-07에 바꿨고(`docs/DECISIONS.md` 18장), 로고(종이배 모양)와 부제 "종이 위에서 연습하는 AI 리포트 모의투자"는 그대로 두었다 | 로고·부제가 지난 이름 "종이배"에서 나왔다. 팀에 새 이름을 공지하고 발표 자료도 새 이름으로 | 사용자 | 이름은 **결정 (2026-10-07, 사용자)**. 로고·부제는 **결정 (2026-10-08, 사용자 — 바꿈)**: ju 브랜치 `f2d42db`(ㅁ 블록 셋 로고·워드마크·인트로, 부제 "여러 AI가 함께 검증하는 모의투자")를 main에 합치고 PDF 머리 로고(`reports/output/pdf.py` `LOGO_SVG`, 양식 판 5)도 맞췄다 — `docs/DECISIONS.md` 27장 |
| U27 | **시연용 수동 시작(`docs/DECISIONS.md` 31장)을 발표 뒤에도 둘지** — 지금은 설정 없이 늘 켜져 있다 (`AUTOTRADE_DEMO`와 무관) | 손익비·기대값 점검을 사람이 건너뛰는 길이라 시연 밖에서는 "AI는 제안만 · 리스크 엔진이 정한다" 원칙의 예외로 남는다 | 사용자 | 미정 — 발표(10/13) 뒤 결정. 끄려면 설정 키(`ci.yml`·`deploy/.env.docker.example` 같이)를 두거나 기능을 지운다 |
| U28 | **손익비가 낮은 계획에도 "새 매매 계획 제안" 알림이 간다** — 2026-10-11 전체 E2E(로컬 `auto_report --force`)의 자동 리포트 계획 3개(리노공업·삼성SDI·LG에너지솔루션)는 손익비 0.18~0.36이라 리스크 엔진이 시작을 막는데(`blockedBy`에 `reward_risk_low` — 다시 시도 2번도 모두 1.5 미만), "새 매매 계획 제안" 알림은 그대로 나갔다 | 알림을 눌러 들어가면 "지금은 시작할 수 없음"만 보인다 (초보자에게 헷갈린다) | 사용자 | 미정 — 제안: 알림 문장에 시작할 수 없는 이유를 붙이거나, `blockedBy`가 빈 계획만 알린다. 시연은 수동 시작(U27)으로 할 수 있다 |
| U29 | **직접 주문에서도 매수 유의 종목을 막을지, 그 범위와 1,000원 미만 종목** — 지금은 자동매매 계획만 막고(`engine/paper_engine/judge/risk.py` `_screen`의 `warning_stock`) 직접·예약 주문은 배지만 보인다 | 키움·대신 상시 모의투자와 한투 대회는 막는 종목이다. 토스 `warnings`에는 관리종목·투자주의가 없다 (`docs/research/조사.md` E6) | 사용자 | 미정 — 제안: 정리매매·경고·위험·관리·거래정지는 막고, 주의·과열은 확인 후 진행, 1,000원 미만은 표시만 (`docs/plans/컨셉변경계획.md` 부록 B-3 ④·B-6) |
| U30 | **시장 대비 수익률의 시장 값** — KODEX 200·코스닥150 대용을 쓸지, 토스 `market-indicators`의 진짜 지수를 쓸지 | 공개 메서드를 두 클라이언트에 같게 두는 규칙 때문에 키움 `ka20006` 실측 전에는 진짜 지수를 붙이기 어렵다 | 사용자 | 미정 — 제안: 대용으로 시작하고 키움 실측 뒤 지수로. 지수를 붙이면 `docs/DECISIONS.md` 14-3의 "토스 조회에는 지수가 없고"를 고친다 (`docs/plans/컨셉변경계획.md` 부록 B-3 ②·B-6) |
| U31 | **매매 이유 한 줄을 주문 때 필수로 받을지** | 필수면 돌아보기는 좋아지지만 주문이 번거로워진다 (StockTrak은 기본 켬) | 사용자 | 미정 — 제안: 선택, 주린이모드는 칩으로 한 번 묻기. 메모는 AI 입력으로 쓰지 않는다 (`docs/plans/컨셉변경계획.md` 부록 B-3 ③·B-6) |
| U32 | **랭킹 시즌·자격·동률 규칙** — 지금은 누적 수익률 하나, 동률은 닉네임순 | 한 번 크게 맞힌 사람만 위에 남는다. 국내 대회는 최소 매매일·종목 수와 동률 규칙을 둔다 | 사용자 | 미정 — 제안: 한 달 시즌, 거래한 날 3일·종목 2개 이상, 동률은 거래금액 → 거래일수 (`docs/plans/컨셉변경계획.md` 부록 B-3 ⑤·B-6) |
| U33 | **랭킹 공개 범위를 MDD·시장 대비·거래일수까지 넓힐지** — 지금은 닉네임과 수익률만 (`backend/trading/service.py` `ranking`, 마이 '내 정보 공개' 문구) | 새 랭킹 탭(시장 대비·MDD 작은 순)과 자격 표시가 공개 범위를 넓힌다 | 사용자 | 미정 — 제안: 지표만 넓히고 금액·보유 종목은 계속 비공개, 공개 스위치 문구도 같이 고친다 (`docs/plans/컨셉변경계획.md` 부록 B-3 ⑤·B-6) |
| U34 | **트레일링 스톱의 화면 표시** — 보유 중 올라간 손절가를 숫자로 보일지 | 올라간 손절가 숫자로 장중 최고가를 거꾸로 계산할 수 있어 `docs/DECISIONS.md` 14-1(장중 가격 숫자를 문장에 넣지 않는다)과 부딪힌다 | 사용자 | 미정 — 제안: 규칙("고점 대비 −x%")만 보이고, 처음에는 직접 스윙 주문만 (`docs/plans/컨셉변경계획.md` 부록 B-3 ⑥·B-6) |
| U35 | **모의 체결가를 보수적으로 바꿀지와 수수료** — 지금 확인 가격은 현재가·최우선 매수·매도호가의 중간값 (`docs/DECISIONS.md` 4-2) | 매수가 매도호가보다 싸게 잡히면 연습 성과가 부풀려진다. 키움은 같은 이유로 수수료를 0.35%로 받는다 | 사용자 | 미정 — 제안: 매수는 최우선 매도호가·매도는 최우선 매수호가 쪽, 수수료는 0.015% 유지. 방향별 가격을 청산 판단에도 쓸지 같이 정한다. 정하면 4-2를 고친다 (`docs/plans/컨셉변경계획.md` 부록 B-3 ⑦·B-6) |
| U36 | **모의 계좌 되돌리기(리셋)를 범위 밖에서 꺼낼지** — 3-3에서 범위 밖으로 정했다 | 해외 모의매매는 리셋이 기본이고, 국내는 참가 취소 후 재참가다. 기록을 지우면 성적표·랭킹이 깨진다 | 사용자 | 미정 — 제안: 넣는다면 시즌(U32)이 바뀔 때만, 기록은 지우지 않고 회차로 닫는다 (`docs/plans/컨셉변경계획.md` 부록 B-6) |

---

### 4-2. 제품·계획 결정

컨셉 계획(D-1~D-7, `docs/plans/컨셉변경계획.md` 13장)과 확장 계획(E-1~E-7, `docs/plans/컨셉변경계획.md` 부록 A6)은 **2026-10-04에 모두 결정**했다 (팀장).
결정 원문은 `docs/DECISIONS.md` 13장이다. 그 뒤 바뀐 것: D-5 이름(→ 15-7 "종이배" → 18장 "모매매"), E-6 단타 한도(단타 폐기로 필요 없음 — 16장).
계약 B1~B10은 `docs/API.md`·`docs/tasks/00-공통.md`, 담당별 할 일은 `docs/tasks/00-공통.md` 부록 A1~A6에 옮겼다 (2026-10-07 정리 — 이 장에 있던 결정 표는 13장과 같아서 지웠다).

---

### 4-3. 기술 확인 (2026-10-04 2차: 공개 1차 출처로 확인한 것과 실측이 남은 것)

자세한 내용과 출처는 각 조사 보고서의 "확인 필요" 절 (항목마다 [확인됨]·[일부 확인]·[실측 필요] 표시).

| 영역 | 확인한 것 (2026-10-04) | 남은 것 (실측) | 보고서 |
|---|---|---|---|
| 세율 | **2026년 국내 매도 거래세 코스피·코스닥 모두 0.20%** (증권거래세법 시행령 제5조, 2026-01-01 시행 + 농특세) → 엔진 `SELL_TAX_RATE` 0.002와 **맞다**. law.go.kr "현행" 표시 판에 이 개정이 아직 합쳐지지 않아 연혁 판으로 확인했다 | ETF 등 거래세 면제 종목 처리 (엔진은 모든 국내 매도에 0.2%) | `docs/research/조사.md` C5 11번 (폐기된 단타 조사의 기록 — 세율 출처로만 남김) |
| 키움 실시간 | "세션당 200종목"은 TR 합산(공식 FAQ #41), `grp_no`로 한도가 늘지 않음, 토큰은 6시간 뒤 재요청하면 재발급·기존 폐기(FAQ #25), **키움 정기 접속 단절 월~토 07:50~07:55 · 일 05:00~05:15** (REST·웹소켓) | 201번째 등록 응답, 두 번째 세션 동작, PING 주기, 0B 빈도, NXT 수신, `ka10079` 행 수 등 (키 필요) | 같은 보고서 5장 |
| 장 시간 | **2026-09-14 KRX 애프터마켓(16:00~20:00) 신설·시간외단일가 폐지, NXT 제도 변경** (키움 공지 #59·#60). KRX 정규장 09:00~15:30은 그대로 | **완료** (2026-10-05 `d5376b8`: `docs/design/DESIGN.md` 부록 A7-1 개편 표·`calendar.py` 머리말에 반영, afterMarket 15:30~20:00은 KRX+NXT 합집합으로 둔다 — `docs/DECISIONS.md` 14-1. 0s 코드표는 저장소에 없다) | 같은 보고서 5장 6번·출처 26·27 |
| 장기 자료 | OpenDART 영업활동현금흐름은 13/13 회사가 표준 `account_id`, 이자비용은 손익계산서 표준 태그 0/13 → `FinanceCosts`·현금흐름표 이자지급으로 근사. LLM 1회 비용 추정 약 $0.002~0.04 | `ka20001`/`ka20006` 값 단위, `upName`·`ka10101` 체계, `ka10059` 확정 시각 (키 필요), 정기공시 반영 시차, data.go.kr 반영 시점, 게이트웨이 실비용 | `docs/research/조사.md` B8 |
| 선물 | **폐기로 확인하지 않음** | – | `docs/research/조사.md` D장 (참고용) |
| 약관 | 1장 U5·U10·U12·U13 | 토스 약관 전문·NAVER API HUB 약관·KIS 고객 약관 원문(공개 페이지 없음), 키움 문의 답 | `docs/research/조사.md` A10 |
| 구현된 것 | – | 장중 체결·청산·재주문 실측(U8, 10/6 오전 못 함 → 계획서 3-4), Discord 실채널(U7, 보류), 키움 실측(U9, 키 대기) | 위 1장 |

---

### 4-4. 담당별로 넘길 것 — **2026-10-05 단순화: 팀원 할 일은 ① 추천 워크플로우 개발 ② UI/UX 업그레이드 ③ 추가 기능 논의 ④ 테스트** (부록 A11). 담당 표는 `docs/DECISIONS.md` 14-2 표가 우선한다

| 담당 | 지금 받은 일 | 근거 |
|---|---|---|
| 1 | U3·U8(10/6)·U9(대기)·U10 문의·U12·U14, B4·B5·B6·B7·B8·B9·B10, 쉬운 보기 뼈대(새 파일만), 사용성 시험 준비(`시험1~3`), 발표 시나리오 데이터, 자동 리포트 T1-4·T1-5 | `docs/tasks/00-공통.md` 부록 A1 T1-19~T1-28, `06` T6-10~T6-13 |
| 2 | B1 `plainSummary`(뼈대 PR부터), 프롬프트 요건(목표 가격 근거·의견이 틀리는 경우·권유형 금지), D-7 한도, `ReportDraft.targets`에 `holdingDays`·`probability` | `docs/tasks/00-공통.md` 부록 A2 |
| 3 | 실패 사유 코드 목록(`00-공통.md` 9절), `runner.tick()` 위치, 설계서 ①의 "사용자 3단계 ↔ Agent" 표 | `docs/tasks/00-공통.md` 부록 A3 |
| 4 | B3 `opinion`·`oneLiner`(뼈대 PR부터), B7 실패 알림 kind `report_failed`, `recovery` 값, 자동 복구율 두 정의 | `docs/tasks/00-공통.md` 부록 A4 |
| 5 | 탭 이름·순서, 서비스 이름, 주린이모드 분기 한 곳, **D-1 교차검증 분석 화면 유지·배치**, 사유 문장 표, 쉬운 보기 다듬기, 발표 자료 | `docs/tasks/00-공통.md` 부록 A5 T5-16~T5-22 |

---

### 4-5. 다음 세션에서 이어서 할 일 (제안 순서)

1. 이 문서 1장의 미정 줄을 사용자에게 확인한다 — U16(알려진 한계를 발표 전에 고칠지), U13(토스 공유 방식), U19(토스 client 분리), U20(B9 시점), U22(운영 PDF). U21(설계 쟁점 Q1~Q8)은 팀 2·3·4가 정한다.
   U18(UI/UX·종이배)은 push했다 — 담당 5에 "합쳤다"고 알리고(5는 그 위에서 다듬는다), 팀에 이름 변경을 공지하고, 실기기(iOS Safari·Android Chrome)로 시트·숫자 키패드·토스트와 연결 띠 쌓기(safe-area)·차트 핀치·홈 화면 아이콘을 한 번 확인한다. 발표 자료에는 새 이름·로고를 쓴다(`docs/DECISIONS.md` 15-7).
2. U8·U15 실측(`docs/records/기록.md` A장 S0~S19)은 10/6 오전에 못 했다 — 계획서 3-4대로 다시 한다(`scripts/dev.sh`로 다시 띄우기, 시험 계정, 호스트 PC 전원·덮개·네트워크). 결과는 그 문서 표와 `docs/tasks/00-공통.md` 부록 A6 "확인한 것"에 적는다.
3. 추천 워크플로우는 2026-10-07 Claude가 구현했다 (`docs/DECISIONS.md` 19장). U25의 실제 모델 실행으로 쉬운 보기·PDF·리포트 끝 알림(`reports/output/alerts.py`)·선정 결과 화면을 확인한다.
   팀원 몫으로 남은 파일(`chaos.py`·`stats.py`·`budget.py`)은 사용자가 따로 말하지 않는 한 만들지 않는다.
4. 키움 키를 받으면(U9) `scripts/kiwoom_check.py` → 지수 TR 실측 (분봉 `ka10080`은 단타 폐기로 하지 않음, 2026-10-06) → 시장 대용 ETF를 지수로 바꿀지.

---

## 부록 A. 팀 개발 계획 (팀원 전달용)

> 옛 `docs/plans/TEAM_DEV_PLAN.md` (2026-10-12 이 문서에 합침 — `docs/DECISIONS.md` 32장). 이 부록 안의 "n장"·"n-m"은 부록 An·An-m을 가리킨다.

2026-10-02 작성, 같은 날 평가 기준(`docs/evaluation/프로젝트평가기준.md`)에 맞춰 다시 구성.
지금까지 만들어진 것과 **발표(10월 13일)까지 팀이 개발할 일**, 개발 환경에 붙는 방법을 정리한다.
전체 배경은 이 문서 1~3장, API 계약은 `docs/API.md`, 결정 사항은 `docs/DECISIONS.md`, 규칙과 명령은 `AGENTS.md`.

### 목차

1. 과제와 평가 기준, 우리 프로젝트의 대응
2. 일정
3. 지금 상태와 이미 들어 있는 복구 로직
4. 개발할 일 A — 에이전트 협업: 리포트 생성 워크플로우
5. 개발할 일 B — AutoHealing: 장애 감지·복구·장애 주입·시각화
6. 개발할 일 C — 자동 리포트 파이프라인 (거래대금 상위 선별 → 리포트 → A4 PDF → Discord)
7. 개발할 일 D — 배포와 CI/CD 파이프라인
8. 장애 주입 시험과 지표
9. 산출물 3종, 발표, 시연
10. UI·UX 개선과 추가
11. 역할 분담 (5명)
12. 개발 환경: 화면과 DB에 접속하기
13. 같이 지킬 규칙
14. 서비스 최종 흐름: AI 추천 → 계획 활성화 → 자동매매 → 알림 (2026-10-04)
15. 서비스 컨셉과 주린이모드 (2026-10-04 확정)

---

### A1. 과제와 평가 기준, 우리 프로젝트의 대응

| 항목 | 내용 |
|---|---|
| 과제 주제 | **에러 자가 치유(AutoHealing) 워크플로우** — 여러 에이전트의 역할과 협업 구조를 설계하고, 장애를 감지·판단·복구하는 자동화 흐름을 구현한 뒤, 서비스로 배포해 장애 시험으로 복구 결과를 검증한다 |
| 발표 | **2026-10-13(화) 15시부터**, 팀당 20분, zoom 화면 공유. 시연 영상은 미리 만들어도 된다 |
| 필수 산출물 | ① 멀티 에이전트 아키텍처 설계서 ② 배포 및 장애 복구 보고서 ③ 파이프라인 구현 결과 보고서 |
| 평가 | 기획·목표 달성도 25 · **서비스 완성도·활용 가능성 35** · 수행 과정·개선 노력 20 · 발표 20 |

**우리 프로젝트를 한 문장으로:** 팀원이 종목 리포트를 신청하거나 매일 장 시작 전 거래대금 상위 종목이 자동으로 선별되면, 여러 에이전트가 조사·작성·검토를 나눠 리포트를 만들고,
그 과정에서 모델·외부 API·DB에 장애가 나도 재시도·대체 모델·캐시로 스스로 복구해 A4 리포트를 Discord로 보낸다. 모든 과정은 웹의 Trace 화면에서 본다.
리포트가 매수를 제안하면 그 진입가·목표가·손절가·기대수익이 **AI 추천**이 되고, 팀원이 웹이나 Discord 링크로 "계획 활성화"를 누르면
모의 계좌에서 계획대로 자동매매가 진행되며 단계마다 알림이 간다 (14장).

핵심 수행내용 네 가지와 이 문서의 작업:

| 핵심 수행내용 | 우리가 할 일 | 장 | 증빙으로 남길 것 |
|---|---|---|---|
| 에이전트 협업 시나리오와 역할 구조 설계 | 역할·책임·입출력·Handoff·종료 조건 설계, 실행 계획(YAML Registry) | 4 | 아키텍처 설계서, 실행 계획 그래프 화면 |
| 장애 유형별 복구 로직 및 자동화 파이프라인 구현 | 장애 유형표, 재시도·대체 모델·캐시 폴백, 장애 주입 체크박스, 자동 리포트 파이프라인 | 5, 6 | Trace(복구 과정), 복구 지표 화면, Discord로 온 리포트 |
| 협업 기반 실행 흐름 통합 구현 | Orchestrator(병렬·Join·검토 반복·Handoff)와 화면·알림 연결 | 4, 6 | 신청 → 리포트까지의 Trace, 시연 영상 |
| 서비스 배포 및 결과 검증 | Docker·EC2 배포, CI/CD(테스트 실패 시 배포 차단), 장애 주입 시험, 자동 복구율·평균 복구시간 | 7, 8 | 배포 URL, 파이프라인 실행 기록, 시험 결과표 |

평가 가이드의 "권장 진행 순서" 7단계는 이렇게 대응한다: 1~3단계(문제·역할·Handoff 설계) → 4장, 4단계(최소 협업 흐름) → 4장, 5단계(장애 감지·복구) → 5장,
6단계(배포·파이프라인) → 7장, 7단계(장애 주입 시험·결과 정리) → 8장.

> 가이드의 원칙: **문서에는 실제 구현한 구조와 실제 시험 결과만 쓴다.** 수치를 지어내지 않는다. 실패 사례와 개선 이력을 숨기지 않고 같이 정리한다.

---

### A2. 일정 (제안)

10/3(토)은 개천절, 10/9(금)은 한글날이다. 평일은 10/5~10/8, 10/12 닷새뿐이다.
**10/5(월)는 개천절 대체공휴일로 증권시장이 쉰다** — 정규장이 필요한 일(체결·청산 실측, 시연 영상의 체결 장면)은 10/6(화)부터 한다.
서비스 컨셉(**"AI 리포트 데스크"**, 주린이모드)은 2026-10-04 팀장 결정으로 확정됐다 — `docs/DECISIONS.md` 13장. 이름은 2026-10-05 "종이배", 2026-10-07 **"모매매"**로 바꿨다(`docs/DECISIONS.md` 15-7·18장).

| 날짜 | 할 일 | 끝나면 있어야 하는 것 |
|---|---|---|
| ~10/4(일) | **설계 확정**: 역할·출력 계약(4-2 A), 장애 유형과 복구 정책 표(5-1), 대체 모델 정하기, API 계약 추가분을 `docs/API.md`에 반영, Discord 발송 방식 결정(6-4) | 아키텍처 설계서 초안, 각자 맡을 일 |
| 10/5(월)~10/7(수) | **구현**: Worker·Orchestrator(4장), 복구 계층·장애 주입·복구 시각화(5장), 자동 리포트·PDF·Discord(6장), Docker·CI(7장) — 병렬로 | 로컬에서 신청 → 리포트 → Discord까지, 장애 주입 시 자동 복구 |
| 10/8(목) | **통합과 배포**: EC2에 올리고 CI/CD로 한 번 이상 배포 | 배포 URL, 파이프라인 실행 기록 |
| 10/9(금)~10/11(일) | **장애 주입 시험**(8장)과 지표 측정, 산출물 3종 작성, 시연 영상 | 시험 결과표, 문서 3종, 영상 |
| 10/12(월) | 리허설(20분), 발표 자료 마무리, 배포 환경 최종 점검 | 발표 자료 |
| 10/13(화) 15시 | 발표 | |

늦어질 때 줄이는 순서: UI·UX 추가 항목(10장) → Handoff(리스크 점검) → 자동 리포트의 화면 설정. **줄이면 안 되는 것**: 신청 → 리포트 흐름, 대체 모델 복구와 그 시각화, 배포, 장애 시험 결과표.

---

### A3. 지금 상태와 이미 들어 있는 복구 로직

지금 상태(기능별 동작 여부·근거)는 **이 문서 1장 한 곳**에서 관리한다 (2026-10-07 정리 — 이 장에 있던 상태 표는 낡아서 지웠다).

**이미 들어 있는 복구 로직** (새로 만들 것이 아니라, 장애 복구 보고서에 실제 구현으로 적고 시험할 것):

| 장애 | 지금의 복구 | 위치 |
|---|---|---|
| 증권사 API 429·호출 제한 | `Retry-After`만큼 기다렸다 최대 3회 재시도 | `engine/paper_engine/data/kiwoom.py`, `toss.py` |
| 증권사 토큰 무효(401) | 캐시를 다시 읽고, 같으면 한 번 재발급 후 재시도 | 같은 파일 |
| 시세 조회 실패 | 계좌 평가는 체결가로 대신하고 사유를 표시, 전일 종가 실패는 60초 캐시해 반복 호출을 막음 | `backend/trading/market.py`, `service.py` |
| 한 시장의 장 달력 조회 실패 | 그 시장만 건너뛰고 다른 시장의 체결·청산은 계속 | `backend/trading/service.py` |
| 예약 실행 중 일시 오류 | 정규장 시작 뒤 10분 동안 다시 시도 | 같은 파일 |
| 엔진 루프의 한 단계 오류 | 그 단계만 실패로 남기고 루프는 계속 | `backend/trading/management/commands/run_engine.py` |
| 엔진 프로세스가 죽어 남은 실행 중 작업 | 다시 뜰 때 실패로 정리해 큐가 멈추지 않게, 끝낼 때 하위 프로세스 정리 | `backend/analysis/jobs.py` |
| AI 분석 중 모델 시간 초과 | 그 모델을 이후 단계와 의결에서 빼고 계속 (핵심 모델이면 중단) | `engine/paper_engine/pipeline.py` |
| 화면의 실시간 연결(SSE) 끊김 | Snapshot을 3초마다 다시 받는 방식으로 전환 | `frontend/src/api/reports.ts` |

---

### A4. 개발할 일 A — 에이전트 협업: 리포트 생성 워크플로우

**목표:** `/reports`에서 종목을 신청하면(또는 6장의 자동 선별이 신청하면) 여러 Agent가 협업해 리포트를 만들고, 그 과정(Trace)이 화면에 실시간으로 보인다.
개념과 용어는 `docs/교육용문서.md`(04 Distributed Collaboration)를 따른다. 화면의 "개념 문서" 탭에서도 볼 수 있다.

#### A4-1. 역할 구조 (아키텍처 설계서의 뼈대)

평가 가이드의 예시 역할(Supervisor·Planner·Executor·Critic·Memory Keeper)에 우리 구조를 맞추면 이렇다. 구조는 Supervisor 기반 중앙 조정형이다.

| 가이드의 역할 | 우리 프로젝트 | 하는 일 | 하지 않는 일 | 출력 |
|---|---|---|---|---|
| Supervisor | **Orchestrator** (코드, LLM 아님) | 실행 계획대로 작업 할당, 완료 수집, Join·재시도·대체 모델·종료 판단, State·Trace 기록 | 조사·작성을 직접 하지 않는다 | 다음 담당, 실행 상태 |
| Planner | **실행 계획** (`team_definitions.yaml` + 계획 검증) | 단계·의존성·병렬·필수/선택·제한 시간을 선언 | 실행 중에 LLM이 계획을 바꾸지 않는다 | Execution Plan |
| Executor | **조사 Worker 셋** (시세·차트 / 재무·공시 / 뉴스·심리), **리포트 작성 Worker** | 맡은 자료를 모으고 LLM으로 결과를 만든다 | State를 직접 바꾸지 않는다. 스스로 성공 판정하지 않는다 | 계약에 맞는 결과 |
| Critic | **검토 Agent** | 리포트가 조사 결과와 맞는지, 근거 없는 주장이 없는지 보고 **PASS·RETRY·FAIL**을 낸다 | 리포트를 직접 고치지 않는다 | 판정과 수정 지시 |
| Memory Keeper | **Shared State·Trace 저장소** (`reports`, `report_trace_events` 표, `state.py`) | 작업 상태·중간 결과·실패 이력·시도 횟수 보관 | 비밀 값·개인 정보를 넣지 않는다 | 상태 참조 |
| (Handoff 대상) | **리스크 점검 Agent** | 투자 유의·고위험 신호가 있을 때 검토 Agent에게서 책임을 넘겨받아 경고를 붙인다 | | 리스크 경고 |

```
                      ┌ 시세·차트 Agent (필수)  ┐
신청 → Orchestrator ─┼ 재무·공시 Agent (필수)  ┼→ Join Guard → 리포트 작성 Agent → 검토 Agent ─ PASS → 완료 → PDF·Discord
                      └ 뉴스·심리 Agent (선택)  ┘                    ▲                  │ RETRY (수정 지시, 최대 2회)
                                                                   └──────────────────┘
                                                                              │ FAIL → 안전 종료·담당자 알림
                                                                              └ Handoff ⇢ 리스크 점검 Agent
```

설계서에 꼭 들어갈 판단 주체: **최종 성공·실패·재시도는 Orchestrator가 정한다.** 검토 Agent는 판정만 내고, 다시 시킬지·몇 번까지인지는 Orchestrator의 규칙(최대 2회)이 정한다.
역할 중복과 책임 공백 점검: 조사 셋은 자료가 겹치지 않게(가격 / 재무·공시 / 뉴스), 결과를 고치는 주체는 리포트 작성 Agent 하나, 검증 주체는 검토 Agent 하나.

#### A4-2. 만들 것

이미 있는 것(고치지 않고 그 위에 만든다): 실행 계획과 계획 검증(`backend/reports/orchestration/registry.py`, YAML 두 개), State·Trace 저장과 **유일한 쓰기 경로**(`orchestration/state.py`:
`start`·`set_step`·`record`·`add_result`·`add_error`·`finish`), Snapshot·SSE API, 화면(그래프·타임라인·State·정책 안내·예시 재생).
새 코드는 `backend/reports/`의 기능 폴더에 둔다 (예: `guardrails/contracts.py`·`guards.py`, `agents/report_team/`, `orchestration/orchestrator.py`·`runner.py` — 폴더 구성은 `AGENTS.md` "구조", `docs/DECISIONS.md` 29장).

| # | 작업 | 내용 |
|---|---|---|
| A | **출력 계약** | Worker별 결과 형식과 검증 (`MarketResult`, `FundamentalResult`, `NewsResult`, `ReportDraft`, `ReviewResult`(판정 PASS·RETRY·FAIL + 수정 지시), `RiskResult`). 검증을 통과한 결과만 `state.add_result`로 넣는다 |
| B | **Worker 6개** | 자료를 모으고 LLM을 불러 계약에 맞는 결과를 돌려준다. State를 직접 바꾸지 않는다 |
| C | **Orchestrator** | 조사 3개 병렬 실행·완료 수집 → Join Guard → 리포트 작성 → 검토 → (RETRY면 수정 지시를 넣어 다시 작성, 최대 2회) → (Handoff) → 전체 종료 |
| D | **Join Guard** | 필수 결과 존재 → 계약 확인 → 실패 결과 제외 → 최소 Context 선택. 막으면 `join_blocked`, 뒤 Agent는 `skipped` |
| E | **부분 실패 정책** | `failure_policy`(fail_fast·best_effort·required_optional)와 `required`·`optional`대로 계속할지 정한다 |
| F | **Handoff와 Guard** | 아래 4-3의 전달 데이터, Guard(사용자, 허용 경로, 민감정보, 최대 Hop) |
| G | **실행 연결** | 웹 요청 안에서 실행하지 않는다. `run_engine` 루프에서 `requested` 리포트를 집어 실행 (`backend/analysis/jobs.py`의 `tick()`이 본보기). 끝나면 `reports/orchestration/registry.py`의 `AGENTS_IMPLEMENTED = True` |
| H | **Provider·Model** | `worker_definitions.yaml`의 `provider`·`model`과 **대체 모델**(5장)을 채운다 |
| I | **비용·한도** | 리포트 한 건의 AI 비용 기록, 팀원별·전체 하루 한도 (`backend/analysis/quota.py` 방식) |
| J | **테스트** | LLM은 가짜 객체로. 정상, 선택 Worker 실패, 필수 Worker 실패(Join 차단), 검토 RETRY 뒤 PASS, RETRY 한도 초과, Handoff Guard 거절 |

Worker가 쓸 수 있는 자료 (이미 있는 코드를 쓴다):

| Worker | 쓸 수 있는 것 |
|---|---|
| 시세·차트 | `engine/paper_engine/data/snapshot.py`의 `build_snapshot`(현재가·일봉·이동평균·RSI·ATR), `backend/trading/market.py`(캐시된 시세·일봉) |
| 재무·공시 | `engine/paper_engine/data/dart.py`(`DartClient`), `data/fina_stat.py`. `DART_API_KEY` 필요 |
| 뉴스·심리 | `engine/paper_engine/data/news.py`의 `fetch_news`, `data/broker_reports.py` |
| 리스크 점검 | 조회 클라이언트의 `warnings(symbol)`, 스냅샷의 `warnings` |
| LLM 호출 | `engine/paper_engine/llm.py`의 `LlmClient`(`complete_json(model, system, user)`, 비용 `llm.cost`). DevPass 게이트웨이 |

#### A4-3. Handoff와 공유 상태 (가이드 3단계)

전달 데이터는 가이드의 예시 필드와 교육 문서의 필드를 합쳐 쓴다.

| 필드 | 용도 |
|---|---|
| `task_id`, `trace_id` | 작업 추적 (`report-<번호>`) |
| `from_agent` / `to_agent` | 전달 주체와 대상 |
| `objective`(= `responsibility`) | 넘기는 책임 |
| `inputs`(= `context`) | 최소한의 입력. 원본 대신 참조(`memory_refs`: State의 결과 키)를 넘긴다 |
| `constraints` | 금지·제한 (예: 리포트 본문을 고치지 않는다) |
| `expected_output` | 기대 결과 형식 (출력 계약 이름) |
| `attempt` | 시도 횟수. **RETRY면 이전 실패 원인과 수정 지시를 같이 넣는다** |
| `user_id`, `hop_count` | 요청자, Handoff 횟수 (최대 Hop 제한) |

API 키·비밀번호·개인 정보는 메시지와 Trace에 넣지 않는다. Guard가 확인한다.

#### A4-4. Trace를 남기는 규칙 (화면이 이 규칙으로 그린다)

- 사건은 `state.record(report, actor, action, status, provider, model, latency_ms, details)`로만 남긴다.
  `actor`는 Worker id 또는 `join_guard`·`handoff_guard`·`orchestrator`.
- 주요 `action`: `agent_started`·`agent_completed`·`agent_failed`·`join_completed`·`join_blocked`·`workflow_completed` (+ 5장의 복구 사건).
  `status`는 `started`·`completed`·`failed`·`blocked`·`skipped` 다섯 가지뿐이다.
- Guard 사건의 `details`에 대상을 넣는다: `join_guard` → `{"step": "compose"}`, `handoff_guard` → `{"to": "risk_agent"}`.
- 순서: `state.start` → (`set_step` → 사건 → `add_result`/`add_error`) 반복 → `workflow_completed` 사건 → `state.finish`. **`finish` 뒤에는 Trace가 붙지 않는다.**
- 실패한 결과를 빈 값이나 고정된 성공 결과로 바꾸지 않는다. 앞이 실패하면 뒤는 실행하지 않고 `skipped`로 남긴다.
- 어떤 모양이 되어야 하는지는 화면의 **예시 Trace 재생**을 보면 된다.

#### A4-5. 완료 기준

- 신청하면 몇 분 안에 리포트 본문이 나오고, 그래프의 노드가 대기 → 실행 중 → 완료로 실시간으로 바뀐다.
- 검토 Agent의 PASS·RETRY·FAIL에 따라 다음 경로가 달라지고, RETRY는 정한 횟수를 넘지 않는다 (무한 실행 방지).
- Trace만 보고 "왜 끝났는지"를 설명할 수 있다. `uv run pytest`가 실제 LLM·증권사 호출 없이 통과한다.

---

### A5. 개발할 일 B — AutoHealing: 장애 감지·복구·장애 주입·시각화

과제의 중심이다. **장애가 나도 사람이 손대지 않고 정상 결과가 나오는 것**과, **그 과정을 눈으로 보여 주는 것** 두 가지를 만든다.

#### A5-1. 장애 유형별 감지와 복구 (배포 및 장애 복구 보고서의 핵심 표)

| 유형 | 예 | 감지 조건 | 복구 | 그래도 안 되면 | 상태 |
|---|---|---|---|---|---|
| LLM 응답 없음 | 모델이 제한 시간 안에 답하지 않음 | 호출 시간 초과 | 주 모델은 다시 기다리지 않고 **바로 대체 모델로 전환**, 대체 모델은 1회 재시도 (2026-10-08) | 선택 Worker면 건너뛰고 계속, 필수면 실패 종료·알림 | **만들 것** |
| LLM 서버 오류 | 5xx, 429 | 상태 코드 | 간격을 두고 재시도 → 대체 모델 | 위와 같음 | **만들 것** |
| LLM 출력 형식 불일치 | JSON이 아니거나 출력 계약 위반 | 계약 검증 실패 | 오류 내용을 넣어 **다시 요청** → 대체 모델 | 위와 같음 | **만들 것** |
| 근거 없는 응답 | 조사 결과에 없는 주장 | 검토 Agent의 RETRY | 수정 지시를 넣어 다시 작성 (최대 2회) | FAIL → 안전 종료·알림 | **만들 것** (4장 C) |
| 같은 모델의 연속 실패 | 한 모델이 계속 죽어 있음 | 연속 실패 횟수 | 일정 시간 그 모델을 건너뛰고 대체 모델을 먼저 쓴다 (Circuit Breaker) | – | **만들 것** |
| 외부 API | 증권사 시세 429·5xx, DART·뉴스 실패 | 상태 코드, 시간 초과 | 재시도, 캐시된 값 사용, 선택 자료면 빼고 계속 | 필수 자료면 실패 종료·알림 | 일부 있음 (3장 표) |
| DB | 연결 끊김 | DB 오류 | 다음 루프에서 다시 연결해 이어 감 | 알림 | 일부 있음 |
| 프로세스 중단 | 엔진 루프가 죽음 | 다시 뜰 때 `running`으로 남은 리포트 | 실패로 정리하거나 마지막 단계부터 다시 실행 | 알림 | 분석 작업에는 있음, 리포트에는 **만들 것** |
| 프롬프트 공격 | 뉴스·공시 본문에 든 "지시를 무시하라" 같은 문구, 비밀 값 요구 | Guard의 문구·형식 검사 | 그 자료를 빼고 진행, 차단 사실을 Trace에 기록 | 알림 | **만들 것** (4장 F의 Guard에 포함) |
| 화면의 실시간 연결 끊김 | SSE 끊김 | 연결 오류 | Snapshot 폴링으로 전환 | – | 있음 |
| 알림 실패 | Discord 전송 실패 | 응답 코드 | 재시도 → 글만 보내기 | 로그에 남김 | **만들 것** (6장) |

LLM 세 줄(응답 없음·서버 오류·출력 형식 불일치)의 재시도와 전환은 모두 호출 한 번에 **최대 4회** 시도 안에서 한다 (주 모델 2회 + 대체 모델 2회 — 5-2).

"그래도 안 되면" 칸이 가이드의 **최종 실패 조건**과 **수동 개입 조건**이다. 복구에 실패하면 사용자에게는 이해할 수 있는 안내(화면의 실패 사유)를, 담당자에게는 Discord 알림을 보낸다.

#### A5-2. 대체 모델로 복구 (모델 1 실패 → 모델 2로 추론)

- `worker_definitions.yaml`의 Worker마다 주 모델과 **대체 모델 목록**을 둔다 (예: `model: A`, `fallbacks: [B, C]`). Registry 검증에 추가한다.
  (2026-10-07 담당 4 결정: 호출기는 `fallbacks`를 쓰지 않고 `healing.FALLBACK_POOL`에서 차단되지 않은 **대체 모델 하나**를 고른다 — `docs/tasks/00-공통.md` 7절)
- LLM 호출을 한 곳(예: `backend/reports/autohealing/healing.py`의 호출 함수)으로 모은다. Worker는 이 함수만 부른다. 이 함수가 아래 순서로 복구한다.
  1. 호출 → 실패(시간 초과·서버 오류·형식 불일치)를 **유형으로 분류**
  2. 유형에 맞게 같은 모델로 다시 (형식 불일치면 오류를 알려 주고 재요청, 서버 오류면 잠깐 기다렸다가). 주 모델의 시간 초과는 다시 기다리지 않고 바로 3으로 (2026-10-08)
  3. 그래도 실패하면 **대체 모델(하나)로 전환** — 대체 모델도 같은 규칙으로 한 번 더
  4. 대체 모델도 실패하면 Worker 실패 → Orchestrator가 필수/선택 정책대로 처리
- 시도 횟수와 전체 제한 시간에 상한을 둔다 (무한 재시도 금지): 호출 한 번에 **최대 4회**(첫 시도 + 재시도 3회, 모델마다 2회 — `MAX_ATTEMPTS = 4`, `MAX_ATTEMPTS_PER_MODEL = 2`),
  단계 제한 시간(180초) 안에서. 복구에 쓴 시간과 비용을 기록한다.

Trace에 남길 사건 (`docs/API.md`와 `docs/tasks/00-공통.md` 9절에 확정했다. 누가 남기는지와 셈법은 9절이 원본):

| action | status | 남기는 쪽 | details |
|---|---|---|---|
| `agent_failed` | `failed` | 호출기(4) — LLM 호출 **한 번**의 실패마다 | `{"errorType": "timeout"\|"server_error"\|"bad_output"\|"unknown", "attempt": 전체 시도 번호, "injected": true\|false, "final": false}` + 그때의 `provider`·`model`·`latency_ms` |
| `agent_retry` | `started` | 호출기(4) | `{"attempt": 2, "reason": ...}` (같은 모델로 다시) |
| `agent_failover` | `started` | 호출기(4) | `{"from": "모델 A", "to": "모델 B", "reason": errorType 또는 "circuit_open"}` |
| `agent_completed` | `completed` | Orchestrator(3) | `{"attempts": 3, "recovered": true, "recoveryMs": 4200, "costUsd": ...}` + 실제로 답한 `provider`·`model` |
| `agent_failed` | `failed` | Orchestrator(3) — 그 Worker를 **포기**할 때 | `{"errorType": 마지막 실패, "attempts": n, "final": true, "message": ...}` |

`final: false`(호출 한 번의 실패)와 `final: true`(포기)를 구분한다. **장애 1건** = Worker 실행(`agent_started`부터)의 첫 `agent_failed(final: false)`,
**복구됨** = 그 실행이 `agent_completed`로 끝남, **복구 시간** = `agent_completed.at − 첫 agent_failed.at`. 화면·지표 API·PDF가 모두 이 셈법을 쓴다.

#### A5-3. 장애 주입 체크박스 (시연과 시험용)

> **2026-10-12 바뀜 (`docs/DECISIONS.md` 35장)**: 장애 주입은 서비스 신청 화면에서 지우고 **관리 서버 `/chaos`(F11)에서만** 켠다. 요청은 관리 서버가 서명해 서비스 내부 API(`POST /api/internal/chaos-runs`)로 보낸다. 아래 주입 방식은 그대로다.

- **리포트 신청 화면에 "장애 주입 (랜덤 실패)" 체크박스**를 둔다. 켜고 신청하면 그 리포트의 실행 중에 LLM 호출이 정해진 확률로 일부러 실패한다.
  요청: `POST /api/reports {"symbol": ..., "chaos": {"enabled": true}}` (선택: 실패 확률, 실패 유형, 대상 Worker). 리포트에 설정을 저장한다.
- 주입은 5-2의 호출 함수 안, 실제 호출 직전에서 한다 (시간 초과·서버 오류·형식이 깨진 응답을 흉내 낸다). 그래야 **복구 로직은 진짜 경로 그대로** 탄다.
- 주입한 실패는 Trace에 `injected: true`로 남겨 실제 장애와 구분한다. 난수 씨앗을 기록해 같은 시험을 다시 돌릴 수 있게 한다.
- 시험용으로 유형을 고르는 선택도 둔다 (8장의 시나리오마다 원하는 장애를 정확히 일으키기 위해): 특정 Worker의 주 모델만 실패, 모든 모델 실패, 형식 불일치만 등.
- 주입은 리포트 워크플로우에만 적용한다. 모의 주문·계좌에는 영향을 주지 않는다. 대체 모델 호출은 실제 비용이 드니 한도(4장 I)에 포함한다.

#### A5-4. 복구 과정 시각화 (화면)

지금의 Trace 화면(`/reports/:id`) 위에 만든다.

- **노드 안에 시도 이력**: `모델 A ✕ 시간 초과 → 모델 B ✕ 시간 초과 → 모델 B 재시도 ✓` 처럼 모델 이름과 결과를 순서대로. 복구된 노드에는 **"자동 복구"** 표시.
- **타임라인**: 실패·재시도·대체 모델 전환 사건을 눈에 띄게, 주입된 장애는 "주입" 표시.
- **이번 실행 요약**: 장애 n건, 자동 복구 n건, 복구에 걸린 시간, 최종적으로 답한 모델.
- **복구 지표 화면** (관리자 화면 `/ops` — "리포트" 메뉴를 8번 연속 누르면 열리는 숨은 화면, 관리자 계정만. API `GET /api/reports/recovery-stats`): 기간별 **자동 복구율**, **평균 복구시간**, 장애 유형별 성공·실패 건수, 최근 실패 사례.
  8장의 시험 결과표를 이 화면의 수치로 채운다.
- **예시 Trace 재생에 세 번째 시나리오** "모델 실패 → 대체 모델로 복구"를 더한다 (Agent가 완성되기 전에도 화면을 확인할 수 있게).

#### A5-5. 완료 기준

- 장애 주입을 켜고 신청해도 리포트가 끝까지 나오고, 어느 모델이 실패했고 어느 모델이 대신 답했는지 화면에서 보인다.
- 모든 모델이 실패하는 경우: 선택 Worker면 건너뛰고 완료, 필수 Worker면 실패 종료하고 사유가 화면과 Discord에 나온다.
- 복구 지표 화면의 자동 복구율·평균 복구시간이 Trace에서 계산된 실제 값이다.
- 복구 로직의 테스트가 있다 (가짜 LLM이 n번째 호출까지 실패하도록 해서 재시도·전환·상한을 검사).

---

### A6. 개발할 일 C — 자동 리포트 파이프라인 (거래대금 상위 선별 → 리포트 → A4 PDF → Discord)

엔진에 있던 "거래대금 상위 종목을 규칙으로 선별하고, 리포트를 만들어 Discord 채널로 보내는" 기능을 이 프로젝트에서 실제로 돌게 한다.

#### A6-1. 지금 상태

- 엔진에 있다: 선별 `screen_market`(거래대금 상위 100 → 규칙 점수, `engine/paper_engine/__main__.py`·`judge/screen.py`),
  전략 실행 `run_strategy`(선별 → 상위 몇 개 AI 분석 → 리포트), 리포트 `report.py`(HTML → Chrome으로 PDF), 알림 `notify.py`, 기본 전략(`strategies.py`: 정규장 시작 1시간 전 하루 한 번).
- 빠진 것: ① 웹 서비스(`run_engine`)에 연결돼 있지 않다 (엔진 자체 루프 `paper_engine serve`와 Redis가 따로 필요) ② **Discord로 보낼 수단이 없다** (엔진의 openclaw 경로는 프로그램과 봇 설정이 있어야 한다)
  ③ PDF를 만들 Chrome 경로가 설정돼 있지 않으면 HTML로만 나온다 ④ 리포트가 글과 표 위주로 길다 ⑤ 웹 화면에서 볼 수 없다.

#### A6-2. 만들 것

| # | 작업 | 내용 |
|---|---|---|
| 1 | **자동 실행** | `run_engine` 루프에 "자동 리포트" 단계: 국내 정규장 시작 1시간 전에 하루 한 번. 손으로 돌리는 명령도 둔다 (예: `manage.py auto_report --market KR`) |
| 2 | **선별** | 엔진의 `screen_market`을 그대로 쓴다 (거래대금 상위 100 → ETF 등 제외 → 규칙 점수). 상위 N개(기본 3)를 고른다 |
| 3 | **리포트 생성** | 고른 종목마다 4장의 워크플로우로 리포트를 만든다 (신청자 `auto`). 5장의 복구가 그대로 적용된다. Agent 워크플로우가 늦어지면 먼저 엔진의 교차검증 분석(`cmd_analyze`)으로 발송까지 연결해 두고 나중에 바꾼다 |
| 4 | **A4 PDF** | 아래 6-3 |
| 5 | **Discord 발송** | 아래 6-4 |
| 6 | **웹** | 리포트 목록에 "자동" 표시, PDF 내려받기(`GET /api/reports/{id}/pdf`), 오늘의 선별 결과 보기 |
| 7 | **테스트** | 선별(가짜 조회 클라이언트), PDF용 HTML 생성, 발송(가짜 전송), 하루 한 번만 도는지 |

#### A6-3. 리포트 서식: A4 PDF, 시각 자료 위주, 짧게

- **A4 한 종목 한 쪽**(길어도 두 쪽). 지금의 `report.py`는 `@page { size: A4 }`와 Chrome PDF 변환이 이미 있다. 내용 구성을 바꾼다.
- 한 쪽 구성 (위에서 아래로):
  1. 머리: 종목명·코드, 날짜, 판정, **한 줄 결론**
  2. **가격 차트**: 최근 일봉 + 이동평균선, 진입가·목표가·손절가를 가로선으로
  3. **핵심 지표 카드** 4~6개: 등락률, 거래대금 순위, RSI, 변동성, PER 등
  4. **점수·확률 막대**: 검토 점수, 목표 도달 확률, 손익비
  5. 근거 3줄 · 리스크 3줄 (긴 서술은 뺀다)
  6. 꼬리: 어떤 Agent가 만들었는지, **자동 복구가 있었는지**(예: "뉴스 Agent: 모델 A 실패 → 모델 B로 복구"), 비용
- 첫 장(표지)에는 그날의 **선별 요약**: 거래대금 상위 막대그래프, 선별된 종목과 점수, 탈락 사유 요약.
- 차트는 서버에서 **SVG로 직접 그린다** (엔진은 표준 라이브러리만 쓴다. 외부 차트 라이브러리를 넣지 않는다). Chrome이 SVG가 든 HTML을 PDF로 바꾼다.
- 글자 수를 줄인다: 뉴스·웹 조사 원문, 모델별 긴 비평은 PDF에서 빼고 웹의 리포트 상세에서 본다.
- Chrome: 로컬은 `.env`의 `CHROME_BIN`, 배포 환경은 엔진 컨테이너에 Chrome을 넣는다. 없으면 HTML로 대신 보낸다 (이것도 복구 로직이다).

#### A6-4. Discord 발송 (결정 필요)

| 방식 | 장점 | 단점 |
|---|---|---|
| **Discord Webhook** (권장) | 채널에서 주소 하나만 만들면 된다. 설치할 것이 없고 표준 라이브러리로 PDF를 첨부해 보낼 수 있다. EC2·CI에서도 같은 방식 | 보내기만 된다 (우리는 알림만 필요) |
| openclaw | 엔진의 `notify.py`가 이미 지원 | 프로그램 설치와 봇 설정이 필요하다 |

- 권장: `.env`에 `DISCORD_WEBHOOK_URL`을 두고 `notify.py`에 Webhook 전송을 더한다 (openclaw는 그대로 두고 설정된 쪽을 쓴다). **Webhook 주소는 비밀 값이다** (`.env`에만).
- 같은 채널로 보내는 것: ① 자동 리포트 PDF와 한 줄 요약 ② 복구 실패 알림(담당자 알림) ③ 배포 파이프라인의 성공·실패(7장).
- 전송 실패 시: 재시도 → 첨부 없이 글만 → 로그. 이것도 5-1 표의 한 줄이다.

#### A6-5. 완료 기준

- 정해진 시각(또는 명령)에 선별 → 리포트 → PDF → Discord 채널 도착까지 사람 손 없이 된다.
- PDF가 A4이고, 차트와 지표 카드가 먼저 보이며, 한 종목이 한두 쪽이다.
- 장애 주입을 켠 상태에서도 리포트가 도착하고, PDF 꼬리에 복구 내용이 적힌다.

---

### A7. 개발할 일 D — 배포와 CI/CD 파이프라인

가이드 6단계와 산출물 ③(파이프라인 구현 결과 보고서)의 근거가 된다. **파이프라인 코드는 미리 만들어 두었다 (2026-10-02).**
남은 일은 서버 연결, 실행 기록 남기기, 4·5장 구현에 맞춘 통합 테스트 추가다. 구성·설정 방법·동작은 `docs/DEPLOY.md`.

| # | 작업 | 상태 | 내용 |
|---|---|---|---|
| 1 | **컨테이너** | 됨 | `deploy/docker-compose.yml`: nginx(프론트 + 프록시), web(Django), engine(`run_engine`, Chromium·한글 글꼴), migrate, db(PostgreSQL), redis. 상태 확인으로 기동 순서를 건다. root가 아닌 사용자·읽기 전용. 이 PC에서 띄워 `deploy/smoke_test.sh` 통과 |
| 2 | **CI** (`.github/workflows/ci.yml`) | 됨 | 커밋 → 린트 → 실주문 코드 0건 → 테스트(SQLite) → 백테스트 → 마이그레이션 확인 → 백엔드 테스트(PostgreSQL) → 프론트 검사·빌드 → 이미지 빌드 → 스택 기동 확인. 비밀 값 없이 돈다 |
| 3 | **CD** (`deploy.yml`) | 됨 (2026-10-06 서버 연결) | `main` push: 검사 통과 시에만 이미지를 올리고(GHCR, 태그 = 커밋 해시) 서버에서 받아 띄운다 → 상태 확인 → 실패하면 직전 버전으로 되돌린다. 되돌리기는 로컬 레지스트리로 확인했다 |
| 4 | **알림** | 바뀜 (2026-10-08 사용자 결정) | Discord 알림은 두지 않는다 (`deploy.yml`의 `notify` 작업을 지움, `docs/DECISIONS.md` 24장). 결과는 Actions 실행 결과(실행한 사람에게 GitHub 기본 실패 알림)와 관리 서버 배포 기록(`blocked`·`rolled_back` 등)으로 본다 |
| 5 | **서버 준비와 첫 배포** | 됨 (2026-10-06, 첫 배포 성공 — `docs/DEPLOY.md` 0장). 남음: 보안 그룹 HTTP 80, 키움 키·IP 등록, 운영 계정 | EC2 만들기, Docker 설치, 배포용 SSH 키, 서버의 `.env.docker`, GitHub 변수·비밀 값, `DEPLOY_ENABLED=true` (`docs/DEPLOY.md` 4~5장). 운영은 `DJANGO_DEBUG=off`와 키움 키 (토스 조회는 개발 전용이라 꺼진다) |
| 6 | **통합 테스트 추가** | 할 일 (4·5장과 같이) | 협업 흐름과 장애 복구(가짜 LLM으로 정상·재시도·대체 모델·Join 차단)를 `backend/reports/tests/`에 넣는다. 넣으면 CI가 알아서 돌린다 (워크플로를 고칠 필요 없다) |
| 7 | **배포 차단 확인** | 할 일 | 테스트를 일부러 실패시켜 **배포가 멈추는 것**을 한 번 실행해 기록한다 (`docs/DEPLOY.md` 8장, DR-CI-01) |
| 8 | **운영 전 점검** | 일부 됨 | 됨: SSE용 gunicorn 스레드 워커와 nginx 설정. 남음: 엔진 컨테이너의 Discord 발송 수단(6-4), 웹 프로세스를 늘릴 때 시세 캐시를 Redis로 (`docs/DECISIONS.md` 8-6), 도메인이 생기면 HTTPS |

새 기능을 만들 때 파이프라인과 맞출 것: 실행에 새 설정 키가 필요하면 `deploy/.env.docker.example`에 더하고, 이미지에 들어가야 하는 새 폴더·파일은
루트 `.dockerignore`와 `deploy/Dockerfile`을 확인한다. 테스트는 외부 API와 `.env` 없이 돌아야 한다 (CI에는 키가 없다).

"에이전트별 서비스를 컨테이너로"라는 가이드 문구에 대해: 우리 Agent들은 엔진 프로세스 하나 안에서 Orchestrator가 부르는 구조다. 컨테이너는 역할(web·engine·db·redis·nginx)로 나눈다.
가이드가 "팀이 구조를 정할 수 있다"고 했으므로 이 선택과 이유(팀 규모, 호출 한도 공유, 장애 격리는 Worker 단위 제한 시간·대체 모델로)를 설계서에 적는다.

완료 기준: 배포 URL에서 로그인 → 리포트 신청 → 복구 시각화까지 된다. `main`에 push하면 자동으로 배포되고, 테스트가 실패하면 배포되지 않는다. 실행 기록(실행 번호, 커밋, 시각, 통과 수, 링크)이 남아 있다.

---

### A8. 장애 주입 시험과 지표

가이드 7단계와 산출물 ②의 근거다. **배포 환경에서** 한다. 5-3의 체크박스와 유형 선택(2026-10-12부터 관리 서버 `/chaos`의 직접 설정)으로 장애를 일으키고, 결과는 Trace와 복구 지표 화면에서 가져온다.

시험 시나리오 (초안. 5-1 표의 줄마다 하나 이상):

| ID | 주입 장애 | 기대 동작 |
|---|---|---|
| DR-LLM-01 | 조사 Worker의 주 모델이 시간 초과 | 주 모델을 다시 기다리지 않고 대체 모델로 전환해 완료 (2026-10-08) |
| DR-LLM-02 | 모델이 형식이 깨진 응답을 냄 | 오류를 알려 재요청, 안 되면 대체 모델 |
| DR-LLM-03 | 선택 Worker(뉴스)의 모든 모델 실패 | 뉴스를 빼고 리포트 완료 |
| DR-LLM-04 | 필수 Worker의 모든 모델 실패 | Join 차단, 뒤 단계 건너뜀, 실패 종료, Discord 알림 (**수동 개입 필요**한 사례) |
| DR-CRT-01 | 검토 Agent가 RETRY를 냄 | 수정 지시로 다시 작성 후 PASS |
| DR-CRT-02 | 검토가 계속 RETRY | 최대 횟수에서 멈추고 실패 종료 (무한 실행 방지) |
| DR-API-01 | 증권사 시세 API 429·5xx | 재시도, 캐시 값으로 진행 |
| DR-API-02 | DART·뉴스 조회 실패 | 선택 자료면 빼고 계속 |
| DR-DB-01 | DB 컨테이너를 잠깐 내림 | 다시 연결해 이어 감 |
| DR-PROC-01 | 실행 중 엔진 컨테이너 재시작 | 남은 리포트를 정리하거나 이어서 실행 |
| DR-SEC-01 | 뉴스 본문에 "지시를 무시하라" 문구 | 그 자료를 빼고 진행, 차단 기록 |
| DR-NET-01 | 브라우저의 실시간 연결을 끊음 | Snapshot 폴링으로 전환, 화면 계속 갱신 |
| DR-NOTI-01 | Discord 전송 실패 | 재시도, 글만 보내기 |
| DR-CI-01 | 실패하는 테스트를 넣고 push | 배포 차단, 관리 서버 배포 기록 `blocked` |

시험마다 기록할 것 (가이드의 표 그대로): Scenario ID · 주입 장애 · 기대 동작 · **실제 동작** · **복구 시간** · **수동 개입(있음/없음)** · 판정(PASS/FAIL) · 증빙(Trace 화면 캡처, 로그, 링크).

지표 (계산 기준을 문서에 적는다):

- **자동 복구율** = 수동 개입 없이 정상화된 장애 시나리오 수 ÷ 전체 장애 시나리오 수 × 100
- **평균 복구시간** = 자동 복구에 성공한 시나리오의 복구시간 합 ÷ 그 건수. 복구시간은 Trace에서 첫 `agent_failed`부터 그 Worker의 `agent_completed`까지
- 장애 유형별 성공·실패 건수와 실패 원인. **실패한 시험과 그 뒤 고친 내용을 같이 적는다** (수행 과정·개선 노력 20점).

시험 중에 찾은 문제와 고친 내용은 그때그때 기록해 둔다 (예: `docs/records/기록.md`). 지금까지의 예: 독립 리뷰에서 나온 결함과 수정(`docs/DECISIONS.md` 8-6), 실제 연동에서 찾은 로그인 403·SSE 조기 종료.

---

### A9. 산출물 3종, 발표, 시연

문서는 `docs/deliverables/`에 둔다 (파일명과 버전을 일관되게). 각 문서에 들어갈 내용과 근거:

| 산출물 | 들어갈 내용 (가이드) | 근거가 되는 것 |
|---|---|---|
| ① 멀티 에이전트 아키텍처 설계서 | 목적·대표 시나리오, 협업 구조와 선정 이유, 역할·책임·입출력, Handoff 조건과 전달 데이터, 공유 상태 관리, 정상·재시도·실패·종료 흐름, 역할 중복·공백 점검 | 4-1·4-3·4-4, `team_definitions.yaml`, 실행 계획 그래프 화면, `docs/교육용문서.md` 대응표(`docs/DECISIONS.md` 9-2) |
| ② 배포 및 장애 복구 보고서 | 배포 구성, 장애별 감지 조건·지표·복구 전략, 장애 주입 시험의 입력·기대·실제·증빙, 자동 복구율·평균 복구시간, 수동 개입 조건과 알림 | 5-1 표, 7장 구성, 8장 결과표, 복구 지표 화면 |
| ③ 파이프라인 구현 결과 보고서 | 커밋 → 빌드 → 단위·통합 테스트 → 배포 흐름, 단계별 성공 조건·실패 처리, 테스트 실패 시 배포 차단, 알림, 실제 실행 결과(실행 번호·커밋·시각·통과 수·링크) | 7장, GitHub Actions 실행 기록, DR-CI-01 |

시연 순서 (가이드의 예시에 맞춤. 영상으로 미리 찍어 둔다):

1. 정상 신청 → 그래프에서 역할 분담과 Join, Handoff를 보여 준다.
2. 검토 Agent가 RETRY를 내고 다시 작성해 PASS가 되는 흐름.
3. **장애 주입을 켜고 신청** → 모델 실패가 일어난다. (2026-10-12부터 관리 서버 `/chaos`에서 신청 — DECISIONS 35장)
4. Trace에서 실패 감지 → 재시도 → **대체 모델 전환**을 따라간다. (관리 서버 리포트 상세의 실행 기록)
5. 복구 뒤 리포트 본문이 나오고 **Discord에 A4 PDF**가 도착한다.
6. 파이프라인 실행 기록과, 테스트 실패 시 배포가 막히고 관리 서버에 `blocked`로 남은 기록.
7. 복구 지표 화면: 자동 복구율, 평균 복구시간, 실패 사례와 개선.
8. AI 추천 → 리포트 검토 → 계획 활성화 → 모의 자동매매 → 알림 (`docs/tasks/00-공통.md` 부록 A6 "시연 순서").

제출 전: 가이드 6장의 체크리스트를 그대로 확인한다. 특히 "설계서·구현·시험 결과가 서로 일치", "키·비밀번호가 문서와 저장소에 없다", "배포 환경에서 시연할 수 있다".

---

### A10. UI·UX 개선과 추가

프론트엔드는 `frontend/` (React + TypeScript + Tailwind CSS, 토스증권 스타일, 모바일 우선). API를 바꿔야 하면 `docs/API.md`를 먼저 고친다.

#### A10-1. 발표에 필요한 것 (먼저)

| 항목 | 내용 | 관련 |
|---|---|---|
| 장애 주입 체크박스 | 리포트 신청 폼 (+ 시험용 유형 선택) → 2026-10-12 관리 서버 `/chaos`로 옮김 | 5-3 |
| 복구 과정 시각화 | 노드의 시도 이력, "자동 복구" 표시, 실행 요약, 예시 재생 ③ | 5-4 |
| 복구 지표 화면 | 자동 복구율·평균 복구시간·유형별 건수 | 5-4, 8장 |
| 리포트 본문·PDF | 본문 꾸미기, PDF 내려받기, "자동" 표시, 오늘의 선별 결과 | 6장 |
| 검토 반복 표시 | RETRY 횟수와 수정 지시를 그래프·타임라인에 | 4장 |
| 실패 안내 | 복구 실패 시 사용자가 이해할 수 있는 사유와 다시 신청 | 5-1 |

#### A10-2. 지금 빠져 있어 불편한 것

| 항목 | 내용 | 백엔드 |
|---|---|---|
| 목표·손절 수정 | 보유 종목의 목표가·손절가·기한 바꾸기 | 있음 (`PATCH /api/orders/{id}`) |
| 예약 결과 알림 | 예약이 지워졌을 때 사유를 화면에 | 필요 |
| 일별 자산 그래프 | 수익률 추이·기간 선택 | 있음 |
| 오류·빈 화면 | 시세 조회 실패·네트워크 끊김 안내와 다시 시도 | – |

#### A10-3. 시간이 남으면

관심 종목, 홈 구성(시장 요약), 종목 상세의 지표·뉴스, 체결 알림, 랭킹 보강, 주문 편의(금액으로 수량 계산), ~~다크 모드~~(2026-10-05 완료 — `docs/DECISIONS.md` 15-2), 모바일(PWA),
관리 화면(계정·중단 스위치·AI 비용·엔진 상태·자동 리포트 설정), 통계·시장·전략 화면, 시세를 폴링에서 서버 푸시로.

#### A10-4. 화면을 고칠 때

- 디자인 토큰은 `frontend/src/index.css`(라이트·다크 한 쌍 — 색은 토큰만, `src/test/colors.test.ts`가 검사), 공용 부품은 `frontend/src/components/ui.tsx`·`components/motion/`(접힘·시트·스크롤), 표시 형식은 `frontend/src/lib/format.ts`, 리포트 화면은 `frontend/src/components/reports/`.
- 360px 폭과 PC 폭 둘 다, **라이트·다크 두 테마**를 확인한다. 상태는 색만으로 구분하지 않는다. 모션·배치 규칙은 `docs/DECISIONS.md` 15장, 화면별 배치와 이유는 `docs/design/DESIGN.md` 부록 B.
- 검사: `cd frontend && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build`

---

### A11. 역할 분담 (5명) — 2026-10-05 단순화

**팀원 할 일은 네 가지로 줄였다: ① 추천 워크플로우 개발 ② UI/UX 업그레이드 ③ 추가 기능 논의 ④ 테스트.**
그 밖의 확정된 변경(장마감 기준 시세, 주린이모드·진단, 쉬운 보기, 계약 B3~B10, 리포트 끝 알림, 하루 리포트 한도, 장기투자, 약관 대응. 2026-10-05에 만든 단타 연습은 2026-10-06 사용자 결정으로 폐기 — `docs/DECISIONS.md` 16장)은
Claude가 구현한다(2026-10-05, `docs/DECISIONS.md` 14장). "추천 워크플로우"는 AI 리포트 Agent 워크플로우(조사 → 작성 → 검토 → 추천)와 그 복구 계층이다.

| 담당 | ① 추천 워크플로우 개발 (주 업무) | ② UI/UX 업그레이드 | ③ 추가 기능 논의 | ④ 테스트 |
|---|---|---|---|---|
| **1. 팀장·통합** | 통합·배포(EC2·CI/CD)·호스트 PC, 자동 리포트(B9: 매일 선별 상위 종목 리포트 자동 신청·Discord 발송) 연결 | 발표 흐름(쉬운 보기 → 전문가 보기 → 파이프라인) 점검 | 회의 진행, 결정 기록(4장) | 인프라 장애 시험(DB 중단·엔진 재시작·배포 차단), 10/6 정규장 실측 |
| **2. Worker** | Worker 6개·출력 계약(B1 `plainSummary` 포함)·프롬프트 요건 | 리포트 문장(쉬운 요약·근거·위험)의 품질 | 뉴스 출처 대안(발표 뒤 공시·수치 중심), 장기투자 AI 문장 | 출력 계약 테스트, LLM 장애 시나리오 일부 |
| **3. Orchestrator** | Orchestrator·Guard·runner·Handoff, 실패 사유 코드(`00-공통.md` 9절) | 진행 단계 표시가 실제 Trace와 맞는지 | ~~단타 AI 팀(`day_plan` 장 전 계획·`day_review` 장 후 복기) 설계~~ (2026-10-06 단타 폐기) | 오케스트레이션 테스트, 장애 시험 |
| **4. AutoHealing** | 재시도·대체 모델·Circuit Breaker·장애 주입·복구 지표·`reports` 마이그레이션 0002 | 자동 복구 문장("AI 하나가 늦어 다른 AI가 이어받았어요")·지표 화면 | ~~키움 실시간(단타 b) 도입 조건~~ (2026-10-06 단타 폐기) | 장애 주입 시험과 결과표(DR) — 결과 모음 |
| **5. 프론트** | 실제 Trace·결과로 리포트 화면 맞추기 | **주 업무**: Claude가 만든 쉬운 보기·주린이모드·장기투자 화면 다듬기, 발표 자료·시연 영상 | 화면 개선 아이디어 | 사용성 시험(10/7 저녁 복도 시험, 10/9 본시험) |

- 워크플로우 안의 파일 소유·함수 서명·출력 계약은 그대로 `docs/tasks/00-공통.md`가 원본이다(2절 표가 Claude 파일과 팀 파일을 나눈다).
- `docs/tasks/00-공통.md` 부록 A1~A6의 세부 줄 중 "→ Claude가 구현 (2026-10-05)" 표시가 붙은 것은 하지 않는다.
- 테스트는 전원: 자기 코드의 단위 테스트, 10/9 장애 시험(8장)·사용성 시험, 리허설.

<details><summary>이전 분담 (2026-10-04, 참고)</summary>


**담당별 세부 작업은 `docs/tasks/`에 있다**: `00-공통.md`(파일 소유, 함수 서명, Trace 규칙, 출력 계약 — 모두가 지키는 약속), `docs/tasks/00-공통.md` 부록 A1 ~ `docs/tasks/00-공통.md` 부록 A5(담당별 할 일·순서·완료 기준).
출력 계약(4-2 A), 복구 정책 표(5-1), 추가되는 Trace 사건과 API는 `00-공통.md`와 `docs/API.md`에 **초안으로 적어 두었다** (2026-10-04). 10/5 오전에 같이 훑고 바꿀 것만 고친 뒤 시작한다.

| 담당 | 만들 것 | 주로 건드리는 곳 | 산출물 책임 |
|---|---|---|---|
| **1. 인프라·배포·통합** (저장소·호스트 PC 담당) | EC2 준비, GitHub 변수·비밀 값, 첫 배포, 배포 차단 시연(7장). 호스트 PC·공유 DB·`main` 통합. 자동 리포트의 자동 실행·선별·리포트 생성 연결·Discord 발송과 그 테스트(6-2의 1·2·3·5·7) | `deploy/`, `.github/`, 자동 리포트 명령, 발송 코드 | ③ 파이프라인 보고서, ②의 배포 구성 |
| **2. Worker·출력 계약** | 출력 계약, Worker 6개, 모델 지정, 비용·한도 (4-2의 A·B·H·I) | `backend/reports/guardrails/contracts.py`, `agents/` | ①의 역할·입출력 |
| **3. Orchestrator** | 병렬 실행·Join Guard·실패 정책·검토 반복·Handoff·`run_engine` 연결과 그 테스트 (4-2의 C~G·J) | `backend/reports/orchestration/orchestrator.py`·`runner.py`, `guardrails/guards.py` | ① 설계서 총괄 (흐름·Handoff) |
| **4. AutoHealing 백엔드** | 재시도·대체 모델·Circuit Breaker, 장애 주입, 복구용 Trace 사건, 복구 지표 API, 엔진이 다시 뜰 때 남은 리포트 정리 (5-1~5-3) | `backend/reports/autohealing/healing.py`, YAML의 대체 모델, `docs/API.md` 추가분 | ② 장애 복구 보고서 (유형표·지표), 8장 시험 시나리오와 결과표 |
| **5. 프론트·리포트 서식** | 장애 주입 체크박스, 복구 과정 시각화, 복구 지표 화면, 검토 반복 표시, 실패 안내 (5-4, 10-1). A4 PDF 서식과 PDF 내려받기, "자동" 표시 (6-3, 6-2의 4·6) | `frontend/`, PDF용 HTML·CSS | 발표 자료·시연 영상 총괄 |

같이 하는 것:

- **장애 주입 시험(8장)**: 4번이 LLM 장애 시나리오를, 1번이 인프라 시나리오(DB 중단 DR-DB-01, 엔진 재시작 DR-PROC-01, 배포 차단 DR-CI-01)를 진행한다. 결과표는 4번이 모은다.
- **산출물 3종과 발표**: 책임자가 뼈대를 쓰고 각자 맡은 부분을 채운다. 리허설은 전원.

나눈 이유와 맞물리는 곳:

- 6장의 선별·리포트·알림은 엔진 코드를 잇는 일이라 엔진을 아는 1번이 맡는다. Discord Webhook도 배포 파이프라인 알림과 같은 채널을 쓴다.
  1번의 부담이 크면 자동 실행·선별 연결(6-2의 1·2)을 2번에게 넘긴다 (Worker가 같은 조회 자료를 쓴다).
- **3번이 가장 무겁다.** 밀리면 Handoff(4-2의 F)부터 줄인다 (2장의 줄이는 순서).
- **2번과 4번은 LLM 호출 함수 한 곳에서 만난다.** Worker는 4번이 만드는 호출 함수(5-2)만 부른다. 함수의 인자와 반환 형식을 첫날 정한다.
- 5번은 백엔드를 기다리지 않는다: 화면은 예시 Trace 재생(5-4의 세 번째 시나리오)으로, PDF 서식은 가짜 데이터로 먼저 만든다.
- 같은 파일을 두 사람이 고치지 않게 위 표의 "주로 건드리는 곳"을 지킨다. `state.py`·`registry.py`·`docs/API.md`처럼 같이 쓰는 파일을 고칠 때는 먼저 알린다.

의존 순서:

```
계약·정책 확정 ─┬→ Worker (2)     ─┐
(전원, ~10/4)   ├→ 복구 계층 (4)   ┼→ Orchestrator 통합 (3) ─→ 자동 리포트 연결 (1) ─→ 배포 (1) ─→ 장애 시험 (4·1, 전원)
                ├→ 화면·PDF 서식 (5, 예시 Trace와 가짜 데이터로 먼저)
                ├→ 선별·Discord 발송 (1, 가짜 리포트로 먼저)
                └→ Docker·CI (됨) ─→ 서버 준비 (1)
```

복구 계층(4)과 Guard(3)는 LLM 없이 가짜 객체로 만들고 테스트할 수 있어 먼저 끝내기 좋다. 화면·PDF 서식(5)과 서버 준비(1)는 Agent를 기다리지 않고 지금 시작할 수 있다 (Docker·CI 코드는 만들어 두었다).

---


</details>

### A12. 개발 환경: 화면과 DB에 접속하기

호스트 PC 한 대가 서버와 DB를 띄워 두고, 팀원은 같은 네트워크(같은 와이파이·사내망)에서 붙는다.

#### A12-1. 화면

- 주소: `http://<호스트 PC의 IP>:5173` (2026-10-02 기준 `http://192.100.200.209:5173`. IP가 바뀌면 호스트 PC에서 `scripts/dev.sh status`로 확인)
- 휴대폰에서도 같은 주소로 들어간다. 로그인은 전달받은 팀 계정으로 한다.

#### A12-2. DB (PostgreSQL) — 개발할 때만 같은 네트워크에 열려 있다

| 항목 | 값 |
|---|---|
| 호스트 | 호스트 PC의 IP (화면 주소와 같은 IP) |
| 포트 | `5434` |
| DB 이름 / 사용자 | `paper` / `paper` |
| 비밀번호 | **문서와 저장소에 적지 않는다.** 호스트 PC 담당자에게 따로 받는다 (호스트 PC `.env`의 `POSTGRES_PASSWORD`) |

접속 방법:

```bash
# psql
psql -h <호스트 IP> -p 5434 -U paper paper

# DBeaver · TablePlus · DataGrip: 새 PostgreSQL 연결 → Host <호스트 IP>, Port 5434, Database paper, User paper, Password (받은 값)

# 접속 문자열 (Python·도구용)
postgresql://paper:<비밀번호>@<호스트 IP>:5434/paper
```

주요 표:

| 표 | 내용 |
|---|---|
| `auth_user`, `accounts_profile` | 계정, 닉네임·공개 여부 |
| `paper_account`, `paper_orders`, `paper_fills`, `reservations`, `equity_daily` | 팀원별 모의 계좌, 주문(=포지션), 체결, 예약, 일별 자산 |
| `analysis_runs`, `jobs` | AI 분석 색인, 분석 요청 작업 |
| `reports`, `report_trace_events` | AI 리포트의 Shared State와 Trace. 복구 지표도 여기서 계산한다 |

주의:

- **조회 위주로 쓴다.** 손으로 `UPDATE`·`DELETE`하면 계좌 현금과 체결 내역이 어긋난다. 데이터를 고쳐야 하면 팀에 먼저 알린다.
- 접속이 안 되면: 같은 네트워크인지, 호스트 PC가 켜져 있고 `scripts/dev.sh status`에 "컨테이너: 실행 중"인지, 호스트 PC 방화벽이 5434·5173을 막지 않는지 확인한다.
- 이 DB는 **개발용**이다. 운영(EC2)에서는 DB 포트를 밖으로 열지 않는다.

#### A12-3. 자기 PC에서 개발할 때

가장 쉬운 방법: 호스트 PC 담당자에게 DM으로 받은 **팀원용 견본 `.env.team`**을 AI 코딩 에이전트(Claude Code, Codex 등)에게 주고
"이 `.env.team` 파일로 세팅해 줘"라고 한다. 파일 머리말의 지시대로 클론 → `.env` → 설치 → 검사 → 계정 → 서버 실행까지 묻지 않고 한다
(Node.js가 없을 때만 묻는다. 절차는 `docs/guides/SETUP_PROMPT.md`의 견본 모드). 이미 클론했으면 그 폴더에서 "`docs/guides/SETUP_PROMPT.md`를 읽고 그대로 진행해 줘"도 된다.
macOS·Linux·WSL2에서 돈다 (WSL이 아닌 Windows에서는 돌지 않는다 — Windows는 먼저 `docs/guides/SETUP_PROMPT.md` 0장).

손으로 할 때:

```bash
git clone https://github.com/SHS5029/paper_trading.git && cd paper_trading
cp .env.team .env           # 받은 팀원용 견본을 저장소 루트에 .env.team으로 둔 뒤. 없으면 cp .env.example .env 후 키를 채운다. 커밋하지 않는다
uv sync && (cd frontend && npm ci)
scripts/dev.sh              # Django + 엔진 루프 + 프론트엔드를 한 번에 띄운다. 끝나면 주소가 나온다
```

`.env`의 `DJANGO_SECRET_KEY`는 견본에서 비워 두었다. 각자 아무 긴 문자열을 넣는다 (`python3 -c "import secrets; print(secrets.token_urlsafe(50))"`).
견본에는 호스트 PC의 토스 키와 Discord Webhook을 넣지 않는다 (토스 토큰은 client당 1개만 유효하고, 팀 채널 알림은 호스트 PC만 보낸다).
키움 키가 없으면 그 PC에서는 가격·차트·종목 검색·선별과 AI 분석·리포트 신청이 503이다 (장마감 종가도 증권사에서 받으므로 대신 나오지 않는다).
시세가 필요한 화면은 호스트 PC 주소(12-1)에서 본다.

DB는 두 가지 중에 고른다.

| 방식 | `.env` | 언제 |
|---|---|---|
| 내 PC의 SQLite (기본) | `POSTGRES_HOST=` (비움, 견본 그대로) | 혼자 기능을 만들고 테스트할 때. 계정은 `cd backend && uv run python manage.py create_team_accounts`로 만든다 |
| 호스트 PC의 공유 DB | 견본 맨 아래 주석 두 줄을 푼다: `POSTGRES_HOST=<호스트 IP>`, `POSTGRES_PASSWORD=<받은 값>` (`POSTGRES_PORT=5434`는 견본에 있다). `DJANGO_SECRET_KEY`가 꼭 있어야 한다 | 팀이 같은 데이터를 보면서 화면을 맞출 때 |

공유 DB에 붙을 때 지킬 것:

- **엔진 루프(`run_engine`)는 호스트 PC에서만 돌린다.** 두 곳에서 돌면 서로의 작업을 실패로 정리하고 체결 확인이 겹친다.
  `scripts/dev.sh`는 `POSTGRES_HOST`가 다른 PC를 가리키면 알아서 엔진 루프를 띄우지 않는다 (손으로 `manage.py run_engine`을 실행하지 않는다).
  그래서 **Agent·Orchestrator를 개발할 때는 자기 PC의 SQLite**로 돌리는 편이 낫다 (엔진 루프를 직접 돌려야 하므로).
- **모델을 바꾸면 공유 DB의 구조가 바뀐다.** `scripts/dev.sh`는 공유 DB에 마이그레이션을 알아서 적용하지 않는다.
  `makemigrations` 뒤 팀에 알리고 직접 `cd backend && uv run python manage.py migrate`를 실행한 다음, 마이그레이션 파일을 바로 push한다.
- 계정은 이미 있다. 공유 DB에 붙은 PC에서 `create_team_accounts`를 실행하지 않는다 (계정이 새로 생긴다).
- 테스트(`uv run pytest`)는 공유 DB를 건드리지 않는다 (항상 SQLite 메모리 DB에서 돈다).
- 프론트엔드만 고칠 때는 백엔드 없이 `VITE_MOCK=1 npm run dev` (가짜 API)로도 된다.

#### A12-4. 호스트 PC를 맡은 사람

```bash
scripts/dev.sh            # 전부 (다시) 띄운다: PostgreSQL 컨테이너 + Django + 엔진 루프 + 프론트엔드(0.0.0.0)
scripts/dev.sh status     # 접속 주소와 DB 접속 방법
scripts/dev.sh logs       # 로그   ·  stop (서버 내리기, DB는 그대로)  ·  db (DB 셸)  ·  db-stop (DB 내리기)
```

호스트 PC의 `.env`에는 `POSTGRES_HOST=127.0.0.1`, `POSTGRES_PORT=5434`, `POSTGRES_BIND=0.0.0.0`, 긴 임의 `POSTGRES_PASSWORD`가 들어 있다.
이 `.env`를 팀원에게 그대로 주지 않는다 (DB 설정이 호스트 전용이고 토스 키가 들어 있다). 대신 저장소 루트의 팀원용 견본 `.env.team`(git 제외)에서
`(받은 값)` 칸(DevPass·DART 키, 공유 DB 비밀번호, 나눠 주기로 했으면 키움 키)을 채워 DM으로 보낸다. 호스트 IP가 바뀌면 견본의 IP도 고친다.
DB 데이터는 Docker 볼륨 `paper-dev_pgdata`에 있다 (컨테이너를 내려도 남는다). 예전 SQLite 파일 `backend/db.sqlite3`는 옮기기 전 사본으로 남아 있다.

---

### A13. 같이 지킬 규칙

- **실주문 코드 금지.** 증권사에는 조회만 한다. 주문은 모의 계좌에서만 체결한다.
- **비밀 값은 `.env`에만.** 키·비밀번호·Discord Webhook 주소·`team_accounts.txt`를 커밋하거나 문서·Trace·로그에 남기지 않는다 (제출 전 체크리스트 항목이다).
- **테스트는 실제 증권사·AI를 부르지 않는다.** 가짜 객체를 쓴다. push 전에 `uv run ruff check . && uv run pytest`와 프론트 검사를 돌린다.
- **API를 바꾸면 `docs/API.md`를 먼저 고친다.** Trace 사건·요청 형식을 더할 때도 마찬가지다.
- **State·Trace는 `backend/reports/orchestration/state.py`로만 바꾼다.** Worker는 결과만 돌려준다.
- **엔진 루프는 한 곳에서만.** 공유 DB를 쓸 때 `run_engine`은 호스트 PC에서만 돌린다.
- **토스 조회는 로컬 개발 전용이다** (`BROKER=toss`, `DJANGO_DEBUG=on`일 때만). 팀원 PC와 운영에는 키움 키를 쓴다.
- AI 분석·리포트·대체 모델 호출은 실제 비용이 든다. 반복 실험은 가짜 LLM이나 값싼 모델로 하고, 장애 주입 시험은 한도 안에서 한다.
- **문서에는 실제로 구현하고 측정한 것만 쓴다.** 실패 사례와 고친 내용을 같이 남긴다.
- `main`에 직접 push해도 된다. 큰 변경은 PR로 리뷰를 받는다.

---

### A14. 서비스 최종 흐름: AI 추천 → 계획 활성화 → 자동매매 → 알림 (2026-10-04)

AI가 종목과 진입가·목표가·손절가·기대수익을 추천하고, 사람이 웹이나 Discord 링크로 **계획 활성화**를 눌러야 모의 자동매매가 진행되며, 단계마다 알림이 간다.
흐름·작업·상태·시연 순서는 `docs/tasks/00-공통.md` 부록 A6, 결정은 `docs/DECISIONS.md` 12장, 계약은 `docs/API.md` 맨 끝 절이 원본이다 (2026-10-07 정리 — 이 장의 내용을 거기로 모았다).

---

### A15. 서비스 컨셉과 주린이모드 (2026-10-04 확정)

팀장 결정으로 확정됐다. 결정 원문은 `docs/DECISIONS.md` 13장(서비스 이름은 18장 "모매매"), 화면·계약은 `docs/plans/컨셉변경계획.md`, 주린이모드와 투자 방식은 `docs/plans/컨셉변경계획.md` 부록 A2,
계약 B1~B10은 `docs/API.md`·`docs/tasks/00-공통.md`, 담당별 할 일은 `docs/tasks/` (2026-10-07 정리 — 이 장에 있던 요약 표는 위 문서와 같아서 지웠다).
