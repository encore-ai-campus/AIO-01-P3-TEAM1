import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";

/** 4xx는 다시 시도하지 않는다 (입력·권한 문제라 결과가 같다). */
export function createQueryClient(opts: { retry?: boolean } = {}) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: opts.retry === false ? false : (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 1000,
      },
      mutations: { retry: false },
    },
  });
}
