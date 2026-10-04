// AI 리포트 화면의 표시 규칙: 상태 이름·색, Trace에서 노드 상태 읽기, 실패 정책 설명 (docs/교육용문서.md 그대로).
import type { ErrorType, ExecutionPlan, FailurePolicy, ReportStatus, TraceEvent, TraceStatus } from "../api/types";
import type { IconName } from "../components/Icon";

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
