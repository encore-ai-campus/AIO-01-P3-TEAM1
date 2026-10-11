// 가짜 API("서버") 규칙: 장마감 기준, 투자자 프로필, 사유 코드, 보유 방식, 리포트 한도, 장기투자.
// 시각에 기대는 것은 freezeTime(src/test/time.ts)으로 Date만 고정한다.
import { describe, expect, it } from "vitest";
import { ApiError, api } from "../api/client";
import type { InvestorAnswers, InvestorProfile, ReportQuota } from "../api/types";
import { basisDay, sessionEndIso, weekdaysEnding } from "./clock";
import * as db from "./db";
import { answersError, assess } from "./investor";
import { dailyMoveOf } from "./longterm";
import { seedStocks } from "./seed";
import { freezeTime as at } from "../test/time";

const alice = () => {
  db.setSession("alice");
  return db.sessionUser()!;
};
const bob = () => {
  db.setSession("bob");
  return db.sessionUser()!;
};
/** db 함수가 던진 MockError를 잡아 돌려준다. */
function caught(fn: () => unknown): db.MockError {
  try {
    fn();
  } catch (e) {
    if (e instanceof db.MockError) return e;
    throw e;
  }
  throw new Error("MockError를 던지지 않았습니다");
}

const CAUSAL = ["때문에", "덕분에", "원인은", "탓에", "영향으로", "오를것", "내릴것", "오를거", "내릴거", "상승할것", "하락할것", "반등할것", "사세요", "팔아야", "좋아요", "매수기회"];
const hasForbidden = (s: string) => CAUSAL.some((w) => s.replace(/\s+/g, "").includes(w));

describe("장 달력 (가짜 API)", () => {
  it("기준일 = 정규장 종료 + 10분이 지난 가장 최근 평일", () => {
    expect(basisDay("KR", new Date("2026-10-02T15:39:00+09:00"))).toBe("2026-10-01");
    expect(basisDay("KR", new Date("2026-10-02T15:40:00+09:00"))).toBe("2026-10-02");
    expect(basisDay("KR", new Date("2026-10-03T10:00:00+09:00"))).toBe("2026-10-02"); // 토요일
    expect(basisDay("KR", new Date("2026-10-05T09:00:00+09:00"))).toBe("2026-10-02"); // 월요일 장 전
    expect(basisDay("US", new Date("2026-10-02T16:09:00-04:00"))).toBe("2026-10-01");
    expect(basisDay("US", new Date("2026-10-02T16:10:00-04:00"))).toBe("2026-10-02");
  });

  it("정규장 종료 시각은 그 시장 시간대 (뉴욕은 서머타임에 따라 오프셋이 바뀐다)", () => {
    expect(sessionEndIso("KR", "2026-10-02")).toBe("2026-10-02T15:30:00+09:00");
    expect(sessionEndIso("US", "2026-10-02")).toBe("2026-10-02T16:00:00-04:00");
    expect(sessionEndIso("US", "2026-12-04")).toBe("2026-12-04T16:00:00-05:00");
    expect(weekdaysEnding("2026-10-05", 3)).toEqual(["2026-10-01", "2026-10-02", "2026-10-05"]);
  });
});

describe("실시간 시세와 장마감 기준 평가", () => {
  it("시세는 실시간(장중 가격 · 받은 시각)이고 setPrice를 따라가며, 오늘 진행 중인 봉이 붙는다", () => {
    at("2026-10-06T11:00:00+09:00"); // 화요일 장중 → KR 기준일은 월요일
    const q = db.quotes(["005930"])[0];
    expect(q).toMatchObject({ price: 71_200, prevClose: 70_500, change: 700, basis: "live" });
    expect(q.asOf).toMatch(/^2026-10-06T11:00:\d{2}\+09:00$/); // 받은 시각 = 지금 (KST, 초까지)
    db.setPrice("005930", 74_000); // 목표가(77,000) 아래라 보유는 그대로
    expect(db.quotes(["005930"])[0]).toMatchObject({ price: 74_000, prevClose: 70_500, change: 3_500, basis: "live" });

    // 일봉: 완성 봉 119개 + 오늘(화) 진행 중인 봉 = 120개. 시가는 직전 종가, 종가는 지금 가격
    const stock = db.stockDetail("005930");
    expect(stock.candles).toHaveLength(120);
    expect(stock.candles.at(-1)).toMatchObject({ date: "2026-10-06", open: 71_200, close: 74_000 });
    expect(stock.candles.at(-1)!.high).toBeGreaterThanOrEqual(74_000);
    expect(stock.candles.at(-1)!.low).toBeLessThanOrEqual(71_200);
    expect(stock.candles.at(-2)).toMatchObject({ date: "2026-10-05", close: 71_200 });
    expect(stock.candles.at(-3)?.close).toBe(70_500);
    expect(stock.asOf).toBe(stock.quote.asOf); // 마지막 봉이 진행 중이면 시세를 받은 시각

    const m = db.marketStatus();
    expect(m.quoteProvider).toBe("키움증권 REST API");
    expect(m.markets.find((x) => x.market === "KR")).toMatchObject({ closeDate: "2026-10-05", lastCloseAt: "2026-10-05T15:30:00+09:00" });
    expect(m.markets.find((x) => x.market === "US")).toMatchObject({ closeDate: "2026-10-05", lastCloseAt: "2026-10-05T16:00:00-04:00" });

    // 평가는 종가 (장중 가격 74,000원이 아니다), 보유 시장의 기준 시각
    const acc = db.account(1);
    const samsung = acc.positions.find((p) => p.symbol === "005930")!;
    expect(samsung).toMatchObject({ lastPrice: 71_200, valueKrw: 712_000, style: "swing" });
    expect(acc.positions.find((p) => p.symbol === "068270")?.style).toBe("long");
    expect(acc.pricesAsOf).toEqual({ KR: "2026-10-05T15:30:00+09:00", US: "2026-10-05T16:00:00-04:00" });
    expect(db.ranking(1).pricesAsOf.KR).toBe("2026-10-05T15:30:00+09:00");
    // 시장가 체결은 장중 가격
    expect(db.placeOrder(1, { symbol: "005380", quantity: 1, orderType: "MARKET" }).message).toBe("현대차 1주 248,000원에 매수 체결");
  });

  it("장이 닫혀 있으면 오늘 봉이 없고 StockDetail.asOf는 마지막 완성 봉의 정규장 종료 시각 (시세는 그래도 실시간)", () => {
    at("2026-10-06T11:00:00+09:00", { marketOpen: { KR: false, US: false } });
    const stock = db.stockDetail("005930");
    expect(stock.quote).toMatchObject({ price: 71_200, basis: "live" });
    expect(stock.candles).toHaveLength(120);
    expect(stock.candles.at(-1)).toMatchObject({ date: "2026-10-05", close: 71_200 });
    expect(stock.asOf).toBe("2026-10-05T15:30:00+09:00");
    expect(stock.asOf).not.toBe(stock.quote.asOf);
    // 미국도 장이 닫혀 있으면 마지막 완성 봉 (뉴욕 16:00)
    expect(db.stockDetail("AAPL").asOf).toBe("2026-10-05T16:00:00-04:00");
  });

  it("증권사 조회 키가 없으면 현재가도 종가도 없는 Quote (basis close, 값 null) — 오늘 봉도 없다", () => {
    at("2026-10-06T11:00:00+09:00", { brokerReady: false });
    expect(db.quotes(["005930"])[0]).toEqual({
      symbol: "005930",
      name: "삼성전자",
      currency: "KRW",
      price: null,
      prevClose: null,
      change: null,
      changeRate: null,
      asOf: null,
      basis: "close",
    });
    const stock = db.stockDetail("005930");
    expect(stock.candles.at(-1)?.date).toBe("2026-10-05");
    expect(stock.asOf).toBe("2026-10-05T15:30:00+09:00");
  });

  it("분석 상세에 뉴스 출처·자료 기준일", () => {
    const a = db.getAnalysis(1);
    expect(a.newsProvider).toBe("Google 뉴스 검색 결과");
    expect(a.newsItems.map((n) => n.title)).toEqual(a.news);
    expect(a.newsItems[0].source).toBeTruthy();
    expect(a.dataAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.listAnalyses(null, null, alice()).map((x) => x.id).sort()).toEqual([1, 6]);
  });
});

describe("투자자 프로필 · 주린이모드", () => {
  const example: InvestorAnswers = { q1: "none", q2: ["deposit"], q3: "never", q4: "heard", q5: "loss_10", q6: "weeks", q7: "practice" };

  it("점수표 (docs/API.md의 예와 경계)", () => {
    expect(assess(example)).toEqual({
      experienceScore: 1,
      experienceLevel: "intro",
      riskScore: 2,
      riskProfile: "stable_seeking",
      recommendedBeginnerMode: true,
    });
    const pro = assess({ q1: "over_3y", q2: ["kr_stock", "derivatives"], q3: "daily", q4: "explain", q5: "more", q6: "intraday", q7: "short_term" });
    expect(pro).toMatchObject({ experienceScore: 11, experienceLevel: "expert", riskScore: 8, riskProfile: "aggressive", recommendedBeginnerMode: false });
    // q2 경험 점수는 최대 3
    expect(assess({ ...example, q2: ["kr_stock", "us_stock", "derivatives"] }).experienceScore).toBe(1 + 3);
    expect(assess({ ...example, q5: "more", q6: "intraday", q7: "growth" }).riskProfile).toBe("active"); // 6
  });

  it("진단 입력 검사", () => {
    expect(answersError(example)).toBeNull();
    expect(answersError(undefined)).toMatch(/answers/);
    expect(answersError({ ...example, q8: "x" })).toMatch(/모르는 문항/);
    const { q3: _drop, ...missing } = example;
    void _drop;
    expect(answersError(missing)).toMatch(/q3/);
    expect(answersError({ ...example, q1: "forever" })).toMatch(/q1/);
    expect(answersError({ ...example, q2: [] })).toMatch(/q2/);
    expect(answersError({ ...example, q2: ["deposit", "kr_stock"] })).toMatch(/예적금만/);
  });

  it("진단 전 기본값은 주린이모드 켬, 제출(PUT)은 모드를 바꾸지 않고 스위치(PATCH)만 바꾼다", () => {
    const b = bob();
    expect(db.toMe(b).beginnerMode).toBe(true);
    expect(db.investorProfile(b.id)).toMatchObject({ beginnerMode: true, answers: null, experienceLevel: null });
    const p = db.submitInvestorProfile(b.id, { answers: example });
    expect(p).toMatchObject({ beginnerMode: true, experienceScore: 1, recommendedBeginnerMode: true });
    expect(p.assessedAt).toBeTruthy();
    expect(caught(() => db.submitInvestorProfile(b.id, { answers: { ...example, q2: [] } })).status).toBe(400);
    expect(caught(() => db.submitInvestorProfile(b.id, { answers: { ...example, q2: ["kr_stock", "kr_stock"] } })).status).toBe(400);
    // q2는 서버(accounts/assessment.clean_answers)처럼 보기 순서로 저장한다 — 고른 순서와 다를 수 있다
    const reordered = db.submitInvestorProfile(b.id, { answers: { ...example, q2: ["derivatives", "kr_stock", "fund_etf"] } });
    expect(reordered.answers?.q2).toEqual(["fund_etf", "kr_stock", "derivatives"]);
    expect(Object.keys(reordered.answers ?? {})).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
    expect(db.patchInvestorProfile(b.id, { beginnerMode: false }).beginnerMode).toBe(false);
    expect(db.toMe(b).beginnerMode).toBe(false);
    expect(caught(() => db.patchInvestorProfile(b.id, { beginnerMode: "no" })).status).toBe(400);
    // 앨리스는 진단을 마친 중급 (지금 화면 테스트가 전문가 보기로 돈다)
    expect(db.investorProfile(1)).toMatchObject({ beginnerMode: false, experienceLevel: "intermediate", riskProfile: "neutral" });
  });
});

describe("실행 불가 사유 코드 · 활성화", () => {
  it("장 밖이면 미리 보기는 종가로 보고, 사유와 코드가 같은 길이·순서다", () => {
    db.options.marketOpen = { KR: false };
    const ok = db.riskPreview(1, 91, null);
    expect(ok).toMatchObject({ activatable: true, reasons: [], reasonCodes: [], lastPrice: 182_300, priceBasis: "close" });
    expect(ok.lastPriceAsOf).toBe(sessionEndIso("KR", basisDay("KR"))); // 미리 보기는 장마감 기준 (실시간 시세의 받은 시각이 아니다)

    db.options.halted = true;
    db.setClose("000660", 205_000); // 종가가 목표가(203,000) 이상
    const bad = db.riskPreview(1, 91, null, "100");
    expect(bad.reasonCodes).toEqual(["budget_too_small", "price_passed", "halted"]);
    expect(bad.reasons).toHaveLength(bad.reasonCodes.length);
    expect(bad.reasons[1]).toBe("직전 종가 205,000원가 이미 목표가 이상");
    expect(bad.approved).toBe(false);
  });

  it("활성화가 막히면 400 {detail, reasonCodes}, 입력 오류는 reasonCodes 없이", () => {
    db.options.halted = true;
    const e = caught(() => db.activate(alice(), 91, { budgetPercent: 10 }));
    expect(e.status).toBe(400);
    expect(e.extra).toEqual({ reasonCodes: ["halted"] });
    db.options.halted = false;
    const input = caught(() => db.activate(alice(), 91, { budgetPercent: 10, acknowledged: "yes" }));
    expect(input.status).toBe(400);
    expect(input.extra).toBeNull();
  });

  it("넣을 돈 (2026-10-11): 활성화는 budgetPercent·budgetKrw 중 하나가 필수, 둘 다·범위 밖은 reasonCodes 없는 400", () => {
    db.options.marketOpen = { KR: false };
    const none = caught(() => db.activate(alice(), 91, { acknowledged: true }));
    expect([none.status, none.message, none.extra]).toEqual([400, "투자 금액을 정해 주세요 (budgetPercent 또는 budgetKrw).", null]);
    const both = caught(() => db.activate(alice(), 91, { budgetPercent: 10, budgetKrw: 1_000_000 }));
    expect([both.status, both.message, both.extra]).toEqual([400, "budgetPercent와 budgetKrw 중 하나만 보냅니다.", null]);
    for (const bad of [0, 101, 12.5, "abc"]) expect(caught(() => db.riskPreview(1, 91, String(bad))).status).toBe(400);
    expect(caught(() => db.riskPreview(1, 91, null, "0")).status).toBe(400);
    expect(caught(() => db.riskPreview(1, 91, "10", "1000")).status).toBe(400);
  });

  it("미리 보기: 금액이 없으면 크기 없이 점검만, %는 매수 가능 금액 × % / 100을 원으로 내린 금액으로 수량을 계산한다", () => {
    db.options.marketOpen = { KR: false };
    const head = db.riskPreview(1, 91);
    expect(head).toMatchObject({ activatable: true, quantity: 0, amountKrw: 0, maxLossKrw: 0, limitedBy: null, budgetMode: null, budgetKrw: null, maxLossRate: null, largeLoss: false });
    expect(head.buyingPowerKrw).toBeGreaterThan(0);
    const pct = db.riskPreview(1, 91, "10");
    expect(pct).toMatchObject({ activatable: true, budgetMode: "percent", budgetPercent: 10, budgetKrw: Math.floor(head.buyingPowerKrw * 0.1), limitedBy: "내가 정한 금액" });
    expect(pct.quantity).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(pct.quantity)).toBe(true);
    expect(pct.amountKrw).toBeLessThanOrEqual(pct.budgetKrw!); // 금액 안에서 산다 (수수료 포함)
    expect(pct.maxLossRate).toBeCloseTo(pct.maxLossKrw / pct.equityKrw);
    // 같은 원 금액이면 같은 수량 (미리 보기 수량 = 활성화 수량)
    const amount = db.riskPreview(1, 91, null, String(pct.budgetKrw));
    expect(amount).toMatchObject({ budgetMode: "amount", budgetPercent: null, quantity: pct.quantity });
    const plan = db.activate(alice(), 91, { budgetPercent: 10, acknowledged: true });
    expect(plan).toMatchObject({ quantity: pct.quantity, budgetMode: "percent", budgetPercent: 10, budgetKrw: pct.budgetKrw });
  });

  it("미리 보기: 한도를 넘으면 줄이지 않고 막는다 (cash_short·total_limit), 손절 손실이 총자산 1%를 넘으면 largeLoss 경고만", () => {
    db.options.marketOpen = { KR: false };
    const head = db.riskPreview(1, 91);
    const over = db.riskPreview(1, 91, null, String(head.buyingPowerKrw + 1_000_000));
    expect(over.reasonCodes).toEqual(expect.arrayContaining(["cash_short", "total_limit"]));
    expect(over.activatable).toBe(false);
    expect(over.amountKrw).toBeGreaterThan(head.buyingPowerKrw); // 줄이지 않았다
    // 앨리스는 보유·대기 주문이 있어 총 금액 한도(5,000,000원)까지 남은 금액이 적다 — 25%부터 total_limit
    expect(db.riskPreview(1, 91, "25").reasonCodes).toEqual(["total_limit"]);
    const big = db.riskPreview(1, 91, null, "2000000"); // 손절 손실이 총자산 1%를 넘는다
    expect(big.largeLoss).toBe(true);
    expect(big.maxLossRate!).toBeGreaterThan(0.01);
    expect(big.reasonCodes).toEqual(["total_limit"]); // largeLoss는 사유가 아니다 (경고만)
    expect(db.riskPreview(1, 91, null, "1000000")).toMatchObject({ activatable: true, largeLoss: false });
  });

  it("정규장이면 미리 보기·활성화가 장중 가격으로 본다 (문장에 장중 가격 숫자가 없다)", () => {
    db.setPrice("000660", 205_000); // 종가는 그대로 (182,300)
    expect(db.riskPreview(1, 91, null)).toMatchObject({ activatable: false, reasons: ["장중 가격이 이미 목표가 이상이에요"], lastPrice: 182_300 });
    const e = caught(() => db.activate(alice(), 91, { budgetPercent: 10 }));
    expect(e.message).toBe("장중 가격이 이미 목표가 이상이에요");
    expect(e.extra).toEqual({ reasonCodes: ["price_passed"] });
    // 장이 닫혀 있으면 종가 판단만
    db.options.marketOpen = { KR: false };
    expect(db.activate(alice(), 91, { budgetPercent: 10, acknowledged: true }).status).toBe("entry_pending");
  });

  it("같은 추천을 다시 활성화하면 plan_exists와 position_exists가 둘 다 나온다 (서버 risk.evaluate와 같다)", () => {
    db.options.marketOpen = { KR: false }; // 장중 확인 없이 종가 판단만
    db.activate(alice(), 91, { budgetKrw: "1000000", acknowledged: true }); // 일반 활성화는 숫자 문자열 금액도 받는다
    expect(db.riskPreview(1, 91, null).reasonCodes).toEqual(["plan_exists", "position_exists"]);
    const e = caught(() => db.activate(alice(), 91, { budgetKrw: 200_000, acknowledged: true }));
    expect(e.extra).toEqual({ reasonCodes: ["plan_exists", "position_exists"] });
    expect(e.message.split("; ")).toHaveLength(2);
  });

  it("acknowledged·넣을 돈은 activated 사건에 남는다 (acknowledged가 없으면 false)", () => {
    const plan = db.activate(alice(), 91, { budgetKrw: 1_000_000, acknowledged: true });
    expect(plan.events[0]).toMatchObject({
      kind: "activated",
      details: { via: "web", budgetMode: "amount", budgetPercent: null, budgetKrw: 1_000_000, acknowledged: true },
    });
    expect(Object.keys(plan.events[0].details).sort()).toEqual(["acknowledged", "budgetKrw", "budgetMode", "budgetPercent", "via"]);
    const pct = db.activate(alice(), 92, { budgetPercent: 4 }); // 총 금액 한도 안
    expect(pct.events[0].details).toMatchObject({ budgetMode: "percent", budgetPercent: 4, acknowledged: false });
    expect(pct.events[0].details.budgetKrw).toBe(pct.budgetKrw);
  });
});

describe("시연용 수동 시작 (DECISIONS 31장)", () => {
  const CODES = ["reward_risk_low", "ev_negative"];

  it("미리 보기·활성화: 손익비·기대값만 skipped로 옮기고, 형식·필요 없음은 400 (사유 코드 없음), 사건·알림에 남긴다", () => {
    const id = db.addRecommendation({ symbol: "005930", entryPrice: 71_000, targetPrice: 72_000, stopPrice: 69_000 }); // 밥은 보유·주문이 없다
    expect(db.riskPreview(2, id)).toMatchObject({ activatable: false, reasonCodes: CODES, skippedCodes: [], skippedReasons: [] });
    const manual = db.riskPreview(2, id, "10", null, "1");
    expect(manual).toMatchObject({ activatable: true, approved: false, reasons: [], reasonCodes: [], skippedCodes: CODES });
    expect(manual.skippedReasons).toHaveLength(2);
    expect(caught(() => db.riskPreview(2, id, null, null, "yes")).status).toBe(400);

    expect(caught(() => db.activate(bob(), id, { budgetPercent: 10 })).extra).toEqual({ reasonCodes: CODES });
    const notNeeded = caught(() => db.activate(bob(), 91, { budgetPercent: 10, manualStart: true }));
    expect([notNeeded.status, notNeeded.message, notNeeded.extra]).toEqual([400, "손익비·기대값 점검에 막히지 않은 계획은 수동 시작(시연용) 없이 시작합니다.", null]);
    for (const bad of ["yes", "true", 1, null]) {
      const e = caught(() => db.activate(bob(), id, { budgetPercent: 10, manualStart: bad }));
      expect([e.status, e.extra], String(bad)).toEqual([400, null]);
    }

    const plan = db.activate(bob(), id, { budgetPercent: 10, acknowledged: true, manualStart: true });
    expect(plan.manualStart).toBe(true);
    expect(plan.events[0]).toMatchObject({ kind: "activated", message: "웹에서 계획 활성화 (시연용 수동 시작)", details: { manualStart: true, skippedCodes: CODES } });
    expect(plan.events[1].details).toMatchObject({ approved: false, manualStart: true });
    const notes = db.listNotifications(2, false).rows.filter((n) => n.link === `/plans/${plan.id}`);
    expect(notes.length).toBeGreaterThan(0);
    for (const n of notes) expect(n.title.startsWith("[시연용 수동 시작] "), n.title).toBe(true);
  });

  it("다른 사유(매수 유의)는 그대로 막고, 일반 계획은 manualStart false", () => {
    const warned = db.addRecommendation({ symbol: "196170", entryPrice: 350_000, targetPrice: 355_000, stopPrice: 340_000 });
    expect(db.riskPreview(2, warned, "10", null, "1")).toMatchObject({ reasonCodes: ["warning_stock"], activatable: false, skippedCodes: CODES });
    expect(db.activate(alice(), 91, { budgetPercent: 10 }).manualStart).toBe(false);
  });
});

describe("보유 방식 style", () => {
  it("목표·손절·기한이 없으면 long, 있으면 swing(둘 다 필요), 모르는 값은 400", () => {
    const long = db.placeOrder(1, { symbol: "005380", quantity: 1, orderType: "MARKET" });
    expect(long.order?.style).toBe("long");
    expect(caught(() => db.placeOrder(1, { symbol: "035420", quantity: 1, orderType: "MARKET", days: 5 })).message).toMatch(/둘 다/);
    expect(caught(() => db.placeOrder(1, { symbol: "035420", quantity: 1, orderType: "MARKET", style: "swing" })).message).toMatch(/둘 다/);
    expect(caught(() => db.placeOrder(1, { symbol: "035420", quantity: 1, orderType: "MARKET", style: "short" } as never)).status).toBe(400);
    expect(caught(() => db.placeOrder(1, { symbol: "035420", quantity: 1, orderType: "MARKET", style: "long", targetPrice: 1 })).status).toBe(400);
    const swing = db.placeOrder(1, { symbol: "035420", quantity: 1, orderType: "MARKET", targetPrice: 210_000, stopPrice: 185_000 });
    expect(swing.order?.style).toBe("swing");
  });

  it("장기 매수는 비중 점검(종가 기준)에서 막히면 400 {detail, reasonCodes}", () => {
    const e = caught(() => db.placeOrder(1, { symbol: "373220", quantity: 30, orderType: "MARKET" })); // 약 1,195만 원
    expect(e.status).toBe(400);
    expect(e.extra?.reasonCodes).toEqual(["cash_short", "position_limit", "total_limit"]);
    expect(e.message.split("; ")).toHaveLength(3);
  });

  it("정규장 밖 매수 예약은 style을 저장하고 그대로 실행한다. 고칠 수 없는 주문은 400", () => {
    db.options.marketOpen = { KR: false };
    const res = db.placeOrder(1, { symbol: "005380", quantity: 2, orderType: "MARKET" });
    expect(res.reservation?.style).toBe("long");
    db.options.marketOpen = { KR: true };
    const order = db.listOrders(1, "active").find((o) => o.symbol === "005380")!;
    expect(order.style).toBe("long");
    expect(caught(() => db.modifyOrder(1, order.id, { days: 3 })).status).toBe(400);
  });
});

describe("리포트 한도 · 내 리포트 · 결론", () => {
  it("오늘 신청한 수를 세고, 넘으면 429 {detail, limit, used}", () => {
    const me = alice();
    expect(db.reportQuota(me.id)).toMatchObject({ limit: 3, used: 1, remaining: 2 });
    db.requestReport(me, "005380");
    db.requestReport(me, "035420");
    const q = db.reportQuota(me.id);
    expect(q).toMatchObject({ used: 3, remaining: 0 });
    expect(q.resetsAt).toMatch(/T00:00:00\+09:00$/);
    const e = caught(() => db.requestReport(me, "373220"));
    expect(e.status).toBe(429);
    expect(e.extra).toEqual({ limit: 3, used: 3 });
    // 같은 종목의 진행 중 리포트는 한도와 상관없이 돌려준다
    expect(db.requestReport(me, "005380").created).toBe(false);
    expect(db.listReports(null, { mineUserId: me.id }).map((r) => r.symbol).sort()).toEqual(["005380", "005930", "035420"]);
    expect(db.listReports(null)[0]).toMatchObject({ opinion: null, oneLiner: null });
  });

  it("한도가 null이면 무제한 (서버 기본값): limit·remaining이 null이고 429가 아니다", () => {
    const me = alice();
    db.options.reportLimit = null;
    for (const symbol of ["005380", "035420", "373220"]) db.requestReport(me, symbol);
    expect(db.reportQuota(me.id)).toMatchObject({ limit: null, used: 4, remaining: null });
  });

  it("예시 리포트: 완성이면 AI 의견·한 줄 요약, 실패는 사유 코드, 긍정적이면 추천이 이어진다", () => {
    db.addSampleReports();
    const rows = db.listReports(null);
    const buy = rows.find((r) => r.symbol === "035420")!;
    expect(buy).toMatchObject({ status: "completed", opinion: "buy" });
    expect(buy.oneLiner).toMatch(/NAVER/);
    expect(rows.find((r) => r.symbol === "373220")).toMatchObject({ opinion: "hold" });
    const failed = db.getReport(rows.find((r) => r.symbol === "086520")!.id);
    expect(failed).toMatchObject({ status: "failed", opinion: null });
    expect(failed.trace.at(-1)?.details.reason).toBe("review_failed");
    const draft = db.getReport(buy.id).state.results.report_agent as { plainSummary: string[] };
    expect(draft.plainSummary).toHaveLength(3);
    for (const s of draft.plainSummary) expect(s).not.toMatch(/\d/); // 숫자 없는 쉬운 문장
    expect(db.listRecommendations(1, { source: "report", sourceId: String(buy.id), status: "all" })).toHaveLength(1);
  });
});

describe("장기투자", () => {
  it("오늘의 내 종목 뉴스: 내 국내 보유 종목만 (이름순), 인과 단정·권유 문장이 없다", () => {
    const list = db.dailyMoves(1, null);
    expect(list.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(list.results.map((m) => m.symbol)).toEqual(["005930", "068270"]); // 삼성전자 · 셀트리온 (NVIDIA는 미국)
    for (const m of list.results) {
      expect(m.market).toBe("KR");
      expect(m.sectorChangeRate).toBeNull();
      expect(m.excessChangeRate).toBeCloseTo(m.changeRate - (m.marketProxy.changeRate ?? 0), 6);
      expect(m.marketProxy.name).toBe("KODEX 200");
      for (const s of [m.headline, ...m.summary]) expect(hasForbidden(s), s).toBe(false);
      for (const id of m.drivers) expect(m.evidence.some((e) => e.id === id)).toBe(true);
    }
    expect(db.dailyMoves(2, null)).toEqual({ date: null, results: [] }); // 보유 없음
    expect(caught(() => db.dailyMoveOne("AAPL", null)).status).toBe(404);
    expect(caught(() => db.dailyMoves(1, "10/05")).status).toBe(400);
  });

  it("오늘의 내 종목 뉴스: 수급 근거 셋(외국인·기관·개인), 변동성이 없으면 LLM을 생략하지 않는다 (서버 daily_move와 같다)", () => {
    const stock = seedStocks().find((x) => x.symbol === "005930")!;
    const bar = (date: string, close: number) => ({ date, open: close, high: close, low: close, close, volume: 1_000_000 });
    // 공시·증권사 헤드라인이 없는 날을 고르고, 종목 등락을 시장 대용 ETF와 같게 맞춰 초과 등락을 0으로 만든다
    const days = Array.from({ length: 28 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
    const calm = days
      .map((day) => dailyMoveOf(stock, [bar("2026-08-31", 10_000), bar(day, 10_000)], "키움")!)
      .find((m) => !m.evidence.some((e) => e.kind === "disclosure" || e.kind === "broker"))!;
    expect(calm).toBeTruthy();
    expect(calm.evidence.filter((e) => e.kind === "flow").map((e) => e.text.split(" ")[0])).toEqual(["외국인", "기관", "개인"]);
    expect(calm.evidence.filter((e) => e.kind === "flow").every((e) => e.source === "키움" && e.reliability === "high")).toBe(true);
    expect(calm.evidence.map((e) => e.id)).toEqual(calm.evidence.map((_, i) => `E${i + 1}`));

    const day = calm.date;
    const rate = calm.marketProxy.changeRate!;
    const close = Math.round(10_000 * (1 + rate));
    // 일봉 2개 → 20일 변동성 없음 → 생략하지 않는다
    const short = dailyMoveOf(stock, [bar("2026-08-31", 10_000), bar(day, close)], "키움")!;
    expect(short.volatility20).toBeNull();
    expect(Math.abs(short.excessChangeRate!)).toBeLessThan(0.01);
    expect(short.method).toBe("llm");
    // 같은 날, 출렁이던 20일 (변동성 > |초과 등락|) → 템플릿 "시장과 비슷하게"
    const history = Array.from({ length: 21 }, (_, i) => bar(`2026-08-${String(i + 1).padStart(2, "0")}`, i % 2 ? 9_500 : 10_500));
    const long = dailyMoveOf(stock, [...history, bar("2026-08-31", 10_000), bar(day, close)], "키움")!;
    expect(long.volatility20).not.toBeNull();
    expect(long.method).toBe("template");
    expect(long.headline).toBe("오늘은 시장과 비슷하게 움직였어요");
  });

  it("펀더멘털: 9개 지표, 적용하지 않는 종목, 종합 판정", () => {
    const f = db.fundamentals(1, "068270");
    expect(f).toMatchObject({ applicable: true, source: "금융감독원 OpenDART", caption: "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다" });
    expect(f.rows.map((r) => r.key)).toEqual([
      "revenueGrowth", "operatingIncomeGrowth", "operatingMargin", "roe", "debtRatio", "currentRatio", "interestCoverage", "operatingCashFlow", "earningsQuality",
    ]);
    expect(f.rows.every((r) => r.baseline === null && r.change === null)).toBe(true);
    expect(f.rows.find((r) => r.key === "debtRatio")).toMatchObject({ status: "na", note: "기준선이 있어야 판정해요" });
    expect(f.thesis).toMatchObject({ symbol: "068270", active: true });
    expect(db.fundamentals(1, "105560")).toMatchObject({ applicable: false, overall: "na", rows: [], reason: "금융업은 일반 기업용 점검을 적용하지 않아요" });
    expect(db.fundamentals(1, "AAPL").applicable).toBe(false);
    const eco = db.fundamentals(1, "086520");
    expect(eco.overall).toBe("review");
    expect(eco.rows.find((r) => r.key === "operatingIncomeGrowth")).toMatchObject({ status: "bad", note: "적자 전환" });
  });

  it("산 이유: 처음 저장할 때 기준선, 입력 검사, 지우기", () => {
    const seeded = db.listTheses(1)[0];
    expect(seeded).toMatchObject({ symbol: "068270", active: true, baselinePeriod: "2025 사업보고서" });
    expect(seeded.lastCheck?.rows).toHaveLength(9);
    expect(seeded.lastCheck?.rows.find((r) => r.key === "operatingMargin")?.change).toBeCloseTo(-0.018, 6);
    // 기준선은 operatingMargin·roe·debtRatio 셋만. 나머지 여섯은 산 이유가 있어도 baseline·change가 null
    const withBase = seeded.lastCheck?.rows.filter((r) => r.baseline !== null).map((r) => r.key);
    expect(withBase).toEqual(["operatingMargin", "roe", "debtRatio"]);
    expect(seeded.lastCheck?.rows.filter((r) => r.baseline === null).every((r) => r.change === null)).toBe(true);
    expect(db.fundamentals(1, "068270").thesis?.lastCheck?.rows.filter((r) => r.baseline !== null)).toHaveLength(3);

    const t = db.putThesis(1, "005930", { reasons: ["  메모리 업황 회복  "] });
    expect(t).toMatchObject({ reasons: ["메모리 업황 회복"], axes: [], active: false }); // 스윙 보유라 점검 대상 아님
    expect(Object.keys(t.baseline)).toHaveLength(9);
    expect(db.putThesis(1, "005930", { reasons: ["바꾼 이유"], axes: ["growth"] }).axes).toEqual(["growth"]);
    expect(db.putThesis(1, "005930", { reasons: ["또 바꿈"] }).axes).toEqual(["growth"]); // axes를 빼면 그대로
    expect(caught(() => db.putThesis(1, "005930", { reasons: [] })).status).toBe(400);
    expect(caught(() => db.putThesis(1, "005930", { reasons: ["x".repeat(101)] })).status).toBe(400);
    expect(caught(() => db.putThesis(1, "005930", { reasons: ["a"], axes: ["growth", "growth"] })).status).toBe(400);
    expect(caught(() => db.putThesis(1, "005930", { reasons: ["a"], note: "x" })).status).toBe(400);
    expect(caught(() => db.putThesis(1, "XXXX", { reasons: ["a"] })).status).toBe(404);
    db.deleteThesis(1, "005930");
    expect(caught(() => db.deleteThesis(1, "005930")).status).toBe(404);
  });

  it("산 이유 active: 정규장 밖 장기 매수 예약도 보유로 본다 (서버 long_holdings)", () => {
    db.options.marketOpen = { KR: false };
    const res = db.placeOrder(1, { symbol: "005380", quantity: 1, orderType: "MARKET" });
    expect(res.reservation).toMatchObject({ kind: "BUY", style: "long" });
    expect(db.putThesis(1, "005380", { reasons: ["전기차 판매 증가"] }).active).toBe(true);
    // 스윙 매수 예약은 장기 보유가 아니다
    db.placeOrder(1, { symbol: "035420", quantity: 1, orderType: "MARKET", targetPrice: 210_000, stopPrice: 185_000 });
    expect(db.putThesis(1, "035420", { reasons: ["검색 광고 회복"] }).active).toBe(false);
  });
});

describe("계약 모양 (docs/API.md)", () => {
  it("분석 요청자는 닉네임으로 내고, mine은 저장된 요청자 id로 거른다", () => {
    const all = db.listAnalyses(null, null);
    expect(new Set(all.map((a) => a.requestedBy))).toEqual(new Set(["앨리스", "strategy:1", "밥", "cli", "데이브"]));
    const mine = db.listAnalyses(null, null, alice());
    expect(mine.map((a) => a.symbol).sort()).toEqual(["005930", "AAPL"]);
    expect(mine.every((a) => a.requestedBy === "앨리스")).toBe(true);
    expect(db.getAnalysis(1)).not.toHaveProperty("requesterId");
  });

  it("시연용 추천의 진입가는 직전 장마감 종가", () => {
    const r = db.createDemo(alice(), { symbol: "035420" });
    expect(r.entryPrice).toBe(191_200);
    expect(r.priceAtCreation).toBe(191_200);
    expect(r.reasons[1]).toBe("직전 장마감 종가로 진입");
  });

  it("끝난 계획(95)의 사건 details가 PlanEventKind 모양을 따른다", () => {
    const keys = Object.fromEntries(db.getPlan(1, 95).events.map((e) => [e.kind, Object.keys(e.details).sort()]));
    expect(keys).toEqual({
      activated: ["acknowledged", "budgetKrw", "via"],
      risk_checked: ["approved", "limitedBy", "quantity", "reasons", "rewardRisk"],
      order_placed: ["limitPrice", "orderId", "quantity"],
      order_requeued: ["orderId", "previousOrderId"],
      filled: ["fillPrice", "orderId", "quantity"],
      closed: ["exitPrice", "exitReason", "orderId", "pnlKrw"],
    });
  });

  it("보유 중 계획 중단 → 청산 사건·알림 문구는 청산 사유 표(사용자 매도)를 따른다", () => {
    at("2026-10-06T10:00:00+09:00");
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000); // 진입가 아래 → 지정가 체결
    expect(db.getPlan(1, plan.id).status).toBe("holding");
    const closed = db.cancelPlan(1, plan.id);
    expect(closed).toMatchObject({ status: "closed", exitReason: "MANUAL" });
    expect(closed.events.at(-1)?.message).toMatch(/^사용자 매도로 청산/);
  });
});

describe("HTTP (MSW 핸들러 + api 클라이언트)", () => {
  it("PUT·PATCH 투자자 프로필, 오류 본문의 reasonCodes·limit을 ApiError로 읽는다", async () => {
    db.setSession("bob");
    const put = await api.put<InvestorProfile>("/api/me/investor-profile", {
      answers: { q1: "none", q2: ["deposit"], q3: "never", q4: "heard", q5: "loss_10", q6: "weeks", q7: "practice" },
    });
    expect(put.experienceLevel).toBe("intro");
    expect((await api.patch<InvestorProfile>("/api/me/investor-profile", { beginnerMode: false })).beginnerMode).toBe(false);

    db.setSession("alice");
    db.options.halted = true;
    const blocked = await api.post("/api/recommendations/91/activate", { budgetPercent: 10, acknowledged: true }).catch((e: unknown) => e);
    expect(blocked).toBeInstanceOf(ApiError);
    expect((blocked as ApiError).reasonCodes).toEqual(["halted"]);
    expect((blocked as ApiError).detail).toBe("새 모의 매수가 중단되어 있습니다.");

    db.options.reportLimit = 1;
    expect((await api.get<ReportQuota>("/api/reports/quota")).remaining).toBe(0);
    const limited = (await api.post("/api/reports", { symbol: "005380" }).catch((e: unknown) => e)) as ApiError;
    expect(limited.status).toBe(429);
    expect([limited.num("limit"), limited.num("used")]).toEqual([1, 1]);
    expect(limited.reasonCodes).toBeNull();
  });
});
