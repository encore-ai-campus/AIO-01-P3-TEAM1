// 교육용 문서 접이식 영역. 문서와 Markdown 렌더러는 열 때 불러온다.
import { Suspense, lazy, useState } from "react";
import { cn } from "../../lib/cn";
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

/** 교육용 문서 접이식 영역 (상세 화면에서는 "개념 문서" 탭). */
export function EduDocSection({ defaultOpen = false }: { defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card>
      <button
        type="button"
        aria-expanded={open}
        aria-controls="edu-doc"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span>
          <span className="block text-[17px] font-bold">개념 문서: 04 Distributed Collaboration</span>
          <span className="block text-[13px] text-mute">Execution Plan · Join Guard · Partial Failure · Handoff · Shared State · Trace · SSE</span>
        </span>
        <Icon name="chevron" className={cn("size-5 shrink-0 text-mute transition-transform", open ? "-rotate-90" : "rotate-90")} />
      </button>
      {open && (
        <div id="edu-doc" className="mt-3 border-t border-line pt-2">
          <LazyEduDoc />
        </div>
      )}
    </Card>
  );
}

