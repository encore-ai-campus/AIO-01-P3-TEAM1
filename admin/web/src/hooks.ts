import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ApiError, getJson } from "./api";
import { getTick, markUpdated, subscribeRefresh } from "./refresh";

export interface ApiResult<T> {
  data: T | undefined;
  error: string | null;
  /** 오류 응답의 HTTP 상태 (연결 실패 0, 오류가 없으면 null) — 장애 주입 꺼짐(404)처럼 상태로 화면을 바꿀 때 */
  errorStatus: number | null;
  loading: boolean;
}

/** 3초 · 15초 · 60초: 화면 종류별 다시 받는 간격 (3초는 진행 중인 리포트처럼 곧 바뀌는 것) */
export const POLL_LIVE = 3_000;
export const POLL_FAST = 15_000;
export const POLL_SLOW = 60_000;

/**
 * GET을 부르고 interval마다 다시 받는다 (화면이 보일 때만). 새로 고침 버튼과 주소 변경에도 다시 받는다.
 * interval에 함수를 주면 받은 자료로 간격을 정한다 (예: 진행 중이면 3초, 끝나면 60초). 간격만 바뀌면 바로 다시 부르지 않고 다음 차례부터 새 간격이다.
 * 401은 api.ts가 전체에 알려 로그인 화면으로 보낸다.
 */
export function useApi<T>(path: string, interval: number | ((data: T | undefined) => number)): ApiResult<T> {
  const tick = useSyncExternalStore(subscribeRefresh, getTick);
  const [state, setState] = useState<{ path: string; data?: T; error?: string; status?: number }>({ path });
  const runRef = useRef<() => void>(() => undefined);
  const current = state.path === path ? state : { path, data: undefined, error: undefined, status: undefined };
  const intervalMs = typeof interval === "function" ? interval(current.data) : interval;

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
        const status = e instanceof ApiError ? e.status : 0;
        setState((prev) => ({ path, data: prev.path === path ? prev.data : undefined, error: message, status }));
      } finally {
        inFlight = false;
      }
    };
    runRef.current = () => void run();
    void run();
    const onVisible = () => {
      if (document.visibilityState === "visible") void run();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      runRef.current = () => undefined;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [path, tick]);

  useEffect(() => {
    const id = setInterval(() => runRef.current(), intervalMs);
    return () => clearInterval(id);
  }, [path, tick, intervalMs]);

  return {
    data: current.data,
    error: current.error ?? null,
    errorStatus: current.status ?? null,
    loading: current.data === undefined && current.error === undefined,
  };
}
