# 팀 개발 계획 (팀원 전달용)

작성 2026-10-02. 지금까지 만들어진 것, 개발 환경에 붙는 방법(화면·DB), 그리고 **팀이 이어서 개발할 일**을 정리한다.
전체 배경은 `docs/TEAM_PAPER_TRADING_PLAN.md`, API 계약은 `docs/API.md`, 결정 사항은 `docs/DECISIONS.md`, 규칙과 명령은 `AGENTS.md`.

## 목차

1. 지금 되어 있는 것
2. 개발 환경: 화면과 DB에 접속하기
3. 개발할 일 ①: 리포트 생성 AI Agent 워크플로우
4. 개발할 일 ②: UI·UX 개선과 추가
5. 그 밖에 남은 일
6. 같이 지킬 규칙

---

## 1. 지금 되어 있는 것

| 영역 | 상태 |
|---|---|
| 로그인 | 팀원 계정 5개 (아이디·비밀번호는 호스트 PC의 `team_accounts.txt`, 각자 자기 것만 전달받는다) |
| 모의 트레이딩 | 팀원별 계좌(1천만원), 시세 1초 폴링, 시장가·지정가 매수, 전량 매도, 목표·손절 자동 청산, 장 밖 주문 예약 |
| AI 분석 | 엔진의 교차검증 분석을 웹에서 요청, 결과 대시보드 (종목당 약 $0.3, 하루 한도 있음) |
| My Page · 랭킹 | 실시간 수익률·투자금액, "내 정보 공개"를 켠 사람만 랭킹에 표시 |
| **AI 리포트** | **구조만 있다.** 신청·실행 계획 그래프·Trace 타임라인·Shared State 화면과 저장·전달(API, SSE)까지. **Agent와 Orchestrator 실행은 없다 → 3장에서 팀이 만든다** |
| 인프라 | 로컬 실행 스크립트(`scripts/dev.sh`), 개발용 PostgreSQL 컨테이너. Docker 배포·CI/CD는 아직 없다 |

화면: 로그인 · 홈 · 종목 검색·상세·주문 · 내 주식 · AI 분석 상세 · AI 리포트(`/reports`) · 랭킹 · My Page.

---

## 2. 개발 환경: 화면과 DB에 접속하기

호스트 PC 한 대가 서버와 DB를 띄워 두고, 팀원은 같은 네트워크(같은 와이파이·사내망)에서 붙는다.

### 2-1. 화면

- 주소: `http://<호스트 PC의 IP>:5173` (2026-10-02 기준 `http://192.100.200.209:5173`. IP가 바뀌면 호스트 PC에서 `scripts/dev.sh status`로 확인)
- 휴대폰에서도 같은 주소로 들어간다. 로그인은 전달받은 팀 계정으로 한다.

### 2-2. DB (PostgreSQL) — 개발할 때만 같은 네트워크에 열려 있다

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
| `reports`, `report_trace_events` | AI 리포트의 Shared State와 Trace (3장에서 채운다) |

주의:

- **조회 위주로 쓴다.** 손으로 `UPDATE`·`DELETE`하면 계좌 현금과 체결 내역이 어긋난다. 데이터를 고쳐야 하면 팀에 먼저 알린다.
- 접속이 안 되면: 같은 네트워크인지, 호스트 PC가 켜져 있고 `scripts/dev.sh status`에 "컨테이너: 실행 중"인지, 호스트 PC 방화벽이 5434·5173을 막지 않는지 확인한다.
- 이 DB는 **개발용**이다. 운영(EC2)에서는 DB 포트를 밖으로 열지 않는다.

### 2-3. 자기 PC에서 개발할 때

```bash
git clone https://github.com/SHS5029/paper_trading.git && cd paper_trading
cp .env.example .env        # 키를 채운다 (팀에서 받은 값). 커밋하지 않는다
uv sync && (cd frontend && npm ci)
scripts/dev.sh              # Django + 엔진 루프 + 프론트엔드를 한 번에 띄운다. 끝나면 주소가 나온다
```

AI 코딩 에이전트(Claude Code, Codex 등)를 쓰면 클론한 폴더에서 "`SETUP_PROMPT.md`를 읽고 그대로 진행해 줘"라고 하면 된다
(도구 확인 → `.env` → 설치 → 검사 → 계정 → 서버 실행까지 안내한다). macOS·Linux·WSL2에서 돈다 (WSL이 아닌 Windows에서는 돌지 않는다).

DB는 두 가지 중에 고른다.

| 방식 | `.env` | 언제 |
|---|---|---|
| 내 PC의 SQLite (기본) | `POSTGRES_HOST=` (비움) | 혼자 기능을 만들고 테스트할 때. 계정은 `cd backend && uv run python manage.py create_team_accounts`로 만든다 |
| 호스트 PC의 공유 DB | `POSTGRES_HOST=<호스트 IP>`, `POSTGRES_PORT=5434`, `POSTGRES_PASSWORD=<받은 값>`, `DJANGO_SECRET_KEY=<아무 긴 문자열>` | 팀이 같은 데이터를 보면서 화면을 맞출 때 |

공유 DB에 붙을 때 지킬 것:

- **엔진 루프(`run_engine`)는 호스트 PC에서만 돌린다.** 두 곳에서 돌면 서로의 작업을 실패로 정리하고 체결 확인이 겹친다.
  `scripts/dev.sh`는 `POSTGRES_HOST`가 다른 PC를 가리키면 알아서 엔진 루프를 띄우지 않는다 (손으로 `manage.py run_engine`을 실행하지 않는다).
- **모델을 바꾸면 공유 DB의 구조가 바뀐다.** `scripts/dev.sh`는 공유 DB에 마이그레이션을 알아서 적용하지 않는다.
  `makemigrations` 뒤 팀에 알리고 직접 `cd backend && uv run python manage.py migrate`를 실행한 다음, 마이그레이션 파일을 바로 push한다.
- 계정은 이미 있다. 공유 DB에 붙은 PC에서 `create_team_accounts`를 실행하지 않는다 (계정이 새로 생긴다).
- 테스트(`uv run pytest`)는 공유 DB를 건드리지 않는다 (항상 SQLite 메모리 DB에서 돈다).
- 프론트엔드만 고칠 때는 백엔드 없이 `VITE_MOCK=1 npm run dev` (가짜 API)로도 된다.

### 2-4. 호스트 PC를 맡은 사람

```bash
scripts/dev.sh            # 전부 (다시) 띄운다: PostgreSQL 컨테이너 + Django + 엔진 루프 + 프론트엔드(0.0.0.0)
scripts/dev.sh status     # 접속 주소와 DB 접속 방법
scripts/dev.sh logs       # 로그   ·  stop (서버 내리기, DB는 그대로)  ·  db (DB 셸)  ·  db-stop (DB 내리기)
```

호스트 PC의 `.env`에는 `POSTGRES_HOST=127.0.0.1`, `POSTGRES_PORT=5434`, `POSTGRES_BIND=0.0.0.0`, 긴 임의 `POSTGRES_PASSWORD`가 들어 있다.
DB 데이터는 Docker 볼륨 `paper-dev_pgdata`에 있다 (컨테이너를 내려도 남는다). 예전 SQLite 파일 `backend/db.sqlite3`는 옮기기 전 사본으로 남아 있다.

---

## 3. 개발할 일 ①: 리포트 생성 AI Agent 워크플로우

**목표:** `/reports`에서 종목을 신청하면 여러 Agent가 협업해 리포트를 만들고, 그 과정(Trace)이 화면에 실시간으로 보인다.
개념과 용어는 `docs/교육용문서.md`(04 Distributed Collaboration)를 그대로 따른다. 화면의 "개념 문서" 탭에서도 볼 수 있다.

### 3-1. 이미 있는 것 (고치지 않고 그 위에 만든다)

| 있는 것 | 위치 |
|---|---|
| 실행 계획 (YAML Registry)과 계획 검증 | `backend/reports/worker_definitions.yaml`, `team_definitions.yaml`, `registry.py` |
| Shared State · Trace 저장 | `backend/reports/models.py` (`Report`, `TraceEvent`) |
| **State·Trace를 바꾸는 유일한 함수** | `backend/reports/state.py`: `start` · `set_step` · `record` · `add_result` · `add_error` · `finish` |
| 조회(Snapshot)와 실시간 전달(SSE) | `GET /api/reports/{id}`, `GET /api/reports/{id}/events` |
| 화면 | 실행 계획 그래프, Trace 타임라인, Shared State, 정책 안내, 예시 Trace 재생 |

지금의 팀 구성 (바꿔도 된다. YAML만 고치면 화면 그래프가 따라온다):

```
시세·차트 Agent (market_agent, 필수)      ─┐
재무·공시 Agent (fundamental_agent, 필수)  ─┼→ Join Guard → 리포트 작성 Agent → 검토 Agent
뉴스·심리 Agent (news_agent, 선택)        ─┘                                   └ Handoff ⇢ 리스크 점검 Agent
```

### 3-2. 만들 것

새 코드는 `backend/reports/` 안에 둔다 (예: `contracts.py`, `agents/`, `guards.py`, `orchestrator.py`, `runner.py`).

| # | 작업 | 내용 | 교육 문서의 해당 부분 |
|---|---|---|---|
| A | **출력 계약** | Worker별 결과 형식과 검증 (`MarketResult`, `FundamentalResult`, `NewsResult`, `ReportDraft`, `ReviewResult`, `RiskResult`). 검증을 통과한 결과만 `state.add_result`로 넣는다 | 역할별 출력 계약 |
| B | **Worker(Agent) 6개** | 입력 데이터를 모으고 LLM을 불러 계약에 맞는 결과를 돌려준다. **Worker는 State를 직접 바꾸지 않는다** (결과만 반환) | Parallel Workers |
| C | **Orchestrator** | 실행 계획대로 실행: 조사 3개 병렬 실행·완료 수집 → Join Guard → 리포트 작성 → 검토 → (Handoff) → 전체 종료. State와 Trace는 Orchestrator만 `state.py`로 갱신한다 | Sequential · Parallel · Shared State |
| D | **Join Guard** | 병렬이 끝났다고 바로 Join하지 않는다: 필수 결과 존재 → 계약 확인 → 실패 결과 제외 → 최소 Context 선택. 막으면 `join_blocked`, 뒤 Agent는 `skipped` | Join Guard |
| E | **부분 실패 정책** | `team_definitions.yaml`의 `failure_policy`(fail_fast · best_effort · required_optional)와 `required`·`optional`대로 계속할지 정한다. 실행 중에 LLM이 정하지 않는다 | Partial Failure |
| F | **Handoff와 Guard** | 검토 Agent → 리스크 점검 Agent로 책임 이전. 계약 필드(`task_id`, `trace_id`, `from_agent`, `to_agent`, `responsibility`, `context`, `user_id`, `hop_count`)와 Guard(사용자, 허용 경로, 민감정보, 최대 Hop) | Handoff |
| G | **실행 연결** | 웹 요청 안에서 실행하지 않는다. `run_engine` 루프에서 `requested` 리포트를 하나씩 집어 실행한다 (`analysis/jobs.py`의 `tick()`이 좋은 본보기). 끝나면 `reports/registry.py`의 `AGENTS_IMPLEMENTED = True` → 화면이 SSE를 연다 | 전체 Workflow |
| H | **Provider·Model 정하기** | `worker_definitions.yaml`의 `provider`·`model`을 채운다 (지금은 null → 화면에 "미정") | YAML Registry |
| I | **비용·한도** | 리포트 한 건의 AI 비용을 기록하고(`details`나 결과에), 팀원별·전체 하루 한도를 건다 (`analysis/quota.py` 방식) | – |
| J | **테스트** | LLM은 가짜 객체로. 정상 흐름, 선택 Worker 실패(계속), 필수 Worker 실패(Join 차단·건너뜀), 시간 초과, Handoff Guard 거절, 완료 순서가 시작 순서와 다른 경우 | – |

Worker별 입력 데이터 (이미 있는 엔진 코드를 쓴다. 새로 긁어 오지 않는다):

| Worker | 쓸 수 있는 것 |
|---|---|
| 시세·차트 | `engine/paper_engine/data/snapshot.py`의 `build_snapshot` (현재가, 일봉, 이동평균·RSI·ATR 등 지표), `backend/trading/market.py` (캐시된 시세·일봉) |
| 재무·공시 | `engine/paper_engine/data/dart.py` (`DartClient`: 재무제표, 공시 요약), `data/fina_stat.py`. `DART_API_KEY` 필요 |
| 뉴스·심리 | `engine/paper_engine/data/news.py`의 `fetch_news`, `data/broker_reports.py` (증권사 리포트) |
| 리스크 점검 | 조회 클라이언트의 `warnings(symbol)` (투자경고 등), 스냅샷의 `warnings` |
| LLM 호출 | `engine/paper_engine/llm.py`의 `LlmClient` (`complete_json(model, system, user)`, 비용은 `llm.cost`). DevPass 게이트웨이, `DEVPASS_APIKEY` |

### 3-3. Trace를 남기는 규칙 (화면이 이 규칙으로 그린다)

- 사건은 `state.record(report, actor, action, status, provider, model, latency_ms, details)`로만 남긴다.
  `actor`는 Worker id(`market_agent` 등) 또는 `join_guard` · `handoff_guard` · `orchestrator`.
- 주요 `action`: `agent_started` · `agent_completed` · `agent_failed` · `join_completed` · `join_blocked` · `workflow_completed`
  (필요하면 `workflow_started` · `workflow_failed` · `handoff_completed` · `handoff_blocked`).
  `status`는 `started` · `completed` · `failed` · `blocked` · `skipped` 다섯 가지뿐이다.
- Guard 사건의 `details`에는 대상을 넣는다: `join_guard` → `{"step": "compose"}`, `handoff_guard` → `{"to": "risk_agent"}`.
- 순서: `state.start` → (`set_step` → 사건들 → `add_result`/`add_error`) 반복 → `workflow_completed` 사건 → `state.finish`.
  **`finish` 뒤에는 Trace가 붙지 않는다.** 마지막 사건을 먼저 남기고 `finish`를 부른다.
- 실패한 결과를 빈 값이나 고정된 성공 결과로 바꾸지 않는다. 앞 Agent가 실패하면 뒤 Agent는 실행하지 않고 `skipped`로 남긴다.
- 어떤 모양이 되어야 하는지는 화면의 **예시 Trace 재생** 두 가지(정상 흐름, 필수 Worker 실패)를 보면 된다. 실제 실행도 같은 모양이 나오면 된다.

### 3-4. 작업 순서와 나누기 (제안)

```
A 출력 계약 ──┬─→ B Worker (조사 3개는 서로 독립이라 나눠서)
              ├─→ D Join Guard · E 실패 정책 (LLM 없이 테스트 가능)
              └─→ F Handoff Guard (LLM 없이 테스트 가능)
B + D + E ───→ C Orchestrator ───→ G 실행 연결 ───→ H·I·J 마무리, 화면 확인
```

| 담당 (예) | 범위 |
|---|---|
| 1 | A 출력 계약 + D Join Guard + E 실패 정책 |
| 2 | B 조사 Worker (시세·차트, 재무·공시) |
| 3 | B 뉴스·심리 Worker + 리스크 점검 Worker + F Handoff |
| 4 | B 리포트 작성·검토 Worker + C Orchestrator |
| 5 | G 실행 연결 + I 비용·한도 + 리포트 화면 보강 (4장) |

A(출력 계약)를 먼저 같이 정해야 나머지가 병렬로 갈 수 있다. D·E·F는 LLM 없이 만들고 테스트할 수 있어 먼저 끝내기 좋다.

### 3-5. 완료 기준

- 화면에서 종목을 신청하면 몇 분 안에 리포트 본문이 나오고, 그래프의 노드가 대기 → 실행 중 → 완료로 실시간으로 바뀐다.
- 선택 Worker(뉴스)가 실패해도 리포트가 나오고, 필수 Worker가 실패하면 Join이 막히고 뒤 Agent가 건너뛴 것이 Trace에 남는다.
- Trace만 보고 "왜 끝났는지"(완료·실패 사유)를 설명할 수 있다.
- `uv run pytest`가 실제 LLM·증권사 호출 없이 통과한다.
- 교육 문서의 "완료 기준" 9개 항목을 이 프로젝트의 코드로 설명할 수 있다.

---

## 4. 개발할 일 ②: UI·UX 개선과 추가

프론트엔드는 `frontend/` (React + TypeScript + Tailwind CSS, 토스증권 스타일, 모바일 우선). API를 바꿔야 하면 `docs/API.md`를 먼저 고친다.

### 4-1. 먼저 (지금 빠져 있어 불편한 것)

| 항목 | 내용 | 백엔드 |
|---|---|---|
| 목표·손절 수정 | 보유 중인 종목의 목표가·손절가·기한을 바꾸는 화면 | 있음 (`PATCH /api/orders/{id}`) |
| 예약 결과 알림 | 예약이 실행되지 않고 지워졌을 때 사유를 화면에 남긴다 (지금은 서버 로그에만) | 필요 (사유 저장) |
| 리포트 화면 보강 | 실제 실행 연결 뒤: 진행률, 노드를 누르면 그 Worker의 결과·오류 보기, 실패 시 다시 신청, 본문 꾸미기, 리포트 목록 필터 | 일부 필요 |
| 일별 자산 그래프 | 기록이 쌓이면 수익률 추이·기간 선택 (지금은 장 마감 뒤 하루 한 점) | 있음 |
| 오류·빈 화면 | 시세 조회 실패, 네트워크 끊김, 데이터 없음일 때의 안내 문구와 다시 시도 | – |

### 4-2. 다음 (쓰기 좋게)

| 항목 | 내용 | 백엔드 |
|---|---|---|
| 관심 종목 | 종목에 별표, 홈에 관심 종목 시세 | 필요 |
| 홈 구성 | 시장 요약(지수·거래대금 상위), 내 보유 종목 요약, 최근 체결 | 일부 필요 |
| 종목 상세 정보 | 지표(이동평균·RSI), 뉴스, 투자 유의 표시, 호가 | 일부 필요 |
| 체결 알림 | 목표·손절로 자동 청산됐을 때 화면 알림 (다음에 들어왔을 때 보이게) | 필요 |
| 랭킹 보강 | 기간별 수익률, 순위 변동, 보유 종목 수 | 필요 |
| 주문 편의 | 금액으로 수량 계산, 최근 주문 다시 하기, 주문 확인 단계 | – |
| 다크 모드 | Tailwind 테마 토큰이 있어 색만 추가하면 된다 | – |
| 모바일 | 홈 화면에 추가(PWA), 당겨서 새로고침, 스와이프 | – |

### 4-3. 나중 (계획서 4-4의 남은 화면)

관리 화면(계정, 중단 스위치, AI 비용, 엔진 상태), 통계(모델별 예측 성적), 시장 기록, 전략·선별 결과, 일일 리포트.
실시간 시세를 폴링에서 서버 푸시(SSE)로 바꾸는 것도 여기에 든다.

### 4-4. 화면을 고칠 때

- 디자인 토큰(색·글꼴)은 `frontend/src/index.css`, 공용 부품은 `frontend/src/components/ui.tsx`, 표시 형식은 `frontend/src/lib/format.ts`.
- 360px 폭과 PC 폭 둘 다 확인한다. 상태는 색만으로 구분하지 않는다 (글자·아이콘을 같이).
- 검사: `cd frontend && npx eslint . && npx tsc --noEmit && npx vitest run && npx vite build`

---

## 5. 그 밖에 남은 일

| 항목 | 내용 |
|---|---|
| 배포 (4E) | Dockerfile, 운영 compose(nginx·web·engine·db·redis), GitHub Actions(ci·deploy), EC2 설정 |
| 운영 전 점검 | 웹 프로세스를 여럿 띄우면 증권사 호출이 그만큼 늘어난다 → Redis 캐시. SSE용 gunicorn 스레드 워커와 nginx 설정 |
| 키움 실측 | 키움 앱키로 `scripts/kiwoom_check.py` 실행 (`docs/KIWOOM.md` 8장). 지금 로컬은 토스 조회로 돌고 있다 |
| 엔진 통합 (5단계) | 엔진 자체 기록(AI 시나리오 추적, 엔진 계좌)을 Django DB로 옮기기 |
| CI | PostgreSQL로 테스트 (`TEST_WITH_POSTGRES=1`), OpenAPI와 프론트 타입 비교 |

---

## 6. 같이 지킬 규칙

- **실주문 코드 금지.** 증권사에는 조회만 한다. 주문은 모의 계좌에서만 체결한다.
- **비밀 값은 `.env`에만.** 키·비밀번호·`team_accounts.txt`를 커밋하거나 채팅에 통째로 올리지 않는다.
- **테스트는 실제 증권사·AI를 부르지 않는다.** 가짜 객체를 쓴다. push 전에 `uv run ruff check . && uv run pytest`와 프론트 검사를 돌린다.
- **API를 바꾸면 `docs/API.md`를 먼저 고친다.** 백엔드와 프론트엔드가 같이 따르는 계약이다.
- **엔진 루프는 한 곳에서만.** 공유 DB를 쓸 때 `run_engine`은 호스트 PC에서만 돌린다.
- **토스 조회는 로컬 개발 전용이다** (`BROKER=toss`, `DJANGO_DEBUG=on`일 때만). 토스 토큰은 계정당 하나만 유효해서, 같은 키를 여러 PC에서 쓰면 서로의 토큰을 무효로 만든다. 팀원 PC에는 키움 키를 쓰거나 호스트 PC의 화면을 쓴다.
- AI 분석·리포트는 실제 비용이 든다. 반복 실험은 가짜 LLM이나 값싼 모델로 한다.
- `main`에 직접 push해도 된다. 큰 변경은 PR로 리뷰를 받는다.
