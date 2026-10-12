// 장애·복구 셈법 (docs/tasks/00-공통.md 9절. 백엔드 stats.py와 같은 규칙). 화면은 이 파일로만 센다.
// - Worker의 실행(run) = 그 actor의 agent_started부터 다음 agent_completed 또는 포기(agent_failed, final이 false가 아님)까지.
// - 장애 1건 = 한 run 안의 첫 agent_failed(final: false). 복구됨 = 그 run이 agent_completed로 끝남.
import type { ErrorType, RecoverySummary, TraceEvent } from "../api/types";

export interface Attempt {
  model: string | null;
  outcome: "ok" | ErrorType;
  injected: boolean;
  at: string;
}

export interface AttemptHistory {
  attempts: Attempt[]; // 마지막 실행의 LLM 호출들 (실패한 호출 + 성공한 호출)
  recovered: boolean; // 실패가 있었지만 완료로 끝남
  gaveUp: boolean; // 포기로 끝남
  injected: boolean; // 실패 중 주입된 것이 있음
  finalModel: string | null; // 최종적으로 답한 모델
}

const ERROR_TYPES: ErrorType[] = ["timeout", "server_error", "bad_output", "unknown"];

export function errorTypeOf(e: TraceEvent): ErrorType {
  const t = e.details.errorType;
  return ERROR_TYPES.includes(t as ErrorType) ? (t as ErrorType) : "unknown";
}

// 쉬운 PDF(backend/reports/output/easy_text.py recovery_sentences)도 같은 판정을 쓴다 (final 없음 = 포기) — 바꾸면 둘 다 고친다
/** LLM 호출 한 번의 실패인지 (재시도·전환으로 이어진다). final 표시가 없으면 포기로 본다. */
export const isCallFailure = (e: TraceEvent) => e.action === "agent_failed" && e.details.final === false;
export const isGiveUp = (e: TraceEvent) => e.action === "agent_failed" && e.details.final !== false;

/** 한 Worker의 마지막 실행에서의 시도 이력. */
export function attemptHistory(trace: TraceEvent[], workerId: string): AttemptHistory {
  const mine = trace.filter((e) => e.actor === workerId);
  const start = mine.map((e) => e.action).lastIndexOf("agent_started");
  const run = start >= 0 ? mine.slice(start) : mine;
  const h: AttemptHistory = { attempts: [], recovered: false, gaveUp: false, injected: false, finalModel: null };
  for (const e of run) {
    if (isCallFailure(e)) {
      const injected = e.details.injected === true;
      h.attempts.push({ model: e.model, outcome: errorTypeOf(e), injected, at: e.at });
      h.injected ||= injected;
    } else if (e.action === "agent_completed") {
      h.recovered = h.attempts.length > 0;
      h.finalModel = e.model;
      h.attempts.push({ model: e.model, outcome: "ok", injected: false, at: e.at });
    } else if (isGiveUp(e)) {
      h.gaveUp = true;
    }
  }
  return h;
}

/** 이 리포트의 장애·복구 요약 (RecoverySummary와 같은 모양). */
export function summarize(trace: TraceEvent[]): RecoverySummary {
  const s: RecoverySummary = { failures: 0, recovered: 0, unrecovered: 0, injected: 0, recoveryMs: null, models: {} };
  const firstFail = new Map<string, string>(); // actor → 이번 run의 첫 실패 시각
  for (const e of trace) {
    if (e.action === "agent_started") {
      firstFail.delete(e.actor);
    } else if (isCallFailure(e)) {
      if (!firstFail.has(e.actor)) {
        firstFail.set(e.actor, e.at);
        s.failures += 1;
        if (e.details.injected === true) s.injected += 1;
      }
    } else if (e.action === "agent_completed") {
      const at = firstFail.get(e.actor);
      if (at !== undefined) {
        s.recovered += 1;
        s.recoveryMs = (s.recoveryMs ?? 0) + Math.max(0, Date.parse(e.at) - Date.parse(at));
        firstFail.delete(e.actor);
      }
      if (e.model) s.models[e.actor] = e.model;
    } else if (isGiveUp(e)) {
      if (firstFail.delete(e.actor)) s.unrecovered += 1;
    }
  }
  return s;
}

export interface ReviewRound {
  round: number;
  target: string;
  issues: string[];
  instructions: string;
}

/** 검토 RETRY → 다시 작성 기록. */
export function reviewRounds(trace: TraceEvent[]): ReviewRound[] {
  return trace
    .filter((e) => e.action === "review_retry")
    .map((e, i) => ({
      round: typeof e.details.round === "number" ? e.details.round : i + 1,
      target: typeof e.details.target === "string" ? e.details.target : "",
      issues: Array.isArray(e.details.issues) ? e.details.issues.map(String) : [],
      instructions: typeof e.details.instructions === "string" ? e.details.instructions : "",
    }));
}
