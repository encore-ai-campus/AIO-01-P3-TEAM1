import { useEffect, useState } from "react";

/** 값이 ms 동안 바뀌지 않으면 그 값을 돌려준다 (검색 입력 디바운스). */
export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
