// AI 리포트 화면의 표시 규칙: 상태 이름·색, Trace에서 노드 상태 읽기, 실패 정책 설명 (docs/교육용문서.md 그대로).
import type { ExecutionPlan, FailurePolicy, ReportStatus, TraceEvent, TraceStatus } from "../api/types";
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
