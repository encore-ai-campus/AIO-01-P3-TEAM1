// 가짜 API의 상태와 규칙 (docs/API.md 주문 규칙을 단순하게 흉내 낸다). 개발 화면 확인·테스트 전용.
import type {
  AccountSummary,
  AnalysisDetail,
  AnalysisQuota,
  AnalysisSummary,
  Candle,
  Fill,
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
  Quote,
  PlanEvent,
  Ranking,
  Recommendation,
  RecommendationSource,
  RiskPreview,
  TradePlan,
  TradePlanDetail,
  ChaosConfig,
  ChaosRequest,
  ReportDetail,
  ReportSummary,
  Reservation,
  StockDetail,
  StockItem,
} from "../api/types";
import { addDays, businessDays, kstDay, kstIso, session } from "./clock";
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
const STORAGE_KEY = "paper-mock-db-v1";

export class MockError extends Error {
  readonly status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

type Owned<T> = T & { userId: number };
type MockOrder = Owned<Order> & { fx: number };
type MockJob = Owned<Job> & { symbol: string; polls: number };
type MockReport = Owned<ReportDetail>;
/** 추천은 팀 공용. status·myPlan·planCount는 볼 때 계산한다. */
type MockRec = Omit<Recommendation, "status" | "myPlan" | "planCount">;
/** nextAt: 시연용 진행 시각 (이 시각이 지나면 다음 단계로). exitRequested: 보유 중 중단으로 매도를 요청함. */
type MockPlan = Owned<TradePlan> & { events: PlanEvent[]; nextAt: number | null; exitRequested: boolean };
type MockSettings = Omit<NotificationSettings, "webhookConfigured">;

interface State {
  seq: number;
  users: MockUser[];
  stocks: MockStock[];
  cash: Record<number, number>;
  orders: MockOrder[];
  fills: Owned<Fill>[];
  reservations: Owned<Reservation>[];
  analyses: AnalysisDetail[];
  jobs: MockJob[];
  reports: MockReport[];
  recommendations: MockRec[];
  plans: MockPlan[];
  notifications: Owned<Notification>[];
  notificationSettings: Record<number, MockSettings>;
  demoUsed: Record<number, number>;
  usedToday: Record<number, number>;
  sessionUserId: number | null;
  ticks: Record<string, number>;
}

export interface MockOptions {
  /** 가격이 조금씩 움직이게 한다 (테스트는 끈다). */
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
}

const DEFAULTS: MockOptions = {
  jitter: true,
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
    sessionUserId: null,
    ticks: {},
  };
  for (const u of s.users) s.cash[u.id] = INITIAL_CAPITAL * (1 + (OTHER_RATES[u.id] ?? 0));
  state = s;
  seedAlice();
  seedAnalyses();
  seedReports();
  seedAutotrade();
  return state;
}

/** 상태를 처음으로 되돌린다. 테스트는 매번 부른다. */
export function resetDb(opts: Partial<MockOptions> = {}) {
  options = { ...DEFAULTS, ...opts };
  state = freshState();
}

/** 브라우저에서 저장해 둔 상태를 불러온다. */
export function loadPersisted(opts: Partial<MockOptions> = {}) {
  options = { ...DEFAULTS, ...opts };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state = JSON.parse(raw) as State;
    state.reports ??= []; // 리포트 기능 전에 저장된 상태
    if (!state.recommendations) {
      // 추천·자동매매 기능 전에 저장된 상태
      Object.assign(state, { recommendations: [], plans: [], notifications: [], notificationSettings: {}, demoUsed: {} });
      seedAutotrade();
    }
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

// ---------------------------------------------------------------- 인증

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

export function toMe(u: MockUser): Me {
  return { id: u.id, username: u.username, nickname: u.nickname, isPublic: u.isPublic, isStaff: u.isStaff };
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

// ---------------------------------------------------------------- 시세

function stockOf(symbol: string): MockStock {
  const s = state.stocks.find((x) => x.symbol === symbol.toUpperCase());
  if (!s) throw new MockError(404, "종목을 찾을 수 없습니다.");
  return s;
}

/** 가격을 조금 움직인다 (종목마다 2초에 한 번, 전일 종가 ±30% 안에서). */
function tick(s: MockStock) {
  if (!options.jitter) return;
  const now = Date.now();
  if (now - (state.ticks[s.symbol] ?? 0) < 2000) return;
  state.ticks[s.symbol] = now;
  const step = (Math.random() - 0.48) * 0.004;
  const next = roundTick(s.price * (1 + step), s.currency);
  s.price = Math.min(s.prevClose * 1.3, Math.max(s.prevClose * 0.7, next));
}

export function quoteOf(s: MockStock): Quote {
  tick(s);
  const change = s.currency === "USD" ? Math.round((s.price - s.prevClose) * 100) / 100 : s.price - s.prevClose;
  return {
    symbol: s.symbol,
    name: s.name,
    currency: s.currency,
    price: options.brokerReady ? s.price : null,
    prevClose: s.prevClose,
    change: options.brokerReady ? change : null,
    changeRate: options.brokerReady ? s.price / s.prevClose - 1 : null,
  };
}

/** 테스트·시연용: 종목 가격을 바꾼다 (지정가 체결·목표가 도달을 일으킬 때). */
export function setPrice(symbol: string, price: number) {
  stockOf(symbol).price = price;
}

export function quotes(symbols: string[]): Quote[] {
  runEngine();
  return symbols
    .map((sym) => state.stocks.find((s) => s.symbol === sym.trim().toUpperCase()))
    .filter((s): s is MockStock => Boolean(s))
    .slice(0, 50)
    .map(quoteOf);
}

function candles(s: MockStock): Candle[] {
  const days = businessDays(120);
  const r = seededRandom(s.symbol);
  // 마지막 봉(오늘)의 종가가 현재가가 되도록 뒤에서부터 만든다
  const closes: number[] = new Array(days.length);
  closes[days.length - 1] = s.price;
  closes[days.length - 2] = s.prevClose;
  for (let i = days.length - 3; i >= 0; i--) closes[i] = closes[i + 1] / (1 + (r() - 0.5) * 0.05);
  return days.map((date, i) => {
    const close = roundTick(closes[i], s.currency);
    const open = roundTick(i === 0 ? close : closes[i - 1] * (1 + (r() - 0.5) * 0.01), s.currency);
    const high = roundTick(Math.max(open, close) * (1 + r() * 0.015), s.currency);
    const low = roundTick(Math.min(open, close) * (1 - r() * 0.015), s.currency);
    return { date, open, high, low, close, volume: Math.round(200_000 + r() * 2_000_000) };
  });
}

export function stockDetail(symbol: string): StockDetail {
  const s = stockOf(symbol);
  return {
    symbol: s.symbol,
    name: s.name,
    exchange: s.exchange,
    market: s.market,
    currency: s.currency,
    quote: quoteOf(s),
    candles: candles(s),
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
    markets: (["KR", "US"] as Market[]).map((m) => ({ market: m, ...session(m, new Date(), options.marketOpen[m]) })),
    halted: options.halted,
    brokerReady: options.brokerReady,
  };
}

const isOpen = (m: Market) => session(m, new Date(), options.marketOpen[m]).isOpen;
const fxOf = (s: { currency: string }) => (s.currency === "USD" ? USD_KRW : 1);
const commissionRate = (m: Market) => (m === "KR" ? 0.00015 : 0.001);
const priceText = (n: number, c: string) =>
  c === "USD" ? `$${n.toFixed(2)}` : `${Math.round(n).toLocaleString("ko-KR")}원`;
const krwText = (n: number) => `${n >= 0 ? "+" : "-"}${Math.abs(Math.round(n)).toLocaleString("ko-KR")}원`;

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
  const tax = side === "SELL" && o.market === "KR" ? Math.round(amountKrw * 0.0018) : 0;
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

function newOrder(userId: number, s: MockStock, req: OrderRequest, at: string): MockOrder {
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
      sum += s.price * r.quantity * fxOf(s);
    }
  }
  return Math.round(sum);
}

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
    throw new MockError(400, "손절가 < 기준가 < 목표가 순서여야 합니다.");
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
  if (need > power) {
    throw new MockError(
      400,
      `매수 가능액이 부족합니다 (필요 ${Math.round(need).toLocaleString("ko-KR")}원, 가능 ${Math.round(power).toLocaleString("ko-KR")}원).`,
    );
  }
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
    runAt: session(s.market, new Date(), options.marketOpen[s.market]).opensAt,
    createdAt: kstIso(),
    ...extra,
  };
  state.reservations.push(r);
  return r;
}

export function placeOrder(userId: number, body: OrderRequest): OrderResult {
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
  validate(userId, s, req);
  const now = kstIso();

  if (req.orderType === "MARKET" && !isOpen(s.market)) {
    const r = reservation(userId, "BUY", s, req.quantity, {
      targetPrice: req.targetPrice ?? null,
      stopPrice: req.stopPrice ?? null,
      days: req.days ?? null,
    });
    return {
      order: null,
      reservation: strip(r),
      message: `장이 닫혀 있어 ${s.name} ${req.quantity}주 시장가 매수를 다음 정규장 시작에 예약했습니다.`,
    };
  }

  const o = newOrder(userId, s, req, now);
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
  state.reservations.splice(i, 1);
}

/** 엔진 흉내: 정규장이면 예약 실행, 지정가 체결, 목표·손절 청산 (실제 엔진은 2회 연속 확인). */
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
      const o = newOrder(r.userId, s, req, now);
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

export function account(userId: number): AccountSummary {
  runEngine();
  const positions: Position[] = userOrders(userId)
    .filter((o) => o.status === "EXIT_WATCHING")
    .map((o) => {
      const s = stockOf(o.symbol);
      const last = options.brokerReady ? s.price : null;
      const costKrw = Math.round((o.fillPrice ?? 0) * o.quantity * o.fx);
      const valueKrw = Math.round((last ?? o.fillPrice ?? 0) * o.quantity * fxOf(s));
      return {
        orderId: o.id,
        symbol: o.symbol,
        name: o.name,
        market: o.market,
        currency: o.currency,
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
    notes: options.brokerReady ? [] : ["현재가를 받지 못해 체결가로 평가했습니다."],
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
  const rates = state.users.map((u) => ({ u, rate: account(u.id).profitRate }));
  const results = rates
    .filter((x) => x.u.isPublic)
    .sort((a, b) => b.rate - a.rate)
    .map((x, i) => ({ rank: i + 1, nickname: x.u.nickname, profitRate: x.rate, isMe: x.u.id === userId }));
  const me = state.users.find((u) => u.id === userId)!;
  const mine = results.find((x) => x.isMe);
  return {
    results,
    me: { isPublic: me.isPublic, rank: mine?.rank ?? null, profitRate: account(userId).profitRate },
    asOf: kstIso(),
  };
}

// ---------------------------------------------------------------- AI 분석

function summary(a: AnalysisDetail): AnalysisSummary {
  const { id, symbol, name, market, currency, analyzedAt, verdict, priceAtAnalysis, best, scenarioCount, requestedBy, costUsd } =
    a;
  return { id, symbol, name, market, currency, analyzedAt, verdict, priceAtAnalysis, best, scenarioCount, requestedBy, costUsd };
}

export function listAnalyses(symbol: string | null, verdict: string | null): AnalysisSummary[] {
  return state.analyses
    .filter((a) => (!symbol || a.symbol === symbol.toUpperCase()) && (!verdict || a.verdict === verdict))
    .sort((a, b) => b.analyzedAt.localeCompare(a.analyzedAt) || b.id - a.id)
    .map(summary);
}

export function getAnalysis(id: number): AnalysisDetail {
  const a = state.analyses.find((x) => x.id === id);
  if (!a) throw new MockError(404, "분석을 찾을 수 없습니다.");
  return a;
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
        const a = makeAnalysis(nextId(), s, s.price >= s.prevClose ? "BUY" : "PASS", kstIso(), user.username);
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

function toReportSummary(r: MockReport): ReportSummary {
  const { id, symbol, name, market, status, currentStep, requestedBy, createdAt, startedAt, finishedAt } = r;
  const { source, chaosEnabled, costUsd, hasPdf } = r;
  return { id, symbol, name, market, status, currentStep, requestedBy, createdAt, startedAt, finishedAt, source, chaosEnabled, costUsd, hasPdf };
}

export function listReports(symbol: string | null): ReportSummary[] {
  return state.reports
    .filter((r) => !symbol || r.symbol === symbol.toUpperCase())
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id)
    .map(toReportSummary);
}

export function getReport(id: number): ReportDetail {
  const r = state.reports.find((x) => x.id === id);
  if (!r) throw new MockError(404, "리포트를 찾을 수 없습니다.");
  return strip(r);
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
    source: "user",
    chaosEnabled: filled !== null,
    costUsd: null,
    hasPdf: false,
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

/** 리포트 신청. 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 그것을 돌려준다 (created=false → 200). */
export function requestReport(user: MockUser, symbol: string, chaos?: ChaosRequest): { report: ReportDetail; created: boolean } {
  const s = state.stocks.find((x) => x.symbol === symbol.trim().toUpperCase());
  if (!s) throw new MockError(400, "종목을 찾을 수 없습니다.");
  const open = state.reports.find(
    (r) => r.userId === user.id && r.symbol === s.symbol && r.status !== "completed" && r.status !== "failed",
  );
  if (open) return { report: strip(open), created: false };
  const r = newReport(nextId(), user, s, kstIso(), chaos);
  state.reports.push(r);
  return { report: strip(r), created: true };
}

// ---------------------------------------------------------------- AI 추천 · 매매 계획 · 자동매매 · 알림
// 리스크 엔진(judge/risk.py)의 계산을 단순하게 흉내 낸다: 건당 위험 1%, 최소 손익비 2.0, 매수 가능 금액, 총 금액 한도, 예산.
// 계획은 시연용으로 시간이 지나면 저절로 진행한다 (주문 접수 → planStepMs 뒤 진입가 체결 → planStepMs 뒤 목표가 청산).

const RISK_PER_TRADE = 0.01;
const MIN_REWARD_RISK = 2.0;
const STOP_SLIPPAGE = 0.01;
const MAX_TOTAL_INVEST_KRW = 5_000_000;
const DEMO_PER_USER = 5;
const DEMO_SYMBOLS = ["035420", "005380", "068270", "105560", "035720"];
const LIVE: TradePlan["status"][] = ["active", "entry_pending", "holding"];
const sellTaxRate = (m: Market) => (m === "KR" ? 0.0018 : 0);

/** 1주 기준 이익·손실 (종목 통화, 수수료·세금·손절 미끄러짐 반영). */
function perShare(r: Pick<MockRec, "entryPrice" | "targetPrice" | "stopPrice" | "market">) {
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
    priceAtCreation: s.price,
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

const recOpen = (r: MockRec) => Date.parse(r.validUntil) > Date.now();

function toRecommendation(r: MockRec, userId: number): Recommendation {
  const plans = state.plans.filter((p) => p.recommendationId === r.id);
  const mine = plans.filter((p) => p.userId === userId).sort((a, b) => b.id - a.id);
  const my = mine.find((p) => LIVE.includes(p.status)) ?? mine[0] ?? null;
  return { ...r, status: recOpen(r) ? "open" : "expired", myPlan: my ? { id: my.id, status: my.status } : null, planCount: plans.length };
}

function recOf(id: number): MockRec {
  const r = state.recommendations.find((x) => x.id === id);
  if (!r) throw new MockError(404, "추천을 찾을 수 없습니다.");
  return r;
}

export function listRecommendations(
  userId: number,
  q: { status?: string | null; source?: string | null; sourceId?: string | null; symbol?: string | null },
): Recommendation[] {
  runEngine();
  return state.recommendations
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

function computePreview(userId: number, r: MockRec, budgetKrw: number | null): RiskPreview {
  if (!options.brokerReady) throw new MockError(503, "증권사 조회 키가 없어 지금 가격을 받을 수 없습니다.");
  const s = stockOf(r.symbol);
  const acc = account(userId);
  const fx = fxOf(s);
  const c = commissionRate(s.market);
  const { gain, loss } = perShare(r);
  const unitKrw = r.entryPrice * fx * (1 + c);
  const limits: [string, number][] = [
    ["건당 위험 한도", Math.floor((acc.equityKrw * RISK_PER_TRADE) / (loss * fx))],
    ["매수 가능 금액", Math.floor(Math.max(0, acc.buyingPowerKrw ?? 0) / unitKrw)],
    ["총 금액 한도", Math.floor(MAX_TOTAL_INVEST_KRW / unitKrw)],
  ];
  if (budgetKrw !== null) limits.push(["예산", Math.floor(budgetKrw / unitKrw)]);
  const [limitedBy, quantity] = limits.reduce((a, b) => (b[1] < a[1] ? b : a));

  const reasons: string[] = [];
  const rr = gain / loss;
  if (rr < MIN_REWARD_RISK) reasons.push(`손익비 ${rr.toFixed(2)}가 기준(${MIN_REWARD_RISK.toFixed(1)})보다 낮습니다.`);
  if (quantity < 1) reasons.push(`${limitedBy} 때문에 살 수 있는 수량이 0주입니다.`);
  if (s.price >= r.targetPrice) reasons.push("지금 가격이 이미 목표가 이상입니다.");
  if (s.price <= r.stopPrice) reasons.push("지금 가격이 이미 손절가 이하입니다.");
  const approved = reasons.length === 0;
  if (!recOpen(r)) reasons.push("추천의 유효 기한이 지났습니다.");
  const busyPlan = state.plans.some((p) => p.userId === userId && p.symbol === r.symbol && LIVE.includes(p.status));
  const busyOrder = userOrders(userId).some((o) => o.symbol === r.symbol && (o.status === "ENTRY_PENDING" || o.status === "EXIT_WATCHING"));
  if (busyPlan) reasons.push(`${r.name}에 진행 중인 계획이 있습니다 (같은 종목은 계획 하나만).`);
  else if (busyOrder) reasons.push(`${r.name}에 진행 중인 모의 주문·보유가 있습니다 (같은 종목은 포지션 하나만).`);
  if (options.halted) reasons.push("새 모의 매수가 중단되어 있습니다.");

  const qty = Math.max(0, quantity);
  return {
    approved,
    activatable: reasons.length === 0,
    reasons,
    quantity: qty,
    amountKrw: Math.round(r.entryPrice * qty * fx),
    expectedProfitKrw: Math.round(gain * qty * fx),
    maxLossKrw: Math.round(loss * qty * fx),
    limitedBy,
    budgetKrw,
    lastPrice: s.price,
  };
}

function parseBudgetParam(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new MockError(400, "예산은 0보다 큰 숫자여야 합니다.");
  return n;
}

export function riskPreview(userId: number, id: number, budget: string | null): RiskPreview {
  return computePreview(userId, recOf(id), parseBudgetParam(budget));
}

/** 가짜 Discord 활성화 링크의 token. 실제 서버는 추천 id + 만료를 서명한다. */
export const demoToken = (recId: number) => `demo-${recId}`;

function notify(userId: number, kind: string, title: string, body: string, link: string | null) {
  state.notifications.push({ id: nextId(), userId, kind, title, body, link, createdAt: kstIso(), readAt: null });
}

function planEvent(p: MockPlan, kind: string, message: string, details: Record<string, unknown> = {}) {
  p.events.push({ step: p.events.length + 1, kind, message, details, at: kstIso() });
  p.updatedAt = kstIso();
}

const qtyText = (n: number) => `${n.toLocaleString("ko-KR")}주`;

export function activate(user: MockUser, id: number, body: { budgetKrw?: unknown; token?: unknown }): TradePlanDetail {
  const r = recOf(id);
  const token = typeof body.token === "string" && body.token ? body.token : null;
  if (token && token !== demoToken(id)) throw new MockError(400, "활성화 링크가 만료되었거나 올바르지 않습니다.");
  const budgetKrw = parseBudgetParam(body.budgetKrw);
  const pv = computePreview(user.id, r, budgetKrw);
  if (!pv.activatable) throw new MockError(400, pv.reasons.join("; "));

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
    via: token ? "discord" : "web",
    quantity: pv.quantity,
    budgetKrw,
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
  planEvent(
    p,
    "activated",
    `${p.via === "discord" ? "Discord 링크" : "웹"}에서 계획 활성화${budgetKrw ? ` (예산 ${Math.round(budgetKrw).toLocaleString("ko-KR")}원)` : ""}`,
    { via: p.via, budgetKrw },
  );
  planEvent(p, "risk_checked", `리스크 엔진 통과: ${qtyText(pv.quantity)} (${pv.limitedBy}), 손익비 ${r.rewardRisk.toFixed(2)}`, {
    approved: true,
    quantity: pv.quantity,
    limitedBy: pv.limitedBy,
    rewardRisk: r.rewardRisk,
    reasons: [],
  });
  notify(user.id, "plan_activated", `${p.name} 계획 활성화`, `${qtyText(p.quantity)} · 진입 ${priceText(p.entryPrice, p.currency)} · 목표 ${priceText(p.targetPrice, p.currency)} · 손절 ${priceText(p.stopPrice, p.currency)}`, link);

  // 바로 한 번 진행: 진입 지정가 주문
  const s = stockOf(p.symbol);
  const o = newOrder(
    user.id,
    s,
    { symbol: s.symbol, quantity: p.quantity, orderType: "LIMIT", limitPrice: p.entryPrice, targetPrice: p.targetPrice, stopPrice: p.stopPrice, days: Math.ceil(p.holdingDays * 1.4) },
    now,
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
  notify(user.id, "order_placed", `${p.name} 진입 주문 접수`, `${qtyText(p.quantity)} ${priceText(p.entryPrice, p.currency)} 지정가. 체결되면 다시 알려 드립니다.`, link);
  return toPlanDetail(p);
}

function closePlan(p: MockPlan, o: MockOrder) {
  p.status = "closed";
  p.exitPrice = o.exitPrice;
  p.exitReason = o.exitReason;
  p.closedAt = o.closedAt;
  p.pnlKrw = o.pnlKrw;
  p.nextAt = null;
  const why = o.exitReason === "TARGET" ? "목표가 도달" : o.exitReason === "STOP" ? "손절가 도달" : o.exitReason === "EXPIRED" ? "보유 기한 만료" : "직접 매도";
  planEvent(p, "closed", `${why}로 청산 (${priceText(o.exitPrice ?? 0, p.currency)}, 손익 ${krwText(o.pnlKrw ?? 0)})`, {
    orderId: o.id,
    exitReason: o.exitReason,
    exitPrice: o.exitPrice,
    pnlKrw: o.pnlKrw,
  });
  notify(p.userId, "closed", `${p.name} 청산 (${why})`, `${priceText(o.exitPrice ?? 0, p.currency)}에 ${qtyText(p.quantity)} 매도 · 손익 ${krwText(o.pnlKrw ?? 0)}`, `/plans/${p.id}`);
}

/** 진행 중 계획을 연결된 주문에 맞추고, 시연용으로 시간이 지나면 다음 단계로 보낸다. */
function advancePlans() {
  const nowMs = Date.now();
  for (const p of state.plans) {
    if (!LIVE.includes(p.status)) continue;
    const o = state.orders.find((x) => x.id === p.orderId);
    if (!o) continue;
    const link = `/plans/${p.id}`;
    if (p.status === "entry_pending") {
      if (o.status === "ENTRY_PENDING" && nowMs > Date.parse(p.entryDeadline)) {
        o.status = "CANCELED";
        o.note = "진입 기한 만료";
        p.status = "expired";
        p.failureReason = "진입 기한까지 체결되지 않아 주문을 취소했습니다.";
        planEvent(p, "expired", "진입 기한이 지나 주문을 취소했습니다", { orderId: o.id });
        notify(p.userId, "expired", `${p.name} 진입 기한 만료`, "진입가에 체결되지 않아 계획이 끝났습니다.", link);
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
        notify(p.userId, "filled", `${p.name} 진입 체결`, `${priceText(o.fillPrice ?? 0, p.currency)}에 ${qtyText(p.quantity)} 매수. 목표가·손절가를 자동으로 감시합니다.`, link);
      } else if (o.status === "CANCELED") {
        p.status = "cancelled";
        p.failureReason = "내 주식에서 주문을 직접 취소했습니다.";
        planEvent(p, "cancelled", "모의 주문이 취소되어 계획을 끝냈습니다", { reason: p.failureReason });
        notify(p.userId, "cancelled", `${p.name} 계획 중단`, p.failureReason, link);
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
  return { ...toPlan(p), recommendation: toRecommendation(recOf(p.recommendationId), p.userId), events: p.events };
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
  notify(userId, "cancelled", `${p.name} 계획 중단`, "체결 대기 주문을 취소했습니다.", link);
  return toPlanDetail(p);
}

/** 시연용 규칙 추천 (AI 아님): 일봉 ATR(14)로 손절 1.5배·목표 4.5배. */
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
  const entry = roundTick(s.price * 0.995, s.currency);
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
    reasons: [`일봉 ATR(14) ${priceText(atr, s.currency)} 기준 손절 1.5배, 목표 4.5배`, "지금 가격보다 0.5% 낮은 지정가로 진입"],
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

// ---------------------------------------------------------------- 초기 데이터

function seedAlice() {
  const at = (days: number) => daysAgoIso(days);
  const buy = (symbol: string, qty: number, price: number, days: number, extra: Partial<OrderRequest> = {}) => {
    const s = stockOf(symbol);
    const o = newOrder(1, s, { symbol, quantity: qty, orderType: "MARKET", ...extra }, at(days));
    o.entryPrice = price;
    state.orders.push(o);
    enter(o, price, at(days));
    return o;
  };
  buy("005930", 10, 69_500, 3, { targetPrice: 77_000, stopPrice: 66_000, days: 10 });
  buy("NVDA", 8, 117.2, 6, { targetPrice: 132, stopPrice: 110, days: 14 });
  const closed = buy("000660", 5, 172_000, 9);
  exit(closed, 181_000, "TARGET", at(2));
  const pending = newOrder(1, stockOf("035720"), { symbol: "035720", quantity: 20, orderType: "LIMIT", limitPrice: 44_000 }, at(0));
  state.orders.push(pending);
}

function seedAnalyses() {
  const rows: [string, "BUY" | "PASS", number, string | null, number?][] = [
    ["005930", "BUY", 0.08, "alice"],
    ["000660", "BUY", 0.21, "strategy:1"],
    ["NVDA", "PASS", 1.1, "bob"],
    ["035720", "PASS", 1.3, "cli"],
    ["247540", "BUY", 2.2, "dave"],
    ["AAPL", "PASS", 3.1, "alice", 0],
  ];
  rows.forEach(([symbol, verdict, daysAgo, by, count], i) => {
    const at = kstIso(new Date(Date.now() - daysAgo * 86_400_000));
    state.analyses.push(makeAnalysis(i + 1, stockOf(symbol), verdict, at, by, count ?? 3));
  });
}

function seedReports() {
  const user = (id: number) => state.users.find((u) => u.id === id)!;
  state.reports.push(newReport(1, user(2), stockOf("000660"), daysAgoIso(1)));
  state.reports.push(newReport(2, user(1), stockOf("005930"), kstIso(new Date(Date.now() - 2 * 3_600_000))));
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
        entryPrice: 190_000,
        targetPrice: 210_000,
        stopPrice: 183_000,
        holdingDays: 5,
        probability: null,
        confidence: null,
        summary: "NAVER: 최근 변동폭(ATR) 기준 규칙으로 만든 시연용 진입·목표·손절입니다.",
        reasons: ["일봉 ATR(14) 기준 손절 1.5배, 목표 4.5배", "지금 가격보다 0.5% 낮은 지정가로 진입"],
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
    quantity: 14,
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
    events: [
      { step: 1, kind: "activated", message: "Discord 링크에서 계획 활성화", details: { via: "discord", budgetKrw: null }, at: at(78) },
      { step: 2, kind: "risk_checked", message: "리스크 엔진 통과: 14주 (건당 위험 한도), 손익비 2.04", details: { approved: true, quantity: 14 }, at: at(78) },
      { step: 3, kind: "order_placed", message: "삼성전자 14주 69,500원 지정가 매수 주문 접수", details: { limitPrice: 69_500, quantity: 14 }, at: at(78) },
      { step: 4, kind: "order_requeued", message: "그날 체결되지 않아 다음 정규장에 다시 주문", details: {}, at: at(72) },
      { step: 5, kind: "filled", message: "삼성전자 14주 69,500원에 체결", details: { fillPrice: 69_500, quantity: 14 }, at: at(70) },
      { step: 6, kind: "closed", message: "목표가 도달로 청산 (77,000원, 손익 +102,850원)", details: { exitReason: "TARGET", exitPrice: 77_000, pnlKrw: 102_850 }, at: at(26) },
    ],
  };
  state.plans.push(done);

  const n = (id: number, kind: string, title: string, body: string, link: string | null, h: number, read: boolean) =>
    state.notifications.push({ id, userId: 1, kind, title, body, link, createdAt: hoursAgo(h), readAt: read ? hoursAgo(h - 0.5) : null });
  n(80, "closed", "삼성전자 청산 (목표가 도달)", "77,000원에 14주 매도 · 손익 +102,850원", "/plans/95", 26, true);
  n(81, "recommendation", "SK하이닉스 AI 추천", "AI 리포트 결론: 진입 181,000원 · 목표 203,000원 · 손절 173,000원", "/recommendations/91", 5, false);
  n(82, "recommendation", "NAVER 시연용 추천", "진입 190,000원 · 목표 210,000원 · 손절 183,000원", "/recommendations/93", 1, false);
}

state = freshState();
