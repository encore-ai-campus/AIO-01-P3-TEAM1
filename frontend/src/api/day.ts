// 단타 연습: 분봉 · 세션 상태 · 미리 보기 · 계획 · 복기 (docs/API.md "단타 연습"). 국내 종목만.
// 잠김(주린이모드 켬·퀴즈 미통과)이면 미리 보기·계획 만들기가 400 {detail, reasonCodes: ["day_trading_locked"]}.
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "./client";
import { keys, live, POLL } from "./queries";
import { useRefreshAutotrade } from "./autotrade";
import type { DayPlanInput, DayPlanList, DayPlanRequest, DayPreview, DayReview, DayStatus, MinuteCandles, TradePlanDetail } from "./types";

/** 분봉 허용 간격 (분). */
export const MINUTE_STEPS = [1, 3, 5, 10, 15, 30, 60] as const;

/**
 * 분봉 (완성된 정규장 세션만). date가 없으면 KR 기준일 — 장 전·장중은 직전 세션, 마감 뒤(15:40)는 그날.
 * 지난 세션은 바뀌지 않으므로 폴링하지 않는다.
 */
export function useMinuteCandles(symbol: string, opts: { date?: string | null; minutes?: number; enabled?: boolean } = {}) {
  const date = opts.date ?? null;
  const minutes = opts.minutes ?? 1;
  return useQuery({
    queryKey: keys.minuteCandles(symbol, date, minutes),
    queryFn: () =>
      api.get<MinuteCandles>(`/api/stocks/${encodeURIComponent(symbol)}/minute-candles${qs({ date, minutes })}`),
    enabled: (opts.enabled ?? true) && symbol.length > 0,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
}

/** 단타 연습장 상태: 잠금 · 세션(진입 마감 15:15) · 한도 · 오늘 쓴 양. */
export function useDayStatus(enabled = true) {
  return useQuery({
    queryKey: keys.dayStatus,
    queryFn: () => api.get<DayStatus>("/api/day/status"),
    enabled,
    ...live(POLL.dayStatus),
  });
}

/**
 * 단타 미리 보기 (POST이지만 읽기라 쿼리로 둔다). input이 null이면 부르지 않는다.
 * 만들 수 없는 시각이면 200 + activatable false + day_entry_closed. 잠김·입력 오류는 400 오류 (ApiError.reasonCodes로 나눈다).
 */
export function useDayPreview(input: DayPlanInput | null) {
  return useQuery({
    queryKey: keys.dayPreview(input),
    queryFn: () => api.post<DayPreview>("/api/day/preview", input),
    enabled: input !== null,
    placeholderData: keepPreviousData,
  });
}

/** 단타 계획 만들기 = 곧바로 활성화. 막히면 400 {detail, reasonCodes} (아무것도 만들지 않는다). */
export function useCreateDayPlan() {
  const qc = useQueryClient();
  const refresh = useRefreshAutotrade();
  return useMutation({
    mutationFn: (body: DayPlanRequest) => api.post<TradePlanDetail>("/api/day/plans", body),
    onSuccess: (plan) => {
      qc.setQueryData(keys.plan(plan.id), plan);
      void refresh(); // 계획·주문·계좌·알림·단타 상태
    },
  });
}

/** 그 세션의 내 단타 계획 (date가 없으면 오늘). 진행 중 계획이 있으니 5초마다. */
export function useDayPlans(date: string | null = null, enabled = true) {
  return useQuery({
    queryKey: keys.dayPlans(date),
    queryFn: () => api.get<DayPlanList>(`/api/day/plans${qs({ date })}`),
    enabled,
    ...live(POLL.plan),
  });
}

/**
 * 결정론 복기 (date가 없으면 KR 기준일). 날짜를 바꾸는 동안 보던 복기를 남긴다(isPlaceholderData → 화면이 흐리게) —
 * 화면 전체가 스켈레톤 하나로 접혔다 펴지지 않게. 그동안 화면의 날짜는 고른 날짜(주소의 ?date=)를 따른다.
 */
export function useDayReview(date: string | null = null, enabled = true) {
  return useQuery({
    queryKey: keys.dayReview(date),
    queryFn: () => api.get<DayReview>(`/api/day/review${qs({ date })}`),
    enabled,
    placeholderData: keepPreviousData,
  });
}
