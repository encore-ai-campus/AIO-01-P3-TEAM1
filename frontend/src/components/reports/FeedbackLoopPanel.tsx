import type { ExecutionPlan, TraceEvent } from "../../api/types";
import { actorLabel } from "../../lib/reports";
import { Icon } from "../Icon";
import { Card } from "../ui";

function reviewRetries(trace: TraceEvent[]) {
  return trace
    .filter((event) => event.action === "review_retry")
    .map((event) => ({
      step: event.step,
      round: typeof event.details.round === "number" ? event.details.round : null,
      target: typeof event.details.target === "string" ? event.details.target : "",
      issues: Array.isArray(event.details.issues) ? event.details.issues.map(String) : [],
      instructions: typeof event.details.instructions === "string" ? event.details.instructions : "",
    }));
}

/** 실제 review_retry Trace가 있을 때만 Feedback Loop를 별도 카드로 강조한다. */
export function FeedbackLoopPanel({ trace, plan, example }: { trace: TraceEvent[]; plan: ExecutionPlan; example: boolean }) {
  const retries = reviewRetries(trace);
  if (retries.length === 0) return null;

  return (
    <Card aria-labelledby="feedback-loop-title" className="border-warn/50 bg-warn-soft/40">
      <div className="flex items-start gap-2.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-warn text-on-warn">
          <Icon name="restart" className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id="feedback-loop-title" className="text-[16px] font-bold">Feedback Loop · 검토 후 재작성</h2>
          <p className="mt-0.5 text-[13px] leading-snug text-sub">
            검토 Agent가 수정할 점을 찾아 Writer Agent에게 다시 보낸 Trace입니다.{example && " (예시 실행)"}
          </p>
        </div>
      </div>
      <ol className="mt-3 space-y-2" aria-label="Feedback Loop 재작성 기록">
        {retries.map((retry) => (
          <li key={retry.step} className="rounded-xl bg-card px-3 py-2.5">
            <p className="text-[14px] font-semibold">
              {retry.round ? `${retry.round}번째 검토` : "검토"} → {actorLabel(plan, retry.target)} 재작성
            </p>
            {retry.issues.length > 0 && <p className="mt-1 text-[13px] leading-snug text-sub">수정할 점: {retry.issues.join(" · ")}</p>}
            {retry.instructions && <p className="mt-1 text-[13px] leading-snug text-sub">수정 지시: {retry.instructions}</p>}
          </li>
        ))}
      </ol>
    </Card>
  );
}
