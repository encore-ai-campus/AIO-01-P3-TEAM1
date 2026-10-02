// 구조화된 Trace 타임라인: 사건을 step 순서로. 새 사건은 아래에 붙는다.
import type { ExecutionPlan, TraceEvent } from "../../api/types";
import { formatLatency, formatTime } from "../../lib/format";
import { actorLabel } from "../../lib/reports";
import { NodeStatusChip } from "./StatusChip";

/** 펼치면 JSON을 보여 준다. */
export function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="group mt-1.5 text-[12px]">
      <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-brand select-none">{summary}</summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-fill p-2.5 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-sub">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

export function TraceTimeline({ trace, plan }: { trace: TraceEvent[]; plan: ExecutionPlan }) {
  if (trace.length === 0) {
    return <p className="py-8 text-center text-[15px] text-mute">아직 실행 사건이 없습니다.</p>;
  }
  return (
    <ol aria-label="Trace 사건" className="space-y-2">
      {trace.map((e) => {
        const run = [e.provider, e.model].filter(Boolean).join(" · ");
        return (
          <li key={e.step} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="grid h-6 min-w-6 place-items-center rounded-full bg-ink px-1.5 text-[12px] font-bold text-white tabular-nums">
                <span className="sr-only">step </span>
                {e.step}
              </span>
              <span className="text-[14px] font-bold">{actorLabel(plan, e.actor)}</span>
              <code className="rounded bg-fill px-1 font-mono text-[12px] text-sub">{e.action}</code>
              <NodeStatusChip status={e.status} />
              <time dateTime={e.at} className="ml-auto text-[12px] text-mute tabular-nums">
                {formatTime(e.at)}
              </time>
            </div>
            {(run || e.latencyMs !== null) && (
              <p className="mt-1 text-[12px] text-mute">
                {run && <span className="font-mono">{run}</span>}
                {run && e.latencyMs !== null && " · "}
                {e.latencyMs !== null && <span className="tabular-nums">{formatLatency(e.latencyMs)}</span>}
              </p>
            )}
            {Object.keys(e.details).length > 0 && <JsonDetails summary="details" value={e.details} />}
          </li>
        );
      })}
    </ol>
  );
}
