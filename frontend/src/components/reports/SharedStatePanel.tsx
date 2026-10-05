// Shared State 패널. Orchestrator만 State를 갱신한다 (Worker는 독립 결과만 돌려준다).
// 실패 표시는 오류 글자색(up-ink — 다크에서도 연빨강 바탕 위 4.5:1 이상).
import type { ReactNode } from "react";
import type { ExecutionPlan, SharedState } from "../../api/types";
import { actorLabel } from "../../lib/reports";
import { ReportStatusBadge } from "./StatusChip";
import { JsonDetails } from "./TraceTimeline";

function Item({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="border-b border-line py-2 last:border-0">
      <dt className="font-mono text-[12px] text-mute">{label}</dt>
      <dd className="mt-0.5 text-[14px]">{children}</dd>
    </div>
  );
}

function Agents({ ids, plan, cls }: { ids: string[]; plan: ExecutionPlan; cls: string }) {
  if (ids.length === 0) return <span className="text-mute">없음</span>;
  return (
    <ul className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <li key={id} className={`rounded-md px-1.5 py-0.5 text-[12px] font-semibold ${cls}`}>
          {actorLabel(plan, id)}
        </li>
      ))}
    </ul>
  );
}

export function SharedStatePanel({ state, plan }: { state: SharedState; plan: ExecutionPlan }) {
  const results = Object.entries(state.results);
  const errors = Object.entries(state.errors);
  const step = plan.steps.find((s) => s.id === state.currentStep);
  return (
    <div>
      <p className="mb-2 text-[13px] leading-snug text-sub">
        Orchestrator만 State를 갱신합니다. Worker는 Shared State를 직접 수정하지 않고 독립 결과만 반환하며, 계약을 통과한 결과만
        results와 completedAgents에 들어갑니다.
      </p>
      <dl>
        <Item label="taskId">
          <span className="font-mono">{state.taskId}</span>
        </Item>
        <Item label="status">
          <ReportStatusBadge status={state.status} />
        </Item>
        <Item label="currentStep">
          {state.currentStep ? (
            <>
              <span className="font-mono">{state.currentStep}</span>
              {step && <span className="text-sub"> ({step.title})</span>}
            </>
          ) : (
            <span className="text-mute">없음</span>
          )}
        </Item>
        <Item label="completedAgents">
          <Agents ids={state.completedAgents} plan={plan} cls="bg-ok-soft text-ok-ink" />
        </Item>
        <Item label="failedAgents">
          <Agents ids={state.failedAgents} plan={plan} cls="bg-up-soft text-up-ink" />
        </Item>
        <Item label="results">
          {results.length === 0 ? (
            <span className="text-mute">없음</span>
          ) : (
            <ul>
              {results.map(([k, v]) => (
                <li key={k}>
                  <JsonDetails summary={k} value={v} />
                </li>
              ))}
            </ul>
          )}
        </Item>
        <Item label="errors">
          {errors.length === 0 ? (
            <span className="text-mute">없음</span>
          ) : (
            <ul className="space-y-1">
              {errors.map(([k, v]) => (
                <li key={k} className="text-[13px]">
                  <span className="font-mono font-semibold text-up-ink">{k}</span> <span className="text-sub">{v}</span>
                </li>
              ))}
            </ul>
          )}
        </Item>
      </dl>
    </div>
  );
}
