// AI 추천(새 계획 제안) · 매매 계획(모의 자동매매) · 알림 화면의 표시 규칙 (라벨, 자동매매 워크플로우 단계 계산, 가격 사다리,
// 매매 계획 카드 상태, 교차검증 과정 요약, 장 시간 안내). 화면 없이 테스트한다.
import type { IconName } from "../components/Icon";
import type { PlanCardState } from "../components/plan/PlanCard";
import type {
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
 * (docs/컨셉변경계획.md 4-3).
 */
export const SOURCE: Record<RecommendationSource, { label: string; chip: string; icon: IconName; hint: string }> = {
  report: { label: "AI 리포트", chip: "bg-brand-soft text-brand-dark", icon: "doc", hint: "AI 리포트의 결론에서 나온 계획" },
  analysis: { label: "AI 교차검증 분석", chip: "bg-brand-soft text-brand-dark", icon: "sparkle", hint: "여러 AI가 서로 검증한 분석에서 나온 계획 (리포트 없음)" },
  demo: { label: "연습용 예시 · AI 아님", chip: "bg-warn-soft text-[#9a5b00]", icon: "chart", hint: "최근 변동폭(ATR)으로 목표·손절을 정한 규칙 기반 예시" },
  day: { label: "단타 연습 · AI 아님", chip: "bg-warn-soft text-[#9a5b00]", icon: "bolt", hint: "단타 연습장에서 직접 입력한 계획" },
};

/** 보유 방식 배지 (Position·Order의 style). */
export const STYLE_BADGE: Record<HoldingStyle, { label: string; chip: string }> = {
  swing: { label: "스윙", chip: "bg-brand-soft text-brand-dark" },
  long: { label: "장기", chip: "bg-ok-soft text-ok" },
  day: { label: "단타", chip: "bg-warn-soft text-[#9a5b00]" },
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

/** 청산 사유의 화면 이름 — docs/API.md "청산 사유" 표 그대로 (쉬운 문장은 lib/plainText.ts EXIT_REASON_TEXT). */
export const EXIT_REASON: Record<NonNullable<TradePlan["exitReason"]>, string> = {
  TARGET: "목표가 도달",
  STOP: "손절가 도달",
  EXPIRED: "보유 기한 경과",
  MANUAL: "사용자 매도",
  EOD: "장 마감 전 정리",
};

/** 청산 사유 → 화면 이름. 모르는 값은 그대로 (docs/API.md "화면은 모르는 값이면 그대로 보인다"). */
export const exitReasonLabel = (reason: string | null | undefined): string =>
  reason ? (EXIT_REASON[reason as keyof typeof EXIT_REASON] ?? reason) : "";

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
    const why = plan.exitReason ? exitReasonLabel(plan.exitReason) : "청산";
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

/** 쉬운 보기의 단계 넷 (docs/컨셉변경계획.md 3장: 주문 → 사는 가격 기다리는 중 → 목표·손절 지켜보는 중 → 팔았어요). */
export type EasyStepKey = "order" | "wait" | "hold" | "sold";

export interface EasyStep {
  key: EasyStepKey;
  label: string;
  state: StepState;
}

const EASY_STEPS: { key: EasyStepKey; label: string; from: number[] }[] = [
  { key: "order", label: "주문", from: [0, 1, 2] }, // 시작 · 안전장치 점검 · 모의 주문
  { key: "wait", label: "사는 가격 기다리는 중", from: [3] },
  { key: "hold", label: "목표·손절 지켜보는 중", from: [4] },
  { key: "sold", label: "팔았어요", from: [5] },
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
  return EASY_STEPS.map((s) => ({ key: s.key, label: s.label, state: mergeStates(s.from.map((i) => wf.steps[i].state)) }));
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

// ---------------------------------------------------------------- 매매 계획 카드 (docs/컨셉변경계획.md 4-5)

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
  /** 고른 추천의 리스크 미리 보기 (예산 없음. 아직 받는 중이면 undefined). */
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

/** 새 계획 제안 나누기: 쉬운 보기는 리포트에서 나온 것만 앞에, 나머지(분석·연습용)는 접어 둔다. 전문가 보기는 전부 앞에. */
export function splitProposals<T extends { source: RecommendationSource }>(recs: readonly T[], easy: boolean): { main: T[]; others: T[] } {
  if (!easy) return { main: [...recs], others: [] };
  return { main: recs.filter((r) => r.source === "report"), others: recs.filter((r) => r.source !== "report") };
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
