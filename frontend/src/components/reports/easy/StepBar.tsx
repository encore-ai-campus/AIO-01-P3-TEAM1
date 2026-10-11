// 단계 막대 ① 만들기 ② 검토 ③ 실행 (docs/plans/컨셉변경계획.md 3장). 상태는 색 + 아이콘 + 글자(화면 읽기용)로 같이 보인다.
// 단계가 넘어가는 순간: 점의 색이 240ms로 바뀌고, 새 아이콘은 한 번 작게 나타나며(pop-in), 연결선이 왼쪽부터 초록으로 찬다.
// 처음 그릴 때는 움직이지 않는다 (CSS 전이는 값이 바뀔 때만, 아이콘은 막대 상태가 바뀐 뒤에만).
// ③ '없음'(skipped): 이 리포트로는 실행할 계획이 없다 — 할 일이 남은 것처럼 보이지 않게 대시로 옅게.
import { useChanged } from "../../../hooks/useMotionState";
import { cn } from "../../../lib/cn";
import { STEP_LABELS, STEP_STATE_TEXT, type StepState } from "../../../lib/reports";
import { Icon } from "../../Icon";

const DOT: Record<StepState, string> = {
  done: "bg-ok text-white",
  current: "bg-brand text-white ring-4 ring-brand-soft",
  todo: "bg-fill text-mute",
  failed: "bg-up text-white",
  skipped: "bg-fill text-mute-weak",
};

function Mark({ state, n }: { state: StepState; n: number }) {
  if (state === "done") return <Icon name="check" className="size-3.5" />;
  if (state === "failed") return <Icon name="close" className="size-3.5" />;
  if (state === "skipped") return <Icon name="minus" className="size-3.5" />;
  return <>{n}</>;
}

export function StepBar({ steps, className }: { steps: StepState[]; className?: string }) {
  // 막대 상태가 이 화면에서 바뀐 뒤에만 아이콘이 나타나는 움직임을 준다 (만드는 중 → 완성, 실행 시작)
  const changed = useChanged(steps.join());
  return (
    <ol aria-label="리포트 단계" className={cn("flex items-center gap-1.5", className)}>
      {STEP_LABELS.map((label, i) => {
        const s = steps[i] ?? "todo";
        const last = i === STEP_LABELS.length - 1;
        return (
          // 마지막 칸은 연결선이 없으니 늘이지 않는다 (막대가 75% 지점에서 끝나 보이지 않게)
          <li key={label} aria-current={s === "current" ? "step" : undefined} className={cn("flex min-w-0 items-center gap-1.5", last ? "flex-none" : "flex-1")}>
            <span
              className={cn(
                "grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold transition-[background-color,color,box-shadow] duration-base ease-standard",
                DOT[s],
              )}
            >
              <span key={s} className={cn("grid place-items-center", changed && "animate-pop-in")}>
                <Mark state={s} n={i + 1} />
              </span>
            </span>
            <span
              className={cn(
                "truncate text-[14px] font-semibold transition-colors duration-base",
                s === "current" ? "text-ink" : s === "todo" || s === "skipped" ? "text-mute" : "text-sub",
              )}
            >
              {label}
              <span className="sr-only"> ({STEP_STATE_TEXT[s]})</span>
            </span>
            {!last && (
              // 연결선 두 겹: 바탕 선 위에 끝난 단계만큼 초록 막대가 왼쪽부터 찬다 (scale-x, 레이아웃 계산 없음)
              <span aria-hidden="true" className="relative h-0.5 min-w-3 flex-1 overflow-hidden rounded-full bg-line">
                <span
                  className="absolute inset-0 origin-left bg-ok transition-[scale] duration-base ease-standard"
                  style={{ scale: s === "done" ? "1 1" : "0 1" }}
                />
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
