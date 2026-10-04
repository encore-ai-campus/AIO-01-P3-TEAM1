import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "./client";
import { useAccount, useOrders, useReservations } from "./queries";
import type { OrderRequest, OrderResult } from "./types";

/** 주문·매도·취소 뒤 다시 받아야 하는 것들. */
export function useRefreshTrading() {
  const qc = useQueryClient();
  return useCallback(
    () =>
      Promise.all(
        ["account", "orders", "reservations", "fills", "ranking", "equity"].map((k) =>
          qc.invalidateQueries({ queryKey: [k] }),
        ),
      ),
    [qc],
  );
}

/** 한 종목의 내 진행 상황: 진행 중 주문(대기·보유), 보유 평가, 예약. */
export function useSymbolTrading(symbol: string) {
  const account = useAccount();
  const orders = useOrders("active");
  const reservations = useReservations();
  const order = orders.data?.results.find((o) => o.symbol === symbol) ?? null;
  const position = account.data?.positions.find((p) => p.symbol === symbol) ?? null;
  const mine = reservations.data?.results.filter((r) => r.symbol === symbol) ?? [];
  return {
    ready: orders.isSuccess && reservations.isSuccess,
    error: orders.error ?? reservations.error,
    account: account.data ?? null,
    order,
    position,
    buyReservation: mine.find((r) => r.kind === "BUY") ?? null,
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
