// AI 추천(새 계획 제안) · 매매 계획(모의 자동매매) · 알림 화면의 표시 규칙 (라벨, 자동매매 워크플로우 단계 계산, 가격 사다리,
// 매매 계획 카드 상태, 교차검증 과정 요약, 장 시간 안내). 화면 없이 테스트한다.
import type { IconName } from "../components/Icon";
import type { PlanCardState } from "../components/plan/PlanCard";
import type {
  BudgetMode,
  HoldingStyle,
  Market,
  MarketSession,
  PlanEvent,
  Recommendation,
  RecommendationSource,
  ReportOpinion,
  ReportStatus,
  RiskLevel,
  RiskPreview,
  Scenario,
  TradePlan,
  TradePlanStatus,
} from "../api/types";

/**
 * 추천 출처. demo는 늘 "연습용 예시 · AI 아님"(docs/DECISIONS.md 13-1 D-4), 분석은 "AI 교차검증 분석"(리포트 없음)을 보인다
 * (docs/plans/컨셉변경계획.md 4-3).
 */
export const SOURCE: Record<RecommendationSource, { label: string; chip: string; icon: IconName; hint: string }> = {
  report: { label: "AI 리포트", chip: "bg-brand-soft text-brand-ink", icon: "doc", hint: "AI 리포트의 결론에서 나온 계획" },
  analysis: { label: "AI 교차검증 분석", chip: "bg-brand-soft text-brand-ink", icon: "sparkle", hint: "여러 AI가 서로 검증한 분석에서 나온 계획 (리포트 없음)" },
  demo: { label: "연습용 예시 · AI 아님", chip: "bg-warn-soft text-warn-ink", icon: "chart", hint: "최근 변동폭(ATR)으로 목표·손절을 정한 규칙 기반 예시" },
};

/** 보유 방식 배지 (Position·Order의 style). */
export const STYLE_BADGE: Record<HoldingStyle, { label: string; chip: string }> = {
  swing: { label: "스윙", chip: "bg-brand-soft text-brand-ink" },
  long: { label: "장기", chip: "bg-ok-soft text-ok-ink" },
};

export const RISK_LEVEL: Record<RiskLevel, { label: string; chip: string }> = {
  low: { label: "리스크 낮음", chip: "bg-ok-soft text-ok-ink" },
  medium: { label: "리스크 보통", chip: "bg-warn-soft text-warn-ink" },
  high: { label: "리스크 높음", chip: "bg-up-soft text-up-ink" },
};

/** 계획 상태: 색 + 아이콘 + 글자. */
export const PLAN_STATUS: Record<TradePlanStatus, { label: string; chip: string; icon: IconName }> = {
  active: { label: "활성화됨", chip: "bg-brand-soft text-brand-ink", icon: "bolt" },
  entry_pending: { label: "체결 대기", chip: "bg-brand-soft text-brand-ink", icon: "clock" },
  holding: { label: "보유 중", chip: "bg-brand text-white", icon: "shield" },
  closed: { label: "청산 완료", chip: "bg-ok-soft text-ok-ink", icon: "check" },
  cancelled: { label: "중단됨", chip: "bg-fill text-sub", icon: "ban" },
  expired: { label: "기한 만료", chip: "bg-fill text-sub", icon: "clock" },
  failed: { label: "실패", chip: "bg-up-soft text-up-ink", icon: "alert" },
};

export const planStatusOf = (status: string) =>
  PLAN_STATUS[status as TradePlanStatus] ?? { label: status, chip: "bg-fill text-sub", icon: "circle" as IconName };

/** 청산 사유의 화면 이름 — docs/API.md "청산 사유" 표 그대로 (쉬운 문장은 lib/plainText.ts EXIT_REASON_TEXT). */
export const EXIT_REASON: Record<NonNullable<TradePlan["exitReason"]>, string> = {
  TARGET: "목표가 도달",
  STOP: "손절가 도달",
  EXPIRED: "보유 기한 경과",
  MANUAL: "사용자 매도",
};

/** 청산 사유 → 화면 이름. 모르는 값은 그대로 (docs/API.md "화면은 모르는 값이면 그대로 보인다"). */
export const exitReasonLabel = (reason: string | null | undefined): string =>
  reason ? (EXIT_REASON[reason as keyof typeof EXIT_REASON] ?? reason) : "";

/** 계획 사건의 아이콘·색. 모르는 kind는 회색 점. */
export const EVENT_KIND: Record<string, { icon: IconName; cls: string; label: string }> = {
  activated: { icon: "bolt", cls: "bg-brand text-white", label: "활성화" },
  risk_checked: { icon: "shield", cls: "bg-brand-soft text-brand-ink", label: "리스크 점검" },
  order_placed: { icon: "doc", cls: "bg-brand-soft text-brand-ink", label: "주문 접수" },
  order_requeued: { icon: "restart", cls: "bg-warn-soft text-warn-ink", label: "재주문" },
  filled: { icon: "check", cls: "bg-up-soft text-up-ink", label: "체결" },
  exit_requested: { icon: "logout", cls: "bg-warn-soft text-warn-ink", label: "매도 요청" },
  closed: { icon: "check", cls: "bg-ok-soft text-ok-ink", label: "청산" },
  cancelled: { icon: "ban", cls: "bg-fill text-sub", label: "중단" },
  expired: { icon: "clock", cls: "bg-fill text-sub", label: "기한 만료" },
  failed: { icon: "alert", cls: "bg-up-soft text-up-ink", label: "실패" },
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

/**
 * 끝난 계획의 결과 한 줄. tone: done(끝까지 진행 — 손익과 무관하게 중립 + 체크, 손익 숫자만 이익·손실 색) ·
 * neutral(멈춤·기한 만료) · error(실패). 초록(성공) 상자에 손실을 담으면 초보가 손실을 성공으로 읽는다 (trade-23).
 */
export interface Outcome {
  tone: "done" | "neutral" | "error";
  title: string;
  text: string;
  /** done(청산 완료)일 때만: 실현 손익 (수수료·세금 포함) */
  pnlKrw?: number | null;
}

export interface Workflow {
  steps: WorkflowStep[];
  /** 끝난 상태면 결과 한 줄 (closed·cancelled·expired·failed). 진행 중이면 null. */
  outcome: Outcome | null;
  /** 체결 대기 중 다시 주문한 횟수. */
  requeues: number;
}

const STEPS: { key: StepKey; label: string; hint: string }[] = [
  { key: "activate", label: "활성화", hint: "사용자가 계획을 켰다" },
  { key: "risk", label: "리스크 점검", hint: "내가 정한 금액으로 수량을 계산하고 리스크 엔진이 한도를 점검한다" },
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
    // 시연용 수동 시작(DECISIONS 31장)은 approved=false를 남기지만 리스크 점검은 지나간 것이다 (끝난 뒤에도 '리스크 점검에서 멈춤'으로 그리지 않게)
    if (e.kind === "risk_checked" && e.details.approved === false && e.details.manualStart !== true) riskRejected = true;
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
    const why = plan.exitReason ? exitReasonLabel(plan.exitReason) : "청산";
    outcome = { tone: "done", title: `청산 완료 · ${why}`, text: "계획이 끝났습니다.", pnlKrw: plan.pnlKrw };
  } else if (plan.status === "cancelled") {
    outcome = { tone: "neutral", title: "사용자가 중단", text: reason || "계획을 중단했습니다." };
  } else if (plan.status === "expired") {
    outcome = { tone: "neutral", title: "진입 기한 만료", text: reason || "진입 기한까지 체결되지 않아 주문을 취소했습니다." };
  } else if (plan.status === "failed") {
    outcome = { tone: "error", title: "주문할 수 없음", text: reason || "계획을 진행하지 못했습니다." };
  }
  return { steps, outcome, requeues };
}

/** 쉬운 보기의 단계 넷 (docs/plans/컨셉변경계획.md 3장: 주문 → 사는 가격 기다리는 중 → 목표·손절 지켜보는 중 → 팔았어요). */
export type EasyStepKey = "order" | "wait" | "hold" | "sold";

export interface EasyStep {
  key: EasyStepKey;
  label: string;
  state: StepState;
}

// label은 문서 3장의 단계 이름. 끝난 단계는 과거형(done), 파는 중인 마지막 단계는 진행형(current)으로 바꿔 보인다 —
// 모두 체크인데 "…기다리는 중"으로 남거나 매도 요청 중인데 "팔았어요"라고 말하지 않게 (trade-36)
const EASY_STEPS: { key: EasyStepKey; label: string; done?: string; current?: string; from: number[] }[] = [
  { key: "order", label: "주문", done: "주문했어요", from: [0, 1, 2] }, // 시작 · 안전장치 점검 · 모의 주문
  { key: "wait", label: "사는 가격 기다리는 중", done: "샀어요", from: [3] },
  { key: "hold", label: "목표·손절 지켜보는 중", done: "목표·손절 지켜봤어요", from: [4] },
  { key: "sold", label: "팔았어요", current: "파는 중", from: [5] },
];

/** 여러 단계를 하나로 묶은 상태: 멈춤 > 진행 중 > 완료(남은 것은 건너뜀뿐) > 일부만 완료(진행 중) > 모두 건너뜀 > 대기. */
function mergeStates(states: StepState[]): StepState {
  if (states.includes("stopped")) return "stopped";
  if (states.includes("current")) return "current";
  if (states.includes("done")) return states.includes("todo") ? "current" : "done";
  if (states.every((s) => s === "skipped")) return "skipped";
  return "todo";
}

/** 계획 상태와 사건으로 쉬운 단계 넷을 계산한다 (planWorkflow의 여섯 단계를 묶는다). */
export function easySteps(plan: Pick<TradePlan, "status" | "exitReason" | "failureReason" | "pnlKrw">, events: PlanEvent[] = []): EasyStep[] {
  const wf = planWorkflow(plan, events);
  return EASY_STEPS.map((s) => {
    const state = mergeStates(s.from.map((i) => wf.steps[i].state));
    const label = (state === "done" && s.done) || (state === "current" && s.current) || s.label;
    return { key: s.key, label, state };
  });
}

// ---------------------------------------------------------------- AI 교차검증 분석 과정 (docs/DECISIONS.md 13-1 D-1)

const COUNT_WORD = ["", "한", "두", "세", "네", "다섯", "여섯", "일곱", "여덟", "아홉", "열"];

/** "AI 세 곳"처럼 셀 때의 수: 1~10은 우리말(한·두·세…), 그 밖은 숫자. */
export const countWord = (n: number): string => COUNT_WORD[n] || String(n);

export interface CrossCheck {
  /** 계획을 낸 AI 수 (= 시나리오 수). */
  count: number;
  /** 교차검증 점수 + 리스크 엔진을 통과한 수. */
  passed: number;
  /** 최종 승인한 계획의 제안 AI (없으면 null). */
  selected: string | null;
  /** 쉬운 보기 한 줄: "AI 세 곳이 각자 계획을 내고 서로 검증했어요 · 통과 2 · 최종 승인 claude". */
  sentence: string;
}

/** 교차검증 과정을 쉬운 말 한 줄로 (점수·확률 없이). */
export function crossCheckSummary(scenarios: Pick<Scenario, "proposer" | "passed" | "selected">[]): CrossCheck {
  const count = scenarios.length;
  const passed = scenarios.filter((s) => s.passed === true).length;
  const selected = scenarios.find((s) => s.selected)?.proposer ?? null;
  if (count === 0) return { count, passed, selected, sentence: "AI가 낸 계획이 없어요 (조건에 맞는 계획이 없었어요)" };
  const who = `AI ${countWord(count)} 곳이`;
  const head = count === 1 ? `${who} 계획을 내고 검증을 거쳤어요` : `${who} 각자 계획을 내고 서로 검증했어요`;
  return { count, passed, selected, sentence: `${head} · 통과 ${passed} · 최종 승인 ${selected ?? "없음"}` };
}

// ---------------------------------------------------------------- 매매 계획 카드 (docs/plans/컨셉변경계획.md 4-5)

/** 리포트가 끝난 뒤 이 시간 안에 추천이 없으면 "계획 준비 중"(엔진 루프가 곧 만든다), 지나면 "계획 없음". */
export const PREPARING_MS = 10 * 60_000;

/** 리포트의 추천 중 카드에 보일 하나: 열린 것 중 최신, 없으면 가장 최근 것. */
export function pickRecommendation(recs: readonly Recommendation[]): Recommendation | null {
  const latest = (list: readonly Recommendation[]) =>
    list.reduce<Recommendation | null>((a, b) => (!a || b.createdAt > a.createdAt || (b.createdAt === a.createdAt && b.id > a.id) ? b : a), null);
  return latest(recs.filter((r) => r.status === "open")) ?? latest(recs);
}

export interface PlanCardInput {
  report: { status: ReportStatus; opinion: ReportOpinion | null; finishedAt: string | null };
  /** 리포트의 추천 (아직 받는 중이면 undefined). */
  recs: readonly Recommendation[] | undefined;
  /** 고른 추천의 리스크 미리 보기 (넣을 돈 없음 — 크기 없이 점검만. 아직 받는 중이면 undefined). */
  preview: RiskPreview | undefined;
  now: number;
}

/** 매매 계획 카드의 상태. 아직 자료를 받는 중이면 "loading". */
export function planCardState(x: PlanCardInput): PlanCardState | "loading" {
  if (x.report.status !== "completed") return "not_completed";
  if (!x.recs) return "loading";
  const rec = pickRecommendation(x.recs);
  if (rec) {
    if (rec.status === "expired") return "expired";
    if (!x.preview) return "loading";
    return x.preview.activatable ? "ready" : "blocked";
  }
  if (x.report.opinion === "hold") return "watch";
  if (x.report.opinion === "avoid") return "negative";
  if (x.report.opinion === "buy") {
    const finished = x.report.finishedAt ? Date.parse(x.report.finishedAt) : NaN;
    if (Number.isFinite(finished) && x.now - finished < PREPARING_MS) return "preparing";
  }
  return "no_plan";
}

/**
 * 계좌와 무관하게 지금 시작할 수 없는 사유 (Recommendation.blockedBy — 없으면 []로 본다, DECISIONS 23장).
 * blockedBy를 모르는 서버라도 기한이 지난 추천은 expired로 본다.
 */
export function blockedCodes(r: Pick<Recommendation, "status"> & { blockedBy?: readonly string[] }): string[] {
  const codes = [...(r.blockedBy ?? [])];
  if (r.status !== "open" && !codes.includes("expired")) codes.push("expired");
  return codes;
}

export const isRecBlocked = (r: Pick<Recommendation, "status"> & { blockedBy?: readonly string[] }): boolean => blockedCodes(r).length > 0;

/** 시연용 수동 시작(DECISIONS 31장)이 건너뛰는 사유 — 서버 backend/autotrade/plans/risk.py MANUAL_SKIP_CODES와 같다. */
export const MANUAL_SKIP_CODES: readonly string[] = ["reward_risk_low", "ev_negative"];
/** 사유가 하나 이상이고 모두 건너뛸 수 있는 것인지. */
export const onlyManualSkip = (codes: readonly string[]): boolean => codes.length > 0 && codes.every((c) => MANUAL_SKIP_CODES.includes(c));
/** 금액 없는 미리 보기(내 계좌까지 본 결과)가 손익비·기대값으로만 막았는지 — '수동매매 (시연용)' 자격. */
export const canStartManually = (pv: Pick<RiskPreview, "activatable" | "reasonCodes"> | undefined): boolean =>
  Boolean(pv && !pv.activatable && onlyManualSkip(pv.reasonCodes));
/** 실행 확인의 시연용 수동 시작 주소 (Discord ?t=가 있으면 이어 붙인다). */
export function manualStartPath(recId: number, token?: string | null): string {
  const sp = new URLSearchParams({ manual: "1" });
  if (token) sp.set("t", token);
  return `/recommendations/${recId}?${sp}`;
}

/** 시작할 수 있는 것을 먼저 (같은 무리 안에서는 받은 순서 = 최신순 그대로). 목록·홈·모의투자 탭의 압축 목록이 같이 쓴다 (UX-2). */
export function startableFirst<T extends Pick<Recommendation, "status"> & { blockedBy?: readonly string[] }>(recs: readonly T[]): T[] {
  return [...recs.filter((r) => !isRecBlocked(r)), ...recs.filter((r) => isRecBlocked(r))];
}

/**
 * 새 계획 제안 나누기: 쉬운 보기는 리포트에서 나온 것만 앞에, 나머지(분석·연습용)는 접어 둔다. 전문가 보기는 전부 앞에.
 * 어느 쪽이든 시작할 수 있는 것이 먼저다 (압축 목록 위 셋이 모두 '시작할 수 없음'이 되지 않게 — UX-2).
 */
export function splitProposals<T extends { source: RecommendationSource; status: Recommendation["status"]; blockedBy?: readonly string[] }>(
  recs: readonly T[],
  easy: boolean,
): { main: T[]; others: T[] } {
  const sorted = startableFirst(recs);
  if (!easy) return { main: sorted, others: [] };
  return { main: sorted.filter((r) => r.source === "report"), others: sorted.filter((r) => r.source !== "report") };
}

/** 같은 종목의 제안 묶음: 보일 하나(rec)와 그 카드 안에 접을 나머지(rest, 최신순). */
export interface ProposalGroup<T> {
  rec: T;
  rest: T[];
  /** rest가 모두 rec보다 먼저 만든 것인지 ('같은 종목의 이전 제안' / '다른 제안'). */
  restOlder: boolean;
}

type GroupInput = Pick<Recommendation, "id" | "symbol" | "market" | "source" | "status" | "createdAt"> & { blockedBy?: readonly string[] };

const newer = (a: GroupInput, b: GroupInput) => (a.createdAt === b.createdAt ? a.id > b.id : a.createdAt > b.createdAt);

/**
 * 새 계획 제안 목록 화면의 배치 (UX-2): 같은 종목은 하나로 묶고(보일 것 = 시작할 수 있는 것 중 최신, 없으면 최신),
 * 묶음을 시작할 수 있는 것(ready) · 쉬운 보기의 다른 출처(others — 분석·연습용, 시작할 수 있는 것만) · 지금은 시작할 수 없는 것(blocked)으로 나눈다.
 * 각 무리 안의 순서는 받은 순서(최신순)다.
 */
export function arrangeProposals<T extends GroupInput>(recs: readonly T[], easy: boolean): { ready: ProposalGroup<T>[]; others: ProposalGroup<T>[]; blocked: ProposalGroup<T>[] } {
  const bySymbol = new Map<string, T[]>();
  for (const r of recs) {
    const key = `${r.market}:${r.symbol}`;
    const list = bySymbol.get(key);
    if (list) list.push(r);
    else bySymbol.set(key, [r]);
  }
  const groups: ProposalGroup<T>[] = [];
  const seen = new Set<string>();
  for (const r of recs) {
    const key = `${r.market}:${r.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const list = bySymbol.get(key)!;
    const pick = (xs: T[]) => xs.reduce<T | null>((a, b) => (!a || newer(b, a) ? b : a), null);
    const rec = pick(list.filter((x) => !isRecBlocked(x))) ?? pick(list)!;
    const rest = list.filter((x) => x !== rec).sort((a, b) => (newer(a, b) ? -1 : 1));
    groups.push({ rec, rest, restOlder: rest.every((x) => newer(rec, x)) });
  }
  // 묶음의 자리는 보일 제안의 순서로 (받은 목록에서의 위치)
  const at = new Map(recs.map((r, i) => [r, i]));
  groups.sort((a, b) => at.get(a.rec)! - at.get(b.rec)!);
  const ready = groups.filter((g) => !isRecBlocked(g.rec));
  const blocked = groups.filter((g) => isRecBlocked(g.rec));
  if (!easy) return { ready, others: [], blocked };
  return { ready: ready.filter((g) => g.rec.source === "report"), others: ready.filter((g) => g.rec.source !== "report"), blocked };
}

const KIND_SHORT: Record<RecommendationSource, string> = { report: "AI 리포트", analysis: "교차검증 분석", demo: "연습용 예시" };

/** 접힌 "다른 계획 ○개 (…)" 괄호 안: 실제로 들어 있는 출처만 (분석만 있으면 "교차검증 분석"). */
export function otherKinds(recs: readonly { source: RecommendationSource }[]): string {
  const order: RecommendationSource[] = ["analysis", "demo", "report"];
  return order.filter((s) => recs.some((r) => r.source === s)).map((s) => KIND_SHORT[s]).join("·");
}

/** 진행 중 계획을 연결된 모의 주문 번호로 찾는 표 (내 주식의 대기 주문·보유·매도 예약 행에 계획을 잇는다 — trade-05). */
export function plansByOrder<T extends Pick<TradePlan, "orderId" | "status">>(plans: readonly T[]): Map<number, T> {
  const map = new Map<number, T>();
  for (const p of plans) {
    if (p.orderId != null && (p.status === "active" || p.status === "entry_pending" || p.status === "holding")) map.set(p.orderId, p);
  }
  return map;
}

/**
 * 시작할 수 없을 때 시작 버튼 아래에 줄 다음 행동 하나 (trade-15). 사유 코드 순서와 무관하게 우선순위로 고른다.
 * my_plan: 이미 진행 중인 내 계획 보기 · portfolio: 같은 종목 주문·보유가 있음 · other_plans: 이 계획 자체가 막힘(다른 계획 보기) ·
 * null: 기다리면 풀리거나(중단 스위치·하루 한도) 넣을 돈을 고치면 되는 경우(cash_short·total_limit·budget_too_small) — 문장만 보인다.
 */
export function nextActionOf(codes: readonly string[]): "my_plan" | "portfolio" | "other_plans" | null {
  if (codes.includes("plan_exists")) return "my_plan";
  if (codes.includes("position_exists")) return "portfolio";
  const planBlocked = ["reward_risk_low", "ev_negative", "price_passed", "warning_stock", "expired", "size_too_small"];
  if (codes.some((c) => planBlocked.includes(c))) return "other_plans";
  return null;
}

// ---------------------------------------------------------------- 시각 (KST·장 시간)

const KST = "Asia/Seoul";
const MARKET_TZ: Record<Market, string> = { KR: KST, US: "America/New_York" };
const SESSION_MIN: Record<Market, [number, number]> = { KR: [9 * 60, 15 * 60 + 30], US: [9 * 60 + 30, 16 * 60] };

function zonedParts(date: Date, timeZone: string) {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
  }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

/** ISO 시각의 KST 날짜 "YYYY-MM-DD" (틀린 값이면 null). */
export function kstDayOf(iso: string | number | Date): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = zonedParts(d, KST);
  return `${p.year}-${p.month}-${p.day}`;
}

/** 그 시각이 오늘(KST)인지. 하루 리포트 한도·"오늘 리포트"와 같은 기준. */
export function isTodayKst(iso: string | null | undefined, now: Date = new Date()): boolean {
  return Boolean(iso) && kstDayOf(iso!) === kstDayOf(now);
}

/**
 * 그 시각이 그 시장의 정규장 시간(평일 KR 09:00~15:30, US 뉴욕 09:30~16:00)이었는지.
 * 분석 시각 가격을 "장중 가격"이라고 밝힐 때 쓴다 (장 달력이 없어 휴장일은 모른다 — 평일만 본다).
 */
export function duringSession(iso: string | null | undefined, market: Market): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const p = zonedParts(d, MARKET_TZ[market]);
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  const [open, close] = SESSION_MIN[market];
  return minutes >= open && minutes < close;
}

/** 정규장 시작 시각을 한국 시각으로: "10월 6일(화) 오전 9시", 미국 장은 "10월 6일(화) 오후 10시 30분(한국 시각)". */
export function formatOpensAt(iso: string | null | undefined, market: Market = "KR"): string {
  if (!iso) return "다음 정규장 시작";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "다음 정규장 시작";
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("ko-KR", { timeZone: KST, month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit", hourCycle: "h23" }).formatToParts(d)) {
    p[x.type] = x.value;
  }
  const h = Number(p.hour);
  const m = Number(p.minute);
  const clock = `${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}시${m ? ` ${m}분` : ""}`;
  return `${p.month}월 ${p.day}일(${p.weekday}) ${clock}${market === "US" ? "(한국 시각)" : ""}`;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const KO_WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 기한 전에 살 수 있는 마지막 정규장 (그 시장 시간대 기준, 평일만 거래일 — 공휴일 달력은 화면에 없다).
 * 기한이 정규장 도중이면 그 날 그 시각까지(midSession), 장 마감 뒤면 그 날 장 마감, 장 시작 전·주말이면 앞 거래일 장 마감.
 * 자동 리포트 추천(08:00 KST에 만들어 기한도 08:0x)은 마지막이 앞 거래일 장 마감이다 (리뷰 R-5).
 */
function lastSessionBefore(d: Date, market: Market): { month: number; day: number; weekday: number; midSession: boolean; moved: boolean } {
  const p = zonedParts(d, MARKET_TZ[market]);
  const [open, close] = SESSION_MIN[market];
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  let wd = WEEKDAY_INDEX[p.weekday] ?? 1;
  const tradingDay = wd >= 1 && wd <= 5;
  if (tradingDay && minutes > open && minutes < close) return { month: Number(p.month), day: Number(p.day), weekday: wd, midSession: true, moved: false };
  let back = 0;
  if (!tradingDay || minutes <= open) {
    do {
      back += 1;
      wd = (wd + 6) % 7;
    } while (wd === 0 || wd === 6);
  }
  // 날짜만 셈하려고 UTC 정오로 만든다 (시간대와 무관)
  const day = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) - back, 12));
  return { month: day.getUTCMonth() + 1, day: day.getUTCDate(), weekday: wd, midSession: false, moved: back > 0 };
}

/**
 * 사는 가격을 기다리는 기한(추천의 validUntil = 계획의 entryDeadline)을 실제로 살 수 있는 마지막으로 (UX-11):
 * "10월 9일(금) 장 마감", 정규장 도중이면 그 시각 "10월 8일(목) 오전 10시 23분"(미국은 한국 시각). 뒤에 "까지"를 붙여 쓴다.
 */
export function entryDeadlineLabel(iso: string | null | undefined, market: Market = "KR"): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const last = lastSessionBefore(d, market);
  if (last.midSession) return formatOpensAt(iso, market);
  return `${last.month}월 ${last.day}일(${KO_WEEKDAY[last.weekday]}) 장 마감${market === "US" ? "(뉴욕)" : ""}`;
}

/** 기한이 그 시장의 장 시작 전·주말이라 entryDeadlineLabel이 앞 거래일 장 마감으로 당겨 보이는지. */
export function deadlineMovedEarlier(iso: string | null | undefined, market: Market = "KR"): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  return lastSessionBefore(d, market).moved;
}

/**
 * 시작하면 바로 사는지 (UX-3): 그 시장이 정규장 중이고 실시간 시세(basis "live")가 사는 가격 이하. 장 밖이거나 종가 기준이면 false
 * (다음 장에 지정가로 기다린다). 숫자를 문장에 넣지 않는다 — 장중 가격 문장 규칙.
 */
export function buysRightAway(
  session: Pick<MarketSession, "isOpen"> | undefined,
  quote: { price: number | null; basis?: string } | undefined,
  entryPrice: number,
): boolean {
  return Boolean(session?.isOpen) && quote?.basis === "live" && quote.price != null && quote.price > 0 && quote.price <= entryPrice;
}

/** 장이 닫혀 있을 때 실행 확인·체결 대기 화면의 안내 (열려 있거나 모르면 null). */
export function closedMarketNotice(session: Pick<MarketSession, "isOpen" | "opensAt"> | undefined, market: Market = "KR"): string | null {
  if (!session || session.isOpen) return null;
  return `지금은 장이 닫혀 있어요. ${formatOpensAt(session.opensAt, market)}에 장이 열리면 사는 가격을 확인해요`;
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

/**
 * 손절–기준점–목표(–지금 가격)를 한 막대 위 위치로. 양쪽에 8% 여백을 둔다. 기준점(entry)은 사기 전에는 사는 가격, 산 뒤에는 산 가격이다
 * (산 가격은 손절·목표 밖일 수도 있어 막대 안으로 붙인다).
 */
export function priceLadder(stop: number, entry: number, target: number, last: number | null): Ladder {
  const lo = stop;
  const hi = target;
  const span = hi - lo || 1;
  const pos = (p: number) => 8 + ((p - lo) / span) * 84;
  const clamp = (v: number) => Math.min(100, Math.max(0, v));
  let outside: Ladder["outside"] = null;
  if (last !== null && last < lo) outside = "below";
  if (last !== null && last > hi) outside = "above";
  return { stop: pos(stop), entry: clamp(pos(entry)), target: pos(target), last: last === null ? null : clamp(pos(last)), outside };
}

/**
 * 시세의 가격(실시간 현재가, 못 받은 종목은 직전 종가)에서 계획의 가격까지 남은 거리 (계획 상세의 "얼마나 남았나" 한 줄 — trade-25).
 * 사기 전(active·entry_pending): 사는 가격까지. 보유 중(holding): 목표·손절까지. 그 밖이거나 시세가 없으면 빈 목록.
 */
export function ladderDistances(
  status: TradePlanStatus,
  p: Pick<TradePlan, "entryPrice" | "targetPrice" | "stopPrice">,
  last: number | null,
): { key: "entry" | "target" | "stop"; rate: number }[] {
  if (last === null || !(last > 0)) return [];
  if (status === "active" || status === "entry_pending") return [{ key: "entry", rate: p.entryPrice / last - 1 }];
  if (status === "holding") {
    return [
      { key: "target", rate: p.targetPrice / last - 1 },
      { key: "stop", rate: p.stopPrice / last - 1 },
    ];
  }
  return [];
}

// ---------------------------------------------------------------- PC 고정 열 (실행 확인·계획 상세의 오른쪽 열)

/**
 * PC 오른쪽 고정(sticky) 열이 화면보다 길면 위에 붙지 않고, 열의 아래 끝(시작·멈추기 버튼)이 화면 바닥 2rem 위에 왔을 때 붙게 한다 (trade-v02).
 * 짧으면 지금처럼 위 2rem에 붙는다. 열 높이를 CSS 변수 --col-h로 넘기고 top을 min()으로 고른다 (ResizeObserver가 없으면 위에 붙는다).
 * 콜백 ref로 쓴다 — 열이 늦게(불러온 뒤) 나타나도 붙고, 사라지면 관찰을 멈춘다: <div ref={stickyFit} className="lg:sticky" style={{ top: STICKY_FIT_TOP }}>
 */
export function stickyFit(el: HTMLElement | null) {
  if (!el || typeof ResizeObserver !== "function") return;
  const ro = new ResizeObserver(() => el.style.setProperty("--col-h", `${el.offsetHeight}px`));
  ro.observe(el);
  return () => ro.disconnect();
}
export const STICKY_FIT_TOP = "min(2rem, calc(100dvh - var(--col-h, 0px) - 2rem))";

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

/** 칩용 짧은 남은 시간: "2일 남음", "5시간 남음", "45분 남음", 지났으면 "만료" (자세한 시각은 상세 화면이 보인다). */
export function timeLeftShort(iso: string, now: Date = new Date()): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return "-";
  if (ms <= 0) return "만료";
  const min = Math.floor(ms / 60_000);
  if (min >= 1440) return `${Math.floor(min / 1440)}일 남음`;
  if (min >= 60) return `${Math.floor(min / 60)}시간 남음`;
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

// ---------------------------------------------------------------- 넣을 돈 (투자 금액, 2026-10-11 DECISIONS 28장)

/** 실행 확인의 % 칩 (매수 가능 금액 기준). */
export const BUDGET_PERCENT_CHIPS = [10, 25, 50, 100] as const;

/** 정한 넣을 돈: percent = 매수 가능 금액의 %(1~100 정수), amount = 원. */
export interface BudgetChoice {
  mode: BudgetMode;
  value: number;
}

/**
 * 넣을 돈 입력 → 숫자. 비었으면 정하지 않음(null, 오류 없음).
 * amount: 원 (쉼표·'원' 허용, 0 이하·숫자가 아니면 오류, 원 미만은 버린다). percent: 1~100 정수 ('%' 허용).
 */
export function parseBudget(raw: string, mode: BudgetMode = "amount"): { value: number | null; error: string | null } {
  if (mode === "percent") {
    const v = raw.replace(/[%\s]/g, "");
    if (!v) return { value: null, error: null };
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { value: null, error: "1~100 사이의 정수로 입력해 주세요." };
    return { value: n, error: null };
  }
  const v = raw.replace(/[,\s원]/g, "");
  if (!v) return { value: null, error: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return { value: null, error: "금액은 0보다 큰 숫자로 입력해 주세요." };
  return { value: Math.floor(n), error: null };
}

/** 미리 보기·활성화 요청에 넣을 값: budgetPercent와 budgetKrw 중 하나만 (docs/API.md "넣을 돈"). */
export function budgetParams(b: BudgetChoice): { budgetPercent: number } | { budgetKrw: number } {
  return b.mode === "percent" ? { budgetPercent: b.value } : { budgetKrw: b.value };
}

/** % → 원: 매수 가능 금액 × % / 100을 원 단위로 내린다 (서버와 같은 계산). */
export const percentToKrw = (buyingPowerKrw: number, percent: number): number => Math.floor((Math.max(0, buyingPowerKrw) * percent) / 100);
