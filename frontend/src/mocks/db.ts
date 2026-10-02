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
  Order,
  OrderRequest,
  OrderResult,
  Position,
  Quote,
  Ranking,
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
    usedToday: { 1: 1 },
    sessionUserId: null,
    ticks: {},
  };
  for (const u of s.users) s.cash[u.id] = INITIAL_CAPITAL * (1 + (OTHER_RATES[u.id] ?? 0));
  state = s;
  seedAlice();
  seedAnalyses();
  seedReports();
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
  return { id, symbol, name, market, status, currentStep, requestedBy, createdAt, startedAt, finishedAt };
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

function newReport(id: number, user: MockUser, s: MockStock, createdAt: string): MockReport {
  return {
    id,
    userId: user.id,
    symbol: s.symbol,
    name: s.name,
    market: s.market,
    status: "requested",
    currentStep: null,
    requestedBy: user.nickname,
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
export function requestReport(user: MockUser, symbol: string): { report: ReportDetail; created: boolean } {
  const s = state.stocks.find((x) => x.symbol === symbol.trim().toUpperCase());
  if (!s) throw new MockError(400, "종목을 찾을 수 없습니다.");
  const open = state.reports.find(
    (r) => r.userId === user.id && r.symbol === s.symbol && r.status !== "completed" && r.status !== "failed",
  );
  if (open) return { report: strip(open), created: false };
  const r = newReport(nextId(), user, s, kstIso());
  state.reports.push(r);
  return { report: strip(r), created: true };
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

state = freshState();
