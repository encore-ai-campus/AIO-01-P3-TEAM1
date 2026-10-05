// 교육용 문서 접이식 영역. 문서와 Markdown 렌더러는 열 때 불러온다.
// 문서가 길어서(모바일 약 8,000px) 펼친 동안 머리(제목 + 접기)를 위에 붙여 두고, 끝에 '접기 · 맨 위로'를 둔다 — 다 읽고 닫으려고 거슬러 올라가지 않게.
// 큰 내용이라 높이를 보간하지 않는다: 열 때 바로 붙이고 문서만 짧게 페이드, 닫을 때는 바로 뗀다 (긴 높이 보간은 비싸고 한 번에 밀리는 느낌은 같다).
import { Suspense, lazy, useId, useRef, useState } from "react";
import { cn } from "../../lib/cn";
import { prefersReducedMotion } from "../../lib/motion";
import { Icon } from "../Icon";
import { Card, SkeletonCard } from "../ui";

const EduDoc = lazy(() => import("./EduDoc").then((m) => ({ default: m.EduDoc })));

/** 문서 본문만 (상세 화면의 "개념 문서" 탭). */
export function LazyEduDoc() {
  return (
    <Suspense fallback={<SkeletonCard lines={6} className="px-0" />}>
      <EduDoc />
    </Suspense>
  );
}

/**
 * 교육용 문서 접이식 영역.
 * stickyTop: 펼친 동안 머리가 붙을 위치 (모바일 화면 머리 아래 기본 top-14 — 화면에 고정 탭 줄이 더 있으면 그 아래로 준다).
 */
export function EduDocSection({ defaultOpen = false, stickyTop = "top-14 lg:top-4" }: { defaultOpen?: boolean; stickyTop?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const [opened, setOpened] = useState(false); // 사용자가 연 경우만 페이드 (처음부터 열려 있으면 움직이지 않는다)
  const docId = useId();
  const head = useRef<HTMLButtonElement>(null);
  const toggle = () => {
    setOpened(!open);
    setOpen((v) => !v);
  };
  // 끝의 '접기 · 맨 위로': 접고 이 영역의 머리로 올라간다 (움직임 줄이기면 바로).
  // 스크롤은 다시 그린 뒤(다음 프레임)에 한다 — 문서가 빠지기 전에 재면 긴 문서 기준 자리로 가고, 영역이 화면 맨 끝이 아니면 엉뚱한 곳에 선다.
  // 포커스는 지금 옮긴다 (누른 버튼이 문서와 함께 사라져 body로 떨어지지 않게).
  const closeToTop = () => {
    setOpen(false);
    const h = head.current;
    if (!h) return;
    h.focus({ preventScroll: true });
    const scroll = () => {
      if (typeof h.scrollIntoView === "function") h.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "nearest" });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
    else scroll();
  };
  return (
    <Card>
      <button
        ref={head}
        type="button"
        aria-expanded={open}
        aria-controls={open ? docId : undefined}
        onClick={toggle}
        className={cn(
          "-m-2 flex w-[calc(100%+1rem)] scroll-mt-20 items-center justify-between gap-3 rounded-xl bg-card p-2 text-left hover:bg-fill/60",
          // 펼친 동안 머리를 붙여 둔다 (어디서든 접을 수 있게)
          open && cn("sticky z-10", stickyTop),
        )}
      >
        <span>
          <span className="block text-[17px] font-bold">개념 문서: 04 Distributed Collaboration</span>
          <span className="block text-[13px] text-mute">Execution Plan · Join Guard · Partial Failure · Handoff · Shared State · Trace · SSE</span>
        </span>
        <span className="flex shrink-0 items-center gap-0.5 text-[13px] font-semibold text-mute">
          {open ? "접기" : "펼치기"}
          <Icon name="chevron-down" className={cn("size-5 transition-transform duration-fast", open && "rotate-180")} />
        </span>
      </button>
      {open && (
        <div id={docId} className={cn("mt-3 border-t border-line pt-2", opened && "reveal-fade")}>
          <LazyEduDoc />
          <button
            type="button"
            onClick={closeToTop}
            className="press mt-4 flex h-11 w-full items-center justify-center gap-1 rounded-xl bg-fill text-[14px] font-semibold text-sub hover:bg-line"
          >
            <Icon name="arrow-up" className="size-4" />
            접기 · 맨 위로
          </button>
        </div>
      )}
    </Card>
  );
}
