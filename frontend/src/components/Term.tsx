// 용어를 눌러서 풀이를 보는 조각: <Term k="손익비" /> 또는 <Term k="손절">손절 가격</Term>.
// 다시 누르거나, 바깥을 누르거나, Esc를 누르거나, 포커스가 용어를 떠나면(Tab) 닫힌다. 풀이는 lib/glossary.ts (화면 고정 사전)
// + lib/reportTerms.ts (AI 글에만 나오는 용어 — 이동평균선·지지선·저항선·등락률·밸류에이션, 쉬운 보기 리포트가 AI 글에 자동으로 붙인다).
// 풀이 상자는 body에 띄우고(position: fixed) 화면 안에 들어오게 자리를 잡는다 — 360px 화면의 오른쪽 열(표의 셋째 칸 등)이나
// 가로 스크롤 상자(overflow-x-auto) 안의 용어도 잘리거나 페이지 가로 스크롤을 만들지 않게. 아래에 자리가 없으면 위로 연다.
// 열 때만 용어 쪽에서 살짝 커지며 나타나고(index.css .tooltip-pop, 꼬리 자리가 기준점), 닫힘은 바로다. 꼬리가 어느 용어의 풀이인지 잇는다.
// 반전 표면(bg-ink + text-on-ink)이라 다크에서는 밝은 상자 + 어두운 글자가 된다. 겹침 층은 시트 위·토스트 아래(--z-popover).
import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { type TermKey, termEntry } from "../lib/reportTerms";

/** 화면 가장자리와 띄우는 거리(px) — 페이지 좌우 여백과 같다. */
const GUTTER = 16;
/** 용어와 풀이 상자 사이(px). */
const GAP = 6;
/** 꼬리가 상자 모서리 둥글림에 걸리지 않게 띄우는 거리(px). */
const TAIL_INSET = 14;

/** 용어 버튼(anchor) 아래(자리가 없으면 위)에, 화면 안에 들어오게 풀이 상자(tip)를 놓는다. */
function placeTooltip(anchor: DOMRect, tip: { width: number; height: number }, viewport: { width: number; height: number }) {
  const maxLeft = Math.max(GUTTER, viewport.width - GUTTER - tip.width);
  const left = Math.min(Math.max(anchor.left, GUTTER), maxLeft);
  const below = anchor.bottom + GAP;
  const above = anchor.top - GAP - tip.height;
  const side = below + tip.height > viewport.height - GUTTER && above >= GUTTER ? ("top" as const) : ("bottom" as const);
  // 꼬리: 용어 가운데를 가리킨다 (상자가 화면 안으로 당겨져도). 모서리 둥글림 안쪽으로만
  const tailX = Math.min(Math.max(anchor.left + anchor.width / 2 - left, TAIL_INSET), Math.max(TAIL_INSET, tip.width - TAIL_INSET));
  return { left, top: side === "top" ? above : below, side, tailX };
}

export function Term({ k, children, className }: { k: TermKey; children?: ReactNode; className?: string }) {
  const entry = termEntry(k);
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
    // Esc는 먼저(capture) 받아 처리했다고 표시한다 — 같은 Esc로 아래의 시트·대화상자까지 닫히지 않게 (useModal은 처리된 Esc를 무시한다).
    // 다만 이 용어가 열린 시트 뒤(배경, inert)에 있으면 닫기만 하고 표시하지 않는다 — 배경의 풀이가 시트의 Esc를 먹으면 두 번 눌러야 닫힌다
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (!btn.current?.closest("[inert]")) e.preventDefault();
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("touchstart", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("touchstart", onDown);
      document.removeEventListener("keydown", onKey, true);
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
      const { left, top, side, tailX } = placeTooltip(b.getBoundingClientRect(), box, { width, height: window.innerHeight });
      t.style.left = `${left}px`;
      t.style.top = `${top}px`;
      t.dataset.side = side;
      t.style.setProperty("--tail-x", `${tailX}px`);
      t.style.transformOrigin = `${tailX}px ${side === "top" ? "100%" : "0"}`; // 꼬리 자리에서 커진다
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
        // 포커스가 떠나면(Tab·다른 칸) 닫는다 — 열린 풀이가 다음 칸을 덮지 않게, 시트를 열 때 그 위에 남지 않게.
        // 창 전환처럼 포커스가 그대로인 blur는 두고, 풀이 상자를 누를 때는 상자가 포커스를 빼앗지 않는다(아래 onMouseDown)
        onBlur={(e) => {
          if (document.activeElement === e.currentTarget || tip.current?.contains(e.relatedTarget as Node | null)) return;
          setOpen(false);
        }}
        className={cn(
          // 열린 동안 밑줄을 파랑으로 — 풀이 상자가 어느 용어의 것인지 보인다
          "cursor-help rounded-sm underline decoration-mute-weak decoration-dotted underline-offset-4 transition-colors hover:decoration-sub focus-visible:outline-2 focus-visible:outline-brand aria-expanded:decoration-brand",
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
            // 상자를 눌러도 포커스가 용어에서 body로 빠지지 않게 (빠지면 위 onBlur가 닫는다). 바깥 누름 판정은 그대로 — 상자 안이라 열린 채다
            onMouseDown={(e) => e.preventDefault()}
            style={{ left: GUTTER, top: 0 }}
            className="tooltip-pop fixed z-(--z-popover) block w-max max-w-[min(18rem,calc(100vw-2rem))] rounded-xl bg-ink px-3.5 py-3 text-left text-[13px] leading-relaxed font-normal text-on-ink shadow-lg"
          >
            <b className="mb-0.5 block text-[14px]">{entry.term}</b>
            {entry.short}
            {/* 꼬리 (아래로 열리면 위 모서리, 위로 열리면 아래 모서리) */}
            <span
              aria-hidden="true"
              className="absolute top-[-4px] left-(--tail-x) size-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-ink in-data-[side=top]:top-auto in-data-[side=top]:bottom-[-4px]"
            />
          </span>,
          document.body,
        )}
    </span>
  );
}
