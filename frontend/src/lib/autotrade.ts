// AI 추천 · 매매 계획 · 알림 화면의 표시 규칙 (라벨, 자동매매 워크플로우 단계 계산, 가격 사다리). 화면 없이 테스트한다.
import type { IconName } from "../components/Icon";
import type { PlanEvent, RecommendationSource, RiskLevel, TradePlan, TradePlanStatus } from "../api/types";

/** 추천 출처. demo는 늘 "시연용 · AI 아님"을 보인다 (docs/DECISIONS.md 12-1). */
export const SOURCE: Record<RecommendationSource, { label: string; chip: string; icon: IconName; hint: string }> = {
  report: { label: "AI 리포트", chip: "bg-brand-soft text-brand-dark", icon: "doc", hint: "AI 리포트 Agent 워크플로우의 결론" },
  analysis: { label: "AI 분석", chip: "bg-brand-soft text-brand-dark", icon: "sparkle", hint: "AI 교차검증 분석의 BUY 판정" },
  demo: { label: "시연용 · AI 아님", chip: "bg-warn-soft text-[#9a5b00]", icon: "chart", hint: "일봉 ATR로 목표·손절을 정한 규칙 기반 시연용 추천" },
};

export const RISK_LEVEL: Record<RiskLevel, { label: string; chip: string }> = {
  low: { label: "리스크 낮음", chip: "bg-ok-soft text-ok" },
  medium: { label: "리스크 보통", chip: "bg-warn-soft text-[#9a5b00]" },
  high: { label: "리스크 높음", chip: "bg-up-soft text-up" },
};

/** 계획 상태: 색 + 아이콘 + 글자. */
export const PLAN_STATUS: Record<TradePlanStatus, { label: string; chip: string; icon: IconName }> = {
  active: { label: "활성화됨", chip: "bg-brand-soft text-brand-dark", icon: "bolt" },
  entry_pending: { label: "체결 대기", chip: "bg-brand-soft text-brand-dark", icon: "clock" },
  holding: { label: "보유 중", chip: "bg-brand text-white", icon: "shield" },
  closed: { label: "청산 완료", chip: "bg-ok-soft text-ok", icon: "check" },
  cancelled: { label: "중단됨", chip: "bg-fill text-sub", icon: "ban" },
  expired: { label: "기한 만료", chip: "bg-fill text-sub", icon: "clock" },
  failed: { label: "실패", chip: "bg-up-soft text-up", icon: "alert" },
};

export const planStatusOf = (status: string) =>
  PLAN_STATUS[status as TradePlanStatus] ?? { label: status, chip: "bg-fill text-sub", icon: "circle" as IconName };

export const EXIT_REASON: Record<NonNullable<TradePlan["exitReason"]>, string> = {
  TARGET: "목표가 도달",
  STOP: "손절가 도달",
  EXPIRED: "보유 기한 만료",
  MANUAL: "직접 매도",
};

/** 계획 사건의 아이콘·색. 모르는 kind는 회색 점. */
export const EVENT_KIND: Record<string, { icon: IconName; cls: string; label: string }> = {
  activated: { icon: "bolt", cls: "bg-brand text-white", label: "활성화" },
  risk_checked: { icon: "shield", cls: "bg-brand-soft text-brand-dark", label: "리스크 점검" },
  order_placed: { icon: "doc", cls: "bg-brand-soft text-brand-dark", label: "주문 접수" },
  order_requeued: { icon: "restart", cls: "bg-warn-soft text-[#9a5b00]", label: "재주문" },
  filled: { icon: "check", cls: "bg-up-soft text-up", label: "체결" },
  exit_requested: { icon: "logout", cls: "bg-warn-soft text-[#9a5b00]", label: "매도 요청" },
  closed: { icon: "check", cls: "bg-ok-soft text-ok", label: "청산" },
  cancelled: { icon: "ban", cls: "bg-fill text-sub", label: "중단" },
  expired: { icon: "clock", cls: "bg-fill text-sub", label: "기한 만료" },
  failed: { icon: "alert", cls: "bg-up-soft text-up", label: "실패" },
};
export const eventKindOf = (kind: string) => EVENT_KIND[kind] ?? { icon: "circle" as IconName, cls: "bg-fill text-mute", label: kind };

// ---------------------------------------------------------------- 자동매매 워크플로우

export type StepKey = "activate" | "risk" | "order" | "wait" | "hold" | "exit";
export type StepState = "done" | "current" | "stopped" | "todo" | "skipped";

export interface WorkflowStep {
  key: StepKey;
  label: string;
  hint: string;
  state: StepState;
}

export interface Workflow {
  steps: WorkflowStep[];
  /** 끝난 상태면 결과 한 줄 (closed·cancelled·expired·failed). 진행 중이면 null. */
  outcome: { tone: "ok" | "neutral" | "error"; title: string; text: string } | null;
  /** 체결 대기 중 다시 주문한 횟수. */
  requeues: number;
}

const STEPS: { key: StepKey; label: string; hint: string }[] = [
  { key: "activate", label: "활성화", hint: "사용자가 계획을 켰다" },
  { key: "risk", label: "리스크 점검", hint: "리스크 엔진이 수량·한도를 정한다" },
  { key: "order", label: "진입 주문", hint: "진입가로 지정가 매수 주문" },
  { key: "wait", label: "체결 대기", hint: "체결되지 않으면 다음 정규장에 다시 주문" },
  { key: "hold", label: "보유 감시", hint: "목표가·손절가·보유 기한을 자동으로 본다" },
  { key: "exit", label: "청산", hint: "목표·손절·기한·직접 매도로 끝낸다" },
];

/** 사건 하나가 끝냈다는 것을 보여 주는 마지막 단계 번호 (STEPS 기준). */
const DONE_BY_EVENT: Record<string, number> = {
  activated: 0,
  risk_checked: 1,
  order_placed: 2,
  order_requeued: 2,
  filled: 3,
  exit_requested: 4,
  closed: 5,
};
/** 상태만으로 알 수 있는 최소 진행 (사건이 없을 때). */
const DONE_BY_STATUS: Partial<Record<TradePlanStatus, number>> = { active: 0, entry_pending: 2, holding: 3, closed: 5 };

/** 계획 상태와 사건으로 워크플로우 단계를 계산한다. 모르는 사건·상태가 와도 깨지지 않는다. */
export function planWorkflow(plan: Pick<TradePlan, "status" | "exitReason" | "failureReason" | "pnlKrw">, events: PlanEvent[] = []): Workflow {
  let done = DONE_BY_STATUS[plan.status] ?? 0;
  let riskRejected = false;
  let requeues = 0;
  for (const e of events) {
    const n = DONE_BY_EVENT[e.kind];
    if (n !== undefined) done = Math.max(done, n);
    if (e.kind === "order_requeued") requeues += 1;
    if (e.kind === "risk_checked" && e.details.approved === false) riskRejected = true;
  }
  const ended = plan.status === "cancelled" || plan.status === "expired" || plan.status === "failed";
  // 끝난 상태에서 멈춘 단계 (리스크 엔진이 거절했으면 리스크 점검에서 멈춘 것)
  let stopAt = Math.min(done + 1, STEPS.length - 1);
  if (riskRejected) stopAt = 1;
  if (plan.status === "expired") stopAt = 3;
  if (ended) done = Math.min(done, stopAt - 1);

  const steps = STEPS.map((s, i): WorkflowStep => {
    let state: StepState;
    if (plan.status === "closed") state = "done";
    else if (i <= done) state = "done";
    else if (ended) state = i === stopAt ? "stopped" : "skipped";
    else state = i === done + 1 ? "current" : "todo";
    return { ...s, state };
  });

  const reason = plan.failureReason ?? "";
  let outcome: Workflow["outcome"] = null;
  if (plan.status === "closed") {
    const why = plan.exitReason ? EXIT_REASON[plan.exitReason] : "청산";
    outcome = { tone: "ok", title: `청산 완료 · ${why}`, text: "계획이 끝났습니다." };
  } else if (plan.status === "cancelled") {
    outcome = { tone: "neutral", title: "사용자가 중단", text: reason || "계획을 중단했습니다." };
  } else if (plan.status === "expired") {
    outcome = { tone: "neutral", title: "진입 기한 만료", text: reason || "진입 기한까지 체결되지 않아 주문을 취소했습니다." };
  } else if (plan.status === "failed") {
    outcome = { tone: "error", title: "주문할 수 없음", text: reason || "계획을 진행하지 못했습니다." };
  }
  return { steps, outcome, requeues };
}

// ---------------------------------------------------------------- 가격 사다리

export interface Ladder {
  /** 막대 위 위치 (0~100%). 손절이 왼쪽 끝, 목표가 오른쪽 끝에 가깝다. */
  stop: number;
  entry: number;
  target: number;
  /** 지금 가격 (없으면 null). 범위를 벗어나면 막대 끝에 붙는다 (outside로 알린다). */
  last: number | null;
  outside: "below" | "above" | null;
}

/** 손절–진입–목표(–지금 가격)를 한 막대 위 위치로. 양쪽에 8% 여백을 둔다. */
export function priceLadder(stop: number, entry: number, target: number, last: number | null): Ladder {
  const lo = stop;
  const hi = target;
  const span = hi - lo || 1;
  const pos = (p: number) => 8 + ((p - lo) / span) * 84;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  let outside: Ladder["outside"] = null;
  if (last !== null && last < lo) outside = "below";
  if (last !== null && last > hi) outside = "above";
  return { stop: pos(stop), entry: pos(entry), target: pos(target), last: last === null ? null : clamp(pos(last)), outside };
}

// ---------------------------------------------------------------- 시각·입력

/** 유효 기한까지 남은 시간: "2일 3시간 남음", "45분 남음", 지났으면 "만료". */
export function timeLeft(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return "-";
  if (ms <= 0) return "만료";
  const min = Math.floor(ms / 60_000);
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  if (days > 0) return hours > 0 ? `${days}일 ${hours}시간 남음` : `${days}일 남음`;
  if (hours > 0) return `${hours}시간 ${min % 60}분 남음`;
  return `${Math.max(1, min)}분 남음`;
}

/** Discord 사용자 ID 검사. 비우면 지운다(null). 틀리면 메시지. */
export function checkDiscordId(raw: string): { value: string | null; error: string | null } {
  const v = raw.trim();
  if (!v) return { value: null, error: null };
  if (!/^\d+$/.test(v)) return { value: v, error: "Discord 사용자 ID는 숫자만 입력합니다." };
  if (v.length < 17 || v.length > 20) return { value: v, error: `Discord 사용자 ID는 숫자 17~20자리입니다 (지금 ${v.length}자리).` };
  return { value: v, error: null };
}

/** 원화 예산 입력 → 숫자 (쉼표 허용). 비었거나 0 이하·숫자가 아니면 null과 오류. */
export function parseBudget(raw: string): { value: number | null; error: string | null } {
  const v = raw.replace(/[,\s원]/g, "");
  if (!v) return { value: null, error: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: "예산은 0보다 큰 숫자로 입력해 주세요." };
  return { value: Math.floor(n), error: null };
}
