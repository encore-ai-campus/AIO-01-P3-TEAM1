// 운영 E2E 점검 뒤 고친 계획 제안·실행 확인·계획 진행 화면 (docs/records/운영E2E점검_UX리뷰_2026-10-08.md, DECISIONS 23장).
// UX-2 시작할 수 없는 제안 구별 · UX-3 바로 사는 경우 · UX-10 수수료·세금 빼기 전 · UX-11 기한 날짜 · UX-14 Discord 묶음 접기 · UX-16 7자리 가격 · 문구.
// 앨리스는 전문가 보기, 밥은 쉬운 보기(주린이모드)다. 배치는 CSS만으로 바뀌므로(JS 폭 분기 없음) 모바일·PC는 같은 내용이 보이는지와 반응형 클래스로 본다.
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Recommendation } from "../api/types";
import { RecommendationCard } from "../components/autotrade/RecommendationCard";
import { arrangeProposals, buysRightAway, deadlineMovedEarlier, entryDeadlineLabel, splitProposals, startableFirst } from "../lib/autotrade";
import { formatRate } from "../lib/format";
import { NOT_SUITABILITY, blockedShort, exitReasonText, planEventSentence, planExitText } from "../lib/plainText";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

const toast = () => screen.getByRole("status");
const userOf = (username: string) => {
  db.setSession(username);
  return db.sessionUser()!;
};
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/**
 * 시작할 수 없는 제안(손익비 미달)과 같은 종목의 겹친 제안을 더한다. 맨 위(최신) 셋이 모두 시작할 수 없게 만든다 —
 * 정렬하지 않으면 홈·모의투자 탭의 압축 목록 위 셋이 모두 '시작할 수 없음'이 된다 (운영에서 본 상황).
 */
function seedBlocked() {
  const kakao = db.addRecommendation({ symbol: "035720", entryPrice: 45_000, targetPrice: 45_500, stopPrice: 44_000, createdAt: minutesAgo(1) });
  const samsungNew = db.addRecommendation({ symbol: "005930", entryPrice: 71_000, targetPrice: 72_000, stopPrice: 69_000, createdAt: minutesAgo(10) });
  const samsungOld = db.addRecommendation({ symbol: "005930", entryPrice: 70_000, targetPrice: 71_000, stopPrice: 68_000, createdAt: minutesAgo(20) });
  // SK하이닉스: 시작할 수 있는 리포트 제안(91, 5시간 전)보다 먼저 만든 같은 종목 제안
  const skOld = db.addRecommendation({ symbol: "000660", entryPrice: 181_000, targetPrice: 203_000, stopPrice: 173_000, createdAt: minutesAgo(600) });
  return { kakao, samsungNew, samsungOld, skOld };
}

const VIEWPORTS = [
  ["모바일 390px", 390],
  ["PC 1280px", 1280],
] as const;

describe.each(VIEWPORTS)("UX-2 계획 제안 목록 · %s", (_name, width) => {
  beforeEach(() => vi.stubGlobal("innerWidth", width));
  afterEach(() => vi.unstubAllGlobals());

  it("쉬운 보기: 시작할 수 있는 것만 앞에(배지 '시작할 수 있음'), 시작할 수 없는 것은 아래 접힘에 이유 한 마디와, 같은 종목은 카드 안에 접는다", async () => {
    seedBlocked();
    renderApp("/recommendations", "bob");
    const list = await screen.findByRole("list", { name: "추천 목록" });
    expect(list.className).toContain("sm:grid-cols-2"); // PC는 2열
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual(["SK하이닉스 계획 제안 보기"]);
    expect(within(list).getByText("시작할 수 있음")).toBeTruthy();
    expect(screen.getByRole("heading", { name: /^기한이 남은 계획\s?1$/ })).toBeTruthy();

    // 같은 종목의 이전 제안은 그 카드 안에 접혀 있다
    const older = within(list).getByRole("button", { name: "같은 종목의 이전 제안 1개" });
    expect(older.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(older);
    const olderList = within(list).getByRole("list", { name: "SK하이닉스 이전 제안" });
    expect(within(olderList).getAllByRole("link")).toHaveLength(1);

    // 시작할 수 없는 제안: 접혀 있고, 펼치면 이유 한 마디
    const fold = screen.getByRole("button", { name: "지금은 시작할 수 없는 제안 2개" });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("link", { name: "카카오 계획 제안 보기" })).toBeNull();
    fireEvent.click(fold);
    const blocked = screen.getByRole("list", { name: "시작할 수 없는 제안 목록" });
    expect(within(blocked).getAllByRole("link", { name: /계획 제안 보기$/ }).map((a) => a.getAttribute("aria-label"))).toEqual([
      "카카오 계획 제안 보기",
      "삼성전자 계획 제안 보기",
    ]);
    expect(within(blocked).getAllByText("지금은 시작할 수 없음 · 버는 돈에 비해 잃을 수 있는 돈이 커요")).toHaveLength(2);
    // 삼성전자 두 장은 하나로 (나머지는 그 카드 안)
    expect(within(blocked).getByRole("button", { name: "같은 종목의 이전 제안 1개" })).toBeTruthy();
    // 분석·연습용 예시(시작할 수 있음)는 지금처럼 '다른 계획'으로 접힌다
    expect(screen.getByRole("button", { name: /^다른 계획 2개/ })).toBeTruthy();
  });

  it("전문가 보기: 활성화 가능한 추천이 먼저, 활성화할 수 없는 추천은 접힘 '지금은 활성화할 수 없는 추천 n개'", async () => {
    seedBlocked();
    renderApp("/recommendations");
    const list = await screen.findByRole("list", { name: "추천 목록" });
    expect(within(list).getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual(["NAVER 추천 보기", "SK하이닉스 추천 보기", "에코프로비엠 추천 보기"]);
    expect(within(list).getAllByText("활성화 가능")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "지금은 활성화할 수 없는 추천 2개" }));
    const blocked = screen.getByRole("list", { name: "활성화할 수 없는 추천 목록" });
    expect(within(blocked).getAllByText("활성화 불가 · 손익비 1.5 미만")).toHaveLength(2);
  });

  it("모의투자 탭(쉬운 보기)의 압축 목록: 시작할 수 있는 것이 먼저, 시작할 수 없는 것에는 작은 표시", async () => {
    seedBlocked();
    renderApp("/portfolio", "bob");
    const main = await screen.findByRole("list", { name: "새 계획 제안 목록" });
    const rows = within(main).getAllByRole("link");
    expect(rows).toHaveLength(3);
    expect(rows[0].getAttribute("aria-label")).toBe("SK하이닉스 계획 제안 보기");
    expect(within(rows[0]).queryByText("시작할 수 없음")).toBeNull();
    expect(within(rows[2]).getByText("시작할 수 없음")).toBeTruthy(); // 위 둘은 시작할 수 있는 SK하이닉스, 셋째부터 시작할 수 없는 것
  });

  it("전문가 홈의 '새 계획 제안' 위 셋: 최신 셋이 모두 활성화 불가여도 활성화할 수 있는 것을 먼저 고른다", async () => {
    seedBlocked();
    renderApp("/");
    const recs = await screen.findByRole("list", { name: "AI 추천 요약" });
    const links = within(recs).getAllByRole("link");
    expect(links).toHaveLength(3);
    expect(links[0].getAttribute("href")).toBe("/recommendations/93");
    expect(within(recs).queryByText("활성화 불가")).toBeNull();
  });
});

describe.each(VIEWPORTS)("UX-2 계획 제안 상세 · %s", (_name, width) => {
  beforeEach(() => vi.stubGlobal("innerWidth", width));
  afterEach(() => vi.unstubAllGlobals());

  it("쉬운 보기: 시작할 수 없으면 머리 배지 아래 이유 한 줄, 넣을 돈·체크리스트·시작 버튼 대신 이유와 '다른 계획 제안 보기'", async () => {
    const { samsungNew } = seedBlocked();
    renderApp(`/recommendations/${samsungNew}`, "bob");
    expect(await screen.findByRole("heading", { name: "삼성전자 계획 제안" })).toBeTruthy();
    const head = screen.getByText("삼성전자", { selector: "p" }).closest("section")!;
    const sentence = "버는 돈에 비해 잃을 수 있는 돈이 커서 안전장치가 막았어요(손익비 기준 1.5 미만)";
    expect(within(head).getByText(sentence)).toBeTruthy();
    expect(await within(head).findByText("지금은 시작할 수 없음")).toBeTruthy();
    const reasons = await screen.findByRole("list", { name: "시작할 수 없는 이유" });
    expect(within(reasons).getByText(sentence)).toBeTruthy();
    expect(screen.queryByRole("group", { name: "넣을 돈 정하는 방식" })).toBeNull();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "모의 자동매매 시작" })).toBeNull();
    expect(screen.getByRole("link", { name: /다른 계획 제안 보기/ }).getAttribute("href")).toBe("/recommendations");
  });

  it("전문가 보기: 같은 규칙 (머리 아래 서버 사유 한 줄 · 활성화 버튼 없음 · 다른 추천 보기)", async () => {
    const { samsungNew } = seedBlocked();
    renderApp(`/recommendations/${samsungNew}`);
    const head = (await screen.findByText("삼성전자", { selector: "p" })).closest("section")!;
    expect(await within(head).findByText(/^손익비 [\d.]+가 기준\(1\.5\)보다 낮습니다\.$/)).toBeTruthy();
    expect(within(await screen.findByRole("list", { name: "활성화할 수 없는 사유" })).getAllByRole("listitem").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "계획 활성화" })).toBeNull();
    expect(screen.getByRole("link", { name: /다른 추천 보기/ }).getAttribute("href")).toBe("/recommendations");
  });

  it("시작할 수 있으면 이유 줄이 없고 넣을 돈·체크리스트·시작 버튼이 그대로 (체크리스트는 넣을 돈을 정한 뒤)", async () => {
    renderApp("/recommendations/91", "bob");
    const box = await screen.findByRole("region", { name: "이 금액으로 사는 수량" });
    expect(within(box).getByText("금액을 정하면 몇 주를 사는지 보여 드려요.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "넣을 돈 정하는 방식" })).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    await within(box).findByText(/^이 금액으로/, undefined, { timeout: 3000 });
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "모의 자동매매 시작" })).toBeTruthy();
    expect(screen.queryByText(/안전장치가 막았어요/)).toBeNull();
  });
});

describe("UX-3 바로 사는 경우", () => {
  it("정규장 중 지금 가격이 사는 가격 이하면 '시작하면 바로 사요'(숫자 없이), 아니면 기다리는 문장", async () => {
    db.setPrice("000660", 180_000); // 사는 가격 181,000원 아래
    const first = renderApp("/recommendations/91", "bob");
    expect(await screen.findByText("지금 가격이 사는 가격보다 낮아서, 시작하면 모의 계좌에서 바로 사요.")).toBeTruthy();
    expect(screen.queryByText(/이하가 될 때까지/)).toBeNull();
    first.unmount();

    renderApp("/recommendations/91"); // 전문가 보기
    expect(await screen.findByText("현재가가 진입가 이하라 활성화하면 바로 모의 체결됩니다.")).toBeTruthy();
  });

  it("장이 닫혀 있으면 지금 가격이 낮아도 기다리는 문장 (다음 장에 지정가로 산다)", async () => {
    freezeTime("2026-10-06T18:00:00+09:00", { marketOpen: {} });
    db.setPrice("000660", 180_000);
    renderApp("/recommendations/91", "bob");
    expect(await screen.findByText(/^181,000원 이하가 될 때까지 .+까지만 기다려요/)).toBeTruthy();
    expect(screen.queryByText(/시작하면 모의 계좌에서 바로 사요/)).toBeNull();
  });

  it.each([
    ["bob", "모의 자동매매 시작", /^SK하이닉스 모의 자동매매를 시작했어요\. 모의 계좌에서 \d+주를 180,000원에 샀어요\.$/],
    ["alice", "계획 활성화", /^SK하이닉스 계획을 활성화했습니다\. \d+주 180,000원에 바로 체결됐습니다\.$/],
  ])("시작하자마자 샀으면(응답 status holding) 토스트는 '샀어요' · %s", async (user, button, line) => {
    server.use(
      http.post("*/api/recommendations/91/activate", async ({ request }) => {
        const u = db.sessionUser()!;
        const plan = db.activate(u, 91, (await request.json()) as Record<string, unknown>);
        db.setPrice("000660", 180_000); // 서버는 같은 요청 안에서 체결까지 간다
        return HttpResponse.json(db.getPlan(u.id, plan.id), { status: 201 });
      }),
    );
    renderApp("/recommendations/91", user);
    const box = await screen.findByRole("region", { name: user === "bob" ? "이 금액으로 사는 수량" : "리스크 미리 보기" });
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    await waitFor(() => expect(screen.getAllByRole("checkbox").length).toBeGreaterThan(0), { timeout: 3000 });
    await waitFor(() => expect(box.getAttribute("aria-busy")).toBe("false"));
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: button }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(toast().textContent).toMatch(line));
  });

  it("체결을 기다리면(entry_pending) 토스트는 지금 문장", async () => {
    renderApp("/recommendations/91", "bob");
    const box = await screen.findByRole("region", { name: "이 금액으로 사는 수량" });
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    await within(box).findByText(/^이 금액으로/, undefined, { timeout: 3000 });
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    await waitFor(() => expect(toast().textContent).toBe("SK하이닉스 모의 자동매매를 시작했어요. 사는 주문을 넣었어요."));
  });

  it.each([
    ["bob", "산 가격"],
    ["alice", "체결가"],
  ])("산 뒤 가격 사다리의 기준점은 산 가격, 손절·목표 %도 산 가격 기준 (사기 전에는 사는 가격) · %s", async (user, label) => {
    const plan = db.activate(userOf(user), 91, { budgetPercent: 10 });
    const pending = renderApp(`/plans/${plan.id}`, user);
    const before = await screen.findByRole("figure", { name: "가격 사다리" });
    expect(within(before).getByText(user === "bob" ? "사는 가격" : "진입")).toBeTruthy();
    expect(within(before).getByText(formatRate(173_000 / 181_000 - 1, 1))).toBeTruthy();
    pending.unmount();

    db.setPrice("000660", 180_000); // 다음 조회에서 체결
    const filled = db.getPlan(db.sessionUser()!.id, plan.id);
    expect(filled.status).toBe("holding");
    const fill = filled.fillPrice!;
    renderApp(`/plans/${plan.id}`, user);
    const ladder = await screen.findByRole("figure", { name: "가격 사다리" });
    expect(within(ladder).getByText(label)).toBeTruthy();
    expect(within(ladder).getByText(formatRate(173_000 / fill - 1, 1))).toBeTruthy();
    expect(within(ladder).getByText(formatRate(203_000 / fill - 1, 1))).toBeTruthy();
    expect(within(ladder).queryByText(formatRate(173_000 / 181_000 - 1, 1))).toBeNull();
    if (user === "alice") expect(screen.getByText("손절가 (체결가 기준)")).toBeTruthy();
  });
});

describe("UX-10 · UX-11 계획 화면의 평가·기한", () => {
  it("보유 중 평가는 '(수수료·세금 빼기 전)'과 팔 때 받는 돈이 조금 적다는 한 줄. 산 뒤에는 기다리는 기한을 숨기고 보유 기한은 날짜 + 거래일", async () => {
    const plan = db.activate(userOf("bob"), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000);
    renderApp(`/plans/${plan.id}`, "bob");
    const numbers = (await screen.findByRole("heading", { name: "숫자로 보기" })).closest("section")!;
    expect(await within(numbers).findByText("지금 가격으로 본 평가 (수수료·세금 빼기 전)")).toBeTruthy();
    expect(within(numbers).getByText("팔 때 수수료와 세금이 빠져서 받는 돈은 조금 적어요.")).toBeTruthy();
    expect(within(numbers).queryByText(/비용 전/)).toBeNull();
    expect(within(numbers).queryByText("사는 가격을 기다리는 기한")).toBeNull();
    expect(within(numbers).getByText("보유 기한")).toBeTruthy();
    expect(await within(numbers).findByText(/^\d+월 \d+일\(.\)까지 \(최대 10거래일\)$/)).toBeTruthy();
  });

  it("사기 전: 기한이 토요일이면 앞 금요일 장 마감으로 (실행 확인·머리·계획 화면 모두), 보유 기간은 '산 뒤 최대 n거래일'", async () => {
    freezeTime("2026-10-06T10:00:00+09:00"); // 화요일 장중
    const id = db.addRecommendation({
      symbol: "000660",
      entryPrice: 181_000,
      targetPrice: 203_000,
      stopPrice: 173_000,
      validUntil: "2026-10-10T19:37:00+09:00", // 토요일
    });
    const page = renderApp(`/recommendations/${id}`, "bob");
    expect(await screen.findByText(/^181,000원 이하가 될 때까지 10월 9일\(금\) 장 마감까지만 기다려요/)).toBeTruthy();
    expect(screen.getByText(/· 10월 9일\(금\) 장 마감까지$/)).toBeTruthy();
    expect(screen.queryByText(/10월 10일\(토\)/)).toBeNull();
    page.unmount();

    const plan = db.activate(userOf("bob"), id, { budgetPercent: 10 });
    renderApp(`/plans/${plan.id}`, "bob");
    const numbers = (await screen.findByRole("heading", { name: "숫자로 보기" })).closest("section")!;
    expect(within(numbers).getByText("10월 9일(금) 장 마감까지")).toBeTruthy();
    expect(within(numbers).getByText("산 뒤 최대 10거래일")).toBeTruthy();
  });

  it("계획 제안의 쉬운 보기 요약도 '(수수료·세금 빼기 전)'. 전문가 지표는 그대로 '비용 전'", async () => {
    const easy = renderApp("/recommendations/91", "bob");
    const summary = (await screen.findByRole("heading", { name: "계획 요약" })).closest("section")!;
    expect(within(summary).getByText("(수수료·세금 빼기 전)")).toBeTruthy();
    expect(within(summary).queryByText("(비용 전)")).toBeNull();
    easy.unmount();
    renderApp("/recommendations/91");
    const metrics = (await screen.findByRole("heading", { name: "지표" })).closest("section")!;
    expect(within(metrics).getAllByText("비용 전").length).toBeGreaterThan(0);
  });

  it("멈추기로 판 계획의 쉬운 결과는 '멈추기로 모의 계좌에서 팔았어요'", async () => {
    const plan = db.activate(userOf("bob"), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000);
    renderApp(`/plans/${plan.id}`, "bob");
    await screen.findByText("목표·손절을 지켜보는 중", { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: "멈추기" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "모두 팔고 멈추기" }));
    await waitFor(() => expect(screen.getByRole("note").textContent).toContain("멈추기로 모의 계좌에서 팔았어요"));
    expect(within(screen.getByRole("list", { name: "계획 사건" })).getByText(/^멈추기로 모의 계좌에서 [\d,]+원에 팔았어요/)).toBeTruthy();
  });
});

describe("UX-14 알림 설정", () => {
  it.each(["alice", "bob"])("Webhook이 없으면 Discord 묶음을 접고 '지금은 웹 알림으로만 와요' · %s", async (user) => {
    renderApp("/my", user);
    expect(await screen.findByText("지금은 웹 알림으로만 와요.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Discord로도 받기/ })).toBeNull();
    expect(screen.queryByText("ID 찾는 법")).toBeNull();
    expect(screen.queryByRole("button", { name: "테스트 알림 보내기" })).toBeNull();
  });

  it("Webhook이 있으면 접지 않고 그대로", async () => {
    db.options.webhookConfigured = true;
    renderApp("/my", "bob");
    expect(await screen.findByRole("switch", { name: /Discord로도 받기/ })).toBeTruthy();
    expect(screen.queryByText("지금은 웹 알림으로만 와요.")).toBeNull();
    expect(screen.getByRole("button", { name: "테스트 알림 보내기" })).toBeTruthy();
  });
});

/** 화면 없이 쓰는 추천 하나 (기본: 시작할 수 있는 리포트 제안). */
function rec(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: 1,
    source: "report",
    sourceId: 1,
    requestedBy: null,
    symbol: "000660",
    name: "SK하이닉스",
    market: "KR",
    currency: "KRW",
    priceAtCreation: 182_300,
    entryPrice: 181_000,
    targetPrice: 203_000,
    stopPrice: 173_000,
    holdingDays: 10,
    targetReturn: 203_000 / 181_000 - 1,
    stopLossRate: 173_000 / 181_000 - 1,
    rewardRisk: 2.5,
    probability: 0.55,
    probabilityAssumed: false,
    expectedReturn: 0.02,
    confidence: 70,
    summary: "요약",
    reasons: [],
    risks: [],
    riskLevel: null,
    status: "open",
    expiredReason: null,
    validUntil: "2026-10-09T15:30:00+09:00",
    createdAt: "2026-10-06T09:00:00+09:00",
    myPlan: null,
    planCount: 0,
    blockedBy: [],
    canDelete: false,
    ...over,
  };
}

describe("UX-16 PC 2열 카드의 7자리 가격", () => {
  const big = rec({ name: "삼성전기", symbol: "009150", entryPrice: 1_603_000, targetPrice: 1_703_000, stopPrice: 1_305_000 });
  const draw = (r: Recommendation, easy: boolean) =>
    render(
      <MemoryRouter>
        <RecommendationCard r={r} easy={easy} />
      </MemoryRouter>,
    );

  it.each([true, false])("7자리 원화는 좁은 칸에서 글자를 한 단계 줄이고 '원' 앞에서만 줄을 바꿀 수 있다 · 쉬운 보기 %s", (easy) => {
    draw(big, easy);
    const price = screen.getByText("1,603,000원", { selector: "dd" });
    expect(price.className).toContain("text-[12px]");
    expect(price.className).toContain("@min-[18rem]:text-[14px]");
    expect(price.className).not.toContain("whitespace-nowrap"); // 옆 칸으로 넘쳐 붙지 않게
    expect(price.querySelector("wbr")).not.toBeNull();
    expect(price.closest("dl")!.className).toContain("@container");
    expect(price.parentElement!.className).toContain("min-w-0");
  });

  it("6자리 이하는 그대로 14px", () => {
    draw(rec(), true);
    expect(screen.getByText("181,000원", { selector: "dd" }).className).toContain("text-[14px]");
    expect(screen.getByText("181,000원", { selector: "dd" }).className).not.toContain("text-[12px]");
  });
});

describe("표시 규칙 (화면 없이)", () => {
  const blocked = (over: Partial<Recommendation>) => rec({ blockedBy: ["reward_risk_low", "ev_negative"], ...over });

  it("startableFirst · splitProposals: 시작할 수 있는 것이 먼저 (기한 지남도 시작할 수 없음, blockedBy가 없으면 []로 본다)", () => {
    const list = [blocked({ id: 1 }), rec({ id: 2, blockedBy: undefined }), rec({ id: 3, status: "expired", blockedBy: undefined }), rec({ id: 4 })];
    expect(startableFirst(list).map((r) => r.id)).toEqual([2, 4, 1, 3]);
    const split = splitProposals([blocked({ id: 1 }), rec({ id: 2, source: "demo" }), rec({ id: 3 })], true);
    expect(split.main.map((r) => r.id)).toEqual([3, 1]);
    expect(split.others.map((r) => r.id)).toEqual([2]);
  });

  it("arrangeProposals: 같은 종목은 하나로(시작할 수 있는 것 중 최신, 없으면 최신), 무리는 ready · others · blocked", () => {
    const list = [
      blocked({ id: 10, symbol: "005930", createdAt: "2026-10-08T09:00:00+09:00" }),
      blocked({ id: 11, symbol: "005930", createdAt: "2026-10-08T08:00:00+09:00" }),
      blocked({ id: 12, symbol: "000660", createdAt: "2026-10-08T07:00:00+09:00" }), // 더 최신이지만 시작할 수 없다
      rec({ id: 13, symbol: "000660", createdAt: "2026-10-07T07:00:00+09:00" }),
      rec({ id: 14, symbol: "035420", source: "analysis", createdAt: "2026-10-06T07:00:00+09:00" }),
    ];
    const easy = arrangeProposals(list, true);
    expect(easy.ready.map((g) => [g.rec.id, g.rest.map((x) => x.id), g.restOlder])).toEqual([[13, [12], false]]);
    expect(easy.others.map((g) => g.rec.id)).toEqual([14]);
    expect(easy.blocked.map((g) => [g.rec.id, g.rest.map((x) => x.id), g.restOlder])).toEqual([[10, [11], true]]);
    const expert = arrangeProposals(list, false);
    expect(expert.ready.map((g) => g.rec.id)).toEqual([13, 14]);
    expect(expert.others).toEqual([]);
  });

  it("entryDeadlineLabel · deadlineMovedEarlier: 주말·장 시작 전이면 앞 거래일 장 마감, 장 마감 뒤면 그 날, 장중이면 그 시각", () => {
    expect(entryDeadlineLabel("2026-10-10T19:37:00+09:00")).toBe("10월 9일(금) 장 마감");
    expect(entryDeadlineLabel("2026-10-11T09:00:00+09:00")).toBe("10월 9일(금) 장 마감");
    expect(entryDeadlineLabel("2026-10-08T19:37:00+09:00")).toBe("10월 8일(목) 장 마감");
    expect(entryDeadlineLabel("2026-10-09T08:05:00+09:00")).toBe("10월 8일(목) 장 마감"); // 자동 리포트 추천: 장 시작 전 기한 (리뷰 R-5)
    expect(entryDeadlineLabel("2026-10-12T08:05:00+09:00")).toBe("10월 9일(금) 장 마감"); // 월요일 장 시작 전 → 금요일
    expect(entryDeadlineLabel("2026-10-08T10:23:00+09:00")).toBe("10월 8일(목) 오전 10시 23분"); // 장중
    expect(entryDeadlineLabel("2026-10-10T19:37:00+09:00", "US")).toBe("10월 9일(금) 장 마감(뉴욕)"); // 뉴욕 토요일 아침
    expect(entryDeadlineLabel("2026-10-10T08:05:00+09:00", "US")).toBe("10월 9일(금) 장 마감(뉴욕)"); // 뉴욕 금요일 저녁 (리뷰 R-5 b)
    expect(deadlineMovedEarlier("2026-10-10T19:37:00+09:00")).toBe(true);
    expect(deadlineMovedEarlier("2026-10-09T08:05:00+09:00")).toBe(true);
    expect(deadlineMovedEarlier("2026-10-09T19:37:00+09:00")).toBe(false);
    expect(entryDeadlineLabel(null)).toBe("-");
  });

  it("buysRightAway: 정규장 중 + 실시간 시세 + 사는 가격 이하일 때만", () => {
    expect(buysRightAway({ isOpen: true }, { price: 180_000, basis: "live" }, 181_000)).toBe(true);
    expect(buysRightAway({ isOpen: true }, { price: 181_000, basis: "live" }, 181_000)).toBe(true);
    expect(buysRightAway({ isOpen: true }, { price: 182_000, basis: "live" }, 181_000)).toBe(false);
    expect(buysRightAway({ isOpen: false }, { price: 180_000, basis: "live" }, 181_000)).toBe(false);
    expect(buysRightAway({ isOpen: true }, { price: 180_000, basis: "close" }, 181_000)).toBe(false);
    expect(buysRightAway(undefined, { price: 180_000, basis: "live" }, 181_000)).toBe(false);
  });

  it("문구: 계획 멈춤 청산은 '멈추기로', 체결 내역의 직접 매도는 그대로, 투자 성향 진단 안내, 시작할 수 없는 이유 한 마디", () => {
    expect(planEventSentence({ kind: "closed", details: { exitReason: "MANUAL", exitPrice: 76_700, pnlKrw: -917 }, message: "" })).toBe(
      "멈추기로 모의 계좌에서 76,700원에 팔았어요 (손익 -917원)",
    );
    expect(planExitText("MANUAL")).toBe("멈추기로 모의 계좌에서 팔았어요");
    expect(planExitText("MANUAL", false)).toBe("사용자 매도");
    expect(planExitText("TARGET")).toBe(exitReasonText("TARGET"));
    expect(exitReasonText("MANUAL")).toBe("직접 모의 계좌에서 팔았어요");
    expect(NOT_SUITABILITY).toBe("증권사의 공식 투자 성향 검사가 아니에요");
    expect(blockedShort(["reward_risk_low"])).toBe("버는 돈에 비해 잃을 수 있는 돈이 커요");
    expect(blockedShort(["ev_negative"], false)).toBe("기대수익률 0 이하");
    expect(blockedShort(["expired"])).toBe("기한이 끝났어요");
    expect(blockedShort([])).toBe("");
  });
});
