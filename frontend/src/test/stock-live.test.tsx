// 종목 화면 보유 평가는 실시간 시세 · 계획 화면 "넣은 돈" (docs/API.md "실시간 시세"의 "종목 화면의 내 보유", docs/DECISIONS.md 28장).
// - 종목 상세의 보유 블록('내 모의 주문' 주문 패널)과 시세 카드 아래 '모의 보유' 한 줄: 시세(Quote.price)와 체결가·수량으로 종목 통화로 계산한다 (lib/holding).
//   시세가 바뀌면 숫자도 바뀌고, 시세 가격이 없으면 장마감 기준 계좌 값(Position)으로 돌아간다. 홈·마이·랭킹은 그대로 장마감 기준.
// - 모의 자동매매 상세의 숫자 카드: TradePlan.budgetMode가 percent·amount면 "넣은 돈", null(2026-10-11 전 계획)이면 그 줄이 없다.
// 앨리스: 삼성전자 10주(체결가 69,500원, 직전 종가 71,200원 — 가짜 API의 시세는 처음에 종가와 같다, 테스트가 setPrice로 72,000원으로 올린다),
// NVDA 8주(체결가 $117.20, 시세 $121.37). 시세는 흔들리지 않는다(TEST_DB jitter 끔).
// 계좌 평가(Position)는 종가 기준이라 시세를 바꿔도 그대로다 — 종목 화면 숫자와 달라지는 것이 이 테스트가 보는 것.
import { screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Quote } from "../api/types";
import { formatKrw, formatRate, formatSignedKrw } from "../lib/format";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";

/** 시세를 받지 못한 종목 상세 (가격 없음 — 증권사 조회 실패). */
function noPriceStock(symbol: string) {
  const d = db.stockDetail(symbol);
  const quote: Quote = { ...d.quote, price: null, prevClose: null, change: null, changeRate: null, asOf: null, basis: "close" };
  server.use(http.get("*/api/stocks/:symbol", () => HttpResponse.json({ ...d, quote })));
}

const panelOf = async () => screen.findByRole("region", { name: "주문" });
const summaryOf = async (name: RegExp) => within(await screen.findByRole("region", { name: "시세" })).findByRole("button", { name });

describe("종목 화면 보유 평가: 시세로 계산한다", () => {
  it("전문가 보기: 평가 금액·손익·수익률은 시세 × 수량, '현재가' 줄과 실시간 기준 시각, 한 줄 요약도 같은 숫자", async () => {
    db.setPrice("005930", 72_000);
    renderApp("/stocks/005930");
    const panel = await panelOf();
    expect(await within(panel).findByText("720,000원")).toBeTruthy(); // 72,000원 × 10주 (장마감 기준 계좌 값은 종가 71,200원 × 10주 = 712,000원)
    expect(within(panel).getByText("+25,000원 (+3.60%)")).toBeTruthy(); // 체결가 69,500원 대비
    expect(within(panel).getByText("수수료·세금 빼기 전")).toBeTruthy();
    expect(within(panel).getByText("현재가")).toBeTruthy();
    expect(within(panel).getByText("72,000원")).toBeTruthy();
    expect(within(panel).queryByText("종가")).toBeNull();
    expect(within(panel).getByText(/^실시간 · \d{2}:\d{2}:\d{2}$/)).toBeTruthy();
    expect(within(panel).queryByText("712,000원")).toBeNull();
    expect(within(panel).getByText(/여기 평가는 실시간이에요 \(자산·랭킹은 직전 장마감 기준\)\.$/)).toBeTruthy();
    // 산 금액(매수 원금)은 체결가로 정해진 계좌 값 그대로
    expect(within(panel).getByText("매수 원금").nextElementSibling?.textContent).toBe("695,000원");

    const line = await summaryOf(/모의 보유 10주/);
    expect(line.textContent).toBe("모의 보유 10주 · 720,000원 +3.60%");
  });

  it("쉬운 보기: '지금 가격' 줄과 '여기 평가는 지금 가격이에요 (내 자산·랭킹은 장 마감 가격)'", async () => {
    db.setPrice("005930", 72_000);
    renderApp("/stocks/005930?view=easy");
    const panel = await panelOf();
    expect(await within(panel).findByText("720,000원")).toBeTruthy();
    expect(within(panel).getByText("지금 가격")).toBeTruthy();
    expect(within(panel).getByText("산 가격")).toBeTruthy();
    expect(
      within(panel).getByText("같은 종목은 한 번에 하나만 가질 수 있고, 팔 때는 가진 수량을 모두 팔아요. 여기 평가는 지금 가격이에요 (내 자산·랭킹은 장 마감 가격)."),
    ).toBeTruthy();
    expect(within(panel).queryByText(/가격·손익은 달러예요/)).toBeNull(); // 국내 종목은 말하지 않는다
  });

  it("시세가 바뀌면 보유 평가와 한 줄 요약도 바뀐다", async () => {
    db.setPrice("005930", 72_000);
    const { client } = renderApp("/stocks/005930");
    const panel = await panelOf();
    expect(await within(panel).findByText("720,000원")).toBeTruthy();
    expect((await summaryOf(/모의 보유 10주/)).textContent).toBe("모의 보유 10주 · 720,000원 +3.60%");

    db.setPrice("005930", 75_000);
    await client.invalidateQueries({ queryKey: ["stock", "005930"] });
    expect(await within(panel).findByText("750,000원")).toBeTruthy();
    expect(within(panel).getByText("+55,000원 (+7.91%)")).toBeTruthy();
    expect(within(panel).getByText("75,000원")).toBeTruthy(); // 현재가 줄
    await waitFor(async () => expect((await summaryOf(/모의 보유 10주/)).textContent).toBe("모의 보유 10주 · 750,000원 +7.91%"));

    // 체결가보다 낮아지면 음수
    db.setPrice("005930", 66_000);
    await client.invalidateQueries({ queryKey: ["stock", "005930"] });
    expect(await within(panel).findByText("660,000원")).toBeTruthy();
    expect(within(panel).getByText("-35,000원 (-5.04%)")).toBeTruthy();
  });

  it("시세 가격이 없으면 장마감 기준 계좌 값(Position)으로 돌아간다 — 종가 줄·장마감 기준 시각·예전 문장", async () => {
    noPriceStock("005930");
    renderApp("/stocks/005930");
    db.setSession("alice");
    const pos = db.account(db.sessionUser()!.id).positions.find((p) => p.symbol === "005930")!;
    const panel = await panelOf();
    expect(await within(panel).findByText(formatKrw(pos.valueKrw))).toBeTruthy();
    expect(within(panel).getByText(`${formatSignedKrw(pos.profitKrw)} (${formatRate(pos.profitRate)})`)).toBeTruthy();
    expect(within(panel).getByText("종가")).toBeTruthy();
    expect(within(panel).getByText(formatKrw(pos.lastPrice))).toBeTruthy();
    expect(within(panel).getByText(/장마감 기준$/)).toBeTruthy();
    expect(within(panel).queryByText("현재가")).toBeNull();
    expect(within(panel).getByText(/평가는 직전 장마감 종가 기준이에요 \(당일 매수는 장 마감 뒤에\)\.$/)).toBeTruthy();
    const line = await summaryOf(/모의 보유 10주/);
    expect(line.textContent).toBe(`모의 보유 10주 · ${formatKrw(pos.valueKrw)} ${formatRate(pos.profitRate)}`);
  });

  it("미국 종목은 달러로 평가하고 달러임을 밝힌다 (산 금액·매수 원금만 원화)", async () => {
    renderApp("/stocks/NVDA");
    const panel = await panelOf();
    expect(await within(panel).findByText("$970.96")).toBeTruthy(); // $121.37 × 8주
    expect(within(panel).getByText("+$33.36 (+3.56%)")).toBeTruthy(); // 체결가 $117.20 대비
    expect(within(panel).getByText("$121.37")).toBeTruthy(); // 현재가 줄
    expect(within(panel).getByText("평가·손익은 달러 기준이에요 (매수 원금은 원화).")).toBeTruthy();
    expect((await summaryOf(/모의 보유 8주/)).textContent).toBe("모의 보유 8주 · $970.96 +3.56%");
  });

  it("미국 종목 쉬운 보기: '가격·손익은 달러예요'", async () => {
    renderApp("/stocks/NVDA?view=easy");
    const panel = await panelOf();
    expect(await within(panel).findByText("$970.96")).toBeTruthy();
    expect(within(panel).getByText("가격·손익은 달러예요 (산 금액만 원화예요).")).toBeTruthy();
  });

  it("홈의 보유는 그대로 장마감 기준이다 (같은 보유가 종목 화면과 다를 수 있다)", async () => {
    db.setPrice("005930", 72_000); // 시세만 오른다 — 계좌 평가의 종가는 그대로
    renderApp("/portfolio");
    const pos = db.account(db.sessionUser()!.id).positions.find((p) => p.symbol === "005930")!;
    expect(pos.valueKrw).toBe(712_000); // 직전 종가 71,200원 × 10주 — 종목 화면은 720,000원
    expect((await screen.findAllByText(formatKrw(pos.valueKrw))).length).toBeGreaterThan(0);
    expect(screen.queryByText("720,000원")).toBeNull();
  });
});

describe("계획 화면: 넣은 돈", () => {
  /** 앨리스의 끝난 계획 #95를 넣은 돈만 바꿔 돌려준다. */
  function withBudget(patch: { budgetMode: "percent" | "amount" | null; budgetPercent: number | null; budgetKrw: number | null }) {
    db.setSession("alice");
    const plan = db.getPlan(db.sessionUser()!.id, 95);
    server.use(http.get("*/api/trade-plans/95", () => HttpResponse.json({ ...plan, ...patch })));
  }
  const valueOf = (label: string) => screen.getByText(label).nextElementSibling?.textContent;

  it("내 자금의 %로 정했으면 쉬운 보기 '내 자금의 25% (1,234,000원)', 전문가 보기 '매수 가능 금액의 25% · 1,234,000원'", async () => {
    withBudget({ budgetMode: "percent", budgetPercent: 25, budgetKrw: 1_234_000 });
    const easy = renderApp("/plans/95?view=easy");
    await screen.findByRole("heading", { name: "숫자로 보기" });
    expect(valueOf("넣은 돈")).toBe("내 자금의 25% (1,234,000원)");
    easy.unmount();

    renderApp("/plans/95");
    await screen.findByRole("heading", { name: "핵심 숫자" });
    expect(valueOf("넣은 돈")).toBe("매수 가능 금액의 25% · 1,234,000원");
    expect(screen.queryByText("예산")).toBeNull(); // 예전 줄과 겹치지 않는다
  });

  it("금액으로 정했으면 금액만", async () => {
    withBudget({ budgetMode: "amount", budgetPercent: null, budgetKrw: 1_500_000 });
    const easy = renderApp("/plans/95?view=easy");
    await screen.findByRole("heading", { name: "숫자로 보기" });
    expect(valueOf("넣은 돈")).toBe("1,500,000원");
    easy.unmount();

    renderApp("/plans/95");
    await screen.findByRole("heading", { name: "핵심 숫자" });
    expect(valueOf("넣은 돈")).toBe("1,500,000원");
  });

  it("2026-10-11 전 계획(budgetMode null)은 '넣은 돈'을 보이지 않는다 — 예전 선택 예산은 '예산' 줄 그대로", async () => {
    withBudget({ budgetMode: null, budgetPercent: null, budgetKrw: 800_000 });
    const easy = renderApp("/plans/95?view=easy");
    await screen.findByRole("heading", { name: "숫자로 보기" });
    expect(screen.queryByText("넣은 돈")).toBeNull();
    expect(valueOf("예산")).toBe("800,000원");
    easy.unmount();

    withBudget({ budgetMode: null, budgetPercent: null, budgetKrw: null });
    renderApp("/plans/95");
    await screen.findByRole("heading", { name: "핵심 숫자" });
    expect(screen.queryByText("넣은 돈")).toBeNull();
    expect(screen.queryByText("예산")).toBeNull();
  });
});
