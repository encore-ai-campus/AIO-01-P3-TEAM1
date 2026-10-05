// 정책 안내: 부분 실패 정책 셋과 이 팀의 정책, Handoff 계약과 Guard, 함수 호출과 Handoff의 차이 (docs/교육용문서.md 그대로).
// 색은 토큰만 (이 팀의 정책 강조는 brand-ink, Guard 확인 항목은 warn-ink — 다크에서도 읽히게).
import type { ExecutionPlan } from "../../api/types";
import { cn } from "../../lib/cn";
import { HANDOFF_FIELDS, HANDOFF_GUARD_CHECKS, POLICIES, actorLabel } from "../../lib/reports";

export function PolicyGuide({ plan }: { plan: ExecutionPlan }) {
  const required = plan.steps.flatMap((s) => s.required);
  const optional = plan.steps.flatMap((s) => s.optional);
  const names = (ids: string[]) => ids.map((id) => actorLabel(plan, id)).join(", ") || "없음";

  return (
    <div className="grid gap-5 lg:grid-cols-2 lg:gap-8">
      <div className="min-w-0">
        <h3 className="text-[16px] font-bold">부분 실패 정책</h3>
        <p className="mt-1 text-[14px] leading-relaxed text-sub">실패 정책은 실행 중 LLM이 즉석에서 정하지 않고 업무 요구사항으로 미리 정의합니다.</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left text-[14px]">
            <caption className="sr-only">부분 실패 정책 비교</caption>
            <thead>
              <tr className="border-b border-line text-[13px] text-mute">
                <th scope="col" className="py-2 pr-3 font-semibold">
                  정책
                </th>
                <th scope="col" className="py-2 font-semibold">
                  동작
                </th>
              </tr>
            </thead>
            <tbody>
              {POLICIES.map((p) => {
                const mine = p.value === plan.failurePolicy;
                return (
                  <tr
                    key={p.value}
                    aria-current={mine ? "true" : undefined}
                    className={cn("border-b border-line last:border-0", mine && "bg-brand-soft")}
                  >
                    <th scope="row" className={cn("py-2.5 pr-3 pl-2 font-semibold whitespace-nowrap", mine && "text-brand-ink")}>
                      {p.name}
                    </th>
                    <td className="py-2.5 pr-2">
                      {p.behavior}
                      {mine && <span className="ml-1.5 inline-flex h-5 items-center rounded bg-brand px-1.5 text-[11px] font-bold text-white">이 팀의 정책</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <dl className="mt-3 space-y-1 text-[14px]">
          <div className="flex gap-2">
            <dt className="shrink-0 font-semibold text-sub">필수</dt>
            <dd>{names(required)}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="shrink-0 font-semibold text-sub">선택</dt>
            <dd>{names(optional)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-[13px] leading-relaxed text-sub">
          앞 Agent가 실패하면 뒤 Agent는 실행하지 않습니다. 실패한 결과를 빈 Context나 고정된 성공 결과로 바꾸지 않습니다.
        </p>
      </div>

      <div className="min-w-0">
        <h3 className="text-[16px] font-bold">Handoff</h3>
        <p className="mt-1 text-[14px] leading-relaxed text-sub">함수 호출과 Handoff는 책임의 소유자가 다릅니다.</p>
        <pre className="mt-2 overflow-x-auto rounded-xl bg-fill p-3 font-mono text-[12px] leading-relaxed text-ink">
          {`함수 호출
Agent A → 계산 요청 → 결과 수신 → Agent A가 계속 책임

Handoff
Support Agent → 책임과 최소 Context 이전 → Refund Agent가 책임 인수`}
        </pre>
        <h4 className="mt-3 text-[14px] font-semibold text-sub">Handoff 계약 필드</h4>
        <ul aria-label="Handoff 계약 필드" className="mt-1 flex flex-wrap gap-1">
          {HANDOFF_FIELDS.map((f) => (
            <li key={f} className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[12px]">
              {f}
            </li>
          ))}
        </ul>
        <h4 className="mt-3 text-[14px] font-semibold text-sub">Guard가 확인하는 것</h4>
        <ul aria-label="Handoff Guard 확인 항목" className="mt-1 flex flex-wrap gap-1">
          {HANDOFF_GUARD_CHECKS.map((c) => (
            <li key={c} className="rounded-md bg-warn-soft px-1.5 py-0.5 text-[12px] font-semibold text-warn-ink">
              {c}
            </li>
          ))}
        </ul>
        <h4 className="mt-3 text-[14px] font-semibold text-sub">이 팀의 Handoff</h4>
        {plan.handoffs.length === 0 ? (
          <p className="mt-1 text-[14px] text-mute">없음</p>
        ) : (
          <ul className="mt-1 space-y-1.5 text-[14px]">
            {plan.handoffs.map((h) => (
              <li key={`${h.from}-${h.to}`}>
                <b>{actorLabel(plan, h.from)}</b> ⇢ <b>{actorLabel(plan, h.to)}</b>
                <span className="block text-[13px] text-sub">
                  {h.responsibility} · 최대 {h.maxHops} Hop
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[13px] leading-relaxed text-mute">Handoff에서는 결과가 아니라 업무 책임의 소유자가 바뀝니다.</p>
      </div>
    </div>
  );
}
