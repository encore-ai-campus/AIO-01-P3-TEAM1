// 실행 요약 띠: 탭과 무관하게 머리 카드 아래에 항상 보인다. 장애·복구 수치는 Trace에서 센다 (src/lib/recovery.ts).
// 수치가 바뀌는 순간(ui.tsx Flash): 장애가 늘면 빨간 배경, 자동 복구가 늘면 초록 배경이 잠깐 깜빡이고, 복구 시간·비용은 새 값이 짧게 페이드한다
// — 숫자를 세어 올리지 않는다. (포기 수만 바뀐 것은 초록으로 깜빡이지 않는다: 복구가 아니므로)
// 실패한 실행에는 '장애 없음'을 붙이지 않는다 (실패인데 초록 문구가 나오지 않게). '리포트 완성 · 보기'는 보는 중에 완성됐을 때만 나타난다.
import type { ExecutionPlan, SharedState, TraceEvent } from "../../api/types";
import { useChanged } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatLatency } from "../../lib/format";
import { summarize } from "../../lib/recovery";
import { actorLabel, formatCost } from "../../lib/reports";
import { Icon } from "../Icon";
import { Card, Flash, type FlashTone } from "../ui";
import { ExampleTag } from "./StatusChip";

function traceCost(trace: TraceEvent[]): number | null {
  const costs = trace.filter((e) => e.action === "agent_completed").map((e) => e.details.costUsd);
  const nums = costs.filter((c): c is number => typeof c === "number");
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null;
}

/**
 * 값 한 칸. tone은 글자색(장애 있음 = 빨강 글자, 복구 있음 = 초록 글자).
 * flash를 주면 그 수가 바뀔 때 Flash로 깜빡인다 (장애 수 = trend: 늘면 빨강, 자동 복구 수 = ok: 늘 때만 초록 — 예시 재생을 끄고 실제 Trace로 돌아가 수가 줄 때는 깜빡이지 않는다) — 그 수가 그대로인 변화(포기 수 등)는
 * 알리지 않는다. flash가 없는 칸은 값이 바뀌면(첫 렌더 제외) 짧게 페이드한다.
 */
function Stat({ label, value, tone, flash }: { label: string; value: string; tone?: "fail" | "ok"; flash?: { count: number; tone: FlashTone } }) {
  const changed = useChanged(value);
  return (
    <div className="min-w-0 rounded-xl bg-fill px-3 py-2">
      <dt className="text-[12px] text-mute">{label}</dt>
      <dd className={cn("text-[17px] font-bold tabular-nums", tone === "fail" ? "text-up-ink" : tone === "ok" ? "text-ok-ink" : "text-ink")}>
        {flash ? (
          <Flash value={flash.count} tone={flash.tone} className="block truncate">
            {value}
          </Flash>
        ) : (
          <span key={value} className={cn("-mx-1 block truncate rounded-md px-1", changed && "reveal-fade")}>
            {value}
          </span>
        )}
      </dd>
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
  showLabel = "리포트 완성 · 보기",
}: {
  plan: ExecutionPlan;
  trace: TraceEvent[];
  state: SharedState;
  costUsd: number | null | undefined;
  example: boolean;
  onShowReport?: () => void; // 완성됐고 다른 탭을 보고 있을 때만
  showLabel?: string; // 그 버튼 글자 (선정 실행은 "선정 완료 · 보기")
}) {
  const s = summarize(trace);
  const step = plan.steps.find((x) => x.id === state.currentStep);
  const cost = example ? traceCost(trace) : (costUsd ?? traceCost(trace));
  const models = Object.entries(s.models);
  const failed = state.status === "failed";
  const headline =
    state.status === "running"
      ? `실행 중${step ? ` · ${step.title} 단계` : ""}`
      : state.status === "completed"
        ? "실행 완료"
        : failed
          ? "실행 실패"
          : "실행 전";
  // '리포트 완성 · 보기'가 이 화면에서 새로 나타날 때만 올라오며 나타난다
  const showChanged = useChanged(Boolean(onShowReport));

  return (
    <Card aria-label="실행 요약" className="py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex flex-wrap items-center gap-1.5 text-[15px] font-bold">
          {headline}
          {example && <ExampleTag />}
          {trace.length > 0 && s.failures === 0 && !failed && <span className="text-[13px] font-semibold text-ok-ink">· 장애 없음</span>}
        </p>
        {onShowReport && (
          <button
            type="button"
            onClick={onShowReport}
            className={cn(
              "press flex h-10 items-center gap-1 rounded-xl bg-brand px-3.5 text-[14px] font-semibold text-white hover:bg-brand-dark",
              showChanged && "animate-rise-in",
            )}
          >
            <Icon name="doc" className="size-4" />
            {showLabel}
          </button>
        )}
      </div>
      {trace.length === 0 ? (
        <p className="mt-1 text-[13px] text-mute">아직 실행 사건이 없습니다. 실행되면 장애·자동 복구·복구 시간·비용이 여기에 나옵니다.</p>
      ) : (
        <>
          <dl className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat
              label="장애"
              value={`${s.failures}건${s.injected > 0 ? ` (주입 ${s.injected})` : ""}`}
              tone={s.failures > 0 ? "fail" : undefined}
              flash={{ count: s.failures, tone: "trend" }}
            />
            <Stat
              label="자동 복구"
              value={`${s.recovered}건${s.unrecovered > 0 ? ` · 포기 ${s.unrecovered}` : ""}`}
              tone={s.recovered > 0 ? "ok" : undefined}
              flash={{ count: s.recovered, tone: "ok" }}
            />
            <Stat label="복구 시간" value={formatLatency(s.recoveryMs)} />
            <Stat label="비용" value={cost === null ? "-" : formatCost(cost)} />
          </dl>
          {models.length > 0 && (
            <details className="group/models mt-2 text-[13px]">
              {/* 보이는 높이는 36px, 누르는 곳은 위아래 4px씩 넓혀 44px */}
              <summary className="relative -ml-1 inline-flex min-h-9 cursor-pointer list-none items-center gap-0.5 rounded-md px-1 font-semibold text-brand-ink select-none before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-fill">
                최종적으로 답한 모델
                <Icon name="chevron-down" className="size-4 transition-transform duration-fast group-open/models:rotate-180" />
              </summary>
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
