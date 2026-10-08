// 예시 Trace 재생: Agent가 아직 없어 실제 Trace가 비어 있으므로, 정해 둔 사건 목록을 차례로 보여 준다.
// Orchestrator 로직이 아니다. 사건과 그때의 Shared State 변화를 미리 적어 둔 데이터이며 서버에는 아무것도 보내지 않는다.
// Worker id는 docs/DECISIONS.md 9-3의 종목 리포트 팀을 따른다.
import { useEffect, useState } from "react";
import type { SharedState, TraceEvent } from "../api/types";

export interface ExampleFrame {
  event: TraceEvent;
  state: Partial<SharedState>; // 이 사건 뒤 Orchestrator가 바꾼 State 항목
}

export type ScenarioId = "normal" | "required_fail" | "recovery" | "bad_output" | "review_limit" | "prompt_guard";

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
  market_agent: { provider: "devpass", model: "gemini-3.8-flash" },
  fundamental_agent: { provider: "devpass", model: "gemini-3.8-flash" },
  news_agent: { provider: "devpass", model: "gemini-3.8-flash" },
  report_agent: { provider: "devpass", model: "gpt-5.6-luna" },
  review_agent: { provider: "devpass", model: "claude-opus-5-5" },
};

/** 사건 하나. step은 목록 순서로 붙인다. */
function ev(
  actor: string,
  action: string,
  status: TraceEvent["status"],
  ms: number,
  details: Record<string, unknown> = {},
  latencyMs: number | null = null,
  override?: { provider: string; model: string }, // 대체 모델이 답했을 때
): Omit<TraceEvent, "step"> {
  // 건너뛴 Agent는 실행하지 않았으므로 실행 정보가 없다
  const llm = status === "skipped" ? undefined : (override ?? LLM[actor]);
  return { actor, action, status, provider: llm?.provider ?? null, model: llm?.model ?? null, latencyMs, details, at: at(ms) };
}

const numbered = (rows: [Omit<TraceEvent, "step">, Partial<SharedState>][]): ExampleFrame[] =>
  rows.map(([e, state], i) => ({ event: { ...e, step: i + 1 }, state }));

const MARKET = { trend: "상승", summary: "20일선 위에서 거래대금이 늘고 있음 (예시)" };
const FUNDAMENTAL = { per: 11.2, note: "최근 분기 영업이익 증가, 특이 공시 없음 (예시)" };
const NEWS = { sentiment: "중립", headlines: 3 };
const REPORT = { sections: ["요약", "가격 흐름", "재무·공시", "리스크"], excluded: ["news_agent"] };
const REVIEW = { verdict: "통과", issues: [] };
const REPORT_FULL = { sections: ["요약", "가격 흐름", "재무·공시", "뉴스·심리", "리스크"], excluded: [] };
const ALL3 = { fundamental_agent: FUNDAMENTAL, market_agent: MARKET, news_agent: NEWS };
/** 뉴스 Agent의 대체 모델 (예시 ③). */
const FALLBACK = { provider: "devpass", model: "gpt-5.6-luna" };

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
  {
    // details는 docs/tasks/00-공통.md 9절 그대로 (백엔드와 같은 모양)
    id: "recovery",
    title: "③ 모델 실패 → 대체 모델로 복구",
    description: "뉴스 Agent에 시간 초과 주입 → 주 모델은 다시 기다리지 않고 대체 모델로 전환 → 대체 모델도 한 번 시간 초과 → 같은 대체 모델로 다시 해 완료(자동 복구) → 검토 RETRY 1회 → 다시 작성 → 완료",
    frames: numbered([
      [ev("orchestrator", "workflow_started", "started", 0, { chaos: true, source: "user" }), { status: "running", currentStep: "parallel_research" }],
      [ev("market_agent", "agent_started", "started", 40, { attempt: 1, step: "parallel_research" }), {}],
      [ev("fundamental_agent", "agent_started", "started", 45, { attempt: 1, step: "parallel_research" }), {}],
      [ev("news_agent", "agent_started", "started", 50, { attempt: 1, step: "parallel_research" }), {}],
      [ev("news_agent", "agent_failed", "failed", 1250, { errorType: "timeout", attempt: 1, injected: true, final: false }, 1200), {}],
      [ev("news_agent", "agent_failover", "started", 1260, { from: "gemini-3.8-flash", to: "gpt-5.6-luna", reason: "timeout" }, null, FALLBACK), {}],
      [
        ev("fundamental_agent", "agent_completed", "completed", 2185, { attempts: 1, recovered: false, recoveryMs: null, costUsd: 0.004, guarded: [] }, 2140),
        { results: { fundamental_agent: FUNDAMENTAL }, completedAgents: ["fundamental_agent"] },
      ],
      [ev("news_agent", "agent_failed", "failed", 2470, { errorType: "timeout", attempt: 2, injected: true, final: false }, 1200, FALLBACK), {}],
      [ev("news_agent", "agent_retry", "started", 2480, { attempt: 3, reason: "timeout" }, null, FALLBACK), {}],
      [
        ev("market_agent", "agent_completed", "completed", 3520, { attempts: 1, recovered: false, recoveryMs: null, costUsd: 0.003, guarded: [] }, 3480),
        { results: { fundamental_agent: FUNDAMENTAL, market_agent: MARKET }, completedAgents: ["fundamental_agent", "market_agent"] },
      ],
      [
        ev("news_agent", "agent_completed", "completed", 4390, { attempts: 3, recovered: true, recoveryMs: 3140, costUsd: 0.005, guarded: [] }, 1900, FALLBACK),
        {
          results: { fundamental_agent: FUNDAMENTAL, market_agent: MARKET, news_agent: NEWS },
          completedAgents: ["fundamental_agent", "market_agent", "news_agent"],
        },
      ],
      [
        ev("join_guard", "join_completed", "completed", 4400, {
          step: "compose",
          required: ["market_agent", "fundamental_agent"],
          missing: [],
          inputs: ["market_agent", "fundamental_agent", "news_agent"],
        }),
        { currentStep: "compose" },
      ],
      [ev("report_agent", "agent_started", "started", 4430, { attempt: 1, step: "compose" }), {}],
      [
        ev("report_agent", "agent_completed", "completed", 9550, { attempts: 1, recovered: false, recoveryMs: null, costUsd: 0.012, guarded: [] }, 5120),
        { results: { ...ALL3, report_agent: REPORT_FULL }, completedAgents: ["fundamental_agent", "market_agent", "news_agent", "report_agent"] },
      ],
      [ev("review_agent", "agent_started", "started", 9570, { attempt: 1, step: "review" }), { currentStep: "review" }],
      [
        ev("review_agent", "agent_completed", "completed", 11400, { attempts: 1, recovered: false, recoveryMs: null, costUsd: 0.004, guarded: [], verdict: "RETRY", score: 62 }, 1830),
        {},
      ],
      [
        ev("orchestrator", "review_retry", "started", 11410, {
          round: 1,
          target: "report_agent",
          issues: ["목표가의 근거가 조사 결과에 없음"],
          instructions: "목표가 근거를 시세·차트 Agent의 결과에서 인용하고, 근거가 없는 수치는 지우세요. (예시)",
        }),
        { currentStep: "compose" },
      ],
      [ev("report_agent", "agent_started", "started", 11440, { attempt: 2, step: "compose" }), {}],
      [
        ev("report_agent", "agent_completed", "completed", 15900, { attempts: 1, recovered: false, recoveryMs: null, costUsd: 0.011, guarded: [] }, 4460),
        {},
      ],
      [ev("review_agent", "agent_started", "started", 15920, { attempt: 2, step: "review" }), { currentStep: "review" }],
      [
        ev("review_agent", "agent_completed", "completed", 17600, { attempts: 1, recovered: false, recoveryMs: null, costUsd: 0.004, guarded: [], verdict: "PASS", score: 84 }, 1680),
        {
          results: { ...ALL3, report_agent: REPORT_FULL, review_agent: REVIEW },
          completedAgents: ["fundamental_agent", "market_agent", "news_agent", "report_agent", "review_agent"],
        },
      ],
      [
        ev("orchestrator", "workflow_completed", "completed", 17610, { reason: "completed", costUsd: 0.043, durationMs: 17610 }),
        { status: "completed", currentStep: null },
      ],
    ]),
  },
  {
    id: "bad_output",
    title: "④ 형식 오류 → 다시 요청",
    description: "DR-LLM-02 · Worker 응답 계약이 깨짐 → 문제를 알려 같은 Agent에 다시 요청 → 정상 결과로 완료",
    frames: numbered([
      [ev("orchestrator", "workflow_started", "started", 0, { team: "stock_report", policy: "required_optional" }), { status: "running", currentStep: "parallel_research" }],
      [ev("market_agent", "agent_started", "started", 40, { attempt: 1, step: "parallel_research" }), {}],
      [ev("market_agent", "agent_failed", "failed", 1100, { errorType: "bad_output", attempt: 1, injected: true, final: false, reason: "출력 계약 불일치" }, 1060), {}],
      [ev("market_agent", "agent_retry", "started", 1110, { attempt: 2, reason: "bad_output" }), {}],
      [ev("market_agent", "agent_completed", "completed", 2600, { attempts: 2, recovered: true, recoveryMs: 1500 }, 1490), { results: { market_agent: MARKET }, completedAgents: ["market_agent"] }],
      [ev("orchestrator", "workflow_completed", "completed", 2610, { reason: "형식 오류를 바로잡아 완료" }), { status: "completed", currentStep: null }],
    ]),
  },
  {
    id: "review_limit",
    title: "⑤ Feedback Loop 최대 횟수 종료",
    description: "DR-CRT-02 · 검토가 계속 RETRY → 정해진 최대 횟수에서 중단 → 무한 실행 없이 실패 종료",
    frames: numbered([
      [ev("orchestrator", "workflow_started", "started", 0, { team: "stock_report" }), { status: "running", currentStep: "review" }],
      [ev("report_agent", "agent_completed", "completed", 1200, { contract: "통과" }, 1200), { results: { report_agent: REPORT_FULL }, completedAgents: ["report_agent"] }],
      [ev("review_agent", "agent_completed", "completed", 2100, { verdict: "RETRY" }, 900), {}],
      [ev("orchestrator", "review_retry", "started", 2110, { round: 1, target: "report_agent", issues: ["근거가 조사 결과와 맞지 않음"], instructions: "조사 결과에 있는 근거만 사용해 다시 작성" }), { currentStep: "compose" }],
      [ev("report_agent", "agent_completed", "completed", 3300, { contract: "통과" }, 1190), {}],
      [ev("review_agent", "agent_completed", "completed", 4200, { verdict: "RETRY" }, 900), {}],
      [ev("orchestrator", "review_retry", "started", 4210, { round: 2, target: "report_agent", issues: ["수정 후에도 근거 불일치"], instructions: "근거 없는 문장을 제거" }), { currentStep: "review" }],
      [ev("orchestrator", "workflow_failed", "failed", 4220, { reason: "review_failed" }), { status: "failed", currentStep: null, errors: { review_agent: "검토 최대 횟수 초과" }, failedAgents: ["review_agent"] }],
    ]),
  },
  {
    id: "prompt_guard",
    title: "⑥ 악성 지시 자료 차단",
    description: "DR-SEC-01 · 뉴스 본문의 프롬프트 공격 감지 → 해당 자료 제외 기록 → 안전한 자료만으로 계속",
    frames: numbered([
      [ev("orchestrator", "workflow_started", "started", 0, { team: "stock_report" }), { status: "running", currentStep: "parallel_research" }],
      [ev("news_agent", "agent_started", "started", 40, { step: "parallel_research" }), {}],
      [ev("news_agent", "agent_completed", "completed", 1800, { guarded: ["prompt_injection"], excludedSources: 1, note: "악성 지시가 있는 뉴스 자료를 제외함" }, 1760), { results: { news_agent: NEWS }, completedAgents: ["news_agent"] }],
      [ev("join_guard", "join_completed", "completed", 1810, { step: "compose", reason: "차단한 자료를 제외하고 계속" }), { currentStep: "compose" }],
      [ev("orchestrator", "workflow_completed", "completed", 1820, { reason: "안전한 자료만 사용해 완료" }), { status: "completed", currentStep: null }],
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
