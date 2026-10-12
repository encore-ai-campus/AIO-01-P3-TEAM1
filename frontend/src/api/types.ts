// docs/API.md의 타입을 그대로 옮긴 것. 계약이 바뀌면 이 파일도 같이 고친다.
// "구현 예정(2026-10-04, Claude)" 필드도 계약대로 적는다 (서버가 아직 안 내는 동안은 가짜 API(src/mocks)가 낸다).
// "(추가)"로 표시된 리포트 필드처럼 서버가 아직 안 낼 수 있는 것은 ?로 둔다.

export type Market = "KR" | "US";
export type Currency = "KRW" | "USD";

export interface Me {
  id: number;
  username: string; // 로그인 아이디
  nickname: string; // 랭킹에 보이는 이름 (기본값은 아이디)
  isPublic: boolean; // 내 정보 공개 (켜면 랭킹보드에 수익률이 나온다). 기본 false
  isStaff: boolean;
  beginnerMode: boolean; // 주린이모드 (켬 = 쉬운 보기). 진단 전 기본 true. InvestorProfile.beginnerMode와 같은 값
}

// ---------------------------------------------------------------- 투자자 프로필 (docs/API.md "계정")

export type ExperienceLevel = "intro" | "novice" | "intermediate" | "expert"; // 입문 · 초급 · 중급 · 숙련
export type RiskProfile = "stable" | "stable_seeking" | "neutral" | "active" | "aggressive";
// 안정형 · 안정추구형 · 위험중립형 · 적극투자형 · 공격투자형

export type InvestorProduct = "deposit" | "fund_etf" | "kr_stock" | "us_stock" | "derivatives";

/** 투자 성향·경험 진단 7문항의 답 (영문 코드). 점수표는 docs/API.md "투자자 프로필과 주린이모드". */
export interface InvestorAnswers {
  q1: "none" | "under_1y" | "1_3y" | "over_3y";
  q2: InvestorProduct[]; // 여럿 고름 (1개 이상, deposit은 혼자만)
  q3: "never" | "yearly" | "monthly" | "daily";
  q4: "unknown" | "heard" | "explain";
  q5: "no_loss" | "loss_10" | "loss_20" | "more";
  q6: "years" | "weeks" | "intraday";
  q7: "practice" | "growth" | "short_term";
}

export interface InvestorProfile {
  beginnerMode: boolean; // 지금 주린이모드. 진단 전 기본 true
  answers: InvestorAnswers | null; // 진단 전이면 null (아래 여섯도 null)
  experienceScore: number | null; // 0~11
  experienceLevel: ExperienceLevel | null;
  riskScore: number | null; // 0~8
  riskProfile: RiskProfile | null;
  recommendedBeginnerMode: boolean | null; // 경험 단계가 intro·novice면 true
  assessedAt: string | null; // 마지막 진단 제출 시각
}

// ---------------------------------------------------------------- 모의 트레이딩 (시세는 실시간, 그 밖의 가격은 장마감 기준 — docs/API.md 공통 규칙 "실시간 시세"·"장마감 기준")

/** 시세의 가격 기준: live 증권사 현재가(실시간) · close 직전 정규장 종가 (현재가를 받지 못한 종목). */
export type QuoteBasis = "live" | "close";

export interface Quote {
  symbol: string;
  name: string | null;
  currency: Currency;
  price: number | null; // live: 증권사 현재가 · close: 직전 정규장 종가 (종가 봉의 종가). 둘 다 못 받으면 null
  prevClose: number | null; // live: 그 가격이 속한 거래일의 전 거래일 종가 · close: 그 전 거래일 종가. 일봉이 없으면 null
  change: number | null; // price - prevClose
  changeRate: number | null; // price / prevClose - 1
  asOf: string | null; // live: 현재가를 받은 시각(서버 시각) · close: 종가 봉 날짜의 정규장 종료 시각. price가 null이면 null
  basis: QuoteBasis; // 가격 기준 — 화면은 이 값으로 표기("실시간 · 15:20:31" / "10월 2일(금) 15:30 장마감 기준")를 고른다
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
  quote: Quote; // 실시간 (현재가를 받지 못하면 장마감 기준)
  candles: Candle[]; // 일봉 최근 120개, 과거 → 최신. 오늘 정규장이 열렸으면 마지막은 오늘 진행 중인 봉
  asOf: string | null; // 마지막 봉이 오늘 진행 중이면 quote.asOf(받은 시각), 완성 봉이면 그 봉 날짜의 정규장 종료 시각. 일봉이 없으면 null
  warnings: string[];
}

export interface MarketSession {
  market: Market;
  isOpen: boolean; // 지금 정규장인지
  opensAt: string | null; // 다음(또는 오늘) 정규장 시작
  closesAt: string | null; // 지금 열려 있으면 오늘 종료 시각
  closeDate: string | null; // 그 시장의 기준일 (장마감 기준). 장 달력을 못 받으면 null
  lastCloseAt: string | null; // 기준일의 정규장 종료 시각. 장 달력을 못 받으면 null
}

export interface MarketStatus {
  markets: MarketSession[];
  halted: boolean; // 새 모의 매수 중단 스위치
  brokerReady: boolean; // 증권사 조회 키가 있는지
  quoteProvider: string; // 시세 출처 이름 (화면 아래 출처 줄): "토스증권 Open API(개발)" | "키움증권 REST API"
}

export type OrderStatus = "ENTRY_PENDING" | "EXIT_WATCHING" | "CLOSED" | "CANCELED";

/** 보유 방식: swing 스윙(목표·손절·기한 자동 매도) · long 장기 보유(자동 매도 없음). */
export type HoldingStyle = "swing" | "long";

/** 청산 사유. 화면은 모르는 값이면 그대로 보인다. */
export type ExitReason = "TARGET" | "STOP" | "EXPIRED" | "MANUAL";

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
  style: HoldingStyle; // 주문할 때 정해지고 바뀌지 않는다
  entryPrice: number;
  fillPrice: number | null;
  filledAt: string | null;
  targetPrice: number | null; // long이면 셋 다 null
  stopPrice: number | null;
  expireDate: string | null;
  exitPrice: number | null;
  exitReason: ExitReason | null;
  closedAt: string | null;
  pnlKrw: number | null; // 실현 손익 (수수료·세금 포함)
  note: string | null; // 취소 사유 등
  createdAt: string;
}

/** 보유 중(EXIT_WATCHING)인 주문의 평가 (장마감 기준). */
export interface Position {
  orderId: number;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  style: HoldingStyle; // 스윙·장기 배지
  quantity: number;
  avgPrice: number; // 매수 체결가
  lastPrice: number | null; // 직전 정규장 종가. 못 받으면 null (그때는 체결가로 평가)
  costKrw: number;
  valueKrw: number;
  profitKrw: number;
  profitRate: number | null;
  targetPrice: number | null;
  stopPrice: number | null;
  expireDate: string | null;
  filledAt: string;
  /**
   * 평가에 쓴 가격 (docs/API.md "장마감 기준", 2026-10-08 DECISIONS 23장). 없으면 "close"로 본다.
   * close: 직전 장마감 종가 · today_fill: 장마감 기준 시각 뒤에 산 보유(오늘 산 종목)라 체결가로 평가(손익 0, 장 마감 뒤 종가로 바뀜)
   * · fill: 종가를 받지 못해 체결가로 평가
   */
  priceBasis?: PositionPriceBasis;
}

export type PositionPriceBasis = "close" | "today_fill" | "fill";

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
  pricesAsOf: PricesAsOf; // 평가에 쓴 종가의 기준 시각 (보유가 있는 시장만. 없으면 {})
  asOf: string; // 계산 시각 (응답을 만든 때)
}

/** 시장별 종가 기준 시각. */
export type PricesAsOf = Partial<Record<Market, string>>;

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
  cashChangeKrw: number; // 현금 증감 (매수 음수)
  reason: "ENTRY" | ExitReason; // 매수 체결은 ENTRY, 매도 체결은 청산 사유
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
  style: HoldingStyle | null; // BUY 예약의 보유 방식 ("swing" | "long"). SELL이면 null
  runAt: string | null; // 실행 예정 (다음 정규장 시작)
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

/** 수익률은 장마감 기준 평가 (AccountSummary.profitRate와 같은 계산). */
export interface Ranking {
  results: RankingEntry[]; // 내 정보 공개(isPublic)를 켠 사용자만
  me: { isPublic: boolean; rank: number | null; profitRate: number };
  pricesAsOf: PricesAsOf; // 평가에 쓴 종가의 기준 시각 (누군가 보유한 시장만)
  asOf: string; // 계산 시각
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
  priceAtAnalysis: number | null; // 분석 시각의 가격 (장마감 기준이 아니다. 화면 "분석 시각 가격")
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

export interface NewsItem {
  title: string;
  source: string | null; // 매체 이름
  publishedAt: string | null; // 게시 시각 (ISO)
}

export interface AnalysisDetail extends AnalysisSummary {
  scenarios: Scenario[];
  news: string[]; // 뉴스 제목 (예전 형식)
  newsItems: NewsItem[]; // 뉴스 제목 + 매체 + 게시 시각, news와 같은 순서. 링크는 내지 않는다
  newsProvider: string; // 뉴스 출처 표기 "Google 뉴스 검색 결과" (화면이 뉴스 칸 아래에 적는다)
  dataAsOf: string | null; // 지표·일봉 자료의 기준일 YYYY-MM-DD (엔진 스냅숏의 lastCandleDate)
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
  // "swing"(목표·손절 둘 다 필요) | "long"(목표·손절·기한을 받지 않음). 없으면 셋이 모두 없을 때 long, 아니면 swing.
  style?: "swing" | "long";
}

/** PATCH /api/orders/{id}. long 주문은 셋 다 받지 않는다 (400). */
export interface OrderPatch {
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
  fallbacks: string[]; // 주 모델이 실패하면 차례로 쓰는 대체 모델
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
  retry: { target: string; maxRounds: number } | null; // 검토 단계: RETRY 판정이면 target Worker를 다시 실행
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

/** 선별 결과의 AI 선정안 한 줄 (선정 Guard 전 원문, SelectionDraft.picks). */
export interface ScreeningAiPick {
  symbol: string;
  rank: number;
  reason: string;
  evidence: string[];
}

/** 선정 Guard가 뺀 종목. stage: 후보 밖 · 투자유의 · 공시 위험 · 같은 테마가 이미 둘. */
export interface ScreeningFiltered {
  symbol: string;
  name: string | null;
  reason: string;
  stage: "candidates" | "warnings" | "filing" | "theme";
}

/**
 * 오늘의 선별 결과 (RUNS_DIR/screening/<날짜>-<시장>.json 그대로). 아래 "선정 팀" 키는 2026-10-07에 더했다 —
 * 그 전 파일(또는 자동 리포트를 끈 날)에는 없으므로 모두 선택이다.
 */
export interface ScreeningResult {
  market: Market;
  at: string;
  rankCount: number;
  eligibleCount: number;
  checked: number;
  /**
   * 최종 종목 (최대 3). symbol · name · score · tradingAmountRank 등 점수·RSI는 늘 코드 값.
   * 선정 팀이 끝나면 aiRank · aiReason · theme · filledByRule(규칙 점수로 채운 종목)이 붙는다.
   * 다시 시도로 더한 종목은 retryRound(1|2)가 붙는다 (picks = 그날 리포트한 종목 전부).
   */
  picks: Record<string, unknown>[];
  dropped: Record<string, unknown>[];
  excluded: Record<string, unknown>[];
  reportIds: number[];
  recommendationIds?: number[]; // 그날 만든 자동 추천 (AUTO_RECOMMEND=demo). 서버가 아직 안 낼 수 있다
  candidates?: Record<string, unknown>[]; // 규칙을 통과한 후보 전부 (점수 순, 최대 30). picks와 같은 모양
  selection?: { reportId: number | null; status: "running" | "done" } | null; // 선정 팀 실행 (team=stock_selection 리포트)
  selectedBy?: "ai" | "rule" | null; // null = 아직 선정 중 (picks는 그때까지 규칙 상위)
  fallbackReason?: string | null; // selectedBy가 rule일 때 사유 코드 (ReportFailureReason + no_candidates)
  aiPicks?: ScreeningAiPick[]; // AI 선정안 원문 (Guard 전). 없으면 []
  filtered?: ScreeningFiltered[]; // 선정 Guard가 뺀 종목
  coverSent?: boolean; // 하루 묶음 표지를 보냈는지
  retries?: number; // 다시 시도한 횟수 0~2 (손익비 기준을 넘는 추천이 없어 다음 종목으로 다시 냄)
}

export interface Handoff {
  from: string;
  to: string;
  responsibility: string;
  maxHops: number;
}

export type FailurePolicy = "fail_fast" | "best_effort" | "required_optional";

/** 리포트 팀: 종목 리포트(기본) · 매매 종목 선정 (하루 한 번, 자동). */
export type ReportTeam = "stock_report" | "stock_selection";

export interface ExecutionPlan {
  team: ReportTeam;
  title: string;
  failurePolicy: FailurePolicy;
  steps: PlanStep[]; // 실행 순서대로
  workers: Worker[]; // steps와 handoffs에 나오는 모든 Worker
  handoffs: Handoff[];
  implemented: boolean; // Agent 실행이 구현됐는지
}

export interface ReportSummary {
  id: number;
  symbol: string;
  name: string;
  market: Market;
  status: ReportStatus;
  currentStep: string | null;
  requestedBy: string; // 신청한 팀원의 닉네임. 자동 리포트는 "자동"
  team?: ReportTeam; // 없으면 stock_report (예전 서버). stock_selection은 목록에 ?team=stock_selection일 때만 온다
  // 아래 넷은 docs/API.md "(추가)" 항목: 서버가 아직 안 낼 수 있다
  source?: "user" | "auto";
  chaosEnabled?: boolean;
  costUsd?: number | null;
  hasPdf?: boolean;
  /** 내가 신청했고 끝난(completed·failed) 종목 리포트면 true → DELETE /api/reports/{id} (2026-10-08, DECISIONS 25장). 자동 리포트·선정 실행·남의 것은 false */
  canDelete: boolean;
  opinion: ReportOpinion | null; // AI 의견 = results.report_agent.verdict. status가 completed일 때만, 그 밖은 null
  oneLiner: string | null; // 한 줄 요약 = results.report_agent.oneLiner (80자). opinion과 같은 규칙
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** AI 의견: buy 긍정적 · hold 지켜보기 · avoid 부정적 (화면 문구는 lib/plainText.ts). */
export type ReportOpinion = "buy" | "hold" | "avoid";

/** GET /api/reports/quota — 하루 리포트 한도 (D-7). */
export interface ReportQuota {
  limit: number | null; // AI_DAILY_REPORTS_PER_USER (기본 null = 무제한, 2026-10-08)
  used: number; // 오늘(KST) 신청한 리포트 중 한도에 세는 수 (장애 주입 없이 failed로 끝난 것은 빼고)
  remaining: number | null; // max(limit − used, 0), 무제한이면 null. 0이면 POST /api/reports가 429 {detail, limit, used}
  resetsAt: string; // 다음 날 00:00 KST
}

/** 리포트 실패 사유 코드 (Trace의 마지막 workflow_failed.details.reason). 모르는 값도 올 수 있다. */
export type ReportFailureReason =
  | "join_blocked"
  | "review_failed"
  | "timeout"
  | "engine_restarted"
  | "exception"
  | "agent_failed"
  | "no_llm"
  | "expired";

export interface ReportDetail extends ReportSummary {
  // Snapshot
  content: string | null; // 리포트 본문 (Markdown). Agent 구현 전에는 null
  state: SharedState;
  trace: TraceEvent[]; // step 오름차순
  plan: ExecutionPlan;
  chaos?: ChaosConfig | null; // (추가)
  recovery?: RecoverySummary; // (추가)
}

// ---------------------------------------------------------------- AI 추천 · 매매 계획 · 자동매매 · 알림 (docs/API.md 끝 절)

export type RecommendationSource = "report" | "analysis" | "demo";
export type RecommendationStatus = "open" | "expired"; // open: validUntil 전이라 활성화할 수 있음
export type RecommendationExpiredReason = "deadline" | "below_stop" | "above_target";
export type RiskLevel = "low" | "medium" | "high";

export interface Recommendation {
  id: number;
  source: RecommendationSource;
  sourceId: number | null; // report면 리포트 id, analysis면 분석 id, demo면 null
  requestedBy: string | null; // 신청한(또는 시연 추천을 만든) 팀원의 닉네임. 자동이면 null
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  priceAtCreation: number | null; // 추천을 만들 때의 직전 장마감 종가 (출처와 무관)
  entryPrice: number; // 지정가로 주문한다
  targetPrice: number;
  stopPrice: number; // 0 < stopPrice < entryPrice < targetPrice
  holdingDays: number; // 거래일 1~20
  targetReturn: number; // targetPrice / entryPrice - 1 (비용 전)
  stopLossRate: number; // stopPrice / entryPrice - 1 (음수, 비용 전)
  rewardRisk: number; // 손익비 (비용 반영, 리스크 엔진과 같은 계산)
  probability: number; // 0~1
  probabilityAssumed: boolean; // AI가 확률을 주지 않아 0.5로 둔 경우
  expectedReturn: number; // 기대수익률 (비용 반영)
  confidence: number | null; // 0~100
  summary: string;
  reasons: string[];
  risks: string[];
  riskLevel: RiskLevel | null;
  status: RecommendationStatus;
  /** status가 expired인 까닭: 기한 지남 / 가격이 이미 손절가 이하 / 이미 목표가 이상 (2026-10-08, DECISIONS 25장). open이면 null */
  expiredReason: RecommendationExpiredReason | null;
  validUntil: string; // 활성화 기한 = 계획의 진입 기한
  createdAt: string;
  myPlan: { id: number; status: TradePlanStatus } | null;
  planCount: number;
  /**
   * 계좌와 무관하게 지금 이 추천의 시작(활성화)을 막는 사유 코드 (reward_risk_low · ev_negative · expired · halted 중, 2026-10-08 DECISIONS 23장).
   * 비어 있어도 내 계좌 사정(현금·한도·같은 종목)으로 막힐 수 있다 — 최종 판단은 RiskPreview. 없으면 []로 본다.
   */
  blockedBy?: ReasonCode[];
  /** 내가 만든(requestedBy가 나) 제안이면 true → DELETE /api/recommendations/{id} (2026-10-08, DECISIONS 25장). 자동·남의 것은 false */
  canDelete: boolean;
}

/**
 * 실행 불가 사유 코드 (docs/API.md "실행 불가 사유 코드"). 서버는 이 표의 코드만 낸다.
 * 화면은 모르는 코드면 같은 자리의 사유 원문을 보인다 (lib/plainText.ts reasonSentence).
 */
export type ReasonCode =
  | "reward_risk_low"
  | "ev_negative"
  | "daily_loss_limit"
  | "daily_trades_limit"
  | "warning_stock"
  | "size_too_small"
  | "budget_too_small"
  | "expired"
  | "plan_exists"
  | "position_exists"
  | "halted"
  | "price_passed"
  | "cash_short"
  | "position_limit"
  | "total_limit";

/** 넣을 돈을 정한 방식 (2026-10-11, docs/DECISIONS.md 28장): percent = 매수 가능 금액의 %, amount = 원. */
export type BudgetMode = "percent" | "amount";

/**
 * 리스크 엔진이 "내 계좌"로 계산한 결과 (활성화 전 확인용). 자산은 장마감 기준.
 * 2026-10-11: 수량 = 내가 정한 금액 ÷ 1주 매수 비용(진입가 × (1 + 수수료) × 환율). 금액이 없으면 크기 계산 없이 점검만
 * (quantity·amountKrw·expectedProfitKrw·maxLossKrw 0, limitedBy·maxLossRate null, largeLoss false).
 */
export interface RiskPreview {
  approved: boolean; // 리스크 엔진 통과 (금액이 없으면 크기와 무관한 점검만)
  activatable: boolean; // approved && 추천이 open && 같은 종목 진행 중 계획·주문 없음 && 중단 스위치 꺼짐 (금액이 없으면 "금액만 정하면 시작 가능") (manualStart면 skippedCodes를 뺀 남은 사유로)
  reasons: string[]; // 활성화할 수 없는 사유 (activatable이면 [])
  reasonCodes: string[]; // reasons[i]의 코드 = reasonCodes[i] (같은 길이·같은 순서). 값은 ReasonCode
  skippedReasons: string[]; // 2026-10-12 시연용 수동 시작(?manualStart=1, DECISIONS 31장)으로 건너뛴 사유 원문 — reasons에는 들지 않는다. 일반 미리 보기는 []
  skippedCodes: string[]; // 같은 길이·순서의 코드(reward_risk_low · ev_negative 중). manual이면 approved는 원래 판정(false), activatable은 남은 사유로만
  quantity: number; // 주문할 수량 (국내는 정수 주)
  amountKrw: number; // 매수 금액 (원화 환산)
  expectedProfitKrw: number; // 목표가 도달 시 이익 (비용 반영)
  maxLossKrw: number; // 손절 시 손실 (비용 반영, 양수)
  limitedBy: string | null; // "내가 정한 금액" (2026-10-11). 금액이 없으면 null
  budgetMode: BudgetMode | null; // 요청이 budgetPercent면 "percent", budgetKrw면 "amount", 없으면 null
  budgetPercent: number | null; // 요청한 % (1~100 정수, 매수 가능 금액 기준)
  budgetKrw: number | null; // 내가 정한 금액 (원). percent면 floor(buyingPowerKrw × % / 100)
  buyingPowerKrw: number; // 매수 가능 금액 = 현금 − 대기 매수 (음수면 0). budgetPercent의 기준
  equityKrw: number; // 총자산 (장마감 기준). maxLossRate의 분모
  maxLossRate: number | null; // maxLossKrw ÷ equityKrw. 금액이 없거나 총자산이 0 이하면 null
  largeLoss: boolean; // 손절 시 손실이 총자산의 1%를 넘음 — 경고만 (막지 않는다)
  lastPrice: number | null; // 직전 정규장 종가 (못 받으면 null). 목표가·손절가와 비교하는 가격 (price_passed)
  lastPriceAsOf: string | null; // lastPrice의 기준 시각 (Quote.asOf와 같은 규칙)
  priceBasis: "close"; // 가격 기준. 지금은 "close" 하나뿐 (총자산 평가 — 수량·금액은 진입가로 계산)
}

export type TradePlanStatus = "active" | "entry_pending" | "holding" | "closed" | "cancelled" | "expired" | "failed";

export interface TradePlan {
  id: number;
  recommendationId: number;
  symbol: string;
  name: string;
  market: Market;
  currency: Currency;
  source: RecommendationSource;
  status: TradePlanStatus;
  via: "web" | "discord";
  manualStart: boolean; // 2026-10-12 시연용 수동 시작 (DECISIONS 31장) — 손익비·기대값 점검을 건너뛰고 활성화한 계획
  quantity: number;
  budgetMode: BudgetMode | null; // 2026-10-11. null = 그 전에 활성화한 계획 (리스크 엔진이 수량을 정함)
  budgetPercent: number | null; // percent면 그 % (매수 가능 금액 기준)
  budgetKrw: number | null; // 내가 정한 금액 (원, percent면 활성화 순간 바꾼 값)
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  holdingDays: number;
  entryDeadline: string; // 진입 기한 (= 추천의 validUntil)
  orderId: number | null;
  fillPrice: number | null;
  filledAt: string | null;
  exitPrice: number | null;
  exitReason: ExitReason | null;
  closedAt: string | null;
  pnlKrw: number | null;
  failureReason: string | null; // failed·expired·cancelled의 사유 (사람이 읽는 말, 전문가 보기)
  activatedAt: string;
  updatedAt: string;
}

export type PlanEventKind =
  | "activated" // details: {via, budgetKrw, acknowledged} + manual이면 {manualStart, skippedCodes} (시연용 수동 시작, DECISIONS 31장)
  | "risk_checked" // + manual이면 {manualStart, skippedCodes, skippedReasons} (approved는 false)
  | "order_placed"
  | "order_requeued"
  | "filled"
  | "exit_requested"
  | "closed"
  | "cancelled"
  | "expired"
  | "failed";

export interface PlanEvent {
  step: number; // 계획별 1부터
  kind: PlanEventKind | (string & {}); // 모르는 값도 그대로 보여 준다
  message: string;
  details: Record<string, unknown>;
  at: string;
}

export interface TradePlanDetail extends TradePlan {
  recommendation: Recommendation;
  events: PlanEvent[]; // step 오름차순
}

export type NotificationKind =
  | "recommendation"
  | "plan_activated"
  | "order_placed"
  | "order_requeued"
  | "filled"
  | "closed"
  | "cancelled"
  | "expired"
  | "failed"
  | "system"
  | "report_completed" // 리포트 완성 (이 리포트로 추천이 생기면 보내지 않는다)
  | "report_failed" // 리포트 실패 (본문은 실패 사유 코드의 쉬운 문장)
  | "daily_move" // 오늘의 내 종목 뉴스 묶음 (사용자당 하루 1개, 웹만)
  | "thesis_check"; // 펀더멘털 점검 결과가 나빠짐 (웹만)

export interface Notification {
  id: number;
  kind: NotificationKind | (string & {});
  title: string;
  body: string;
  link: string | null; // 웹 경로 ("/plans/3")
  createdAt: string;
  readAt: string | null;
}

export interface NotificationPage extends Page<Notification> {
  unreadCount: number;
}

export interface NotificationSettings {
  discordUserId: string | null; // 숫자 17~20자리
  discordEnabled: boolean;
  webhookConfigured: boolean;
}

export interface NotificationTestResult {
  detail: string;
  discord: "queued" | "not_configured" | "disabled";
}

/** POST /api/recommendations/{id}/activate 본문. acknowledged: 실행 확인 체크리스트를 모두 켰는지 (없으면 false). */
/** budgetPercent(1~100 정수)와 budgetKrw(원) 중 하나가 필수 (2026-10-11). */
export interface ActivateRequest {
  budgetPercent?: number;
  budgetKrw?: number;
  token?: string; // Discord 활성화 링크의 ?t=
  acknowledged?: boolean;
  manualStart?: boolean; // 시연용 수동 시작 — 자격이 될 때만 true로 보낸다 (일반 활성화는 키를 넣지 않는다)
}

// ---------------------------------------------------------------- 장기투자 (docs/API.md "장기투자")

export interface DailyMoveEvidence {
  id: string; // "E1", "E2" … (기록 하나 안에서 유일)
  kind: "disclosure" | "flow" | "broker" | "news";
  // disclosure 그날 DART 공시(사실) · flow 수급(숫자) · broker 증권사 목표가 헤드라인 · news 뉴스 제목(신뢰 낮음)
  text: string; // 한 줄 (200자까지)
  source: string; // 출처 이름
  at: string | null; // 게시·접수 시각. 날짜만 아는 자료는 null
  url: string | null; // 공시면 DART 원문 주소, 그 밖은 null
  reliability: "high" | "medium" | "low";
}

/** 종목 하나의 하루 기록 (팀 공용). 원인을 단정하지 않는다 — 화면 고정 문구는 lib/plainText.ts DAILY_MOVE_CAPTION. */
export interface DailyMove {
  symbol: string;
  name: string;
  market: "KR";
  date: string; // 거래일 YYYY-MM-DD
  asOf: string; // 그날 정규장 종료 시각
  close: number;
  prevClose: number;
  changeRate: number; // close / prevClose − 1
  marketProxy: { symbol: string; name: string; changeRate: number | null }; // 코스피 "069500" KODEX 200 · 코스닥 "229200" KODEX 코스닥150
  excessChangeRate: number | null; // changeRate − marketProxy.changeRate (β=1, 원인이 아니다)
  sectorChangeRate: null; // v1은 늘 null (화면 "업종 자료 없음")
  volatility20: number | null; // 최근 20거래일 일간 등락률 표준편차
  flows: { foreign: number | null; institution: number | null; individual: number | null } | null; // 순매수 ÷ 거래량
  headline: string; // 60자까지
  summary: string[]; // 1~3개 (각 120자까지)
  drivers: string[]; // 설명이 기댄 evidence id. 템플릿이면 []
  uncertain: boolean; // 근거가 약함 → 화면 "뚜렷한 소식을 찾지 못했어요"
  method: "template" | "llm";
  evidence: DailyMoveEvidence[];
  missing: string[]; // 비운 칸과 이유 한 줄씩
  createdAt: string;
}

/** GET /api/longterm/daily-moves. 기록이 하나도 없으면 {date: null, results: []}. */
export interface DailyMoveList {
  date: string | null;
  results: DailyMove[];
}

export type FundamentalKey =
  | "revenueGrowth"
  | "operatingIncomeGrowth"
  | "operatingMargin"
  | "roe"
  | "debtRatio"
  | "currentRatio"
  | "interestCoverage"
  | "operatingCashFlow"
  | "earningsQuality"; // docs/API.md "지표와 판정" 표 순서
export type ThesisAxis = "growth" | "profitability" | "balance_sheet"; // 성장 · 수익성 · 재무 안정
export type CheckStatus = "ok" | "warn" | "bad" | "na"; // ✓ · △ · ✗ · 판정 없음
/** 종합. 화면은 중립 표기: solid "기준 충족" · caution "주의" · review "확인 필요" · na "적용하지 않음". */
export type FundamentalsOverall = "solid" | "caution" | "review" | "na";

export interface FundamentalsRow {
  key: FundamentalKey;
  label: string; // 화면 이름 ("매출 성장")
  axis: ThesisAxis;
  value: number | null; // 최신 값 (unit 기준)
  unit: "ratio" | "times" | "krw"; // ratio 소수(0.12 = 12%) · times 배 · krw 원
  baseline: number | null; // 산 이유를 처음 저장할 때의 값
  change: number | null; // value − baseline (ratio면 %p를 소수로)
  status: CheckStatus;
  note: string | null; // 판정 이유 한 줄
}

export interface ThesisCheck {
  id: number;
  checkedAt: string;
  trigger: "filing" | "weekly";
  period: string | null; // "2026 반기보고서"
  receivedAt: string | null; // 보고서 접수일 YYYY-MM-DD
  overall: FundamentalsOverall;
  previousOverall: FundamentalsOverall | null;
  rows: FundamentalsRow[]; // 9개
  newBad: FundamentalKey[];
  notified: boolean;
  caption: string; // "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"
}

/** 산 이유 (사용자·종목당 하나). */
export interface Thesis {
  symbol: string;
  name: string;
  market: Market;
  reasons: string[]; // 1~3개 (각 1~100자)
  axes: ThesisAxis[]; // 비면 셋 다로 본다
  baseline: Partial<Record<FundamentalKey, number | null>>; // 자료가 없으면 {}
  baselinePeriod: string | null;
  active: boolean; // 이 종목을 장기 보유(style long, 체결 대기·보유 중) 중인지. 서버가 정한다
  lastCheck: ThesisCheck | null;
  createdAt: string;
  updatedAt: string;
}

/** PUT /api/longterm/theses/{symbol}. axes를 빼면 그대로 (새로 만들 때는 []). */
export interface ThesisRequest {
  reasons: string[];
  axes?: ThesisAxis[];
}

/** GET /api/stocks/{symbol}/fundamentals — 보유 여부와 상관없이 최근 지표와 절대 기준 판정. */
export interface FundamentalsView {
  symbol: string;
  name: string;
  market: Market;
  applicable: boolean; // 금융업·ETF·ETN·리츠·미국 종목은 false
  reason: string | null; // applicable이 false거나 자료가 없을 때의 이유
  overall: FundamentalsOverall;
  rows: FundamentalsRow[]; // 9개 (baseline·change는 늘 null). applicable이 false면 []
  asOf: { period: string | null; receivedAt: string | null } | null;
  source: string; // "금융감독원 OpenDART"
  caption: string;
  thesis: Thesis | null; // 이 종목에 대한 내 산 이유와 최근 점검
}
