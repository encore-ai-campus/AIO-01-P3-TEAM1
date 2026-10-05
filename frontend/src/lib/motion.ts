// 움직임 공용 조각 (컴포넌트 없음 — Fast Refresh 규칙). 값은 index.css의 모션 토큰과 같다.
// 테스트(jsdom, css:false)에는 getAnimations·matchMedia·scrollTo 구현이 없어서 모두 typeof로 확인하고, 없으면 바로 끝낸다.

/** 애니메이션을 기다릴 수 있는 환경인지. jsdom은 false → 닫힘·퇴장을 같은 렌더에서 끝낸다 (동기 단언이 그대로 통과). */
export const CAN_ANIMATE = typeof Element !== "undefined" && typeof Element.prototype.getAnimations === "function";

/** JS로 돌리는 애니메이션(Web Animations·View Transition)용 길이(ms). CSS 토큰 --transition-duration-*과 같다. */
export const DURATION = { instant: 100, fast: 160, base: 240, slow: 320 } as const;

/** JS로 돌리는 애니메이션용 곡선. CSS 토큰 --ease-*와 같다. */
export const EASE = {
  standard: "cubic-bezier(0.2, 0, 0, 1)",
  enter: "cubic-bezier(0.05, 0.7, 0.1, 1)",
  exit: "cubic-bezier(0.3, 0, 0.8, 0.15)",
} as const;

/** 기기의 '동작 줄이기' 설정. matchMedia가 없으면(jsdom) false. */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 끝이 있는 애니메이션·트랜지션만 고른다. 닫힘을 기다릴 때 스피너 같은 무한 애니메이션은 뺀다. */
export function finiteAnimations(el: Element, subtree = false): Animation[] {
  if (!CAN_ANIMATE) return [];
  return el.getAnimations({ subtree }).filter((a) => {
    const end = a.effect?.getComputedTiming().endTime;
    return typeof end === "number" && Number.isFinite(end);
  });
}

/** 맨 위로. 기본은 부드럽게, 동작 줄이기면 바로. 화면에서 window.scrollTo를 직접 부르지 말고 이것을 쓴다. */
export function scrollToTop(smooth = true) {
  if (typeof window === "undefined" || typeof window.scrollTo !== "function") return;
  window.scrollTo({ top: 0, left: 0, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}
