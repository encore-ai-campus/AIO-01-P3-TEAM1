import { describe, expect, it, vi } from "vitest";
import type { PlanEvent, TradePlan } from "../api/types";
import {
  STICKY_FIT_TOP,
  budgetParams,
  canStartManually,
  checkDiscordId,
  easySteps,
  ladderDistances,
  manualStartPath,
  nextActionOf,
  onlyManualSkip,
  otherKinds,
  parseBudget,
  percentToKrw,
  plansByOrder,
  planWorkflow,
  priceLadder,
  stickyFit,
  timeLeft,
  timeLeftShort,
} from "./autotrade";

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

  it("청산 완료면 전부 완료 + 사유. 결과는 손익과 무관하게 중립(done) + 손익 숫자 (손실을 초록 성공 상자에 담지 않는다 — trade-23)", () => {
    const wf = planWorkflow(plan("closed", { exitReason: "STOP", pnlKrw: -32_261 }));
    expect(wf.steps.every((s) => s.state === "done")).toBe(true);
    expect(wf.outcome).toMatchObject({ tone: "done", title: "청산 완료 · 손절가 도달", pnlKrw: -32_261 });
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

  it("시연용 수동 시작(approved=false + manualStart)은 리스크 점검을 지나간 것 — 끝난 뒤에도 리스크 점검에서 멈춤으로 그리지 않는다 (DECISIONS 31장)", () => {
    const events = [ev(1, "activated", { manualStart: true }), ev(2, "risk_checked", { approved: false, manualStart: true }), ev(3, "order_placed"), ev(4, "cancelled")];
    expect(states(plan("cancelled"), events)).toEqual(["done", "done", "done", "stopped", "skipped", "skipped"]);
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

  it("parseBudget(금액): 쉼표·원 허용, 원 미만은 버림, 0 이하는 오류", () => {
    expect(parseBudget("1,000,000원")).toEqual({ value: 1_000_000, error: null });
    expect(parseBudget("1,000,000원", "amount")).toEqual({ value: 1_000_000, error: null });
    expect(parseBudget("1500.7", "amount")).toEqual({ value: 1500, error: null });
    expect(parseBudget("")).toEqual({ value: null, error: null });
    expect(parseBudget("0").error).toBeTruthy();
    expect(parseBudget("abc").error).toBeTruthy();
  });

  it("parseBudget(%): 1~100 정수만 ('%' 허용), 비우면 정하지 않음", () => {
    expect(parseBudget("25", "percent")).toEqual({ value: 25, error: null });
    expect(parseBudget(" 100% ", "percent")).toEqual({ value: 100, error: null });
    expect(parseBudget("", "percent")).toEqual({ value: null, error: null });
    for (const bad of ["0", "101", "12.5", "abc", "-5"]) expect(parseBudget(bad, "percent"), bad).toEqual({ value: null, error: "1~100 사이의 정수로 입력해 주세요." });
  });

  it("budgetParams: 요청에는 budgetPercent·budgetKrw 중 하나만, percentToKrw는 원 단위로 내림 (서버와 같은 계산)", () => {
    expect(budgetParams({ mode: "percent", value: 25 })).toEqual({ budgetPercent: 25 });
    expect(budgetParams({ mode: "amount", value: 1_000_000 })).toEqual({ budgetKrw: 1_000_000 });
    expect(percentToKrw(6_282_505, 25)).toBe(1_570_626);
    expect(percentToKrw(-10, 50)).toBe(0); // 매수 가능 금액이 음수면 0
  });
});

describe("단계 이름 (쉬운 보기)", () => {
  it("끝난 단계는 과거형, 지금 단계만 '…하는 중', 매도 요청 중인 마지막 단계는 '파는 중'", () => {
    expect(easySteps(plan("closed")).map((s) => s.label)).toEqual(["주문했어요", "샀어요", "목표·손절 지켜봤어요", "팔았어요"]);
    expect(easySteps(plan("holding")).map((s) => s.label)).toEqual(["주문했어요", "샀어요", "목표·손절 지켜보는 중", "팔았어요"]);
    const asked = easySteps(plan("holding"), [ev(1, "filled"), ev(2, "exit_requested")]);
    expect(asked.map((s) => [s.label, s.state])).toEqual([
      ["주문했어요", "done"],
      ["샀어요", "done"],
      ["목표·손절 지켜봤어요", "done"],
      ["파는 중", "current"],
    ]);
  });
});

describe("모의투자 화면 도우미", () => {
  it("otherKinds: 접힌 '다른 계획'의 괄호 안은 실제로 든 출처만", () => {
    expect(otherKinds([{ source: "analysis" }, { source: "demo" }])).toBe("교차검증 분석·연습용 예시");
    expect(otherKinds([{ source: "demo" }, { source: "demo" }])).toBe("연습용 예시");
    expect(otherKinds([{ source: "analysis" }])).toBe("교차검증 분석");
    expect(otherKinds([])).toBe("");
  });

  it("plansByOrder: 진행 중 계획만 주문 번호로 (끝난 계획·주문 전 계획은 빼서 일반 주문처럼 취소할 수 있게)", () => {
    const map = plansByOrder([
      { id: 1, orderId: 10, status: "entry_pending" },
      { id: 2, orderId: 11, status: "holding" },
      { id: 3, orderId: 12, status: "closed" },
      { id: 4, orderId: null, status: "active" },
    ] as const);
    expect([...map.keys()]).toEqual([10, 11]);
    expect(map.get(11)?.id).toBe(2);
  });

  it("nextActionOf: 시작할 수 없을 때 다음 행동 (우선순위: 내 계획 > 보유·주문 > 다른 계획 > 문장만)", () => {
    expect(nextActionOf(["reward_risk_low", "plan_exists"])).toBe("my_plan");
    expect(nextActionOf(["position_exists"])).toBe("portfolio");
    expect(nextActionOf(["price_passed"])).toBe("other_plans");
    expect(nextActionOf(["reward_risk_low"])).toBe("other_plans");
    expect(nextActionOf(["halted"])).toBeNull();
    expect(nextActionOf(["daily_loss_limit"])).toBeNull();
    expect(nextActionOf(["budget_too_small"])).toBeNull();
    // 넣을 돈 때문에 막힌 것은 금액을 고치면 풀린다 — 다른 화면으로 보내지 않는다 (2026-10-11)
    expect(nextActionOf(["cash_short", "total_limit"])).toBeNull();
    expect(nextActionOf([])).toBeNull();
  });

  it("시연용 수동 시작 자격 (DECISIONS 31장): 사유가 손익비·기대값뿐일 때만, 주소는 ?manual=1 (+ Discord ?t=)", () => {
    expect(onlyManualSkip(["reward_risk_low"])).toBe(true);
    expect(onlyManualSkip(["ev_negative"])).toBe(true);
    expect(onlyManualSkip(["reward_risk_low", "ev_negative"])).toBe(true);
    expect(onlyManualSkip(["reward_risk_low", "plan_exists"])).toBe(false);
    expect(onlyManualSkip([])).toBe(false);
    expect(canStartManually({ activatable: false, reasonCodes: ["reward_risk_low", "ev_negative"] })).toBe(true);
    expect(canStartManually({ activatable: false, reasonCodes: ["reward_risk_low", "halted"] })).toBe(false);
    expect(canStartManually({ activatable: true, reasonCodes: [] })).toBe(false);
    expect(canStartManually(undefined)).toBe(false);
    expect(manualStartPath(7)).toBe("/recommendations/7?manual=1");
    expect(manualStartPath(7, "demo-7")).toBe("/recommendations/7?manual=1&t=demo-7");
  });

  it("ladderDistances: 사기 전은 사는 가격까지, 보유 중은 목표·손절까지 (직전 종가 기준), 그 밖은 없음", () => {
    const p = { entryPrice: 181_000, targetPrice: 203_000, stopPrice: 173_000 };
    const [entry] = ladderDistances("entry_pending", p, 182_300);
    expect(entry.key).toBe("entry");
    expect(entry.rate).toBeCloseTo(181_000 / 182_300 - 1);
    expect(ladderDistances("holding", p, 182_300).map((d) => d.key)).toEqual(["target", "stop"]);
    expect(ladderDistances("holding", p, 182_300)[0].rate).toBeCloseTo(203_000 / 182_300 - 1);
    expect(ladderDistances("closed", p, 182_300)).toEqual([]);
    expect(ladderDistances("holding", p, null)).toEqual([]);
  });

  it("timeLeftShort: 칩용 짧은 남은 시간", () => {
    const now = new Date("2026-10-04T00:00:00Z");
    expect(timeLeftShort("2026-10-06T03:00:00Z", now)).toBe("2일 남음");
    expect(timeLeftShort("2026-10-04T05:30:00Z", now)).toBe("5시간 남음");
    expect(timeLeftShort("2026-10-04T00:45:00Z", now)).toBe("45분 남음");
    expect(timeLeftShort("2026-10-03T23:00:00Z", now)).toBe("만료");
    expect(timeLeftShort("x", now)).toBe("-");
  });

  it("stickyFit: 열 높이를 --col-h로 넘기고, 사라지면 관찰을 멈춘다 (ResizeObserver가 없으면 아무것도 하지 않는다)", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "offsetHeight", { value: 952 });
    expect(stickyFit(el)).toBeUndefined(); // jsdom에는 ResizeObserver가 없다 → top은 var 대체값(0px)으로 위 2rem
    const seen: { observed: Element[]; disconnected: boolean } = { observed: [], disconnected: false };
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(private cb: () => void) {}
        observe(t: Element) {
          seen.observed.push(t);
          this.cb();
        }
        disconnect() {
          seen.disconnected = true;
        }
      },
    );
    try {
      const stop = stickyFit(el);
      expect(seen.observed).toEqual([el]);
      expect(el.style.getPropertyValue("--col-h")).toBe("952px");
      stop?.();
      expect(seen.disconnected).toBe(true);
      expect(STICKY_FIT_TOP).toContain("var(--col-h, 0px)");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
