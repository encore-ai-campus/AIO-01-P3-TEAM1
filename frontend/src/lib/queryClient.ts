import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";

/**
 * 4xx는 다시 시도하지 않는다 (입력·권한 문제라 결과가 같다).
 * 변경 요청(mutations)은 오프라인이어도 보내 본다(networkMode always): 연결이 없으면 '멈춤'으로 기다리지 않고 오류로 끝나 화면이 알린다.
 * 조회(queries)는 기본값 그대로 (연결이 돌아오면 다시 받는다).
 */
export function createQueryClient(opts: { retry?: boolean } = {}) {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: opts.retry === false ? false : (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
        refetchOnWindowFocus: true,
        staleTime: 1000,
      },
      mutations: { retry: false, networkMode: "always" },
    },
  });
}
