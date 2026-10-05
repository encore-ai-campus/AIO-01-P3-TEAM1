// 내용이 나타날 때의 움직임 판단. 움직이는 때는 (a) 기다린 끝에 내용이 왔을 때 (b) 사용자가 상태를 바꾼 순간뿐이다.
// 캐시로 바로 그린 화면·첫 렌더·폴링 갱신에서는 움직이지 않는다. CSS는 index.css의 .reveal-fade·[data-reveal]·.is-new.
import { type AnimationEvent, type AnimationEventHandler, useState } from "react";

/**
 * 처음 그릴 때 불러오는 중이었고, 이제 다 왔으면 true. 캐시로 바로 그렸으면 늘 false.
 * early return보다 앞에서 부른다: const reveal = useRevealAfterLoading(isPending);
 */
export function useRevealAfterLoading(pending: boolean): boolean {
  const [startedPending] = useState(pending);
  return startedPending && !pending;
}

/**
 * 마운트할 때의 값에서 한 번이라도 바뀌었으면 true (그 뒤로 계속 true). 첫 렌더에는 움직이지 않게 할 때 쓴다.
 * A↔B 교체: const changed = useChanged(mode); <div key={mode} className={changed ? "reveal-fade" : undefined}>
 */
export function useChanged<T>(value: T): boolean {
  const [seen, setSeen] = useState({ first: value, changed: false });
  const differs = !Object.is(seen.first, value);
  if (differs && !seen.changed) setSeen({ first: seen.first, changed: true }); // 렌더 중 조건부 파생 상태
  return seen.changed || differs;
}

const NO_KEYS: ReadonlySet<never> = new Set<never>();

/**
 * 기준 시점 뒤에 새로 생긴 항목 (실시간으로 붙는 알림·사건 → className .is-new).
 * 기준은 ready가 처음 true인 렌더의 목록이다 (불러오는 동안 빈 목록을 기준으로 삼아 전부 '새 항목'이 되지 않게).
 */
export function useNewKeys<K>(keys: readonly K[], ready = true): ReadonlySet<K> {
  const [initial, setInitial] = useState<ReadonlySet<K> | null>(() => (ready ? new Set(keys) : null));
  if (initial === null && ready) setInitial(new Set(keys));
  if (initial === null) return NO_KEYS;
  return new Set(keys.filter((k) => !initial.has(k)));
}

/**
 * .is-new 항목의 onAnimationEnd: 등장이 끝나면 data-shown을 DOM에 직접 단다 (index.css는 .is-new:not([data-shown])에만 움직임을 건다).
 * 폴링으로 순서가 바뀌어 React가 줄을 옮기면(insertBefore) CSS 애니메이션이 처음부터 다시 돈다 — 랭킹처럼 순서가 바뀌는 목록에 단다.
 * <li className={cn(fresh && "is-new")} onAnimationEnd={fresh ? markShown : undefined}>
 */
export function markShown(e: AnimationEvent<HTMLElement>) {
  if (e.target === e.currentTarget) e.currentTarget.setAttribute("data-shown", "");
}

/** 순차 등장이 끝났다고 표시하는 안전 시간(ms). 최대 지연 200ms + rise 240ms보다 길다. */
const REVEAL_SAFETY_MS = 600;

const markRevealed = (el: Element) => el.setAttribute("data-revealed", "");

// 첫 항목이 움직이기 시작하면 600ms 뒤 data-revealed를 단다 — 폴링으로 마지막 항목이 바뀌어 animationend가 오지 않아도 멈추게
function onRevealStart(e: AnimationEvent<HTMLElement>) {
  const list = e.currentTarget;
  if ((e.target as Element).parentElement !== list || list.hasAttribute("data-reveal-timer")) return;
  list.setAttribute("data-reveal-timer", "");
  window.setTimeout(() => markRevealed(list), REVEAL_SAFETY_MS);
}

function onRevealEnd(e: AnimationEvent<HTMLElement>) {
  if (e.target === e.currentTarget.lastElementChild) markRevealed(e.currentTarget);
}

/** revealList가 돌려주는 props (목록 요소에 펼쳐 쓴다). */
export interface RevealProps {
  "data-reveal"?: "fade" | "rise";
  onAnimationStart?: AnimationEventHandler<HTMLElement>;
  onAnimationEnd?: AnimationEventHandler<HTMLElement>;
}

/**
 * 목록이 처음 나타날 때의 props (목록 요소에 펼쳐 쓴다): <ul {...revealList(reveal)} className="divide-y …">
 * - "fade"(기본): 목록 전체가 한 번에 160ms 페이드 — 행 목록(보유·주문·알림·검색·랭킹·리포트 목록).
 * - "rise": 항목이 40ms 간격(최대 5단계)으로 8px 올라오며 나타난다 — 카드 5개 이하 목록에만.
 * 끝나면 data-revealed를 DOM에 직접 단다. React가 관리하지 않는 속성이라 폴링·순서 변경으로 노드가 움직여도 다시 재생되지 않는다.
 */
export function revealList(on: boolean, kind: "fade" | "rise" = "fade"): RevealProps {
  if (!on) return {};
  if (kind === "fade") return { "data-reveal": "fade" };
  return { "data-reveal": "rise", onAnimationStart: onRevealStart, onAnimationEnd: onRevealEnd };
}
