// docs/API.md의 타입을 그대로 옮긴 것. 계약이 바뀌면 이 파일도 같이 고친다.

export type Market = "KR" | "US";
export type Currency = "KRW" | "USD";

export interface Me {
  id: number;
  username: string; // 로그인 아이디
  nickname: string; // 랭킹에 보이는 이름 (기본값은 아이디)
  isPublic: boolean; // 내 정보 공개 (켜면 랭킹보드에 수익률이 나온다). 기본 false
  isStaff: boolean;
}

export interface Quote {
  symbol: string;
  name: string | null;
  currency: Currency;
  price: number | null; // 현재가. 조회 실패면 null
  prevClose: number | null; // 전 거래일 종가
  change: number | null; // price - prevClose
  changeRate: number | null; // price / prevClose - 1
}

export interface StockItem {
  symbol: string;
  name: string;
  exchange: string; // KOSPI | KOSDAQ | NYSE | NASDAQ | AMEX
  market: Market;
}

export interface Candle {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface StockDetail {
  symbol: string;
  name: string;
  exchange: string;
  market: Market;
  currency: Currency;
  quote: Quote;
  candles: Candle[]; // 일봉, 과거 → 최신, 최근 120개
  warnings: string[];
}

export interface MarketStatus {
  markets: { market: Market; isOpen: boolean; opensAt: string | null; closesAt: string | null }[];
  halted: boolean; // 새 모의 매수 중단 스위치
  brokerReady: boolean; // 증권사 조회 키가 있는지
}

export type OrderStatus = "ENTRY_PENDING" | "EXIT_WATCHING" | "CLOSED" | "CANCELED";

export interface Order {
  id: number;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  orderType: "MARKET" | "LIMIT";
  limitPrice: number | null;
  quantity: number;
  status: OrderStatus;
  entryPrice: number;
  fillPrice: number | null;
  filledAt: string | null;
  targetPrice: number | null;
  stopPrice: number | null;
  expireDate: string | null;
  exitPrice: number | null;
  exitReason: "TARGET" | "STOP" | "EXPIRED" | "MANUAL" | null;
  closedAt: string | null;
  pnlKrw: number | null;
  note: string | null;
  createdAt: string;
}

export interface Position {
  orderId: number;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  quantity: number;
  avgPrice: number;
  lastPrice: number | null;
  costKrw: number;
  valueKrw: number;
  profitKrw: number;
  profitRate: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  expireDate: string | null;
  filledAt: string;
}

export interface AccountSummary {
  initialCapitalKrw: number;
  cashKrw: number;
  holdingsValueKrw: number;
  equityKrw: number;
  investedKrw: number;
  profitKrw: number;
  profitRate: number;
  pendingKrw: number | null;
  buyingPowerKrw: number | null;
  positions: Position[];
  notes: string[];
  asOf: string;
}

export interface Fill {
  id: number;
  orderId: number;
  symbol: string;
  name: string;
  currency: Currency;
  side: "BUY" | "SELL";
  price: number;
  quantity: number;
  amount: number;
  commission: number;
  tax: number;
  cashChangeKrw: number;
  reason: "ENTRY" | "TARGET" | "STOP" | "EXPIRED" | "MANUAL";
  filledAt: string;
}

export interface Reservation {
  id: number;
  kind: "BUY" | "SELL";
  symbol: string;
  name: string;
  market: Market;
  quantity: number;
  orderId: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  days: number | null;
  runAt: string | null;
  createdAt: string;
}

export interface OrderResult {
  order: Order | null;
  reservation: Reservation | null;
  message: string;
}

export interface RankingEntry {
  rank: number;
  nickname: string;
  profitRate: number;
  isMe: boolean;
}

export interface Ranking {
  results: RankingEntry[];
  me: { isPublic: boolean; rank: number | null; profitRate: number };
  asOf: string;
}

export type Verdict = "BUY" | "PASS";

export interface Scenario {
  proposer: string;
  selected: boolean;
  passed: boolean | null;
  score: number | null;
  probability: number | null;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  holdingDays: number;
  rationale: string[];
  invalidation: string;
  rejectReasons: string[];
}

export interface AnalysisSummary {
  id: number;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  analyzedAt: string;
  verdict: Verdict;
  priceAtAnalysis: number | null;
  best: Scenario | null;
  scenarioCount: number;
  requestedBy: string | null;
  costUsd: number | null;
}

export interface ResearchFinding {
  claim: string;
  direction: string | null;
  date: string | null;
  sourceTitle: string | null;
}

export interface AnalysisDetail extends AnalysisSummary {
  scenarios: Scenario[];
  news: string[];
  research: { researcher: string; findings: ResearchFinding[] }[];
  indicators: Record<string, number | string | null>;
  errors: string[];
}

export interface Job {
  id: number;
  type: "analyze";
  status: "QUEUED" | "RUNNING" | "DONE" | "FAILED";
  result: { analysisIds: number[] } | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface AnalysisQuota {
  usedToday: number;
  limitPerUser: number;
  remaining: number;
  estimatedCostUsd: number;
  enabled: boolean;
}

export interface Page<T> {
  count: number;
  results: T[];
}

export interface OrderRequest {
  symbol: string;
  quantity: number;
  orderType: "MARKET" | "LIMIT";
  limitPrice?: number;
  targetPrice?: number;
  stopPrice?: number;
  days?: number;
}

export interface EquityPoint {
  day: string;
  equityKrw: number;
}

// ---------------------------------------------------------------- AI 리포트 (Agents Orchestration과 Trace)

export type TraceStatus = "started" | "completed" | "failed" | "blocked" | "skipped";
// action과 details는 docs/tasks/00-공통.md 9절. 모르는 값도 그대로 보여 준다.
// agent_failed는 두 가지: details.final = false 는 LLM 호출 한 번의 실패(재시도·전환으로 이어진다), 그 밖은 그 Worker를 포기한 것.
export type ErrorType = "timeout" | "server_error" | "bad_output" | "unknown";

export interface TraceEvent {
  step: number; // 전체 실행에서의 사건 순서 (1부터)
  actor: string; // Worker id 또는 Guard("join_guard", "handoff_guard") 또는 "orchestrator"
  action: string;
  status: TraceStatus;
  provider: string | null; // 실제 LLM 실행 정보 (Guard·Orchestrator 사건은 null)
  model: string | null;
  latencyMs: number | null; // 응답 또는 실패까지 걸린 시간
  details: Record<string, unknown>; // 오류와 추가 정보
  at: string;
}

export type ReportStatus = "requested" | "running" | "completed" | "failed";

export interface SharedState {
  // Orchestrator만 갱신한다
  taskId: string; // "report-<id>"
  status: ReportStatus;
  currentStep: string | null; // 실행 계획의 step id
  results: Record<string, unknown>; // 출력 계약을 통과한 Worker 결과만
  errors: Record<string, string>; // Worker id → 오류
  completedAgents: string[];
  failedAgents: string[];
}

export interface Worker {
  id: string;
  title: string;
  goal: string;
  provider: string | null; // 아직 정하지 않았으면 null
  model: string | null;
  fallbacks?: string[]; // 주 모델이 실패하면 차례로 쓰는 대체 모델 (서버가 아직 안 낼 수 있다)
  outputContract: string; // 역할별 출력 계약 이름
}

export interface PlanStep {
  id: string;
  title: string;
  mode: "parallel" | "sequential";
  workers: string[]; // Worker id
  required: string[]; // 필수 Worker (실패하면 Join을 막는다)
  optional: string[]; // 선택 Worker (실패해도 계속한다)
  dependsOn: string[]; // 먼저 끝나야 하는 step id
  join: boolean; // 앞 단계 결과를 Join Guard로 확인한 뒤 실행하는지
  timeoutSec: number | null;
  retry?: { target: string; maxRounds: number } | null; // 검토 단계: RETRY 판정이면 target Worker를 다시 실행
}

/** 장애 주입 설정 (docs/tasks/00-공통.md 5절). 리포트 워크플로우에만 적용된다. */
export interface ChaosConfig {
  enabled: boolean;
  probability: number; // 0~1. 호출 하나가 실패할 확률
  errorTypes: ErrorType[]; // unknown 제외
  workers: string[] | null; // 대상 Worker (null이면 전부)
  scope: "primary" | "all"; // primary: 주 모델 호출만 실패 · all: 대체 모델까지 실패
  seed: number;
}
/** POST /api/reports의 chaos: enabled만 필수, 나머지는 서버 기본값. */
export type ChaosRequest = Pick<ChaosConfig, "enabled"> & Partial<Omit<ChaosConfig, "enabled">>;

/** 한 리포트의 장애·복구 요약 (셈법은 00-공통.md 9절. 화면은 src/lib/recovery.ts로 Trace에서도 센다). */
export interface RecoverySummary {
  failures: number;
  recovered: number;
  unrecovered: number;
  injected: number;
  recoveryMs: number | null; // 복구된 건의 복구 시간 합
  models: Record<string, string>; // Worker id → 최종적으로 답한 모델
}

export interface RecoveryStats {
  from: string;
  to: string;
  days: number;
  reports: number;
  reportsWithFailures: number;
  failures: number;
  recovered: number;
  unrecovered: number;
  injected: number;
  autoRecoveryRate: number | null; // recovered ÷ failures × 100
  meanRecoveryMs: number | null;
  byErrorType: { errorType: ErrorType; failures: number; recovered: number }[];
  byWorker: { worker: string; failures: number; recovered: number }[];
  recent: {
    reportId: number;
    symbol: string;
    worker: string;
    errorType: ErrorType;
    injected: boolean;
    recovered: boolean;
    recoveryMs: number | null;
    at: string;
  }[];
}

export interface ScreeningResult {
  market: Market;
  at: string;
  rankCount: number;
  eligibleCount: number;
  checked: number;
  picks: Record<string, unknown>[]; // 점수 순. symbol · name · score · tradingAmountRank 등
  dropped: Record<string, unknown>[];
  excluded: Record<string, unknown>[];
  reportIds: number[];
}

export interface Handoff {
  from: string;
  to: string;
  responsibility: string;
  maxHops: number;
}

export type FailurePolicy = "fail_fast" | "best_effort" | "required_optional";

export interface ExecutionPlan {
  team: string;
  title: string;
  failurePolicy: FailurePolicy;
  steps: PlanStep[]; // 실행 순서대로
  workers: Worker[]; // steps와 handoffs에 나오는 모든 Worker
  handoffs: Handoff[];
  implemented: boolean; // Agent 실행이 구현됐는지. 지금은 false
}

export interface ReportSummary {
  id: number;
  symbol: string;
  name: string;
  market: Market;
  status: ReportStatus;
  currentStep: string | null;
  requestedBy: string; // 신청한 팀원의 닉네임. 자동 리포트는 "자동"
  // 아래 넷은 docs/API.md "(추가)" 항목: 서버가 아직 안 낼 수 있다
  source?: "user" | "auto";
  chaosEnabled?: boolean;
  costUsd?: number | null;
  hasPdf?: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ReportDetail extends ReportSummary {
  // Snapshot
  content: string | null; // 리포트 본문 (Markdown). Agent 구현 전에는 null
  state: SharedState;
  trace: TraceEvent[]; // step 오름차순
  plan: ExecutionPlan;
  chaos?: ChaosConfig | null; // (추가)
  recovery?: RecoverySummary; // (추가)
}
