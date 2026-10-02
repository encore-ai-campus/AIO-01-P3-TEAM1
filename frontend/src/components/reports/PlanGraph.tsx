// 실행 계획 그래프 (Execution Plan): step을 PC는 왼쪽→오른쪽, 모바일은 위→아래로 그린다.
// 병렬 step은 Worker 노드를 점선 묶음으로 쌓고, join step 앞에는 Join Guard 노드, Handoff는 점선 화살표로 대상 Worker에 잇는다.
// 노드 상태는 Trace에서 그 actor의 마지막 사건으로 정한다 (사건이 없으면 대기).
import { Fragment } from "react";
import type { ExecutionPlan, Handoff, PlanStep, TraceEvent, Worker } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatLatency } from "../../lib/format";
import { NODE_STATUS, forDetail, nodeView, type NodeStatus } from "../../lib/reports";
import { Icon } from "../Icon";
import { NodeStatusChip } from "./StatusChip";

type Role = "required" | "optional" | "handoff";

const ROLE: Record<Role, { label: string; cls: string }> = {
  required: { label: "필수", cls: "bg-ink text-white" },
  optional: { label: "선택", cls: "border border-line bg-card text-sub" },
  handoff: { label: "Handoff 대상", cls: "bg-warn-soft text-[#9a5b00]" },
};

function workerOf(plan: ExecutionPlan, id: string): Worker {
  return (
    plan.workers.find((w) => w.id === id) ?? { id, title: id, goal: "", provider: null, model: null, outputContract: "-" }
  );
}

const titles = (plan: ExecutionPlan, ids: string[]) => ids.map((id) => workerOf(plan, id).title).join(", ") || "-";

function WorkerNode({ worker, role, trace }: { worker: Worker; role: Role; trace: TraceEvent[] }) {
  const v = nodeView(trace, worker.id);
  // 실제 실행 정보가 있으면 그것을, 없으면 Registry 값을 보인다
  const provider = v.provider ?? worker.provider;
  const model = v.model ?? worker.model;
  return (
    <article
      aria-label={worker.title}
      className={cn(
        "rounded-xl border-2 bg-card p-3",
        NODE_STATUS[v.status].border,
        role === "handoff" && "border-dashed",
        v.status === "started" && "ring-4 ring-brand/15",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-[14px] leading-tight font-bold">{worker.title}</h4>
          <p className="truncate font-mono text-[11px] text-mute">{worker.id}</p>
        </div>
        <NodeStatusChip status={v.status} />
      </div>
      {worker.goal && <p className="mt-1.5 text-[12px] leading-snug text-sub">{worker.goal}</p>}
      <div className="mt-2">
        <span className={cn("inline-flex h-5 items-center rounded px-1.5 text-[11px] font-bold", ROLE[role].cls)}>{ROLE[role].label}</span>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5 text-[12px]">
        <dt className="text-mute">Provider</dt>
        <dd className="truncate font-medium">{provider || model ? [provider, model].filter(Boolean).join(" · ") : "미정"}</dd>
        <dt className="text-mute">출력 계약</dt>
        <dd className="truncate font-mono">{worker.outputContract}</dd>
        <dt className="text-mute">소요</dt>
        <dd className="font-medium tabular-nums">{formatLatency(v.latencyMs)}</dd>
      </dl>
    </article>
  );
}

/** 위→아래 점선 화살표 (Handoff). */
function DashedArrow() {
  return (
    <div aria-hidden="true" className="flex w-3 shrink-0 flex-col items-center">
      <div className="w-0 flex-1 border-l-2 border-dashed border-warn" />
      <svg viewBox="0 0 10 6" className="w-2.5 text-warn">
        <path d="M0 0l5 6 5-6z" fill="currentColor" />
      </svg>
    </div>
  );
}

function HandoffBranch({ h, plan, trace }: { h: Handoff; plan: ExecutionPlan; trace: TraceEvent[] }) {
  const guard = nodeView(trace, "handoff_guard", forDetail("to", h.to));
  const target = workerOf(plan, h.to);
  const inSteps = plan.steps.some((s) => s.workers.includes(h.to));
  return (
    <div className="mt-1 ml-3">
      <div className="flex gap-2">
        <DashedArrow />
        <div className="min-w-0 py-1.5 text-[12px] leading-snug">
          <p className="flex flex-wrap items-center gap-1 font-bold text-[#9a5b00]">
            Handoff · 책임 이전 {guard.status !== "waiting" && <NodeStatusChip status={guard.status} />}
          </p>
          <p className="text-sub">{h.responsibility}</p>
          <p className="text-mute">
            {workerOf(plan, h.from).title} → {target.title} · 최대 {h.maxHops} Hop
          </p>
        </div>
      </div>
      {inSteps ? (
        <p className="rounded-lg border-2 border-dashed border-warn px-3 py-2 text-[12px] font-semibold">{target.title} (다른 단계의 노드)</p>
      ) : (
        <WorkerNode worker={target} role="handoff" trace={trace} />
      )}
    </div>
  );
}

function StepBox({ step, plan, trace, current }: { step: PlanStep; plan: ExecutionPlan; trace: TraceEvent[]; current: boolean }) {
  const parallel = step.mode === "parallel";
  return (
    <section
      aria-label={`단계 ${step.title}`}
      className={cn(
        "h-full rounded-2xl border p-3",
        current ? "border-brand bg-brand-soft/50 ring-2 ring-brand/30" : "border-line bg-fill/60",
      )}
    >
      <header className="mb-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-[15px] font-bold">{step.title}</h3>
          <span
            className={cn(
              "inline-flex h-5 items-center gap-0.5 rounded px-1.5 text-[11px] font-bold",
              parallel ? "bg-brand text-white" : "bg-card text-sub",
            )}
          >
            {parallel ? "병렬" : "순차"}
          </span>
          {current && <span className="inline-flex h-5 items-center rounded bg-ink px-1.5 text-[11px] font-bold text-white">현재 단계</span>}
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-mute">
          {step.id}
          {step.timeoutSec ? ` · 제한 ${step.timeoutSec}초` : ""}
        </p>
      </header>
      <ul className={cn("space-y-2", parallel && "border-l-2 border-dashed border-brand/60 pl-2.5")}>
        {step.workers.map((id) => (
          <li key={id}>
            <WorkerNode worker={workerOf(plan, id)} role={step.optional.includes(id) ? "optional" : "required"} trace={trace} />
            {plan.handoffs
              .filter((h) => h.from === id)
              .map((h) => (
                <HandoffBranch key={h.to} h={h} plan={plan} trace={trace} />
              ))}
          </li>
        ))}
      </ul>
      {parallel && <p className="mt-2 text-[12px] leading-snug text-mute">동시에 시작합니다. 완료 순서는 시작 순서와 다를 수 있습니다.</p>}
    </section>
  );
}

function JoinNode({ step, plan, trace }: { step: PlanStep; plan: ExecutionPlan; trace: TraceEvent[] }) {
  const v = nodeView(trace, "join_guard", forDetail("step", step.id));
  const prev = plan.steps.filter((s) => step.dependsOn.includes(s.id));
  const optional = prev.flatMap((s) => s.optional);
  return (
    <section aria-label="Join Guard" className={cn("h-full rounded-2xl border-2 border-dashed bg-card p-3", NODE_STATUS[v.status].border)}>
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h3 className="flex items-center gap-1 text-[15px] font-bold">
          <Icon name="shield" className="size-4" />
          Join Guard
        </h3>
        <NodeStatusChip status={v.status} />
      </div>
      <p className="mt-1.5 text-[12px] leading-snug text-sub">
        병렬 완료만으로 Join하지 않습니다. 필수 결과와 계약을 확인한 뒤 &lsquo;{step.title}&rsquo;을 실행합니다.
      </p>
      <dl className="mt-2 space-y-1 text-[12px] leading-snug">
        <div>
          <dt className="text-mute">필수 결과 확인</dt>
          <dd className="font-medium">{titles(plan, prev.flatMap((s) => s.required))}</dd>
        </div>
        {optional.length > 0 && (
          <div>
            <dt className="text-mute">선택 (실패하면 제외)</dt>
            <dd className="font-medium">{titles(plan, optional)}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

function Arrow() {
  return (
    <li aria-hidden="true" className="flex items-center justify-center py-1 text-mute lg:px-0.5 lg:py-0">
      <span className="flex flex-col items-center lg:flex-row">
        <span className="h-3 w-0.5 bg-line lg:h-0.5 lg:w-3" />
        <Icon name="chevron" className="-mt-1.5 size-5 rotate-90 lg:mt-0 lg:-ml-2 lg:rotate-0" />
      </span>
    </li>
  );
}

const LEGEND: NodeStatus[] = ["waiting", "started", "completed", "failed", "blocked", "skipped"];

export function PlanGraph({ plan, trace, currentStep }: { plan: ExecutionPlan; trace: TraceEvent[]; currentStep: string | null }) {
  const cols = plan.steps.flatMap((step) =>
    step.join ? [{ kind: "join" as const, step }, { kind: "step" as const, step }] : [{ kind: "step" as const, step }],
  );
  return (
    <div>
      <ol aria-label="실행 계획 그래프" className="flex flex-col lg:flex-row lg:items-stretch lg:overflow-x-auto lg:pb-2">
        {cols.map((c, i) => (
          <Fragment key={`${c.kind}-${c.step.id}`}>
            {i > 0 && <Arrow />}
            <li className={cn("min-w-0", c.kind === "join" ? "lg:w-[160px] lg:shrink-0" : "lg:min-w-[200px] lg:flex-1")}>
              {c.kind === "join" ? (
                <JoinNode step={c.step} plan={plan} trace={trace} />
              ) : (
                <StepBox step={c.step} plan={plan} trace={trace} current={currentStep === c.step.id} />
              )}
            </li>
          </Fragment>
        ))}
      </ol>
      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12px] text-sub">
        <span className="font-semibold text-mute">범례</span>
        {LEGEND.map((s) => (
          <NodeStatusChip key={s} status={s} />
        ))}
        <span className="flex items-center gap-1">
          <Icon name="chevron" className="size-4" /> 순차 진행
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-3 w-4 rounded-sm border-l-2 border-dashed border-brand/60" /> 병렬 묶음
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0 w-5 border-t-2 border-dashed border-warn" /> Handoff (책임 이전)
        </span>
      </div>
    </div>
  );
}
