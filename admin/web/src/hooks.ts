import { useEffect, useState, useSyncExternalStore } from "react";
import { ApiError, getJson } from "./api";
import { getTick, markUpdated, subscribeRefresh } from "./refresh";

export interface ApiResult<T> {
  data: T | undefined;
  error: string | null;
  loading: boolean;
}

/** 15초 · 60초: 화면 종류별 다시 받는 간격 */
export const POLL_FAST = 15_000;
export const POLL_SLOW = 60_000;

/**
 * GET을 부르고 intervalMs마다 다시 받는다 (화면이 보일 때만). 새로 고침 버튼과 주소 변경에도 다시 받는다.
 * 401은 api.ts가 전체에 알려 로그인 화면으로 보낸다.
 */
export function useApi<T>(path: string, intervalMs: number): ApiResult<T> {
  const tick = useSyncExternalStore(subscribeRefresh, getTick);
  const [state, setState] = useState<{ path: string; data?: T; error?: string }>({ path });

  useEffect(() => {
    let cancelled = false;
    let inFlight = false; // 앞 요청이 끝나기 전에는 다시 부르지 않는다 (DB가 느릴 때 요청이 쌓이지 않게)
    const run = async () => {
      if (document.visibilityState === "hidden" || inFlight) return;
      inFlight = true;
      try {
        const data = await getJson<T>(path);
        if (cancelled) return;
        setState({ path, data });
        markUpdated();
      } catch (e) {
        if (cancelled) return;
        if (e instanceof ApiError && e.status === 401) return;
        const message = e instanceof Error ? e.message : "알 수 없는 오류";
        setState((prev) => ({ path, data: prev.path === path ? prev.data : undefined, error: message }));
      } finally {
        inFlight = false;
      }
    };
    void run();
    const id = setInterval(run, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, intervalMs, tick]);

  const current = state.path === path ? state : { path };
  return {
    data: current.data,
    error: current.error ?? null,
    loading: current.data === undefined && current.error === undefined,
  };
}
