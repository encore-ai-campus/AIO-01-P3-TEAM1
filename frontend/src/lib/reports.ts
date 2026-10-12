// AI 리포트 화면의 표시 규칙: 상태 이름·색, Trace에서 노드 상태 읽기, 실패 정책 설명 (docs/교육용문서.md 그대로).
// 아래쪽 "쉬운 보기" 절은 주린이모드 화면(components/reports/easy/*)이 결과·Trace·리스크 미리 보기에서 문장을 만드는 순수 함수다.
import type {
  AnalysisSummary,
  Currency,
  ErrorType,
  ExecutionPlan,
  FailurePolicy,
  QuoteBasis,
  RecommendationExpiredReason,
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
import type { PlanCardState } from "../components/plan/PlanCard";
import { countWord, isTodayKst } from "./autotrade";
import { formatPercent, formatPrice, formatRate, formatSignedKrw } from "./format";
import { REPORT_FAILURE_FALLBACK, REPORT_STATUS_TEXT, priceExpiredText } from "./plainText";
import { attemptHistory, isGiveUp } from "./recovery";

export const NOT_IMPLEMENTED = "Agent 실행은 아직 구현되지 않았습니다. 신청은 기록되고 구조만 볼 수 있습니다.";

/** 매매 종목 선정 팀 (하루 한 번 자동으로 돈다). 종목 리포트가 아니라 의견·PDF·추천·쉬운 보기가 없다. */
export const SELECTION_TEAM = "stock_selection";

/** 리포트(요약·상세)나 실행 계획이 선정 팀 것인지. team이 없으면(예전 서버) 종목 리포트다. */
export const isSelection = (x: { team?: string | null } | null | undefined): boolean => x?.team === SELECTION_TEAM;

/** 그래프 노드 상태: Trace에서 그 actor의 마지막 사건 status. 사건이 없으면 대기. */
export type NodeStatus = "waiting" | TraceStatus;

interface Look {
  label: string;
  icon: IconName;
  chip: string; // 배지 색
  border: string; // 노드 테두리
}

// 상태는 색만으로 구분하지 않는다 (아이콘 + 글자를 같이 쓴다). 글자색은 연한 바탕 위 글자용 *-ink 토큰 (다크에서도 읽히게)
export const NODE_STATUS: Record<NodeStatus, Look> = {
  waiting: { label: "대기", icon: "circle", chip: "bg-fill text-mute", border: "border-line" },
  started: { label: "실행 중", icon: "play", chip: "bg-brand-soft text-brand-ink", border: "border-brand" },
  completed: { label: "완료", icon: "check", chip: "bg-ok-soft text-ok-ink", border: "border-ok" },
  failed: { label: "실패", icon: "close", chip: "bg-up-soft text-up-ink", border: "border-up" },
  blocked: { label: "차단", icon: "ban", chip: "bg-warn-soft text-warn-ink", border: "border-warn" },
  skipped: { label: "건너뜀", icon: "skip", chip: "bg-fill text-sub", border: "border-dashed border-mute" },
};

export const REPORT_STATUS: Record<ReportStatus, Omit<Look, "border">> = {
  requested: { label: "신청됨", icon: "clock", chip: "bg-fill text-sub" },
  running: { label: "실행 중", icon: "play", chip: "bg-brand-soft text-brand-ink" },
  completed: { label: "완료", icon: "check", chip: "bg-ok-soft text-ok-ink" },
  failed: { label: "실패", icon: "close", chip: "bg-up-soft text-up-ink" },
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

/** 타임라인 문장의 주어: 선정 팀이면 "선정", 아니면 "리포트". */
const what = (plan: ExecutionPlan | undefined) => (isSelection(plan) ? "선정" : "리포트");

/** 사건 하나를 문장으로. 모르는 action은 null (화면이 action 코드를 그대로 보인다). */
export function eventText(e: TraceEvent, plan: ExecutionPlan | undefined): EventText | null {
  const d = e.details;
  const model = e.model ? ` (${e.model})` : "";
  const injected = d.injected === true ? ["주입"] : [];
  switch (e.action) {
    case "workflow_started":
      return { text: `${what(plan)} 실행 시작${d.chaos === true ? " · 장애 주입 켜짐" : ""}`, tone: "info", icon: "play", tags: [] };
    case "workflow_completed":
      return { text: isSelection(plan) ? "선정 완료" : "리포트 완성", tone: "ok", icon: "check", tags: [] };
    case "workflow_failed":
      return { text: `${what(plan)} 실패${str(d.reason) ? ` — ${str(d.reason)}` : ""}`, tone: "fail", icon: "close", tags: [] };
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

// ---------------------------------------------------------------- 쉬운 보기 (주린이모드 켬) — docs/plans/컨셉변경계획.md 4-2·4-4·5장·6장
// 화면 문구와 숫자는 코드가 만든다. LLM이 쓴 문장은 plainSummary·oneLiner·reasons·risks뿐이고, 금액은 리스크 미리 보기 값이다.
// 주어를 밝히고("AI 의견", "검토 AI", "안전장치"), 권유·명령형을 쓰지 않는다 (docs/API.md "금지 표현").

const KST = "Asia/Seoul";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const text = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const texts = (v: unknown, max: number): string[] =>
  Array.isArray(v) ? v.map(text).filter((x): x is string => x !== null).slice(0, max) : [];

// 쉬운 PDF(backend/reports/output/easy_text.py)도 같은 문장을 쓴다 — 바꾸면 둘 다 고친다
/** AI 담당자(Worker)의 쉬운 이름 ("Agent" 대신). 모르는 id는 "AI 담당자". */
export const WORKER_EASY_NAME: Record<string, string> = {
  market_agent: "시세를 보는 AI",
  fundamental_agent: "재무제표를 읽는 AI",
  news_agent: "뉴스를 읽는 AI",
  report_agent: "리포트를 쓰는 AI",
  review_agent: "검토 AI",
  risk_agent: "위험을 점검하는 AI",
  // 매매 종목 선정 팀 (stock_selection)
  news_screen_agent: "후보 뉴스를 보는 AI",
  filing_screen_agent: "후보 공시를 보는 AI",
  flow_agent: "수급을 보는 AI",
  selector_agent: "종목을 고르는 AI",
  selection_review_agent: "선정을 검토하는 AI",
};

export const workerEasyName = (id: string): string => WORKER_EASY_NAME[id] ?? "AI 담당자";

export interface ProgressStepDef {
  actor: string;
  label: string;
  noun: string;
}

/**
 * 쉬운 진행 표시 다섯 단계 (docs/plans/컨셉변경계획.md 4-2 "시세를 보는 중 → … → 검토하는 중").
 * noun: 진행형이 어색한 자리(실패 화면의 "어디서 멈췄는지")에 쓰는 명사형 이름.
 */
export const PROGRESS_STEPS: readonly ProgressStepDef[] = [
  { actor: "market_agent", label: "시세를 보는 중", noun: "시세 보기" },
  { actor: "fundamental_agent", label: "재무제표를 읽는 중", noun: "재무제표 읽기" },
  { actor: "news_agent", label: "뉴스를 읽는 중", noun: "뉴스 읽기" },
  { actor: "report_agent", label: "리포트를 쓰는 중", noun: "리포트 쓰기" },
  { actor: "review_agent", label: "검토하는 중", noun: "검토" },
];

/** 매매 종목 선정 팀의 단계: 후보 조사(뉴스·공시·수급, 함께 돈다) → 종목 고르기 → 선정 검토. */
export const SELECTION_PROGRESS_STEPS: readonly ProgressStepDef[] = [
  { actor: "news_screen_agent", label: "후보 뉴스를 보는 중", noun: "후보 뉴스 보기" },
  { actor: "filing_screen_agent", label: "후보 공시를 보는 중", noun: "후보 공시 보기" },
  { actor: "flow_agent", label: "수급을 보는 중", noun: "수급 보기" },
  { actor: "selector_agent", label: "종목을 고르는 중", noun: "종목 고르기" },
  { actor: "selection_review_agent", label: "선정을 검토하는 중", noun: "선정 검토" },
];

/** 팀의 쉬운 진행 단계 (team이 없으면 종목 리포트). */
export const progressStepsOf = (team?: string | null): readonly ProgressStepDef[] =>
  team === SELECTION_TEAM ? SELECTION_PROGRESS_STEPS : PROGRESS_STEPS;

/** 검토 단계 담당자 (검토 실패는 그 단계에서 멈췄다). */
const REVIEW_ACTORS = new Set(["review_agent", "selection_review_agent"]);

/** again: 검토 AI가 고쳐 쓰게 해(RETRY) 고친 글을 다시 볼 차례 — 끝남 표시를 지운다 (처음부터 기다리는 단계처럼 보이지 않게 따로 둔다). */
export type ProgressState = "waiting" | "active" | "done" | "failed" | "skipped" | "again";

export const PROGRESS_STATE_TEXT: Record<ProgressState, string> = {
  waiting: "기다리는 중",
  active: "지금 하는 중",
  done: "끝났어요",
  failed: "하지 못했어요",
  skipped: "건너뛰었어요",
  again: "고친 글을 다시 봐요",
};

/** 검토 RETRY로 다시 쓰는(고르는) 단계 아래의 한 줄 (팀별). */
export const REWRITE_NOTE: Record<string, string> = {
  stock_report: "검토 AI가 고쳐 쓰라고 해서 다시 쓰는 중이에요",
  [SELECTION_TEAM]: "선정을 검토하는 AI가 다시 고르라고 해서 다시 고르는 중이에요",
};
export const rewriteNoteOf = (team?: string | null): string => REWRITE_NOTE[team === SELECTION_TEAM ? SELECTION_TEAM : "stock_report"];

export interface ProgressStep {
  actor: string;
  label: string;
  state: ProgressState;
  recovered: boolean; // 중간에 실패했지만 재시도·다른 AI로 끝냄
  rewriting: boolean; // 검토 AI가 고쳐 쓰게 해 다시 하는 중 (화면이 이 단계 아래에 REWRITE_NOTE를 보인다)
}

/** 검토 결과가 다시 쓰기(RETRY)였는지 (검토 담당자의 agent_completed.details.verdict). */
const isRetryVerdict = (e: TraceEvent | undefined) => e?.action === "agent_completed" && REVIEW_ACTORS.has(e.actor) && e.details.verdict === "RETRY";

/**
 * Trace → 팀의 단계별 상태 (종목 리포트는 다섯 단계). 그 담당자의 마지막 사건으로 정한다.
 * 검토 RETRY: 검토 단계는 '끝났어요' 대신 '고친 글을 다시 봐요'(again), 다시 쓰는 단계는 마지막 review_retry 뒤에 끝나기 전까지
 * '지금 하는 중' + rewriting — 끝난 단계가 아무 말 없이 '지금 하는 중'으로 돌아가 보이지 않게 까닭을 같이 보인다.
 * team: 리포트의 팀 (없으면 종목 리포트).
 */
export function progressOf(trace: TraceEvent[], team?: string | null): ProgressStep[] {
  let retryAt = -1;
  for (let i = trace.length - 1; i >= 0; i--) {
    if (trace[i].action === "review_retry") {
      retryAt = i;
      break;
    }
  }
  const retryTarget = retryAt >= 0 ? str(trace[retryAt].details.target) : "";
  return progressStepsOf(team).map(({ actor, label }) => {
    const mine = trace.filter((e) => e.actor === actor);
    const last = mine[mine.length - 1];
    let state: ProgressState = "waiting";
    if (last) {
      if (isRetryVerdict(last)) state = "again";
      else if (last.action === "agent_completed") state = "done";
      else if (last.action === "agent_skipped") state = "skipped";
      else if (isGiveUp(last)) state = "failed";
      else state = "active";
    }
    // 다시 쓰라는 지시(review_retry) 뒤에 아직 다시 끝내지 못한 단계: 시작 전이라도 '지금 하는 중' (지시를 받았다)
    let rewriting = false;
    if (actor === retryTarget && state !== "failed") {
      const doneAfter = trace.slice(retryAt + 1).some((e) => e.actor === actor && e.action === "agent_completed");
      if (!doneAfter) {
        state = "active";
        rewriting = true;
      }
    }
    return { actor, label, state, recovered: attemptHistory(trace, actor).recovered, rewriting };
  });
}

/** 끝난 단계 수 (끝났어요·건너뛰었어요·하지 못했어요 — 더 기다릴 일이 없는 단계). */
export const progressDone = (steps: readonly ProgressStep[]): number =>
  steps.filter((s) => s.state !== "waiting" && s.state !== "active" && s.state !== "again").length;

/**
 * 진행 막대 값: 지금까지 끝난 단계 수의 최댓값. 검토 RETRY로 '리포트를 쓰는 중'이 다시 시작돼도 막대가 뒤로 가지 않게
 * (사건 목록은 늘어나기만 하므로 앞에서부터 잘라 세면 된다 — 사건은 많아야 수십 개).
 */
export function progressPeak(trace: TraceEvent[], team?: string | null): number {
  let peak = 0;
  for (let i = 1; i <= trace.length; i++) peak = Math.max(peak, progressDone(progressOf(trace.slice(0, i), team)));
  return peak;
}

/**
 * 진행 표시를 화면 읽기 프로그램에 알리는 한 줄 (보이는 글자와 겹치지 않게 따로 만든다).
 * done: 진행 막대에 보이는 끝난 단계 수 (없으면 지금 끝난 수) — 막대와 알림이 다른 숫자를 말하지 않게.
 * rewriteNote: 검토 RETRY로 다시 하는 단계면 덧붙일 한 줄 (rewriteNoteOf).
 */
export function progressAnnouncement(steps: readonly ProgressStep[], done: number = progressDone(steps), rewriteNote?: string): string {
  const active = steps.find((s) => s.state === "active");
  if (active) return `지금: ${active.label} (${done}/${steps.length})${active.rewriting && rewriteNote ? ` · ${rewriteNote}` : ""}`;
  return done === steps.length ? `${countWord(steps.length)} 단계를 모두 끝냈어요 (${done}/${steps.length})` : `진행 ${done}/${steps.length}`;
}

/**
 * 실패한 리포트가 멈춘 단계 (실패 화면의 "어디서 멈췄는지"). 검토 실패는 검토, Join 차단 등은 처음으로 실패한 단계.
 * 시간 초과·엔진 재시작·예외는 그때 하던 단계에서 멈췄다 — 먼저 포기한 선택 담당자(뉴스 등)가 있어도 하던 단계가 먼저다.
 * agent_failed·timeout은 trace를 주면 마지막으로 포기한(agent_failed final) 담당자의 단계다.
 * 세 조사 단계는 함께(병렬) 돌므로 순서가 진행 순서가 아니다: 다른 단계의 상태는 화면이 단계마다 따로 보인다(EasyFailure).
 */
export function stoppedStepIndex(steps: readonly ProgressStep[], reason: string | null, trace?: readonly TraceEvent[]): number {
  if (reason === "review_failed") return steps.findIndex((s) => REVIEW_ACTORS.has(s.actor));
  // 필수 AI의 포기·시간 초과로 멈췄으면 마지막으로 포기한 담당자가 멈춘 곳이다 (먼저 포기한 선택 담당자 — 뉴스 등 — 가 아니라)
  if (trace && (reason === "agent_failed" || reason === "timeout")) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const k = isGiveUp(trace[i]) ? steps.findIndex((s) => s.actor === trace[i].actor) : -1;
      if (k >= 0) return k;
    }
  }
  const first = (state: ProgressState) => steps.findIndex((s) => s.state === state);
  const cutOff = reason === "timeout" || reason === "engine_restarted" || reason === "exception";
  for (const state of cutOff ? (["active", "failed", "waiting"] as const) : (["failed", "active", "waiting"] as const)) {
    const i = first(state);
    if (i >= 0) return i;
  }
  return steps.length - 1;
}

/** 실패 사유별 다음 행동 한 줄 (쉬운 보기). 권유·명령형 없이 할 수 있는 일을 말한다. */
export const FAILURE_NEXT: Record<string, string> = {
  review_failed: "검토 AI가 근거와 맞지 않는 내용을 걸러낸 거예요. 다시 만들면 처음부터 새로 조사해요",
  join_blocked: "자료가 다 모이지 않으면 리포트를 쓰지 않아요. 잠시 뒤 다시 만들 수 있어요",
  timeout: "일시적인 문제일 수 있어요. 잠시 뒤 다시 만들 수 있어요",
  engine_restarted: "일시적인 문제일 수 있어요. 잠시 뒤 다시 만들 수 있어요",
  exception: "일시적인 문제일 수 있어요. 잠시 뒤 다시 만들 수 있어요",
  agent_failed: "일시적인 문제일 수 있어요. 잠시 뒤 다시 만들 수 있어요",
  no_llm: "관리자가 AI 연결을 설정하면 다시 만들 수 있어요",
  expired: "기다리는 동안 실행되지 않은 신청이에요. 지금 다시 만들 수 있어요",
};
export const FAILURE_NEXT_FALLBACK = "다시 만들면 처음부터 새로 조사해요";

/** 실패 사유별 둘째 문장 (전문가 보기). 모르는 사유는 예전 문장. */
export const EXPERT_FAILURE_NOTE: Record<string, string> = {
  join_blocked: "필수 Worker 결과가 없어 Join Guard가 막았습니다. 실패한 Agent는 “진행 기록” 탭에서 볼 수 있습니다.",
  review_failed: "검토 Agent가 FAIL 판정을 냈습니다. 지적 사항은 “진행 기록” 탭에서 볼 수 있습니다.",
  timeout: "제한 시간을 넘겨 중단했습니다. 일시적인 문제일 수 있습니다.",
  engine_restarted: "엔진이 다시 시작돼 중단했습니다. 일시적인 문제일 수 있습니다.",
  exception: "예상하지 못한 예외로 중단했습니다. 마지막 사건은 “진행 기록” 탭에서 볼 수 있습니다.",
  agent_failed: "필수 Agent가 재시도와 대체 모델로도 답하지 못해 중단했습니다. 실패한 Agent는 “진행 기록” 탭에서 볼 수 있습니다.",
  no_llm: "LLM 연결 설정(DEVPASS_APIKEY)이 없어 Agent를 실행하지 않았습니다.",
  expired: "24시간 넘게 실행을 기다린 신청이라 실행기가 실행하지 않고 끝냈습니다.",
};
export const EXPERT_FAILURE_FALLBACK = "재시도와 대체 모델로도 복구하지 못했습니다. 어느 모델이 실패했는지는 “진행 기록” 탭에서 볼 수 있습니다.";

// 쉬운 PDF(backend/reports/output/easy_text.py recovery_sentences)도 같은 규칙·문장을 쓴다 — 바꾸면 둘 다 고친다
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
  // AI가 쓴 글은 그리기 전에 다듬는다 (쉼표 없는 금액·의견 영어 — cleanReportText)
  return {
    verdict,
    oneLiner: cleanOrNull(text(d.oneLiner)),
    plainSummary: texts(d.plainSummary, 3).map(cleanReportText),
    reasons: texts(d.reasons, 3).map(cleanReportText),
    risks: texts(d.risks, 3).map(cleanReportText),
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
  return r.oneLiner !== null && r.oneLiner !== undefined ? cleanReportText(r.oneLiner) : (draftOf(r.state)?.oneLiner ?? null);
}

// 아래 근거·'틀리는 경우' 함수(splitSource ~ withoutPriceClause)는 쉬운 PDF(backend/reports/output/easy_text.py)가 그대로 옮겨 쓴다 — 바꾸면 둘 다 고친다
const SOURCE_TAIL = /\s*[([（]\s*(?:출처|근거)\s*[:：]\s*([^)\]）]+?)\s*[)\]）]\s*$/;

/** "… (출처: DART 반기보고서)"처럼 끝에 붙은 출처를 떼어 낸다. 없으면 source null. */
export function splitSource(line: string): { text: string; source: string | null } {
  const m = SOURCE_TAIL.exec(line);
  return m ? { text: line.slice(0, m.index).trim(), source: m[1].trim() } : { text: line, source: null };
}

const WRONG_HINT = /다시 (?:봐야|판단)|틀리|아래로|손절/;

/**
 * "이 의견이 틀리는 경우": 위험 중 프롬프트가 요구한 형식("○○원 아래로 내려가거나 … 다시 봐야 해요")에 맞는 하나.
 * 나머지 위험은 위험 목록에 그대로 둔다. opinion이 긍정적(buy)이 아니면 '손절'이 든 위험은 옮기지 않는다 — 그 의견에는 손절 가격이 없다.
 */
export function whenWrongOf(draft: Pick<DraftView, "risks">, opinion?: ReportOpinion | null): { risk: string | null; others: string[] } {
  const noStop = opinion !== undefined && opinion !== "buy";
  const risk = draft.risks.find((x) => WRONG_HINT.test(x) && !(noStop && x.includes("손절"))) ?? null;
  return { risk, others: draft.risks.filter((x) => x !== risk) };
}

/** 호가 단위 (국내는 가격대별, 미국은 1센트) — 문장 속 금액이 손절 가격과 같은 가격인지 볼 때 반올림 차이를 허용하려고. */
function tickOf(price: number, currency: Currency): number {
  if (currency === "USD") return 0.01;
  return price < 2_000 ? 1 : price < 5_000 ? 5 : price < 20_000 ? 10 : price < 50_000 ? 50 : price < 200_000 ? 100 : price < 500_000 ? 500 : 1_000;
}

/** 가격 하나를 호가 단위로 내린다 — 엔진 paper_engine/data/ticks.py round_price(up=False)와 같은 계산 (국내 가격대별 단위, 미국 1달러 이상 0.01·미만 0.0001). */
function floorPrice(price: number, currency: Currency): number {
  if (currency === "KRW") {
    const tick = tickOf(price, currency);
    return Math.floor(Number((price / tick).toFixed(6))) * tick;
  }
  const scale = price >= 1 ? 100 : 10_000;
  return Math.floor(Number((price * scale).toFixed(6))) / scale;
}

/**
 * 리포트가 제안한 사는·목표·손절 가격을 추천이 저장하는 값으로 (호가 단위 내림, 0 이하·없는 값은 그대로 — autotrade.recommend.sources.create와 같다).
 * 추천이 아직 없을 때 쉬운 보기가 이 값으로 계획 판단·세 가지 경우·차트·'틀리는 경우'의 손절 문장을 그린다 — 쉬운 PDF(easy_text.tick_prices)와 같은 숫자.
 */
export function floorTargets(targets: ReportTargets, currency: Currency): ReportTargets {
  const floor = (v: number | null) => (v !== null && v > 0 ? floorPrice(v, currency) : v);
  return { ...targets, entry: floor(targets.entry), target: floor(targets.target), stop: floor(targets.stop) };
}

/**
 * 문장 속 가격 한 개의 모양 (그 통화만): 국내 "66,000원"·"66000 원"·"66,000원선", 미국 "$110.00". 숫자가 첫 번째 묶음이다.
 * '1조원'·'500억 원'·'원/달러'·'원자재'처럼 숫자 바로 뒤가 '원'이 아니거나 숫자가 없는 말은 가격이 아니다.
 */
const priceSource = (currency: Currency) => (currency === "USD" ? String.raw`\$\s*(\d[\d,]*(?:\.\d+)?)` : String.raw`(\d[\d,]*(?:\.\d+)?)\s*원선?`);

/** 금액(문장 속 숫자 그대로)이 손절 가격과 같은 가격인지. AI가 반올림해 적을 수 있어 호가 두 칸까지 같다고 본다. */
function isStopPrice(raw: string, stop: number, currency: Currency): boolean {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) && Math.abs(n - stop) <= 2 * tickOf(stop, currency) + 1e-9;
}

/** 손절 가격을 이름으로 부르는 말 ("손절 가격"·"손절가"·"손절선"). "손절 매물"·"손절 가능성"은 가격이 아니다. */
const STOP_WORD = String.raw`손절\s*(?:가격|선|라인|가(?!능))`;

/** 문장이 손절 가격을 말하는지: 손절 가격이라고 부르거나, 손절 가격과 같은 금액(호가 두 칸 안)이 있다. */
function mentionsStop(line: string, stop: number, currency: Currency): boolean {
  if (new RegExp(STOP_WORD).test(line)) return true;
  return [...line.matchAll(new RegExp(priceSource(currency), "g"))].some((m) => isStopPrice(m[1], stop, currency));
}

/**
 * 손절 가격만 말하는 '틀리는 경우' 문장인지 ("손절 가격(66,000원) 아래로 내려가면 다시 봐야 한다"). 그런 문장은 코드가 만든 손절 문장과
 * 같은 뜻이라 숨긴다. 손절 가격과 다른 금액(환율 1,450원·매출 1조원·다른 가격)이거나 '거나·또는·나오면·발표'처럼 다른 조건이 붙어 있으면
 * 새 정보라 그대로 보인다 — 글자 '원'만으로는 정하지 않는다(원자재·원/달러·회원).
 */
export function priceOnlyRisk(line: string, stop: number, currency: Currency): boolean {
  return mentionsStop(line, stop, currency) && !/거나|또는|나오면|발표/.test(line);
}

/**
 * '66,000원 아래로 내려가거나 …'처럼 앞에 붙은 손절 가격 조건을 뗀다. 코드가 만든 손절 문장이 이미 그 가격을 말하므로
 * 같은 가격을 두 번 보이지 않고 다른 조건만 남긴다. 떼는 것은 그 금액이 손절 가격(호가 두 칸 안)이거나 '손절 가격'이라고 부를 때뿐이다 —
 * '광고 매출이 1조원 아래로 떨어지거나'·'70,000원(손절 가격과 다른 값) 아래로 내려가거나'는 다른 조건이라 그대로 둔다.
 * 앞에 또 다른 조건(…하면·…하고)이 있거나, 그런 모양이 아니거나, 남는 말이 너무 짧아도 그대로 둔다.
 */
export function withoutPriceClause(line: string, stop: number, currency: Currency): string {
  const clause = new RegExp(String.raw`^([^.]*?)(?:${priceSource(currency)}|${STOP_WORD})\)?\s*(?:아래|밑)으?로\s*(?:내려가|떨어지)거나,?\s*`);
  const m = clause.exec(line);
  if (!m || /거나|또는|면\s|고\s|며\s/.test(m[1])) return line;
  if (m[2] !== undefined && !isStopPrice(m[2], stop, currency)) return line;
  const rest = line.slice(m[0].length).trim();
  return rest.length >= 4 ? rest : line;
}

export interface ScenarioView {
  basis: "account" | "share"; // account: 리스크 미리 보기 금액(이 계좌·수량 기준), share: 1주 기준 비율(비용 전)
  gain: string; // 목표에 닿으면
  loss: string; // 손절에 닿으면
  quantity: number | null;
  holdingDays: number | null;
  asOf: string | null; // 미리 보기의 종가 기준 시각
  blocked: boolean; // 계좌 금액이지만 안전장치가 지금은 실행을 막은 계획 ("정했다"고 쓰지 않는다)
  expired: boolean; // 계획 기한이 끝나 계좌 금액 대신 비율로 보인다
}

/**
 * 시나리오 세 칸 (docs/plans/컨셉변경계획.md 5장, LLM 숫자 없음). 목표·손절이 맞지 않으면 null.
 * 리포트의 추천이 있고 안전장치가 1주 이상을 계산했으면 그 금액(비용 반영), 아니면 1주 기준 비율(비용 전).
 * plan: 매매 계획 카드와 같은 상태 — blocked면 금액은 그대로 두고(막힌 이유가 숫자로 보인다) 표시만 바꾸고, 기한이 지났으면 비율로.
 */
export function scenarioOf(
  targets: ReportTargets,
  preview: RiskPreview | null | undefined,
  holdingDays: number | null,
  plan?: PlanCardState | "loading" | null,
): ScenarioView | null {
  if (!validTargets(targets)) return null;
  const days = holdingDays ?? targets.holdingDays;
  if (preview && preview.quantity > 0 && plan !== "expired") {
    return {
      basis: "account",
      gain: formatSignedKrw(preview.expectedProfitKrw),
      loss: formatSignedKrw(-Math.abs(preview.maxLossKrw)),
      quantity: preview.quantity,
      holdingDays: days,
      asOf: preview.lastPriceAsOf,
      blocked: plan === "blocked",
      expired: false,
    };
  }
  return {
    basis: "share",
    gain: formatRate(targets.target / targets.entry - 1),
    loss: formatRate(targets.stop / targets.entry - 1),
    quantity: null,
    holdingDays: days,
    asOf: null,
    blocked: false,
    expired: plan === "expired",
  };
}

// 신뢰 패널(trustOf·dataTimeText)은 쉬운 PDF(backend/reports/output/easy_text.py trust_lines·data_time_text)도 같은 규칙·문장을 쓴다 — 바꾸면 둘 다 고친다
/** 신뢰 패널 (docs/plans/컨셉변경계획.md 5장): 검토 통과 · 인용 수 · 자료 기준 시각 / 자동 복구 문장. 점수·고쳐 쓴 횟수는 펼친 곳에. */
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
  price: number | null; // MarketResult.price — basis close면 장마감 기준 종가, live면 리포트를 만들 때의 장중 가격
  changePct: number | null;
  asOf: string | null;
  basis: QuoteBasis; // MarketResult.priceBasis (2026-10-08, docs/API.md "리포트 시세"). 없거나 다른 값이면 close (예전 결과)
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
          summary: cleanOrNull(text(m.summary)),
          price: finite(m.price),
          changePct: finite(m.changePct),
          asOf: text(m.asOf),
          basis: m.priceBasis === "live" ? "live" : "close",
          rsi: finite(m.rsi),
          volatilityPct: finite(m.volatilityPct),
          signals: texts(m.signals, 5),
        }
      : null,
    fundamental: isObj(f)
      ? {
          summary: cleanOrNull(text(f.summary)),
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
          summary: cleanOrNull(text(n.summary)),
          headlines: rows(n.headlines)
            .map((x) => ({ date: text(x.date), title: text(x.title) ?? "", source: text(x.source) }))
            .filter((x) => x.title)
            .slice(0, 5),
        }
      : null,
  };
}

/** 단계 막대 ① 만들기 ② 검토 ③ 실행 (docs/plans/컨셉변경계획.md 3장 "단계 막대의 뜻"). */
export const STEP_LABELS = ["만들기", "검토", "실행"] as const;
/** skipped: 이 리포트로는 실행할 계획이 없다 (③ 없음 — 할 일이 남은 것처럼 보이지 않게). */
export type StepState = "done" | "current" | "todo" | "failed" | "skipped";

export const STEP_STATE_TEXT: Record<StepState, string> = { done: "끝남", current: "지금 단계", todo: "아직", failed: "멈춤", skipped: "없음" };

/** 실행할 계획이 없는 매매 계획 상태 (지켜보기·부정적·계획 없음·기한 지남). 안전장치가 막은 것(blocked)은 나중에 풀릴 수 있어 넣지 않는다. */
const NO_PLAN_STATES = new Set<string>(["watch", "negative", "no_plan", "expired"]);

/**
 * executed: 이 리포트의 계획으로 내 모의 자동매매가 시작됐는지.
 * plan: 매매 계획 카드와 같은 상태(선택). 실행할 계획이 없으면 ③을 '없음'으로 둔다.
 */
export function stepsOf(status: ReportStatus, executed: boolean, plan?: PlanCardState | "loading" | null): StepState[] {
  if (status === "failed") return ["failed", "todo", "todo"];
  if (status !== "completed") return ["current", "todo", "todo"];
  if (executed) return ["done", "done", "done"];
  return ["done", "current", plan && NO_PLAN_STATES.has(plan) ? "skipped" : "todo"];
}

/**
 * 완성 화면 머리의 다음 행동 안내 (매매 계획 카드 상태별, docs/plans/컨셉변경계획.md 3장).
 * 준비 중·불러오는 중에는 없다 — 매매 계획 카드와 반대로 말하지 않게.
 * 실행할 계획이 없는 경우(지켜보기·부정적·계획 없음)도 없다: "실행할 계획이 없어요"는 매매 계획 카드 한 곳에서만 말한다 (UX-8 — 머리·결론·카드에서 세 번 되풀이했다).
 * 머리에서는 단계 막대 ③ '없음'이 같은 뜻을 보인다.
 * 카드의 자리를 말하지 않는다 ('아래' 아님): 모바일은 아래, PC는 오른쪽 열에 있다.
 * expiredReason: 기한이 아니라 가격이 이미 손절가·목표가를 지나 끝난 제안이면 그 까닭으로 말한다 (DECISIONS 25장).
 */
export function planGuide(plan: PlanCardState | "loading" | null | undefined, expiredReason?: RecommendationExpiredReason | null): string | null {
  switch (plan) {
    case "ready":
      return "결론과 손실 금액을 확인했으면 매매 계획 카드에서 실행 준비로 넘어가요.";
    case "blocked":
      return "안전장치가 지금은 실행을 막았어요. 이유는 매매 계획 카드에 있어요.";
    case "expired": {
      const price = priceExpiredText(expiredReason, true);
      return price ? `${price}.` : "계획 기한이 끝났어요.";
    }
    default:
      return null;
  }
}

/** 계획 미니(결론 카드 안)를 보일 매매 계획 상태: 실행할 계획이 없는 상태는 매매 계획 카드만 말한다 (같은 말을 되풀이하지 않게). */
export const showPlanMini = (plan: PlanCardState | "loading" | null | undefined): boolean =>
  plan !== "watch" && plan !== "negative" && plan !== "no_plan";

/**
 * AI 의견의 뜻 한 줄 (쉬운 보기 결론 아래, UX-8). '지켜보기'·'부정적'이 이미 가진 사람에게 팔라는 말로 읽히지 않게.
 * 긍정적은 매매 계획 카드가 다음 행동을 말하므로 없다. 권유·명령형을 쓰지 않는다 (docs/API.md "금지 표현").
 */
export const OPINION_MEANING: Partial<Record<ReportOpinion, string>> = {
  hold: "지금은 사지 않고 지켜보자는 뜻이에요. 이미 가진 사람에게 팔라는 뜻은 아니에요.",
  avoid: "지금 새로 사기에는 위험이 더 크다고 본 거예요. 이미 가진 사람에게 당장 팔라는 뜻은 아니에요.",
};

// ---------------------------------------------------------------- AI 글 다듬기 (옛 데이터용 화면 안전장치, UX-5)
// 서버(리포트 Worker·Guard)가 새 리포트부터 고치지만, 이미 만든 리포트의 글은 그대로다. 리포트 화면에서 그릴 때만 바꾼다 (원문은 그대로 둔다).

/** 의견 영어 표기 → 화면 말 (리포트 화면의 의견과 같은 말). */
const VERDICT_WORD: Record<string, string> = { hold: "지켜보기", buy: "매수", sell: "매도", avoid: "부정적" }; // 백엔드 tidy.OPINION_KO와 같은 말

/** 바꾼 말(모두 받침 없이 끝난다) 뒤에 바로 붙은 조사를 받침 없는 꼴로 ("sell이에요" → "매도예요"). */
const PARTICLE_AFTER_VOWEL: [RegExp, string][] = [
  [/^이에요/, "예요"],
  [/^이었/, "였"],
  [/^으로/, "로"],
  [/^을/, "를"],
  [/^은/, "는"],
  [/^과/, "와"],
  [/^이(?=[\s.,!?)]|$)/, "가"],
];

/** 앞뒤 글자로 의견 영어인지 본다: 한글이 바로 붙었거나("hold예요"), 뒤에 '의견'이 오거나, 앞이 "의견은 "·"의견: "일 때만 (영어 문장·뉴스 제목의 buy는 그대로). */
function isVerdictContext(before: string, after: string): boolean {
  return /^[가-힣]/.test(after) || /^\s*의견/.test(after) || /의견\s*(?:은|는|이|:)\s*$/.test(before);
}

/**
 * 리포트의 AI 글을 그리기 전에 다듬는다: 쉼표 없는 원 금액("201000원" → "201,000원"), 문장 속 의견 영어(hold·buy·sell·avoid → 지켜보기·매수·매도·부정적, 바로 붙은 조사도 맞춘다).
 * 이미 쉼표가 있거나 4자리 미만인 수, '원'이 붙지 않은 수(연도·개수)는 그대로다.
 */
export function cleanReportText(s: string): string {
  // "2026 원/달러"·"원화"·"0123원"은 금액이 아니다 (백엔드 tidy._WON과 같은 규칙, 리뷰 R-11)
  const withCommas = s.replace(/(?<![\d,.])([1-9]\d{3,})(?=\s?원(?![/화]))/g, (n) => Number(n).toLocaleString("en-US"));
  return withCommas.replace(
    /(?<![A-Za-z])(hold|buy|sell|avoid)(?![A-Za-z])(이에요|이었|으로|을|은|과|이(?=[\s.,!?)]|$))?/gi,
    (m: string, word: string, particle: string | undefined, offset: number, all: string) => {
      if (!isVerdictContext(all.slice(0, offset), all.slice(offset + word.length))) return m;
      const p = particle ?? "";
      const fixed = PARTICLE_AFTER_VOWEL.find(([re]) => re.test(p));
      return VERDICT_WORD[word.toLowerCase()] + (fixed ? p.replace(fixed[0], fixed[1]) : p);
    },
  );
}

const cleanOrNull = (s: string | null): string | null => (s === null ? null : cleanReportText(s));

/** 근거·위험 한 줄 (끝에 붙은 출처를 뗀 글과 출처). */
export interface SourcedLine {
  line: string; // 원문 (목록 key)
  text: string;
  source: string | null;
}

export interface ReasonsRisksView {
  reasons: SourcedLine[];
  risks: SourcedLine[]; // '틀리는 경우'로 옮긴 위험은 뺀다
  stopLine: number | null; // 코드가 만드는 손절 문장의 가격 (긍정적이고 가격이 맞을 때만)
  wrong: string | null; // '틀리는 경우'의 AI 문장 (손절 문장과 같은 뜻이면 null, 앞의 같은 손절 가격 조건은 뗀 글)
}

/**
 * 근거와 위험 카드에 보일 글 (ReasonsRisks). 쉬운 보기가 AI 글의 용어 풀이를 붙일 때 같은 글을 미리 알아야 해서 함수로 둔다.
 * targets: 손절 문장·가격 판단에 쓸 가격 (주지 않으면 draft.targets).
 */
export function reasonsRisksView(draft: DraftView, opinion: ReportOpinion | null, currency: Currency, targets?: ReportTargets): ReasonsRisksView {
  const { risk, others } = whenWrongOf(draft, opinion);
  const prices = targets ?? draft.targets;
  const stopLine = opinion === "buy" && validTargets(prices) ? prices.stop : null;
  const riskText = risk === null ? null : splitSource(risk).text;
  // 손절 문장이 있으면 그 손절 가격만 말하는 AI 문장은 같은 뜻이라 숨긴다 (다른 금액·다른 조건이면 그대로 — 위험 목록에서 이미 옮겨 왔으므로 지우지 않는다)
  const kept = riskText !== null && !(stopLine !== null && priceOnlyRisk(riskText, stopLine, currency)) ? riskText : null;
  // 손절 문장이 가격을 말하므로 AI 문장 앞의 같은 손절 가격 조건은 떼고 다른 조건만 (같은 가격을 두 번 보이지 않게)
  const wrong = kept !== null && stopLine !== null ? withoutPriceClause(kept, stopLine, currency) : kept;
  const sourced = (line: string): SourcedLine => ({ line, ...splitSource(line) });
  return { reasons: draft.reasons.map(sourced), risks: others.map(sourced), stopLine, wrong };
}

/** 교차검증 분석 판정의 전문가 표기 (BUY 매수 · PASS 지켜보기 — 리포트 의견 '지켜보기'와 같은 말, UX-5). */
export const VERDICT_TEXT: Record<AnalysisSummary["verdict"], string> = { BUY: "매수", PASS: "지켜보기" };

/**
 * 팀 피드(리포트 목록의 팀 리포트)에 보일 리포트인지 (UX-15): 남이 신청한 실패 리포트와 자동 리포트 실패는 뺀다 — 서비스가 고장 난 것처럼 보인다.
 * 내 실패는 '다시 만들기'와 함께 남긴다. mine: 내 리포트인지.
 */
export const inTeamFeed = (r: Pick<ReportSummary, "status">, mine: boolean): boolean => r.status !== "failed" || mine;

/** 최근 완성 리포트(최대 take개)의 시작~끝 시간 (ms, 짧은 순). */
function recentDurations(reports: Pick<ReportSummary, "status" | "startedAt" | "finishedAt">[], take: number): number[] {
  return reports
    .filter((r) => r.status === "completed" && r.startedAt && r.finishedAt)
    .map((r) => ({ end: Date.parse(r.finishedAt ?? ""), start: Date.parse(r.startedAt ?? "") }))
    .filter((x) => Number.isFinite(x.end) && Number.isFinite(x.start) && x.end >= x.start)
    .sort((a, b) => b.end - a.end)
    .slice(0, take)
    .map((x) => x.end - x.start)
    .sort((a, b) => a - b);
}

/** 진행 화면의 예상 시간: 최근 완성 리포트(최대 take개)의 시작~끝 시간 중앙값. 3건 미만이면 null (docs/plans/컨셉변경계획.md 4-6). */
export function typicalDurationMs(reports: Pick<ReportSummary, "status" | "startedAt" | "finishedAt">[], take = 10): number | null {
  const ms = recentDurations(reports, take);
  if (ms.length < 3) return null;
  const mid = Math.floor(ms.length / 2);
  return ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2;
}

/**
 * 진행 화면의 걸린 시간 범위 (분): 최근 완성 리포트(최대 take개)의 시작~끝 시간 중 가운데 절반(아래 1/4 ~ 위 1/4 — 유난히 오래 걸린 한 건에 끌리지 않게).
 * 아래는 반올림(최소 1분), 위는 올림. 3건 미만이면 null. 한 값 하나로 말하면 넘겼을 때 '고장인가' 싶다 (UX-7: "보통 1분"인데 2분).
 */
export function typicalDurationRange(reports: Pick<ReportSummary, "status" | "startedAt" | "finishedAt">[], take = 10): { lo: number; hi: number } | null {
  const ms = recentDurations(reports, take);
  if (ms.length < 3) return null;
  const n = ms.length - 1;
  const lo = Math.max(1, Math.round(ms[Math.floor(n * 0.25)] / 60_000));
  const hi = Math.max(lo, Math.ceil(ms[Math.ceil(n * 0.75)] / 60_000));
  return { lo, hi };
}

/** 걸린 시간 안내: "보통 1~3분 걸려요" (범위가 한 값이면 "보통 2분쯤 걸려요", 자료가 없으면 기본 문장). */
export function durationSentence(range: { lo: number; hi: number } | null): string {
  if (!range) return "보통 몇 분 걸려요";
  return range.lo === range.hi ? `보통 ${range.lo}분쯤 걸려요` : `보통 ${range.lo}~${range.hi}분 걸려요`;
}

/**
 * 진행 화면의 기다린 시간: 늘 신청 시각 기준 한 문장 ("신청한 지 1분이 안 됐어요" · "신청한 지 3분").
 * 시작 시각으로 기준을 바꾸면 "신청한 지 1분 → 방금 시작했어요"처럼 시간이 뒤로 가 보인다 (UX-7).
 */
export function requestedAgoText(createdAt: string | null | undefined, now: number): string | null {
  const t = elapsedText(createdAt, now);
  if (t === null) return null;
  return t === "방금" ? "신청한 지 1분이 안 됐어요" : `신청한 지 ${t}`;
}

/** 기다린 시간 ("방금" · "3분" · "2시간" · "1일"). 진행 화면의 "신청한 지 ○분"에 쓴다. */
export function elapsedText(fromIso: string | null | undefined, now: number): string | null {
  const from = fromIso ? Date.parse(fromIso) : NaN;
  if (!Number.isFinite(from)) return null;
  const min = Math.max(0, Math.floor((now - from) / 60_000));
  if (min < 1) return "방금";
  if (min < 60) return `${min}분`;
  if (min < 24 * 60) return `${Math.floor(min / 60)}시간`;
  return `${Math.floor(min / (24 * 60))}일`;
}

/** 리포트 목록 카드의 상태 (대기 중·만드는 중·완성·실행 가능·만들지 못함). ready = 완성 + 안전장치가 지금 실행을 허락하는 계획이 있음. */
export type ReportCardStatus = ReportStatus | "ready";

/** ready: 이 리포트 계획의 리스크 미리 보기가 activatable (계획이 있다는 것만으로는 '실행 가능'이라 하지 않는다 — 상세와 같은 판단). */
export function reportCardStatus(status: ReportStatus, ready: boolean): ReportCardStatus {
  return status === "completed" && ready ? "ready" : status;
}

/**
 * 카드 상태 칩과 문장. 문장은 행동이 필요하거나 기다리는 상태에만 둔다 (완성은 칩과 의견 배지로 충분 — 카드마다 같은 말을 되풀이하지 않게).
 * 글자색은 연한 바탕 위 *-ink (다크에서도 읽히게). 아이콘은 상태마다 다르다.
 */
export const REPORT_CARD_TEXT: Record<ReportCardStatus, { label: string; sentence: string; chip: string; icon: IconName }> = {
  requested: { label: REPORT_STATUS_TEXT.requested.easy, sentence: "만들 차례를 기다리고 있어요", chip: "bg-fill text-sub", icon: "clock" },
  running: { label: REPORT_STATUS_TEXT.running.easy, sentence: "AI 담당자들이 조사하고 쓰는 중이에요", chip: "bg-brand-soft text-brand-ink", icon: "play" },
  completed: { label: REPORT_STATUS_TEXT.completed.easy, sentence: "", chip: "bg-ok-soft text-ok-ink", icon: "check" },
  ready: { label: "실행 가능", sentence: "이 리포트에서 나온 모의 자동매매 계획이 있어요", chip: "bg-brand-soft text-brand-ink", icon: "flow" },
  failed: { label: REPORT_STATUS_TEXT.failed.easy, sentence: REPORT_FAILURE_FALLBACK, chip: "bg-up-soft text-up-ink", icon: "close" },
};

/**
 * 완성 카드에 계획이 붙어 있지만 '실행 가능'이 아닐 때의 문장 (칩은 '완성' 그대로).
 * live: 이 리포트로 내 모의 자동매매가 진행 중 · blocked: 안전장치가 지금은 막음 · unchecked: 화면 아래쪽이라 아직 확인하지 않음.
 */
export const PLAN_NOTE = {
  live: "이 리포트로 모의 자동매매를 하고 있어요",
  blocked: "계획이 있지만 지금은 실행할 수 없어요. 이유는 리포트에서 볼 수 있어요",
  unchecked: "이 리포트에서 나온 계획이 있어요. 실행할 수 있는지는 리포트에서 확인해요",
} as const;

/** 하루 리포트 한도 문장 ("오늘 ○번 더 만들 수 있어요", D-7). remaining이 null이면 무제한. */
export function quotaSentence(q: Pick<ReportQuota, "remaining">): string {
  if (q.remaining === null) return "오늘은 횟수 제한 없이 만들 수 있어요";
  return q.remaining > 0 ? `오늘 ${q.remaining}번 더 만들 수 있어요` : "오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요";
}

/** 교차검증 분석 카드의 쉬운 표기 (D-1: 과정은 두 모드 모두, 점수·확률은 전문가 보기에서만). */
export const CROSS_CHECK_TEXT: Record<AnalysisSummary["verdict"], { badge: string; line: string }> = {
  BUY: { badge: "승인된 계획 있음", line: "여러 AI가 각자 계획을 내고 서로 검증했어요. 최종 승인을 통과한 계획이 있어요" },
  PASS: { badge: "승인된 계획 없음", line: "여러 AI가 각자 계획을 내고 서로 검증했어요. 최종 승인을 통과한 계획이 없어요" },
};

/** 제안 AI 이름 표기 (쉬운 보기): claude → Claude, gpt → GPT, gemini → Gemini. 모르는 이름은 그대로. */
export function providerName(p: string): string {
  const k = p.trim().toLowerCase();
  if (k === "gpt" || k.startsWith("gpt-") || k === "openai") return "GPT";
  if (k.startsWith("claude") || k === "anthropic") return "Claude";
  if (k.startsWith("gemini") || k === "google") return "Gemini";
  return p;
}

/** 교차검증 분석 목록의 쉬운 한 줄: 행마다 다른 정보 (목록 응답만으로 — 제안 수와 최종 승인 AI). */
export function crossCheckLine(a: Pick<AnalysisSummary, "scenarioCount" | "best">): string {
  if (a.scenarioCount === 0) return "AI가 낸 계획이 없어요";
  const approved = a.best?.selected ? providerName(a.best.proposer) : "없음";
  return `제안 ${a.scenarioCount}개 · 최종 승인 ${approved}`;
}

/** 오늘(KST) 만든 이 종목 리포트 중 보일 하나: 완성된 것 중 최신, 없으면 만드는 중인 것 중 최신 (실패는 빼고). 만들기 카드·종목 상세가 같이 쓴다. */
export function todayReport(reports: readonly ReportSummary[], now: Date = new Date()): ReportSummary | null {
  const today = reports.filter((r) => r.status !== "failed" && isTodayKst(r.createdAt, now));
  const newest = (list: ReportSummary[]) => list.reduce<ReportSummary | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  return newest(today.filter((r) => r.status === "completed")) ?? newest(today);
}

/** 쉬운 보기의 지표 값 모양: price 가격(원·$), rate 부호 붙은 등락률(0.021 → +2.1%), percent 비율(0.312 → 31.2%), number 숫자 그대로. */
export type IndicatorFormat = "price" | "rate" | "percent" | "number";

/**
 * 분석 상세의 지표 이름 (쉬운 보기). 키는 엔진 스냅샷의 지표 그대로다 (engine/paper_engine/data/snapshot.py — docs/API.md "엔진 스냅샷의 지표 그대로").
 * term이 있으면 눌러서 풀이(용어 사전), format은 값 모양(비율은 소수로 온다). 표에 없는 키는 쉬운 보기에서 숨긴다 (원래 키는 전문가 보기에).
 */
export const INDICATOR_EASY: Record<string, { label: string; term?: "RSI" | "이동평균" | "변동성"; format: IndicatorFormat }> = {
  sma20: { label: "20일 평균 가격", term: "이동평균", format: "price" },
  sma60: { label: "60일 평균 가격", term: "이동평균", format: "price" },
  sma120: { label: "120일 평균 가격", term: "이동평균", format: "price" },
  rsi14: { label: "RSI(14일)", term: "RSI", format: "number" },
  atr14: { label: "하루 변동폭(ATR)", term: "변동성", format: "price" },
  volatility20: { label: "20일 변동성(1년 환산)", term: "변동성", format: "percent" },
  change5d: { label: "5일 등락률", format: "rate" },
  change20d: { label: "20일 등락률", format: "rate" },
  change60d: { label: "60일 등락률", format: "rate" },
  periodHigh: { label: "기간 최고 가격", format: "price" },
  periodLow: { label: "기간 최저 가격", format: "price" },
};

/** 쉬운 보기의 지표 값 한 칸 (숫자가 아니면 그대로, 없으면 "-"). */
export function indicatorValue(v: number | string | null, format: IndicatorFormat, currency: Currency): string {
  if (v === null) return "-";
  if (typeof v !== "number") return v;
  if (format === "price") return formatPrice(v, currency);
  if (format === "rate") return formatRate(v, 1);
  if (format === "percent") return formatPercent(v, 1);
  return v.toLocaleString("ko-KR");
}

/** 제안 AI가 응답하지 못한 오류 (엔진 engine/paper_engine/pipeline.py "{모델} 시나리오 제안 실패: …"). */
const PROPOSAL_FAILED = /^(.+?) 시나리오 제안 실패:/;

/** 엔진 오류 문구 → 쉬운 문장 (쉬운 보기 '참고'). 엔진은 빈 결과(계획 0개)에 오류를 남기지 않으므로 오류는 숨기지 않는다. */
const ANALYSIS_ERROR_EASY: [RegExp, (who: string) => string][] = [
  [PROPOSAL_FAILED, (who) => `${who}: 응답하지 못해 계획을 내지 못했어요`],
  [/^(.+?) 웹 조사 실패:/, (who) => `${who}: 응답하지 못해 웹 조사를 하지 못했어요`],
  [/^(.+?) 검증 실패:/, (who) => `${who}: 응답하지 못해 다른 AI의 계획을 검증하지 못했어요`],
  [/^(.+?) 검증 누락:/, (who) => `${who}: 다른 AI의 계획 일부를 검증하지 않았어요`],
  [/^(.+?): 시간 초과로 이후 단계와 의결에서 제외함/, (who) => `${who}: 응답이 늦어 이후 단계에서 빠졌어요`],
];

/** 교차검증 분석 오류 한 줄의 쉬운 문장. 아는 엔진 문구만 바꾸고(AI 이름은 Claude·GPT·Gemini로) 모르는 문구는 원문 그대로. */
export function analysisErrorEasy(e: string): string {
  for (const [re, say] of ANALYSIS_ERROR_EASY) {
    const m = re.exec(e);
    if (m) return say(providerName(m[1]));
  }
  if (e.startsWith("APPROVER가 설정되지 않아")) return "최종 승인을 맡을 AI가 정해지지 않아 최종 승인을 하지 못했어요";
  if (e.startsWith("모델 응답 에러:")) return "AI 응답에 문제가 있었어요";
  return e;
}

/**
 * 계획이 0개인 분석의 과정 문장: 제안 AI가 응답하지 못했으면 '조건에 맞는 계획이 없었어요'가 아니라 그 사실을 말한다.
 * 실패가 없으면 null (기본 문장 그대로 — 정말 조건에 맞는 계획이 없었다).
 */
export function noPlanSentence(errors: readonly string[]): string | null {
  const failed = errors.filter((e) => PROPOSAL_FAILED.test(e)).length;
  return failed > 0 ? `AI가 낸 계획이 없어요 (AI ${countWord(failed)} 곳이 응답하지 못했어요)` : null;
}
