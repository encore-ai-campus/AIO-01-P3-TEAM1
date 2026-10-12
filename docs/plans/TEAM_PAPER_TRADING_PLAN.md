# 모매매 — 팀 모의투자 웹 서비스

작성 2026-10-06(화). 기준 커밋 `main` `d3325f2`(2026-10-05 UI/UX 개선·서비스 이름 "종이배"). 1장은 2026-10-07에 다시 맞췄다.
**"지금 상태"는 이 문서 1장이 원본이다** — `README.md`의 요약 표, `docs/plans/TEAM_DEV_PLAN.md` 3장, `docs/결정필요사항.md` 0장은 여기를 가리킨다.
지금 상태를 확정했고, 앞으로는 3장의 네 가지(핵심 AI Agent 워크플로우·프론트엔드 개선·기능 개선·테스트 후 완성도 다듬기)만 한다. 배포·운영(EC2·키움 키·GitHub 배포 설정·운영 `.env`·Discord 채널)은 팀장(담당 1)이 따로 맡는다(`docs/DEPLOY.md`).
옛 판(2026-10-01 "토스 → 키움 전환 계획")은 `git show d3325f2:docs/plans/TEAM_PAPER_TRADING_PLAN.md`로 본다. `docs/DECISIONS.md`·`docs/KIWOOM.md`·`docs/design/DESIGN.md`의 "계획서 n장·단계 n"은 그 판을 가리킨다.
결정의 역사는 `docs/DECISIONS.md`, 남은 결정·확인(U1~U24)은 `docs/결정필요사항.md`에 있다.
근거는 파일:줄이나 문서 절로 단다. 실행해서 본 사실은 확인 방법을 붙인다. 코드·로그에서 미루어 본 것은 "추측", 문서에 없는 제안은 "제안"이라고 적는다.

---

## 1. 지금 상태

### 1-1. 한 문장 소개

**모매매**(2026-10-07 이름 바뀜 — 전 이름 "종이배", `docs/DECISIONS.md` 18장)는 주식이 처음인 사람도 AI 리포트를 만들고·검토하고·모의 자동매매로 실행해 보는 팀 모의투자 웹 서비스다. 시세는 증권사 조회 API로만 받고, 매매는 팀원별 가상 현금 계좌에서만 체결한다(**실주문 코드 0건**).
부제는 "여러 AI가 함께 검증하는 모의투자"다(2026-10-08 바뀜, `frontend/src/lib/plainText.ts` `SERVICE_TAGLINE`). 컨셉은 `docs/DECISIONS.md` 13장, 이름은 18장, 로고(ㅁ 블록 셋)·부제는 27장.

### 1-2. 기능별 상태

**동작** = 실제 데이터로 돈다 · **시연판** = 규칙 입력으로 끝까지 돈다(AI 아님) · **구조만** = 저장·화면·API만 있고 실행 부분이 없다 · **예시** = 서버 API가 없어 화면이 예시 데이터를 "예시" 표시와 함께 보인다. 건수는 공유 개발 DB를 읽기 전용으로 조회한 값(10/6)이다.

| 영역 | 된 것 | 상태 | 근거 (`DECISIONS` 절) |
|---|---|---|---|
| 모의 계좌·주문 | 팀원별 계좌(1천만원), 시장가·지정가, 장 밖 예약, 지정가는 장 끝에 취소, 목표·손절은 2회 연속 확인 뒤 청산, 보유 방식 swing·long | 동작. 실측은 웹 시장가 체결 3건(10/2)뿐, 지정가 체결·자동 청산은 아직(U8) | 8-1·8-3·14-3 |
| 장마감 기준 | 화면 숫자는 직전 정규장 종가(KR은 거래일 15:40에 넘어간다), 체결·청산만 장중 확인 가격 | 동작 | 14-1, `backend/trading/market.py:1-12` |
| 종목·차트 | 검색, 완성 일봉, 매수 유의, 펀더멘털 신호등(로컬은 `MARKETS=KR`) | 동작 | 14-3 |
| AI 교차검증 분석 | 웹 요청 → `run_engine`이 엔진 `analyze` 하위 프로세스를 돌린다. 팀원별 하루 5회, 팀 하루 $10 | 실제 LLM 실행은 CLI smoke-test 1건(10/2, $0.30)뿐. 웹 경로는 가짜 테스트로만 확인(분석 작업 0건) | 8-4 |
| AI 리포트 | 신청·하루 3회 한도, YAML Registry, State·Trace, Snapshot·SSE, 선별 API, A4 PDF, 쉬운 보기, 끝 알림 | **동작 (2026-10-07, Claude — `docs/DECISIONS.md` 19장)**: Orchestrator·Guard·runner·Worker 11개(종목 리포트 6 + 매매 종목 선정 5), 선정 Guard·하루 파이프라인(`AUTO_REPORT`, 기본 off). 가짜 LLM 테스트로 확인했고 실제 모델 실행(T2-10·T3-10)은 아직. 장애 주입(T4-6)·복구 지표(T4-7)·비용 예산은 없다(팀 몫). 하루 넘게 기다린 `requested`는 실행하지 않고 `expired`로 끝낸다 | 9-1 |
| 추천 → 활성화 → 모의 자동매매 → 알림 | 출처 report·analysis·demo, 리스크 엔진(건당 1%·손익비 1.5, 손절가는 코드가 정함), 진입 지정가·3일 재주문·목표·손절·기한 청산, 단계별 사건·알림 | 시연판: demo 규칙 추천만 있고 report 출처는 0건. 장중 체결·청산은 가짜 시세 테스트만(U8) | 12장, `docs/tasks/06-추천·자동매매.md:64-73` |
| 장기투자 | 장기 보유, "왜 샀나요?", 오늘의 내 종목 뉴스(16:30), 펀더멘털 점검(18:00), 웹 알림 | 동작(10/5 격리 환경). 실제 시각 실행은 아직(U15) | 14-3 |
| ~~단타 연습~~ | – | **폐기 (2026-10-06, 사용자 결정)**. 코드·API·화면에서 모두 지웠다 | 16장 |
| 주린이모드·화면 | 계정 저장, 7문항 진단, 홈 3단계 안내, 쉬운 보기, 실행 확인 체크리스트, 하단 탭 다섯, 다크 모드, 로고 | 동작. 쉬운 보기는 가짜 API(`VITE_MOCK=1`)로만 끝까지 봤다. 실기기 확인 전 | 14-7·15장 |
| 알림 | 웹 알림, Discord Webhook 보낼 편지함(1회 재시도·글만) | 웹은 동작, Discord는 꺼짐(U7). 직접 주문에는 체결 알림이 없다(`filled`는 자동매매 계획만 — `backend/autotrade/plans/executor.py:318`) | 12-4 |
| `/ops`·오늘의 선별 | 관리자 복구 지표(숨은 입구, staff만), 리포트 탭의 선별 결과 | 예시: 복구 지표 API가 없고 선별 파일도 없다(404). 발표·보고서에 쓰지 않는다 | `frontend/src/components/admin/RecoveryStatsPanel.tsx:177-179` |
| 엔진 CLI·백테스트 | 엔진 자체 계좌(SQLite)와 CLI, AI 없는 백테스트 | 동작. 웹 계좌와 별개 | `AGENTS.md:93-102` |

### 1-3. 비어 있는 것·막힌 것

- **핵심 AI Agent 워크플로우는 뼈대만 들어왔다 (10/7).** 출력 계약 6종·Worker 인터페이스(`contracts.py`·`agents/base.py`, `acdb038` — 리뷰 지적은 모두 미수정: `docs/works/todo/feat-2-worker_리뷰_Worker계약_2026-10-07.md`)와 Registry의 `fallbacks`·`retry`(T3-1, `78778e9`·`fcf4d5a`), 담당 4의 T4-1~T4-5(마이그레이션 0002, LLM 호출기 `healing.py` — 재시도·대체 모델·Circuit Breaker, PR #1·#2)가 들어왔다. Worker 구현(`agents.WORKERS`는 비어 있다)·orchestrator·guards·runner·chaos·stats·budget은 없다. 원격 브랜치는 팀원별로 생겼다(`git branch -r` 10/7: Hwanseok·dy·feat/2-worker·feat/4-healing·inhye·ju·yubeen). 과제 주제(에러 자가 치유)의 핵심이고, 산출물 3종·`docs/개선이력.md`·장애 시험 결과표도 아직 없다.
- **공유 개발 DB의 리포트 3건(10/2~10/5 신청)이 모두 `requested`다.** runner를 켜면 이 3건이 먼저 돈다(3-1 Q5).
- **10/6 개장 시험(U8·U15)은 시작하지 못했다.** 시험 계정이 없다. 호스트 PC(노트북)가 09:48~12:34에 절전과 짧은 깨어남을 되풀이했고, 그사이 토스 조회는 DNS 오류·403으로 실패했다(12:36부터 정상). 시각별 기록은 `docs/결정필요사항.md` U8.
- **토스 client를 원본 개인 프로젝트(실주문)와 같이 쓴다.** 한쪽이 토큰을 새로 받으면 다른 쪽 토큰이 무효가 된다. 10/6에도 되풀이된다(엔진 로그 13:02 `token-revoked`, `.cache/toss_token.json`을 13시대에 여러 번 다시 씀). `AGENTS.md:26-27`과 어긋난다(U4 → U19).
- **운영 전제는 팀장 몫으로 남았다.** EC2는 2026-10-06에 연결해 `main` push마다 자동 배포된다(`docs/DEPLOY.md` 0장). 하지만 보안 그룹 HTTP 80이 닫혀 있어 밖에서는 접속되지 않고, 키움 키(U9)가 없어 서버도 토스 조회를 임시로 쓴다. `DATA_GOKR_API`(U14)·Discord Webhook은 비어 있다. 운영 구성의 PDF는 HTML로 나간다(U22).
- **알려진 한계(U16, 고칠지 미정)**: ① 가격 상한이 없다 — `/api/orders`는 목표 1e308 같은 값을 201로 저장한다(10/6 테스트 DB에서 재현. 같은 값에 500이 나던 단타 미리 보기는 단타 폐기로 없어졌다) ②·③ 분봉 한계(수능일·토스 15:30 봉)는 분봉 삭제(2026-10-06)로 없어졌다 ④ 장기투자 뉴스가 `DAILY_MOVE_MODEL` 없이 `APPROVER`를 쓴다(종목당 약 $0.02).
- **약관**: Vite(`0.0.0.0:5173`)로 팀원에게 토스 시세를 보이는 지금 방식은 토스 FAQ의 제3자 배포 금지에 걸린다(U13). 키움 교육용 다중 표시 문의가 남았다(U10·U12).

### 1-4. 품질

- **테스트**(10/7 로컬, `main`의 healing을 합친 뒤): Python 1,555개(engine 733 + backend 822, SQLite 메모리 DB)·backtest 12개·ruff·`makemigrations --check`, 프론트 vitest 561개(27파일)·eslint·tsc·build가 통과한다. (10/6의 1,629개·603개와 다른 것은 단타 삭제 `fae25fe`에서 테스트 212개를 지우고, 그 뒤 계약·Registry·healing 테스트가 더해졌기 때문이다.)
- **CI**(`d3325f2`, Deploy 실행 37316655698 성공): ruff → 실주문 코드 검사 → pytest → backtest → `makemigrations --check` → PostgreSQL 16 backend 875개 · eslint → tsc → vitest → build · 이미지 3개 → compose → `smoke_test.sh`(엔진 PDF 포함).
- **안전 검사**: CI가 실주문 문자열과 `orders.py`를 막고(`.github/workflows/ci.yml:55-66`), 루트 `conftest.py`가 증권사·Discord 키를 비운다.

### 1-5. 데이터·시세

- **시세**: 로컬은 토스 조회(`BROKER=toss`, `DJANGO_DEBUG=on`일 때만 — `engine/paper_engine/config.py:154-165`), 운영은 키움 REST 조회 TR만(`docs/KIWOOM.md` 4장, 실측 0건).
- **공유 개발 DB**: 호스트 PC의 PostgreSQL 16 컨테이너(포트 5434), 마이그레이션 모두 적용, 계정 6개(팀 5 + 관리자 1). 체결 3건·지정가 취소 1건(10/2), 분석 1건, 추천 1건(demo)·계획 0건, 리포트 3건(`requested`).
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

근거: `deploy/docker-compose.yml:1-12`, `backend/trading/management/commands/run_engine.py:53-67`, `docs/DECISIONS.md` 8-2·8-4·11장. Redis를 여는 곳은 엔진 CLI(`engine/paper_engine/__main__.py:135-136·586-588·1064`)뿐이다(`backend`에는 redis 참조가 없다 — 코드 검색).

### 2-2. 구성

| 층 | 기술 | 버전 | 비고 |
|---|---|---|---|
| 언어·도구 | Python, uv 작업 공간(engine·backend), pytest·pytest-django·ruff | 3.12, uv 0.8(이미지), 9.1.1·4.14.0·0.16.10 | 잠금 패키지 29개(작업 공간 3개 포함). ruff E·F·W, line-length 120(E501은 끔) |
| 엔진 | `engine/paper_engine` | 의존성 0 | 표준 라이브러리만. Redis RESP2·LLM HTTP·PDF(Chrome headless)를 직접 구현 |
| 백엔드 | Django·DRF·drf-spectacular·psycopg[binary]·gunicorn·PyYAML | 5.2.17·3.18.1·0.30.0·3.3.6·26.2.0·6.0.3 | 앱 7개, 세션 인증 + CSRF, OpenAPI `/api/schema/` |
| DB | SQLite / PostgreSQL | 16 | `POSTGRES_HOST`로 고른다. PostgreSQL 전용 기능 금지 |
| 캐시·실시간 | LocMemCache, TanStack Query 폴링, 리포트만 SSE | – | WebSocket 없음. 폴링 간격은 `frontend/src/api/queries.ts:39-51` |
| 프론트 | React·react-router·TanStack Query·Tailwind CSS·lightweight-charts·react-markdown·Pretendard | 19.3.0·8.4.0·5.104.0·4.3.3·5.2.1·10.1.0·1.3.9 | Vite SPA. 타입은 `docs/API.md`를 보고 손으로 쓴다 |
| 프론트 도구 | TypeScript·Vite·Vitest·jsdom·Testing Library·MSW·ESLint | 6.0.3·8.3.2·4.1.11·29.1.1·16.3.3·2.15.0·10.11.0 | Node 22(CI). `VITE_MOCK=1`이면 브라우저 안 가짜 API |
| 컨테이너 | nginx-unprivileged·python:3.12-slim-bookworm·node:22-alpine(빌드)·postgres·redis·Chromium | nginx 1.27·python 3.12·uv 0.8은 메이저.마이너, node 22·postgres 16·redis 7은 메이저 태그 | 다이제스트 고정 없음. read_only, cap_drop ALL, uid 10001. Chromium은 engine 이미지에만 |
| CI/CD·서버 | GitHub Actions·GHCR·SSH 배포·되돌리기. 운영은 AWS EC2 Ubuntu `t3.medium`(메모리 4GB: Chrome PDF·PostgreSQL·엔진을 한 서버에서)·디스크 30GB 이상(계획) | Actions 실행기 ubuntu-24.04, EC2 Ubuntu 26.04 LTS | `DEPLOY_ENABLED=true`, EC2 연결됨(2026-10-06 첫 배포 성공, 보안 그룹 80은 남음 — `docs/DEPLOY.md` 0장) |
| AI | DevPass LLM Gateway(OpenAI 호환, 웹 검색 도구) | – | 분석 모델은 `.env`, 리포트 Worker 모델은 `worker_definitions.yaml`(지금 null) |
| 외부 데이터 | 키움 REST(운영)·토스(로컬)·DART·data.go.kr·SEC EDGAR·Google 뉴스 RSS | – | 조회만. 계좌·주문 TR 없음 |

근거: `uv.lock`, `frontend/package-lock.json`, `deploy/Dockerfile`·`deploy/nginx/Dockerfile`·`deploy/docker-compose.yml`, `pyproject.toml:30-37`, `.github/workflows/ci.yml:22`.

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

git에서 빼는 것은 `.gitignore:1-31`에 있다(원본 복사본 `personal_project_files/` — 보지도 고치지도 않는다, `data/`·`runs/`·`reports/`·`.cache/`, `.env`·`.env.docker`, 계정 파일). `.env.example`은 커밋한다. `frontend/.env.local`은 무시되지 않으니 커밋하지 않게 조심한다(`.gitignore`에 더하는 것은 제안). 실행 데이터는 `PAPER_ROOT` 아래에 둔다.

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

macOS·Linux·WSL2에서만 돈다. 공유 개발 DB는 `.env`에 `POSTGRES_HOST=<호스트 IP>`·`POSTGRES_PORT=5434`·`POSTGRES_PASSWORD`·`DJANGO_SECRET_KEY`를 넣어 붙는다(`docs/plans/TEAM_DEV_PLAN.md` 12장). 그때 `dev.sh`는 엔진 루프를 띄우지 않는다 — **엔진 루프는 호스트 PC 하나만** 돈다.
모델을 바꾸면 팀에 알리고 손으로 migrate한 뒤 바로 push한다(같은 절). 포트가 차 있으면 다음 빈 포트를 쓴다.

### 2-5. 설정·비밀 값

- **로컬**: 루트 `.env`. 키 이름·기본값은 `.env.example`, 설명은 `docs/DECISIONS.md` 2장·12-5·14-8. 프론트는 `frontend/.env.local`의 `VITE_API_TARGET`·`VITE_MOCK`.
- **운영**: 서버의 `deploy/.env.docker`와 GitHub 변수·비밀 값 — `docs/DEPLOY.md` 4~5장(팀장).
- **AI 모델·한도**: 분석은 `.env`의 `ANALYSTS`·`RESEARCHERS`·`APPROVER`·`REQUIRED_MODELS`, 장기투자 뉴스는 `DAILY_MOVE_MODEL`(없으면 `APPROVER`). 한도는 `AI_DAILY_BUDGET_USD`(팀 하루 $10)·`AI_DAILY_ANALYSES_PER_USER`(5)·`AI_DAILY_REPORTS_PER_USER`(3).
- 키·토큰은 `.env`에만 두고 문서·로그·커밋에 남기지 않는다. 설정 키를 바꾸면 `ci.yml`·`deploy/.env.docker.example`도 고친다.

### 2-6. 꼭 지킬 규칙 (원본: `AGENTS.md` 안전 규칙·DB, `docs/tasks/00-공통.md`, `docs/DECISIONS.md` 15장, `docs/API.md` 공통 규칙)

1. **실주문 코드 0건.** 키움은 조회 TR만. `orders.py`·`create_order`·`LIVE_TRADING`·`--live`·`--bypass`는 코드에 나오면 안 된다(CI가 막는다). `tossinvest`는 `engine/paper_engine/data/toss.py` 한 곳에만.
2. **토스 조회는 로컬 개발 전용**(토큰 발급 말고 GET만), 운영은 키움만. 원본 `toss_trading`에 영향을 주지 않는다 — Redis 키는 `paper:`만, 토스 client는 따로(U19).
3. **AI는 제안만 한다.** 수량·한도·활성화는 리스크 엔진, 주문·체결은 `trading.service`와 모의 체결기. 최소 손익비(스윙 1.5)는 프롬프트에 넣지 않는다. 손절가는 AI가 아니라 코드가 정한다 (`judge/stops.py`).
   예외: 시연용 수동 시작(사용자가 '수동매매 (시연용)'을 누르고 확인한 계획만)은 손익비·기대값 점검만 건너뛴다 (2026-10-12 — `docs/DECISIONS.md` 31장).
4. **엔진은 표준 라이브러리만**, 외부 패키지는 `backend/`에만. 키움 응답 → 내부(토스) 형식 변환은 `data/kiwoom.py` 안에서만.
5. **DB**: 같은 모델·마이그레이션을 SQLite·PostgreSQL에 쓴다(PostgreSQL 전용 기능 금지).
6. **계약을 먼저 고친다**: 웹 API는 `docs/API.md`, 워크플로우 약속은 `00-공통.md`. State·Trace는 `backend/reports/orchestration/state.py` 함수로만. "Claude" 파일(`00-공통.md` 2절)은 팀원이 고치지 않고 팀장에게 알린다.
7. **화면**: 색은 `frontend/src/index.css` 토큰만(`colors.test.ts`가 검사), 금지 표현은 `engine/paper_engine/wording.py` 하나, 면책 문장은 하나, 주문·체결 쉬운 문장에는 "모의", 주어는 "AI 의견"·"안전장치".
8. **테스트는 실제 증권사·AI·Discord를 부르지 않는다.** 팀 코드는 브랜치 `feat/<담당>-<주제>` → PR(설명에 "03 T3-5"처럼 문서 항목) → CI 초록 + 다른 담당 1명 확인 → 합친다(급하면 1). 매일 아침 `main`을 자기 브랜치에 합친다(`00-공통.md` 12절). `main` 직접 push는 문서·작은 고침만(`docs/tasks/01-인프라.md:112`).

### 2-7. 문서 지도

| 문서 | 무엇 |
|---|---|
| `AGENTS.md` · `docs/guides/SETUP_PROMPT.md` | 작업 규칙·실행 명령의 원본 · 클론 직후 설치 절차 |
| `docs/plans/TEAM_DEV_PLAN.md` | 워크플로우·AutoHealing 설계(4~5장), 장애 시험(8장), 산출물(9장), 역할(11장), 개발 환경(12장). 3장은 10/2 기준 |
| `docs/결정필요사항.md` | 남은 결정·확인(U1~U24)과 다음 세션 시작점 |
| `docs/DECISIONS.md` · `docs/API.md` | 공통 결정 1~18장 · 웹 API 계약(AI 리포트 469줄~, 추천·자동매매 663줄~, 장기투자 917줄~) |
| `docs/tasks/00~06` | 00 공통 약속(파일 소유·서명·Trace·출력 계약·사유 코드), 01~05 담당별 할 일, 06 추천·자동매매 |
| `docs/design/DESIGN.md` · `docs/KIWOOM.md` · `docs/DEPLOY.md` | 엔진 설계 · 키움 TR · CI/CD·서버 준비 |
| `docs/plans/컨셉변경계획.md` · `docs/plans/투자서비스확장계획.md` · `docs/design/화면배치.md` | 컨셉·계약 변경 B(8장)·사용성 시험(12장) · 장기·스윙 확장(단타·선물은 폐기) · 화면 배치 |
| `docs/evaluation/프로젝트평가기준.md` · `docs/records/개장시험_2026-10-06.md` · `docs/교육용문서.md` · `docs/research/` | 평가 가이드 · 정규장 실측 S0~S19 · 리포트 화면의 교육 자료 · 약관·시세·장기투자 조사 |

---

## 3. 남은 작업

담당: 1 팀장·통합 · 2 Worker · 3 Orchestrator · 4 AutoHealing · 5 프론트(`docs/plans/TEAM_DEV_PLAN.md` 11장) · Claude = Claude가 만든 파일(팀장이 요청할 때) · 전원.
번호: U = `docs/결정필요사항.md` · B = 계약 변경(`docs/plans/컨셉변경계획.md` 8장) · T = `docs/tasks/` 작업 · D·E = `docs/DECISIONS.md` 13장 · DR = 장애 시험(`docs/plans/TEAM_DEV_PLAN.md` 8장) · S = 개장 시험 · Q = 3-1 설계 쟁점 · P0·P1 = 우선순위.

### 3-0. 일정

| 날짜 | 할 일 | 근거 |
|---|---|---|
| 10/6(화)~10/7(수) | 워크플로우 구현 — 뼈대 PR 5개부터(원래 10/5 오전). 10/7은 새 화면 작업 없이 실제 Agent 통합, 저녁 복도 시험 | `docs/tasks/00-공통.md` 13절, `05-프론트.md:140` |
| 10/8(목) | 실제 Trace로 화면 맞추기, 1의 발표 시나리오 데이터(T1-26, P0)와 정규장 체결 장면 촬영, **15:00 화면 동결** — 그 배포본이 10/9 시험의 최종본 | `docs/plans/컨셉변경계획.md:294,301`, `01-인프라.md:65` |
| 10/9(금, 한글날) | 오전 장애 주입 시험, 오후 사용성 시험(리포트 실행기가 1건씩이라 시간대를 나눈다) | `docs/plans/컨셉변경계획.md:302` |
| 10/10~10/11 | 문구만 고친다. 산출물 3종(① 3·2, ② 4, ③ 1), 시연 영상·발표 자료(5) | 같은 문서 :303, `docs/plans/TEAM_DEV_PLAN.md` 9장 |
| 10/12(월) | 리허설(20분), 필요하면 체결 장면 다시 찍기 | 같은 문서 :304 |
| 10/13(화) 15:00 | 발표(팀당 20분) | `docs/evaluation/프로젝트평가기준.md:22,26` |

남은 정규장은 10/6 오후·10/7·10/8·10/12다. 늦어지면 UI·UX 추가 항목 → Handoff(T3-7) → 자동 리포트 화면 설정 순으로 줄인다. 신청 → 리포트 흐름, 대체 모델 복구와 그 시각화, 배포, 장애 시험 결과표, 주린이모드·쉬운 보기·계획 카드 상태와 실행 불가 사유·실제 금액·체크리스트·용어 바꾸기는 줄이지 않는다(`docs/plans/TEAM_DEV_PLAN.md:72`, `docs/plans/컨셉변경계획.md:307`).

### 3-1. 핵심 AI Agent 워크플로우 (담당 2·3·4, 자동 리포트는 1)

앞(신청·Registry·State·Trace·SSE·화면)과 뒤(추천 수집·끝 알림 `reports/output/alerts.py`·PDF·한도)는 이어져 있고 가운데(Agent 실행)만 비어 있다. `completed` 리포트의 `report_agent.verdict`가 `"buy"`이고 `0 < stop < entry < target`이면 엔진 루프가 추천을 만든다(`backend/autotrade/recommend/sources.py:134-158`).
약속의 원본은 `docs/tasks/00-공통.md`(파일 소유 2절·Trace 9절·출력 계약 10절)와 `docs/API.md` "AI 리포트" 절이다. 바꾸려면 문서를 먼저 고친다. PR 규칙은 2-6 규칙 8.
**개발 환경**: 팀원 PC에는 증권사 조회 키가 없다고 보고 만든다(토스는 개발자 로컬 전용·client당 토큰 1개, 팀원용 키움 키는 대기 — `docs/plans/TEAM_DEV_PLAN.md:614`, U9). 그래서 신청 API는 503(`backend/reports/views.py:62`), market_agent는 `WorkerError`다. 각자 SQLite에서 가짜 조회 클라이언트·`fake_llm`·`fake_worker`로 만들고, 실제 자료·모델 통합(T2-10·T3-10·T4-10)은 호스트 PC에서 1과 같이 한다.

**먼저 정할 설계 쟁점** — 정하면 `00-공통.md`·`API.md`에 적는다(목록은 U21).

| # | 쟁점 | 지금 | 정할 사람 · 막는 작업 |
|---|---|---|---|
| Q1 | timeout 규칙 (**2026-10-07 정함**: 같은 모델 1회 → 대체 모델 하나, 호출 한 번 최대 4회 — 00-공통 7절. **2026-10-08 바뀜**: 주 모델 timeout은 같은 모델을 다시 기다리지 않고 바로 대체 모델, 대체 모델 timeout은 같은 모델로 한 번 더) | `00-공통.md` 7절·T4-4는 "다음 모델로", `docs/plans/TEAM_DEV_PLAN.md` 5-1·DR-LLM-01·예시 재생 ③은 "같은 모델 1회 → 대체 모델"이다. 하나로 정하고 다른 쪽을 고친다 | 4(5와) · T4-4 전 |
| Q2 | 제한 시간 | 호출 제한 90초(`engine/paper_engine/llm.py:10`)가 단계 `timeout` 60초(`team_definitions.yaml`)보다 길어 시간 초과 뒤 대체 모델로 넘어갈 시간이 없다(추측). 검토 재작성·Handoff에는 제한 시간이 없다. 버린 Worker 스레드가 `finish` 뒤에 기록하면 `StateError`다(`03-orchestrator.md` 주의) | 4·3 · T4-4·T3-5 전 |
| Q3 | 필수 Worker 시간 초과의 사유 코드 (**2026-10-07 정함**: 단계 제한 시간 초과면 `timeout`, 00-공통 9절) | `join_blocked`인지 `timeout`인지(9절 표) | 3 · T3-5 |
| Q4 | 검토 단계 입력 | 문서는 "Join Guard가 초안·조사 결과를 검토에 넘긴다", YAML `review`에는 join이 없다 | 3 · T3-5 전 |
| Q5 | runner를 켜는 시점 (**2026-10-07 정함**: 24시간 넘게 기다린 `requested`는 실행하지 않고 실패 사유 `expired`로 끝낸다 — DECISIONS 19장) | 묵은 `requested` 3건이 켜는 순간 실제 비용으로 돌고 끝 알림이 간다(같은 사람·종목 신청에는 이 행이 200으로 온다). 처리(끝내기·나이 제한·실행)를 정한다. 통합 전에는 별도 설정 키로 `runner.tick`을 막는다(제안 — `AGENTS_IMPLEMENTED`는 화면 SSE 깃발, `registry.py:17-18`) | 3·1 · ⑤ 전(오늘) |
| Q6 | 시험 수단 | `errorTypes` 셋으로는 DR-CRT-01·02·DR-SEC-01을 못 만든다. Circuit Breaker(모델별·프로세스 전역 5분, T4-5)가 시나리오끼리 간섭한다 → 사이에 5분 대기나 재시작(제안). 리포트 한도 3건 → 시험 한도를 올리거나 계정을 나눈다(제안) | 4·1 · T4-6·T4-10 전 |
| Q7 | 장애 분류·셈법 | `LlmError`에 상태 코드가 없어 server_error·bad_output을 나누기 어렵다 → 구조화된 오류(제안). LLM 실패 없는 실패(Worker 오류·단계 시간 초과)를 장애로 셀지 정한다 | 4 · T4-2·T4-7 전 |
| Q8 | 그 밖 | `attempt`의 두 뜻, `chaos.parse` 인자, 권유 표현을 계약 검증에 넣을지(넣으면 재요청 = 장애 1건), 0002 새 열의 `db_default`(제안 — 옛 코드가 도는 공유 DB 대비, 본보기 `trading/migrations/0002_order_style.py`), 산출물 위치(`docs/deliverables/` 대 `docs/설계서.md`·`장애복구보고서.md`·`파이프라인보고서.md`) — 산출물 위치는 2026-10-09 `docs/deliverables/`(`01_`·`02_`·`03_` 번호 파일)로 정함 | 2·3·4·1 · 0002 전, 산출물은 10/8 전 |

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

**순서**(`00-공통.md` 13절): ① 3 registry 스키마 → ② 4 0002·payloads → ③ 2 contracts·`agents/base` → ④ 4 healing 서명·fake_llm → ⑤ 3 `run_report` 정상 경로·runner(완료 기준 `run_engine --once`로 requested → completed, `03-orchestrator.md:61`. 공유 DB에 붙이기 전에 Q5).
YAML 모델 값은 ① 뒤, budget·`add_cost`·chaos 저장·B9는 ② 뒤, `AGENTS_IMPLEMENTED = True`는 T3-5 뒤, 실제 통합은 2의 Worker와 4의 호출기 뒤, DR 시험은 통합 뒤다.
**체크포인트(제안 — 뼈대가 하루 늦어 02~04의 일정을 하루씩 민다)**: 10/6 ①~⑤ 합치기 → 10/7 오전 T3-5·T3-6·T4-4~T4-6·Worker 6개 → 10/7 오후 호스트 PC에서 실제 통합 → 10/8 오전 T3-7~T3-9·T4-7·T4-10 설정표, 15:00 전 실제 Trace로 화면 확인 → 10/8~10/11 산출물.

**완료 기준**

- [ ] 실제 리포트 1건이 몇 분 안에 나오고 노드가 대기 → 실행 중 → 완료로 바뀐다(SSE). 검토 결과로 경로가 갈리고 RETRY는 상한을 넘지 않는다. Trace만 보고 끝난 이유를 설명할 수 있다(`docs/plans/TEAM_DEV_PLAN.md:194-198`). 끝나고 5초 안에 `/recommendations`에 추천이 뜬다(`docs/tasks/02-worker.md:38`).
- [ ] 장애 주입을 켜도 끝까지 나오고, 어느 모델이 실패하고 어느 모델이 대신 답했는지 보인다. 같은 seed는 같은 판정이다. 선택 Worker가 전부 실패하면 건너뛰고, 필수면 실패로 끝내고 사유를 화면·알림에 낸다(`docs/plans/TEAM_DEV_PLAN.md:256-272`).
- [ ] `/ops`가 실측을 그린다. 자동 복구율은 시나리오 / 호출 장애 두 이름으로 나눠 적는다.
- [ ] 가짜 LLM 테스트: 정상·선택 실패·Join 차단·RETRY 뒤 PASS·RETRY 한도·Handoff 거절·재시도·대체 모델. `uv run pytest backend/reports -q`가 1분 안(지금 139개), CI 초록(`00-공통.md:289-294`).
- [ ] 산출물: 설계서 ①(3·2), 보고서 ②(4), 보고서 ③(1). 실제 구조와 시험 결과만 쓴다(`docs/evaluation/프로젝트평가기준.md:69`).

**주의**

- 0002에서 user를 null로 열면 `payloads.summary`의 `get_username()`이 깨진다(`payloads.py:62`). user가 없는 리포트의 끝 알림은 활성 사용자 전체에게 간다(코드로 확인: `alerts.py:92,99` → `backend/notifications/service.py:161-162`. 건너뛰는 것은 `source == "auto"`뿐 — `alerts.py:67`).
- 비용: 리포트는 동시에 1건, 하루 예산 $10을 분석·리포트·대체 모델·자동 리포트가 같이 쓴다. 한 리포트는 최대 Worker 실행 10번·LLM 시도 40번이다(Worker 실행마다 LLM 호출 한 번 × 최대 4회 시도로 본 계산). 실제 호출은 T2-10·T3-10·T4-10에서만 한다.
- 루트 `conftest.py`는 `DEVPASS_APIKEY`·`DART_API_KEY`를 비우지 않는다 → 팀 테스트는 가짜 `engine_config`와 `fake_llm`을 꼭 끼운다. 스레드가 DB를 쓰는 테스트에는 `django_db(transaction=True)`가 필요할 것이다(추측). 새 이름에 CI 금지 문자열을 쓰지 않는다.

### 3-2. 프론트엔드 개선 (담당 5)

새 화면은 거의 없고 **실제 데이터로 맞추기**가 남았다. 5는 Claude의 "합쳤다" 알림 뒤 그 위에서 다듬는다(`00-공통.md` 2절).
규칙: 색은 토큰만, 라이트·다크 × 390·1280 확인, 공용 부품은 `ui.tsx`·`components/motion/`, 배치를 바꾸면 `docs/design/화면배치.md`도 고친다, 상태를 색만으로 구분하지 않는다(`docs/DECISIONS.md` 15-3·15-6).
다른 담당의 화면 몫(`docs/plans/TEAM_DEV_PLAN.md` 11장 ②): 1 발표 흐름 점검, 2 리포트 문장 품질, 3 진행 단계 표시가 실제 Trace와 맞는지, 4 자동 복구 문장·지표 화면.

| 할 일 | 담당 | 언제 | 근거 |
|---|---|---|---|
| 실제 Trace·`recovery`로 T5-3~T5-6 확인, 신뢰 패널 둘째 줄을 T4-11과 맞추기, 같은 리포트의 `/ops`·RunSummary 수치 대조(`recovery.ts`와 `stats.py`가 같은 셈법) | 5, 4 | 10/7 확인, 10/8 오전 수정 | `docs/tasks/05-프론트.md:103-106,122,147` |
| T5-10 본문 꾸미기(판정·한 줄 결론을 머리로, 근거·리스크 목록, 리스크 경고 블록 — 2의 `markdown` 형식을 보고). PDF는 실제 결과로 눈 확인, 0002 뒤 `pdf_path` 열로 | 5 | 10/8 | 같은 문서 :49-50,111 |
| T5-19 교차검증 분석 배치 확정, T5-22 홈·종목 상세·모의투자 다듬기 | 5 | 10/8 15:00 전 | 같은 문서 :120,123 |
| 실기기(iOS Safari·Android Chrome): 시트, 숫자 키패드, 토스트·연결 띠(safe-area), 차트 핀치, 홈 화면 아이콘 | 5 | 동결 전 | `docs/결정필요사항.md:124` |
| 발표 화면 약 8분(쉬운 보기 2:30 → `?view=expert` 4:00 → 파이프라인 1:30), 프로젝터는 "밝게", 가짜 API 화면이면 표시 | 5 | 10/12 리허설 | `docs/plans/컨셉변경계획.md:320-326` |

팀장 할 일: 5에게 "합쳤다" 알리기와 팀에 이름 변경 공지(U18·U3). 상승·하락 글자(3.71:1)와 색 바탕 흰 글자 버튼(3.2~3.7:1)이 WCAG AA 4.5:1에 못 미치는데, 브랜드 색으로 고칠지 정한다(`docs/DECISIONS.md:813`).

### 3-3. 기능 개선

다른 담당의 논의 몫(`docs/plans/TEAM_DEV_PLAN.md` 11장 ③): 2 뉴스 출처 대안·장기투자 AI 문장, ~~3 단타 AI 팀(`day_plan`·`day_review`) 설계~~(단타 폐기, 2026-10-06), 4 키움 실시간 도입 조건, 5 화면 개선 아이디어.

**발표 전** — 화면을 크게 바꾸지 않는 작은 일만, 10/8 15:00 전에.

| 할 일 | 담당 | 근거 |
|---|---|---|
| U16①: 가격 입력 상한(예: 직전 종가의 몇 배)을 trading `views._number`에 둔다. `docs/API.md`를 먼저 고친다(U16 결정 뒤 — 제안. daytrade `_price`는 단타 폐기로 없어졌다) | Claude | `backend/trading/views.py:41` |
| U16④: `DAILY_MOVE_MODEL`에 싼 모델 지정(U16 결정 뒤 — 제안) | 1 | `docs/결정필요사항.md:48` |
| 예약 결과 알림: 예약이 실행되지 않거나 지워져도 엔진 콘솔에만 남는다. `docs/API.md`부터(우선순위 낮음) | Claude | `docs/plans/TEAM_DEV_PLAN.md:438`, `backend/trading/service.py:526-558` |
| 목표·손절 수정 화면(`PATCH /api/orders/{id}`는 있다). 여유 있을 때만 — 줄일 때 가장 먼저 뺀다 | 5 | `docs/plans/TEAM_DEV_PLAN.md:437`, `docs/API.md:426` |

**발표 뒤** — 그때까지는 알려진 한계로 적는다.

- ETF 거래세 면제(엔진이 모든 국내 매도에 0.20% — `docs/결정필요사항.md:99`), 키움 실시간(4, 키 필요 — 단타 (b)용이었고 단타 폐기와 함께 필요 없어졌다), 뉴스 출처 공시·수치 중심(2).
- 직접 주문의 체결 알림(1-2), 지난 AI 리포트 성적(컨셉 P1), 진단 문항·점수표 조정(E-2 — 10/9 뒤 "문구만" 규칙과 부딪힌다).
- `docs/plans/TEAM_DEV_PLAN.md` 10-3 "시간이 남으면"(관심 종목, 홈 시장 요약, PWA, 서버 푸시 등). CSP를 넣으면 테마 인라인 스크립트의 sha256을 허용한다(`docs/DECISIONS.md:799`).
- 범위 밖으로 정한 것: 모의 계좌 되돌리기, 성향으로 수량 배수(D-6), 선물(폐기), Discord 활성화 버튼(링크로 대신), 분할·추가 매수.

### 3-4. 테스트 후 완성도 다듬기

| 시험 | 언제 | 담당 | 무엇 | 기록 위치 |
|---|---|---|---|---|
| 정규장 실측 U8·U15(S0~S19) | 10/6 오후(15:30 전 준비 시 S14~S17 — 단타 시나리오 S6·S7·S11~S13·S18은 삭제로 시험하지 않음), 10/7·10/8, 예비 10/12 (제안 — 팀장 결정) | 1 | 예약 실행·체결·재주문, 15:40 기준 전환, 16:30 뉴스, 18:00 점검, 웹에서 분석 1건(제안). 준비는 아래 | `docs/records/개장시험_2026-10-06.md` 4절 표 → `06-추천·자동매매.md` "확인한 것" |
| 복도 시험 | 10/7 저녁 | 5 진행, 1 준비 | 팀 밖 1~2명, 과제 ②만 | `docs/개선이력.md` |
| 장애 주입 시험(DR 14개) | 10/9 오전 | 4(LLM·CRT·SEC, 결과 모음), 1(DB·PROC·NOTI·NET·CI) | 시나리오마다 ID·주입 장애·기대·실제·복구 시간·수동 개입·판정·증빙. 실패와 고친 것도 | 보고서 ② 결과표 |
| 사용성 시험 | 10/9 오후 | 5 진행, 1 준비 | 팀 밖 5명, 과제 넷(리포트 만들기 · 손절 손실 말하기 · 자동매매 시작 · "사라는 말인가요?"), 과제당 5분, 성공 기준은 미리(`docs/plans/컨셉변경계획.md` 12장) | 참가자 P1~P5 원표, `docs/개선이력.md` |
| 동결 전 회귀 | 10/8 15:00 전 | 전원 | 2-4의 검사 + 아래 수동 확인 | CI 실행 기록 |

**정규장 실측 준비**: `scripts/dev.sh`로 다시 띄우고 시험 계정을 만든다. 호스트 PC는 전원에 꽂고 덮개를 열어 둔다(배터리로 덮개를 닫으면 `caffeinate`가 있어도 잠든다 — `pmset -g log` 10/6 09:48). 접속 IP가 바뀌지 않는 네트워크에서 한다(제안). S9가 기대하는 "체결 알림"은 직접 주문에 없다(1-2) → 기대 결과를 고친다.

**점검 기준**

- **표현**: 규칙은 2-6 규칙 7, 금지 표현 원본은 `engine/paper_engine/wording.py`(권유 17·인과 5·예측 7). 화면 고정 문구는 검사 대상이 아니고 프론트 테스트 6개는 목록 일부만 복사한다 → 프론트 전체 문자열을 이 목록으로 훑는 테스트 하나(제안). 장중 가격·배 은어 금지, 연습용은 "(AI 아님)"(`docs/API.md:60-90`). 발표 영상(유튜브)의 모든 화면·알림이 대상이다.
- **수치**: 시험한 값만 쓴다. 사용성은 "n/5"와 원표(백분율·평균 금지), 자동 복구율은 두 이름, 평균 복구시간은 첫 `agent_failed`부터 그 Worker의 `agent_completed`까지. "예시" 수치(`/ops`·예시 Trace·선별)는 캡처에 쓰지 않는다.
- **동결 직전 수동 확인**: 발표 흐름 한 번(3-2), 라이트·다크 × 390·1280, 시험·발표 계정 주린이모드 켬·"밝게", 완성 리포트 3건 이상("보통 ○분" 문장의 조건, `frontend/src/lib/reports.ts:669-683`), "예시"·"가짜 API" 표시.
- **제출 전**: `docs/evaluation/프로젝트평가기준.md` 6장 체크리스트(증빙, 지표 기준, 실패 사례·수동 개입, 배포 차단, 실행 ID·커밋, 문서·구현·시험 일치, 비밀 값 없음, 배포 환경 시연).

**제보와 심각도** — 정해진 것은 "500이면 `backend.log` 오류 줄을 붙여 1에게, 화면 문구·흐름은 5에게, 찾은 문제와 고친 것은 `docs/개선이력.md`에"뿐이다(`docs/records/개장시험_2026-10-06.md:116,122`, `docs/plans/TEAM_DEV_PLAN.md:390`).
제안: 1이 오늘 `docs/개선이력.md`에 표 머리(날짜·제보자·화면/API·재현 단계·기대·실제·증빙·등급·담당·상태)를 만든다. 받는 사람은 500·데이터 1, 화면 5, 워크플로우 2·3·4. 등급도 제안이다.

| 등급 | 예 | 처리 |
|---|---|---|
| 치명 | 안전 규칙 위반, 돈 숫자 틀림, 500, 과제를 진행할 수 없음 | 바로 고친다. 동결 뒤에도 예외로 허용 |
| 높음 | 사용성 과제 실패의 원인, DR FAIL, 시연 화면 깨짐 | 10/8 15:00 전에. 그 뒤면 문구로 우회 |
| 중간·낮음 | 그 밖 | 10/10~11에 문구로, 아니면 3-3 "발표 뒤"로 |

**문서·점검표 정리**: 화면 문구 점검표(5 — 성공 기준에 있는데 파일이 없다, `docs/plans/컨셉변경계획.md:339`). 문서 불일치(1·Claude): PDF 양식 판(`docs/API.md:667`·`docs/DECISIONS.md:754`는 2, 코드는 3), `backend/config/settings.py:129` 주석, `engine/paper_engine/__main__.py:25` 알림 순서, `README.md` 소개, `docs/plans/TEAM_DEV_PLAN.md` 3장 "시세 1초 폴링", `docs/records/개장시험_2026-10-06.md:12`의 토스 client 공유(U19).

**막힌 것·정할 것**

- **U19 토스 client(1, 제안)**: 개발용 토스 client를 따로 받는다. 그 전까지는 실측·시험 시간 밖에 `run_engine`을 내린다. 키움 키를 받는 즉시 `BROKER`를 키움으로 바꾼다.
- **시험 환경(U13, 팀장)**: 호스트 PC·토스 조회로 팀 밖 사람에게 열면 약관에 걸린다. 가짜 API는 공휴일을 모르고 계획이 6초마다 진행해 과제 ③의 기준이 달라진다(`frontend/src/mocks/clock.ts:1`).
- **시험 계정**: `시험1~3`으로 5명을 받으면 앞 사람의 리포트·계획이 남고, 같은 종목 계획은 `plan_exists`로 막히고, 리포트 한도 3건을 같이 쓴다 → 시험자 사이에 정리하거나 계정을 5개로(제안). 완성 리포트가 늦으면 가짜 API 예시로 대신할지 10/7 저녁에 정한다(제안).
- **증빙 빈칸**: DR-API-01·02는 담당도 주입 수단도 없다(가이드의 예시가 DR-API-01이다). 가이드 7단계의 "정상 요청" 줄도 8장 표에 없다. DR-LLM-04·DR-NOTI-01·DR-CI-01은 Discord 알림이 증빙인데 실채널이 보류(U7)다 → 실채널을 열지, 웹 알림으로 판정할지 정한다.
- **10/6 사례**: 토스 403은 엔진을 다시 띄우지 않았는데 10:48 뒤로 멈췄다. 원인(공인 IP 변경·네트워크 이동 — 추측)과 사람의 개입 여부는 확인이 필요하다. 보고서 ②에 쓰려면 그날 네트워크를 바꿨는지부터 확인한다. 호스트 PC 절전으로 엔진 루프가 멈춘 일(09:48~12:34)은 "사람이 조치해야 하는 운영 위험"으로 적을 수 있다(제안).
