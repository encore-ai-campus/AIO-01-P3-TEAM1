import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, qs } from "./client";
import type {
  AccountSummary,
  AnalysisDetail,
  AnalysisQuota,
  AnalysisSummary,
  EquityPoint,
  ExecutionPlan,
  Fill,
  Job,
  MarketStatus,
  Me,
  Order,
  Page,
  Quote,
  Ranking,
  ReportSummary,
  Reservation,
  StockDetail,
  StockItem,
  Verdict,
} from "./types";

/**
 * 폴링 간격 (ms). 시세(quote, stock)와 시세로 계산하는 계좌(account)는 로그인해 있는 동안 탭이 가려져도 계속 받는다.
 * 나머지는 탭이 보이지 않으면 멈추고, 돌아오면 바로 다시 받는다.
 * (가려진 탭의 타이머는 브라우저가 늦춘다: 보통 1초에 한 번, Chrome은 5분 넘게 가려지면 1분에 한 번.)
 */
export const POLL = {
  quote: 1000,
  stock: 1000,
  account: 2000,
  ranking: 5000,
  orders: 5000,
  job: 5000,
  market: 30000,
  analyses: 30000,
  reports: 30000,
  report: 3000, // SSE가 없거나 끊겼을 때 리포트 Snapshot 다시 받기
};

const live = (ms: number) => ({ refetchInterval: ms, refetchIntervalInBackground: false });
/** 시세 추적용: 탭이 가려져도 계속 받는다. */
const always = (ms: number) => ({ refetchInterval: ms, refetchIntervalInBackground: true });

export const keys = {
  me: ["me"] as const,
  market: ["market"] as const,
  account: ["account"] as const,
  equity: (days: number) => ["equity", days] as const,
  quotes: (symbols: string[]) => ["quotes", symbols.join(",")] as const,
  stock: (symbol: string) => ["stock", symbol] as const,
  search: (q: string) => ["search", q] as const,
  orders: (status: "active" | "all") => ["orders", status] as const,
  reservations: ["reservations"] as const,
  fills: ["fills"] as const,
  ranking: ["ranking"] as const,
  analyses: (params: { symbol?: string; verdict?: Verdict; limit?: number }) => ["analyses", params] as const,
  analysis: (id: number) => ["analysis", id] as const,
  quota: ["quota"] as const,
  job: (id: number) => ["job", id] as const,
  reportPlan: ["reportPlan"] as const,
  reports: (params: { symbol?: string; source?: string; limit?: number }) => ["reports", params] as const,
  report: (id: number) => ["report", id] as const,
};

export function useMe() {
  return useQuery({
    queryKey: keys.me,
    queryFn: () => api.get<Me | null>("/api/auth/me", { allow401: true }),
    staleTime: Infinity,
  });
}

export function useMarket() {
  return useQuery({ queryKey: keys.market, queryFn: () => api.get<MarketStatus>("/api/market"), ...live(POLL.market) });
}

export function useAccount() {
  return useQuery({
    queryKey: keys.account,
    queryFn: () => api.get<AccountSummary>("/api/account"),
    ...always(POLL.account),
  });
}

export function useEquity(days = 30) {
  return useQuery({
    queryKey: keys.equity(days),
    queryFn: () => api.get<{ points: EquityPoint[] }>(`/api/account/equity${qs({ days })}`),
  });
}

/** 여러 종목 현재가를 한 번에 (최대 50개). 종목 → Quote 맵으로 돌려준다. */
export function useQuotes(symbols: string[]) {
  const list = [...new Set(symbols)].sort().slice(0, 50);
  return useQuery({
    queryKey: keys.quotes(list),
    queryFn: () => api.get<{ quotes: Quote[]; asOf: string }>(`/api/quotes${qs({ symbols: list.join(",") })}`),
    select: (data) => new Map(data.quotes.map((q) => [q.symbol, q])),
    enabled: list.length > 0,
    ...always(POLL.quote),
  });
}

export function useStock(symbol: string) {
  return useQuery({
    queryKey: keys.stock(symbol),
    queryFn: () => api.get<StockDetail>(`/api/stocks/${encodeURIComponent(symbol)}`),
    ...always(POLL.stock),
  });
}

export function useSearch(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: keys.search(term),
    queryFn: () => api.get<{ results: StockItem[] }>(`/api/stocks/search${qs({ q: term, limit: 20 })}`),
    enabled: term.length > 0,
    staleTime: 60_000,
  });
}

export function useOrders(status: "active" | "all" = "active") {
  return useQuery({
    queryKey: keys.orders(status),
    queryFn: () => api.get<Page<Order>>(`/api/orders${qs({ status, limit: 50 })}`),
    ...live(POLL.orders),
  });
}

export function useReservations() {
  return useQuery({
    queryKey: keys.reservations,
    queryFn: () => api.get<{ results: Reservation[] }>("/api/reservations"),
    ...live(POLL.orders),
  });
}

const FILL_PAGE = 20;

export function useFills() {
  return useInfiniteQuery({
    queryKey: keys.fills,
    queryFn: ({ pageParam }) => api.get<Page<Fill>>(`/api/fills${qs({ limit: FILL_PAGE, offset: pageParam })}`),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.results.length, 0);
      return loaded < last.count ? loaded : undefined;
    },
  });
}

export function useRanking() {
  return useQuery({ queryKey: keys.ranking, queryFn: () => api.get<Ranking>("/api/ranking"), ...live(POLL.ranking) });
}

export function useAnalyses(params: { symbol?: string; verdict?: Verdict; limit?: number } = {}) {
  return useQuery({
    queryKey: keys.analyses(params),
    queryFn: () =>
      api.get<Page<AnalysisSummary>>(
        `/api/analyses${qs({ symbol: params.symbol, verdict: params.verdict, limit: params.limit ?? 50 })}`,
      ),
    ...live(POLL.analyses),
  });
}

export function useAnalysis(id: number) {
  return useQuery({
    queryKey: keys.analysis(id),
    queryFn: () => api.get<AnalysisDetail>(`/api/analyses/${id}`),
    enabled: Number.isFinite(id),
  });
}

export function useQuota() {
  return useQuery({ queryKey: keys.quota, queryFn: () => api.get<AnalysisQuota>("/api/analyses/quota") });
}

/** 분석 작업 상태. 끝나면(DONE·FAILED) 폴링을 멈춘다. */
export function useJob(id: number | null) {
  return useQuery({
    queryKey: keys.job(id ?? -1),
    queryFn: () => api.get<Job>(`/api/jobs/${id}`),
    enabled: id !== null,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === "DONE" || status === "FAILED" ? false : POLL.job;
    },
    refetchIntervalInBackground: false,
  });
}

/** 실행 계획 (YAML Registry). 서버를 다시 띄워야 바뀌므로 오래 둔다. */
export function useReportPlan() {
  return useQuery({
    queryKey: keys.reportPlan,
    queryFn: () => api.get<ExecutionPlan>("/api/reports/plan"),
    staleTime: 5 * 60_000,
  });
}

/** 리포트 목록 (팀 전체 공용, 최신순). 상세 Snapshot·SSE는 api/reports.ts의 useReportLive. */
export function useReports(params: { symbol?: string; source?: "user" | "auto"; limit?: number } = {}) {
  return useQuery({
    queryKey: keys.reports(params),
    queryFn: () => api.get<Page<ReportSummary>>(`/api/reports${qs({ symbol: params.symbol, source: params.source, limit: params.limit ?? 50 })}`),
    ...live(POLL.reports),
  });
}
