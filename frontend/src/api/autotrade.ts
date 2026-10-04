// AI 추천 · 매매 계획 · 알림의 변경 요청 (docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림").
// 조회 훅은 queries.ts. 성공하면 관련 쿼리를 무효화한다.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "./client";
import { keys } from "./queries";
import type { ActivateRequest, NotificationSettings, NotificationTestResult, Recommendation, TradePlanDetail } from "./types";

/** 계획이 바뀌면 다시 받아야 하는 것들 (추천의 myPlan·planCount, 계획, 알림, 모의 계좌·주문, 단타 상태·계획). */
export function useRefreshAutotrade() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all(
        ["recommendations", "recommendation", "plans", "plan", "notifications", "account", "orders", "reservations", "fills", "day"].map((k) =>
          qc.invalidateQueries({ queryKey: [k] }),
        ),
      ),
    [qc],
  );
}

/**
 * 계획 활성화 ("모의 자동매매 시작"). token은 Discord 활성화 링크의 ?t= (있으면 via=discord).
 * acknowledged: 실행 확인 체크리스트를 모두 켰는지 (서버는 activated 사건에 남기기만 한다 — 화면이 버튼을 막는다).
 * 막히면 400 {detail, reasonCodes} → ApiError.reasonCodes (lib/plainText.ts의 rejectionSentences로 쉬운 문장).
 * 201이어도 status가 "failed"일 수 있다 (점검과 접수 사이의 드문 경합).
 */
export function useActivate(id: number) {
  const qc = useQueryClient();
  const refresh = useRefreshAutotrade();
  return useMutation({
    mutationFn: (body: ActivateRequest) => api.post<TradePlanDetail>(`/api/recommendations/${id}/activate`, body),
    onSuccess: (plan) => {
      qc.setQueryData(keys.plan(plan.id), plan);
      void refresh();
    },
  });
}

/** 시연용 규칙 추천 만들기 (AI 아님). symbol을 비우면 서버가 고른다. */
export function useCreateDemo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (symbol: string) => api.post<Recommendation>("/api/recommendations/demo", symbol ? { symbol } : {}),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["recommendations"] });
      void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
  });
}

/** 계획 중단: 주문 전·체결 대기면 취소, 보유 중이면 전량 매도 요청. */
export function useCancelPlan(id: number) {
  const qc = useQueryClient();
  const refresh = useRefreshAutotrade();
  return useMutation({
    mutationFn: () => api.post<TradePlanDetail>(`/api/trade-plans/${id}/cancel`),
    onSuccess: (plan) => {
      qc.setQueryData(keys.plan(plan.id), plan);
      void refresh();
    },
  });
}

/** 알림 읽음: ids 또는 all. */
export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { ids: number[] } | { all: true }) => api.post<void>("/api/notifications/read", body),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}

export function useUpdateNotificationSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { discordUserId?: string | null; discordEnabled?: boolean }) =>
      api.patch<NotificationSettings>("/api/notification-settings", body),
    onSuccess: (s) => qc.setQueryData(keys.notificationSettings, s),
  });
}

export function useTestNotification() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<NotificationTestResult>("/api/notification-settings/test"),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["notifications"] }),
  });
}
