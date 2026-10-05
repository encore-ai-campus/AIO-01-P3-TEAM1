// 시트·대화상자의 공통 동작: 처음 포커스, Esc, 배경 잠금(inert), 스크롤 잠금, 닫히면 포커스 복귀.
// dialog.showModal은 쓰지 않는다 (토스트를 그 위로 올릴 수 없고 jsdom에 없다). div + aria-modal + inert 방식.
import { type RefObject, useEffectEvent, useLayoutEffect, useRef } from "react";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// 열린 모달이 겹칠 수 있다 (주문 시트 → '왜 샀나요?'). 맨 위 모달 하나만 쓸 수 있고 Esc도 그것만 닫는다.
// 잠금은 모달이 열리고 닫힐 때마다 맨 위 모달 기준으로 다시 계산한다 (닫히는 순서가 어떻든 맞게).
const stack: { token: symbol; panel: HTMLElement }[] = [];
let inerted: Element[] = []; // 여기서 단 inert (다른 이유로 잠긴 요소는 건드리지 않는다)

/** 맨 위 모달의 패널에서 body까지 올라가며 형제 요소에 inert를 단다. data-inert-exempt(토스트 영역·스크림)는 건너뛴다. */
function refreshLock() {
  for (const el of inerted) el.removeAttribute("inert");
  inerted = [];
  const html = document.documentElement;
  const top = stack[stack.length - 1];
  if (!top) {
    html.removeAttribute("data-scroll-lock");
    return;
  }
  html.setAttribute("data-scroll-lock", ""); // index.css: overflow hidden (scrollbar-gutter로 본문이 튀지 않는다)
  for (let node: HTMLElement | null = top.panel; node && node !== document.body; node = node.parentElement) {
    for (const sib of Array.from(node.parentElement?.children ?? [])) {
      if (sib === node || sib.hasAttribute("inert") || sib.hasAttribute("data-inert-exempt") || sib.tagName === "SCRIPT") continue;
      sib.setAttribute("inert", "");
      inerted.push(sib);
    }
  }
}

/** 포커스가 아직 모달 안이나 body에 있으면 돌려준다 (사용자가 다른 곳으로 옮겼으면 그대로 둔다). */
function giveBack(back: HTMLElement, panel: HTMLElement) {
  const now = document.activeElement;
  if (!back.isConnected || (now && now !== document.body && !panel.contains(now))) return;
  back.focus({ preventScroll: true });
}

/**
 * active인 동안 panel을 모달로 만든다.
 * - 처음 포커스: initialFocus → panel 안 첫 포커스 가능 요소 → panel(tabIndex=-1).
 * - Esc: 맨 위 모달만 닫는다. 이미 처리된 Esc(defaultPrevented, 예: 용어 풀이 툴팁)는 무시한다.
 * - 배경: 형제에 inert, html[data-scroll-lock].
 * - 닫히면(active false·언마운트) returnFocus → 열기 전 포커스로 돌려준다 (iOS Safari는 눌러도 포커스를 주지 않으므로 returnFocus로 지정).
 *   위에 다른 모달이 열려 있으면 포커스를 빼앗지 않는다.
 */
export function useModal(
  panel: RefObject<HTMLElement | null>,
  opts: { active: boolean; onClose: () => void; initialFocus?: RefObject<HTMLElement | null>; returnFocus?: RefObject<HTMLElement | null> },
) {
  const { active, initialFocus, returnFocus } = opts;
  const close = useEffectEvent(opts.onClose);
  const unmounting = useRef(false);
  // active가 꺼진 뒤 돌려줄 포커스. React는 커밋 중간(정리 함수가 도는 때)에 바뀐 포커스를 커밋 끝에 원래 요소로 되돌리므로,
  // 패널이 남아 있는 경우(닫힘 애니메이션·주문 독)는 다음 layout effect에서 옮긴다
  const pending = useRef<{ back: HTMLElement; panel: HTMLElement } | null>(null);

  // 이 정리 함수가 돌면 컴포넌트가 사라지는 중이다 (아래 effect보다 먼저 선언해야 먼저 돈다)
  useLayoutEffect(() => {
    unmounting.current = false;
    return () => {
      unmounting.current = true;
    };
  }, []);

  useLayoutEffect(() => {
    const el = panel.current;
    if (!active || !el) return;
    // 닫힌 뒤 돌아갈 곳: 지정한 요소(연 버튼) → 열기 전 포커스
    const back = returnFocus?.current ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    const token = Symbol("modal");
    stack.push({ token, panel: el });
    refreshLock();
    (initialFocus?.current ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || stack[stack.length - 1]?.token !== token) return;
      e.preventDefault();
      close();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const at = stack.findIndex((m) => m.token === token);
      const wasTop = at >= 0 && at === stack.length - 1;
      if (at >= 0) stack.splice(at, 1);
      refreshLock();
      if (!wasTop || !back) return;
      if (unmounting.current) giveBack(back, el); // 패널이 같이 사라지면 React가 포커스를 되돌리지 않는다
      else pending.current = { back, panel: el };
    };
  }, [active, panel, initialFocus, returnFocus]);

  useLayoutEffect(() => {
    const next = pending.current;
    if (active || !next) return;
    pending.current = null;
    giveBack(next.back, next.panel);
  }, [active]);
}
