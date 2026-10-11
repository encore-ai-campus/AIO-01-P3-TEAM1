import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import type { ReasonCode, TraceEvent } from "../api/types";
import { GLOSSARY, GLOSSARY_KEYS, glossaryOf } from "./glossary";
import * as plain from "./plainText";

// docs/API.md 공통 규칙 "금지 표현"의 PERSUASION 최소 목록 (공백을 지운 뒤 부분 문자열로 비교)
const PERSUASION = [
  "사세요", "사 볼 만해요", "사 볼 만", "매수하세요", "매수 기회", "지금 사면", "담으세요", "좋아요", "파세요", "팔아야",
  "매도하세요", "매도 기회", "지금 팔면", "정리하세요", "비중을 줄이세요", "비중을 늘리세요", "손절하세요",
];
const CAUSAL_AND_PREDICTION = ["때문에", "덕분에", "원인은", "탓에", "영향으로", "오를 것", "내릴 것", "오를 거", "내릴 거", "상승할 것", "하락할 것", "반등할 것"];
const squash = (s: string) => s.replace(/\s+/g, "");
const forbidden = (text: string, list: string[]) => list.filter((p) => squash(text).includes(squash(p)));

/** 객체 안의 모든 문자열 (함수 제외). */
function strings(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.flatMap(strings);
  if (v && typeof v === "object") return Object.values(v).flatMap(strings);
  return [];
}

// docs/API.md "실행 불가 사유 코드" 표 그대로
const API_REASON_CODES: ReasonCode[] = [
  "reward_risk_low", "ev_negative", "daily_loss_limit", "daily_trades_limit", "warning_stock", "size_too_small", "budget_too_small",
  "expired", "plan_exists", "position_exists", "halted", "price_passed", "cash_short", "position_limit", "total_limit",
];

describe("쉬운 문장 표", () => {
  it("실행 불가 사유 코드는 표의 코드마다 문장이 있고, 모르는 코드는 원문을 보인다", () => {
    expect(Object.keys(plain.REASON_TEXT).sort()).toEqual([...API_REASON_CODES].sort());
    for (const code of API_REASON_CODES) expect(plain.reasonSentence(code, "원문")).not.toBe("원문");
    expect(plain.reasonSentence("brand_new_code", "서버가 준 원문")).toBe("서버가 준 원문");
    expect(plain.reasonSentence("brand_new_code")).toBe("brand_new_code");
    expect(plain.reasonSentence(null, "원문")).toBe("원문");
  });

  it("계획 문맥(plan)은 넣을 돈 문장, 장기 매수 주문(기본)은 그대로 (같은 사유 코드 — 2026-10-11)", () => {
    expect(plain.reasonSentence("cash_short", null, "plan")).toBe("넣을 돈이 매수 가능 금액보다 많아요");
    expect(plain.reasonSentence("total_limit", null, "plan")).toBe("모의 자동매매에 넣을 수 있는 총 금액 한도를 넘어요");
    expect(plain.reasonSentence("budget_too_small", null, "plan")).toBe("이 금액으로는 1주도 살 수 없어요");
    expect(plain.reasonSentence("cash_short")).toBe("매수 가능 금액보다 사려는 금액이 커요");
    expect(plain.reasonSentence("total_limit")).toBe("총 투자 금액 한도를 넘어요");
    expect(plain.reasonSentence("halted", null, "plan")).toBe(plain.REASON_TEXT.halted); // 계획 문장이 없는 코드는 같은 문장
    const blocked = new ApiError(400, "매수 금액 2,000,000원이 매수 가능 금액 1,000,000원보다 큼; 총 금액 한도(5,000,000원)를 넘습니다", {
      detail: "",
      reasonCodes: ["cash_short", "total_limit"],
    });
    expect(plain.rejectionSentences(blocked, "plan")).toEqual(["넣을 돈이 매수 가능 금액보다 많아요", "모의 자동매매에 넣을 수 있는 총 금액 한도를 넘어요"]);
    expect(plain.errorSentence(blocked)).toBe("매수 가능 금액보다 사려는 금액이 커요 · 총 투자 금액 한도를 넘어요"); // 주문 화면 문장은 그대로
    for (const t of Object.values(plain.PLAN_REASON_TEXT)) expect(forbidden(t, PERSUASION)).toEqual([]);
  });

  it("코드·원문 짝을 쉬운 문장으로 (같은 문장은 한 번, 코드가 모자라면 원문)", () => {
    const out = plain.reasonSentences(["halted", "price_passed", "price_passed"], ["중단", "종가가 목표가 이상", "장중 가격이 이미 손절가 이하예요", "코드 없는 원문"]);
    expect(out).toEqual([plain.REASON_TEXT.halted, plain.REASON_TEXT.price_passed, "코드 없는 원문"]);
  });

  it("400 {detail, reasonCodes}만 실행 불가 사유로 읽고, 입력 오류는 detail 그대로", () => {
    const blocked = new ApiError(400, "새 모의 매수가 중단되어 있습니다.; 신기한 사유", { detail: "x", reasonCodes: ["halted", "unknown_code"] });
    expect(plain.rejectionSentences(blocked)).toEqual([plain.REASON_TEXT.halted, "신기한 사유"]);
    expect(plain.errorSentence(blocked)).toBe(`${plain.REASON_TEXT.halted} · 신기한 사유`);
    const input = new ApiError(400, "budgetKrw는 0보다 큰 숫자여야 합니다.", { detail: "budgetKrw는 0보다 큰 숫자여야 합니다." });
    expect(plain.rejectionSentences(input)).toBeNull();
    expect(plain.errorSentence(input)).toBe("budgetKrw는 0보다 큰 숫자여야 합니다.");
    expect(plain.rejectionSentences(new Error("boom"))).toBeNull();
  });

  it("리포트 상태·AI 의견·실패 사유", () => {
    expect(plain.reportStatusText("running")).toBe("만드는 중");
    expect(plain.reportStatusText("running", false)).toBe("실행 중");
    expect(plain.reportStatusText("mystery")).toBe("mystery");
    expect(plain.opinionText("buy")).toMatchObject({ label: "AI 의견: 긍정적", line: "오를 근거가 더 많다고 봤어요" });
    expect(plain.opinionText("avoid")?.badge).toBe("부정적");
    expect(plain.opinionText(null)).toBeNull();
    expect(plain.reportFailureSentence("join_blocked")).toBe("자료를 모으는 AI가 응답하지 않아 리포트를 쓸 수 없었어요");
    expect(plain.reportFailureSentence("exception")).toBe("예상하지 못한 오류로 멈췄어요");
    expect(plain.reportFailureSentence("whatever")).toBe(plain.REPORT_FAILURE_FALLBACK);
    const ev = (step: number, action: string, details: Record<string, unknown> = {}): TraceEvent => ({
      step, actor: "orchestrator", action, status: "failed", provider: null, model: null, latencyMs: null, details, at: "2026-10-02T10:00:00+09:00",
    });
    expect(plain.failureReasonOf([ev(1, "workflow_started"), ev(2, "workflow_failed", { reason: "timeout" })])).toBe("timeout");
    expect(plain.failureReasonOf([ev(1, "workflow_failed")])).toBeNull();
    expect(plain.failureReasonOf([])).toBeNull();
  });

  it("계획 상태·청산 사유·알림 종류", () => {
    expect(plain.planStatusText("entry_pending")).toBe("사는 가격을 기다리는 중");
    expect(plain.planStatusText("entry_pending", false)).toBe("체결 대기");
    expect(plain.exitReasonText("EXPIRED")).toBe("보유 기간이 끝나 그날 가격에 모의 계좌에서 팔았어요");
    expect(plain.exitReasonText("EXPIRED", false)).toBe("보유 기한 경과");
    expect(plain.exitReasonText("NEW")).toBe("NEW");
    expect(plain.notificationKindText("report_failed")).toBe("리포트 만들지 못함");
    expect(plain.notificationKindText("brand_new_kind")).toBe("알림");
    expect(Object.keys(plain.NOTIFICATION_KIND_TEXT)).toEqual(
      expect.arrayContaining(["report_completed", "report_failed", "daily_move", "thesis_check"]),
    );
  });

  it("사건 문장: 주문·체결·청산·자동매매를 말하는 문장에는 '모의'가 있다", () => {
    const sentence = (kind: string, details: Record<string, unknown>) => plain.planEventSentence({ kind, details, message: "원래 문장" });
    const made = {
      activated: sentence("activated", { via: "web", budgetKrw: 1_000_000, acknowledged: true }),
      risk_checked: sentence("risk_checked", { approved: true, quantity: 5 }),
      order_placed: sentence("order_placed", { limitPrice: 181_000, quantity: 5 }),
      order_requeued: sentence("order_requeued", { quantity: 4, previousQuantity: 5 }),
      filled: sentence("filled", { fillPrice: 180_000, quantity: 5 }),
      exit_requested: sentence("exit_requested", {}),
      closed: sentence("closed", { exitReason: "STOP", exitPrice: 98_700, pnlKrw: -1_234 }),
      cancelled: sentence("cancelled", {}),
      expired: sentence("expired", {}),
      failed: sentence("failed", {}),
    };
    for (const [kind, text] of Object.entries(made)) expect(text, kind).toContain("모의");
    expect(made.activated).toBe("모의 자동매매를 시작했어요 (예산 1,000,000원)"); // 2026-10-11 전 계획 (budgetMode 없음)
    // 2026-10-11부터: 넣은 돈을 정한 방식대로
    expect(sentence("activated", { via: "web", budgetMode: "percent", budgetPercent: 25, budgetKrw: 1_570_626, acknowledged: true })).toBe(
      "모의 자동매매를 시작했어요 (넣은 돈: 내 자금의 25% · 1,570,626원)",
    );
    expect(sentence("activated", { via: "web", budgetMode: "amount", budgetPercent: null, budgetKrw: 1_000_000 })).toBe("모의 자동매매를 시작했어요 (넣은 돈: 1,000,000원)");
    expect(sentence("risk_checked", { approved: true, quantity: 5, limitedBy: "내가 정한 금액" })).toBe(
      "넣은 돈으로 모의 주문 수량 5주를 계산했고, 안전장치가 한도를 확인했어요",
    );
    // 시연용 수동 시작 (DECISIONS 31장): approved=false를 남기지만 막힌 것이 아니다 — 그 말을 먼저 한다
    expect(sentence("activated", { budgetMode: "percent", budgetPercent: 10, budgetKrw: 1_000_000, manualStart: true })).toBe(
      "시연용으로 모의 자동매매를 직접 시작했어요 (넣은 돈: 내 자금의 10% · 1,000,000원)",
    );
    expect(sentence("risk_checked", { approved: false, manualStart: true, quantity: 14, limitedBy: "내가 정한 금액" })).toBe(
      "시연용 수동 시작이라 안전장치의 손익비·기대 수익 점검을 건너뛰고, 넣은 돈으로 모의 주문 수량 14주를 계산했어요",
    );
    expect(sentence("risk_checked", { approved: false, quantity: 14 })).toBe("안전장치가 모의 주문을 막았어요");
    expect(made.order_placed).toBe("모의 계좌에서 181,000원 이하에 5주를 사는 주문을 넣었어요");
    expect(made.order_requeued).toContain("(수량 5주 → 4주)");
    expect(made.closed).toBe("손절 가격에 닿아 손실이 더 커지지 않게 모의 계좌에서 98,700원에 팔았어요 (손익 -1,234원)");
    // 청산 사유·계획 상태 설명도 쉬운 문장이라 "모의"가 있다 (체결 내역·계획 화면·홈 카드에서 실제 매도로 읽히지 않게)
    for (const [reason, w] of Object.entries(plain.EXIT_REASON_TEXT)) expect(w.easy, reason).toContain("모의");
    for (const [status, w] of Object.entries(plain.PLAN_STATUS_TEXT)) expect(w.line, status).toContain("모의");
    expect(plain.planEventSentence({ kind: "filled", details: { fillPrice: 1.5, quantity: 2 }, message: "" }, "USD")).toContain("$1.50");
    // 모르는 kind나 details가 모자라면 서버 문장 그대로
    expect(sentence("brand_new", {})).toBe("원래 문장");
    expect(sentence("filled", {})).toBe("원래 문장");
  });

  it("시세 가격의 이름은 기준을 따른다 (실시간 = 현재가·쉬운 말 지금 가격, 장마감 = 종가)", () => {
    expect(plain.quotePriceName("live")).toBe("현재가");
    expect(plain.quotePriceName("live", true)).toBe("지금 가격");
    expect(plain.quotePriceName("close")).toBe("종가");
    expect(plain.quotePriceName("close", true)).toBe("종가");
    expect(plain.quotePriceName(undefined)).toBe("종가");
    expect(plain.marketOrderEstimate("live")).toBe("지금 시세 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요");
    expect(plain.marketOrderEstimate("close")).toBe(plain.MARKET_ORDER_ESTIMATE);
    expect(plain.marketOrderEstimate(undefined)).toBe(plain.MARKET_ORDER_ESTIMATE);
  });

  it("출처 줄·면책·투자자 진단 문항", () => {
    expect(plain.sourceLine("키움증권 REST API")).toBe(
      "시세: 키움증권 REST API 조회 · 실시간 (계좌·랭킹은 장마감 기준) | 공시·재무: 금융감독원 OpenDART, 금융위원회(공공데이터포털) | 뉴스 제목: Google 뉴스 검색 결과(각 언론사)",
    );
    expect(plain.DISCLAIMER).toBe("이 리포트는 AI가 만든 참고 자료이며 투자 권유가 아닙니다. 모든 매매는 모의 계좌에서만 이뤄집니다.");
    expect(plain.INVESTOR_QUESTIONS.map((q) => q.key)).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
    expect(plain.INVESTOR_QUESTIONS.filter((q) => q.multiple).map((q) => q.key)).toEqual(["q2"]);
    expect(plain.SOURCE_TEXT.demo.label).toBe("연습용 예시 계획 (AI 아님)");
    expect(plain.FUNDAMENTALS_OVERALL_TEXT).toEqual({ solid: "기준 충족", caution: "주의", review: "확인 필요", na: "적용하지 않음" });
  });

  it("고정 문구·표에 권유 표현이 없고, 시장 움직임 문구에는 인과 단정·예측도 없다", () => {
    const all = strings(plain);
    expect(all.length).toBeGreaterThan(100);
    for (const text of all) expect(forbidden(text, PERSUASION), text).toEqual([]);
    for (const text of [plain.DAILY_MOVE_CAPTION, plain.DAILY_MOVE_UNCERTAIN, plain.CLOSE_BASIS_NOTE]) {
      expect(forbidden(text, CAUSAL_AND_PREDICTION), text).toEqual([]);
    }
  });
});

describe("용어 사전", () => {
  it("28개 (P0 15 + P1 13), 컨셉 계획의 용어가 모두 있다", () => {
    expect(GLOSSARY_KEYS).toHaveLength(28);
    expect(GLOSSARY_KEYS.filter((k) => GLOSSARY[k].tier === "P0")).toEqual([
      "PER", "PBR", "ROE", "손절", "목표 가격", "손익비", "지정가", "체결", "보유 기간", "거래일", "변동성", "거래대금", "이동평균", "RSI", "모의 투자",
    ]);
    expect(GLOSSARY_KEYS.filter((k) => GLOSSARY[k].tier === "P1")).toEqual([
      "시장가", "종가", "장마감 기준", "부채비율", "유동비율", "영업이익률", "영업현금흐름", "이자보상배율", "공시", "수급", "초과 등락", "수수료", "거래세",
    ]);
    for (const k of GLOSSARY_KEYS) {
      expect(GLOSSARY[k].term).toBe(k);
      expect(GLOSSARY[k].short.length).toBeGreaterThan(10);
      expect(forbidden(GLOSSARY[k].short, [...PERSUASION, ...CAUSAL_AND_PREDICTION]), k).toEqual([]);
    }
    expect(glossaryOf("손익비")?.term).toBe("손익비");
    expect(glossaryOf("없는 말")).toBeNull();
  });
});
