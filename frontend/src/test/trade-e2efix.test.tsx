// 운영 E2E 점검 뒤 고친 것 — 직접 주문·보유 평가 (docs/records/운영E2E점검_UX리뷰_2026-10-08.md UX-1·UX-4·UX-6·UX-10).
// - UX-6: 쉬운 보기의 매수·매도·취소 토스트는 서버 원문이 아니라 정해진 쉬운 문장 ("모의"를 꼭 넣는다). 전문가 보기는 원문.
// - UX-4: 쉬운 보기 보유 패널은 '모두 팔기'·"같은 종목은 한 번에 하나만…".
// - UX-10: 보유 손익 옆 "수수료·세금 빼기 전"과 "팔 때 수수료와 세금이 빠져서 받는 돈은 조금 적어요".
// - UX-1: 오늘 산 보유(Position.priceBasis "today_fill")는 종가·손익 대신 "오늘 산 종목 · 장 마감(15:40) 뒤에 평가돼요".
//   가짜 API는 today_fill을 내지 않으므로 계좌 응답을 바꿔 끼운다.
//   2026-10-11부터 종목 화면은 시세로 평가해 오늘 산 종목도 실시간 숫자다 — 그 문구는 시세 가격이 직전 종가일 때(현재가를 받지 못함)만 남는다 (stock-live.test.tsx).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Providers } from "../App";
import type { AccountSummary, Order, OrderResult, Reservation } from "../api/types";
import { AssetCard } from "../components/AssetCard";
import { createQueryClient } from "../lib/queryClient";
import { CANCEL_TEXT, buyResultText, isTodayFill, sellResultText, todayFillNote, todayFillText } from "../lib/orderText";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";

const toast = () => screen.getByRole("status");

/** 우리 문장에 쓰지 않는 권유 표현 (docs/API.md "금지 표현" PERSUASION). 공백을 지우고 비교한다. */
const PERSUASION = ["사세요", "사볼만", "매수하세요", "매수기회", "지금사면", "담으세요", "좋아요", "파세요", "팔아야", "매도하세요", "매도기회", "지금팔면", "정리하세요", "손절하세요"];
const persuasionIn = (text: string) => PERSUASION.filter((p) => text.replace(/\s+/g, "").includes(p));

const order = (patch: Partial<Order>): Order =>
  ({ id: 3, symbol: "035720", name: "카카오", market: "KR", currency: "KRW", orderType: "MARKET", quantity: 1, entryPrice: 32_450, ...patch }) as Order;
const result = (patch: Partial<OrderResult>): OrderResult => ({ order: null, reservation: null, message: "[모의 체결 #3] 카카오 (035720) 원문", ...patch });
const reservation = (patch: Partial<Reservation>): Reservation => ({ id: 7, kind: "BUY", quantity: 1, runAt: null, ...patch }) as Reservation;

/** 앨리스 계좌에서 symbol 보유를 오늘 산 종목(체결가로 평가, 손익 0)으로 바꿔 돌려주는 계좌 응답. */
function boughtToday(symbol: string) {
  db.setSession("alice");
  const id = db.sessionUser()!.id;
  server.use(
    http.get("*/api/account", () => {
      const acc: AccountSummary = db.account(id);
      const positions = acc.positions.map((p) =>
        p.symbol === symbol ? { ...p, priceBasis: "today_fill" as const, valueKrw: p.costKrw, profitKrw: 0, profitRate: 0 } : p,
      );
      return HttpResponse.json({ ...acc, positions });
    }),
  );
}

describe("직접 주문 결과 문장 (lib/orderText)", () => {
  it("매수: 체결·예약·체결 대기를 구분하고 '모의 계좌'를 밝힌다", () => {
    const filled = result({ order: order({ status: "EXIT_WATCHING", fillPrice: 32_450 }) });
    expect(buyResultText(filled, "카카오", "KR")).toBe("모의 계좌에서 카카오 1주를 32,450원에 샀어요");
    expect(buyResultText(result({ reservation: reservation({}) }), "카카오", "KR")).toBe("다음 정규장이 열리면 모의 계좌에서 카카오 1주를 사도록 예약했어요");
    expect(buyResultText(result({ reservation: reservation({ runAt: "2026-10-09T09:00:00+09:00" }) }), "카카오", "KR")).toBe(
      "모의 계좌에서 10월 9일(금) 오전 9시에 카카오 1주를 사도록 예약했어요",
    );
    const pending = result({ order: order({ status: "ENTRY_PENDING", orderType: "LIMIT", limitPrice: 32_000 }) });
    expect(buyResultText(pending, "카카오", "KR")).toBe("카카오 1주를 32,000원 이하가 되면 사요 (모의 계좌 체결 대기)");
  });

  it("팔기: 판 가격과 실현 손익(수수료·세금 포함), 장 밖이면 예약", () => {
    const sold = result({ order: order({ status: "CLOSED", fillPrice: 32_450, exitPrice: 32_450, pnlKrw: -75 }) });
    expect(sellResultText(sold, "카카오", "KR")).toBe("모의 계좌에서 카카오 1주를 32,450원에 팔았어요 · 손익 -75원 (수수료·세금 포함)");
    const reserved = result({ order: order({ status: "EXIT_WATCHING" }), reservation: reservation({ kind: "SELL" }) });
    expect(sellResultText(reserved, "카카오", "KR")).toBe("다음 정규장이 열리면 모의 계좌에서 카카오 1주를 모두 팔도록 예약했어요");
  });

  it("쉬운 문장은 모두 '모의'가 있고 권유 표현이 없다", () => {
    const easy = [
      buyResultText(result({ order: order({ status: "EXIT_WATCHING", fillPrice: 32_450 }) }), "카카오", "KR"),
      buyResultText(result({ reservation: reservation({}) }), "카카오", "KR"),
      sellResultText(result({ order: order({ status: "CLOSED", exitPrice: 32_450, pnlKrw: 1_200 }) }), "카카오", "KR"),
      sellResultText(result({ order: order({ status: "CANCELED" }) }), "카카오", "KR"),
      ...Object.values(CANCEL_TEXT).map((t) => t.easy),
    ];
    for (const text of easy) {
      expect(text).toContain("모의");
      expect(persuasionIn(text)).toEqual([]);
    }
  });

  it("오늘 산 종목 표기: 시장별 평가 시각, 쉬운·전문가 보기", () => {
    expect(todayFillText("KR", true)).toBe("오늘 산 종목 · 장 마감(15:40) 뒤에 평가돼요");
    expect(todayFillText("KR", false)).toBe("당일 매수 · 15:40 이후 종가 평가");
    expect(todayFillText("US", true)).toBe("오늘 산 종목 · 장 마감(뉴욕 16:10) 뒤에 평가돼요");
    expect(isTodayFill({ priceBasis: "today_fill" })).toBe(true);
    expect(isTodayFill({})).toBe(false); // 필드가 없으면 close
    const positions = [
      { market: "KR" as const, priceBasis: "close" as const },
      { market: "US" as const, priceBasis: "today_fill" as const },
    ];
    expect(todayFillNote(positions, true)).toBe("오늘 산 종목은 산 가격으로 셈하고, 장 마감(뉴욕 16:10) 뒤에 평가돼요");
    expect(todayFillNote(positions.slice(0, 1), true)).toBeNull();
  });
});

describe("직접 주문 토스트와 보유 패널 (쉬운 보기)", () => {
  it("쉬운 보기 매수 토스트는 정해진 문장, '왜 샀나요?'는 '실적 보고서(정기공시)'로 푼다", async () => {
    renderApp("/stocks/005380", "bob");
    fireEvent.click(await screen.findByRole("button", { name: /직접 주문\(고급\)/ }));
    fireEvent.change(await screen.findByLabelText("수량"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "매수하기" }));
    fireEvent.click(within(screen.getByRole("group", { name: "모의 계좌로 현대차 1주를 살까요?" })).getByRole("button", { name: "모의 매수 확정" }));
    await waitFor(() => expect(toast().textContent).toMatch(/^모의 계좌에서 현대차 1주를 [\d,]+원에 샀어요$/));
    expect(toast().textContent).not.toContain("[모의 체결");
    const dialog = await screen.findByRole("dialog", { name: "왜 샀나요?" });
    expect(dialog.textContent).toContain("실적 보고서(정기공시)가 나올 때");
    expect(within(dialog).getByRole("group", { name: "먼저 볼 것 (선택)" })).toBeTruthy();
  });

  it("쉬운 보기 보유: '모두 팔기' → '○주를 모두 팔까요?' → '팔기', 토스트는 판 가격과 손익(수수료·세금 포함)", async () => {
    renderApp("/stocks/068270?view=easy"); // 앨리스의 셀트리온 5주 (장기 보유)
    const sell = await screen.findByRole("button", { name: "모두 팔기" });
    expect(screen.queryByRole("button", { name: "전량 매도" })).toBeNull();
    expect(screen.getByText("같은 종목은 한 번에 하나만 가질 수 있고, 팔 때는 가진 수량을 모두 팔아요. 여기 평가는 지금 가격이에요 (내 자산·랭킹은 장 마감 가격).")).toBeTruthy();
    expect(screen.queryByText(/포지션/)).toBeNull();
    expect(screen.getByText("수수료·세금 빼기 전")).toBeTruthy();
    expect(screen.getByText("팔 때 수수료와 세금이 빠져서 받는 돈은 조금 적어요.")).toBeTruthy();
    expect(screen.getByText("산 가격")).toBeTruthy();
    fireEvent.click(sell);
    const box = screen.getByRole("group", { name: "5주를 모두 팔까요?" });
    fireEvent.click(within(box).getByRole("button", { name: "팔기" }));
    await waitFor(() => expect(toast().textContent).toMatch(/^모의 계좌에서 셀트리온 5주를 [\d,]+원에 팔았어요 · 손익 [+-]?[\d,]+원 \(수수료·세금 포함\)$/));
  });

  it("쉬운 보기 취소 토스트에는 '모의'가 들어간다", async () => {
    renderApp("/stocks/035720?view=easy"); // 앨리스의 카카오 체결 대기 주문
    fireEvent.click(await screen.findByRole("button", { name: "주문 취소" }));
    await waitFor(() => expect(toast().textContent).toBe("모의 주문을 취소했어요."));
  });

  it("전문가 보기 보유 패널은 그대로 ('전량 매도'·포지션 문구) + 손익 옆 '수수료·세금 빼기 전'", async () => {
    renderApp("/stocks/068270");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByRole("button", { name: "전량 매도" })).toBeTruthy();
    expect(within(panel).getByText(/^같은 종목은 포지션 하나만 가질 수 있고, 매도는 전량만 돼요/)).toBeTruthy();
    expect(within(panel).getByText("수수료·세금 빼기 전")).toBeTruthy();
    expect(within(panel).getByText("평균 체결가")).toBeTruthy();
  });
});

/** 현재가를 받지 못한 종목 상세: 시세가 직전 종가(basis close)다. */
function closeBasisQuote(symbol: string) {
  const d = db.stockDetail(symbol);
  const asOf = "2026-10-05T15:30:00+09:00";
  server.use(http.get("*/api/stocks/:symbol", () => HttpResponse.json({ ...d, quote: { ...d.quote, asOf, basis: "close" as const }, asOf })));
}

describe("오늘 산 종목 평가 (priceBasis today_fill)", () => {
  it("종목 상세 쉬운 보기: 시세가 실시간이면 '모의 보유' 한 줄과 보유 패널이 실시간 숫자 (장 마감 뒤 문구 없음)", async () => {
    boughtToday("068270");
    renderApp("/stocks/068270?view=easy");
    const line = await screen.findByRole("button", { name: /모의 보유 5주/ });
    await waitFor(() => expect(line.textContent).toBe("모의 보유 5주 · 932,000원 +4.72%")); // 186,400원 × 5주 · 체결가 178,000원
    expect(screen.queryByText(/장 마감\(15:40\) 뒤에 평가돼요/)).toBeNull();
    const panel = screen.getByRole("region", { name: "주문" });
    expect(within(panel).getByText("지금 가격")).toBeTruthy(); // 보유 패널의 가격 줄 (시세 카드의 이름과 같은 말)
    expect(within(panel).getByText("팔 때 수수료와 세금이 빠져서 받는 돈은 조금 적어요.")).toBeTruthy();
  });

  it("종목 상세 쉬운 보기: 현재가를 받지 못해 시세가 직전 종가면 '모의 보유' 한 줄과 보유 패널에 수익률·종가 대신 언제 평가되는지", async () => {
    boughtToday("068270");
    closeBasisQuote("068270");
    renderApp("/stocks/068270?view=easy");
    const line = await screen.findByRole("button", { name: /모의 보유 5주/ });
    await waitFor(() => expect(line.textContent).toContain("· 오늘 산 종목 · 장 마감(15:40) 뒤에 평가돼요"));
    expect(line.textContent).not.toMatch(/%/);
    expect(await screen.findByText("오늘 산 종목 · 장 마감(15:40) 뒤에 평가돼요")).toBeTruthy();
    const panel = screen.getByRole("region", { name: "주문" });
    expect(within(panel).queryByText("종가")).toBeNull(); // 보유 패널의 '종가' 행을 빼고 (시세 카드의 가격 이름은 종가 그대로)
    expect(screen.queryByText("수수료·세금 빼기 전")).toBeNull(); // 손익 줄 대신 위 문장
    expect(screen.getByText("팔 때 수수료와 세금이 빠져서 받는 돈은 조금 적어요.")).toBeTruthy();
  });

  it("종목 상세 전문가 보기: 실시간이면 평가 금액·손익·현재가 줄, '당일 매수 · 15:40 이후 종가 평가'는 없다", async () => {
    boughtToday("068270");
    renderApp("/stocks/068270");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByText("932,000원")).toBeTruthy();
    expect(within(panel).getByText("+42,000원 (+4.72%)")).toBeTruthy();
    expect(within(panel).getByText("현재가")).toBeTruthy();
    expect(within(panel).getByText(/^실시간 · \d{2}:\d{2}:\d{2}$/)).toBeTruthy();
    expect(within(panel).queryByText("당일 매수 · 15:40 이후 종가 평가")).toBeNull();
  });

  it("종목 상세 전문가 보기: 시세가 직전 종가면 '당일 매수 · 15:40 이후 종가 평가', 장마감 기준 시각을 붙이지 않는다", async () => {
    boughtToday("068270");
    closeBasisQuote("068270");
    renderApp("/stocks/068270");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByText("당일 매수 · 15:40 이후 종가 평가")).toBeTruthy();
    expect(within(panel).queryByText(/장마감 기준$/)).toBeNull();
  });

  it("모의투자 탭 쉬운 보기: 그 행은 종가·손익 대신 한 줄, 평가 기준 문구에 '(오늘 산 종목은 장 마감 뒤에)'", async () => {
    boughtToday("068270");
    renderApp("/portfolio?view=easy");
    const holdings = await screen.findByRole("list", { name: "보유 종목" });
    const celltrion = within(holdings).getByText("셀트리온").closest("li")!;
    await waitFor(() => expect(within(celltrion).getByText("오늘 산 종목 · 장 마감(15:40) 뒤에 평가돼요")).toBeTruthy());
    expect(within(celltrion).queryByText(/종가/)).toBeNull();
    expect(within(celltrion).queryByText(/%\)$/)).toBeNull();
    const samsung = within(holdings).getByText("삼성전자").closest("li")!;
    expect(within(samsung).getByText(/종가 /)).toBeTruthy(); // 다른 보유는 그대로 종가
    expect(within(screen.getByLabelText("평가 기준")).getByText("평가는 지난 장 마감 가격으로 해요 (오늘 산 종목은 장 마감 뒤에)")).toBeTruthy();
  });

  it("홈 자산 카드: 오늘 산 종목이 있으면 기준 시각 아래 한 줄", async () => {
    boughtToday("068270");
    const client = createQueryClient({ retry: false });
    render(
      <MemoryRouter>
        <Providers client={client}>
          <AssetCard easy />
        </Providers>
      </MemoryRouter>,
    );
    expect(await screen.findByText("오늘 산 종목은 산 가격으로 셈하고, 장 마감(15:40) 뒤에 평가돼요")).toBeTruthy();
  });
});
