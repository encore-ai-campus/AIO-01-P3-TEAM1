// AI 추천 · 매매 계획 · 알림의 변경 요청 (docs/API.md "AI 추천 · 매매 계획 · 자동매매 · 알림").
// 조회 훅은 queries.ts. 성공하면 관련 쿼리를 무효화한다. (계획 화면 전용 조회 둘은 아래 useExitWatch)
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api, qs } from "./client";
import { keys, live, POLL } from "./queries";
import type {
  ActivateRequest,
  Notification,
  NotificationPage,
  NotificationSettings,
  NotificationTestResult,
  Order,
  Page,
  Recommendation,
  Reservation,
  TradePlanDetail,
} from "./types";

/**
 * 보유 중 계획의 모두 팔기(전량 매도) 요청을 지켜보는 두 조회 (계획 화면의 '매도 요청됨' ↔ '매도 예약이 취소됨' — trade-v06. 판단은 PlanPage).
 * - reservation: 그 주문의 매도 예약이 지금 있는지. 사건 이력(exit_requested)만 보면 예약을 내 주식에서 취소한 뒤에도 '팔도록 요청했어요'에
 *   멈춘다 (서버는 예약이 없으면 중단을 다시 받는다 — backend/autotrade/plans/executor.py cancel).
 * - held: 그 주문이 아직 보유 중(EXIT_WATCHING)인지. 장이 열리면 엔진이 예약을 먼저 지우고 팔며, 계획은 같은 바퀴의 뒤 단계에서야
 *   청산 완료가 된다 — 예약이 없어도 이미 팔린 것일 수 있다 (trade-r1).
 * 내 주식 화면과 같은 쿼리 키(useReservations · useOrders("active")와 같은 요청)라 캐시를 같이 쓰고, 필요할 때(enabled)만 받는다.
 */
export function useExitWatch(orderId: number | null, enabled: boolean) {
  const on = enabled && orderId != null;
  const reservation = useQuery({
    queryKey: keys.reservations,
    queryFn: () => api.get<{ results: Reservation[] }>("/api/reservations"),
    enabled: on,
    select: (d) => d.results.some((r) => r.kind === "SELL" && r.orderId === orderId),
    ...live(POLL.orders),
  });
  const held = useQuery({
    queryKey: keys.orders("active"),
    queryFn: () => api.get<Page<Order>>(`/api/orders${qs({ status: "active", limit: 50 })}`),
    enabled: on,
    select: (d) => d.results.some((o) => o.id === orderId && o.status === "EXIT_WATCHING"),
    ...live(POLL.orders),
  });
  return { reservation, held };
}

/**
 * 보유 중 계획의 보유 기한 (연결된 모의 주문의 expireDate "YYYY-MM-DD", 없으면 null). 내 주식의 보유 카드와 같은 날짜를 보인다 (UX-11).
 * 내 주식 화면과 같은 쿼리(진행 중 주문 목록)를 같이 쓰고, 기한은 바뀌지 않으므로 이 화면에서 따로 폴링하지 않는다.
 */
export function useOrderExpireDate(orderId: number | null, enabled: boolean) {
  return useQuery({
    queryKey: keys.orders("active"),
    queryFn: () => api.get<Page<Order>>(`/api/orders${qs({ status: "active", limit: 50 })}`),
    enabled: enabled && orderId != null,
    select: (d) => d.results.find((o) => o.id === orderId)?.expireDate ?? null,
    staleTime: 60_000,
  });
}

/** 계획이 바뀌면 다시 받아야 하는 것들 (추천의 myPlan·planCount, 계획, 알림, 모의 계좌·주문). */
export function useRefreshAutotrade() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all(
        ["recommendations", "recommendation", "plans", "plan", "notifications", "account", "orders", "reservations", "fills"].map((k) =>
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

/**
 * 계획 제안(추천) 지우기 (DELETE /api/recommendations/{id} → 204, DECISIONS 25장). 리포트 추천이면 서버가 출처 리포트도 숨긴다.
 * 진행 중인 계획이 있으면 400 {detail} — ApiError.detail을 그대로 보인다. 지운 추천의 상세는 404가 되므로 다시 받지 않는다.
 */
export function useDeleteRecommendation(rec: Pick<Recommendation, "id" | "source" | "sourceId">) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.del(`/api/recommendations/${rec.id}`),
    onSuccess: async () => {
      await qc.cancelQueries({ queryKey: keys.recommendation(rec.id) });
      void qc.invalidateQueries({ queryKey: keys.recommendation(rec.id), refetchType: "none" }); // 미리 보기 포함
      if (rec.source === "report" && rec.sourceId != null) void qc.invalidateQueries({ queryKey: keys.report(rec.sourceId), refetchType: "none" });
      for (const k of ["recommendations", "reports"]) void qc.invalidateQueries({ queryKey: [k] });
    },
  });
}

/** 계획 중단: 주문 전·체결 대기면 취소, 보유 중이면 모두 팔기(전량 매도) 요청. */
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

/** 알림 읽음 대상: 몇 개(ids) 또는 전부(all). */
export type ReadTarget = { ids: number[] } | { all: true };

/** 읽음을 반영한 알림 쪽. unreadOnly: 종 배지가 쓰는 '안 읽은 것만' 목록 (읽은 것은 빠진다). */
function markPage(page: NotificationPage, target: ReadTarget, newlyRead: number, at: string, unreadOnly: boolean): NotificationPage {
  const all = "all" in target;
  const hit = (n: Notification) => !n.readAt && (all || target.ids.includes(n.id));
  const unreadCount = all ? 0 : Math.max(0, page.unreadCount - newlyRead);
  if (unreadOnly) {
    const results = page.results.filter((n) => !hit(n));
    return { ...page, results, count: Math.max(0, page.count - (page.results.length - results.length)), unreadCount };
  }
  return { ...page, results: page.results.map((n) => (hit(n) ? { ...n, readAt: at } : n)), unreadCount };
}

/** 읽음 요청의 mutationKey (진행 중인 읽음 요청 수를 센다). */
const READ_KEY = ["notifications", "read"] as const;
/** 읽음 요청 순번 (모든 화면 공통). 실패한 요청은 그 뒤에 시작한 읽음 요청이 없을 때만 화면을 되돌린다. */
let readSeq = 0;

/**
 * 알림 읽음 (POST /api/notifications/read). 화면에 먼저 반영한다: ['notifications', …] 캐시 전부(목록·종 배지)를 같은 순간에 고쳐서
 * 알림 화면·홈 최근 알림·종 배지가 함께 바뀐다. 실패하면 되돌리고 onError(오류 알림)를 부르며, 마지막 읽음 요청이 끝나면 다시 받아 서버 값으로 맞춘다.
 * 연달아 읽을 때(trade-r3): 앞 요청이 끝나자마자 다시 받으면 그 응답이 뒤 요청의 읽음보다 먼저 처리되어 뒤 알림이 '안 읽음'으로 잠깐 돌아온다.
 * 그래서 다시 받기는 마지막 요청이 끝날 때 한 번만 하고, 실패한 앞 요청은 뒤 요청의 읽음까지 지우는 통째 되돌리기를 하지 않는다
 * (그 알림은 마지막 다시 받기에서 서버 값 '안 읽음'으로 돌아온다).
 * 이 콜백들은 훅에 달려 있어 누른 화면을 떠난 뒤(알림 링크로 이동)에도 돈다.
 */
export function useMarkRead(onError?: (err: unknown) => void) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: READ_KEY,
    mutationFn: (target: ReadTarget) => api.post<void>("/api/notifications/read", target),
    onMutate: async (target) => {
      const seq = ++readSeq;
      await qc.cancelQueries({ queryKey: ["notifications"] }); // 폴링 응답이 방금 고친 값을 덮지 않게
      const before = qc.getQueriesData<NotificationPage>({ queryKey: ["notifications"] });
      // 안 읽은 수에서 뺄 개수: 전체 목록에서 안 읽은 것만 센다 (목록이 없으면 누른 알림은 안 읽은 것으로 본다 — 화면은 안 읽은 것만 보낸다)
      const full = qc.getQueryData<NotificationPage>(keys.notifications(false));
      const newlyRead = "all" in target ? 0 : (full?.results.filter((n) => !n.readAt && target.ids.includes(n.id)).length ?? target.ids.length);
      const at = new Date().toISOString();
      for (const [key, page] of before) {
        if (page) qc.setQueryData<NotificationPage>(key, markPage(page, target, newlyRead, at, key[1] === true));
      }
      return { before, seq };
    },
    onError: (err, _target, ctx) => {
      // 뒤에 시작한 읽음 요청이 있으면 그 요청이 고친 화면을 지킨다 (스냅숏에는 그 읽음이 없다)
      if (ctx && ctx.seq === readSeq) for (const [key, page] of ctx.before) qc.setQueryData(key, page);
      onError?.(err);
    },
    onSettled: () => {
      // 이 요청도 아직 셈에 든다: 1이면 마지막 읽음 요청이다. 기다리지 않는다 (화면은 이미 바뀌었다)
      if (qc.isMutating({ mutationKey: READ_KEY }) === 1) void qc.invalidateQueries({ queryKey: ["notifications"] });
    },
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
