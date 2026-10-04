// 실행 요약 띠: 탭과 무관하게 머리 카드 아래에 항상 보인다. 장애·복구 수치는 Trace에서 센다 (src/lib/recovery.ts).
import type { ExecutionPlan, SharedState, TraceEvent } from "../../api/types";
import { formatLatency } from "../../lib/format";
import { summarize } from "../../lib/recovery";
import { actorLabel, formatCost } from "../../lib/reports";
import { Icon } from "../Icon";
import { Card } from "../ui";
import { ExampleTag } from "./StatusChip";

function traceCost(trace: TraceEvent[]): number | null {
  const costs = trace.filter((e) => e.action === "agent_completed").map((e) => e.details.costUsd);
  const nums = costs.filter((c): c is number => typeof c === "number");
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: "fail" | "ok" }) {
  return (
    <div className="min-w-0 rounded-xl bg-fill px-3 py-2">
      <dt className="text-[12px] text-mute">{label}</dt>
      <dd className={`truncate text-[17px] font-bold tabular-nums ${tone === "fail" ? "text-up" : tone === "ok" ? "text-ok" : "text-ink"}`}>{value}</dd>
    </div>
  );
}

export function RunSummary({
  plan,
  trace,
  state,
  costUsd,
  example,
  onShowReport,
}: {
  plan: ExecutionPlan;
  trace: TraceEvent[];
  state: SharedState;
  costUsd: number | null | undefined;
  example: boolean;
  onShowReport?: () => void; // 완성됐고 다른 탭을 보고 있을 때만
}) {
  const s = summarize(trace);
  const step = plan.steps.find((x) => x.id === state.currentStep);
  const cost = example ? traceCost(trace) : (costUsd ?? traceCost(trace));
  const models = Object.entries(s.models);
  const headline =
    state.status === "running"
      ? `실행 중${step ? ` · ${step.title} 단계` : ""}`
      : state.status === "completed"
        ? "실행 완료"
        : state.status === "failed"
          ? "실행 실패"
          : "실행 전";

  return (
    <Card aria-label="실행 요약" className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-1.5 text-[15px] font-bold">
          {headline}
          {example && <ExampleTag />}
          {trace.length > 0 && s.failures === 0 && <span className="text-[13px] font-semibold text-ok">· 장애 없음</span>}
        </p>
        {onShowReport && (
          <button type="button" onClick={onShowReport} className="flex h-9 items-center gap-1 rounded-xl bg-brand px-3 text-[14px] font-semibold text-white hover:bg-brand-dark">
            <Icon name="doc" className="size-4" />
            리포트 완성 · 보기
          </button>
        )}
      </div>
      {trace.length === 0 ? (
        <p className="mt-1 text-[13px] text-mute">아직 실행 사건이 없습니다. 실행되면 장애·자동 복구·복구 시간·비용이 여기에 나옵니다.</p>
      ) : (
        <>
          <dl className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="장애" value={`${s.failures}건${s.injected > 0 ? ` (주입 ${s.injected})` : ""}`} tone={s.failures > 0 ? "fail" : undefined} />
            <Stat label="자동 복구" value={`${s.recovered}건${s.unrecovered > 0 ? ` · 포기 ${s.unrecovered}` : ""}`} tone={s.recovered > 0 ? "ok" : undefined} />
            <Stat label="복구 시간" value={formatLatency(s.recoveryMs)} />
            <Stat label="비용" value={cost === null ? "-" : formatCost(cost)} />
          </dl>
          {models.length > 0 && (
            <details className="mt-2 text-[13px]">
              <summary className="inline-flex min-h-8 cursor-pointer items-center font-semibold text-brand select-none">최종적으로 답한 모델</summary>
              <ul aria-label="Worker별 최종 모델" className="mt-1 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                {models.map(([id, model]) => (
                  <li key={id} className="flex justify-between gap-2">
                    <span className="text-sub">{actorLabel(plan, id)}</span>
                    <span className="truncate font-mono text-[12px]">{model}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
