import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { type BudgetChoice, budgetParams } from "../lib/autotrade";
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
  NotificationPage,
  NotificationSettings,
  Order,
  Page,
  Quote,
  Ranking,
  Recommendation,
  RecommendationSource,
  ReportSummary,
  ReportTeam,
  Reservation,
  RiskPreview,
  StockDetail,
  StockItem,
  TradePlan,
  TradePlanDetail,
  TradePlanStatus,
  Verdict,
} from "./types";

/**
 * 폴링 간격 (ms, docs/API.md 공통 규칙). 종목 시세는 실시간(2026-10-06)이라 5초 (전 60초 — 서버가 종목마다 1초 캐시하므로 팀이 같이 봐도 증권사 조회는 늘지 않는다),
 * 계좌 평가는 장마감 기준이지만 체결·현금이 장중에 바뀌므로 10초, 주문·매매 계획 5초.
 * 시세(quote, stock)와 계좌(account)는 계약대로 로그인해 있는 동안 탭이 가려져도 계속 받는다.
 * 나머지는 탭이 보이지 않으면 멈추고, 돌아오면 바로 다시 받는다.
 */
export const POLL = {
  quote: 5000,
  stock: 5000,
  account: 10_000,
  ranking: 30_000,
  orders: 5000,
  job: 5000,
  market: 30000,
  analyses: 30000,
  reports: 30000,
  report: 3000, // SSE가 없거나 끊겼을 때 리포트 Snapshot 다시 받기
  notifications: 15000, // 안 읽은 알림 수
  plan: 5000, // 진행 중 계획
  planIdle: 30_000, // 진행 중 계획이 없는 목록 (docs/API.md 프론트 폴링)
  recommendations: 30000,
};

/** 탭이 보일 때만 ms마다 다시 받는다. */
export const live = (ms: number) => ({ refetchInterval: ms, refetchIntervalInBackground: false });
/** 시세·계좌용: 탭이 가려져도 계속 받는다. */
export const always = (ms: number) => ({ refetchInterval: ms, refetchIntervalInBackground: true });

/**
 * 목록 훅의 선택 인자.
 * keepPrevious: 필터·검색어를 바꾸는 동안 이전 결과를 남긴다 (스켈레톤으로 바뀌며 높이가 출렁이지 않게).
 * 그동안 isPlaceholderData가 true다 → 목록을 흐리게(opacity .6, aria-busy) 보인다.
 * 대상이 바뀌는 호출(종목 symbol, 리포트 sourceId 등)에는 켜지 않는다: 앞 대상의 결과가 새 대상 화면에 잠깐 보이면 잘못 읽는다.
 */
export interface ListOptions {
  keepPrevious?: boolean;
}

const keepIf = (on: boolean | undefined) => (on ? { placeholderData: keepPreviousData } : {});

export interface AnalysisParams {
  symbol?: string;
  verdict?: Verdict;
  mine?: boolean; // 내가 요청한 분석만 (?mine=1)
  limit?: number;
}

export interface ReportParams {
  symbol?: string;
  source?: "user" | "auto";
  team?: ReportTeam; // 없으면 서버 기본(stock_report). stock_selection은 하루 한 번 도는 선정 실행 목록
  mine?: boolean; // 내가 신청한 리포트만 (?mine=1)
  limit?: number;
}

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
  analyses: (params: AnalysisParams) => ["analyses", params] as const,
  analysis: (id: number) => ["analysis", id] as const,
  quota: ["quota"] as const,
  job: (id: number) => ["job", id] as const,
  reportPlan: ["reportPlan"] as const,
  reports: (params: ReportParams) => ["reports", params] as const,
  report: (id: number) => ["report", id] as const,
  reportQuota: ["reports", "quota"] as const,
  recommendations: (params: RecommendationParams) => ["recommendations", params] as const,
  recommendation: (id: number) => ["recommendation", id] as const,
  // 넣을 돈 없음(null)은 [..., "preview", null, null] — 머리 칩·리포트 계획 카드·실행 확인이 같은 캐시를 쓴다.
  // manual(시연용 수동 시작 미리 보기, DECISIONS 31장)은 끝에 "manual"을 붙인 따로 된 캐시 — 머리 칩·리포트 매매 계획 카드(일반 미리 보기)와 섞이지 않게
  preview: (id: number, budget: BudgetChoice | null, manual = false) =>
    manual
      ? (["recommendation", id, "preview", budget?.mode ?? null, budget?.value ?? null, "manual"] as const)
      : (["recommendation", id, "preview", budget?.mode ?? null, budget?.value ?? null] as const),
  plans: (status: "active" | "all") => ["plans", status] as const,
  plan: (id: number) => ["plan", id] as const,
  notifications: (unread: boolean) => ["notifications", unread] as const,
  notificationSettings: ["notificationSettings"] as const,
  // 계정: 투자자 프로필 (훅은 api/profile.ts)
  investorProfile: ["investorProfile"] as const,
  // 장기투자 (훅은 api/longterm.ts)
  dailyMoves: (date: string | null) => ["longterm", "dailyMoves", date] as const,
  dailyMove: (symbol: string, date: string | null) => ["longterm", "dailyMove", symbol, date] as const,
  theses: ["longterm", "theses"] as const,
  fundamentals: (symbol: string) => ["fundamentals", symbol] as const,
};

export interface RecommendationParams {
  status?: "open" | "all";
  source?: RecommendationSource;
  sourceId?: number;
  symbol?: string;
  limit?: number;
}

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

/**
 * 여러 종목 시세를 한 번에 (최대 50개). 종목 → Quote 맵으로 돌려준다.
 * 가격은 실시간이고(Quote.basis "live"), 현재가를 받지 못한 종목만 직전 종가("close")다. 기준 시각은 각 Quote.asOf다 (응답 맨 위 asOf는 응답 시각이라 쓰지 않는다).
 */
export function useQuotes(symbols: string[], opts: ListOptions = {}) {
  const list = [...new Set(symbols)].sort().slice(0, 50);
  return useQuery({
    queryKey: keys.quotes(list),
    queryFn: () => api.get<{ quotes: Quote[]; asOf: string }>(`/api/quotes${qs({ symbols: list.join(",") })}`),
    select: (data) => new Map(data.quotes.map((q) => [q.symbol, q])),
    enabled: list.length > 0,
    ...always(POLL.quote),
    ...keepIf(opts.keepPrevious && list.length > 0),
  });
}

export function useStock(symbol: string) {
  return useQuery({
    queryKey: keys.stock(symbol),
    queryFn: () => api.get<StockDetail>(`/api/stocks/${encodeURIComponent(symbol)}`),
    ...always(POLL.stock),
  });
}

/** 종목 검색. 검색어를 지우면(빈 검색어) 이전 결과를 남기지 않는다. */
export function useSearch(q: string, opts: ListOptions = {}) {
  const term = q.trim();
  return useQuery({
    queryKey: keys.search(term),
    queryFn: () => api.get<{ results: StockItem[] }>(`/api/stocks/search${qs({ q: term, limit: 20 })}`),
    enabled: term.length > 0,
    staleTime: 60_000,
    ...keepIf(opts.keepPrevious && term.length > 0),
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

/** AI 교차검증 분석 목록 (팀 공용, 최신순). mine이면 내가 요청한 것만. */
export function useAnalyses(params: AnalysisParams = {}, opts: ListOptions = {}) {
  return useQuery({
    queryKey: keys.analyses(params),
    queryFn: () =>
      api.get<Page<AnalysisSummary>>(
        `/api/analyses${qs({ symbol: params.symbol, verdict: params.verdict, mine: params.mine ? 1 : null, limit: params.limit ?? 50 })}`,
      ),
    ...live(POLL.analyses),
    ...keepIf(opts.keepPrevious),
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

/** 리포트 목록 (팀 전체 공용, 최신순). mine이면 내가 신청한 것만. 상세 Snapshot·SSE는 api/reports.ts의 useReportLive. */
export function useReports(params: ReportParams = {}, opts: ListOptions = {}) {
  return useQuery({
    queryKey: keys.reports(params),
    queryFn: () =>
      api.get<Page<ReportSummary>>(
        `/api/reports${qs({ symbol: params.symbol, source: params.source, team: params.team, mine: params.mine ? 1 : null, limit: params.limit ?? 50 })}`,
      ),
    ...live(POLL.reports),
    ...keepIf(opts.keepPrevious),
  });
}

// ---------------------------------------------------------------- AI 추천 · 매매 계획 · 알림 (변경 요청은 api/autotrade.ts)

/** 진행 중 계획 = active · entry_pending · holding. 나머지는 끝난 상태 (다시 바뀌지 않는다). */
export const isPlanLive = (status: TradePlanStatus) => status === "active" || status === "entry_pending" || status === "holding";

/** 추천 목록 (팀 전체 공용, 최신순). 리포트·분석 화면은 source·sourceId로 자기 추천을 찾는다. */
export function useRecommendations(params: RecommendationParams = {}, enabled = true, opts: ListOptions = {}) {
  return useQuery({
    queryKey: keys.recommendations(params),
    queryFn: () =>
      api.get<Page<Recommendation>>(
        `/api/recommendations${qs({
          status: params.status ?? "open",
          source: params.source,
          sourceId: params.sourceId,
          symbol: params.symbol,
          limit: params.limit ?? 50,
        })}`,
      ),
    enabled,
    ...live(POLL.recommendations),
    ...keepIf(opts.keepPrevious && enabled),
  });
}

export function useRecommendation(id: number) {
  return useQuery({
    queryKey: keys.recommendation(id),
    queryFn: () => api.get<Recommendation>(`/api/recommendations/${id}`),
    enabled: Number.isFinite(id),
    ...live(POLL.recommendations),
  });
}

/**
 * 리스크 엔진이 내 계좌로 계산한 활성화 미리 보기. budget: 넣을 돈 (% 또는 원 — budgetPercent·budgetKrw 중 하나만 보낸다).
 * null이면 금액 없이 점검만 한다 (수량 0 — 머리 칩·시작할 수 없는 이유·매수 가능 금액 안내용, docs/API.md 2026-10-11).
 * manual: 시연용 수동 시작 미리 보기(?manualStart=1, DECISIONS 31장 — 손익비·기대값 사유는 skippedCodes로). 일반 미리 보기에는 붙이지 않는다.
 */
export function useRiskPreview(id: number, budget: BudgetChoice | null, enabled = true, manual = false) {
  return useQuery({
    queryKey: keys.preview(id, budget, manual),
    queryFn: () => api.get<RiskPreview>(`/api/recommendations/${id}/preview${qs({ ...(budget ? budgetParams(budget) : {}), manualStart: manual ? 1 : null })}`),
    enabled: enabled && Number.isFinite(id),
    placeholderData: (prev) => prev,
  });
}

/** 계획 목록. 진행 중 계획이 있을 때만 5초마다, 없으면 30초마다 받는다 (탭이 가려지면 멈춘다). */
export function usePlans(status: "active" | "all" = "active", opts: ListOptions = {}) {
  return useQuery({
    queryKey: keys.plans(status),
    queryFn: () => api.get<Page<TradePlan>>(`/api/trade-plans${qs({ status, limit: 50 })}`),
    refetchInterval: (q) => (q.state.data?.results.some((p) => isPlanLive(p.status)) ? POLL.plan : POLL.planIdle),
    refetchIntervalInBackground: false,
    ...keepIf(opts.keepPrevious),
  });
}

/** 계획 상세. 진행 중이면 5초마다, 끝났으면 멈춘다. */
export function usePlan(id: number) {
  return useQuery({
    queryKey: keys.plan(id),
    queryFn: () => api.get<TradePlanDetail>(`/api/trade-plans/${id}`),
    enabled: Number.isFinite(id),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      return status && !isPlanLive(status) ? false : POLL.plan;
    },
    refetchIntervalInBackground: false,
  });
}

/** 알림 목록. unread면 안 읽은 것만 (헤더 배지는 unreadCount만 쓴다). */
export function useNotifications(unread = false) {
  return useQuery({
    queryKey: keys.notifications(unread),
    queryFn: () => api.get<NotificationPage>(`/api/notifications${qs({ unread: unread ? 1 : null, limit: unread ? 1 : 50 })}`),
    ...live(POLL.notifications),
  });
}

export function useNotificationSettings() {
  return useQuery({
    queryKey: keys.notificationSettings,
    queryFn: () => api.get<NotificationSettings>("/api/notification-settings"),
  });
}
