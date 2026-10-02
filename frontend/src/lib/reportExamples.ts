// 예시 Trace 재생: Agent가 아직 없어 실제 Trace가 비어 있으므로, 정해 둔 사건 목록을 차례로 보여 준다.
// Orchestrator 로직이 아니다. 사건과 그때의 Shared State 변화를 미리 적어 둔 데이터이며 서버에는 아무것도 보내지 않는다.
// Worker id는 docs/DECISIONS.md 9-3의 종목 리포트 팀을 따른다.
import { useEffect, useState } from "react";
import type { SharedState, TraceEvent } from "../api/types";

export interface ExampleFrame {
  event: TraceEvent;
  state: Partial<SharedState>; // 이 사건 뒤 Orchestrator가 바꾼 State 항목
}

export type ScenarioId = "normal" | "required_fail";

export interface ExampleScenario {
  id: ScenarioId;
  title: string;
  description: string;
  frames: ExampleFrame[];
}

/** 사건 사이 간격 (ms). */
export const REPLAY_MS = 800;

const BASE = Date.parse("2026-10-02T10:00:00+09:00");
const at = (ms: number) => `${new Date(BASE + ms + 9 * 3_600_000).toISOString().slice(0, 23)}+09:00`;

const LLM: Record<string, { provider: string; model: string }> = {
  market_agent: { provider: "gemini", model: "gemini-3.5-flash" },
  fundamental_agent: { provider: "openai", model: "gpt-4.1-mini" },
  news_agent: { provider: "ollama", model: "llama3.2" },
  report_agent: { provider: "gemma", model: "gemma3:4b" },
  review_agent: { provider: "openai", model: "gpt-4.1-mini" },
};

/** 사건 하나. step은 목록 순서로 붙인다. */
function ev(
  actor: string,
  action: string,
  status: TraceEvent["status"],
  ms: number,
  details: Record<string, unknown> = {},
  latencyMs: number | null = null,
): Omit<TraceEvent, "step"> {
  // 건너뛴 Agent는 실행하지 않았으므로 실행 정보가 없다
  const llm = status === "skipped" ? undefined : LLM[actor];
  return { actor, action, status, provider: llm?.provider ?? null, model: llm?.model ?? null, latencyMs, details, at: at(ms) };
}

const numbered = (rows: [Omit<TraceEvent, "step">, Partial<SharedState>][]): ExampleFrame[] =>
  rows.map(([e, state], i) => ({ event: { ...e, step: i + 1 }, state }));

const MARKET = { trend: "상승", summary: "20일선 위에서 거래대금이 늘고 있음 (예시)" };
const FUNDAMENTAL = { per: 11.2, note: "최근 분기 영업이익 증가, 특이 공시 없음 (예시)" };
const NEWS = { sentiment: "중립", headlines: 3 };
const REPORT = { sections: ["요약", "가격 흐름", "재무·공시", "리스크"], excluded: ["news_agent"] };
const REVIEW = { verdict: "통과", issues: [] };

export const SCENARIOS: ExampleScenario[] = [
  {
    id: "normal",
    title: "① 정상 흐름",
    description: "병렬 3개 시작 → 완료 순서가 시작 순서와 다름 → 선택 Worker(뉴스) 실패 → 선택 결과를 빼고 Join → 작성 → 검토 → 완료",
    frames: numbered([
      [ev("orchestrator", "workflow_started", "started", 0, { team: "stock_report", policy: "required_optional" }), { status: "running", currentStep: "parallel_research" }],
      [ev("market_agent", "agent_started", "started", 40, { step: "parallel_research" }), {}],
      [ev("fundamental_agent", "agent_started", "started", 45, { step: "parallel_research" }), {}],
      [ev("news_agent", "agent_started", "started", 50, { step: "parallel_research" }), {}],
      [
        ev("fundamental_agent", "agent_completed", "completed", 2185, { contract: "통과", note: "시작은 두 번째였지만 가장 먼저 끝났습니다" }, 2140),
        { results: { fundamental_agent: FUNDAMENTAL }, completedAgents: ["fundamental_agent"] },
      ],
      [
        ev("news_agent", "agent_failed", "failed", 3060, { error: "출력 계약 검증 실패: sentiment 필드 없음", required: false }, 3010),
        { errors: { news_agent: "출력 계약 검증 실패: sentiment 필드 없음" }, failedAgents: ["news_agent"] },
      ],
      [
        ev("market_agent", "agent_completed", "completed", 3520, { contract: "통과" }, 3480),
        { results: { fundamental_agent: FUNDAMENTAL, market_agent: MARKET }, completedAgents: ["fundamental_agent", "market_agent"] },
      ],
      [
        ev("join_guard", "join_completed", "completed", 3530, {
          step: "compose",
          required: ["market_agent", "fundamental_agent"],
          excluded: ["news_agent"],
          reason: "필수 결과와 계약을 확인했고, 실패한 선택 결과는 제외했습니다",
        }),
        { currentStep: "compose" },
      ],
      [ev("report_agent", "agent_started", "started", 3560, { step: "compose", context: ["market_agent", "fundamental_agent"] }), {}],
      [
        ev("report_agent", "agent_completed", "completed", 8680, { contract: "통과" }, 5120),
        {
          results: { fundamental_agent: FUNDAMENTAL, market_agent: MARKET, report_agent: REPORT },
          completedAgents: ["fundamental_agent", "market_agent", "report_agent"],
        },
      ],
      [ev("review_agent", "agent_started", "started", 8700, { step: "review" }), { currentStep: "review" }],
      [
        ev("review_agent", "agent_completed", "completed", 10530, { contract: "통과", handoff: "리스크 신호가 없어 넘기지 않음" }, 1830),
        {
          results: { fundamental_agent: FUNDAMENTAL, market_agent: MARKET, report_agent: REPORT, review_agent: REVIEW },
          completedAgents: ["fundamental_agent", "market_agent", "report_agent", "review_agent"],
        },
      ],
      [
        ev("orchestrator", "workflow_completed", "completed", 10540, { reason: "필수 Worker가 모두 성공. 선택 Worker(news_agent) 실패는 제외하고 완료" }),
        { status: "completed", currentStep: null },
      ],
    ]),
  },
  {
    id: "required_fail",
    title: "② 필수 Worker 실패",
    description: "필수 Worker(재무·공시) 실패 → Join Guard가 차단 → 뒤 Agent는 건너뜀 → 전체 실패",
    frames: numbered([
      [ev("orchestrator", "workflow_started", "started", 0, { team: "stock_report", policy: "required_optional" }), { status: "running", currentStep: "parallel_research" }],
      [ev("market_agent", "agent_started", "started", 40, { step: "parallel_research" }), {}],
      [ev("fundamental_agent", "agent_started", "started", 45, { step: "parallel_research" }), {}],
      [ev("news_agent", "agent_started", "started", 50, { step: "parallel_research" }), {}],
      [
        ev("market_agent", "agent_completed", "completed", 2910, { contract: "통과" }, 2870),
        { results: { market_agent: MARKET }, completedAgents: ["market_agent"] },
      ],
      [
        ev("fundamental_agent", "agent_failed", "failed", 4165, { error: "공시 조회 시간 초과", required: true }, 4120),
        { errors: { fundamental_agent: "공시 조회 시간 초과" }, failedAgents: ["fundamental_agent"] },
      ],
      [
        ev("news_agent", "agent_completed", "completed", 4350, { contract: "통과" }, 4300),
        { results: { market_agent: MARKET, news_agent: NEWS }, completedAgents: ["market_agent", "news_agent"] },
      ],
      [
        ev("join_guard", "join_blocked", "blocked", 4360, {
          step: "compose",
          missingRequired: ["fundamental_agent"],
          reason: "필수 결과가 없어 Join을 막았습니다. 실패 결과를 빈 Context로 바꾸지 않습니다",
        }),
        { currentStep: "compose" },
      ],
      [ev("report_agent", "agent_skipped", "skipped", 4365, { reason: "Join 차단" }), {}],
      [ev("review_agent", "agent_skipped", "skipped", 4370, { reason: "앞 단계 실패" }), {}],
      [
        ev("orchestrator", "workflow_failed", "failed", 4380, { reason: "필수 Worker(fundamental_agent) 실패 — Required/Optional 정책에 따라 중단" }),
        { status: "failed", currentStep: null },
      ],
    ]),
  },
];

function emptyState(taskId: string): SharedState {
  return { taskId, status: "requested", currentStep: null, results: {}, errors: {}, completedAgents: [], failedAgents: [] };
}

interface Run {
  scenario: ScenarioId;
  index: number; // 지금까지 보여 준 사건 수
  playing: boolean;
}

/** 예시 재생 상태. 재생 중이면 index를 REPLAY_MS마다 하나씩 늘린다. */
export function useReplay(taskId: string, intervalMs = REPLAY_MS) {
  const [run, setRun] = useState<Run | null>(null);
  const scenario = run ? (SCENARIOS.find((s) => s.id === run.scenario) ?? null) : null;
  const total = scenario?.frames.length ?? 0;

  useEffect(() => {
    if (!run?.playing) return;
    const t = setTimeout(
      () => setRun((r) => r && { ...r, index: Math.min(r.index + 1, total), playing: r.index + 1 < total }),
      intervalMs,
    );
    return () => clearTimeout(t);
  }, [run, total, intervalMs]);

  const frames = scenario && run ? scenario.frames.slice(0, run.index) : [];
  const state = frames.reduce<SharedState>((s, f) => ({ ...s, ...f.state }), emptyState(taskId));

  return {
    active: run !== null,
    scenario,
    index: run?.index ?? 0,
    total,
    playing: run?.playing ?? false,
    done: run !== null && run.index >= total,
    trace: frames.map((f) => f.event),
    state,
    start: (id: ScenarioId) => setRun({ scenario: id, index: 0, playing: true }),
    pause: () => setRun((r) => r && { ...r, playing: false }),
    resume: () => setRun((r) => r && (r.index < total ? { ...r, playing: true } : r)),
    step: () => setRun((r) => r && (r.index < total ? { ...r, index: r.index + 1, playing: false } : r)),
    restart: () => setRun((r) => r && { ...r, index: 0, playing: false }),
    stop: () => setRun(null),
  };
}

export type Replay = ReturnType<typeof useReplay>;
