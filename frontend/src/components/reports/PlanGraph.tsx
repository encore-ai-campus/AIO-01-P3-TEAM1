// 작업 계획(Planner) 그래프 (Execution Plan): step을 PC는 왼쪽→오른쪽, 모바일은 위→아래로 그린다.
// 병렬 step은 Worker 노드를 점선 묶음으로 쌓고, join step 앞에는 Join Guard 노드, Handoff는 점선 화살표로 대상 Worker에 잇는다.
// 노드 상태는 Trace에서 그 actor의 마지막 사건으로 정한다 (사건이 없으면 대기).
// 상태가 바뀌는 순간: 테두리·강조 고리·바탕이 240ms로 바뀌고 상태 칩이 한 번 작게 나타난다 (처음 그릴 때는 움직이지 않는다 — 실시간 변화를 보여 주는 화면).
// 색은 토큰만 (반전 칩은 text-on-ink, 주황 글자는 warn-ink — 다크에서도 읽히게). 카드 안 상자는 카드보다 작은 모서리(rounded-xl).
import { Fragment } from "react";
import type { ExecutionPlan, Handoff, PlanStep, TraceEvent, Worker } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatLatency } from "../../lib/format";
import { attemptHistory, isCallFailure, reviewRounds } from "../../lib/recovery";
import { useChanged } from "../../hooks/useMotionState";
import { ERROR_LABEL, NODE_STATUS, forDetail, nodeView, type NodeStatus } from "../../lib/reports";
import { Icon } from "../Icon";
import { LiveDot } from "../ui";
import { InjectedBadge, NodeStatusChip, RecoveredBadge } from "./StatusChip";

type Role = "required" | "optional" | "handoff";

const ROLE: Record<Role, { label: string; cls: string }> = {
  required: { label: "필수", cls: "bg-ink text-on-ink" },
  optional: { label: "선택", cls: "border border-line bg-card text-sub" },
  handoff: { label: "Handoff 대상", cls: "bg-warn-soft text-warn-ink" },
};

function workerOf(plan: ExecutionPlan, id: string): Worker {
  return (
    plan.workers.find((w) => w.id === id) ??
    { id, title: id, goal: "", provider: null, model: null, fallbacks: [], outputContract: "-" }
  );
}

const titles = (plan: ExecutionPlan, ids: string[]) => ids.map((id) => workerOf(plan, id).title).join(", ") || "-";

/** 시도 이력 칩 한 줄: 모델 A ✕ 시간 초과 → 모델 A ✕ → 모델 B ✓. */
function Attempts({ worker, trace }: { worker: Worker; trace: TraceEvent[] }) {
  const h = attemptHistory(trace, worker.id);
  const chipCls = "inline-flex h-6 max-w-full items-center gap-1 rounded-md px-1.5 text-[12px] font-semibold";
  const name = (m: string | null) => (
    <span className="max-w-[9rem] truncate" title={m ?? undefined}>
      {m ?? "모델"}
    </span>
  );
  const sep = (
    <li aria-hidden="true" className="text-mute">
      →
    </li>
  );

  if (h.attempts.length === 0) {
    // 실행 전(계획 미리 보기): 주 모델 → 대체 모델 순서를 옅게
    const planned = [worker.model, ...(worker.fallbacks ?? [])].filter((m): m is string => Boolean(m));
    if (planned.length === 0) return null;
    return (
      <ol aria-label="모델 순서" className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px]">
        {planned.map((m, i) => (
          <Fragment key={`${m}-${i}`}>
            {i > 0 && sep}
            <li className={cn(chipCls, "bg-fill text-sub")}>{name(m)}</li>
          </Fragment>
        ))}
      </ol>
    );
  }

  // 실패 뒤 아직 답을 기다리는 중이면 지금 부르는 모델을 끝에 붙인다
  const mine = trace.filter((e) => e.actor === worker.id);
  const pending = !h.finalModel && !h.gaveUp;
  const last = mine[mine.length - 1];
  const pendingModel = last?.action === "agent_failover" && typeof last.details.to === "string" ? last.details.to : h.attempts[h.attempts.length - 1].model;
  return (
    <ol aria-label="시도 이력" className="mt-1.5 flex flex-wrap items-center gap-1 text-[12px]">
      {h.attempts.map((a, i) => (
        <Fragment key={i}>
          {i > 0 && sep}
          <li className={cn(chipCls, a.outcome === "ok" ? "bg-ok-soft text-ok-ink" : "bg-up-soft text-up-ink")}>
            {name(a.model)}
            <Icon name={a.outcome === "ok" ? "check" : "close"} className="size-3.5 shrink-0" />
            <span className="shrink-0">{a.outcome === "ok" ? "성공" : ERROR_LABEL[a.outcome]}</span>
          </li>
        </Fragment>
      ))}
      {pending && (
        <>
          {sep}
          <li className={cn(chipCls, "bg-brand-soft text-brand-ink")}>
            {name(pendingModel)}
            {/* 오래 이어질 수 있는 '시도 중'은 도는 아이콘 대신 살아 있음 점 */}
            <LiveDot className="mx-0.5" />
            <span className="shrink-0">시도 중</span>
          </li>
        </>
      )}
    </ol>
  );
}

/** 압축 노드: 제목 + 상태 + 시도 이력 + 배지. 나머지(목표·역할·Provider·출력 계약·소요)는 "자세히"를 누르면 펼친다. */
function WorkerNode({ worker, role, trace }: { worker: Worker; role: Role; trace: TraceEvent[] }) {
  const v = nodeView(trace, worker.id);
  const h = attemptHistory(trace, worker.id);
  // 호출 한 번의 실패는 노드의 실패가 아니다 (재시도·전환으로 이어진다)
  const mine = trace.filter((e) => e.actor === worker.id);
  const recovering = mine.length > 0 && isCallFailure(mine[mine.length - 1]);
  const status: NodeStatus = recovering ? "started" : v.status;
  // 실제 실행 정보가 있으면 그것을, 없으면 Registry 값을 보인다
  const provider = v.provider ?? worker.provider;
  const model = v.model ?? worker.model;
  // 이 화면에서 상태가 바뀐 뒤에만 칩이 한 번 작게 나타난다 (예시 재생·SSE로 바뀌는 순간을 눈이 따라가게)
  const changed = useChanged(status);
  return (
    <article
      aria-label={worker.title}
      className={cn(
        "rounded-xl border-2 bg-card p-2.5 transition-[border-color,box-shadow,background-color] duration-base ease-standard",
        NODE_STATUS[status].border,
        role === "handoff" && "border-dashed",
        status === "started" && "ring-4 ring-brand/15",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="min-w-0 text-[14px] leading-tight font-bold">{worker.title}</h4>
        <NodeStatusChip key={status} status={status} className={changed ? "animate-pop-in" : undefined} />
      </div>
      <Attempts worker={worker} trace={trace} />
      {(h.recovered || h.injected) && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {h.recovered && <RecoveredBadge />}
          {h.injected && <InjectedBadge />}
        </div>
      )}
      <details className="group/node mt-1 text-[12px]">
        {/* 보이는 높이는 32px, 누르는 곳은 위아래 6px씩 넓혀 44px (노드 카드가 길어지지 않게) */}
        <summary className="relative -ml-1 inline-flex min-h-8 cursor-pointer list-none items-center gap-0.5 rounded-md px-1 text-mute select-none before:absolute before:inset-x-0 before:-inset-y-1.5 hover:bg-fill">
          자세히
          <Icon name="chevron-down" className="size-3.5 transition-transform duration-fast group-open/node:rotate-180" />
        </summary>
        <p className="font-mono text-[11px] text-mute">{worker.id}</p>
        {worker.goal && <p className="mt-1 leading-snug text-sub">{worker.goal}</p>}
        <div className="mt-1.5">
          <span className={cn("inline-flex h-5 items-center rounded px-1.5 text-[11px] font-bold", ROLE[role].cls)}>{ROLE[role].label}</span>
        </div>
        <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-0.5">
          <dt className="text-mute">Provider</dt>
          <dd className="truncate font-medium">{provider || model ? [provider, model].filter(Boolean).join(" · ") : "미정"}</dd>
          {worker.fallbacks && worker.fallbacks.length > 0 && (
            <>
              <dt className="text-mute">대체 모델</dt>
              <dd className="truncate font-medium">{worker.fallbacks.join(" → ")}</dd>
            </>
          )}
          <dt className="text-mute">출력 계약</dt>
          <dd className="truncate font-mono">{worker.outputContract}</dd>
          <dt className="text-mute">소요</dt>
          <dd className="font-medium tabular-nums">{formatLatency(v.latencyMs)}</dd>
        </dl>
      </details>
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
          <p className="flex flex-wrap items-center gap-1 font-bold text-warn-ink">
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
  // 검토 RETRY로 이 단계의 Worker를 다시 실행한 횟수
  const rounds = reviewRounds(trace).filter((r) => step.workers.includes(r.target)).length;
  const maxRounds = plan.steps.find((s) => s.retry && step.workers.includes(s.retry.target))?.retry?.maxRounds;
  return (
    <section
      aria-label={`단계 ${step.title}`}
      className={cn(
        "h-full rounded-xl border p-3 transition-[border-color,box-shadow,background-color] duration-base ease-standard",
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
          {current && <span className="inline-flex h-5 items-center rounded bg-ink px-1.5 text-[11px] font-bold text-on-ink">현재 단계</span>}
          {rounds > 0 && (
            <span className="inline-flex h-5 items-center gap-0.5 rounded bg-warn-soft px-1.5 text-[11px] font-bold text-warn-ink">
              <Icon name="restart" className="size-3" />
              검토 뒤 다시 작성 {rounds}
              {maxRounds ? `/${maxRounds}` : ""}회
            </span>
          )}
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
  const changed = useChanged(v.status);
  const prev = plan.steps.filter((s) => step.dependsOn.includes(s.id));
  const optional = prev.flatMap((s) => s.optional);
  return (
    <section
      aria-label="Join Guard"
      className={cn(
        "h-full rounded-xl border-2 border-dashed bg-card p-3 transition-[border-color,box-shadow,background-color] duration-base ease-standard",
        NODE_STATUS[v.status].border,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <h3 className="flex items-center gap-1 text-[15px] font-bold">
          <Icon name="shield" className="size-4" />
          Join Guard
        </h3>
        <NodeStatusChip key={v.status} status={v.status} className={changed ? "animate-pop-in" : undefined} />
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
      <ol aria-label="작업 계획 그래프" className="flex flex-col lg:flex-row lg:items-stretch lg:overflow-x-auto lg:pb-2">
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
        <span className="font-semibold text-sub">범례</span>
        {LEGEND.map((s) => (
          <NodeStatusChip key={s} status={s} live={false} />
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
