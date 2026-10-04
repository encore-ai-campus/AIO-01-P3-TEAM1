// Trace 타임라인: 사건을 사람이 읽는 문장으로 (src/lib/reports.ts의 eventText). 새 사건은 아래에 붙는다.
// "주요 사건"(기본)은 실패·재시도·전환·완료·포기·검토 반복·막힘·시작과 끝만, "전체"는 모든 사건과 원본 action·details.
import { useState } from "react";
import type { ExecutionPlan, TraceEvent } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatLatency, formatTime } from "../../lib/format";
import { actorLabel, eventText, isKeyEvent, type EventTone } from "../../lib/reports";
import { Icon } from "../Icon";
import { Segmented } from "../ui";
import { InjectedBadge, NodeStatusChip, RecoveredBadge } from "./StatusChip";

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

const TONE: Record<EventTone, { dot: string; box: string }> = {
  fail: { dot: "bg-up text-white", box: "border-up/40 bg-up-soft/50" },
  recover: { dot: "bg-warn text-white", box: "border-warn/50 bg-warn-soft/60" },
  ok: { dot: "bg-ok text-white", box: "border-line" },
  info: { dot: "bg-fill text-sub", box: "border-line" },
};

function Tag({ tag }: { tag: string }) {
  if (tag === "주입") return <InjectedBadge />;
  if (tag === "자동 복구") return <RecoveredBadge />;
  return <span className="inline-flex h-6 items-center rounded-md bg-up px-1.5 text-[12px] font-bold text-white">{tag}</span>;
}

type Mode = "key" | "all";

export function TraceTimeline({ trace, plan }: { trace: TraceEvent[]; plan: ExecutionPlan }) {
  const [mode, setMode] = useState<Mode>("key");
  if (trace.length === 0) {
    return <p className="py-8 text-center text-[15px] text-mute">아직 실행 사건이 없습니다.</p>;
  }
  const shown = mode === "key" ? trace.filter(isKeyEvent) : trace;
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="타임라인 보기"
          value={mode}
          onChange={setMode}
          options={[
            { value: "key", label: "주요 사건" },
            { value: "all", label: "전체" },
          ]}
        />
        <span className="text-[12px] text-mute tabular-nums">
          {shown.length} / {trace.length}건
        </span>
      </div>
      <ol aria-label="Trace 사건" className="space-y-2">
        {shown.map((e) => {
          const t = eventText(e, plan);
          const tone = TONE[t?.tone ?? "info"];
          const run = [e.provider, e.model].filter(Boolean).join(" · ");
          const instructions = e.action === "review_retry" && typeof e.details.instructions === "string" ? e.details.instructions : "";
          const issues = e.action === "review_retry" && Array.isArray(e.details.issues) ? e.details.issues.map(String) : [];
          return (
            <li key={e.step} className={cn("rounded-xl border p-3", tone.box)}>
              <div className="flex items-start gap-2.5">
                <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full", tone.dot)}>
                  <Icon name={t?.icon ?? "circle"} className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[14px] font-bold">{actorLabel(plan, e.actor)}</span>
                    {t?.tags.map((tag) => <Tag key={tag} tag={tag} />)}
                    <time dateTime={e.at} className="ml-auto text-[12px] text-mute tabular-nums">
                      {formatTime(e.at)}
                    </time>
                  </div>
                  <p className="mt-0.5 text-[14px] leading-snug text-sub">{t?.text ?? e.action}</p>
                  {mode === "key" && instructions && (
                    <details className="mt-1 text-[13px]">
                      <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-brand select-none">수정 지시 보기</summary>
                      {issues.length > 0 && <p className="text-sub">지적: {issues.join(" · ")}</p>}
                      <p className="mt-0.5 leading-snug text-sub">{instructions}</p>
                    </details>
                  )}
                  {mode === "all" && (
                    <>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-mute">
                        <span className="tabular-nums">
                          <span className="sr-only">step </span>#{e.step}
                        </span>
                        <code className="rounded bg-fill px-1 font-mono text-sub">{e.action}</code>
                        <NodeStatusChip status={e.status} />
                        {run && <span className="font-mono">{run}</span>}
                        {e.latencyMs !== null && <span className="tabular-nums">{formatLatency(e.latencyMs)}</span>}
                      </p>
                      {Object.keys(e.details).length > 0 && <JsonDetails summary="details" value={e.details} />}
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
