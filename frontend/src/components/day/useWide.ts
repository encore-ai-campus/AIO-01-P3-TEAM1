// PC 2단(lg 이상)인지. 단타 연습장은 PC에서 미리 보기를 오른쪽 칸으로 옮긴다 (입력은 왼쪽, 입력에 반응하는 숫자는 오른쪽).
// matchMedia가 없으면(jsdom) false — 테스트는 모바일 한 열 배치(미리 보기가 폼 안)로 돈다. DOM은 늘 한 벌이다.
import { useSyncExternalStore } from "react";

const LG = "(min-width: 64rem)"; // Tailwind lg와 같다

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const media = window.matchMedia(LG);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

const snapshot = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(LG).matches;

export function useWide(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
