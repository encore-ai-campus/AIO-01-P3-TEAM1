// 장기투자: 오늘의 내 종목 뉴스 · 산 이유와 펀더멘털 점검 (docs/API.md "장기투자"). 숫자와 판정은 서버의 결정론적 코드다.
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "./client";
import { keys } from "./queries";
import type { DailyMove, DailyMoveList, FundamentalsView, Thesis, ThesisRequest } from "./types";

// 하루에 한 번(장 마감 뒤·공시 뒤) 만들어지는 자료라 폴링하지 않고 5분 동안 새로 받지 않는다.
const DAILY = 5 * 60_000;

/** 오늘의 내 종목 뉴스: 내가 보유 중인 국내 종목의 그날 기록 (date가 없으면 가장 최근 기록일). */
export function useDailyMoves(date: string | null = null, enabled = true) {
  return useQuery({
    queryKey: keys.dailyMoves(date),
    queryFn: () => api.get<DailyMoveList>(`/api/longterm/daily-moves${qs({ date })}`),
    enabled,
    staleTime: DAILY,
  });
}

/** 한 종목의 하루 기록 (보유 여부와 상관없이 팀 공용). 기록이 없으면 404 오류. */
export function useDailyMove(symbol: string, date: string | null = null, enabled = true) {
  return useQuery({
    queryKey: keys.dailyMove(symbol, date),
    queryFn: () => api.get<DailyMove>(`/api/longterm/daily-moves/${encodeURIComponent(symbol)}${qs({ date })}`),
    enabled: enabled && symbol.length > 0,
    staleTime: DAILY,
  });
}

/** 내 산 이유 목록 (최근 점검 포함, updatedAt 최신순). */
export function useTheses(enabled = true) {
  return useQuery({
    queryKey: keys.theses,
    queryFn: () => api.get<{ results: Thesis[] }>("/api/longterm/theses"),
    enabled,
    staleTime: DAILY,
  });
}

/** 종목의 최근 지표와 절대 기준 판정 + 내 산 이유. DART 조회 실패도 200 (rows의 값이 null, reason에 이유). */
export function useFundamentals(symbol: string, enabled = true) {
  return useQuery({
    queryKey: keys.fundamentals(symbol),
    queryFn: () => api.get<FundamentalsView>(`/api/stocks/${encodeURIComponent(symbol)}/fundamentals`),
    enabled: enabled && symbol.length > 0,
    staleTime: DAILY,
  });
}

/** 산 이유 저장 (PUT — 없으면 만들고, 있으면 reasons·axes만 바꾼다. 처음 만들 때만 기준선을 잡는다). */
export function useSaveThesis(symbol: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ThesisRequest) => api.put<Thesis>(`/api/longterm/theses/${encodeURIComponent(symbol)}`, body),
    onSuccess: (t) => {
      qc.setQueryData<FundamentalsView>(keys.fundamentals(symbol), (f) => (f ? { ...f, thesis: t } : f));
      void qc.invalidateQueries({ queryKey: keys.theses });
    },
  });
}

/** 산 이유 지우기 (점검 기록도 지운다). */
export function useDeleteThesis(symbol: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/api/longterm/theses/${encodeURIComponent(symbol)}`),
    onSuccess: () => {
      qc.setQueryData<FundamentalsView>(keys.fundamentals(symbol), (f) => (f ? { ...f, thesis: null } : f));
      void qc.invalidateQueries({ queryKey: keys.theses });
    },
  });
}
