# 웹 API 계약 (1차: 로그인 · 모의 트레이딩 · AI 분석 대시보드 · My Page · 랭킹)

작성 2026-10-02. 백엔드(`backend/`)와 프론트엔드(`frontend/`)가 같이 따르는 계약이다. 배경 결정은 `docs/DECISIONS.md` 8장.
바꾸려면 이 파일을 먼저 고치고 양쪽 작업자에게 알린다. 프론트 타입(`frontend/src/api/types.ts`)은 지금은 이 문서를 보고
손으로 쓰고, OpenAPI 자동 생성(`drf-spectacular` → `openapi-typescript`) 비교는 CI 단계(4E)에서 붙인다.

## 공통 규칙

- 경로는 `/api/...`, **끝 슬래시 없음**. 요청·응답은 JSON, 키는 **camelCase**.
- 인증은 Django 세션 쿠키 + CSRF. 프론트는 같은 출처로 부른다 (개발: Vite가 `/api`를 `127.0.0.1:8000`으로 프록시).
  - 변경 요청(POST·PATCH·DELETE, 로그인 포함)에는 `X-CSRFToken` 헤더가 필요하다. 프론트는 **요청할 때마다 `csrftoken` 쿠키 값을 읽어**
    헤더에 넣는다 (로그인하면 값이 바뀐다). 쿠키가 아직 없으면 `GET /api/auth/csrf`를 먼저 불러 쿠키를 받는다.
    CSRF 검사에 걸리면 `403 {"detail": ...}`.
  - 로그인하지 않았으면 `401 {"detail": "로그인이 필요합니다."}`. 로그인·csrf·health만 로그인 없이 된다 (`/api/schema/`도 로그인 필요).
- 오류: `{"detail": "사람이 읽는 한국어 메시지"}`. 입력·규칙 위반(주문 거절 포함) 400, 없는 대상 404, 한도 초과 429,
  증권사 조회 실패 503 (`detail`에 사유).
- 숫자는 JSON number (문자열 아님). 금액은 종목 통화 기준이고, 이름이 `...Krw`면 원화다. 비율은 소수 (0.0123 = 1.23%).
  값이 없으면 `null`. 원화 반올림·천 단위 표시는 프론트가 한다.
- 시각은 UTC 오프셋이 붙은 ISO 8601 (`2026-10-02T09:00:00+09:00`), 날짜는 `YYYY-MM-DD`.
- 목록의 페이지: `?limit=20&offset=0` → `{"count": n, "results": [...]}`.
- **실시간 = 폴링.** 프론트는 화면에 보이는 종목의 시세(`/api/quotes`, `/api/stocks/{symbol}`)를 **1초**, 계좌(`/api/account`)를 2초,
  랭킹·주문·작업 상태를 5초 간격으로 다시 받는다. 백엔드는 현재가를 1초 캐시한다 (같은 종목은 팀원이 몇 명이 봐도 증권사 조회 1번).
  시세와 계좌는 로그인해 있는 동안 탭이 가려져도 계속 받고, 나머지는 탭이 보이지 않으면 멈춘다.
  간격은 `frontend/src/api/queries.ts`의 `POLL`, 캐시는 `backend/trading/market.py`의 `PRICE_TTL`.

## 타입

```ts
type Market = "KR" | "US";
type Currency = "KRW" | "USD";

interface Me {
  id: number;
  username: string;       // 로그인 아이디
  nickname: string;       // 랭킹에 보이는 이름 (기본값은 아이디)
  isPublic: boolean;      // 내 정보 공개 (켜면 랭킹보드에 수익률이 나온다). 기본 false
  isStaff: boolean;
}

interface Quote {
  symbol: string;
  name: string | null;
  currency: Currency;
  price: number | null;        // 현재가. 조회 실패면 null
  prevClose: number | null;    // 전 거래일 종가. 그날 처음 보는 종목은 잠깐 null일 수 있다 (한 요청이 새로 받는 수를 제한한다. 다음 폴링에 채워진다)
  change: number | null;       // price - prevClose
  changeRate: number | null;   // price / prevClose - 1
}

interface StockItem {            // 검색 결과
  symbol: string;
  name: string;
  exchange: string;            // KOSPI | KOSDAQ | NYSE | NASDAQ | AMEX
  market: Market;
}

interface Candle { date: string; open: number; high: number; low: number; close: number; volume: number; }

interface StockDetail {
  symbol: string;
  name: string;
  exchange: string;
  market: Market;
  currency: Currency;
  quote: Quote;
  candles: Candle[];           // 일봉, 과거 → 최신, 최근 120개 (장중이면 마지막은 오늘 미완성 봉)
  warnings: string[];          // 매수 유의 (투자경고 등). 없으면 []
}

interface MarketStatus {
  markets: { market: Market; isOpen: boolean; opensAt: string | null; closesAt: string | null }[];
  // isOpen: 지금 정규장인지. opensAt: 다음(또는 오늘) 정규장 시작, closesAt: 지금 열려 있으면 오늘 종료 시각
  halted: boolean;             // 새 모의 매수 중단 스위치
  brokerReady: boolean;        // 증권사 조회 키가 있는지 (없으면 시세·주문이 안 된다)
}

type OrderStatus = "ENTRY_PENDING" | "EXIT_WATCHING" | "CLOSED" | "CANCELED";
// ENTRY_PENDING 체결 대기 · EXIT_WATCHING 보유 중 · CLOSED 종료(매도 완료) · CANCELED 취소

interface Order {                // 매수 주문 하나 = 포지션 하나
  id: number;
  symbol: string; name: string; market: Market; currency: Currency;
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  quantity: number;
  status: OrderStatus;
  entryPrice: number;          // 계획 진입가 (시장가는 주문 시점 가격)
  fillPrice: number | null; filledAt: string | null;
  targetPrice: number | null; stopPrice: number | null; expireDate: string | null;
  exitPrice: number | null; exitReason: "TARGET" | "STOP" | "EXPIRED" | "MANUAL" | null; closedAt: string | null;
  pnlKrw: number | null;       // 실현 손익 (수수료·세금 포함)
  note: string | null;         // 취소 사유 등
  createdAt: string;
}

interface Position {             // 보유 중(EXIT_WATCHING)인 주문의 평가
  orderId: number;
  symbol: string; name: string; market: Market; currency: Currency;
  quantity: number;
  avgPrice: number;            // 매수 체결가
  lastPrice: number | null;    // 현재가. 못 받으면 null (그때는 체결가로 평가)
  costKrw: number;             // 매수 원금 (체결가 × 수량 × 체결 환율)
  valueKrw: number;            // 평가 금액
  profitKrw: number;           // valueKrw - costKrw
  profitRate: number | null;
  targetPrice: number | null; stopPrice: number | null; expireDate: string | null;
  filledAt: string;
}

interface AccountSummary {       // My Page · 홈 자산 카드
  initialCapitalKrw: number;
  cashKrw: number;
  holdingsValueKrw: number;    // 보유 평가액
  equityKrw: number;           // 총자산 = 현금 + 보유 평가액
  investedKrw: number;         // 투자금액 = 보유 종목 매수 원금 합계
  profitKrw: number;           // equityKrw - initialCapitalKrw
  profitRate: number;          // 수익률 = equityKrw / initialCapitalKrw - 1
  pendingKrw: number | null;   // 대기 매수 금액
  buyingPowerKrw: number | null; // 매수 가능액 = 현금 - 대기 매수 금액
  positions: Position[];
  notes: string[];             // "현재가를 받지 못해 체결가로 평가: ..." 같은 안내
  asOf: string;
}

interface Fill {
  id: number; orderId: number;
  symbol: string; name: string; currency: Currency;
  side: "BUY" | "SELL";
  price: number; quantity: number; amount: number;
  commission: number; tax: number;
  cashChangeKrw: number;       // 현금 증감 (매수 음수)
  reason: "ENTRY" | "TARGET" | "STOP" | "EXPIRED" | "MANUAL";
  filledAt: string;
}

interface Reservation {          // 정규장 밖 시장가 매수·매도 → 다음 정규장 시작에 실행
  id: number;
  kind: "BUY" | "SELL";
  symbol: string; name: string; market: Market;
  quantity: number;
  orderId: number | null;      // SELL이면 팔 주문(포지션)
  targetPrice: number | null; stopPrice: number | null; days: number | null;
  runAt: string | null;        // 실행 예정 (다음 정규장 시작)
  createdAt: string;
}

interface OrderResult {          // 주문·매도 요청의 결과
  order: Order | null;         // 접수(또는 체결)된 주문
  reservation: Reservation | null; // 정규장 밖이라 예약으로 들어간 경우
  message: string;             // "삼성전자 10주 71,000원에 매수 체결" 같은 한 줄 결과
}

interface RankingEntry {
  rank: number;                // 1부터, 수익률 내림차순
  nickname: string;
  profitRate: number;
  isMe: boolean;
}

interface Ranking {
  results: RankingEntry[];     // 내 정보 공개(isPublic)를 켠 사용자만
  me: { isPublic: boolean; rank: number | null; profitRate: number }; // 내가 비공개면 rank는 null
  asOf: string;
}

type Verdict = "BUY" | "PASS";   // BUY: 교차검증·리스크 엔진·최종 승인을 통과한 시나리오가 있음

interface Scenario {
  proposer: string;            // 제안한 모델
  selected: boolean;           // 최종 승인까지 통과
  passed: boolean | null;      // 교차검증 점수 + 리스크 엔진 통과
  score: number | null;        // 0~100
  probability: number | null;  // 합의 확률 (손절 전에 목표가에 도달할 확률, 0~1)
  entryPrice: number; targetPrice: number; stopPrice: number;
  holdingDays: number;
  rationale: string[];         // 근거
  invalidation: string;        // 시나리오가 틀렸다고 볼 조건
  rejectReasons: string[];     // 탈락 사유 (통과면 [])
}

interface AnalysisSummary {      // AI 분석 종목 대시보드의 카드
  id: number;
  symbol: string; name: string; market: Market; currency: Currency;
  analyzedAt: string;
  verdict: Verdict;
  priceAtAnalysis: number | null; // 분석 시점 현재가
  best: Scenario | null;       // 대표 시나리오: 승인된 것 중 최고 점수, 없으면 전체 중 최고 점수. 시나리오가 없으면 null
  scenarioCount: number;
  requestedBy: string | null;  // 요청한 팀원의 닉네임 (로그인 아이디는 내지 않는다), 전략 실행이면 "strategy:<번호>", CLI면 "cli"
  costUsd: number | null;
}

interface AnalysisDetail extends AnalysisSummary {
  scenarios: Scenario[];
  news: string[];              // 뉴스 제목
  research: { researcher: string; findings: { claim: string; direction: string | null; date: string | null;
                                               sourceTitle: string | null }[] }[];
  indicators: Record<string, number | string | null>;   // 엔진 스냅샷의 지표 그대로
  errors: string[];
}

interface Job {
  id: number;
  type: "analyze";
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  result: { analysisIds: number[] } | null;  // DONE이면 만들어진 분석
  error: string | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

interface AnalysisQuota {
  usedToday: number;           // 내가 오늘(KST) 요청한 수
  limitPerUser: number;        // AI_DAILY_ANALYSES_PER_USER (기본 5)
  remaining: number;           // 내 한도와 전체 예산 중 작은 쪽의 남은 횟수
  estimatedCostUsd: number;    // 종목당 예상 비용 0.3
  enabled: boolean;            // AI 키(DEVPASS_APIKEY, ANALYSTS)가 있어 분석을 요청할 수 있는지
}
```

## 엔드포인트

### 계정 (`backend/accounts`)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/auth/csrf` | – (로그인 불필요) | `200 {"csrfToken": string}` + `csrftoken` 쿠키 |
| `POST /api/auth/login` | `{"username", "password"}` | `200 Me` · 틀리면 `400 {"detail": "아이디 또는 비밀번호가 올바르지 않습니다."}` · 같은 주소에서 1분에 10번 넘게 시도하면 `429` (`Retry-After` 헤더) |
| `POST /api/auth/logout` | – | `204` |
| `GET /api/auth/me` | – | `200 Me` · `401` |
| `PATCH /api/me/profile` | `{"isPublic"?: boolean, "nickname"?: string}` | `200 Me` · 닉네임은 2~12자(NFKC 정규화 후), 다른 사람의 닉네임·아이디와 겹치거나 보이지 않는 문자가 있으면 `400` |

### 모의 트레이딩 (`backend/trading`)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/market` | – | `200 MarketStatus` |
| `GET /api/stocks/search?q=&limit=20` | `q`는 종목명 일부나 종목코드 | `200 {"results": StockItem[]}` (`q`가 비면 `[]`) |
| `GET /api/stocks/{symbol}` | – | `200 StockDetail` · `404` |
| `GET /api/quotes?symbols=005930,000660` | 쉼표 구분, 최대 50개 | `200 {"quotes": Quote[], "asOf": string}` (모르는 종목은 빠진다) |
| `GET /api/account` | – | `200 AccountSummary` |
| `GET /api/account/equity?days=30` | – | `200 {"points": {"day": string, "equityKrw": number}[]}` (일별 자산, 과거 → 최신) |
| `GET /api/orders?status=active\|all` | 기본 `active`(대기·보유), 페이지 | `200 {"count", "results": Order[]}` (최신순) |
| `POST /api/orders` | `{"symbol", "quantity", "orderType": "MARKET"\|"LIMIT", "limitPrice"?, "targetPrice"?, "stopPrice"?, "days"?}` | `201 OrderResult` · 거절 `400` |
| `PATCH /api/orders/{id}` | `{"targetPrice"?, "stopPrice"?, "days"?}` | `200 Order` |
| `POST /api/orders/{id}/sell` | – (보유 전량 매도. 대기 주문이면 취소) | `200 OrderResult` |
| `POST /api/orders/{id}/cancel` | – (체결 대기 주문만) | `200 Order` |
| `GET /api/fills` | 페이지 | `200 {"count", "results": Fill[]}` (최신순) |
| `GET /api/reservations` | – | `200 {"results": Reservation[]}` |
| `DELETE /api/reservations/{id}` | – | `204` |
| `GET /api/ranking` | – | `200 Ranking` |

주문 규칙 (엔진 `PaperExecutor` 그대로, `docs/DECISIONS.md` 4-2):
- 매수 주문 하나가 포지션 하나다. **같은 종목은 포지션 하나만** (진행 중 주문이 있으면 거절), **매도는 전량**이다.
- 체결은 정규장 안에서만. 시장가는 확인 가격(현재가·최우선 호가의 중간값)에 바로 체결, 지정가는 확인 가격 ≤ 지정가면 체결하고
  그날 정규장이 끝날 때까지 안 되면 취소. 국내 종목은 정수 주.
- **정규장 밖 시장가 매수·매도는 예약**으로 들어가고(`OrderResult.reservation`), 엔진(`run_engine`)이 다음 정규장 시작에 실행한다.
  정규장 밖 지정가 매수는 체결 대기 주문으로 받는다.
- `targetPrice`와 `stopPrice`는 함께 주거나 함께 뺀다 (손절가 < 기준가 < 목표가). `days`는 보유 기한(오늘부터 달력 일수).
  주면 엔진이 목표·손절·기한 조건을 2회 연속 확인했을 때 자동으로 판다. `days`를 주지 않으면 기한 없이 목표·손절만 본다
  (엔진 CLI는 기본 30일이지만 웹은 넣지 않는다).
- 예약 실행이 증권사 조회 실패 같은 일시 오류로 안 되면 정규장 시작 뒤 10분 동안 다시 시도하고, 그래도 안 되거나 주문이 거절되면
  예약을 지운다 (사유는 `run_engine` 콘솔에 남는다).
- 남의 주문·예약은 `404`.

### AI 분석 (`backend/analysis`)

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/analyses?symbol=&verdict=` | 페이지, 둘 다 선택 | `200 {"count", "results": AnalysisSummary[]}` (최신순, 팀 전체 공용) |
| `GET /api/analyses/{id}` | – | `200 AnalysisDetail` · `404` |
| `GET /api/analyses/quota` | – | `200 AnalysisQuota` |
| `POST /api/analyses` | `{"symbol"}` | `202 {"jobId": number}` · 한도 초과 `429` · AI 키 없음 `503` |
| `GET /api/jobs/{id}` | – | `200 Job` · 남의 작업 `404` |

- 분석은 몇 분 걸린다. 프론트는 `POST` 뒤 `GET /api/jobs/{id}`를 5초 간격으로 확인하고, `DONE`이면 `result.analysisIds[0]`로 간다.
- 한도(팀원별 하루 횟수, 전체 하루 횟수)는 **엔진이 실제로 시작한 작업을 실패해도 센다** (실패는 대부분 AI 비용을 쓴 뒤에 난다).
- 분석 결과는 팀 전체가 같이 본다 (요청자 표시). 현재가·등락률은 프론트가 `/api/quotes`로 따로 받는다.

---

# AI 리포트 (`backend/reports`) — Agents Orchestration과 Trace

작성 2026-10-02. 종목별로 AI 리포트를 신청하고, 여러 Agent가 협업하는 과정(Trace)을 화면에서 본다. 배경은 `docs/DECISIONS.md` 9장,
개념은 저장소 루트의 `교육용문서.md`(04 Distributed Collaboration)를 그대로 따른다.
**Agent와 Orchestrator 실행 코드는 아직 없다** (`ExecutionPlan.implemented = false`). 지금은 신청·실행 계획·Shared State·Trace를
담고 보여 주는 구조만 있다. 신청한 리포트는 `requested` 상태로 남는다.

## 타입

```ts
type TraceStatus = "started" | "completed" | "failed" | "blocked" | "skipped";
// 주요 action: agent_started · agent_completed · agent_failed · join_completed · join_blocked · workflow_completed
// (그 밖에 workflow_started · workflow_failed · handoff_completed · handoff_blocked 등이 올 수 있다. 모르는 값도 그대로 보여 준다)

interface TraceEvent {            // 구조화된 Trace의 사건 하나
  step: number;                 // 전체 실행에서의 사건 순서 (1부터)
  actor: string;                // Worker id(예: "market_agent") 또는 Guard("join_guard", "handoff_guard") 또는 "orchestrator"
  action: string;
  status: TraceStatus;
  provider: string | null;      // 실제 LLM 실행 정보 (Guard·Orchestrator 사건은 null)
  model: string | null;
  latencyMs: number | null;     // 응답 또는 실패까지 걸린 시간
  details: Record<string, unknown>;  // 오류와 추가 정보. Guard 사건은 대상을 넣는다: join_guard는 {"step": <Join하는 step id>},
                                     // handoff_guard는 {"to": <넘겨받는 Worker id>} (화면이 이 값으로 그래프의 어느 노드인지 찾는다)
  at: string;
}

interface SharedState {           // Orchestrator만 갱신한다
  taskId: string;               // "report-<id>"
  status: "requested" | "running" | "completed" | "failed";
  currentStep: string | null;   // 실행 계획의 step id (예: "parallel_research")
  results: Record<string, unknown>;   // 출력 계약을 통과한 Worker 결과만
  errors: Record<string, string>;     // Worker id → 오류
  completedAgents: string[];
  failedAgents: string[];
}

interface Worker {
  id: string; title: string; goal: string;
  provider: string | null; model: string | null;   // 아직 정하지 않았으면 null
  outputContract: string;       // 역할별 출력 계약 이름
}

interface PlanStep {
  id: string; title: string;
  mode: "parallel" | "sequential";
  workers: string[];            // Worker id
  required: string[];           // 필수 Worker (실패하면 Join을 막는다)
  optional: string[];           // 선택 Worker (실패해도 계속한다)
  dependsOn: string[];          // 먼저 끝나야 하는 step id
  join: boolean;                // 앞 단계 결과를 Join Guard로 확인한 뒤 실행하는지
  timeoutSec: number | null;
}

interface Handoff { from: string; to: string; responsibility: string; maxHops: number; }

interface ExecutionPlan {
  team: string; title: string;
  failurePolicy: "fail_fast" | "best_effort" | "required_optional";
  steps: PlanStep[];            // 실행 순서대로
  workers: Worker[];            // steps와 handoffs에 나오는 모든 Worker
  handoffs: Handoff[];
  implemented: boolean;         // Agent 실행이 구현됐는지. 지금은 false
}

interface ReportSummary {
  id: number;
  symbol: string; name: string; market: Market;
  status: SharedState["status"];
  currentStep: string | null;
  requestedBy: string;          // 신청한 팀원의 닉네임
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}

interface ReportDetail extends ReportSummary {   // Snapshot
  content: string | null;       // 리포트 본문 (Markdown). Agent 구현 전에는 null
  state: SharedState;
  trace: TraceEvent[];          // step 오름차순
  plan: ExecutionPlan;
}
```

## 엔드포인트

| 메서드·경로 | 요청 | 응답 |
|---|---|---|
| `GET /api/reports/plan` | – | `200 ExecutionPlan` (YAML Registry에서 읽은 실행 계획) |
| `GET /api/reports?symbol=` | 페이지, `symbol` 선택 | `200 {"count", "results": ReportSummary[]}` (팀 전체 공용, 최신순) |
| `POST /api/reports` | `{"symbol"}` | `201 ReportDetail` · 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 그것을 `200`으로 · 없는 종목 `400` · 증권사 조회 불가 `503` |
| `GET /api/reports/{id}` | – | `200 ReportDetail` · `404` (**Snapshot API**: 새로고침·연결 복구에 쓴다) |
| `GET /api/reports/{id}/events` | 헤더 `Last-Event-ID` 또는 `?after=<step>` | `200 text/event-stream` (**SSE**) · 미로그인 `401` JSON · `404` |

SSE 형식 (실행 Event를 발생 즉시 한 방향으로 전달):
- `event: trace` / `id: <step>` / `data: <TraceEvent JSON>` — `after`(또는 `Last-Event-ID`)보다 큰 step만, 순서대로.
- `event: state` / `data: <SharedState JSON>` — 상태가 바뀔 때.
- `event: end` / `data: {"status": ...}` — 전체 종료(completed·failed)이고 남은 사건이 없을 때 보내고 연결을 닫는다.
- 15초마다 `: keep-alive` 주석 줄. 서버는 한 연결을 60초 뒤 닫는다 (브라우저 `EventSource`가 `Last-Event-ID`로 다시 붙는다).
- **SSE가 실행 상태의 유일한 저장소가 되면 안 된다.** 상태와 Trace는 DB에 있고, 프론트는 먼저 Snapshot을 받은 뒤 SSE로 이어 받는다.
  SSE가 끊기거나 안 되면 Snapshot을 3초 간격으로 다시 받는다 (폴링). `plan.implemented`가 false이고 status가 `requested`면 SSE를 열지 않는다.
