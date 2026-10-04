// 용어를 눌러서 풀이를 보는 조각: <Term k="손익비" /> 또는 <Term k="손절">손절 가격</Term>.
// 다시 누르거나, 바깥을 누르거나, Esc를 누르면 닫힌다. 풀이는 lib/glossary.ts (화면 고정 사전).
// 풀이 상자는 body에 띄우고(position: fixed) 화면 안에 들어오게 자리를 잡는다 — 360px 화면의 오른쪽 열(표의 셋째 칸 등)이나
// 가로 스크롤 상자(overflow-x-auto) 안의 용어도 잘리거나 페이지 가로 스크롤을 만들지 않게. 아래에 자리가 없으면 위로 연다.
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { GLOSSARY, type GlossaryKey } from "../lib/glossary";

/** 화면 가장자리와 띄우는 거리(px) — 페이지 좌우 여백과 같다. */
const GUTTER = 16;
/** 용어와 풀이 상자 사이(px). */
const GAP = 6;

/** 용어 버튼(anchor) 아래(자리가 없으면 위)에, 화면 안에 들어오게 풀이 상자(tip)를 놓는다. */
function placeTooltip(anchor: DOMRect, tip: { width: number; height: number }, viewport: { width: number; height: number }) {
  const maxLeft = Math.max(GUTTER, viewport.width - GUTTER - tip.width);
  const left = Math.min(Math.max(anchor.left, GUTTER), maxLeft);
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - tip.height;
  const top = below + tip.height > viewport.height - GUTTER && above >= GUTTER ? above : below;
  return { left, top };
}

export function Term({ k, children, className }: { k: GlossaryKey; children?: ReactNode; className?: string }) {
  const entry = GLOSSARY[k];
  const [open, setOpen] = useState(false);
  const id = useId();
  const btn = useRef<HTMLButtonElement>(null);
  const tip = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !tip.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 그리기 전에 자리를 잡고, 스크롤·화면 크기가 바뀌면 다시 잡는다 (DOM에 바로 쓴다 — 상태를 두지 않는다)
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = btn.current;
      const t = tip.current;
      if (!b || !t) return;
      const box = t.getBoundingClientRect();
      const width = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
      const { left, top } = placeTooltip(b.getBoundingClientRect(), box, { width, height: window.innerHeight });
      t.style.left = `${left}px`;
      t.style.top = `${top}px`;
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  return (
    <span className="inline-block">
      <button
        ref={btn}
        type="button"
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "cursor-help rounded-sm underline decoration-mute decoration-dotted underline-offset-4 hover:decoration-sub focus-visible:outline-2 focus-visible:outline-brand",
          className,
        )}
      >
        {children ?? entry.term}
      </button>
      {open &&
        createPortal(
          <span
            ref={tip}
            role="tooltip"
            id={id}
            style={{ left: GUTTER, top: 0 }}
            className="fixed z-[70] block w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-xl bg-ink px-3.5 py-3 text-left text-[13px] leading-relaxed font-normal text-white shadow-lg"
          >
            <b className="mb-0.5 block text-[14px]">{entry.term}</b>
            {entry.short}
          </span>,
          document.body,
        )}
    </span>
  );
}
