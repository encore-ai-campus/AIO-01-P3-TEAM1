import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import { api } from "./client";
import { useAccount, useOrders, useReservations } from "./queries";
import type { OrderRequest, OrderResult } from "./types";

// 주문 뒤 다시 받을 것. 화면이 기다리는 것(주문 패널이 보유·대기로 바뀌는 데 필요한 것)과 기다리지 않는 것을 나눈다.
const TRADING_KEYS = ["account", "orders", "reservations", "fills", "ranking", "equity"];
// 장기 보유가 생기거나 끝나면 산 이유 점검(active)과 오늘의 내 종목 뉴스 대상도 바뀐다 — 주문 버튼을 붙잡아 두지 않게 기다리지 않는다
const LONGTERM_KEYS = ["longterm", "fundamentals"];

/** 주문·매도·취소 뒤 다시 받아야 하는 것들. 돌려주는 Promise는 계좌·주문·예약을 다시 받으면 끝난다. */
export function useRefreshTrading() {
  const qc = useQueryClient();
  return useCallback(() => {
    for (const k of LONGTERM_KEYS) void qc.invalidateQueries({ queryKey: [k] });
    return Promise.all(TRADING_KEYS.map((k) => qc.invalidateQueries({ queryKey: [k] })));
  }, [qc]);
}

/**
 * 한 종목에 대한 내 상태 (주문 패널 본문·하단 버튼 문구·내 모의 주문 한 줄이 같이 쓴다).
 * loading: 아직 모름 · error: 주문·예약을 받지 못함 · holding 보유 · pending 체결 대기 · reserved 매수 예약 · buy 살 수 있음.
 */
export type SymbolState = "loading" | "error" | "holding" | "pending" | "reserved" | "buy";

/** 한 종목의 내 진행 상황: 진행 중 주문(대기·보유), 보유 평가, 예약. */
export function useSymbolTrading(symbol: string) {
  const account = useAccount();
  const orders = useOrders("active");
  const reservations = useReservations();
  const order = orders.data?.results.find((o) => o.symbol === symbol) ?? null;
  const position = account.data?.positions.find((p) => p.symbol === symbol) ?? null;
  const mine = reservations.data?.results.filter((r) => r.symbol === symbol) ?? [];
  const ready = orders.isSuccess && reservations.isSuccess;
  const error = orders.error ?? reservations.error;
  const buyReservation = mine.find((r) => r.kind === "BUY") ?? null;
  const state: SymbolState = !ready
    ? error
      ? "error"
      : "loading"
    : order?.status === "EXIT_WATCHING"
      ? "holding"
      : order?.status === "ENTRY_PENDING"
        ? "pending"
        : buyReservation
          ? "reserved"
          : "buy";
  return {
    ready,
    error,
    state,
    account: account.data ?? null,
    order,
    position,
    buyReservation,
    sellReservation: mine.find((r) => r.kind === "SELL") ?? null,
  };
}

/**
 * 모의 매수 주문 (POST /api/orders). style: "swing"(목표·손절 둘 다) | "long"(목표·손절·기한 없음, 자동 매도 없음).
 * long 매수가 비중 점검에서 막히면 400 {detail, reasonCodes} → ApiError.reasonCodes (cash_short·position_limit·total_limit).
 */
export function usePlaceOrder() {
  const qc = useQueryClient();
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: (body: OrderRequest) => api.post<OrderResult>("/api/orders", body),
    onSuccess: () => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ["longterm"] }); // 장기 보유가 생기면 산 이유의 active가 바뀐다
    },
  });
}

// ---------------------------------------------------------------- 최근 본 종목 (이 기기에만 — localStorage. 서버에 보내지 않는다)
// 종목 검색의 첫 화면(바로가기)이 쓴다. 계정마다 따로 둔다(키에 사용자 id): 한 기기(시연 PC 등)를 여럿이 번갈아 써도
// 앞 사람이 본 종목이 다음 사람에게 보이지 않게. 저장소를 쓸 수 없으면(사생활 보호 모드 등) 빈 목록으로 그대로 동작한다.

export interface RecentStock {
  symbol: string;
  name: string;
}

const RECENT_STOCKS_PREFIX = "paper-recent-stocks";
/** 사용자별 저장 키 ("paper-recent-stocks:{사용자 id}"). */
export const recentStocksKey = (userId: number) => `${RECENT_STOCKS_PREFIX}:${userId}`;
export const RECENT_STOCKS_MAX = 8;
const NO_RECENT: RecentStock[] = [];
const recentListeners = new Set<() => void>();
// 키별로 마지막에 읽은 저장값과 목록 (저장값이 같으면 같은 배열 — useSyncExternalStore가 다시 그리지 않게)
const recentCache = new Map<string, { raw: string | null; list: RecentStock[] }>();

function readRecentRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function parseRecent(raw: string | null): RecentStock[] {
  if (!raw) return NO_RECENT;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return NO_RECENT;
    const ok = value.filter(
      (x): x is RecentStock =>
        typeof x === "object" && x !== null && typeof (x as RecentStock).symbol === "string" && typeof (x as RecentStock).name === "string",
    );
    return ok.slice(0, RECENT_STOCKS_MAX);
  } catch {
    return NO_RECENT; // 다른 형식이 남아 있으면 없는 것으로 본다
  }
}

/** 이 사용자가 최근 본 종목 (최근 것이 앞). 사용자를 모르면(null) 빈 목록. */
export function getRecentStocks(userId: number | null): RecentStock[] {
  if (userId === null) return NO_RECENT;
  const key = recentStocksKey(userId);
  const raw = readRecentRaw(key);
  const hit = recentCache.get(key);
  if (hit && hit.raw === raw) return hit.list;
  const list = parseRecent(raw);
  recentCache.set(key, { raw, list });
  return list;
}

function writeRecent(userId: number, list: RecentStock[]) {
  const key = recentStocksKey(userId);
  try {
    if (list.length) localStorage.setItem(key, JSON.stringify(list));
    else localStorage.removeItem(key);
  } catch {
    // 저장소를 쓸 수 없으면 이 기기에 남기지 않는다
  }
  recentListeners.forEach((fn) => fn());
}

/** 종목 상세를 열면 그 사용자의 목록 맨 앞에 넣는다 (같은 종목은 앞으로 옮기고, 최대 8개). */
export function addRecentStock(userId: number, stock: RecentStock) {
  const list = getRecentStocks(userId);
  if (list[0]?.symbol === stock.symbol && list[0].name === stock.name) return;
  writeRecent(userId, [stock, ...list.filter((r) => r.symbol !== stock.symbol)].slice(0, RECENT_STOCKS_MAX));
}

export function clearRecentStocks(userId: number) {
  writeRecent(userId, []);
}

function subscribeRecent(fn: () => void) {
  recentListeners.add(fn);
  // 다른 탭에서 바꾼 것도 따라간다 (어느 사용자 키든 다시 읽어 본다 — 같으면 같은 배열이라 다시 그리지 않는다)
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key.startsWith(`${RECENT_STOCKS_PREFIX}:`)) fn();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    recentListeners.delete(fn);
    window.removeEventListener("storage", onStorage);
  };
}

const serverRecent = () => NO_RECENT;

/** 이 사용자가 최근 본 종목 (바뀌면 다시 그린다). */
export function useRecentStocks(userId: number | null): RecentStock[] {
  return useSyncExternalStore(subscribeRecent, () => getRecentStocks(userId), serverRecent);
}
