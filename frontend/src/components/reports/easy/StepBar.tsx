// 단계 막대 ① 만들기 ② 검토 ③ 실행 (docs/컨셉변경계획.md 3장). 상태는 색 + 아이콘 + 글자(화면 읽기용)로 같이 보인다.
import { cn } from "../../../lib/cn";
import { STEP_LABELS, STEP_STATE_TEXT, type StepState } from "../../../lib/reports";
import { Icon } from "../../Icon";

const DOT: Record<StepState, string> = {
  done: "bg-ok text-white",
  current: "bg-brand text-white ring-4 ring-brand-soft",
  todo: "bg-fill text-mute",
  failed: "bg-up text-white",
};

export function StepBar({ steps, className }: { steps: StepState[]; className?: string }) {
  return (
    <ol aria-label="리포트 단계" className={cn("flex items-center gap-1.5", className)}>
      {STEP_LABELS.map((label, i) => {
        const s = steps[i] ?? "todo";
        return (
          <li key={label} aria-current={s === "current" ? "step" : undefined} className="flex min-w-0 flex-1 items-center gap-1.5">
            <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold", DOT[s])}>
              {s === "done" ? <Icon name="check" className="size-3.5" /> : s === "failed" ? <Icon name="close" className="size-3.5" /> : i + 1}
            </span>
            <span className={cn("truncate text-[14px] font-semibold", s === "current" ? "text-ink" : s === "todo" ? "text-mute" : "text-sub")}>
              {label}
              <span className="sr-only"> ({STEP_STATE_TEXT[s]})</span>
            </span>
            {i < STEP_LABELS.length - 1 && <span aria-hidden="true" className="h-px min-w-3 flex-1 bg-line" />}
          </li>
        );
      })}
    </ol>
  );
}
