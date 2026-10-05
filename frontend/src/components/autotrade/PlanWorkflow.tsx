// 자동매매 워크플로우 그래프 (활성화 → 리스크 점검 → 진입 주문 → 체결 대기 → 보유 감시 → 청산)와 사건 타임라인.
// 쉬운 보기는 단계 넷(EasySteps: 주문 → 사는 가격 기다리는 중 → 목표·손절 지켜보는 중 → 팔았어요)과
// 화면이 kind + details로 만든 쉬운 문장(lib/plainText.ts planEventSentence)을 보인다. 서버의 원래 message는 전문가 보기.
// 움직임: 단계가 넘어가는 순간만 — 노드 색 전이, 새로 끝난 단계의 체크가 한 번 튀고, 연결선이 왼쪽부터 찬다.
// 아무 일 없는 대기 중(며칠 갈 수 있다)에는 아무것도 움직이지 않는다 (trade-09). 새 사건만 아래에서 올라온다(.is-new).
import { type ReactNode, useState } from "react";
import type { Currency, PlanEvent } from "../../api/types";
import { useNewKeys } from "../../hooks/useMotionState";
import { type EasyStep, eventKindOf, type Outcome, type StepState, type Workflow } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatDateTime, formatSignedKrw, trendClass } from "../../lib/format";
import { planEventSentence } from "../../lib/plainText";
import { Icon, type IconName } from "../Icon";

const STATE: Record<StepState, { label: string; node: string; icon: IconName; text: string }> = {
  done: { label: "완료", node: "bg-brand text-white", icon: "check", text: "text-ink" },
  current: { label: "진행 중", node: "bg-card text-brand ring-2 ring-brand", icon: "clock", text: "text-brand-ink font-bold" },
  stopped: { label: "멈춤", node: "bg-up-soft text-up ring-2 ring-up/50", icon: "ban", text: "text-up-ink font-bold" },
  todo: { label: "대기", node: "bg-fill text-mute-weak", icon: "circle", text: "text-mute" },
  skipped: { label: "건너뜀", node: "bg-fill text-mute-weak", icon: "skip", text: "text-mute line-through" },
};

const NODE = "relative z-10 grid size-9 place-items-center rounded-full transition-[background-color,color,box-shadow] duration-base ease-standard";

/**
 * 처음 그린 뒤 상태가 바뀐 단계만 true (그 아이콘만 한 번 튄다 — 폴링으로 같은 상태가 다시 와도 움직이지 않는다).
 * celebrate(방금 시작해서 온 화면)면 처음부터 끝난 단계도 한 번 튄다 — 배너 없이 시작된 순간을 보인다 (trade-10).
 */
function usePopped(states: StepState[], celebrate: boolean): (i: number) => boolean {
  const [initial] = useState(() => states.map((s) => (celebrate && s === "done" ? null : s)));
  return (i) => states[i] !== initial[i];
}

/** 노드 아이콘: 상태가 바뀌면 key가 바뀌어 다시 그려지고, 바뀐 단계면 pop-in(160ms) 한 번. */
function NodeIcon({ state, popped }: { state: StepState; popped: boolean }) {
  return (
    <span key={state} className={cn("grid place-items-center", popped && "animate-pop-in")}>
      <Icon name={STATE[state].icon} className="size-4" />
    </span>
  );
}

/** 앞 단계와 잇는 선: 회색 바탕 위에 파란 선이 왼쪽부터 차오른다 (첫 렌더는 이미 찬 채로 — transition은 바뀔 때만 돈다). */
function Connector({ filled, className }: { filled: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={cn("absolute top-[17px] -left-1/2 h-0.5 w-full overflow-hidden bg-line", className)}>
      <span className="absolute inset-0 origin-left bg-brand transition-[scale] duration-base ease-standard" style={{ scale: filled ? "1 1" : "0 1" }} />
    </span>
  );
}

const OUTCOME_CLS = { done: "bg-fill text-ink", neutral: "bg-fill text-sub", error: "bg-up-soft text-up-ink" } as const;
const OUTCOME_ICON: Record<Outcome["tone"], IconName> = { done: "check-circle", neutral: "ban", error: "alert" };

/**
 * 끝난 계획의 결과 상자 (role=note). 끝까지 진행한 계획(done)은 손익과 무관하게 중립 상자 + 초록 체크(과정이 끝났다는 뜻)이고,
 * 손익 숫자만 이익·손실 색으로 칠한다 — 손실을 초록 상자에 담지 않는다 (trade-23).
 */
export function OutcomeNote({ tone, children, className }: { tone: Outcome["tone"]; children: ReactNode; className?: string }) {
  return (
    <p role="note" className={cn("flex items-start gap-2 rounded-xl px-3.5 py-3 text-[14px] leading-snug", OUTCOME_CLS[tone], className)}>
      <Icon name={OUTCOME_ICON[tone]} className={cn("mt-0.5 size-4 shrink-0", tone === "done" && "text-ok")} />
      <span>{children}</span>
    </p>
  );
}

/** 손익 숫자 (이익 빨강·손실 파랑). */
export function Pnl({ value }: { value: number | null | undefined }) {
  return <b className={cn("font-bold tabular-nums", trendClass(value))}>{formatSignedKrw(value)}</b>;
}

export function WorkflowGraph({ wf, celebrate = false }: { wf: Workflow; celebrate?: boolean }) {
  const popped = usePopped(
    wf.steps.map((s) => s.state),
    celebrate,
  );
  return (
    // 칸 수는 화면이 아니라 이 그래프의 폭으로 정한다: PC 1024px의 좁은 왼쪽 열(약 300px)에서 6칸으로 쪼개면
    // '리스크 점검'·'보유 감시 대기'가 두세 줄로 깨진다 (trade-03과 같은 이유). 448px 이상일 때만 한 줄 6칸
    <div className="@container">
      <ol aria-label="자동매매 단계" className="grid grid-cols-3 gap-x-1 gap-y-4 @md:grid-cols-6">
        {wf.steps.map((s, i) => {
          const st = STATE[s.state];
          return (
            <li
              key={s.key}
              aria-current={s.state === "current" ? "step" : undefined}
              className="relative flex flex-col items-center text-center"
              title={s.hint}
            >
              {/* 좁으면 3칸씩 두 줄: 줄 첫 칸(i % 3 === 0)은 앞 줄 끝과 잇지 않는다 */}
              {i > 0 && (
                <Connector
                  filled={s.state === "done" || s.state === "current" || s.state === "stopped"}
                  className={i % 3 === 0 ? "hidden @md:block" : undefined}
                />
              )}
              <span className={cn(NODE, st.node)}>
                <NodeIcon state={s.state} popped={popped(i)} />
              </span>
              <span className={cn("mt-1.5 text-[13px] leading-tight transition-colors duration-base", st.text)}>{s.label}</span>
              <span className="text-[11px] text-mute">
                {st.label}
                {s.key === "wait" && wf.requeues > 0 ? ` · 재주문 ${wf.requeues}회` : ""}
              </span>
            </li>
          );
        })}
      </ol>
      {wf.outcome && (
        <OutcomeNote tone={wf.outcome.tone} className="mt-4">
          <b>{wf.outcome.title}</b> ·{" "}
          {wf.outcome.pnlKrw != null ? (
            <>
              손익 <Pnl value={wf.outcome.pnlKrw} />
            </>
          ) : (
            wf.outcome.text
          )}
        </OutcomeNote>
      )}
    </div>
  );
}

/** 쉬운 보기의 단계 넷 (지금 단계는 aria-current="step"). 끝난 단계는 과거형 이름(lib/autotrade easySteps). */
export function EasySteps({ steps, celebrate = false }: { steps: EasyStep[]; celebrate?: boolean }) {
  const popped = usePopped(
    steps.map((s) => s.state),
    celebrate,
  );
  return (
    <ol aria-label="모의 자동매매 단계" className="grid grid-cols-4 gap-1">
      {steps.map((s, i) => {
        const st = STATE[s.state];
        return (
          <li key={s.key} aria-current={s.state === "current" ? "step" : undefined} className="relative flex flex-col items-center text-center">
            {i > 0 && <Connector filled={s.state !== "todo" && s.state !== "skipped"} />}
            <span className={cn(NODE, st.node)}>
              <NodeIcon state={s.state} popped={popped(i)} />
            </span>
            <span className={cn("mt-1.5 text-[13px] leading-tight transition-colors duration-base", st.text)}>{s.label}</span>
            <span className="sr-only">{st.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * 계획 사건 타임라인 (step 오름차순). 모르는 kind도 메시지를 그대로 보인다.
 * easy면 쉬운 문장(planEventSentence — details가 모자라면 원래 message), 아니면 서버의 원래 message와 사건 번호(#step).
 * 화면을 연 뒤 새로 붙은 사건만 아래에서 올라온다 (처음 그린 사건은 움직이지 않는다).
 */
export function PlanTimeline({ events, easy = false, currency = "KRW" }: { events: PlanEvent[]; easy?: boolean; currency?: Currency }) {
  const sorted = [...events].sort((a, b) => a.step - b.step);
  const fresh = useNewKeys(sorted.map((e) => e.step));
  if (events.length === 0) return <p className="text-[14px] text-mute">{easy ? "아직 일어난 일이 없어요." : "아직 사건이 없습니다."}</p>;
  return (
    <ol aria-label="계획 사건" className="relative space-y-3 before:absolute before:top-2 before:bottom-2 before:left-[13px] before:w-0.5 before:bg-line">
      {sorted.map((e) => {
        const k = eventKindOf(e.kind);
        return (
          <li key={e.step} className={cn("relative flex gap-3", fresh.has(e.step) && "is-new")}>
            <span className={cn("relative z-10 grid size-7 shrink-0 place-items-center rounded-full", k.cls)}>
              <Icon name={k.icon} className="size-3.5" />
            </span>
            <div className="min-w-0 pt-0.5">
              <p className="text-[14px] leading-snug">
                {!easy && <span className="mr-1.5 text-[12px] font-bold text-sub">{k.label}</span>}
                {easy ? planEventSentence(e, currency) : e.message}
              </p>
              <p className="text-[12px] text-mute tabular-nums">
                {easy ? formatDateTime(e.at) : `#${e.step} · ${formatDateTime(e.at)}`}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
