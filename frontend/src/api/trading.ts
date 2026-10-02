import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useAccount, useOrders, useReservations } from "./queries";

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
