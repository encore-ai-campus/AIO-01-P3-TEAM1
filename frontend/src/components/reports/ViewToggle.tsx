// "이 화면만 자세히 보기" (?view=expert, 저장하지 않음). 주린이모드는 마이에서 바꾼다 (hooks/useBeginnerMode.ts).
// 쉬운 보기 → 전문가 보기, 이 화면만 전문가 보기 → 쉬운 보기로 돌아가기, 주린이모드 끔 → 이 화면만 쉬운 보기.
import type { ViewModeState } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";

export function ViewToggle({ view, compact = false, className }: { view: ViewModeState; compact?: boolean; className?: string }) {
  const [label, next] = view.easy
    ? [compact ? "자세히 보기" : "이 화면만 자세히 보기", "expert" as const]
    : view.override === "expert"
      ? [compact ? "쉬운 보기" : "쉬운 보기로 돌아가기", null]
      : [compact ? "쉬운 보기" : "이 화면만 쉽게 보기", "easy" as const];
  return (
    <button
      type="button"
      onClick={() => view.setView(next)}
      className={cn(
        "flex h-9 shrink-0 items-center rounded-full bg-fill px-3 text-[13px] font-semibold whitespace-nowrap text-sub hover:bg-line",
        className,
      )}
    >
      {label}
    </button>
  );
}
