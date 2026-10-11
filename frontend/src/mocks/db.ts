// 가짜 API의 상태와 규칙 (docs/API.md 주문 규칙을 단순하게 흉내 낸다). 개발 화면 확인·테스트 전용.
// 가격: 종목 시세(Quote·StockDetail)는 실시간(basis "live", 값 = 종목의 장중 가격 price), 그 밖의 화면 가격(계좌 평가·미리 보기 등)은 장마감 기준(종목의 close·prevClose),
// 모의 체결·청산 판단은 장중 확인 가격(price) — docs/API.md 공통 규칙 "실시간 시세"·"장마감 기준".
import type {
  AccountSummary,
  AnalysisDetail,
  AnalysisQuota,
  AnalysisSummary,
  BudgetMode,
  Candle,
  DailyMove,
  DailyMoveList,
  Fill,
  FundamentalKey,
  FundamentalsView,
  HoldingStyle,
  InvestorAnswers,
  InvestorProfile,
  Job,
  Market,
  MarketStatus,
  Me,
  Notification,
  NotificationSettings,
  NotificationTestResult,
  Order,
  OrderRequest,
  OrderResult,
  Position,
  PricesAsOf,
  Quote,
  PlanEvent,
  Ranking,
  ReasonCode,
  Recommendation,
  RecommendationSource,
  ReportQuota,
  RiskPreview,
  Thesis,
  ThesisAxis,
  ThesisCheck,
  TradePlan,
  TradePlanDetail,
  ChaosConfig,
  ChaosRequest,
  ReportDetail,
  ReportSummary,
  ReportTeam,
  Reservation,
  ScreeningResult,
  StockDetail,
  StockItem,
} from "../api/types";
import {
  addDays,
  basisDay,
  businessDays,
  isWeekday,
  kstDay,
  kstDayStartMs,
  kstIso,
  marketDay,
  marketMinutes,
  session,
  sessionEndIso,
  weekdaysEnding,
} from "./clock";
import { answersError, assess, cleanAnswers } from "./investor";
import { FUNDAMENTALS_CAPTION, FUNDAMENTALS_SOURCE, dailyMoveOf, judgeRows, metricsOf, overallOf } from "./longterm";
import { sampleScreening } from "../lib/reportSamples";
import { finishSample, sampleTargets, selectionSample, type SampleKind } from "./sampleReports";
import {
  type MockStock,
  type MockUser,
  OTHER_RATES,
  makeAnalysis,
  reportPlan,
  roundTick,
  seedStocks,
  seedUsers,
  seededRandom,
} from "./seed";

export const INITIAL_CAPITAL = 10_000_000;
export const USD_KRW = 1_380;
const QUOTA_LIMIT = 5;
// 저장 형식이 바뀌면 숫자를 올린다 (예전 상태는 버리고 처음부터)
const STORAGE_KEY = "paper-mock-db-v4"; // v4: 보유 방식은 스윙·장기 둘만 (예전 저장 상태를 버린다, 2026-10-06)

export class MockError extends Error {
  readonly status: number;
  /** 본문에 detail과 같이 넣을 필드 (예: 400의 reasonCodes, 429의 limit·used). */
  readonly extra: Record<string, unknown> | null;
  constructor(status: number, detail: string, extra: Record<string, unknown> | null = null) {
    super(detail);
    this.status = status;
    this.extra = extra;
  }
}

/** 실행 불가 사유가 있는 400 ({detail: 사유를 "; "로 이은 것, reasonCodes}). */
const blocked = (reasons: string[], codes: string[]) => new MockError(400, reasons.join("; "), { reasonCodes: codes });

type Owned<T> = T & { userId: number };
type MockOrder = Owned<Order> & { fx: number };
type MockJob = Owned<Job> & { symbol: string; polls: number };
/** deletedAt: 지운(숨긴) 시각 — 목록·상세에서 빼고 한도에는 그대로 센다 (DECISIONS 25장). 저장된 canDelete는 쓰지 않고 볼 때 계산한다. */
type MockReport = Owned<ReportDetail> & { deletedAt?: string };
/**
 * 추천은 팀 공용. status·myPlan·planCount·expiredReason·canDelete는 볼 때 계산한다.
 * expired: 가격이 이미 손절가·목표가를 지나 엔진이 내린 까닭 (테스트·시연은 expireRecommendation). deletedAt: 지운(숨긴) 시각.
 */
type MockRec = Omit<Recommendation, "status" | "myPlan" | "planCount" | "blockedBy" | "expiredReason" | "canDelete"> & {
  expired?: "below_stop" | "above_target";
  deletedAt?: string;
};
/** nextAt: 시연용 진행 시각 (이 시각이 지나면 다음 단계로). exitRequested: 보유 중 중단으로 매도를 요청함. */
type MockPlan = Owned<TradePlan> & { events: PlanEvent[]; nextAt: number | null; exitRequested: boolean };
type MockSettings = Omit<NotificationSettings, "webhookConfigured">;
interface MockProfile {
  beginnerMode: boolean;
  answers: InvestorAnswers | null;
  assessedAt: string | null;
}
/** 산 이유 (active·name·market은 볼 때 정한다). */
type MockThesis = Owned<Omit<Thesis, "active" | "name" | "market">>;
/** 분석. 요청한 팀원의 id는 안에만 두고(서버의 요청자 ID 열), 밖으로는 requestedBy(닉네임·"strategy:<번호>"·"cli")만 낸다. */
type MockAnalysis = AnalysisDetail & { requesterId: number | null };

interface State {
  seq: number;
  users: MockUser[];
  stocks: MockStock[];
  cash: Record<number, number>;
  orders: MockOrder[];
  fills: Owned<Fill>[];
  reservations: Owned<Reservation>[];
  analyses: MockAnalysis[];
  jobs: MockJob[];
  reports: MockReport[];
  recommendations: MockRec[];
  plans: MockPlan[];
  notifications: Owned<Notification>[];
  notificationSettings: Record<number, MockSettings>;
  demoUsed: Record<number, number>;
  usedToday: Record<number, number>;
  profiles: Record<number, MockProfile>;
  theses: MockThesis[];
  sessionUserId: number | null;
  ticks: Record<string, number>;
}

export interface MockOptions {
  /** 장중 확인 가격이 조금씩 움직이게 한다 (화면의 종가는 그대로. 기본 끔). */
  jitter: boolean;
  /** 브라우저 localStorage에 상태를 저장한다 (새로고침해도 로그인·주문 유지). */
  persist: boolean;
  /** 정규장 여부를 고정한다 (테스트용). 없으면 실제 시각으로 판단. */
  marketOpen: Partial<Record<Market, boolean>>;
  /** 분석 작업이 끝날 때까지 필요한 상태 조회 횟수. */
  jobPolls: number;
  jobFails: boolean;
  halted: boolean;
  brokerReady: boolean;
  aiEnabled: boolean;
  /** 계획이 다음 단계로 가는 간격 (ms): 주문 접수 → 체결 → 목표가 청산. Infinity면 저절로 진행하지 않는다. */
  planStepMs: number;
  /** 시연용 추천을 만들 수 있는지 (AUTOTRADE_DEMO). */
  demoEnabled: boolean;
  /** 서버에 DISCORD_WEBHOOK_URL이 있는지. */
  webhookConfigured: boolean;
  /** MarketStatus.quoteProvider (화면 아래 출처 줄). */
  quoteProvider: string;
  /** 하루 리포트 한도 (AI_DAILY_REPORTS_PER_USER). null이면 무제한 (서버 기본값). */
  reportLimit: number | null;
  /** 끝난 예시 리포트(완성·실패)를 넣는다 (브라우저 가짜 API는 켬, 테스트는 db.addSampleReports()). */
  sampleReports: boolean;
}

const DEFAULTS: MockOptions = {
  jitter: false,
  persist: false,
  marketOpen: {},
  jobPolls: 3,
  jobFails: false,
  halted: false,
  brokerReady: true,
  aiEnabled: true,
  planStepMs: 6000,
  demoEnabled: true,
  webhookConfigured: false,
  quoteProvider: "키움증권 REST API",
  reportLimit: 3,
  sampleReports: false,
};

export let options: MockOptions = { ...DEFAULTS };
// 초기 데이터는 파일 끝에서 채운다 (아래 함수·상수가 모두 정의된 뒤)
let state = {} as State;

// ---------------------------------------------------------------- 상태 관리

function freshState(): State {
  const s: State = {
    seq: 100,
    users: seedUsers(),
    stocks: seedStocks(),
    cash: {},
    orders: [],
    fills: [],
    reservations: [],
    analyses: [],
    jobs: [],
    reports: [],
    recommendations: [],
    plans: [],
    notifications: [],
    notificationSettings: {},
    demoUsed: {},
    usedToday: { 1: 1 },
    profiles: {},
    theses: [],
    sessionUserId: null,
    ticks: {},
  };
  for (const u of s.users) s.cash[u.id] = INITIAL_CAPITAL * (1 + (OTHER_RATES[u.id] ?? 0));
  state = s;
  seedProfiles();
  seedAlice();
  seedAnalyses();
  seedReports();
  seedAutotrade();
  seedTheses();
  if (options.sampleReports) {
    addSampleReports();
    addSampleSelection();
  }
  return state;
}

/** 상태를 처음으로 되돌린다. 테스트는 매번 부른다. */
export function resetDb(opts: Partial<MockOptions> = {}) {
  options = { ...DEFAULTS, ...opts };
  state = freshState();
}

/** 브라우저에서 저장해 둔 상태를 불러온다 (없거나 깨졌으면 처음부터). */
export function loadPersisted(opts: Partial<MockOptions> = {}) {
  options = { ...DEFAULTS, ...opts };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    state = raw ? (JSON.parse(raw) as State) : freshState();
  } catch {
    state = freshState();
  }
}

export function persist() {
  if (!options.persist) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 저장 공간을 못 쓰면 메모리 상태만 쓴다
  }
}

const nextId = () => ++state.seq;
const daysAgoIso = (days: number, hour = 10) => kstIso(new Date(Date.now() - days * 86_400_000 - hour * 60_000));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDayParam(raw: string | null, name = "date"): string | null {
  if (raw === null || raw === "") return null;
  if (!DAY_RE.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) throw new MockError(400, `${name}는 YYYY-MM-DD 형식이어야 합니다.`);
  return raw;
}

/** 모르는 키가 있으면 400. */
function onlyKeys(body: Record<string, unknown>, allowed: string[]) {
  const unknown = Object.keys(body).filter((k) => !allowed.includes(k));
  if (unknown.length) throw new MockError(400, `모르는 키입니다: ${unknown.join(", ")}`);
}

// ---------------------------------------------------------------- 인증 · 프로필

export function login(username: string, password: string): MockUser {
  const u = state.users.find((x) => x.username === username && x.password === password);
  if (!u) throw new MockError(400, "아이디 또는 비밀번호가 올바르지 않습니다.");
  state.sessionUserId = u.id;
  return u;
}

export function logout() {
  state.sessionUserId = null;
}

export function sessionUser(): MockUser | null {
  return state.users.find((u) => u.id === state.sessionUserId) ?? null;
}

/** 테스트에서 로그인 상태를 바로 만든다. */
export function setSession(username: string | null) {
  state.sessionUserId = username ? (state.users.find((u) => u.username === username)?.id ?? null) : null;
}

function profileOf(userId: number): MockProfile {
  return (state.profiles[userId] ??= { beginnerMode: true, answers: null, assessedAt: null });
}

export function toMe(u: MockUser): Me {
  return { id: u.id, username: u.username, nickname: u.nickname, isPublic: u.isPublic, isStaff: u.isStaff, beginnerMode: profileOf(u.id).beginnerMode };
}

export function updateProfile(u: MockUser, body: { isPublic?: unknown; nickname?: unknown }): Me {
  if (body.nickname !== undefined) {
    const nick = String(body.nickname).trim();
    if (nick.length < 2 || nick.length > 12) throw new MockError(400, "닉네임은 2~12자로 정해 주세요.");
    if (state.users.some((x) => x.id !== u.id && x.nickname === nick)) {
      throw new MockError(400, "이미 쓰고 있는 닉네임입니다.");
    }
    u.nickname = nick;
  }
  if (body.isPublic !== undefined) u.isPublic = Boolean(body.isPublic);
  return toMe(u);
}

export function investorProfile(userId: number): InvestorProfile {
  const p = profileOf(userId);
  const a = p.answers ? assess(p.answers) : null;
  return {
    beginnerMode: p.beginnerMode,
    answers: p.answers,
    experienceScore: a?.experienceScore ?? null,
    experienceLevel: a?.experienceLevel ?? null,
    riskScore: a?.riskScore ?? null,
    riskProfile: a?.riskProfile ?? null,
    recommendedBeginnerMode: a?.recommendedBeginnerMode ?? null,
    assessedAt: p.assessedAt,
  };
}

/** PUT: 진단 제출. beginnerMode는 바꾸지 않는다. */
export function submitInvestorProfile(userId: number, body: Record<string, unknown>): InvestorProfile {
  onlyKeys(body, ["answers"]);
  const err = answersError(body.answers);
  if (err) throw new MockError(400, err);
  const p = profileOf(userId);
  p.answers = cleanAnswers(body.answers as InvestorAnswers); // q2는 서버처럼 보기 순서로 저장
  p.assessedAt = kstIso();
  return investorProfile(userId);
}

/** PATCH: 주린이모드 스위치만. */
export function patchInvestorProfile(userId: number, body: Record<string, unknown>): InvestorProfile {
  onlyKeys(body, ["beginnerMode"]);
  if (typeof body.beginnerMode !== "boolean") throw new MockError(400, "beginnerMode는 true 또는 false여야 합니다.");
  profileOf(userId).beginnerMode = body.beginnerMode;
  return investorProfile(userId);
}

/** 테스트·시연용: 사용자의 프로필을 바로 바꾼다 (예: setInvestorProfile("alice", { beginnerMode: true })). */
export function setInvestorProfile(username: string, patch: Partial<MockProfile>) {
  const u = state.users.find((x) => x.username === username);
  if (!u) throw new Error(`no user ${username}`);
  Object.assign(profileOf(u.id), patch);
}

// ---------------------------------------------------------------- 시세 (실시간)

function stockOf(symbol: string): MockStock {
  const s = state.stocks.find((x) => x.symbol === symbol.toUpperCase());
  if (!s) throw new MockError(404, "종목을 찾을 수 없습니다.");
  return s;
}

/** 장중 확인 가격(= 실시간 시세의 현재가)을 조금 움직인다 (종목마다 2초에 한 번, 종가 ±30% 안에서). 계좌 평가의 종가는 바뀌지 않는다. */
function tick(s: MockStock) {
  if (!options.jitter) return;
  const now = Date.now();
  if (now - (state.ticks[s.symbol] ?? 0) < 2000) return;
  state.ticks[s.symbol] = now;
  const step = (Math.random() - 0.48) * 0.004;
  const next = roundTick(s.price * (1 + step), s.currency);
  s.price = Math.min(s.close * 1.3, Math.max(s.close * 0.7, next));
}

/** 종가의 기준 시각 = 기준일의 정규장 종료. */
const closeAsOf = (s: MockStock) => sessionEndIso(s.market, basisDay(s.market));

/** 지금 그 시장이 정규장인지 (options.marketOpen으로 고정할 수 있다). */
const marketIsOpen = (s: MockStock) => session(s.market, new Date(), options.marketOpen[s.market]).isOpen;

/**
 * 실시간 시세: price = 장중 가격(s.price), asOf = 지금(받은 시각), basis "live".
 * prevClose는 단순하게 종목의 전 거래일 종가(s.prevClose)로 고정한다 (서버는 가격이 속한 거래일의 전 거래일 종가를 거래일 달력으로 정한다 — docs/API.md "실시간 시세").
 * 증권사 조회 키가 없으면(brokerReady 꺼짐) 현재가도 종가도 받지 못한 Quote다 (basis "close", 값 null).
 */
export function quoteOf(s: MockStock): Quote {
  tick(s);
  if (!options.brokerReady) {
    return { symbol: s.symbol, name: s.name, currency: s.currency, price: null, prevClose: null, change: null, changeRate: null, asOf: null, basis: "close" };
  }
  const change = s.currency === "USD" ? Math.round((s.price - s.prevClose) * 100) / 100 : s.price - s.prevClose;
  return {
    symbol: s.symbol,
    name: s.name,
    currency: s.currency,
    price: s.price,
    prevClose: s.prevClose,
    change,
    changeRate: s.price / s.prevClose - 1,
    asOf: kstIso(),
    basis: "live",
  };
}

/** 테스트·시연용: 장중 확인 가격(= 실시간 시세의 현재가)을 바꾼다 (지정가 체결·목표가 도달을 일으킬 때). 계좌 평가의 종가는 그대로. */
export function setPrice(symbol: string, price: number) {
  stockOf(symbol).price = price;
}

/** 테스트·시연용: 직전 장마감 종가를 바꾼다 (화면 가격·미리 보기·평가가 바뀐다). */
export function setClose(symbol: string, close: number, prevClose?: number) {
  const s = stockOf(symbol);
  s.close = close;
  if (prevClose !== undefined) s.prevClose = prevClose;
}

export function quotes(symbols: string[]): Quote[] {
  runEngine();
  return symbols
    .map((sym) => state.stocks.find((s) => s.symbol === sym.trim().toUpperCase()))
    .filter((s): s is MockStock => Boolean(s))
    .slice(0, 50)
    .map(quoteOf);
}

/**
 * 일봉 120개 (과거 → 최신). 완성 봉은 기준일로 끝난다 (마지막 완성 봉 = 기준일(종가 = close), 그 앞 봉 종가 = prevClose).
 * 오늘 정규장이 열려 있으면 마지막에 오늘 진행 중인 봉이 붙는다 (시가 = 직전 종가, 종가 = 지금 가격) — 실시간 시세를 받을 수 있을 때만.
 */
function candles(s: MockStock): Candle[] {
  const days = weekdaysEnding(basisDay(s.market), 120);
  const r = seededRandom(s.symbol);
  const closes: number[] = new Array(days.length);
  closes[days.length - 1] = s.close;
  closes[days.length - 2] = s.prevClose;
  for (let i = days.length - 3; i >= 0; i--) closes[i] = closes[i + 1] / (1 + (r() - 0.5) * 0.05);
  const done = days.map((date, i) => {
    const close = roundTick(closes[i], s.currency);
    const open = roundTick(i === 0 ? close : closes[i - 1] * (1 + (r() - 0.5) * 0.01), s.currency);
    const high = roundTick(Math.max(open, close) * (1 + r() * 0.015), s.currency);
    const low = roundTick(Math.min(open, close) * (1 - r() * 0.015), s.currency);
    return { date, open, high, low, close, volume: Math.round(200_000 + r() * 2_000_000) };
  });
  const today = marketDay(s.market);
  if (!options.brokerReady || today <= days[days.length - 1] || !marketIsOpen(s)) return done;
  const t = seededRandom(`${s.symbol}-${today}-today`);
  const open = s.close;
  const close = s.price;
  const high = Math.max(open, close, roundTick(Math.max(open, close) * (1 + t() * 0.006), s.currency));
  const low = Math.min(open, close, roundTick(Math.min(open, close) * (1 - t() * 0.006), s.currency));
  return [...done, { date: today, open, high, low, close, volume: Math.round(100_000 + t() * 900_000) }].slice(-120);
}

export function stockDetail(symbol: string): StockDetail {
  const s = stockOf(symbol);
  const bars = candles(s);
  const last = bars[bars.length - 1];
  const quote = quoteOf(s);
  // 마지막 봉이 오늘 진행 중이면 시세를 받은 시각, 완성 봉이면 그 봉 날짜의 정규장 종료 시각
  const inProgress = last !== undefined && quote.basis === "live" && last.date === marketDay(s.market) && marketIsOpen(s);
  return {
    symbol: s.symbol,
    name: s.name,
    exchange: s.exchange,
    market: s.market,
    currency: s.currency,
    quote,
    candles: bars,
    asOf: last ? (inProgress ? quote.asOf : sessionEndIso(s.market, last.date)) : null,
    warnings: s.warnings,
  };
}

export function search(q: string, limit: number): StockItem[] {
  const term = q.trim().toLowerCase();
  if (!term) return [];
  return state.stocks
    .filter((s) => s.name.toLowerCase().includes(term) || s.symbol.toLowerCase().startsWith(term))
    .slice(0, limit)
    .map(({ symbol, name, exchange, market }) => ({ symbol, name, exchange, market }));
}

export function marketStatus(): MarketStatus {
  return {
    markets: (["KR", "US"] as Market[]).map((m) => {
      const closeDate = basisDay(m);
      return { market: m, ...session(m, new Date(), options.marketOpen[m]), closeDate, lastCloseAt: sessionEndIso(m, closeDate) };
    }),
    halted: options.halted,
    brokerReady: options.brokerReady,
    quoteProvider: options.quoteProvider,
  };
}

const isOpen = (m: Market) => session(m, new Date(), options.marketOpen[m]).isOpen;
const fxOf = (s: { currency: string }) => (s.currency === "USD" ? USD_KRW : 1);
const commissionRate = (m: Market) => (m === "KR" ? 0.00015 : 0.001);
const SELL_TAX_KR = 0.002; // 매도 거래세 0.20%
const sellTaxRate = (m: Market) => (m === "KR" ? SELL_TAX_KR : 0);
const priceText = (n: number, c: string) =>
  c === "USD" ? `$${n.toFixed(2)}` : `${Math.round(n).toLocaleString("ko-KR")}원`;
const krwText = (n: number) => `${n >= 0 ? "+" : "-"}${Math.abs(Math.round(n)).toLocaleString("ko-KR")}원`;
const wonText = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;

// ---------------------------------------------------------------- 계좌·주문

function userOrders(userId: number) {
  return state.orders.filter((o) => o.userId === userId);
}

function strip<T extends { userId: number }>(row: T): Omit<T, "userId"> {
  const { userId: _ignored, ...rest } = row;
  void _ignored;
  return rest;
}

function toOrder(o: MockOrder): Order {
  const { fx: _fx, ...rest } = strip(o);
  void _fx;
  return rest;
}

function fill(o: MockOrder, side: "BUY" | "SELL", price: number, reason: Fill["reason"], at: string) {
  const amount = price * o.quantity;
  const amountKrw = amount * o.fx;
  const commission = Math.round(amountKrw * commissionRate(o.market));
  const tax = side === "SELL" ? Math.round(amountKrw * sellTaxRate(o.market)) : 0;
  const cashChangeKrw = side === "BUY" ? -(amountKrw + commission) : amountKrw - commission - tax;
  state.cash[o.userId] += cashChangeKrw;
  state.fills.push({
    id: nextId(),
    userId: o.userId,
    orderId: o.id,
    symbol: o.symbol,
    name: o.name,
    currency: o.currency,
    side,
    price,
    quantity: o.quantity,
    amount,
    commission,
    tax,
    cashChangeKrw,
    reason,
    filledAt: at,
  });
  return cashChangeKrw;
}

function enter(o: MockOrder, price: number, at: string) {
  o.status = "EXIT_WATCHING";
  o.fillPrice = price;
  o.filledAt = at;
  o.fx = fxOf(o);
  fill(o, "BUY", price, "ENTRY", at);
}

function exit(o: MockOrder, price: number, reason: NonNullable<Order["exitReason"]>, at: string) {
  const buy = state.fills.find((f) => f.orderId === o.id && f.side === "BUY");
  const proceeds = fill(o, "SELL", price, reason, at);
  o.status = "CLOSED";
  o.exitPrice = price;
  o.exitReason = reason;
  o.closedAt = at;
  o.pnlKrw = Math.round(proceeds + (buy?.cashChangeKrw ?? 0));
}

function newOrder(userId: number, s: MockStock, req: OrderRequest, at: string, style: HoldingStyle): MockOrder {
  return {
    id: nextId(),
    userId,
    symbol: s.symbol,
    name: s.name,
    market: s.market,
    currency: s.currency,
    orderType: req.orderType,
    limitPrice: req.orderType === "LIMIT" ? (req.limitPrice ?? null) : null,
    quantity: req.quantity,
    status: "ENTRY_PENDING",
    style,
    entryPrice: req.orderType === "LIMIT" && req.limitPrice ? req.limitPrice : s.price,
    fillPrice: null,
    filledAt: null,
    targetPrice: req.targetPrice ?? null,
    stopPrice: req.stopPrice ?? null,
    expireDate: req.days ? addDays(kstDay(), req.days) : null,
    exitPrice: null,
    exitReason: null,
    closedAt: null,
    pnlKrw: null,
    note: null,
    createdAt: at,
    fx: fxOf(s),
  };
}

function pendingKrw(userId: number): number {
  let sum = 0;
  for (const o of userOrders(userId)) {
    if (o.status === "ENTRY_PENDING") sum += (o.limitPrice ?? o.entryPrice) * o.quantity * fxOf(o);
  }
  for (const r of state.reservations) {
    if (r.userId === userId && r.kind === "BUY") {
      const s = stockOf(r.symbol);
      sum += s.close * r.quantity * fxOf(s); // 화면 추정과 같은 종가 기준
    }
  }
  return Math.round(sum);
}

const MAX_TOTAL_INVEST_KRW = 5_000_000;

/** 엔진 buy_blockers 흉내 (장중 가격으로 확인. 문장에 장중 가격 숫자를 넣지 않는다). */
function validate(userId: number, s: MockStock, req: OrderRequest) {
  if (options.halted) throw new MockError(400, "새 모의 매수가 중단되어 있습니다.");
  if (!options.brokerReady) throw new MockError(503, "증권사 조회 키가 없어 주문할 수 없습니다.");
  const qty = Number(req.quantity);
  if (!(qty > 0)) throw new MockError(400, "수량은 0보다 커야 합니다.");
  if (s.market === "KR" && !Number.isInteger(qty)) throw new MockError(400, "국내 종목은 정수 주만 주문할 수 있습니다.");
  if (req.orderType === "LIMIT" && !(Number(req.limitPrice) > 0)) throw new MockError(400, "지정가를 입력해 주세요.");
  const hasTarget = req.targetPrice != null;
  const hasStop = req.stopPrice != null;
  if (hasTarget !== hasStop) throw new MockError(400, "목표가와 손절가는 함께 입력해 주세요.");
  const base = req.orderType === "LIMIT" ? Number(req.limitPrice) : s.price;
  if (hasTarget && !(Number(req.stopPrice) < base && base < Number(req.targetPrice))) {
    throw new MockError(
      400,
      req.orderType === "LIMIT"
        ? "손절가 < 지정가 < 목표가 순서여야 합니다."
        : `손절가 ${priceText(Number(req.stopPrice), s.currency)} < 현재가 < 목표가 ${priceText(Number(req.targetPrice), s.currency)} 순서가 아님`,
    );
  }
  if (req.days != null && !(Number.isInteger(req.days) && req.days > 0)) {
    throw new MockError(400, "보유 기한은 1일 이상 정수로 입력해 주세요.");
  }
  const busy =
    userOrders(userId).some((o) => o.symbol === s.symbol && (o.status === "ENTRY_PENDING" || o.status === "EXIT_WATCHING")) ||
    state.reservations.some((r) => r.userId === userId && r.symbol === s.symbol && r.kind === "BUY");
  if (busy) throw new MockError(400, `${s.name}은(는) 이미 진행 중인 주문이 있습니다 (같은 종목은 포지션 하나만).`);
  const need = base * qty * fxOf(s) * (1 + commissionRate(s.market));
  const power = state.cash[userId] - pendingKrw(userId);
  if (need > power) throw new MockError(400, `매수 가능 금액 부족 (가능 ${wonText(power)})`);
}

/** 보유 방식 정하기 (docs/API.md "보유 방식"). 모르는 값, 규칙 위반은 400. */
function styleOf(raw: unknown, req: OrderRequest): "swing" | "long" {
  if (raw !== undefined && raw !== null && raw !== "swing" && raw !== "long") {
    throw new MockError(400, "보유 방식은 swing 또는 long이어야 합니다.");
  }
  const any = req.targetPrice != null || req.stopPrice != null || req.days != null;
  const style = (raw as "swing" | "long" | undefined) ?? (any ? "swing" : "long");
  if (style === "long" && any) throw new MockError(400, "장기 보유는 목표가·손절가·보유 기한을 받지 않아요.");
  if (style === "swing" && (req.targetPrice == null || req.stopPrice == null)) {
    throw new MockError(400, "스윙 주문은 목표가와 손절가가 둘 다 있어야 해요.");
  }
  return style;
}

/** 장기 보유 매수의 비중 점검 (엔진 assess_position 흉내): 매수 가능 금액 · 종목당 비중 100% · 총 금액 한도. 가격은 지정가 또는 종가. */
function assessPosition(userId: number, s: MockStock, req: OrderRequest) {
  const price = req.orderType === "LIMIT" && req.limitPrice ? Number(req.limitPrice) : s.close;
  const need = price * Number(req.quantity) * fxOf(s) * (1 + commissionRate(s.market));
  const acc = account(userId);
  const power = acc.cashKrw - pendingKrw(userId);
  const reasons: string[] = [];
  const codes: string[] = [];
  if (need > power) {
    reasons.push(`매수 가능 금액 부족 (가능 ${wonText(power)})`);
    codes.push("cash_short");
  }
  if (need > acc.equityKrw) {
    reasons.push("종목당 비중 한도(100%)를 넘습니다");
    codes.push("position_limit");
  }
  if (acc.investedKrw + pendingKrw(userId) + need > MAX_TOTAL_INVEST_KRW) {
    reasons.push(`총 금액 한도(${wonText(MAX_TOTAL_INVEST_KRW)})를 넘습니다`);
    codes.push("total_limit");
  }
  if (reasons.length) throw blocked(reasons, codes);
}

function reservation(userId: number, kind: "BUY" | "SELL", s: MockStock, qty: number, extra: Partial<Reservation>) {
  const r: Owned<Reservation> = {
    id: nextId(),
    userId,
    kind,
    symbol: s.symbol,
    name: s.name,
    market: s.market,
    quantity: qty,
    orderId: null,
    targetPrice: null,
    stopPrice: null,
    days: null,
    style: null,
    runAt: session(s.market, new Date(), options.marketOpen[s.market]).opensAt,
    createdAt: kstIso(),
    ...extra,
  };
  state.reservations.push(r);
  return r;
}

export function placeOrder(userId: number, body: OrderRequest & { style?: unknown }): OrderResult {
  const s = stockOf(String(body.symbol ?? ""));
  const req: OrderRequest = {
    symbol: s.symbol,
    quantity: Number(body.quantity),
    orderType: body.orderType === "LIMIT" ? "LIMIT" : "MARKET",
    limitPrice: body.limitPrice == null ? undefined : Number(body.limitPrice),
    targetPrice: body.targetPrice == null ? undefined : Number(body.targetPrice),
    stopPrice: body.stopPrice == null ? undefined : Number(body.stopPrice),
    days: body.days == null ? undefined : Number(body.days),
  };
  const style = styleOf(body.style, req);
  if (style === "long" && !options.halted && options.brokerReady && Number(req.quantity) > 0) assessPosition(userId, s, req);
  validate(userId, s, req);
  const now = kstIso();

  if (req.orderType === "MARKET" && !isOpen(s.market)) {
    const r = reservation(userId, "BUY", s, req.quantity, {
      targetPrice: req.targetPrice ?? null,
      stopPrice: req.stopPrice ?? null,
      days: req.days ?? null,
      style,
    });
    return {
      order: null,
      reservation: strip(r),
      message: `장이 닫혀 있어 ${s.name} ${req.quantity}주 시장가 매수를 다음 정규장 시작에 예약했습니다.`,
    };
  }

  const o = newOrder(userId, s, req, now, style);
  state.orders.push(o);
  if (isOpen(s.market) && (req.orderType === "MARKET" || s.price <= (req.limitPrice ?? 0))) {
    enter(o, s.price, now);
    return { order: toOrder(o), reservation: null, message: `${s.name} ${o.quantity}주 ${priceText(s.price, s.currency)}에 매수 체결` };
  }
  return {
    order: toOrder(o),
    reservation: null,
    message: `${s.name} ${o.quantity}주 ${priceText(o.limitPrice ?? 0, s.currency)} 지정가 매수 접수 (체결 대기)`,
  };
}

function ownOrder(userId: number, id: number): MockOrder {
  const o = state.orders.find((x) => x.id === id && x.userId === userId);
  if (!o) throw new MockError(404, "주문을 찾을 수 없습니다.");
  return o;
}

export function sellOrder(userId: number, id: number): OrderResult {
  const o = ownOrder(userId, id);
  if (o.status === "ENTRY_PENDING") {
    o.status = "CANCELED";
    o.note = "사용자 취소";
    return { order: toOrder(o), reservation: null, message: `${o.name} 체결 대기 주문을 취소했습니다.` };
  }
  if (o.status !== "EXIT_WATCHING") throw new MockError(400, "이미 끝난 주문입니다.");
  const s = stockOf(o.symbol);
  if (!isOpen(o.market)) {
    if (state.reservations.some((r) => r.orderId === o.id)) throw new MockError(400, "이미 매도 예약이 있습니다.");
    const r = reservation(userId, "SELL", s, o.quantity, { orderId: o.id });
    return {
      order: toOrder(o),
      reservation: strip(r),
      message: `장이 닫혀 있어 ${o.name} ${o.quantity}주 전량 매도를 다음 정규장 시작에 예약했습니다.`,
    };
  }
  exit(o, s.price, "MANUAL", kstIso());
  return {
    order: toOrder(o),
    reservation: null,
    message: `${o.name} ${o.quantity}주 ${priceText(s.price, s.currency)}에 매도 체결 (손익 ${krwText(o.pnlKrw ?? 0)})`,
  };
}

export function cancelOrder(userId: number, id: number): Order {
  const o = ownOrder(userId, id);
  if (o.status !== "ENTRY_PENDING") throw new MockError(400, "체결 대기 주문만 취소할 수 있습니다.");
  o.status = "CANCELED";
  o.note = "사용자 취소";
  return toOrder(o);
}

export function modifyOrder(userId: number, id: number, body: { targetPrice?: number; stopPrice?: number; days?: number }) {
  const o = ownOrder(userId, id);
  const touches = body.targetPrice !== undefined || body.stopPrice !== undefined || body.days !== undefined;
  if (o.style === "long" && touches) throw new MockError(400, "장기 보유 주문에는 목표가·손절가·보유 기한을 넣지 않아요.");
  if (body.targetPrice !== undefined) o.targetPrice = body.targetPrice;
  if (body.stopPrice !== undefined) o.stopPrice = body.stopPrice;
  if (body.days !== undefined) o.expireDate = addDays(kstDay(), body.days);
  return toOrder(o);
}

export function listOrders(userId: number, status: string): Order[] {
  runEngine();
  return userOrders(userId)
    .filter((o) => status === "all" || o.status === "ENTRY_PENDING" || o.status === "EXIT_WATCHING")
    .sort((a, b) => b.id - a.id)
    .map(toOrder);
}

export function listFills(userId: number): Fill[] {
  return state.fills
    .filter((f) => f.userId === userId)
    .sort((a, b) => b.filledAt.localeCompare(a.filledAt) || b.id - a.id)
    .map(strip);
}

export function listReservations(userId: number): Reservation[] {
  runEngine();
  return state.reservations.filter((r) => r.userId === userId).map(strip);
}

export function deleteReservation(userId: number, id: number) {
  const i = state.reservations.findIndex((r) => r.id === id && r.userId === userId);
  if (i < 0) throw new MockError(404, "예약을 찾을 수 없습니다.");
  const removed = state.reservations[i];
  state.reservations.splice(i, 1);
  // 서버와 같게: 계획의 전량 매도 예약을 지우면 그 계획은 다시 중단을 받는다 (backend/autotrade/plans/executor.py cancel — 매도 예약이 없으면 다시 매도 요청)
  if (removed.kind === "SELL") {
    for (const p of state.plans) if (p.orderId === removed.orderId && p.status === "holding") p.exitRequested = false;
  }
}

/** 엔진 흉내: 정규장이면 예약 실행, 지정가 체결, 목표·손절 청산 (실제 엔진은 2회 연속 확인). 모두 장중 확인 가격. */
function runEngine() {
  const now = kstIso();
  for (const r of [...state.reservations]) {
    if (!isOpen(r.market)) continue;
    state.reservations.splice(state.reservations.indexOf(r), 1);
    const s = stockOf(r.symbol);
    if (r.kind === "BUY") {
      const req: OrderRequest = {
        symbol: r.symbol,
        quantity: r.quantity,
        orderType: "MARKET",
        targetPrice: r.targetPrice ?? undefined,
        stopPrice: r.stopPrice ?? undefined,
        days: r.days ?? undefined,
      };
      const o = newOrder(r.userId, s, req, now, r.style ?? "swing"); // 예약 때 정한 보유 방식 그대로
      state.orders.push(o);
      enter(o, s.price, now);
    } else {
      const o = state.orders.find((x) => x.id === r.orderId);
      if (o?.status === "EXIT_WATCHING") exit(o, s.price, "MANUAL", now);
    }
  }
  for (const o of state.orders) {
    if (!isOpen(o.market)) continue;
    const price = stockOf(o.symbol).price;
    if (o.status === "ENTRY_PENDING" && o.limitPrice != null && price <= o.limitPrice) enter(o, price, now);
    else if (o.status === "EXIT_WATCHING") {
      if (o.targetPrice != null && price >= o.targetPrice) exit(o, price, "TARGET", now);
      else if (o.stopPrice != null && price <= o.stopPrice) exit(o, price, "STOP", now);
    }
  }
  advancePlans();
}

/** 보유가 있는 시장의 종가 기준 시각. */
function pricesAsOf(markets: Iterable<Market>): PricesAsOf {
  const out: PricesAsOf = {};
  for (const m of markets) out[m] = sessionEndIso(m, basisDay(m));
  return out;
}

export function account(userId: number): AccountSummary {
  runEngine();
  const positions: Position[] = userOrders(userId)
    .filter((o) => o.status === "EXIT_WATCHING")
    .map((o) => {
      const s = stockOf(o.symbol);
      const last = options.brokerReady ? s.close : null;
      const costKrw = Math.round((o.fillPrice ?? 0) * o.quantity * o.fx);
      const valueKrw = Math.round((last ?? o.fillPrice ?? 0) * o.quantity * fxOf(s));
      return {
        orderId: o.id,
        symbol: o.symbol,
        name: o.name,
        market: o.market,
        currency: o.currency,
        style: o.style,
        quantity: o.quantity,
        avgPrice: o.fillPrice ?? 0,
        lastPrice: last,
        costKrw,
        valueKrw,
        profitKrw: valueKrw - costKrw,
        profitRate: costKrw ? valueKrw / costKrw - 1 : null,
        targetPrice: o.targetPrice,
        stopPrice: o.stopPrice,
        expireDate: o.expireDate,
        filledAt: o.filledAt ?? o.createdAt,
        priceBasis: last === null ? ("fill" as const) : ("close" as const),
      };
    });
  const cash = Math.round(state.cash[userId]);
  const holdings = positions.reduce((n, p) => n + p.valueKrw, 0);
  const equity = cash + holdings;
  const pending = pendingKrw(userId);
  return {
    initialCapitalKrw: INITIAL_CAPITAL,
    cashKrw: cash,
    holdingsValueKrw: holdings,
    equityKrw: equity,
    investedKrw: positions.reduce((n, p) => n + p.costKrw, 0),
    profitKrw: equity - INITIAL_CAPITAL,
    profitRate: equity / INITIAL_CAPITAL - 1,
    pendingKrw: pending,
    buyingPowerKrw: cash - pending,
    positions,
    notes: options.brokerReady ? [] : ["종가를 받지 못해 체결가로 평가했습니다."],
    pricesAsOf: options.brokerReady ? pricesAsOf(new Set(positions.map((p) => p.market))) : {},
    asOf: kstIso(),
  };
}

export function equityHistory(userId: number, days: number) {
  const list = businessDays(Math.max(2, Math.min(days, 365)));
  const end = account(userId).equityKrw;
  const r = seededRandom(`equity-${userId}`);
  const points = list.map((day, i) => {
    const t = i / (list.length - 1);
    const base = INITIAL_CAPITAL + (end - INITIAL_CAPITAL) * t;
    const wiggle = i === list.length - 1 ? 0 : (r() - 0.5) * INITIAL_CAPITAL * 0.012;
    return { day, equityKrw: Math.round(base + wiggle) };
  });
  return { points };
}

export function ranking(userId: number): Ranking {
  const accounts = state.users.map((u) => ({ u, acc: account(u.id) }));
  const results = accounts
    .filter((x) => x.u.isPublic)
    .sort((a, b) => b.acc.profitRate - a.acc.profitRate)
    .map((x, i) => ({ rank: i + 1, nickname: x.u.nickname, profitRate: x.acc.profitRate, isMe: x.u.id === userId }));
  const me = state.users.find((u) => u.id === userId)!;
  const mine = results.find((x) => x.isMe);
  const held = new Set(accounts.flatMap((x) => x.acc.positions.map((p) => p.market)));
  return {
    results,
    me: { isPublic: me.isPublic, rank: mine?.rank ?? null, profitRate: account(userId).profitRate },
    pricesAsOf: options.brokerReady ? pricesAsOf(held) : {},
    asOf: kstIso(),
  };
}

// ---------------------------------------------------------------- AI 분석

function summary(a: MockAnalysis): AnalysisSummary {
  const { id, symbol, name, market, currency, analyzedAt, verdict, priceAtAnalysis, best, scenarioCount, requestedBy, costUsd } =
    a;
  return { id, symbol, name, market, currency, analyzedAt, verdict, priceAtAnalysis, best, scenarioCount, requestedBy, costUsd };
}

/** 분석 목록. mine이면 요청자가 나인 것만 (서버처럼 닉네임이 아니라 저장된 요청자 id로 거른다). */
export function listAnalyses(symbol: string | null, verdict: string | null, mine: MockUser | null = null): AnalysisSummary[] {
  return state.analyses
    .filter((a) => (!symbol || a.symbol === symbol.toUpperCase()) && (!verdict || a.verdict === verdict))
    .filter((a) => !mine || a.requesterId === mine.id)
    .sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt) || b.id - a.id)
    .map(summary);
}

export function getAnalysis(id: number): AnalysisDetail {
  const a = state.analyses.find((x) => x.id === id);
  if (!a) throw new MockError(404, "분석을 찾을 수 없습니다.");
  const { requesterId: _ignored, ...rest } = a;
  void _ignored;
  return rest;
}

export function quota(userId: number): AnalysisQuota {
  const used = state.usedToday[userId] ?? 0;
  return {
    usedToday: used,
    limitPerUser: QUOTA_LIMIT,
    remaining: Math.max(0, QUOTA_LIMIT - used),
    estimatedCostUsd: 0.3,
    enabled: options.aiEnabled,
  };
}

export function requestAnalysis(user: MockUser, symbol: string): { jobId: number } {
  if (!options.aiEnabled) throw new MockError(503, "AI 키가 없어 분석을 요청할 수 없습니다.");
  const s = stockOf(symbol);
  if (quota(user.id).remaining <= 0) throw new MockError(429, `오늘 분석 요청 한도(${QUOTA_LIMIT}회)를 다 썼습니다.`);
  state.usedToday[user.id] = (state.usedToday[user.id] ?? 0) + 1;
  const job: MockJob = {
    id: nextId(),
    userId: user.id,
    symbol: s.symbol,
    polls: 0,
    type: "analyze",
    status: "QUEUED",
    result: null,
    error: null,
    createdAt: kstIso(),
    startedAt: null,
    finishedAt: null,
  };
  state.jobs.push(job);
  return { jobId: job.id };
}

export function getJob(user: MockUser, id: number): Job {
  const job = state.jobs.find((j) => j.id === id && j.userId === user.id);
  if (!job) throw new MockError(404, "작업을 찾을 수 없습니다.");
  if (job.status === "QUEUED" || job.status === "RUNNING") {
    job.polls += 1;
    job.startedAt ??= kstIso();
    job.status = "RUNNING";
    if (job.polls >= options.jobPolls) {
      job.finishedAt = kstIso();
      if (options.jobFails) {
        job.status = "FAILED";
        job.error = "AI 응답 형식 오류로 분석을 끝내지 못했습니다.";
      } else {
        const s = stockOf(job.symbol);
        const a: MockAnalysis = {
          ...makeAnalysis(nextId(), s, s.price >= s.prevClose ? "BUY" : "PASS", kstIso(), user.nickname),
          requesterId: user.id,
        };
        state.analyses.push(a);
        job.status = "DONE";
        job.result = { analysisIds: [a.id] };
      }
    }
  }
  const { symbol: _s, polls: _p, ...rest } = strip(job);
  void _s;
  void _p;
  return rest;
}

// ---------------------------------------------------------------- AI 리포트 (Agent 실행 없음: 신청은 requested로 남는다)

/** opinion·oneLiner: completed일 때만 results.report_agent의 verdict·oneLiner (그 밖은 null). */
function conclusionOf(r: ReportDetail): Pick<ReportSummary, "opinion" | "oneLiner"> {
  const draft = r.state.results.report_agent as { verdict?: unknown; oneLiner?: unknown } | undefined;
  if (r.status !== "completed" || !draft) return { opinion: null, oneLiner: null };
  const v = draft.verdict;
  return {
    opinion: v === "buy" || v === "hold" || v === "avoid" ? v : null,
    oneLiner: typeof draft.oneLiner === "string" ? draft.oneLiner : null,
  };
}

const teamOf = (r: Pick<ReportSummary, "team">): ReportTeam => r.team ?? "stock_report";
const TEAMS: readonly string[] = ["stock_report", "stock_selection"];

/** 지울 수 있는지: 내가 신청했고 끝난 종목 리포트 (자동 리포트·선정 실행·남의 것은 아니다). */
const reportDeletable = (r: MockReport, viewerId: number | null) =>
  viewerId != null && r.userId === viewerId && (r.source ?? "user") === "user" && teamOf(r) === "stock_report" && (r.status === "completed" || r.status === "failed");

function toReportSummary(r: MockReport, viewerId: number | null = null): ReportSummary {
  const { id, symbol, name, market, status, currentStep, requestedBy, createdAt, startedAt, finishedAt } = r;
  const { source, chaosEnabled, costUsd, hasPdf } = r;
  return {
    id,
    team: teamOf(r),
    symbol,
    name,
    market,
    status,
    currentStep,
    requestedBy,
    createdAt,
    startedAt,
    finishedAt,
    source,
    chaosEnabled,
    costUsd,
    hasPdf,
    canDelete: reportDeletable(r, viewerId),
    ...conclusionOf(r),
  };
}

/** 리포트 목록. team이 없으면 종목 리포트만 (서버와 같다 — 선정 실행은 ?team=stock_selection일 때만). 모르는 team·source는 400. */
export function listReports(
  symbol: string | null,
  q: { source?: string | null; mineUserId?: number | null; team?: string | null; viewerId?: number | null } = {},
): ReportSummary[] {
  const team = q.team || "stock_report";
  if (!TEAMS.includes(team)) throw new MockError(400, "team은 stock_report 또는 stock_selection이어야 합니다.");
  if (q.source && q.source !== "user" && q.source !== "auto") throw new MockError(400, "source는 user 또는 auto여야 합니다.");
  return state.reports
    .filter((r) => !r.deletedAt)
    .filter((r) => teamOf(r) === team)
    .filter((r) => !symbol || r.symbol === symbol.toUpperCase())
    .filter((r) => !q.source || (r.source ?? "user") === q.source)
    .filter((r) => !q.mineUserId || (r.userId === q.mineUserId && (r.source ?? "user") === "user"))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
    .map((r) => toReportSummary(r, q.viewerId ?? null));
}

export function getReport(id: number, viewerId: number | null = null): ReportDetail {
  const r = state.reports.find((x) => x.id === id && !x.deletedAt);
  if (!r) throw new MockError(404, "리포트를 찾을 수 없습니다.");
  const { deletedAt: _d, ...rest } = strip(r);
  void _d;
  return { ...rest, ...conclusionOf(r), canDelete: reportDeletable(r, viewerId) };
}

/** 진행 중인 계획(누구 것이든)이 있는 추천인지 — 있으면 지우지 않는다 (400). */
function recHasLivePlan(recId: number): boolean {
  return state.plans.some((p) => p.recommendationId === recId && LIVE.includes(p.status));
}
const LIVE_PLAN_DETAIL = "이 계획 제안으로 진행 중인 모의 자동매매가 있어 지울 수 없어요. 먼저 멈춰 주세요.";

/** 리포트 지우기 (숨김): 신청한 사람만, 끝난 종목 리포트만. 그 리포트의 계획 제안도 같이 숨긴다 (DECISIONS 25장). */
export function deleteReport(user: MockUser, id: number) {
  const r = state.reports.find((x) => x.id === id && !x.deletedAt);
  if (!r) throw new MockError(404, "리포트를 찾을 수 없습니다.");
  if (r.userId !== user.id || (r.source ?? "user") !== "user" || teamOf(r) !== "stock_report") {
    throw new MockError(403, "내가 신청한 리포트만 지울 수 있어요.");
  }
  if (r.status !== "completed" && r.status !== "failed") throw new MockError(400, "끝난 리포트만 지울 수 있어요.");
  const recs = state.recommendations.filter((x) => x.source === "report" && x.sourceId === id && !x.deletedAt);
  if (recs.some((x) => recHasLivePlan(x.id))) throw new MockError(400, LIVE_PLAN_DETAIL);
  const at = kstIso();
  r.deletedAt = at;
  for (const x of recs) x.deletedAt = at;
}

function newReport(id: number, user: MockUser, s: MockStock, createdAt: string, chaos?: ChaosRequest): MockReport {
  // 서버가 기본값과 seed를 채운다 (docs/tasks/00-공통.md 5절)
  const filled: ChaosConfig | null = chaos?.enabled
    ? {
        enabled: true,
        probability: chaos.probability ?? 0.5,
        errorTypes: chaos.errorTypes ?? ["timeout", "server_error", "bad_output"],
        workers: chaos.workers ?? null,
        scope: chaos.scope ?? "primary",
        seed: chaos.seed ?? 123456,
      }
    : null;
  return {
    id,
    userId: user.id,
    symbol: s.symbol,
    name: s.name,
    market: s.market,
    status: "requested",
    currentStep: null,
    requestedBy: user.nickname,
    team: "stock_report",
    source: "user",
    chaosEnabled: filled !== null,
    costUsd: null,
    hasPdf: false,
    canDelete: false,
    opinion: null,
    oneLiner: null,
    chaos: filled,
    recovery: { failures: 0, recovered: 0, unrecovered: 0, injected: 0, recoveryMs: null, models: {} },
    createdAt,
    startedAt: null,
    finishedAt: null,
    content: null,
    state: {
      taskId: `report-${id}`,
      status: "requested",
      currentStep: null,
      results: {},
      errors: {},
      completedAgents: [],
      failedAgents: [],
    },
    trace: [],
    plan: reportPlan(),
  };
}

/** 하루 리포트 한도 (D-7): 오늘(KST) 내가 신청한 것 중 장애 주입 없이 failed로 끝난 것을 뺀 수. */
export function reportQuota(userId: number): ReportQuota {
  const today = kstDay();
  const used = state.reports.filter(
    (r) =>
      r.userId === userId &&
      (r.source ?? "user") === "user" &&
      kstDay(new Date(r.createdAt)) === today &&
      !(r.status === "failed" && !r.chaos?.enabled),
  ).length;
  const limit = options.reportLimit;
  const remaining = limit === null ? null : Math.max(limit - used, 0);
  return { limit, used, remaining, resetsAt: `${addDays(today, 1)}T00:00:00+09:00` };
}

/** 리포트 신청. 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 그것을 돌려준다 (created=false → 200, 한도와 무관). */
export function requestReport(user: MockUser, symbol: string, chaos?: ChaosRequest): { report: ReportDetail; created: boolean } {
  const s = state.stocks.find((x) => x.symbol === symbol.trim().toUpperCase());
  if (!s) throw new MockError(400, "종목을 찾을 수 없습니다.");
  const open = state.reports.find(
    (r) => r.userId === user.id && r.symbol === s.symbol && r.status !== "completed" && r.status !== "failed",
  );
  if (open) return { report: getReport(open.id, user.id), created: false };
  const q = reportQuota(user.id);
  if (q.remaining !== null && q.remaining <= 0) {
    throw new MockError(429, `오늘 리포트 한도(${q.limit}개)를 다 썼어요. 내일 0시에 다시 만들 수 있어요.`, { limit: q.limit, used: q.used });
  }
  const r = newReport(nextId(), user, s, kstIso(), chaos);
  state.reports.push(r);
  return { report: getReport(r.id, user.id), created: true };
}

// ---------------------------------------------------------------- AI 추천 · 매매 계획 · 자동매매 · 알림
// 리스크 엔진(judge/risk.py assess_budget)의 계산을 단순하게 흉내 낸다: 수량 = 내가 정한 금액 ÷ 1주 매수 비용 (2026-10-11 — 건당 위험 1%는 경고만),
// 최소 손익비 1.5(스윙), 매수 가능 금액·총 금액 한도는 점검만(넘으면 막는다).
// 가격은 장마감 기준(종가), 활성화는 정규장이면 장중 확인 가격으로 한 번 더 본다.
// 계획은 시연용으로 시간이 지나면 저절로 진행한다 (주문 접수 → planStepMs 뒤 진입가 체결 → planStepMs 뒤 목표가 청산).

const RISK_PER_TRADE = 0.01;
const MIN_REWARD_RISK = 1.5;
const STOP_SLIPPAGE = 0.01;
const DEMO_PER_USER = 5;
const DEMO_SYMBOLS = ["035420", "005380", "068270", "105560", "035720"];
const LIVE: TradePlan["status"][] = ["active", "entry_pending", "holding"];
// 시연용 수동 시작 (DECISIONS 31장 — 서버 backend/autotrade/plans/risk.py MANUAL_SKIP_CODES·views.py BAD_MANUAL·executor.py MANUAL_NOT_NEEDED와 같다)
const MANUAL_SKIP_CODES = ["reward_risk_low", "ev_negative"];
const BAD_MANUAL = "manualStart는 true 또는 false여야 합니다.";
const MANUAL_NOT_NEEDED = "손익비·기대값 점검에 막히지 않은 계획은 수동 시작(시연용) 없이 시작합니다.";

/** 1주 기준 이익·손실 (종목 통화, 수수료·세금·손절 미끄러짐 반영). */
function perShare(r: { entryPrice: number; targetPrice: number; stopPrice: number; market: Market }) {
  const c = commissionRate(r.market);
  const t = sellTaxRate(r.market);
  const gain = r.targetPrice - r.entryPrice - r.entryPrice * c - r.targetPrice * (c + t);
  const stopFill = r.stopPrice * (1 - STOP_SLIPPAGE);
  const loss = r.entryPrice - stopFill + r.entryPrice * c + stopFill * (c + t);
  return { gain, loss };
}

interface RecInput {
  source: RecommendationSource;
  sourceId: number | null;
  requestedBy: string | null;
  symbol: string;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  holdingDays: number;
  probability: number | null;
  confidence: number | null;
  summary: string;
  reasons: string[];
  risks: string[];
  riskLevel: Recommendation["riskLevel"];
  createdAt: string;
  validUntil: string;
}

function makeRec(id: number, x: RecInput): MockRec {
  const s = stockOf(x.symbol);
  const base = { entryPrice: x.entryPrice, targetPrice: x.targetPrice, stopPrice: x.stopPrice, market: s.market };
  const { gain, loss } = perShare(base);
  const p = x.probability ?? 0.5;
  return {
    id,
    source: x.source,
    sourceId: x.sourceId,
    requestedBy: x.requestedBy,
    symbol: s.symbol,
    name: s.name,
    market: s.market,
    currency: s.currency,
    priceAtCreation: s.close, // 만들 때의 직전 종가 (출처와 무관)
    entryPrice: x.entryPrice,
    targetPrice: x.targetPrice,
    stopPrice: x.stopPrice,
    holdingDays: x.holdingDays,
    targetReturn: x.targetPrice / x.entryPrice - 1,
    stopLossRate: x.stopPrice / x.entryPrice - 1,
    rewardRisk: Math.round((gain / loss) * 100) / 100,
    probability: p,
    probabilityAssumed: x.probability === null,
    expectedReturn: (p * gain - (1 - p) * loss) / x.entryPrice,
    confidence: x.confidence,
    summary: x.summary,
    reasons: x.reasons,
    risks: x.risks,
    riskLevel: x.riskLevel,
    validUntil: x.validUntil,
    createdAt: x.createdAt,
  };
}

/**
 * 테스트·시연용: 추천 하나를 더한다 (손익비·기대수익률은 가격으로 계산 — 손익비가 낮으면 blockedBy에 reward_risk_low가 붙는다).
 * 주지 않은 값은 리포트 출처·10거래일·확률 0.5·지금 만듦·48시간 뒤 기한. 새 번호를 돌려준다.
 */
export function addRecommendation(x: Pick<RecInput, "symbol" | "entryPrice" | "targetPrice" | "stopPrice"> & Partial<RecInput>): number {
  const id = Math.max(0, ...state.recommendations.map((r) => r.id)) + 1;
  state.recommendations.push(
    makeRec(id, {
      source: "report",
      sourceId: null,
      requestedBy: null,
      holdingDays: 10,
      probability: 0.5,
      confidence: null,
      summary: `${stockOf(x.symbol).name} 계획`,
      reasons: [],
      risks: [],
      riskLevel: null,
      createdAt: kstIso(),
      validUntil: kstIso(new Date(Date.now() + 48 * 3_600_000)),
      ...x,
    }),
  );
  return id;
}

const recOpen = (r: MockRec) => !r.expired && Date.parse(r.validUntil) > Date.now();

/** 테스트·시연용: 가격이 이미 손절가·목표가를 지나 엔진이 추천을 내린 것처럼 만든다 (DECISIONS 25장 — 다시 open으로 돌리지 않는다). */
export function expireRecommendation(id: number, reason: "below_stop" | "above_target") {
  recOf(id).expired = reason;
}

/** 계획 제안 지우기 (숨김): 만든 사람만. 진행 중인 계획이 있으면 400. 리포트 추천이면 출처 리포트도 숨긴다 (DECISIONS 25장). */
export function deleteRecommendation(user: MockUser, id: number) {
  const r = recOf(id);
  if (r.requestedBy == null || r.requestedBy !== user.nickname) throw new MockError(403, "내가 만든 계획 제안만 지울 수 있어요.");
  if (recHasLivePlan(id)) throw new MockError(400, LIVE_PLAN_DETAIL);
  const at = kstIso();
  r.deletedAt = at;
  if (r.source === "report" && r.sourceId != null) {
    const rep = state.reports.find((x) => x.id === r.sourceId && !x.deletedAt);
    if (rep) {
      rep.deletedAt = at;
      // 같은 리포트의 다른 추천도 함께 숨긴다 (출처 리포트가 사라지므로)
      for (const x of state.recommendations) if (x.source === "report" && x.sourceId === rep.id && !x.deletedAt && !recHasLivePlan(x.id)) x.deletedAt = at;
    }
  }
}

function toRecommendation(r: MockRec, userId: number): Recommendation {
  const plans = state.plans.filter((p) => p.recommendationId === r.id);
  const mine = plans.filter((p) => p.userId === userId).sort((a, b) => b.id - a.id);
  const my = mine.find((p) => LIVE.includes(p.status)) ?? mine[0] ?? null;
  const blockedBy: ReasonCode[] = [];
  if (r.rewardRisk < MIN_REWARD_RISK) blockedBy.push("reward_risk_low");
  if (r.expectedReturn <= 0) blockedBy.push("ev_negative");
  if (!recOpen(r)) blockedBy.push("expired");
  const { expired: _x, deletedAt: _d, ...rest } = r;
  void _x;
  void _d;
  const open = recOpen(r);
  const nickname = state.users.find((u) => u.id === userId)?.nickname;
  return {
    ...rest,
    status: open ? "open" : "expired",
    expiredReason: open ? null : (r.expired ?? "deadline"),
    myPlan: my ? { id: my.id, status: my.status } : null,
    planCount: plans.length,
    blockedBy,
    canDelete: r.requestedBy != null && r.requestedBy === nickname,
  };
}

/** includeHidden: 지운 추천도 (계획 상세의 recommendation은 계속 열린다). */
function recOf(id: number, includeHidden = false): MockRec {
  const r = state.recommendations.find((x) => x.id === id && (includeHidden || !x.deletedAt));
  if (!r) throw new MockError(404, "추천을 찾을 수 없습니다.");
  return r;
}

export function listRecommendations(
  userId: number,
  q: { status?: string | null; source?: string | null; sourceId?: string | null; symbol?: string | null },
): Recommendation[] {
  runEngine();
  return state.recommendations
    .filter((r) => !r.deletedAt)
    .filter((r) => (q.status === "all" ? true : recOpen(r)))
    .filter((r) => !q.source || r.source === q.source)
    .filter((r) => !q.sourceId || r.sourceId === Number(q.sourceId))
    .filter((r) => !q.symbol || r.symbol === q.symbol.toUpperCase())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
    .map((r) => toRecommendation(r, userId));
}

export function getRecommendation(userId: number, id: number): Recommendation {
  return toRecommendation(recOf(id), userId);
}

/** 요청의 넣을 돈 (budgetPercent 또는 budgetKrw 중 하나). */
interface BudgetParam {
  mode: BudgetMode;
  percent: number | null;
  krw: number | null;
}

interface RiskInput {
  userId: number;
  s: MockStock;
  entryPrice: number;
  targetPrice: number;
  stopPrice: number;
  probability: number;
  budget: BudgetParam | null;
}

interface RiskResult {
  approved: boolean;
  reasons: string[];
  codes: string[];
  quantity: number;
  budgetKrw: number | null; // 원으로 바꾼 넣을 돈 (percent면 floor(매수 가능 금액 × % / 100))
  buyingPowerKrw: number;
  equityKrw: number;
  gain: number;
  loss: number;
}

/**
 * 리스크 엔진 assess_budget 흉내 (종가 기준 자산, 수량은 진입가로). approved는 리스크 엔진 사유만으로 정한다.
 * 넣을 돈이 없으면 크기 계산 없이 점검만 한다 (수량 0).
 */
function assessRisk(x: RiskInput): RiskResult {
  if (!options.brokerReady) throw new MockError(503, "증권사 조회 키가 없어 종가를 받을 수 없습니다.");
  const { s } = x;
  const acc = account(x.userId);
  const fx = fxOf(s);
  const c = commissionRate(s.market);
  const { gain, loss } = perShare({ entryPrice: x.entryPrice, targetPrice: x.targetPrice, stopPrice: x.stopPrice, market: s.market });
  const unitKrw = x.entryPrice * fx * (1 + c);
  const power = Math.max(0, acc.buyingPowerKrw ?? 0);
  const budgetKrw = x.budget ? (x.budget.mode === "percent" ? Math.floor((power * (x.budget.percent ?? 0)) / 100) : (x.budget.krw ?? 0)) : null;
  let quantity = 0;
  let tooSmall = false;
  if (budgetKrw !== null) {
    if (s.market === "KR") {
      quantity = Math.floor(budgetKrw / unitKrw);
      tooSmall = quantity < 1;
    } else {
      // 미국은 수수료를 뺀 매수 금액을 센트로 내린 소수점 수량 (최소 주문 금액 $1) — 엔진 assess_budget과 같은 식
      const amount = Math.floor((budgetKrw / fx / (1 + c)) * 100) / 100;
      quantity = amount / x.entryPrice;
      tooSmall = amount < 1;
    }
    if (tooSmall) quantity = 0;
  }

  const reasons: string[] = [];
  const codes: string[] = [];
  const add = (code: string, text: string) => {
    codes.push(code);
    reasons.push(text);
  };
  const rr = gain / loss;
  if (rr < MIN_REWARD_RISK) add("reward_risk_low", `손익비 ${rr.toFixed(2)}가 기준(${MIN_REWARD_RISK.toFixed(1)})보다 낮습니다.`);
  if (x.probability * gain - (1 - x.probability) * loss <= 0) add("ev_negative", "비용을 반영한 기대값이 0 이하입니다.");
  if (s.warnings.length) add("warning_stock", `매수 유의 종목입니다: ${s.warnings[0]}`);
  if (budgetKrw !== null) {
    // 넘으면 줄이지 않고 막는다 (assess_position과 같은 방식)
    const need = quantity * unitKrw;
    if (tooSmall) add("budget_too_small", s.market === "KR" ? `투자 금액 ${wonText(budgetKrw)}으로는 1주도 살 수 없습니다.` : `투자 금액 ${wonText(budgetKrw)}이 최소 주문 금액($1)보다 작습니다.`);
    else if (need > power) add("cash_short", `매수 금액 ${wonText(Math.round(need))}이 매수 가능 금액 ${wonText(power)}보다 큼`);
    if (!tooSmall && acc.investedKrw + pendingKrw(x.userId) + need > MAX_TOTAL_INVEST_KRW) add("total_limit", `총 금액 한도(${wonText(MAX_TOTAL_INVEST_KRW)})를 넘습니다`);
  }
  // 장 중이면 직전 종가는 지난 가격이다 — 장중 가격으로 본다 (숫자 없는 문장, docs/API.md "리포트 시세"). 장 밖이면 직전 종가
  if (isOpen(s.market)) {
    if (s.price >= x.targetPrice) add("price_passed", "장중 가격이 이미 목표가 이상이에요");
    else if (s.price <= x.stopPrice) add("price_passed", "장중 가격이 이미 손절가 이하예요");
  } else if (s.close >= x.targetPrice) add("price_passed", `직전 종가 ${priceText(s.close, s.currency)}가 이미 목표가 이상`);
  else if (s.close <= x.stopPrice) add("price_passed", `직전 종가 ${priceText(s.close, s.currency)}가 이미 손절가 이하`);
  return { approved: reasons.length === 0, reasons, codes, quantity, budgetKrw, buyingPowerKrw: power, equityKrw: acc.equityKrw, gain, loss };
}

/**
 * 같은 종목 진행 중 계획·주문, 중단 스위치 (미리 보기·활성화 공통).
 * 서버(autotrade.plans.risk.evaluate)처럼 계획·주문을 따로 본다: 진행 중 계획은 진행 중 주문도 가지므로 둘 다 나온다.
 */
function busyReasons(userId: number, s: MockStock, name: string, out: { reasons: string[]; codes: string[] }) {
  const busyPlan = state.plans.some((p) => p.userId === userId && p.symbol === s.symbol && LIVE.includes(p.status));
  const busyOrder = userOrders(userId).some((o) => o.symbol === s.symbol && (o.status === "ENTRY_PENDING" || o.status === "EXIT_WATCHING"));
  if (busyPlan) {
    out.reasons.push(`${name}에 진행 중인 계획이 있습니다 (같은 종목은 계획 하나만).`);
    out.codes.push("plan_exists");
  }
  if (busyOrder) {
    out.reasons.push(`${name}에 진행 중인 모의 주문·보유가 있습니다 (같은 종목은 포지션 하나만).`);
    out.codes.push("position_exists");
  }
  if (options.halted) {
    out.reasons.push("새 모의 매수가 중단되어 있습니다.");
    out.codes.push("halted");
  }
}

/** manual: 시연용 수동 시작 — 손익비·기대값 (코드, 문장) 짝을 reasons에서 빼 skipped로 옮긴다 (activatable은 남은 사유로, approved는 그대로). */
function previewOf(x: RiskInput, risk: RiskResult, extra: { reasons: string[]; codes: string[] }, manual = false): RiskPreview {
  const fx = fxOf(x.s);
  const texts = [...risk.reasons, ...extra.reasons];
  const pairs = [...risk.codes, ...extra.codes].map((code, i) => ({ code, text: texts[i] }));
  const skipped = pairs.filter((pair) => manual && MANUAL_SKIP_CODES.includes(pair.code));
  const kept = pairs.filter((pair) => !skipped.includes(pair));
  const sized = x.budget !== null;
  const maxLossKrw = Math.round(risk.loss * risk.quantity * fx);
  return {
    approved: risk.approved,
    activatable: kept.length === 0,
    reasons: kept.map((pair) => pair.text),
    reasonCodes: kept.map((pair) => pair.code),
    skippedReasons: skipped.map((pair) => pair.text),
    skippedCodes: skipped.map((pair) => pair.code),
    quantity: risk.quantity,
    amountKrw: Math.round(x.entryPrice * risk.quantity * fx),
    expectedProfitKrw: Math.round(risk.gain * risk.quantity * fx),
    maxLossKrw,
    limitedBy: sized ? "내가 정한 금액" : null,
    budgetMode: x.budget?.mode ?? null,
    budgetPercent: x.budget?.percent ?? null,
    budgetKrw: risk.budgetKrw,
    buyingPowerKrw: risk.buyingPowerKrw,
    equityKrw: risk.equityKrw,
    maxLossRate: sized && risk.equityKrw > 0 ? maxLossKrw / risk.equityKrw : null,
    largeLoss: sized && maxLossKrw > risk.equityKrw * RISK_PER_TRADE, // 경고만 (막지 않는다)
    lastPrice: x.s.close,
    lastPriceAsOf: closeAsOf(x.s),
    priceBasis: "close",
  };
}

function computePreview(userId: number, r: MockRec, budget: BudgetParam | null, manual = false): RiskPreview {
  const s = stockOf(r.symbol);
  const input: RiskInput = {
    userId,
    s,
    entryPrice: r.entryPrice,
    targetPrice: r.targetPrice,
    stopPrice: r.stopPrice,
    probability: r.probability,
    budget,
  };
  const risk = assessRisk(input);
  const extra = { reasons: [] as string[], codes: [] as string[] };
  if (!recOpen(r)) {
    extra.reasons.push("추천의 유효 기한이 지났습니다.");
    extra.codes.push("expired");
  }
  busyReasons(userId, s, r.name, extra);
  return previewOf(input, risk, extra, manual);
}

const given = (v: unknown) => v !== null && v !== undefined && v !== "";

/** budgetPercent(1~100 정수)·budgetKrw(양수, 원) 중 하나 → 넣을 돈. 둘 다 없으면 null, 둘 다·형식 오류는 400 (reasonCodes 없음). */
function parseBudgetParams(percentRaw: unknown, krwRaw: unknown): BudgetParam | null {
  if (given(percentRaw) && given(krwRaw)) throw new MockError(400, "budgetPercent와 budgetKrw 중 하나만 보냅니다.");
  if (given(percentRaw)) {
    const n = Number(percentRaw);
    if (!Number.isInteger(n) || n < 1 || n > 100) throw new MockError(400, "budgetPercent는 1~100 사이의 정수여야 합니다.");
    return { mode: "percent", percent: n, krw: null };
  }
  if (given(krwRaw)) {
    const n = Number(krwRaw);
    if (!Number.isFinite(n) || n <= 0) throw new MockError(400, "budgetKrw는 0보다 큰 숫자여야 합니다.");
    return { mode: "amount", percent: null, krw: n };
  }
  return null;
}

/** 미리 보기 ?manualStart=: 없음·빈 값·0·false는 끔, 1·true는 켬 (앞뒤 공백·대소문자 무시), 그 밖은 400 (사유 코드 없음). */
function parseManualQuery(raw: string | null): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "" || v === "0" || v === "false") return false;
  if (v === "1" || v === "true") return true;
  throw new MockError(400, BAD_MANUAL);
}

/** 활성화 본문 manualStart: 없으면 끔, JSON 불리언이 아니면 400 (null·"true"·1 포함 — acknowledged와 같은 규칙). */
function parseManualBody(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v === "boolean") return v;
  throw new MockError(400, BAD_MANUAL);
}

/** 미리 보기 (GET .../preview?budgetPercent=|budgetKrw=&manualStart=). 금액이 둘 다 없으면 크기 없이 점검만. */
export function riskPreview(
  userId: number,
  id: number,
  budgetPercent: string | null = null,
  budgetKrw: string | null = null,
  manualStart: string | null = null,
): RiskPreview {
  return computePreview(userId, recOf(id), parseBudgetParams(budgetPercent, budgetKrw), parseManualQuery(manualStart));
}

/** 가짜 Discord 활성화 링크의 token. 실제 서버는 추천 id + 만료를 서명한다. */
export const demoToken = (recId: number) => `demo-${recId}`;

function notify(userId: number, kind: string, title: string, body: string, link: string | null) {
  state.notifications.push({ id: nextId(), userId, kind, title, body, link, createdAt: kstIso(), readAt: null });
}

function planEvent(p: MockPlan, kind: string, message: string, details: Record<string, unknown> = {}, at = kstIso()) {
  p.events.push({ step: p.events.length + 1, kind, message, details, at });
  p.updatedAt = at;
}

const qtyText = (n: number) => `${n.toLocaleString("ko-KR")}주`;

/** 계획 알림 제목: 시연용 수동 시작 계획이면 앞에 꼬리표 (서버 autotrade/text.py manual_tagged — 본문은 그대로). */
const planTitle = (p: MockPlan, title: string) => (p.manualStart ? `[시연용 수동 시작] ${title}` : title);

/** 계획을 만들고 바로 진입 지정가 주문까지 낸다. manual: 시연용 수동 시작 (사건 details·message에 남긴다). */
function startPlan(user: MockUser, r: MockRec, pv: RiskPreview, via: "web" | "discord", acknowledged: boolean, manual = false): MockPlan {
  const now = kstIso();
  const p: MockPlan = {
    id: nextId(),
    userId: user.id,
    recommendationId: r.id,
    symbol: r.symbol,
    name: r.name,
    market: r.market,
    currency: r.currency,
    source: r.source,
    status: "active",
    via,
    manualStart: manual,
    quantity: pv.quantity,
    budgetMode: pv.budgetMode,
    budgetPercent: pv.budgetPercent,
    budgetKrw: pv.budgetKrw,
    entryPrice: r.entryPrice,
    targetPrice: r.targetPrice,
    stopPrice: r.stopPrice,
    holdingDays: r.holdingDays,
    entryDeadline: r.validUntil,
    orderId: null,
    fillPrice: null,
    filledAt: null,
    exitPrice: null,
    exitReason: null,
    closedAt: null,
    pnlKrw: null,
    failureReason: null,
    activatedAt: now,
    updatedAt: now,
    events: [],
    nextAt: null,
    exitRequested: false,
  };
  state.plans.push(p);
  const link = `/plans/${p.id}`;
  // 문장은 서버(backend/autotrade/plans/executor.py _start·_budget_text)와 같은 모양
  const share = p.budgetMode === "percent" ? `(매수 가능 금액의 ${p.budgetPercent}%)` : "";
  // 시연용 수동 시작이면 키를 더하고 문장 끝에 표시한다 (일반 계획의 details 키·문장은 그대로)
  planEvent(p, "activated", `${via === "discord" ? "Discord 링크" : "웹"}에서 계획 활성화${manual ? " (시연용 수동 시작)" : ""}`, {
    via,
    budgetMode: p.budgetMode,
    budgetPercent: p.budgetPercent,
    budgetKrw: p.budgetKrw,
    acknowledged,
    ...(manual ? { manualStart: true, skippedCodes: pv.skippedCodes } : {}),
  });
  const budgetLine = `내가 정한 금액${share} ${wonText(p.budgetKrw ?? 0)}으로 ${qtyText(pv.quantity)}`;
  planEvent(
    p,
    "risk_checked",
    manual
      ? `리스크 엔진 점검: ${pv.skippedReasons.join("; ")} — 시연용 수동 시작으로 건너뜀. ${budgetLine}`
      : `리스크 엔진 점검 통과: ${budgetLine} (손익비 ${r.rewardRisk.toFixed(2)})`,
    {
      approved: pv.approved, // 리스크 엔진의 원래 판정 (시연용 수동 시작이면 false)
      quantity: pv.quantity,
      limitedBy: pv.limitedBy,
      rewardRisk: r.rewardRisk,
      reasons: [],
      ...(manual ? { manualStart: true, skippedCodes: pv.skippedCodes, skippedReasons: pv.skippedReasons } : {}),
    },
  );
  notify(
    user.id,
    "plan_activated",
    planTitle(p, `${p.name} 계획 활성화`),
    `${qtyText(p.quantity)} · 진입 ${priceText(p.entryPrice, p.currency)} · 목표 ${priceText(p.targetPrice, p.currency)} · 손절 ${priceText(p.stopPrice, p.currency)}`,
    link,
  );

  // 바로 한 번 진행: 진입 지정가 주문
  const s = stockOf(p.symbol);
  const o = newOrder(
    user.id,
    s,
    {
      symbol: s.symbol,
      quantity: p.quantity,
      orderType: "LIMIT",
      limitPrice: p.entryPrice,
      targetPrice: p.targetPrice,
      stopPrice: p.stopPrice,
      days: Math.ceil(p.holdingDays * 1.4),
    },
    now,
    "swing",
  );
  o.note = `자동매매 계획 #${p.id}`;
  state.orders.push(o);
  p.orderId = o.id;
  p.status = "entry_pending";
  p.nextAt = Date.now() + options.planStepMs;
  planEvent(p, "order_placed", `${p.name} ${qtyText(p.quantity)} ${priceText(p.entryPrice, p.currency)} 지정가 매수 주문 접수`, {
    orderId: o.id,
    limitPrice: p.entryPrice,
    quantity: p.quantity,
  });
  notify(user.id, "order_placed", planTitle(p, `${p.name} 진입 주문 접수`), `${qtyText(p.quantity)} ${priceText(p.entryPrice, p.currency)} 지정가. 체결되면 다시 알려 드립니다.`, link);
  return p;
}

export function activate(
  user: MockUser,
  id: number,
  body: { budgetPercent?: unknown; budgetKrw?: unknown; token?: unknown; acknowledged?: unknown; manualStart?: unknown },
): TradePlanDetail {
  const r = recOf(id);
  const token = typeof body.token === "string" && body.token ? body.token : null;
  if (token && token !== demoToken(id)) throw new MockError(400, "활성화 링크가 만료되었거나 올바르지 않습니다.");
  if (body.acknowledged !== undefined && typeof body.acknowledged !== "boolean") throw new MockError(400, "acknowledged는 true 또는 false여야 합니다.");
  const manual = parseManualBody(body.manualStart); // 시연용 수동 시작 (DECISIONS 31장)
  // 넣을 돈은 필수 (2026-10-11) — 입력 오류라 reasonCodes 없이 400
  const budget = parseBudgetParams(body.budgetPercent, body.budgetKrw);
  if (!budget) throw new MockError(400, "투자 금액을 정해 주세요 (budgetPercent 또는 budgetKrw).");
  const pv = computePreview(user.id, r, budget, manual);
  if (!pv.activatable) throw blocked(pv.reasons, pv.reasonCodes); // 장 중이면 가격 점검이 이미 장중 가격이다 (assess)
  // 건너뛸 것이 없는 계획에 시연용 표시를 붙이지 않는다 (Blocked 판정 뒤 — 다른 사유가 먼저 보이게, 서버와 같은 순서)
  if (manual && pv.skippedCodes.length === 0) throw new MockError(400, MANUAL_NOT_NEEDED);
  const p = startPlan(user, r, pv, token ? "discord" : "web", body.acknowledged === true, manual);
  return toPlanDetail(p);
}

function closePlan(p: MockPlan, o: MockOrder) {
  p.status = "closed";
  p.exitPrice = o.exitPrice;
  p.exitReason = o.exitReason;
  p.closedAt = o.closedAt;
  p.pnlKrw = o.pnlKrw;
  p.nextAt = null;
  const why =
    o.exitReason === "TARGET"
      ? "목표가 도달"
      : o.exitReason === "STOP"
        ? "손절가 도달"
        : o.exitReason === "EXPIRED"
          ? "보유 기한 경과"
          : "사용자 매도";
  planEvent(
    p,
    "closed",
    `${why}로 청산 (${priceText(o.exitPrice ?? 0, p.currency)}, 손익 ${krwText(o.pnlKrw ?? 0)})`,
    { orderId: o.id, exitReason: o.exitReason, exitPrice: o.exitPrice, pnlKrw: o.pnlKrw },
    o.closedAt ?? kstIso(),
  );
  notify(p.userId, "closed", planTitle(p, `${p.name} 청산 (${why})`), `${priceText(o.exitPrice ?? 0, p.currency)}에 ${qtyText(p.quantity)} 매도 · 손익 ${krwText(o.pnlKrw ?? 0)}`, `/plans/${p.id}`);
}

/** 진행 중 계획을 연결된 주문에 맞추고, 시연용으로 시간이 지나면 다음 단계로 보낸다. */
function advancePlans() {
  const nowMs = Date.now();
  for (const p of state.plans) {
    if (!LIVE.includes(p.status)) continue;
    const o = state.orders.find((x) => x.id === p.orderId);
    if (!o) continue;
    const link = `/plans/${p.id}`;
    const pastCutoff = nowMs > Date.parse(p.entryDeadline);
    if (p.status === "entry_pending") {
      if (o.status === "ENTRY_PENDING" && pastCutoff) {
        o.status = "CANCELED";
        o.note = "진입 기한 만료";
        p.status = "expired";
        p.failureReason = "진입 기한까지 체결되지 않아 주문을 취소했습니다.";
        planEvent(p, "expired", "진입 기한이 지나 주문을 취소했습니다", { orderId: o.id });
        notify(p.userId, "expired", planTitle(p, `${p.name} 진입 기한 만료`), "진입가에 체결되지 않아 계획이 끝났습니다.", link);
        continue;
      }
      if (o.status === "ENTRY_PENDING" && p.nextAt !== null && nowMs >= p.nextAt) enter(o, p.entryPrice, kstIso());
      if (o.status === "EXIT_WATCHING" || o.status === "CLOSED") {
        p.status = "holding";
        p.fillPrice = o.fillPrice;
        p.filledAt = o.filledAt;
        p.nextAt = nowMs + options.planStepMs;
        planEvent(p, "filled", `${p.name} ${qtyText(p.quantity)} ${priceText(o.fillPrice ?? 0, p.currency)}에 체결`, {
          orderId: o.id,
          fillPrice: o.fillPrice,
          quantity: p.quantity,
        });
        notify(p.userId, "filled", planTitle(p, `${p.name} 진입 체결`), `${priceText(o.fillPrice ?? 0, p.currency)}에 ${qtyText(p.quantity)} 매수. 목표가·손절가를 자동으로 감시합니다.`, link);
      } else if (o.status === "CANCELED") {
        p.status = "cancelled";
        p.failureReason = "내 주식에서 주문을 직접 취소했습니다.";
        planEvent(p, "cancelled", "모의 주문이 취소되어 계획을 끝냈습니다", { reason: p.failureReason });
        notify(p.userId, "cancelled", planTitle(p, `${p.name} 계획 중단`), p.failureReason, link);
        continue;
      }
    }
    if (p.status === "holding") {
      if (o.status === "EXIT_WATCHING" && !p.exitRequested && p.nextAt !== null && nowMs >= p.nextAt) {
        exit(o, p.targetPrice, "TARGET", kstIso());
      }
      if (o.status === "CLOSED") closePlan(p, o);
    }
  }
}

function planOf(userId: number, id: number): MockPlan {
  const p = state.plans.find((x) => x.id === id && x.userId === userId);
  if (!p) throw new MockError(404, "계획을 찾을 수 없습니다.");
  return p;
}

function toPlan(p: MockPlan): TradePlan {
  const { events: _e, nextAt: _n, exitRequested: _x, ...rest } = strip(p);
  void _e;
  void _n;
  void _x;
  return rest;
}

function toPlanDetail(p: MockPlan): TradePlanDetail {
  return { ...toPlan(p), recommendation: toRecommendation(recOf(p.recommendationId, true), p.userId), events: p.events };
}

export function listPlans(userId: number, status: string | null): TradePlan[] {
  runEngine();
  return state.plans
    .filter((p) => p.userId === userId && (status === "all" || LIVE.includes(p.status)))
    .sort((a, b) => b.id - a.id)
    .map(toPlan);
}

export function getPlan(userId: number, id: number): TradePlanDetail {
  runEngine();
  return toPlanDetail(planOf(userId, id));
}

export function cancelPlan(userId: number, id: number): TradePlanDetail {
  runEngine();
  const p = planOf(userId, id);
  if (!LIVE.includes(p.status)) throw new MockError(400, "이미 끝난 계획입니다.");
  const o = state.orders.find((x) => x.id === p.orderId);
  const link = `/plans/${p.id}`;
  if (p.status === "holding" && o?.status === "EXIT_WATCHING") {
    if (p.exitRequested) throw new MockError(400, "이미 매도를 요청했습니다.");
    const res = sellOrder(userId, o.id);
    p.exitRequested = true;
    planEvent(p, "exit_requested", res.reservation ? "장이 닫혀 있어 다음 정규장 시작에 전량 매도를 예약했습니다" : "보유 수량 전량 매도를 요청했습니다", {
      orderId: o.id,
      reservationId: res.reservation?.id ?? null,
    });
    if ((o.status as Order["status"]) === "CLOSED") closePlan(p, o); // 정규장이면 바로 매도 체결
    return toPlanDetail(p);
  }
  if (o?.status === "ENTRY_PENDING") {
    o.status = "CANCELED";
    o.note = "계획 중단";
  }
  p.status = "cancelled";
  p.nextAt = null;
  p.failureReason = "사용자가 계획을 중단했습니다.";
  planEvent(p, "cancelled", "사용자가 계획을 중단해 체결 대기 주문을 취소했습니다", { reason: p.failureReason });
  notify(userId, "cancelled", planTitle(p, `${p.name} 계획 중단`), "체결 대기 주문을 취소했습니다.", link);
  return toPlanDetail(p);
}

/** 시연용 규칙 추천 (AI 아님): 완성 일봉 ATR(14)로 손절 1.5배·목표 4.5배, 진입은 직전 종가 기준. */
export function createDemo(user: MockUser, body: { symbol?: unknown }): Recommendation {
  if (!options.demoEnabled) throw new MockError(403, "시연용 추천이 꺼져 있습니다 (AUTOTRADE_DEMO=off).");
  if ((state.demoUsed[user.id] ?? 0) >= DEMO_PER_USER) throw new MockError(429, `오늘 시연용 추천 한도(${DEMO_PER_USER}개)를 다 썼습니다.`);
  if (!options.brokerReady) throw new MockError(503, "증권사 조회 키가 없어 일봉을 받을 수 없습니다.");
  const raw = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : "";
  const symbol = raw || DEMO_SYMBOLS[(state.demoUsed[user.id] ?? 0) % DEMO_SYMBOLS.length];
  const s = state.stocks.find((x) => x.symbol === symbol);
  if (!s) throw new MockError(400, `종목 ${symbol}을(를) 찾을 수 없습니다.`);
  const bars = candles(s).slice(-14);
  const atr = bars.reduce((n, b) => n + (b.high - b.low), 0) / bars.length;
  const entry = roundTick(s.close, s.currency); // 직전 장마감 종가 그대로 (backend/autotrade/recommend/demo.py)
  const created = new Date();
  const r = makeRec(nextId(), {
    source: "demo",
    sourceId: null,
    requestedBy: user.nickname,
    symbol: s.symbol,
    entryPrice: entry,
    stopPrice: roundTick(entry - 1.5 * atr, s.currency),
    targetPrice: roundTick(entry + 4.5 * atr, s.currency),
    holdingDays: 5,
    probability: null,
    confidence: null,
    summary: `${s.name}: 최근 변동폭(ATR) 기준 규칙으로 만든 시연용 진입·목표·손절입니다.`,
    reasons: [`일봉 ATR(14) ${priceText(atr, s.currency)} 기준 손절 1.5배, 목표 4.5배`, "직전 장마감 종가로 진입"],
    risks: ["AI 판단이 아닌 시연용 규칙입니다.", "확률은 0.5로 가정했습니다."],
    riskLevel: null,
    createdAt: kstIso(created),
    validUntil: kstIso(new Date(created.getTime() + 3 * 86_400_000)),
  });
  state.recommendations.push(r);
  state.demoUsed[user.id] = (state.demoUsed[user.id] ?? 0) + 1;
  notify(user.id, "recommendation", `${s.name} 시연용 추천`, `진입 ${priceText(r.entryPrice, s.currency)} · 목표 ${priceText(r.targetPrice, s.currency)} · 손절 ${priceText(r.stopPrice, s.currency)}`, `/recommendations/${r.id}`);
  return toRecommendation(r, user.id);
}

export function listNotifications(userId: number, unread: boolean) {
  runEngine();
  const mine = state.notifications.filter((n) => n.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const unreadCount = mine.filter((n) => !n.readAt).length;
  return { rows: (unread ? mine.filter((n) => !n.readAt) : mine).map(strip), unreadCount };
}

export function markRead(userId: number, body: { ids?: unknown; all?: unknown }) {
  const ids = Array.isArray(body.ids) ? body.ids.map(Number) : [];
  if (!body.all && ids.length === 0) throw new MockError(400, "ids나 all 중 하나를 보내 주세요.");
  for (const n of state.notifications) {
    if (n.userId === userId && !n.readAt && (body.all || ids.includes(n.id))) n.readAt = kstIso();
  }
}

function settingsOf(userId: number): MockSettings {
  return (state.notificationSettings[userId] ??= { discordUserId: null, discordEnabled: true });
}

export function notificationSettings(userId: number): NotificationSettings {
  return { ...settingsOf(userId), webhookConfigured: options.webhookConfigured };
}

export function updateNotificationSettings(userId: number, body: { discordUserId?: unknown; discordEnabled?: unknown }): NotificationSettings {
  const cur = settingsOf(userId);
  if (body.discordUserId !== undefined) {
    const v = body.discordUserId === null ? "" : String(body.discordUserId).trim();
    if (v && !/^\d{17,20}$/.test(v)) throw new MockError(400, "Discord 사용자 ID는 숫자 17~20자리입니다.");
    cur.discordUserId = v || null;
  }
  if (body.discordEnabled !== undefined) cur.discordEnabled = Boolean(body.discordEnabled);
  return notificationSettings(userId);
}

export function testNotification(userId: number): NotificationTestResult {
  const cur = settingsOf(userId);
  const discord: NotificationTestResult["discord"] = !options.webhookConfigured ? "not_configured" : cur.discordEnabled ? "queued" : "disabled";
  notify(userId, "system", "테스트 알림", "알림이 잘 도착하는지 확인하는 메시지입니다.", "/notifications");
  const detail =
    discord === "queued"
      ? `웹 알림을 만들고 Discord로도 보냈습니다${cur.discordUserId ? " (멘션 포함)" : ""}.`
      : discord === "disabled"
        ? "웹 알림을 만들었습니다. Discord로 받기가 꺼져 있어 Discord로는 보내지 않았습니다."
        : "웹 알림을 만들었습니다. 서버에 Discord Webhook이 없어 Discord로는 보내지 않았습니다.";
  return { detail, discord };
}

// ---------------------------------------------------------------- 장기투자 (오늘의 내 종목 뉴스 · 산 이유 · 펀더멘털)

const DAILY_MOVE_MIN = 16 * 60 + 30; // DAILY_MOVE_AT 16:30 KST

/** 오늘의 내 종목 뉴스가 있는 가장 최근 날짜: KR 기준일 (오늘이면 16:30 이후만). */
function latestMoveDay(now = new Date()): string {
  const basis = basisDay("KR", now);
  if (basis === kstDay(now) && marketMinutes("KR", now) < DAILY_MOVE_MIN) return weekdaysEnding(basis, 2)[0];
  return basis;
}

/** 종목·날짜의 기록 (최근 20거래일 안의 국내 종목만). 없으면 null. */
function moveOf(s: MockStock, day: string): DailyMove | null {
  if (s.market !== "KR" || !isWeekday(day) || day > latestMoveDay()) return null;
  const bars = candles(s);
  const i = bars.findIndex((b) => b.date === day);
  if (i < 0 || bars.length - i > 20) return null;
  return dailyMoveOf(s, bars.slice(0, i + 1), options.quoteProvider);
}

/** 내가 지금 보유(EXIT_WATCHING) 중인 국내 종목. */
function heldKr(userId: number): MockStock[] {
  const symbols = new Set(userOrders(userId).filter((o) => o.status === "EXIT_WATCHING" && o.market === "KR").map((o) => o.symbol));
  return [...symbols].map(stockOf);
}

export function dailyMoves(userId: number, dateParam: string | null): DailyMoveList {
  const date = parseDayParam(dateParam);
  const held = heldKr(userId);
  const day = date ?? (held.length ? latestMoveDay() : null);
  if (!day) return { date: null, results: [] };
  const results = held
    .map((s) => moveOf(s, day))
    .filter((m): m is DailyMove => m !== null)
    .sort((a, b) => a.name.localeCompare(b.name, "ko"));
  if (!date && !results.length) return { date: null, results: [] };
  return { date: day, results };
}

export function dailyMoveOne(symbol: string, dateParam: string | null): DailyMove {
  const date = parseDayParam(dateParam);
  const s = stockOf(symbol);
  const move = moveOf(s, date ?? latestMoveDay());
  if (!move) throw new MockError(404, "그날 기록이 없습니다.");
  return move;
}

const THESIS_AXES: ThesisAxis[] = ["growth", "profitability", "balance_sheet"];

/** 이 종목을 장기 보유(style long, 체결 대기·보유 중) 중인지. 장기 매수 예약이 있어도 보유로 본다 (서버 long_holdings). */
const holdsLong = (userId: number, symbol: string) =>
  userOrders(userId).some((o) => o.symbol === symbol && o.style === "long" && (o.status === "ENTRY_PENDING" || o.status === "EXIT_WATCHING")) ||
  state.reservations.some((r) => r.userId === userId && r.symbol === symbol && r.kind === "BUY" && r.style === "long");

function toThesis(t: MockThesis): Thesis {
  const s = stockOf(t.symbol);
  const { userId, ...rest } = t;
  return { ...rest, name: s.name, market: s.market, active: holdsLong(userId, t.symbol) };
}

export function listTheses(userId: number): Thesis[] {
  return state.theses
    .filter((t) => t.userId === userId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(toThesis);
}

export function putThesis(userId: number, symbol: string, body: Record<string, unknown>): Thesis {
  onlyKeys(body, ["reasons", "axes"]);
  const s = stockOf(symbol);
  const raw = body.reasons;
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 3) throw new MockError(400, "산 이유는 1~3개로 적어 주세요.");
  const reasons = raw.map((x) => (typeof x === "string" ? x.trim() : ""));
  if (reasons.some((x) => x.length < 1 || x.length > 100)) throw new MockError(400, "산 이유는 하나에 1~100자로 적어 주세요.");
  let axes: ThesisAxis[] | undefined;
  if (body.axes !== undefined) {
    if (!Array.isArray(body.axes) || body.axes.some((a) => !THESIS_AXES.includes(a as ThesisAxis))) throw new MockError(400, "점검 축이 올바르지 않습니다.");
    if (new Set(body.axes).size !== body.axes.length) throw new MockError(400, "점검 축이 겹칩니다.");
    axes = body.axes as ThesisAxis[];
  }
  const now = kstIso();
  const cur = state.theses.find((t) => t.userId === userId && t.symbol === s.symbol);
  if (cur) {
    cur.reasons = reasons;
    if (axes) cur.axes = axes;
    cur.updatedAt = now;
    return toThesis(cur);
  }
  // 처음 만들 때만 기준선을 잡는다 (적용하지 않는 종목이면 빈 기준선)
  const m = metricsOf(s);
  const t: MockThesis = {
    userId,
    symbol: s.symbol,
    reasons,
    axes: axes ?? [],
    baseline: m ? { ...m.values } : {},
    baselinePeriod: m?.period ?? null,
    lastCheck: null,
    createdAt: now,
    updatedAt: now,
  };
  state.theses.push(t);
  return toThesis(t);
}

export function deleteThesis(userId: number, symbol: string) {
  const i = state.theses.findIndex((t) => t.userId === userId && t.symbol === symbol.toUpperCase());
  if (i < 0) throw new MockError(404, "산 이유를 찾을 수 없습니다.");
  state.theses.splice(i, 1);
}

export function fundamentals(userId: number, symbol: string): FundamentalsView {
  const s = stockOf(symbol);
  const mine = state.theses.find((t) => t.userId === userId && t.symbol === s.symbol);
  const base = {
    symbol: s.symbol,
    name: s.name,
    market: s.market,
    source: FUNDAMENTALS_SOURCE,
    caption: FUNDAMENTALS_CAPTION,
    thesis: mine ? toThesis(mine) : null,
  };
  const m = metricsOf(s);
  if (!m) return { ...base, applicable: false, reason: s.fundamentalsNa ?? "적용하지 않아요", overall: "na", rows: [], asOf: null };
  const rows = judgeRows(m, null);
  return { ...base, applicable: true, reason: null, overall: overallOf(rows), rows, asOf: { period: m.period, receivedAt: m.receivedAt } };
}

/** 산 이유 점검 한 번 (기준선 비교 포함). previous가 있으면 newBad·previousOverall을 그것과 비교한다. */
function checkOf(t: MockThesis, s: MockStock, at: string, previous: ThesisCheck | null): ThesisCheck | null {
  const m = metricsOf(s);
  if (!m) return null;
  const rows = judgeRows(m, t.baseline);
  const overall = overallOf(rows);
  const prevBad = new Set(previous?.rows.filter((r) => r.status === "bad").map((r) => r.key) ?? []);
  const newBad = rows.filter((r) => r.status === "bad" && !prevBad.has(r.key)).map((r) => r.key as FundamentalKey);
  return {
    id: nextId(),
    checkedAt: at,
    trigger: "filing",
    period: m.period,
    receivedAt: m.receivedAt,
    overall,
    previousOverall: previous?.overall ?? null,
    rows,
    newBad,
    notified: newBad.length > 0,
    caption: FUNDAMENTALS_CAPTION,
  };
}

// ---------------------------------------------------------------- 초기 데이터

/** 앨리스는 진단을 마친 중급(주린이모드 끔) — 지금 화면(전문가 보기) 테스트가 그대로 돈다. 다른 팀원은 진단 전(켬). */
function seedProfiles() {
  state.profiles[1] = {
    beginnerMode: false,
    answers: { q1: "1_3y", q2: ["kr_stock", "us_stock"], q3: "monthly", q4: "explain", q5: "loss_20", q6: "weeks", q7: "growth" },
    assessedAt: daysAgoIso(12),
  };
}

function seedAlice() {
  const at = (days: number) => daysAgoIso(days);
  const buy = (symbol: string, qty: number, price: number, days: number, style: HoldingStyle, extra: Partial<OrderRequest> = {}) => {
    const s = stockOf(symbol);
    const o = newOrder(1, s, { symbol, quantity: qty, orderType: "MARKET", ...extra }, at(days), style);
    o.entryPrice = price;
    state.orders.push(o);
    enter(o, price, at(days));
    return o;
  };
  buy("005930", 10, 69_500, 3, "swing", { targetPrice: 77_000, stopPrice: 66_000, days: 10 });
  buy("NVDA", 8, 117.2, 6, "swing", { targetPrice: 132, stopPrice: 110, days: 14 });
  buy("068270", 5, 178_000, 20, "long"); // 장기 보유 (자동 매도 없음, 산 이유 있음)
  const closed = buy("000660", 5, 172_000, 9, "long");
  exit(closed, 181_000, "TARGET", at(2));
  const pending = newOrder(1, stockOf("035720"), { symbol: "035720", quantity: 20, orderType: "LIMIT", limitPrice: 44_000 }, at(0), "long");
  state.orders.push(pending);
}

function seedAnalyses() {
  // 요청자: 팀원이면 user id(밖으로는 닉네임), 아니면 "strategy:<번호>"·"cli" 그대로
  const rows: [string, "BUY" | "PASS", number, number | string, number?][] = [
    ["005930", "BUY", 0.08, 1],
    ["000660", "BUY", 0.21, "strategy:1"],
    ["NVDA", "PASS", 1.1, 2],
    ["035720", "PASS", 1.3, "cli"],
    ["247540", "BUY", 2.2, 4],
    ["AAPL", "PASS", 3.1, 1, 0],
  ];
  rows.forEach(([symbol, verdict, daysAgo, by, count], i) => {
    const at = kstIso(new Date(Date.now() - daysAgo * 86_400_000));
    const user = typeof by === "number" ? state.users.find((u) => u.id === by)! : null;
    state.analyses.push({
      ...makeAnalysis(i + 1, stockOf(symbol), verdict, at, user ? user.nickname : (by as string), count ?? 3),
      requesterId: user ? user.id : null,
    });
  });
}

function seedReports() {
  const user = (id: number) => state.users.find((u) => u.id === id)!;
  state.reports.push(newReport(1, user(2), stockOf("000660"), daysAgoIso(1)));
  // 앨리스의 리포트는 늘 "오늘" 것 (하루 한도 셈이 시각에 따라 바뀌지 않게): 2시간 전, 자정을 넘지 않게
  const twoHoursAgo = Math.max(kstDayStartMs(kstDay()) + 60_000, Date.now() - 2 * 3_600_000);
  state.reports.push(newReport(2, user(1), stockOf("005930"), kstIso(new Date(twoHoursAgo))));
}

/** 끝난 예시 리포트: 완성(긍정적·추천 있음) · 완성(지켜보기) · 실패(검토 실패). 기본 seed의 리포트·추천은 그대로 둔다. */
export function addSampleReports() {
  const user = (id: number) => state.users.find((u) => u.id === id)!;
  const add = (userId: number, symbol: string, hoursAgo: number, kind: SampleKind) => {
    const s = stockOf(symbol);
    const r = newReport(nextId(), user(userId), s, kstIso(new Date(Date.now() - hoursAgo * 3_600_000)));
    finishSample(r, s, kind);
    state.reports.push(r);
    return r;
  };
  const buy = add(4, "035420", 5, "buy");
  add(5, "373220", 7, "hold");
  add(2, "086520", 9, "failed");
  const s = stockOf(buy.symbol);
  const t = sampleTargets(s);
  state.recommendations.push(
    makeRec(nextId(), {
      source: "report",
      sourceId: buy.id,
      requestedBy: buy.requestedBy,
      symbol: s.symbol,
      entryPrice: t.entry,
      targetPrice: t.target,
      stopPrice: t.stop,
      holdingDays: t.holdingDays,
      probability: t.probability,
      confidence: 68,
      summary: `${s.name}: 실적 개선과 수급이 이어져 오를 근거가 더 많다고 봤다.`,
      reasons: ["반기 매출·영업이익이 전년보다 늘었다", "20일 이동평균선 위에서 거래대금이 늘었다", "외국인 순매수가 이어졌다"],
      risks: ["업황 지표가 나빠지면 실적 기대가 줄 수 있다", "환율이 급하게 움직이면 수급이 바뀔 수 있다"],
      riskLevel: "medium",
      createdAt: buy.finishedAt ?? kstIso(),
      validUntil: kstIso(new Date(Date.now() + 3 * 86_400_000)),
    }),
  );
}

/** 끝난 예시 선정 실행 하나 (자동, 오늘 08:00쯤). 오늘의 선별(screening)이 이 실행 번호로 'AI 선정 과정 보기'를 잇는다. */
export function addSampleSelection(): number {
  // 오늘 08:00 (그 전이면 1분 전)
  const at = kstIso(new Date(Math.min(kstDayStartMs(kstDay()) + 8 * 3_600_000, Date.now() - 60_000)));
  const r: MockReport = { ...selectionSample(nextId(), at), userId: 0 };
  state.reports.push(r);
  return r.id;
}

/** 오늘의 선별 (AI 선정 예시). 끝난 선정 실행이 있으면 그 번호를 잇는다 (없으면 null — 과정 보기 링크가 없다). */
export function screening(): ScreeningResult {
  const run = [...state.reports].reverse().find((r) => teamOf(r) === "stock_selection" && r.status === "completed");
  return { ...sampleScreening(), selection: { reportId: run?.id ?? null, status: "done" } };
}

/** 추천 4개(리포트·분석·시연, 하나는 만료)와 앨리스의 끝난 계획 하나, 알림 몇 개. */
function seedAutotrade() {
  const hoursAgo = (h: number) => kstIso(new Date(Date.now() - h * 3_600_000));
  const hoursLater = (h: number) => kstIso(new Date(Date.now() + h * 3_600_000));
  const recs: [number, RecInput][] = [
    [
      91,
      {
        source: "report",
        sourceId: 1,
        requestedBy: "밥",
        symbol: "000660",
        entryPrice: 181_000,
        targetPrice: 203_000,
        stopPrice: 173_000,
        holdingDays: 10,
        probability: 0.58,
        confidence: 72,
        summary: "HBM 수요가 이어지며 직전 고점 돌파를 노릴 구간. 181,000원 눌림에서 진입한다.",
        reasons: ["HBM 공급 계약 확대 기사가 이어짐", "20일 이동평균선 위에서 거래대금 증가", "외국인 순매수 5거래일 연속"],
        risks: ["반도체 업황 지표 발표 전후 변동성", "환율 급변 시 외국인 수급 반전"],
        riskLevel: "medium",
        createdAt: hoursAgo(5),
        validUntil: hoursLater(48),
      },
    ],
    [
      92,
      {
        source: "analysis",
        sourceId: 5,
        requestedBy: "데이브",
        symbol: "247540",
        entryPrice: 200_000,
        targetPrice: 225_000,
        stopPrice: 191_000,
        holdingDays: 7,
        probability: 0.55,
        confidence: 64,
        summary: "2차전지 소재 반등 초입. 200,000원 지지 확인 뒤 225,000원까지.",
        reasons: ["교차검증 3개 모델 중 2개 통과", "단기 낙폭 과대 후 거래량 동반 반등"],
        risks: ["업황 회복 지연 시 재차 하락", "변동성이 커 손절 미끄러짐 가능"],
        riskLevel: null,
        createdAt: hoursAgo(20),
        validUntil: hoursLater(30),
      },
    ],
    [
      93,
      {
        source: "demo",
        sourceId: null,
        requestedBy: "앨리스",
        symbol: "035420",
        entryPrice: 191_200, // NAVER 직전 장마감 종가
        targetPrice: 210_000,
        stopPrice: 183_000,
        holdingDays: 5,
        probability: null,
        confidence: null,
        summary: "NAVER: 최근 변동폭(ATR) 기준 규칙으로 만든 시연용 진입·목표·손절입니다.",
        reasons: ["일봉 ATR(14) 기준 손절 1.5배, 목표 4.5배", "직전 장마감 종가로 진입"],
        risks: ["AI 판단이 아닌 시연용 규칙입니다.", "확률은 0.5로 가정했습니다."],
        riskLevel: null,
        createdAt: hoursAgo(1),
        validUntil: hoursLater(71),
      },
    ],
    [
      90,
      {
        source: "analysis",
        sourceId: 1,
        requestedBy: "앨리스",
        symbol: "005930",
        entryPrice: 69_500,
        targetPrice: 77_000,
        stopPrice: 66_000,
        holdingDays: 10,
        probability: 0.6,
        confidence: 70,
        summary: "메모리 가격 반등 기대. 69,500원 진입, 77,000원 목표.",
        reasons: ["20일 이동평균선 위에서 거래대금이 늘며 지지를 확인", "직전 고점까지 상승 여력"],
        risks: ["단기 과열 시 눌림 가능"],
        riskLevel: "low",
        createdAt: hoursAgo(80),
        validUntil: hoursAgo(8),
      },
    ],
  ];
  for (const [id, x] of recs) state.recommendations.push(makeRec(id, x));

  // 앨리스가 만료된 추천(90)으로 끝까지 진행한 계획: 활성화 → 체결 → 목표가 청산
  const at = (h: number) => hoursAgo(h);
  const done: MockPlan = {
    id: 95,
    userId: 1,
    recommendationId: 90,
    symbol: "005930",
    name: "삼성전자",
    market: "KR",
    currency: "KRW",
    source: "analysis",
    status: "closed",
    via: "discord",
    manualStart: false,
    quantity: 14,
    budgetMode: null, // 2026-10-11 전에 활성화한 계획 (리스크 엔진이 수량을 정함)
    budgetPercent: null,
    budgetKrw: null,
    entryPrice: 69_500,
    targetPrice: 77_000,
    stopPrice: 66_000,
    holdingDays: 10,
    entryDeadline: hoursAgo(8),
    orderId: null,
    fillPrice: 69_500,
    filledAt: at(70),
    exitPrice: 77_000,
    exitReason: "TARGET",
    closedAt: at(26),
    pnlKrw: 102_850,
    failureReason: null,
    activatedAt: at(78),
    updatedAt: at(26),
    nextAt: null,
    exitRequested: false,
    // 이 계획의 주문은 씨앗 데이터에 없어서 orderId·previousOrderId는 null (키 모양은 docs/API.md PlanEventKind)
    events: [
      { step: 1, kind: "activated", message: "Discord 링크에서 계획 활성화", details: { via: "discord", budgetKrw: null, acknowledged: false }, at: at(78) },
      { step: 2, kind: "risk_checked", message: "리스크 엔진 통과: 14주 (건당 위험 한도), 손익비 2.04", details: { approved: true, quantity: 14, limitedBy: "건당 위험 한도", rewardRisk: 2.04, reasons: [] }, at: at(78) },
      { step: 3, kind: "order_placed", message: "삼성전자 14주 69,500원 지정가 매수 주문 접수", details: { orderId: null, limitPrice: 69_500, quantity: 14 }, at: at(78) },
      { step: 4, kind: "order_requeued", message: "그날 체결되지 않아 다음 정규장에 다시 주문", details: { orderId: null, previousOrderId: null }, at: at(72) },
      { step: 5, kind: "filled", message: "삼성전자 14주 69,500원에 체결", details: { orderId: null, fillPrice: 69_500, quantity: 14 }, at: at(70) },
      { step: 6, kind: "closed", message: "목표가 도달로 청산 (77,000원, 손익 +102,850원)", details: { orderId: null, exitReason: "TARGET", exitPrice: 77_000, pnlKrw: 102_850 }, at: at(26) },
    ],
  };
  state.plans.push(done);

  const n = (id: number, kind: string, title: string, body: string, link: string | null, h: number, read: boolean) =>
    state.notifications.push({ id, userId: 1, kind, title, body, link, createdAt: hoursAgo(h), readAt: read ? hoursAgo(h - 0.5) : null });
  n(80, "closed", "삼성전자 청산 (목표가 도달)", "77,000원에 14주 매도 · 손익 +102,850원", "/plans/95", 26, true);
  n(81, "recommendation", "SK하이닉스 AI 추천", "AI 리포트 결론: 진입 181,000원 · 목표 203,000원 · 손절 173,000원", "/recommendations/91", 5, false);
  n(82, "recommendation", "NAVER 시연용 추천", "진입 191,200원 · 목표 210,000원 · 손절 183,000원", "/recommendations/93", 1, false);
}

/** 앨리스의 장기 보유(셀트리온) 산 이유와 최근 점검 (기준선은 직전 보고서 값이라 일부 지표가 달라졌다). */
function seedTheses() {
  const s = stockOf("068270");
  const m = metricsOf(s);
  if (!m) return;
  const v = m.values;
  const baseline: Partial<Record<FundamentalKey, number | null>> = {
    ...v,
    operatingMargin: v.operatingMargin === null ? null : Math.round((v.operatingMargin + 0.018) * 10_000) / 10_000,
    roe: v.roe === null ? null : Math.round((v.roe + 0.006) * 10_000) / 10_000,
    debtRatio: v.debtRatio === null ? null : Math.round((v.debtRatio - 0.08) * 10_000) / 10_000,
  };
  const t: MockThesis = {
    userId: 1,
    symbol: s.symbol,
    reasons: ["바이오시밀러 해외 판매가 늘고 있어서", "신약 개발 일정이 공개돼 있어서"],
    axes: ["growth", "profitability"],
    baseline,
    baselinePeriod: "2025 사업보고서",
    lastCheck: null,
    createdAt: daysAgoIso(20),
    updatedAt: daysAgoIso(20),
  };
  t.lastCheck = checkOf(t, s, `${m.receivedAt}T18:05:00+09:00`, null);
  state.theses.push(t);
}

state = freshState();
