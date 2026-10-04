// AI 리포트 화면의 표시 규칙: 상태 이름·색, Trace에서 노드 상태 읽기, 실패 정책 설명 (docs/교육용문서.md 그대로).
// 아래쪽 "쉬운 보기" 절은 주린이모드 화면(components/reports/easy/*)이 결과·Trace·리스크 미리 보기에서 문장을 만드는 순수 함수다.
import type {
  AnalysisSummary,
  ErrorType,
  ExecutionPlan,
  FailurePolicy,
  Recommendation,
  ReportDetail,
  ReportOpinion,
  ReportQuota,
  ReportStatus,
  ReportSummary,
  RiskPreview,
  SharedState,
  TraceEvent,
  TraceStatus,
} from "../api/types";
import type { IconName } from "../components/Icon";
import { formatRate, formatSignedKrw } from "./format";
import { REPORT_FAILURE_FALLBACK, REPORT_STATUS_TEXT } from "./plainText";
import { attemptHistory, isGiveUp } from "./recovery";

export const NOT_IMPLEMENTED = "Agent 실행은 아직 구현되지 않았습니다. 신청은 기록되고 구조만 볼 수 있습니다.";

/** 그래프 노드 상태: Trace에서 그 actor의 마지막 사건 status. 사건이 없으면 대기. */
export type NodeStatus = "waiting" | TraceStatus;

interface Look {
  label: string;
  icon: IconName;
  chip: string; // 배지 색
  border: string; // 노드 테두리
}

// 상태는 색만으로 구분하지 않는다 (아이콘 + 글자를 같이 쓴다)
export const NODE_STATUS: Record<NodeStatus, Look> = {
  waiting: { label: "대기", icon: "circle", chip: "bg-fill text-mute", border: "border-line" },
  started: { label: "실행 중", icon: "play", chip: "bg-brand-soft text-brand-dark", border: "border-brand" },
  completed: { label: "완료", icon: "check", chip: "bg-ok-soft text-ok", border: "border-ok" },
  failed: { label: "실패", icon: "close", chip: "bg-up-soft text-up", border: "border-up" },
  blocked: { label: "차단", icon: "ban", chip: "bg-warn-soft text-[#9a5b00]", border: "border-warn" },
  skipped: { label: "건너뜀", icon: "skip", chip: "bg-fill text-sub", border: "border-dashed border-mute" },
};

export const REPORT_STATUS: Record<ReportStatus, Omit<Look, "border">> = {
  requested: { label: "신청됨", icon: "clock", chip: "bg-fill text-sub" },
  running: { label: "실행 중", icon: "play", chip: "bg-brand-soft text-brand-dark" },
  completed: { label: "완료", icon: "check", chip: "bg-ok-soft text-ok" },
  failed: { label: "실패", icon: "close", chip: "bg-up-soft text-up" },
};

export const POLICIES: { value: FailurePolicy; name: string; behavior: string }[] = [
  { value: "fail_fast", name: "Fail Fast", behavior: "하나라도 실패하면 전체 중단" },
  { value: "best_effort", name: "Best Effort", behavior: "성공 결과만으로 제한된 결과 생성" },
  { value: "required_optional", name: "Required/Optional", behavior: "필수 Agent 실패일 때만 중단" },
];

/** LLM 비용: 1센트보다 작은 값이 많아 소수 셋째 자리까지. */
export const formatCost = (usd: number) => `$${usd.toFixed(3)}`;

export const policyName = (p: FailurePolicy) => POLICIES.find((x) => x.value === p)?.name ?? p;

/** Handoff 계약 필드와 Guard가 확인하는 것 (docs/교육용문서.md "Handoff"). */
export const HANDOFF_FIELDS = ["task_id", "trace_id", "from_agent", "to_agent", "responsibility", "context", "user_id", "hop_count"];
export const HANDOFF_GUARD_CHECKS = ["사용자", "허용 경로", "민감정보", "최대 Hop"];

const SPECIAL_ACTORS: Record<string, string> = {
  join_guard: "Join Guard",
  handoff_guard: "Handoff Guard",
  orchestrator: "Orchestrator",
};

/** actor id → 화면 이름 (Worker 제목, Guard 이름). 모르는 값은 그대로. */
export function actorLabel(plan: ExecutionPlan | undefined, actor: string): string {
  return plan?.workers.find((w) => w.id === actor)?.title ?? SPECIAL_ACTORS[actor] ?? actor;
}

export interface NodeView {
  status: NodeStatus;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
}

/** 한 actor의 노드 상태: 마지막 사건의 status, 실제 실행 Provider·Model, 마지막 소요 시간. */
export function nodeView(trace: TraceEvent[], actor: string, match: (e: TraceEvent) => boolean = () => true): NodeView {
  // 최신 사건이 앞에 오게
  const mine = trace.filter((e) => e.actor === actor && match(e)).reverse();
  const ran = mine.find((e) => e.provider || e.model);
  return {
    status: mine[0]?.status ?? "waiting",
    provider: ran?.provider ?? null,
    model: ran?.model ?? null,
    latencyMs: mine.find((e) => e.latencyMs !== null)?.latencyMs ?? null,
  };
}

/** Guard 사건이 어느 step·Handoff 것인지 details로 가린다. 표시가 없으면 모두 해당한다고 본다. */
export const forDetail = (key: string, value: string) => (e: TraceEvent) => !(key in e.details) || e.details[key] === value;

// ---------------------------------------------------------------- 타임라인 문장 (사람이 읽는 말)

export const ERROR_LABEL: Record<ErrorType, string> = {
  timeout: "시간 초과",
  server_error: "서버 오류",
  bad_output: "형식 오류",
  unknown: "오류",
};

export type EventTone = "fail" | "recover" | "ok" | "info";

export interface EventText {
  text: string;
  tone: EventTone;
  icon: IconName;
  tags: string[]; // "주입", "포기", "자동 복구"
}

const str = (v: unknown) => (typeof v === "string" ? v : "");
const num = (v: unknown) => (typeof v === "number" ? v : null);

/** 타임라인의 "주요 사건": 실패·재시도·전환·완료·포기·검토 반복·Join/Handoff 막힘·시작과 끝. */
const KEY_ACTIONS = new Set([
  "workflow_started",
  "workflow_completed",
  "workflow_failed",
  "agent_completed",
  "agent_failed",
  "agent_retry",
  "agent_failover",
  "review_retry",
  "join_blocked",
  "handoff_blocked",
]);
export const isKeyEvent = (e: TraceEvent) => KEY_ACTIONS.has(e.action);

/** 사건 하나를 문장으로. 모르는 action은 null (화면이 action 코드를 그대로 보인다). */
export function eventText(e: TraceEvent, plan: ExecutionPlan | undefined): EventText | null {
  const d = e.details;
  const model = e.model ? ` (${e.model})` : "";
  const injected = d.injected === true ? ["주입"] : [];
  switch (e.action) {
    case "workflow_started":
      return { text: d.chaos === true ? "리포트 실행 시작 · 장애 주입 켜짐" : "리포트 실행 시작", tone: "info", icon: "play", tags: [] };
    case "workflow_completed":
      return { text: "리포트 완성", tone: "ok", icon: "check", tags: [] };
    case "workflow_failed":
      return { text: `리포트 실패${str(d.reason) ? ` — ${str(d.reason)}` : ""}`, tone: "fail", icon: "close", tags: [] };
    case "agent_started":
      return { text: num(d.attempt) && num(d.attempt)! > 1 ? `다시 실행 (${num(d.attempt)}번째)` : "시작", tone: "info", icon: "play", tags: [] };
    case "agent_completed": {
      const recovered = d.recovered === true;
      const verdict = str(d.verdict) ? ` · 판정 ${str(d.verdict)}${num(d.score) !== null ? ` ${num(d.score)}점` : ""}` : "";
      return { text: `${recovered ? "복구 완료" : "완료"}${model}${verdict}`, tone: recovered ? "recover" : "ok", icon: "check", tags: recovered ? ["자동 복구"] : [] };
    }
    case "agent_failed": {
      if (d.final === false) {
        return { text: `${ERROR_LABEL[(str(d.errorType) as ErrorType)] ?? "오류"}로 실패${model}`, tone: "fail", icon: "close", tags: injected };
      }
      const why = str(d.message) || str(d.error) || (str(d.errorType) ? ERROR_LABEL[str(d.errorType) as ErrorType] ?? str(d.errorType) : "");
      return { text: `실패${why ? ` — ${why}` : ""}`, tone: "fail", icon: "close", tags: ["포기"] };
    }
    case "agent_retry":
      return { text: `같은 모델로 다시 시도${num(d.attempt) ? ` (${num(d.attempt)}번째)` : ""}`, tone: "recover", icon: "restart", tags: [] };
    case "agent_failover":
      return { text: `대체 모델 ${str(d.to) || "?"}(으)로 전환${str(d.from) ? ` (← ${str(d.from)})` : ""}`, tone: "recover", icon: "swap", tags: [] };
    case "agent_skipped":
      return { text: "건너뜀", tone: "info", icon: "skip", tags: [] };
    case "join_completed":
      return { text: "필수 결과 확인, Join 통과", tone: "ok", icon: "shield", tags: [] };
    case "join_blocked":
      return { text: "필수 결과가 없어 Join을 막음", tone: "fail", icon: "ban", tags: [] };
    case "review_retry": {
      const round = num(d.round);
      return { text: `검토 → ${actorLabel(plan, str(d.target))} 다시 작성${round ? ` (${round}번째)` : ""}`, tone: "recover", icon: "restart", tags: [] };
    }
    case "handoff_started":
    case "handoff_completed":
      return { text: `${actorLabel(plan, str(d.from))} → ${actorLabel(plan, str(d.to))} 책임 넘김`, tone: "info", icon: "swap", tags: [] };
    case "handoff_blocked":
      return { text: `${actorLabel(plan, str(d.to))}(으)로 넘기기를 막음`, tone: "fail", icon: "ban", tags: [] };
    default:
      return null;
  }
}

// ---------------------------------------------------------------- 쉬운 보기 (주린이모드 켬) — docs/컨셉변경계획.md 4-2·4-4·5장·6장
// 화면 문구와 숫자는 코드가 만든다. LLM이 쓴 문장은 plainSummary·oneLiner·reasons·risks뿐이고, 금액은 리스크 미리 보기 값이다.
// 주어를 밝히고("AI 의견", "검토 AI", "안전장치"), 권유·명령형을 쓰지 않는다 (docs/API.md "금지 표현").

const KST = "Asia/Seoul";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const texts = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.map(text).filter((x): x is string => x !== null).slice(0, max) : [];

/** AI 담당자(Worker)의 쉬운 이름 ("Agent" 대신). 모르는 id는 "AI 담당자". */
export const WORKER_EASY_NAME: Record<string, string> = {
  market_agent: "시세를 보는 AI",
  fundamental_agent: "재무제표를 읽는 AI",
  news_agent: "뉴스를 읽는 AI",
  report_agent: "리포트를 쓰는 AI",
  review_agent: "검토 AI",
  risk_agent: "위험을 점검하는 AI",
};

export const workerEasyName = (id: string): string => WORKER_EASY_NAME[id] ?? "AI 담당자";

/** 쉬운 진행 표시 다섯 단계 (docs/컨셉변경계획.md 4-2 "시세를 보는 중 → … → 검토하는 중"). */
export const PROGRESS_STEPS: readonly { actor: string; label: string }[] = [
  { actor: "market_agent", label: "시세를 보는 중" },
  { actor: "fundamental_agent", label: "재무제표를 읽는 중" },
  { actor: "news_agent", label: "뉴스를 읽는 중" },
  { actor: "report_agent", label: "리포트를 쓰는 중" },
  { actor: "review_agent", label: "검토하는 중" },
];

export type ProgressState = "waiting" | "active" | "done" | "failed" | "skipped";

export const PROGRESS_STATE_TEXT: Record<ProgressState, string> = {
  waiting: "기다리는 중",
  active: "지금 하는 중",
  done: "끝났어요",
  failed: "하지 못했어요",
  skipped: "건너뛰었어요",
};

export interface ProgressStep {
  actor: string;
  label: string;
  state: ProgressState;
  recovered: boolean; // 중간에 실패했지만 재시도·다른 AI로 끝냄
}

/** Trace → 다섯 단계의 상태. 그 담당자의 마지막 사건으로 정한다 (검토 RETRY로 다시 쓰면 "지금 하는 중"으로 돌아간다). */
export function progressOf(trace: TraceEvent[]): ProgressStep[] {
  return PROGRESS_STEPS.map(({ actor, label }) => {
    const mine = trace.filter((e) => e.actor === actor);
    const last = mine[mine.length - 1];
    let state: ProgressState = "waiting";
    if (last) {
      if (last.action === "agent_completed") state = "done";
      else if (last.action === "agent_skipped") state = "skipped";
      else if (isGiveUp(last)) state = "failed";
      else state = "active";
    }
    return { actor, label, state, recovered: attemptHistory(trace, actor).recovered };
  });
}

/**
 * 자동 복구를 쉬운 문장으로 (신뢰 패널 둘째 줄·진행 표시, docs/tasks/04-autohealing.md T4-11).
 * 다른 모델로 바꿔 끝냈으면 "○○ AI가 늦어 다른 AI가 이어받았어요", 같은 모델로 다시 해서 끝냈으면 "한 번 더 시도해 끝냈어요",
 * 끝내 답하지 못했으면 "그 자료 없이 진행했어요". 주입한 실패도 같은 문장이다.
 */
export function recoverySentences(trace: TraceEvent[]): string[] {
  const out: string[] = [];
  for (const actor of new Set(trace.map((e) => e.actor))) {
    if (!(actor in WORKER_EASY_NAME)) continue;
    const h = attemptHistory(trace, actor);
    const name = workerEasyName(actor);
    const why = h.attempts.some((a) => a.outcome === "timeout") ? "늦어" : "제대로 답하지 못해";
    const switched = trace.some((e) => e.actor === actor && e.action === "agent_failover");
    if (h.recovered) out.push(switched ? `${name}가 ${why} 다른 AI가 이어받았어요` : `${name}가 ${why} 한 번 더 시도해 끝냈어요`);
    else if (h.gaveUp) out.push(`${name}가 끝내 답하지 못해 그 자료 없이 진행했어요`);
  }
  return out;
}

export interface ReportTargets {
  entry: number | null;
  target: number | null;
  stop: number | null;
  holdingDays: number | null;
  probability: number | null;
}

/** 리포트 작성 AI의 결과 (ReportDraft, docs/tasks/00-공통.md 10절). 모양이 틀린 값은 비우고 읽는다. */
export interface DraftView {
  verdict: ReportOpinion | null;
  oneLiner: string | null;
  plainSummary: string[];
  reasons: string[];
  risks: string[];
  citations: string[];
  targets: ReportTargets;
}

export function draftOf(state: Pick<SharedState, "results">): DraftView | null {
  const d = state.results.report_agent;
  if (!isObj(d)) return null;
  const t = isObj(d.targets) ? d.targets : {};
  const verdict = d.verdict === "buy" || d.verdict === "hold" || d.verdict === "avoid" ? d.verdict : null;
  return {
    verdict,
    oneLiner: text(d.oneLiner),
    plainSummary: texts(d.plainSummary, 3),
    reasons: texts(d.reasons, 3),
    risks: texts(d.risks, 3),
    citations: texts(d.citations, 10),
    targets: {
      entry: finite(t.entry),
      target: finite(t.target),
      stop: finite(t.stop),
      holdingDays: finite(t.holdingDays),
      probability: finite(t.probability),
    },
  };
}

/** 사는·목표·손절 가격이 0 < 손절 < 사는 가격 < 목표 순서인지 (추천으로 이어지는 조건과 같다). */
export function validTargets(t: ReportTargets): t is ReportTargets & { entry: number; target: number; stop: number } {
  return t.entry !== null && t.target !== null && t.stop !== null && 0 < t.stop && t.stop < t.entry && t.entry < t.target;
}

/** AI 의견: 완성된 리포트만. 서버의 opinion(B3)을 먼저, 없으면 완성된 결과의 verdict. */
export function opinionOf(r: Pick<ReportDetail, "status" | "opinion" | "state">): ReportOpinion | null {
  if (r.status !== "completed") return null;
  return r.opinion ?? draftOf(r.state)?.verdict ?? null;
}

/** 한 줄 요약: opinion과 같은 규칙. */
export function oneLinerOf(r: Pick<ReportDetail, "status" | "oneLiner" | "state">): string | null {
  if (r.status !== "completed") return null;
  return r.oneLiner ?? draftOf(r.state)?.oneLiner ?? null;
}

const SOURCE_TAIL = /\s*[([（]\s*(?:출처|근거)\s*[:：]\s*([^)\]）]+?)\s*[)\]）]\s*$/;

/** "… (출처: DART 반기보고서)"처럼 끝에 붙은 출처를 떼어 낸다. 없으면 source null. */
export function splitSource(line: string): { text: string; source: string | null } {
  const m = SOURCE_TAIL.exec(line);
  return m ? { text: line.slice(0, m.index).trim(), source: m[1].trim() } : { text: line, source: null };
}

const WRONG_HINT = /다시 (?:봐야|판단)|틀리|아래로|손절/;

/**
 * "이 의견이 틀리는 경우": 위험 중 프롬프트가 요구한 형식("○○원 아래로 내려가거나 … 다시 봐야 해요")에 맞는 하나.
 * 나머지 위험은 위험 목록에 그대로 둔다.
 */
export function whenWrongOf(draft: Pick<DraftView, "risks">): { risk: string | null; others: string[] } {
  const risk = draft.risks.find((x) => WRONG_HINT.test(x)) ?? null;
  return { risk, others: draft.risks.filter((x) => x !== risk) };
}

/** 이 리포트의 추천 중 화면에 쓸 하나: 아직 활성화할 수 있는(open) 것, 없으면 가장 최근 것. */
export function pickRecommendation(recs: Recommendation[] | undefined): Recommendation | null {
  if (!recs?.length) return null;
  return recs.find((x) => x.status === "open") ?? recs[0];
}

export interface ScenarioView {
  basis: "account" | "share"; // account: 리스크 미리 보기 금액(이 계좌·수량 기준), share: 1주 기준 비율(비용 전)
  gain: string; // 목표에 닿으면
  loss: string; // 손절에 닿으면
  quantity: number | null;
  holdingDays: number | null;
  asOf: string | null; // 미리 보기의 종가 기준 시각
}

/**
 * 시나리오 세 칸 (docs/컨셉변경계획.md 5장, LLM 숫자 없음). 목표·손절이 맞지 않으면 null.
 * 리포트의 추천이 있고 안전장치가 1주 이상을 정했으면 그 금액(비용 반영), 아니면 1주 기준 비율(비용 전).
 */
export function scenarioOf(targets: ReportTargets, preview: RiskPreview | null | undefined, holdingDays: number | null): ScenarioView | null {
  if (!validTargets(targets)) return null;
  const days = holdingDays ?? targets.holdingDays;
  if (preview && preview.quantity > 0) {
    return {
      basis: "account",
      gain: formatSignedKrw(preview.expectedProfitKrw),
      loss: formatSignedKrw(-Math.abs(preview.maxLossKrw)),
      quantity: preview.quantity,
      holdingDays: days,
      asOf: preview.lastPriceAsOf,
    };
  }
  return {
    basis: "share",
    gain: formatRate(targets.target / targets.entry - 1),
    loss: formatRate(targets.stop / targets.entry - 1),
    quantity: null,
    holdingDays: days,
    asOf: null,
  };
}

/** 신뢰 패널 (docs/컨셉변경계획.md 5장): 검토 통과 · 인용 수 · 자료 기준 시각 / 자동 복구 문장. 점수·고쳐 쓴 횟수는 펼친 곳에. */
export interface TrustInfo {
  reviewed: boolean; // 검토 AI가 PASS
  score: number | null;
  rewrites: number; // 검토 RETRY → 다시 쓴 횟수
  citations: number;
  dataAt: string | null; // 시세 AI가 자료를 받은 시각 (market_agent의 agent_completed.at)
  recovery: string[];
}

export function trustOf(state: Pick<SharedState, "results">, trace: TraceEvent[]): TrustInfo {
  const review = isObj(state.results.review_agent) ? state.results.review_agent : null;
  const lastOf = (actor: string) => [...trace].reverse().find((e) => e.actor === actor && e.action === "agent_completed");
  const reviewEvent = lastOf("review_agent");
  const verdict = text(review?.verdict) ?? text(reviewEvent?.details.verdict);
  return {
    reviewed: verdict === "PASS",
    score: finite(review?.score) ?? finite(reviewEvent?.details.score),
    rewrites: trace.filter((e) => e.action === "review_retry").length,
    citations: draftOf(state)?.citations.length ?? 0,
    dataAt: lastOf("market_agent")?.at ?? null,
    recovery: recoverySentences(trace),
  };
}

/** "10월 5일(월) 14:02 자료" (자료 기준 시각, 한국 시간). */
export function dataTimeText(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return "자료 시각 모름";
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    hourCycle: "h23",
    month: "numeric",
    day: "numeric",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(iso))) {
    p[x.type] = x.value;
  }
  return `${p.month}월 ${p.day}일(${p.weekday}) ${p.hour}:${p.minute} 자료`;
}

export interface MarketView {
  summary: string | null;
  price: number | null; // 장마감 기준 종가 (MarketResult.price)
  changePct: number | null;
  asOf: string | null;
  rsi: number | null;
  volatilityPct: number | null;
  signals: string[];
}

export interface FundamentalView {
  summary: string | null;
  per: number | null;
  pbr: number | null;
  roe: number | null;
  revenueGrowthPct: number | null;
  opMarginPct: number | null;
  filings: { date: string | null; title: string }[];
}

export interface NewsView {
  summary: string | null;
  headlines: { date: string | null; title: string; source: string | null }[];
}

/** 조사 AI 세 곳의 결과 (MarketResult·FundamentalResult·NewsResult). 없으면 null. */
export function researchOf(state: Pick<SharedState, "results">): { market: MarketView | null; fundamental: FundamentalView | null; news: NewsView | null } {
  const m = state.results.market_agent;
  const f = state.results.fundamental_agent;
  const n = state.results.news_agent;
  const metrics = isObj(f) && isObj(f.metrics) ? f.metrics : {};
  const rows = (v: unknown) => (Array.isArray(v) ? v.filter(isObj) : []);
  return {
    market: isObj(m)
      ? {
          summary: text(m.summary),
          price: finite(m.price),
          changePct: finite(m.changePct),
          asOf: text(m.asOf),
          rsi: finite(m.rsi),
          volatilityPct: finite(m.volatilityPct),
          signals: texts(m.signals, 5),
        }
      : null,
    fundamental: isObj(f)
      ? {
          summary: text(f.summary),
          per: finite(metrics.per),
          pbr: finite(metrics.pbr),
          roe: finite(metrics.roe),
          revenueGrowthPct: finite(metrics.revenueGrowthPct),
          opMarginPct: finite(metrics.opMarginPct),
          filings: rows(f.recentFilings)
            .map((x) => ({ date: text(x.date), title: text(x.title) ?? "" }))
            .filter((x) => x.title)
            .slice(0, 5),
        }
      : null,
    news: isObj(n)
      ? {
          summary: text(n.summary),
          headlines: rows(n.headlines)
            .map((x) => ({ date: text(x.date), title: text(x.title) ?? "", source: text(x.source) }))
            .filter((x) => x.title)
            .slice(0, 5),
        }
      : null,
  };
}

/** 단계 막대 ① 만들기 ② 검토 ③ 실행 (docs/컨셉변경계획.md 3장 "단계 막대의 뜻"). */
export const STEP_LABELS = ["만들기", "검토", "실행"] as const;
export type StepState = "done" | "current" | "todo" | "failed";

export const STEP_STATE_TEXT: Record<StepState, string> = { done: "끝남", current: "지금 단계", todo: "아직", failed: "멈춤" };

/** executed: 이 리포트의 계획으로 내 모의 자동매매가 시작됐는지. */
export function stepsOf(status: ReportStatus, executed: boolean): StepState[] {
  if (status === "failed") return ["failed", "todo", "todo"];
  if (status !== "completed") return ["current", "todo", "todo"];
  return executed ? ["done", "done", "done"] : ["done", "current", "todo"];
}

/** 진행 화면의 예상 시간: 최근 완성 리포트(최대 take개)의 시작~끝 시간 중앙값. 3건 미만이면 null (docs/컨셉변경계획.md 4-6). */
export function typicalDurationMs(reports: Pick<ReportSummary, "status" | "startedAt" | "finishedAt">[], take = 10): number | null {
  const ms = reports
    .filter((r) => r.status === "completed" && r.startedAt && r.finishedAt)
    .map((r) => ({ end: Date.parse(r.finishedAt ?? ""), start: Date.parse(r.startedAt ?? "") }))
    .filter((x) => Number.isFinite(x.end) && Number.isFinite(x.start) && x.end >= x.start)
    .sort((a, b) => b.end - a.end)
    .slice(0, take)
    .map((x) => x.end - x.start)
    .sort((a, b) => a - b);
  if (ms.length < 3) return null;
  const mid = Math.floor(ms.length / 2);
  return ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2;
}

export const durationSentence = (ms: number): string => `지난 리포트들은 보통 ${Math.max(1, Math.round(ms / 60_000))}분쯤 걸렸어요`;

/** 리포트 목록 카드의 상태 (대기 중·만드는 중·완성·실행 가능·만들지 못함). ready = 완성 + 활성화할 수 있는 계획이 있음. */
export type ReportCardStatus = ReportStatus | "ready";

export function reportCardStatus(status: ReportStatus, hasOpenPlan: boolean): ReportCardStatus {
  return status === "completed" && hasOpenPlan ? "ready" : status;
}

export const REPORT_CARD_TEXT: Record<ReportCardStatus, { label: string; sentence: string; chip: string; icon: IconName }> = {
  requested: { label: REPORT_STATUS_TEXT.requested.easy, sentence: "만들 차례를 기다리고 있어요", chip: "bg-fill text-sub", icon: "clock" },
  running: { label: REPORT_STATUS_TEXT.running.easy, sentence: "AI 담당자들이 조사하고 쓰는 중이에요", chip: "bg-brand-soft text-brand-dark", icon: "play" },
  completed: { label: REPORT_STATUS_TEXT.completed.easy, sentence: "다 만들었어요. 결론과 근거를 읽을 수 있어요", chip: "bg-ok-soft text-ok", icon: "check" },
  ready: { label: "실행 가능", sentence: "이 리포트에서 나온 모의 자동매매 계획이 있어요", chip: "bg-brand text-white", icon: "play" },
  failed: { label: REPORT_STATUS_TEXT.failed.easy, sentence: REPORT_FAILURE_FALLBACK, chip: "bg-up-soft text-up", icon: "close" },
};

/** 하루 리포트 한도 문장 ("오늘 ○번 더 만들 수 있어요", D-7). */
export function quotaSentence(q: Pick<ReportQuota, "remaining">): string {
  return q.remaining > 0 ? `오늘 ${q.remaining}번 더 만들 수 있어요` : "오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요";
}

/** 교차검증 분석 카드의 쉬운 표기 (D-1: 과정은 두 모드 모두, 점수·확률은 전문가 보기에서만). */
export const CROSS_CHECK_TEXT: Record<AnalysisSummary["verdict"], { badge: string; line: string }> = {
  BUY: { badge: "승인된 계획 있음", line: "여러 AI가 각자 계획을 내고 서로 검증했어요. 최종 승인을 통과한 계획이 있어요" },
  PASS: { badge: "승인된 계획 없음", line: "여러 AI가 각자 계획을 내고 서로 검증했어요. 최종 승인을 통과한 계획이 없어요" },
};
