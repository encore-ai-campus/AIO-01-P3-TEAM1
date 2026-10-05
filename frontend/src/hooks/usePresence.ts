// 나가는 애니메이션이 끝난 뒤 언마운트한다 (접힘·시트). 외부 라이브러리 없이 Web Animations의 finished를 기다린다.
import { type RefObject, useLayoutEffect, useState } from "react";
import { CAN_ANIMATE, finiteAnimations } from "../lib/motion";

export type PresenceState = "open" | "closing";

/**
 * 열기: 같은 렌더에서 바로 마운트한다 (테스트가 동기로 찾는다).
 * 닫기: 애니메이션을 못 하는 환경(jsdom)이면 같은 렌더에서 바로 언마운트한다.
 *       그 밖에는 state=closing으로 두고, ref 요소(subtree면 자손까지)의 끝이 있는 애니메이션이 끝나거나 maxMs가 지나면 언마운트한다.
 * appear: 마운트된 뒤에 사용자가 열었을 때만 true. 처음부터 열려 있던 내용은 움직이지 않는다.
 */
export function usePresence(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  { subtree = false, maxMs = 700 }: { subtree?: boolean; maxMs?: number } = {},
): { present: boolean; state: PresenceState; appear: boolean } {
  const [mounted, setMounted] = useState(open);
  const [appear, setAppear] = useState(false);
  // 렌더 중 조건부 파생 상태 (ui.tsx Flash와 같은 패턴 — effect를 기다리지 않아 같은 렌더에서 끝난다)
  if (open && !mounted) {
    setMounted(true);
    setAppear(true);
  }
  if (!open && mounted && !CAN_ANIMATE) setMounted(false);

  useLayoutEffect(() => {
    if (open || !mounted) return;
    const el = ref.current;
    let live = true;
    const done = () => {
      if (live) setMounted(false); // 비동기 콜백 안의 setState
    };
    const timer = window.setTimeout(done, maxMs); // 애니메이션이 끝나지 않아도(요소가 숨겨짐 등) 언마운트한다
    void Promise.allSettled((el ? finiteAnimations(el, subtree) : []).map((a) => a.finished)).then(done);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [open, mounted, ref, subtree, maxMs]);

  return { present: open || mounted, state: open ? "open" : "closing", appear };
}
