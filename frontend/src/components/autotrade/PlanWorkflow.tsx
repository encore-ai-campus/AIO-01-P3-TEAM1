// 자동매매 워크플로우 그래프 (활성화 → 리스크 점검 → 진입 주문 → 체결 대기 → 보유 감시 → 청산)와 사건 타임라인.
import type { PlanEvent } from "../../api/types";
import { eventKindOf, type StepState, type Workflow } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { Icon, type IconName } from "../Icon";

const STATE: Record<StepState, { label: string; node: string; icon: IconName; text: string }> = {
  done: { label: "완료", node: "bg-brand text-white", icon: "check", text: "text-ink" },
  current: { label: "진행 중", node: "bg-card text-brand ring-2 ring-brand", icon: "clock", text: "text-brand-dark font-bold" },
  stopped: { label: "멈춤", node: "bg-up-soft text-up ring-2 ring-up/50", icon: "ban", text: "text-up font-bold" },
  todo: { label: "대기", node: "bg-fill text-mute", icon: "circle", text: "text-mute" },
  skipped: { label: "건너뜀", node: "bg-fill text-line", icon: "skip", text: "text-mute line-through" },
};

const OUTCOME_CLS = { ok: "bg-ok-soft text-ok", neutral: "bg-fill text-sub", error: "bg-up-soft text-up" } as const;

export function WorkflowGraph({ wf }: { wf: Workflow }) {
  return (
    <div>
      <ol aria-label="자동매매 단계" className="grid grid-cols-3 gap-x-1 gap-y-4 sm:grid-cols-6">
        {wf.steps.map((s, i) => {
          const st = STATE[s.state];
          return (
            <li
              key={s.key}
              aria-current={s.state === "current" ? "step" : undefined}
              className="relative flex flex-col items-center text-center"
              title={s.hint}
            >
              {i > 0 && (
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute top-[17px] -left-1/2 hidden h-0.5 w-full sm:block",
                    s.state === "done" || s.state === "current" || s.state === "stopped" ? "bg-brand" : "bg-line",
                  )}
                />
              )}
              <span className={cn("relative z-10 grid size-9 place-items-center rounded-full", st.node)}>
                <Icon name={st.icon} className={cn("size-4", s.state === "current" && "animate-pulse")} />
              </span>
              <span className={cn("mt-1.5 text-[13px] leading-tight", st.text)}>{s.label}</span>
              <span className="text-[11px] text-mute">
                {st.label}
                {s.key === "wait" && wf.requeues > 0 ? ` · 재주문 ${wf.requeues}회` : ""}
              </span>
            </li>
          );
        })}
      </ol>
      {wf.outcome && (
        <p role="note" className={cn("mt-4 flex items-start gap-2 rounded-xl px-3.5 py-3 text-[14px]", OUTCOME_CLS[wf.outcome.tone])}>
          <Icon name={wf.outcome.tone === "ok" ? "check" : wf.outcome.tone === "error" ? "alert" : "ban"} className="mt-0.5 size-4 shrink-0" />
          <span>
            <b>{wf.outcome.title}</b> · {wf.outcome.text}
          </span>
        </p>
      )}
    </div>
  );
}

/** 계획 사건 타임라인 (step 오름차순). 모르는 kind도 메시지를 그대로 보인다. */
export function PlanTimeline({ events }: { events: PlanEvent[] }) {
  if (events.length === 0) return <p className="text-[14px] text-mute">아직 사건이 없습니다.</p>;
  return (
    <ol aria-label="계획 사건" className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-0.5 before:bg-line">
      {[...events]
        .sort((a, b) => a.step - b.step)
        .map((e) => {
          const k = eventKindOf(e.kind);
          return (
            <li key={e.step} className="relative flex gap-3">
              <span className={cn("relative z-10 grid size-7 shrink-0 place-items-center rounded-full", k.cls)}>
                <Icon name={k.icon} className="size-3.5" />
              </span>
              <div className="min-w-0 pt-0.5">
                <p className="text-[14px] leading-snug">
                  <span className="mr-1.5 text-[12px] font-bold text-sub">{k.label}</span>
                  {e.message}
                </p>
                <p className="text-[12px] text-mute tabular-nums">
                  #{e.step} · {formatDateTime(e.at)}
                </p>
              </div>
            </li>
          );
        })}
    </ol>
  );
}
