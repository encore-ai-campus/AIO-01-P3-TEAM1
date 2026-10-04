import { describe, expect, it } from "vitest";
import type { PlanEvent, TradePlan } from "../api/types";
import { checkDiscordId, parseBudget, planWorkflow, priceLadder, timeLeft } from "./autotrade";

type P = Pick<TradePlan, "status" | "exitReason" | "failureReason" | "pnlKrw">;
const plan = (status: TradePlan["status"], extra: Partial<P> = {}): P => ({ status, exitReason: null, failureReason: null, pnlKrw: null, ...extra });
const ev = (step: number, kind: string, details: Record<string, unknown> = {}): PlanEvent => ({
  step,
  kind,
  message: kind,
  details,
  at: "2026-10-04T09:00:00+09:00",
});
const states = (p: P, events: PlanEvent[] = []) => planWorkflow(p, events).steps.map((s) => s.state);

describe("planWorkflow", () => {
  it("체결 대기: 활성화·리스크 점검·진입 주문 완료, 체결 대기가 지금 단계", () => {
    const wf = planWorkflow(plan("entry_pending"), [ev(1, "activated"), ev(2, "risk_checked", { approved: true }), ev(3, "order_placed"), ev(4, "order_requeued")]);
    expect(wf.steps.map((s) => s.state)).toEqual(["done", "done", "done", "current", "todo", "todo"]);
    expect(wf.requeues).toBe(1);
    expect(wf.outcome).toBeNull();
  });

  it("사건이 없어도 상태로 최소 진행을 안다", () => {
    expect(states(plan("active"))).toEqual(["done", "current", "todo", "todo", "todo", "todo"]);
    expect(states(plan("holding"))).toEqual(["done", "done", "done", "done", "current", "todo"]);
  });

  it("보유 중 매도 요청이면 청산이 지금 단계", () => {
    expect(states(plan("holding"), [ev(1, "filled"), ev(2, "exit_requested")])).toEqual(["done", "done", "done", "done", "done", "current"]);
  });

  it("청산 완료면 전부 완료 + 사유", () => {
    const wf = planWorkflow(plan("closed", { exitReason: "STOP" }));
    expect(wf.steps.every((s) => s.state === "done")).toBe(true);
    expect(wf.outcome).toMatchObject({ tone: "ok", title: "청산 완료 · 손절가 도달" });
  });

  it("체결 대기 중 중단: 체결 대기에서 멈추고 뒤는 건너뜀", () => {
    const wf = planWorkflow(plan("cancelled", { failureReason: "사용자가 계획을 중단했습니다." }), [ev(1, "activated"), ev(2, "risk_checked"), ev(3, "order_placed"), ev(4, "cancelled")]);
    expect(wf.steps.map((s) => s.state)).toEqual(["done", "done", "done", "stopped", "skipped", "skipped"]);
    expect(wf.outcome).toEqual({ tone: "neutral", title: "사용자가 중단", text: "사용자가 계획을 중단했습니다." });
  });

  it("기한 만료는 체결 대기에서 멈춘다", () => {
    const wf = planWorkflow(plan("expired"), [ev(1, "activated"), ev(2, "order_placed"), ev(3, "expired")]);
    expect(wf.steps.map((s) => s.state)).toEqual(["done", "done", "done", "stopped", "skipped", "skipped"]);
    expect(wf.outcome?.title).toBe("진입 기한 만료");
  });

  it("리스크 엔진이 거절해 실패하면 리스크 점검에서 멈춘다", () => {
    const wf = planWorkflow(plan("failed", { failureReason: "손익비 부족" }), [ev(1, "activated"), ev(2, "risk_checked", { approved: false }), ev(3, "failed")]);
    expect(wf.steps.map((s) => s.state)).toEqual(["done", "stopped", "skipped", "skipped", "skipped", "skipped"]);
    expect(wf.outcome).toMatchObject({ tone: "error", text: "손익비 부족" });
  });

  it("주문 단계에서 실패하면 진입 주문에서 멈춘다", () => {
    expect(states(plan("failed"), [ev(1, "activated"), ev(2, "risk_checked", { approved: true }), ev(3, "failed")])).toEqual([
      "done",
      "done",
      "stopped",
      "skipped",
      "skipped",
      "skipped",
    ]);
  });

  it("모르는 사건·상태가 와도 깨지지 않는다", () => {
    const wf = planWorkflow(plan("paused" as TradePlan["status"]), [ev(1, "activated"), ev(2, "something_new")]);
    expect(wf.steps.map((s) => s.state)).toEqual(["done", "current", "todo", "todo", "todo", "todo"]);
    expect(wf.outcome).toBeNull();
  });
});

describe("priceLadder", () => {
  it("손절·진입·목표를 8~92% 사이에 놓고 지금 가격을 표시한다", () => {
    const l = priceLadder(90, 100, 120, 105);
    expect(l.stop).toBe(8);
    expect(l.target).toBe(92);
    expect(l.entry).toBeCloseTo(36);
    expect(l.last).toBeCloseTo(50);
    expect(l.outside).toBeNull();
  });

  it("범위 밖의 지금 가격은 막대 끝에 붙고 알린다", () => {
    expect(priceLadder(90, 100, 120, 50)).toMatchObject({ last: 0, outside: "below" });
    expect(priceLadder(90, 100, 120, 200)).toMatchObject({ last: 100, outside: "above" });
    expect(priceLadder(90, 100, 120, null)).toMatchObject({ last: null, outside: null });
  });
});

describe("입력·시각", () => {
  it("timeLeft", () => {
    const now = new Date("2026-10-04T00:00:00Z");
    expect(timeLeft("2026-10-06T03:00:00Z", now)).toBe("2일 3시간 남음");
    expect(timeLeft("2026-10-05T00:00:00Z", now)).toBe("1일 남음");
    expect(timeLeft("2026-10-04T02:30:00Z", now)).toBe("2시간 30분 남음");
    expect(timeLeft("2026-10-04T00:00:20Z", now)).toBe("1분 남음");
    expect(timeLeft("2026-10-03T23:00:00Z", now)).toBe("만료");
  });

  it("checkDiscordId: 숫자 17~20자리, 비우면 지운다", () => {
    expect(checkDiscordId(" ")).toEqual({ value: null, error: null });
    expect(checkDiscordId("123456789012345678")).toEqual({ value: "123456789012345678", error: null });
    expect(checkDiscordId("12345").error).toBe("Discord 사용자 ID는 숫자 17~20자리입니다 (지금 5자리).");
    expect(checkDiscordId("abc").error).toBe("Discord 사용자 ID는 숫자만 입력합니다.");
  });

  it("parseBudget: 쉼표·원 허용, 0 이하는 오류", () => {
    expect(parseBudget("1,000,000원")).toEqual({ value: 1_000_000, error: null });
    expect(parseBudget("")).toEqual({ value: null, error: null });
    expect(parseBudget("0").error).toBeTruthy();
    expect(parseBudget("abc").error).toBeTruthy();
  });
});
