// 요소의 높이(px, 올림). 바뀌면 다시 잰다 (ResizeObserver가 없으면 0 — jsdom).
// 예시 재생 띠(ReplayBar)가 PC에서 위에 붙을 때 그 높이를 화면이 --replay-h로 넘기는 데 쓴다 (ReportPage·WorkflowPreviewPage).
import { useEffect, useState } from "react";

export function useHeight(el: HTMLElement | null): number {
  const [h, setH] = useState(0);
  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setH(Math.ceil(el.getBoundingClientRect().height)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return el ? h : 0;
}
