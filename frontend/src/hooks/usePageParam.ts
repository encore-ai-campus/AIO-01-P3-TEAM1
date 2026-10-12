import { useCallback } from "react";
import { useSearchParams } from "react-router";

/**
 * 주소의 ?key= 쪽 번호 (1부터). 1이면 주소에서 뺀다. 바꿀 때 기록을 늘리지 않는다(replace) —
 * 상세에 다녀와도(뒤로) 보던 쪽으로 돌아오고, 쪽을 넘긴 만큼 '뒤로'를 눌러야 하는 일은 없다 (리포트 탭 목록, docs/DECISIONS.md 34장).
 */
export function usePageParam(key: string): [number, (page: number) => void] {
  const [params, setParams] = useSearchParams();
  const n = Number(params.get(key));
  const page = Number.isInteger(n) && n >= 1 ? n : 1;
  const setPage = useCallback(
    (next: number) =>
      setParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          if (next <= 1) sp.delete(key);
          else sp.set(key, String(next));
          return sp;
        },
        { replace: true },
      ),
    [key, setParams],
  );
  return [page, setPage];
}
