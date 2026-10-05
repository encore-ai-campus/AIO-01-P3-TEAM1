// 같은 선택 표시가 옆으로 미끄러진다 (Segmented). CSS는 index.css의 .seg·.seg-indicator·.seg-on.
import { type RefObject, useLayoutEffect } from "react";

/**
 * container 안에서 selector에 맞는 요소(선택된 버튼)의 자리·폭을 CSS 변수(--ind-x, --ind-w)로 넘긴다.
 * - 측정할 수 없으면(jsdom·숨김, 폭 0) data-indicator를 떼어 버튼이 직접 배경을 그린다 (.seg-on).
 * - 첫 자리는 미끄러지지 않고, 다음 프레임부터 transition(data-indicator-ready).
 * - 폭이 바뀌면(시트 안처럼 0이었다가 커짐, 글자 크기 변경) ResizeObserver로 다시 잰다.
 * key: 선택 값처럼 바뀌면 다시 재야 하는 값.
 */
export function useSlidingIndicator(container: RefObject<HTMLElement | null>, selector: string, key: unknown) {
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    let frame = 0;
    const place = () => {
      const on = el.querySelector<HTMLElement>(selector);
      if (!on || on.offsetWidth === 0) {
        el.removeAttribute("data-indicator");
        el.removeAttribute("data-indicator-ready");
        return;
      }
      el.style.setProperty("--ind-x", `${on.offsetLeft}px`);
      el.style.setProperty("--ind-w", `${on.offsetWidth}px`);
      el.setAttribute("data-indicator", "");
      if (!el.hasAttribute("data-indicator-ready") && typeof requestAnimationFrame === "function") {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => el.setAttribute("data-indicator-ready", ""));
      }
    };
    place();
    if (typeof ResizeObserver !== "function") return () => cancelAnimationFrame(frame);
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [container, selector, key]);
}
