// PC 폭(Tailwind lg, 64rem 이상)인지. PC에만 있는 추가 요소(모의투자 계좌 요약 줄·표 머리, 계획 화면의 가격 차트 등)를
// CSS로 숨긴 사본 대신 아예 그리지 않으려고 쓴다 — 숨긴 사본도 DOM(테스트·화면 읽기)에는 남아 같은 이름이 둘이 된다 (DESIGN 부록 B0-7).
// 배치(열·순서)는 여전히 CSS(lg:)로 정한다. matchMedia가 없으면(jsdom) 모바일로 본다.
import { useSyncExternalStore } from "react";

const QUERY = "(min-width: 64rem)";

const media = () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null);

function subscribe(onChange: () => void) {
  const mq = media();
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useIsPc(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => media()?.matches ?? false,
    () => false,
  );
}
