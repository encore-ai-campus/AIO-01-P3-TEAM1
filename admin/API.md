# 관리자 API 계약 (`/api/admin/*`)

> 관리 서버의 관리자 백엔드(`admin/server/`)가 내고, 관리자 프론트(`admin/web/`)와 MCP 서버(`admin/server/paper_admin/mcp_server.py`)가 부른다.
> 계획은 루트 `docs/plans/OPS_ADMIN_PLAN.md`. 이 문서를 먼저 고친 뒤 코드를 고친다 (서비스의 `docs/API.md`와 따로다).

## 0. 공통 규칙

- **조회만 한다.** 쓰기 요청은 로그인·로그아웃뿐이고, 서비스 DB에는 읽기 전용 계정(4장)으로만 붙는다.
- 시각은 모두 ISO 8601에 시간대를 붙인다 (`2026-10-08T09:30:00+09:00`). 날짜 묶음(일별 비용 등)은 **KST 날짜**(`YYYY-MM-DD`)다.
- 돈은 USD 숫자(소수), 시간 길이는 ms 또는 초(필드 이름에 `Ms`·`Sec`).
- 오류 응답은 `{"detail": string}`이다. `400` 잘못된 값 · `401` 로그인·토큰 없음 · `404` 없음 · `429` 로그인 시도 초과 · `503` 서비스 DB에 붙지 못함("서비스 DB에 연결할 수 없습니다").
- 상태 단계 `Level`: `ok`(정상) · `warn`(살펴볼 것) · `down`(멈춤·실패) · `unknown`(자료 없음).
- 비밀 값·개인 정보를 내지 않는다: 비밀번호 해시, 세션, 토큰, 알림 본문(`notification_outbox.content`), 리포트 본문, 사용자 이름·닉네임.
  오류 문장은 300자로 자르고 URL의 경로·쿼리(웹훅 주소 등)는 `…`로 가린다.

## 1. 인증

두 가지 방법이 있다. 둘 다 없으면 로그인·로그아웃 말고 모든 경로가 `401`이다.

| 누가 | 방법 | 기록 |
|---|---|---|
| 관리자 화면 | `POST /api/admin/login`이 주는 세션 쿠키 `paper_admin_session` (HttpOnly, SameSite=Strict, 12시간) | 로그인 성공·실패를 감사 기록에 남긴다 |
| MCP 서버 | `Authorization: Bearer <사람별 토큰>`. MCP 서버가 받은 토큰을 그대로 넘기고, 부른 도구 이름을 `X-Admin-Tool` 헤더에 넣는다 | 요청마다 감사 기록 한 줄 (누가·도구·경로·응답 코드) |

- 로그인은 **서비스의 staff 계정**으로 한다 (계획 F1). 관리자 백엔드는 서비스 DB의 뷰 `admin_staff_accounts`(staff 행만, 4장)만 읽으므로 staff가 아닌 사용자의 비밀번호 해시는 읽을 권한이 없다.
  비밀번호는 Django 해시 형식 `pbkdf2_sha256$반복$솔트$해시`(base64)를 직접 검증한다. 그 밖의 형식은 실패로 본다.
- 세션 쿠키에는 사용자 id·아이디·만료 시각·비밀번호 해시의 지문(HMAC)·nonce를 넣어 서명한다. 요청마다 뷰를 다시 읽어 staff·활성 상태와 지문을 확인한다
  (staff를 빼거나 비밀번호를 바꾸면 바로 로그아웃된다). 로그아웃한 쿠키는 만료까지 다시 받지 않는다 (서버 메모리 — 관리자 백엔드를 다시 띄우면 잊는다).
- **서비스 DB(터널)가 끊겼을 때**는 서명·만료·로그아웃만 확인하고 통과시킨다: DB가 필요 없는 F3·F5와 `/me`는 200, DB가 필요한 경로는 `503`. 로그인은 `503`.
- 같은 아이디로 10분 안에 5번 시도해 성공하지 못하면 10분 동안 `429` (시도는 검증 전에 센다 — 동시 요청으로 넘지 못한다).
  IP로는 막지 않는다: 관리자는 모두 SSH 터널로 들어와 주소가 같다. 없는 아이디도 가짜 해시로 같은 시간 검증한다 (응답 시간으로 staff 아이디를 알 수 없게).
- 토큰은 관리 서버의 `ADMIN_DATA_DIR/mcp_tokens.json`에 **SHA-256 해시**로만 둔다. 만들기·목록·지우기: `python -m paper_admin.tokens add|list|revoke <이름>` (토큰 원문은 만들 때 한 번만 보인다).
- 감사 기록은 `ADMIN_DATA_DIR/audit.jsonl`에 한 줄씩 더한다: `{"at", "via": "token"|"session", "who", "event": "login"|"login_failed"|"request", "tool", "path", "status"}`. 토큰·비밀번호는 적지 않는다.
- 화면에서 쓰는 GET은 쿠키로, MCP는 토큰으로 부른다. 토큰으로는 로그인·로그아웃을 부르지 않는다.

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `POST /api/admin/login` | `{"username", "password"}` (JSON) | `200 Me` + 쿠키 · 빈 값 `400` · 틀림·staff 아님·비활성 `401 {"detail": "아이디 또는 비밀번호가 맞지 않거나 관리자 계정이 아닙니다."}` · `429` |
| `POST /api/admin/logout` | – | `204` (쿠키를 지운다) |
| `GET /api/admin/me` | – | `200 Me` · `401` |

```ts
interface Me { username: string; via: "session" | "token" }   // 토큰이면 username = 토큰 이름
```

## 2. 형식

```ts
type Level = "ok" | "warn" | "down" | "unknown";

// F2 개요 — GET /api/admin/overview
interface Overview {
  at: string;
  level: Level;                 // items 중 가장 나쁜 것 (down > warn > unknown > ok)
  items: OverviewItem[];        // 나쁜 것부터: down → warn → unknown → ok, 같으면 아래 key 순서
}
interface OverviewItem {
  key: "service" | "engine" | "deploys" | "reports" | "recovery" | "costs" | "alerts";
  title: string;                // "서비스 상태" · "엔진 상태" · "배포 기록" · "리포트 장애" · "복구 지표" · "AI 비용" · "알림·작업 실패"
  level: Level;
  summary: string;              // 한 줄 (예: "API 응답 없음 (3분째)", "마지막 동작 12초 전 · 버전 500d087")
}

// F3 서비스 상태 — GET /api/admin/service
interface HealthProbe { ok: boolean; status: number | null; ms: number | null; error: string | null }  // error: "timeout" · "connection" · "HTTP 502" 같은 짧은 사유
interface HealthCheck { at: string; api: HealthProbe; page: HealthProbe }   // 한 번에 /api/health 와 / 를 함께 부른다
interface ServiceStatus {
  url: string;                  // 확인하는 서비스 주소 (ADMIN_SERVICE_URL)
  intervalSec: number;          // 확인 간격 (기본 30)
  level: Level;
  latest: HealthCheck | null;   // 아직 한 번도 확인하지 않았으면 null
  downSince: string | null;     // 지금 실패 중이면 연속 실패가 시작된 시각
  uptimePct24h: number | null;  // 최근 24시간 확인 중 api·page 모두 성공한 비율 (0~100, 소수 1자리)
  avgMs24h: number | null;      // 최근 24시간 성공한 api 확인의 평균 응답 시간
  recent: HealthCheck[];        // 최근 60번, 최신순
}

// F4 엔진 상태 — GET /api/admin/engine
interface EngineStatus {
  level: Level;
  found: boolean;               // engine_status 행이 있는지 (엔진이 한 번도 상태를 남기지 않았으면 false)
  version: string | null;       // 엔진 컨테이너의 APP_VERSION (= 배포한 이미지 태그, 커밋 해시)
  host: string | null;
  startedAt: string | null;
  beatAt: string | null;        // 마지막으로 동작한 시각
  ageSec: number | null;        // 지금 − beatAt
  stale: boolean;               // ageSec > staleAfterSec → "멈춤"
  staleAfterSec: number;        // 120
  halted: boolean | null;       // 새 모의 매수 중단 스위치
  brokerReady: boolean | null;  // 증권사 조회 키가 있는지
  lastTickMs: number | null;    // 마지막 한 바퀴에 걸린 시간
  errors: { at: string; step: string; error: string }[];   // 최근 단계 오류, 최신순 (최대 20)
  limits: Record<string, number | string | null>;          // 엔진이 알려 준 한도 (5장 engine_status.limits)
}

// F5 배포 기록 — GET /api/admin/deploys?limit=50  (limit 1~200)
type DeployResult = "success" | "rolled_back" | "rollback_failed" | "failed" | "blocked";
// success 새 버전으로 바뀜 · rolled_back 새 버전이 뜨지 않아 직전 버전으로 되돌림 · rollback_failed 되돌리기도 실패
// failed 배포 실패, 서버는 그대로 (이미지를 받지 못함·되돌릴 직전 버전 없음·SSH 실패) · blocked 검사(CI) 실패로 배포하지 않음
interface DeployRecord {
  at: string; server: string; tag: string; previous: string | null; result: DeployResult;
  actor: string | null; commit: string | null; runUrl: string | null;
}
interface DeployServer {
  server: string;
  current: string | null;       // 지금 그 서버에서 도는 태그: 최신순으로 보며 success → tag, rolled_back → previous,
                                // failed·blocked → 건너뜀, rollback_failed → null (알 수 없음)
  currentAt: string | null;     // current를 정한 기록의 시각
  last: DeployRecord;           // 그 서버의 가장 최근 기록
}
interface Deploys { servers: DeployServer[]; records: DeployRecord[]; total: number }   // records 최신순, total = 전체 기록 수

// F6 리포트 장애 — GET /api/admin/reports?days=7&kind=all&team=&limit=100
//   days 1~90 (기본 7) · kind: all(기본, 아래 셋 중 하나라도) | failed(status failed) | recovered(복구된 장애가 1건 이상) | chaos(장애 주입을 켬)
//   team: stock_report | stock_selection | 빈 값(둘 다) · limit 1~500 (기본 100)
//   기간 = 리포트의 created_at이 오늘(KST)을 포함한 최근 days일 안 (첫날 0시 KST부터) — F7·서비스 reports.autohealing.stats와 같은 기간
interface ReportRow {
  id: number; team: "stock_report" | "stock_selection"; symbol: string; name: string;
  source: "user" | "auto"; status: "requested" | "running" | "completed" | "failed";
  chaos: boolean;               // chaos.enabled === true
  failReason: string | null;    // workflow_failed.details.reason (서비스 docs/API.md 실패 사유 코드)
  failures: number; recovered: number; unrecovered: number; injected: number;   // 3장 셈법
  costUsd: number | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  durationMs: number | null;    // finishedAt − startedAt
}
interface ReportList { from: string; to: string; days: number; kind: string; count: number; results: ReportRow[] }   // 최신순. from·to는 KST 날짜(YYYY-MM-DD), count는 limit 전 건수

// 리포트 하나의 실행 기록 — GET /api/admin/reports/{id}/trace
type TraceKind = "retry" | "failover" | "failure" | "give_up" | "recovered" | "skipped" | "guard" | "workflow" | "other";
// agent_retry → retry · agent_failover → failover · agent_failed(final false) → failure · 그 밖의 agent_failed(final이 false가 아님) → give_up
// agent_completed(details.recovered true) → recovered · agent_skipped → skipped · join_*·handoff_*·review_retry → guard
// workflow_* → workflow · 그 밖(agent_started, 복구 없는 agent_completed) → other
interface TraceItem {
  step: number; at: string; actor: string; action: string; status: string;
  provider: string | null; model: string | null; latencyMs: number | null;
  details: Record<string, unknown>;   // 서비스 Trace의 details 그대로 (문자열 값은 300자로 자른다)
  kind: TraceKind;
}
interface RecoverySummary { failures: number; recovered: number; unrecovered: number; injected: number; recoveryMs: number | null }
interface ReportTrace { report: ReportRow; recovery: RecoverySummary; events: TraceItem[] }   // events는 step 오름차순(= 시간순)

// F7 복구 지표 — GET /api/admin/recovery?days=7  (days 1~90)
//   서비스 docs/API.md의 RecoveryStats(backend/reports/autohealing/stats.py recovery_stats)와 같은 형식·기간이다: 오늘(KST)을 포함한 최근 days일 안에 만든 리포트, from·to는 KST 날짜
interface RecoveryStats {
  from: string; to: string; days: number;   // from·to: "YYYY-MM-DD" (KST)
  reports: number; reportsWithFailures: number;
  failures: number; recovered: number; unrecovered: number; injected: number;   // unrecovered = 포기한 건 (진행 중인 건은 failures에만)
  autoRecoveryRate: number | null;   // recovered ÷ failures × 100, 소수 1자리 (장애가 없으면 null)
  meanRecoveryMs: number | null;     // 복구된 건의 복구 시간 평균 (반올림 정수)
  byErrorType: { errorType: string; failures: number; recovered: number }[];   // 장애 건의 첫 실패 errorType별, failures 많은 순
  byWorker: { worker: string; failures: number; recovered: number }[];
  recent: { reportId: number; symbol: string; worker: string; errorType: string; injected: boolean;
            recovered: boolean; recoveryMs: number | null; at: string }[];      // 최근 20건, 최신순 (at = 첫 실패 시각)
}

// F8 AI 비용 — GET /api/admin/costs?days=14  (days 1~90)
interface CostDay {
  date: string;                 // KST 날짜. 기간의 모든 날을 0으로라도 낸다 (오래된 날 → 오늘)
  reportsUsd: number;           // reports.cost_usd 합 (created_at 날짜. 자동 리포트·선정 실행 포함)
  analysisUsd: number;          // analysis_runs.cost_usd 합 (analyzed_at 날짜)
  longtermUsd: number;          // daily_move_notes.cost_usd 합 (created_at 날짜)
  totalUsd: number;
  reports: number;              // 그날 만든 리포트 수
  analyses: number;             // 그날 분석한 종목 수 (analysis_runs 행)
}
interface Costs {
  from: string; to: string; days: number;
  daily: CostDay[];
  totals: { reportsUsd: number; analysisUsd: number; longtermUsd: number; totalUsd: number };
  today: {
    date: string; totalUsd: number;
    budgetUsd: number | null;   // limits.aiDailyBudgetUsd (엔진이 알려 준 값. 모르면 null)
    budgetUsedUsd: number;      // 예산 사용액 = 서비스 reports.limits.budget.used_usd와 같은 셈 (이 값이 예산에 닿으면 서비스가 새 리포트를 막는다):
                                //   오늘 분석 요청 수(analyses.used) × limits.analysisCostUsd(건당 예상, 없으면 0.3) + 오늘 만든 리포트의 실제 비용(reportsUsd)
    budgetPct: number | null;   // budgetUsedUsd ÷ budgetUsd × 100, 소수 1자리
    analyses: { used: number; limit: number | null };        // 오늘 분석 요청 수 (서비스 analysis.quota와 같은 셈) / limits.analysesTotal
    reportsPerUser: { maxUsed: number; limit: number | null;    // 오늘 가장 많이 쓴 사람의 리포트 수 (reports.limits.quota와 같은 셈) / limits.reportsPerUser
                      unlimited: boolean };                     // 엔진이 한도를 null(무제한, 서비스 기본값 — 2026-10-08)로 알려 줬으면 true. limit null이고 false면 모름
  };
}

// F9 알림·작업 실패 — GET /api/admin/alerts?hours=24  (hours 1~168)
interface OutboxRow {
  id: number; kind: string; status: "failed" | "pending" | "sending"; attempts: number;
  lastError: string | null; createdAt: string; claimedAt: string | null; ageSec: number;
}
interface StuckJob {
  kind: "analysis" | "report"; id: number; status: string;
  label: string;                // "분석 005930" · "리포트 삼성전자(005930)" · "선정 KR"
  since: string;                // 그 상태가 된 시각 (running: started_at, 대기: created_at)
  ageSec: number;
}
interface Alerts {
  hours: number; level: Level;
  discord: { failed: number; pendingOld: number; sendingStuck: number; rows: OutboxRow[] };   // rows 최신순 (최대 50)
  stuck: StuckJob[];            // 오래된 것부터
}
```

**레벨과 기준값** (화면·MCP가 같은 값을 보도록 백엔드가 정한다):

| 항목 | down | warn | unknown |
|---|---|---|---|
| service | 마지막 확인에서 api 또는 page 실패 | 최근 10분 안에 실패가 있었음, 또는 마지막 api 응답이 2,000ms 넘음 | 아직 확인 전 |
| engine | 행이 없음 또는 `stale` | 중단 스위치 켜짐, 또는 최근 30분 안에 단계 오류 | – |
| deploys | 최신 기록이 `rollback_failed` | 최신 기록이 `failed`·`rolled_back`·`blocked` | 기록 없음 |
| reports | – | 최근 24시간 안에 장애 주입 없이 `failed`로 끝난 리포트가 있음 | – |
| recovery (7일) | – | `unrecovered` > 0 | 장애 0건 (요약 "장애 없음") |
| costs (오늘) | `budgetPct` ≥ 100 | `budgetPct` ≥ 80 | 예산을 모름 |
| alerts (24시간) | – | Discord 실패·오래된 대기·멈춘 발송이 있거나 멈춘 작업이 있음 | – |

- Discord: `failed`는 기간 안에 만든 것, `pendingOld`는 10분 넘게 `pending`, `sendingStuck`은 `claimed_at`이 10분 넘은 `sending` (서비스 `dispatch.STALE_SENDING`).
- 멈춘 작업: 분석 `RUNNING` 15분 초과 · `QUEUED` 10분 초과, 리포트 `running` 20분 초과 · `requested` 30분 초과.

| 메서드·경로 | 응답 |
|---|---|
| `GET /api/admin/overview` | `200 Overview` |
| `GET /api/admin/service` | `200 ServiceStatus` |
| `GET /api/admin/engine` | `200 EngineStatus` |
| `GET /api/admin/deploys?limit=` | `200 Deploys` |
| `GET /api/admin/reports?days=&kind=&team=&limit=` | `200 ReportList` · 잘못된 값 `400` |
| `GET /api/admin/reports/{id}/trace` | `200 ReportTrace` · `404` |
| `GET /api/admin/recovery?days=` | `200 RecoveryStats` |
| `GET /api/admin/costs?days=` | `200 Costs` |
| `GET /api/admin/alerts?hours=` | `200 Alerts` |
| `GET /api/admin/mcp?hours=&limit=` | `200 McpStatus` (6장) |
| `GET /api/admin/health` | `200 {"ok": true}` (로그인 없이. 관리 서버 컨테이너 상태 확인용) |

## 3. 복구 셈법 (F6·F7, 서비스 `docs/tasks/00-공통.md` 9절 · `backend/reports/autohealing/stats.py`(담당 4, T4-7)와 같은 규칙)

- Worker의 실행(run) = 그 actor의 `agent_started`부터 다음 `agent_completed` 또는 **포기**(`agent_failed`이면서 `details.final`이 `false`가 아닌 것 — `final` 키가 없어도 포기)까지. Trace는 리포트별로 `step` 순서로 읽는다.
- 장애 1건 = 한 run 안의 **첫** `agent_failed(final: false)`. `agent_started` 없이 실패가 먼저 오면 그때 run이 시작된 것으로 본다.
- 복구됨 = 그 run이 `agent_completed`로 끝남. 복구 시간 = `agent_completed.at − 첫 실패.at` (ms, 버림 정수).
- 복구 못 함(`unrecovered`) = 그 run이 포기로 끝남. **끝나지 않은 run의 장애**(실행 중이거나, 장애가 열린 채 같은 actor의 `agent_started`가 다시 옴)는 장애 건수에만 든다 — 복구도 포기도 아니다.
- `injected` = 장애 건의 첫 실패의 `details.injected`가 true. `errorType` = 첫 실패의 `details.errorType` (`timeout`·`server_error`·`bad_output`·`unknown` 밖이면 `"unknown"`).
- 한 리포트의 `recoveryMs` = 복구된 건의 복구 시간 **합** (복구된 건이 없으면 null). 기간 지표의 `meanRecoveryMs` = 건별 복구 시간 평균(반올림), `recent`의 `recovered`는 복구된 건만 true.
- 기준 사례: `admin/recovery_cases.json`. 관리자 백엔드 테스트(`admin/server/tests/test_recovery.py`)와 서비스 테스트(`backend/reports/tests/autohealing/test_recovery_cases.py`, `reports.autohealing.stats`)가
  **같은 파일로 같은 숫자**가 나오는지 확인한다. 셈법을 바꾸면 이 파일을 먼저 고친다.

## 4. 읽는 서비스 DB (읽기 전용 계정 `paper_admin_ro`, `deploy/readonly_role.sql`)

열 단위로 SELECT만 준다. 아래에 없는 표·열(리포트 본문, 알림 본문, 사용자 표 등)은 권한이 없어 읽을 수 없다.
PostgreSQL의 JSON 열은 `jsonb`, 테스트의 SQLite는 JSON 문자열이다.

| 표 | 읽는 열 |
|---|---|
| `admin_staff_accounts` (뷰: `auth_user`의 staff 행) | `id, username, password, is_active` |
| `engine_status` | `name, version, host, pid, started_at, beat_at, halted, broker_ready, last_tick_ms, step_errors, limits` |
| `reports` | `id, user_id, team, symbol, name, market, source, status, chaos, cost_usd, created_at, started_at, finished_at` |
| `report_trace_events` | `id, report_id, step, actor, action, status, provider, model, latency_ms, details, at` |
| `analysis_runs` | `id, symbol, analyzed_at, cost_usd` |
| `jobs` | `id, type, user_id, payload, status, created_at, started_at, finished_at` |
| `notification_outbox` | `id, kind, status, attempts, last_error, created_at, claimed_at, sent_at` |
| `daily_move_notes` | `id, symbol, created_at, cost_usd` |

## 5. 서비스가 남기는 것

### 5-1. 엔진 상태 `engine_status` (서비스 `trading.EngineStatus`, `run_engine`이 30초마다)

| 열 | 형식 | 뜻 |
|---|---|---|
| `name` | 문자 (고유) | `"run_engine"` |
| `version` | 문자 | 환경 변수 `APP_VERSION` (운영 compose가 이미지 태그를 넣는다. 없으면 `"dev"`) |
| `host`, `pid` | 문자, 정수 | 컨테이너 호스트 이름, 프로세스 번호 |
| `started_at`, `beat_at` | 시각 | 루프 시작, 마지막 기록 |
| `halted`, `broker_ready` | 참거짓 | 중단 스위치(`PAPER_ROOT/data/HALT`) 켜짐, 증권사 조회 키 있음 |
| `last_tick_ms` | 정수 | 마지막 한 바퀴에 걸린 시간 |
| `step_errors` | JSON 배열 | `[{"at", "step", "error"}]` 최신순 최대 20 (`error`는 `예외이름: 메시지` 300자, URL 경로·쿼리는 가림) |
| `limits` | JSON 객체 | `{"aiDailyBudgetUsd", "analysisCostUsd", "analysesPerUser", "analysesTotal", "reportsPerUser"}` — 비밀 값이 아닌 한도만. `reportsPerUser`가 null이면 한도 없음 |

### 5-2. 배포 기록 (`ADMIN_DATA_DIR/deploys.jsonl`)

서비스 GitHub Actions `deploy.yml`의 마지막 작업이 배포 결과 한 줄을 관리 서버로 보낸다. 관리 서버의 `authorized_keys`에 강제 명령
(`server/paper_admin/deploy_record.py`, 표준 라이브러리만)을 건 전용 키로 SSH 접속해 표준 입력으로 JSON 한 줄을 넘기면, 그 스크립트가 검사해 파일 끝에 더한다.

```json
{"at": "2026-10-08T12:00:00+00:00", "server": "app", "tag": "<커밋 해시>", "previous": "<직전 태그>|null",
 "result": "success", "actor": "github 아이디", "commit": "커밋 제목 120자", "runUrl": "https://github.com/.../actions/runs/1"}
```

- 검사: 모르는 키는 버리고, `at`·`server`·`tag`·`result`는 필수. `server`는 `[a-z0-9-]{1,32}`, `tag`·`previous`는 `[0-9A-Za-z._-]{1,64}`, `result`는 `DeployResult` 중 하나,
  문자열은 각각 300자, 한 줄은 4KB 이하. 틀리면 아무것도 쓰지 않고 0이 아닌 코드로 끝난다.

## 6. MCP 도구·호출 기록 (F10, 2026-10-08 추가)

관리자 화면의 "MCP" 메뉴가 쓴다. MCP 도구 목록, 사람별 토큰(이름·만든 시각·마지막 사용), 토큰으로 들어온 요청의 감사 기록(1장 `audit.jsonl`)을 함께 낸다.
토큰 원문·해시는 내지 않는다.

`GET /api/admin/mcp?hours=24&limit=200` — hours 1~168 (기본 24), limit 1~500 (기본 200)

```ts
interface McpTool {
  name: string;                 // MCP 도구 이름 (예 "report_trace")
  description: string;          // MCP 클라이언트에 보이는 설명
  path: string;                 // 부르는 관리자 API 경로 (예 "/api/admin/reports/{report_id}/trace")
  params: string[];             // 도구 인자 이름 (예 ["days", "kind", "team", "limit"])
}
interface McpToken {
  name: string; createdAt: string | null;
  lastUsedAt: string | null;    // 감사 기록에서 그 토큰의 가장 최근 요청 (기간과 상관없이, 읽은 기록 안에서)
  calls: number;                // 기간 안 도구 호출 수 (X-Admin-Tool이 있는 요청)
  errors: number;               // 그중 응답 코드가 400 이상
}
interface McpCall {
  at: string; who: string | null;   // 토큰 이름. 틀린 토큰이면 null
  tool: string | null;              // 도구 이름. null이면 MCP 서버의 토큰 확인(GET /api/admin/me) 같은 도구 밖 요청
  path: string; status: number; ok: boolean;   // ok = status < 400
}
interface McpStatus {
  endpoint: string;             // "/mcp" (화면이 지금 주소에 붙여 연결 주소를 보인다)
  hours: number;
  tools: McpTool[];             // 도구 9개, 등록 순서
  tokens: McpToken[];           // 이름순
  summary: {
    calls: number; errors: number;   // 기간 안 도구 호출 수 · 그중 실패
    invalid: number;                 // 기간 안 틀린 토큰 요청 (who null, 401)
    byTool: { tool: string; calls: number; errors: number }[];   // 호출 많은 순
  };
  calls: McpCall[];             // 기간 안 토큰 요청 최신순 limit개 (도구 밖 요청 포함)
}
```

- 감사 기록은 파일 끝 4MB까지만 읽는다 (오래된 기록은 `lastUsedAt`·기간 셈에서 빠질 수 있다).

