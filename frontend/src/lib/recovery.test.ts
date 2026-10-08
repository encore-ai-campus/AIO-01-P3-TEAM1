import { describe, expect, it } from "vitest";
import type { TraceEvent } from "../api/types";
import { attemptHistory, reviewRounds, summarize } from "./recovery";
import { SCENARIOS } from "./reportExamples";
import { eventText, isKeyEvent } from "./reports";

let n = 0;
function ev(actor: string, action: string, details: Record<string, unknown> = {}, model: string | null = null, sec = 0): TraceEvent {
  n += 1;
  const status = action.endsWith("failed") ? "failed" : action.endsWith("completed") ? "completed" : "started";
  return { step: n, actor, action, status, provider: null, model, latencyMs: null, details, at: new Date(Date.UTC(2026, 9, 4, 1, 0, sec)).toISOString() };
}
const fail = (actor: string, model: string, sec: number, extra: Record<string, unknown> = {}) =>
  ev(actor, "agent_failed", { errorType: "timeout", final: false, injected: false, ...extra }, model, sec);

describe("attemptHistory", () => {
  it("복구된 Worker: 실패 두 번 뒤 대체 모델이 답했다", () => {
    const trace = [
      ev("news", "agent_started"),
      fail("news", "a", 1, { injected: true }),
      ev("news", "agent_retry", { attempt: 2 }),
      fail("news", "a", 2, { errorType: "server_error" }),
      ev("news", "agent_failover", { from: "a", to: "b" }),
      ev("news", "agent_completed", { recovered: true }, "b", 5),
    ];
    const h = attemptHistory(trace, "news");
    expect(h.attempts.map((a) => [a.model, a.outcome])).toEqual([["a", "timeout"], ["a", "server_error"], ["b", "ok"]]);
    expect(h).toMatchObject({ recovered: true, gaveUp: false, injected: true, finalModel: "b" });
    expect(summarize(trace)).toEqual({ failures: 1, recovered: 1, unrecovered: 0, injected: 1, recoveryMs: 4000, models: { news: "b" } });
  });

  it("포기한 Worker: 모든 모델이 실패했다", () => {
    const trace = [ev("news", "agent_started"), fail("news", "a", 1), fail("news", "b", 2), ev("news", "agent_failed", { errorType: "timeout", final: true, attempts: 2 })];
    expect(attemptHistory(trace, "news")).toMatchObject({ recovered: false, gaveUp: true, finalModel: null });
    expect(summarize(trace)).toMatchObject({ failures: 1, recovered: 0, unrecovered: 1, recoveryMs: null });
  });

  it("실패 없이 끝난 Worker는 복구가 아니고, final 표시가 없는 실패는 포기로 본다", () => {
    expect(attemptHistory([ev("m", "agent_started"), ev("m", "agent_completed", {}, "a")], "m")).toMatchObject({ recovered: false, finalModel: "a" });
    const old = [ev("m", "agent_started"), ev("m", "agent_failed", { error: "x" })];
    expect(attemptHistory(old, "m")).toMatchObject({ attempts: [], gaveUp: true });
    expect(summarize(old).failures).toBe(0);
  });

  it("재실행(검토 RETRY) 뒤에는 두 번째 실행만 읽고, 장애는 실행마다 센다", () => {
    const trace = [
      ev("w", "agent_started"),
      fail("w", "a", 1),
      ev("w", "agent_completed", {}, "b", 2),
      ev("orchestrator", "review_retry", { round: 1, target: "w", issues: ["근거 없음"], instructions: "고쳐라" }),
      ev("w", "agent_started", { attempt: 2 }),
      ev("w", "agent_completed", {}, "a", 9),
    ];
    expect(attemptHistory(trace, "w")).toMatchObject({ attempts: [{ model: "a", outcome: "ok" }], recovered: false });
    expect(summarize(trace)).toMatchObject({ failures: 1, recovered: 1, recoveryMs: 1000 });
    expect(reviewRounds(trace)).toEqual([{ round: 1, target: "w", issues: ["근거 없음"], instructions: "고쳐라" }]);
  });
});

describe("예시 ③과 문장", () => {
  const trace = SCENARIOS.find((s) => s.id === "recovery")!.frames.map((f) => f.event);

  it("예시 ③: 장애 1건(주입)이 자동 복구되고 최종 모델은 대체 모델", () => {
    expect(summarize(trace)).toMatchObject({ failures: 1, recovered: 1, unrecovered: 0, injected: 1, recoveryMs: 3140 });
    // worker_definitions.yaml의 현재 news_agent 첫 fallback과 맞춘다.
    expect(summarize(trace).models.news_agent).toBe("gpt-5.6-luna");
    expect(reviewRounds(trace)).toHaveLength(1);
  });

  it("모든 예시 사건이 문장이 되고, 모르는 action은 null (주요 사건에서도 빠진다)", () => {
    for (const s of SCENARIOS) for (const f of s.frames) expect(eventText(f.event, undefined)).not.toBeNull();
    const unknown = ev("x", "something_new");
    expect(eventText(unknown, undefined)).toBeNull();
    expect(isKeyEvent(unknown)).toBe(false);
    expect(eventText(fail("news", "a", 1, { injected: true }), undefined)).toMatchObject({ text: "시간 초과로 실패 (a)", tags: ["주입"], tone: "fail" });
  });
});
