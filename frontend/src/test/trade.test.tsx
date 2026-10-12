// 종목 상세 · 주문(보유 방식) · 모의투자 탭 · 실행 확인 · 모의 자동매매 상세 · 매매 계획 카드 · 교차검증 분석 (F-trade).
// 앨리스는 주린이모드 끔(전문가 보기), 밥은 진단 전이라 켬(쉬운 보기). 시각에 기대는 테스트는 freezeTime으로 KST 시각을 고정한다.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { CandlestickSeries, HistogramSeries, LineSeries, createChart } from "lightweight-charts";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { Providers } from "../App";
import { recentStocksKey } from "../api/trading";
import type { Recommendation, RiskPreview } from "../api/types";
import { AnalysisCard } from "../components/analysis/AnalysisCard";
import { PlanCard, type PlanCardProps } from "../components/plan/PlanCard";
import {
  EXIT_REASON,
  PREPARING_MS,
  closedMarketNotice,
  crossCheckSummary,
  duringSession,
  easySteps,
  exitReasonLabel,
  formatOpensAt,
  isTodayKst,
  kstDayOf,
  pickRecommendation,
  planCardState,
  splitProposals,
} from "../lib/autotrade";
import { formatDayLabel, formatPrice } from "../lib/format";
import { createQueryClient } from "../lib/queryClient";
import { setThemePref } from "../lib/theme";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

const toast = () => screen.getByRole("status");
const userOf = (username: string) => {
  db.setSession(username);
  return db.sessionUser()!;
};
/** 요청 본문 기록 (경로 끝이 suffix인 POST). */
function recordBodies(suffix: string) {
  const seen: Record<string, unknown>[] = [];
  server.events.on("request:start", async ({ request }) => {
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(suffix)) seen.push(await request.clone().json());
  });
  return seen;
}

// 화요일 장중 (KR 기준일 = 10월 5일 월요일 — 가짜 API는 휴일을 모른다)
const TUE_MORNING = "2026-10-06T10:00:00+09:00";
const KR_ASOF = "10월 5일(월) 15:30 장마감 기준";
/** 실시간 시세의 기준 표기 (받은 시각 — 테스트 시계는 흐르므로 초는 정하지 않는다). */
const LIVE_ASOF = /^실시간 · \d{2}:\d{2}:\d{2}$/;

/** 현재가를 받지 못한 종목의 종목 상세: 서버가 낸 장마감 기준 Quote(basis "close") + 오늘 봉 없는 일봉. KR 종목용 (TUE_MORNING 기준). */
const closeBasisStock = (symbol: string) => {
  const d = db.stockDetail(symbol);
  const asOf = "2026-10-05T15:30:00+09:00";
  return { ...d, quote: { ...d.quote, asOf, basis: "close" as const }, candles: d.candles.slice(0, -1), asOf };
};

describe("종목 상세: 실시간 시세와 AI 리포트 만들기", () => {
  it("현재가·실시간 기준·진행 중인 오늘 봉 안내, 오늘 이 종목 리포트가 있으면 '오늘 리포트 보기'와 남은 횟수", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/stocks/005930");
    const quote = await screen.findByRole("region", { name: "시세" });
    expect(within(quote).getByText("현재가")).toBeTruthy();
    expect(within(quote).getByText("71,200원")).toBeTruthy();
    expect(within(quote).getByText(LIVE_ASOF).textContent).toMatch(/^실시간 · 10:0\d:\d{2}$/); // 받은 시각 (KST)
    expect(within(quote).queryByText(/장마감 기준/)).toBeNull();
    expect(within(quote).getByText(/일봉 · 최근 120일 · 마지막 봉 10월 6일\(화\)은 진행 중/)).toBeTruthy();

    // 앨리스가 오늘 신청한 삼성전자 리포트(#2)가 있다 → 큰 버튼이 "오늘 리포트 보기"
    const link = await screen.findByRole("link", { name: "오늘 리포트 보기" });
    expect(link.getAttribute("href")).toBe("/reports/2");
    expect(screen.getByText(/내가 만듦/)).toBeTruthy(); // 내 리포트는 "내가 만듦"
    expect(screen.getByRole("button", { name: "새로 만들기" })).toBeTruthy();
    expect(await screen.findByText("오늘 2번 더 만들 수 있어요")).toBeTruthy();
    // 보조 버튼 (D-1)
    expect(screen.getByRole("button", { name: "AI 교차검증 분석" })).toBeTruthy();
  });

  it("장이 닫혀 있어도 시세는 실시간 현재가 — 마지막 봉은 완성된 종가 봉", async () => {
    freezeTime(TUE_MORNING, { marketOpen: { KR: false, US: false } });
    renderApp("/stocks/005930");
    const quote = await screen.findByRole("region", { name: "시세" });
    expect(within(quote).getByText("현재가")).toBeTruthy();
    expect(within(quote).getByText(LIVE_ASOF)).toBeTruthy();
    expect(within(quote).getByText(/일봉 · 최근 120일 · 완성된 봉만 \(마지막 봉 10월 5일\(월\) 종가\)/)).toBeTruthy();
  });

  it("쉬운 보기(밥)는 '지금 가격', 현재가를 받지 못한 종목은 종가와 장마감 기준 시각 그대로 (basis close)", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/stocks/005930", "bob");
    const live = await screen.findByRole("region", { name: "시세" });
    expect(within(live).getByText("지금 가격")).toBeTruthy();
    expect(within(live).getByText(LIVE_ASOF)).toBeTruthy();
    cleanup();

    server.use(http.get("*/api/stocks/:symbol", () => HttpResponse.json(closeBasisStock("005930"))));
    renderApp("/stocks/005930");
    const close = await screen.findByRole("region", { name: "시세" });
    expect(within(close).getByText("종가")).toBeTruthy();
    expect(within(close).getByText(KR_ASOF)).toBeTruthy();
    expect(within(close).queryByText(/^실시간/)).toBeNull();
    expect(within(close).getByText(/완성된 봉만 \(마지막 봉 10월 5일\(월\) 종가\)/)).toBeTruthy();
  });

  it("오늘 리포트가 없으면 큰 버튼 'AI 리포트 만들기' → 리포트를 만든다", async () => {
    freezeTime(TUE_MORNING);
    const seen = recordBodies("/api/reports");
    renderApp("/stocks/005380");
    const btn = await screen.findByRole("button", { name: "AI 리포트 만들기" });
    await screen.findByText("오늘 2번 더 만들 수 있어요");
    fireEvent.click(btn);
    await waitFor(() => expect(db.listReports("005380").length).toBe(1));
    server.events.removeAllListeners();
    expect(seen).toEqual([{ symbol: "005380" }]);
  });

  it("오늘 한도를 다 쓰면 버튼을 막고 다음 날 안내", async () => {
    freezeTime(TUE_MORNING, { reportLimit: 1 });
    renderApp("/stocks/005380");
    expect(await screen.findByText("오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요")).toBeTruthy();
    expect((screen.getByRole("button", { name: "AI 리포트 만들기" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("팀 AI 비용 예산 429(본문에 limit 없음)는 한도 문장 대신 서버 문장", async () => {
    freezeTime(TUE_MORNING);
    const budget = "오늘 AI 비용 예산을 다 썼어요. 내일 0시에 다시 신청할 수 있어요.";
    server.use(http.post("*/api/reports", () => HttpResponse.json({ detail: budget }, { status: 429 })));
    renderApp("/stocks/005380");
    await screen.findByText("오늘 2번 더 만들 수 있어요");
    fireEvent.click(screen.getByRole("button", { name: "AI 리포트 만들기" }));
    expect(await screen.findByText(budget)).toBeTruthy();
    expect(screen.queryByText("오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요")).toBeNull();
  });

  it("교차검증 분석 요청은 보조 버튼에서 → 끝나면 분석 상세", async () => {
    renderApp("/stocks/005380");
    const btn = await screen.findByRole("button", { name: "AI 교차검증 분석" });
    await screen.findByText(/오늘 4번 더 분석할 수 있어요/);
    fireEvent.click(btn);
    expect(await screen.findByRole("heading", { name: "현대차 AI 교차검증 분석" }, { timeout: 3000 })).toBeTruthy();
  });

  it("쉬운 보기(밥): 주문은 '직접 주문(고급)'으로 접혀 있고 하단 구매 버튼이 없다", async () => {
    renderApp("/stocks/005380", "bob");
    const toggle = await screen.findByRole("button", { name: /직접 주문\(고급\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByLabelText("수량")).toBeNull();
    expect(screen.queryByRole("button", { name: "구매하기" })).toBeNull();
    expect(screen.getByText(/AI 여러 곳이 시세·재무·뉴스를 읽고 리포트를 써요/)).toBeTruthy();
    fireEvent.click(toggle);
    expect(await screen.findByLabelText("수량")).toBeTruthy();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
  });

  it("전문가 보기(앨리스): 주문 패널이 바로 열려 있다", async () => {
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByLabelText("수량")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /직접 주문\(고급\)/ })).toBeNull();
  });

  it("전문가 보기 모바일: 하단 버튼 → 주문 시트(대화상자). Esc로 닫히면 연 버튼으로 포커스가 돌아오고 배경 잠금이 풀린다", async () => {
    renderApp("/stocks/005380");
    const open = await screen.findByRole("button", { name: "구매하기" }); // 주문·예약을 받기 전에는 중립 '주문'(누를 수 없음)
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    fireEvent.click(open);
    const sheet = screen.getByRole("dialog", { name: "주문하기" });
    expect(open.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(sheet);
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "주문하기" })).toBeNull();
    expect(screen.getByRole("region", { name: "주문" })).toBe(sheet); // 한 벌 DOM (PC 패널과 같은 요소)
    expect(document.activeElement).toBe(open);
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
  });

  it("보유 중이면 시세 아래 '모의 보유' 한 줄(수량·평가·수익률), 누르면 주문 시트(제목 '내 모의 주문')", async () => {
    renderApp("/stocks/005930");
    const quote = await screen.findByRole("region", { name: "시세" });
    const line = await within(quote).findByRole("button", { name: /모의 보유 10주/ });
    expect(line.textContent).toMatch(/^모의 보유 10주 · [\d,]+원 [+-]\d+\.\d{2}%$/);
    expect(screen.getByRole("button", { name: "판매하기" })).toBeTruthy();
    fireEvent.click(line);
    expect(screen.getByRole("dialog", { name: "내 모의 주문" })).toBeTruthy();
  });

  it("쉬운 보기: '모의 보유' 한 줄을 누르면 접어 둔 '내 모의 주문'을 펼치고 그리로 포커스", async () => {
    renderApp("/stocks/068270?view=easy");
    const toggle = await screen.findByRole("button", { name: "내 모의 주문" });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true")); // 주문이 있으면 펼친 채 시작
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /모의 보유 5주/ }));
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(toggle));
  });

  it("분석에서 오면(?analysis=) 하단 버튼이 '분석 가격으로 주문하기' — 채워 둔 사실을 알린다 (시트를 저절로 열지 않는다)", async () => {
    renderApp("/stocks/000660?analysis=2");
    const bar = await screen.findByRole("button", { name: /분석 가격으로 주문하기/ });
    expect(bar.textContent).toContain("AI 분석 #2의 목표가·손절가를 채워 뒀어요");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("없는 종목: '다시 시도' 대신 종목 검색으로 (검색어를 채워서)", async () => {
    renderApp("/stocks/NOPE999");
    const link = await screen.findByRole("link", { name: "종목 검색으로" });
    expect(link.getAttribute("href")).toBe("/search?q=NOPE999");
    expect(screen.getByText("종목을 찾을 수 없어요")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull();
  });

  it("교차검증 분석: 다른 화면에 다녀와도 '분석 중'이 이어지고 버튼은 막혀 있다 (같은 분석을 또 누르지 않게)", async () => {
    db.resetDb({ jitter: false, persist: false, jobPolls: 99, marketOpen: { KR: true, US: false } }); // 끝나지 않는 작업
    const first = renderApp("/stocks/005380");
    await screen.findByText(/오늘 4번 더 분석할 수 있어요/);
    fireEvent.click(screen.getByRole("button", { name: "AI 교차검증 분석" }));
    expect(await screen.findByText(/현대차 교차검증 분석 중이에요/)).toBeTruthy();
    first.unmount();
    renderApp("/stocks/005380");
    expect(await screen.findByText(/현대차 교차검증 분석 중이에요/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "AI 교차검증 분석" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("교차검증 분석: 끝났을 때 입력 중이면 화면을 옮기지 않고 '결과 보기'를 보인다 (입력을 잃지 않게)", async () => {
    renderApp("/stocks/005380");
    const qty = await within(await screen.findByRole("region", { name: "주문" })).findByLabelText("수량");
    await screen.findByText(/오늘 4번 더 분석할 수 있어요/);
    fireEvent.click(screen.getByRole("button", { name: "AI 교차검증 분석" }));
    qty.focus(); // 수량을 입력하는 중
    expect(await screen.findByText("분석이 끝났어요")).toBeTruthy();
    expect(screen.getByRole("link", { name: "결과 보기" }).getAttribute("href")).toMatch(/^\/analyses\/\d+$/);
    expect(screen.queryByRole("heading", { name: "현대차 AI 교차검증 분석" })).toBeNull();
    // 카드 안 글은 화면 읽기에 알려지지 않으므로(시트가 열려 있으면 배경이 inert) 토스트로도 알린다 — 거기서 바로 결과로 갈 수 있다
    expect(within(toast()).getByText("현대차 교차검증 분석이 끝났어요")).toBeTruthy();
    expect(document.activeElement).toBe(qty); // 입력하던 칸은 그대로
    fireEvent.click(within(toast()).getByRole("button", { name: "결과 보기" }));
    expect(await screen.findByRole("heading", { name: "현대차 AI 교차검증 분석" })).toBeTruthy();
  });

  it("교차검증 분석이 실패하면 카드 안 문구와 함께 토스트로 알린다 (화면 읽기에도)", async () => {
    db.resetDb({ jitter: false, persist: false, jobPolls: 1, jobFails: true, marketOpen: { KR: true, US: false } });
    renderApp("/stocks/005380");
    await screen.findByText(/오늘 4번 더 분석할 수 있어요/);
    fireEvent.click(screen.getByRole("button", { name: "AI 교차검증 분석" }));
    expect(await screen.findByText(/^분석에 실패했어요: AI 응답 형식 오류/)).toBeTruthy();
    expect(within(toast()).getByText("현대차 교차검증 분석에 실패했어요")).toBeTruthy();
  });

  it("교차검증 분석: 같은 탭에서 다른 계정으로 들어오면 앞 사람의 작업을 이어받지 않는다 (남의 작업을 묻지 않는다)", async () => {
    db.resetDb({ jitter: false, persist: false, jobPolls: 99, marketOpen: { KR: true, US: false } }); // 끝나지 않는 작업
    const first = renderApp("/stocks/005380"); // 앨리스
    await screen.findByText(/오늘 4번 더 분석할 수 있어요/);
    fireEvent.click(screen.getByRole("button", { name: "AI 교차검증 분석" }));
    expect(await screen.findByText(/현대차 교차검증 분석 중이에요/)).toBeTruthy();
    first.unmount(); // 로그아웃 → 같은 탭에서 밥으로 로그인
    const jobCalls: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.startsWith("/api/jobs/")) jobCalls.push(request.url);
    });
    renderApp("/stocks/005380", "bob");
    await screen.findByText(/오늘 \d+번 더 분석할 수 있어요/);
    expect((screen.getByRole("button", { name: "AI 교차검증 분석" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText(/교차검증 분석 중이에요/)).toBeNull();
    expect(screen.queryByText(/작업을 찾/)).toBeNull();
    expect(jobCalls).toEqual([]);
    server.events.removeAllListeners();
  });

  it("교차검증 분석: 작업이 서버에서 없어지면(404) 한 번 알리고 잊는다 — 그 작업을 더 묻지 않고, 다시 요청할 수 있다", async () => {
    db.resetDb({ jitter: false, persist: false, jobPolls: 99, marketOpen: { KR: true, US: false } });
    const first = renderApp("/stocks/005380");
    await screen.findByText(/오늘 4번 더 분석할 수 있어요/);
    fireEvent.click(screen.getByRole("button", { name: "AI 교차검증 분석" }));
    expect(await screen.findByText(/현대차 교차검증 분석 중이에요/)).toBeTruthy();
    first.unmount();
    const savedKey = () => {
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (k?.startsWith("paper-analysis-job:") && k.endsWith(":005380")) return k;
      }
      return null;
    };
    const jobId = (JSON.parse(sessionStorage.getItem(savedKey()!)!) as { jobId: number }).jobId;
    // 서버가 다시 시작돼 작업이 없어졌다
    server.use(http.get("*/api/jobs/:id", () => HttpResponse.json({ detail: "작업을 찾을 수 없습니다." }, { status: 404 })));
    const { client } = renderApp("/stocks/005380");
    expect(await screen.findByText("분석 작업을 찾지 못했어요. 다시 요청해 주세요.")).toBeTruthy();
    expect(screen.queryByText(/교차검증 분석 중이에요/)).toBeNull();
    await screen.findByText(/오늘 \d+번 더 분석할 수 있어요/); // 남은 횟수를 받으면
    expect((screen.getByRole("button", { name: "AI 교차검증 분석" }) as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(savedKey()).toBeNull()); // 이 탭의 기록도 지운다
    // 그 작업을 지켜보는 쿼리가 없다 = 5초 폴링이 멈췄다
    expect(client.getQueryCache().find({ queryKey: ["job", jobId] })?.getObserversCount() ?? 0).toBe(0);
  });
});

describe("종목 상세 · 내 모의 주문 한 줄과 주문 시트", () => {
  it("'모의 보유' 한 줄로 연 시트에서 전량 매도하면, 닫힌 뒤 포커스는 하단 버튼으로 (보유가 끝나 사라지는 줄로 가지 않게)", async () => {
    renderApp("/stocks/005930");
    const quote = await screen.findByRole("region", { name: "시세" });
    const line = await within(quote).findByRole("button", { name: /모의 보유 10주/ });
    line.focus();
    fireEvent.click(line);
    const sheet = screen.getByRole("dialog", { name: "내 모의 주문" });
    fireEvent.click(within(sheet).getByRole("button", { name: "전량 매도" }));
    fireEvent.click(await within(sheet).findByRole("button", { name: "매도하기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(within(quote).queryByRole("button", { name: /모의 보유/ })).toBeNull()); // 보유가 끝나 줄이 접혔다
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "구매하기" }));
  });

  it("아무것도 하지 않고 Esc로 닫으면 포커스는 연 줄로 돌아간다 (줄이 그대로 있으므로)", async () => {
    renderApp("/stocks/005930");
    const line = await within(await screen.findByRole("region", { name: "시세" })).findByRole("button", { name: /모의 보유 10주/ });
    line.focus();
    fireEvent.click(line);
    expect(screen.getByRole("dialog", { name: "내 모의 주문" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(line);
  });

  it("쉬운 보기: '내 모의 주문'에서 주문을 취소하면 저절로 접히고 포커스는 접힘 버튼으로 (body로 떨어지지 않게) — 보내는 동안에도 누른 버튼에 남는다 (a11y-11)", async () => {
    let calls = 0;
    server.use(
      http.post("*/api/orders/:id/cancel", async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 60));
        return undefined;
      }),
    );
    renderApp("/stocks/035720?view=easy"); // 앨리스의 카카오 체결 대기 주문
    const toggle = await screen.findByRole("button", { name: "내 모의 주문" });
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("true")); // 주문이 있으면 펼친 채 시작
    const cancel = await screen.findByRole("button", { name: "주문 취소" });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(cancel.getAttribute("aria-disabled")).toBe("true")); // 보내는 동안: disabled가 아니라 포커스가 남는다
    expect((cancel as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(cancel); // 보내는 동안 다시 눌러도 무시
    expect(document.activeElement).toBe(cancel);
    await waitFor(() => expect(toast().textContent).toContain("주문을 취소했어요."));
    await waitFor(() => expect(toggle.getAttribute("aria-expanded")).toBe("false"));
    expect(toggle.textContent).toContain("직접 주문(고급)");
    expect(document.activeElement).toBe(toggle);
    expect(calls).toBe(1);
  });

  it("매도 예약을 취소하면 누른 버튼 자리의 '전량 매도'로 포커스가 옮겨 간다 (사라진 버튼과 함께 body로 떨어지지 않게)", async () => {
    db.options.marketOpen = { KR: false, US: false }; // 장이 닫혀 있으면 매도가 다음 정규장 시작 예약이 된다
    renderApp("/stocks/005930");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.click(await within(panel).findByRole("button", { name: "전량 매도" }));
    fireEvent.click(within(panel).getByRole("button", { name: "매도 예약" }));
    const cancel = await within(panel).findByRole("button", { name: "매도 예약 취소" });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(toast().textContent).toContain("매도 예약을 취소했어요."));
    const sell = await within(panel).findByRole("button", { name: "전량 매도" });
    await waitFor(() => expect(document.activeElement).toBe(sell));
  });
});

describe("종목 상세 · 일봉 차트 (전문가 보기 캔들 · 쉬운 보기 종가 선)", () => {
  type FakeSeries = { setData: Mock; applyOptions: Mock };
  type FakeChart = { addSeries: Mock; applyOptions: Mock; remove: Mock };
  /** 가짜 시리즈 (setupTests — 모든 차트·시리즈가 같은 가짜 하나를 나눠 쓴다). */
  const fakeSeries = () => (createChart(document.createElement("div")) as unknown as { addSeries: () => FakeSeries }).addSeries();
  /** 이 상자에 마지막으로 만든 차트. */
  const chartOn = (box: Element) => {
    const { calls, results } = vi.mocked(createChart).mock;
    let i = calls.length - 1;
    while (i >= 0 && calls[i][0] !== box) i--;
    return results[i].value as FakeChart;
  };
  /** 만든 시리즈 종류 (순서대로). */
  const kinds = (chart: FakeChart) =>
    chart.addSeries.mock.calls.map(([def]) => (def === CandlestickSeries ? "candle" : def === LineSeries ? "line" : def === HistogramSeries ? "volume" : "?"));
  const KR = (p: number) => Math.round(p).toLocaleString("ko-KR");

  it("전문가 보기(앨리스): 캔들 + 이동평균 둘 + 거래량, 범례는 마지막 봉 (날짜·종가)", async () => {
    renderApp("/stocks/005930");
    const box = await screen.findByRole("img", { name: /^일봉 차트 \(마지막 봉 \d{4}-\d{2}-\d{2}, 오늘 봉은 진행 중일 수 있음\)$/ });
    expect(kinds(chartOn(box))).toEqual(["candle", "line", "line", "volume"]);
    const last = db.stockDetail("005930").candles.at(-1)!;
    expect(box.getAttribute("aria-label")).toContain(last.date);
    const legend = box.previousElementSibling!;
    expect(legend.getAttribute("aria-hidden")).toBe("true"); // 화면 읽기는 차트 이름이 요약한다
    expect(legend.textContent).toContain(formatDayLabel(last.date));
    expect(legend.textContent).toContain(`종 ${KR(last.close)}`);
  });

  it("쉬운 보기(밥): 종가 선 하나 — 이름과 범례에 마지막 날 종가", async () => {
    renderApp("/stocks/005930", "bob");
    const { candles } = db.stockDetail("005930");
    const last = candles.at(-1)!;
    const box = await screen.findByRole("img", {
      name: `종가 선 차트 (최근 ${candles.length}일, 마지막 ${formatDayLabel(last.date)} 종가 ${formatPrice(last.close, "KRW")})`,
    });
    expect(kinds(chartOn(box))).toEqual(["line"]);
    expect(box.previousElementSibling!.textContent).toContain(`${formatDayLabel(last.date)} 종가 ${formatPrice(last.close, "KRW")}`);
  });

  it("테마를 바꾸면 차트를 다시 만들지 않고 색만 바꾼다 (확대 상태가 남게) — 전문가 캔들", async () => {
    const series = fakeSeries();
    renderApp("/stocks/005930");
    const box = await screen.findByRole("img", { name: /^일봉 차트 \(/ });
    const chart = chartOn(box);
    await waitFor(() => expect(series.setData).toHaveBeenCalled());
    const made = vi.mocked(createChart).mock.calls.length;
    series.setData.mockClear();
    series.applyOptions.mockClear();
    chart.applyOptions.mockClear();

    act(() => setThemePref("dark"));
    // 봉 색은 다크 상승·하락색 (jsdom은 토큰을 못 읽어 대체값), 축·격자는 차트 옵션으로
    await waitFor(() => expect(series.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ upColor: "#F25C68", downColor: "#458EF7" })));
    expect(chart.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ layout: expect.objectContaining({ textColor: expect.any(String) }) }));
    expect(vi.mocked(createChart).mock.calls.length).toBe(made); // 다시 만들지 않는다
    expect(chart.remove).not.toHaveBeenCalled();
    // 다시 넣는 것은 봉마다 색이 있는 거래량뿐이다 (봉·이동평균은 그대로)
    expect(series.setData).toHaveBeenCalledTimes(1);
    expect((series.setData.mock.calls[0][0] as { color?: string }[])[0].color).toMatch(/^rgba\(/);
  });

  it("쉬운 보기 종가 선도 테마를 따라 색만 바꾼다 (데이터는 다시 넣지 않는다)", async () => {
    const series = fakeSeries();
    renderApp("/stocks/005930", "bob");
    const box = await screen.findByRole("img", { name: /^종가 선 차트/ });
    const chart = chartOn(box);
    await waitFor(() => expect(series.setData).toHaveBeenCalled());
    const made = vi.mocked(createChart).mock.calls.length;
    const { candles } = db.stockDetail("005930");
    const fell = candles.at(-1)!.close < candles[0].close;
    series.setData.mockClear();
    series.applyOptions.mockClear();

    act(() => setThemePref("dark"));
    await waitFor(() => expect(series.applyOptions).toHaveBeenCalledWith({ color: fell ? "#458EF7" : "#F25C68" }));
    expect(vi.mocked(createChart).mock.calls.length).toBe(made);
    expect(chart.remove).not.toHaveBeenCalled();
    expect(series.setData).not.toHaveBeenCalled();
  });
});

describe("종목 상세 · AI 리포트 만들기", () => {
  it("오늘 남은 횟수를 받지 못하면 '확인하는 중'에 멈추지 않고 다시 확인할 수 있다", async () => {
    let fail = true;
    server.use(http.get("*/api/reports/quota", () => (fail ? HttpResponse.json({ detail: "오류" }, { status: 500 }) : undefined)));
    renderApp("/stocks/005380", "bob");
    const cta = await screen.findByRole("region", { name: "AI 리포트" });
    expect(await within(cta).findByText("오늘 남은 횟수를 확인하지 못했어요.")).toBeTruthy();
    fail = false;
    fireEvent.click(within(cta).getByRole("button", { name: "다시 확인" }));
    expect(await within(cta).findByText(/^오늘 \d번 더 만들 수 있어요$/)).toBeTruthy();
  });

  it("리포트 목록·한도를 다 받기 전에는 큰 버튼 자리에 뼈대만 둔다 (누를 수 있는 '만들기'가 먼저 보였다 바뀌지 않게)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get("*/api/reports/quota", async () => {
        await gate;
        return undefined; // 기본 처리기로
      }),
    );
    renderApp("/stocks/005380");
    const cta = await screen.findByRole("region", { name: "AI 리포트" });
    await screen.findByRole("button", { name: "AI 교차검증 분석" }); // 다른 카드는 다 그린 뒤에도
    expect(cta.getAttribute("aria-busy")).toBe("true");
    expect(within(cta).queryByRole("button", { name: "AI 리포트 만들기" })).toBeNull();
    release();
    expect(await within(cta).findByRole("button", { name: "AI 리포트 만들기" })).toBeTruthy();
    expect(within(cta).getByText(/^오늘 \d번 더 만들 수 있어요$/)).toBeTruthy();
    expect(cta.hasAttribute("aria-busy")).toBe(false);
  });

  it("장애 주입(시연)은 전문가 보기에만 접혀 있고, 켜면 큰 버튼에 표시하고 요청에 싣는다", async () => {
    const seen = recordBodies("/api/reports");
    renderApp("/stocks/005380");
    const cta = await screen.findByRole("region", { name: "AI 리포트" });
    const toggle = await within(cta).findByRole("button", { name: /장애 주입 \(시연\)/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    fireEvent.click(await within(cta).findByRole("switch", { name: /장애 주입/ }));
    fireEvent.click(await within(cta).findByRole("button", { name: "AI 리포트 만들기 · 장애 주입" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    server.events.removeAllListeners();
    expect(seen[0]).toMatchObject({ symbol: "005380", chaos: { enabled: true } });
  });

  it("쉬운 보기에는 장애 주입이 없다", async () => {
    renderApp("/stocks/005380", "bob");
    await within(await screen.findByRole("region", { name: "AI 리포트" })).findByRole("button", { name: "AI 리포트 만들기" });
    expect(screen.queryByRole("button", { name: /장애 주입/ })).toBeNull();
  });
});

describe("주문: 보유 방식(스윙·장기 보유)", () => {
  it("장기 보유가 기본(분석에서 오지 않으면): 시장가 추정 안내, style long으로 주문하고 '왜 샀나요?'를 연다", async () => {
    const seen = recordBodies("/api/orders");
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    const group = await within(panel).findByRole("group", { name: "보유 방식" });
    expect(within(group).getByRole("button", { name: "장기 보유" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).getByText("지금 시세 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요.")).toBeTruthy();
    expect(within(panel).getByText("시장가 · 현재가")).toBeTruthy();
    expect(within(panel).getByText(LIVE_ASOF)).toBeTruthy();
    expect(within(panel).queryByLabelText("목표가")).toBeNull();
    fireEvent.change(within(panel).getByLabelText("수량"), { target: { value: "2" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    const dialog = await screen.findByRole("dialog", { name: "왜 샀나요?" });
    expect(within(dialog).getByText(/현대차를 산 이유를 1~3개 적어 두면/)).toBeTruthy(); // 받침에 맞는 조사
    server.events.removeAllListeners();
    expect(seen).toEqual([{ symbol: "005380", quantity: 2, orderType: "MARKET", style: "long" }]);
    expect(toast().textContent).toContain("현대차 2주 248,000원에 매수 체결");
    fireEvent.click(within(dialog).getByRole("button", { name: "나중에 적기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "왜 샀나요?" })).toBeNull());
    expect(db.listOrders(1, "active").find((o) => o.symbol === "005380")?.style).toBe("long");
  });

  it("현재가를 받지 못한 종목(basis close)의 주문 패널은 '직전 종가'와 장마감 기준 문구 그대로", async () => {
    freezeTime(TUE_MORNING);
    server.use(http.get("*/api/stocks/:symbol", () => HttpResponse.json(closeBasisStock("005380"))));
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByText("시장가 · 직전 종가")).toBeTruthy();
    expect(within(panel).getByText(KR_ASOF)).toBeTruthy();
    expect(within(panel).getByText("직전 장마감 가격 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요.")).toBeTruthy();
    fireEvent.click(within(await within(panel).findByRole("group", { name: "보유 방식" })).getByRole("button", { name: "스윙" }));
    fireEvent.change(within(panel).getByLabelText("수량"), { target: { value: "1" } });
    fireEvent.change(within(panel).getByLabelText("목표가"), { target: { value: "240000" } });
    fireEvent.change(within(panel).getByLabelText("손절가"), { target: { value: "230000" } });
    expect(within(panel).getByRole("alert").textContent).toBe("손절가 < 직전 종가 < 목표가 순서여야 해요.");
    expect(within(panel).getAllByText(/^종가 대비/)).toHaveLength(2); // 목표가·손절가 칸 아래 읽기 도움
  });

  it("스윙은 목표가·손절가가 둘 다 있어야 하고(순서 검사), style swing으로 보낸다", async () => {
    const seen = recordBodies("/api/orders");
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.click(within(await within(panel).findByRole("group", { name: "보유 방식" })).getByRole("button", { name: "스윙" }));
    fireEvent.change(within(panel).getByLabelText("수량"), { target: { value: "1" } });
    const buy = within(panel).getByRole("button", { name: "매수하기" }) as HTMLButtonElement;
    expect(buy.disabled).toBe(true);
    expect(within(panel).getByText("스윙은 목표가와 손절가를 둘 다 넣어 주세요.")).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText("목표가"), { target: { value: "240000" } });
    fireEvent.change(within(panel).getByLabelText("손절가"), { target: { value: "230000" } });
    expect(within(panel).getByRole("alert").textContent).toBe("손절가 < 현재가 < 목표가 순서여야 해요.");
    fireEvent.change(within(panel).getByLabelText("목표가"), { target: { value: "270000" } });
    await waitFor(() => expect(buy.disabled).toBe(false));
    fireEvent.click(buy);
    await waitFor(() => expect(toast().textContent).toContain("매수 체결"));
    server.events.removeAllListeners();
    expect(seen).toEqual([{ symbol: "005380", quantity: 1, orderType: "MARKET", style: "swing", targetPrice: 270_000, stopPrice: 230_000 }]);
    expect(screen.queryByRole("dialog", { name: "왜 샀나요?" })).toBeNull(); // 스윙은 산 이유를 묻지 않는다
  });

  it("장기 매수가 비중 점검에서 막히면(400 reasonCodes) 쉬운 사유 문장을 보인다", async () => {
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.change(await within(panel).findByLabelText("수량"), { target: { value: "6" } }); // 총 금액 한도 5,000,000원을 넘는다
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    await waitFor(() => expect(toast().textContent).toBe("총 투자 금액 한도를 넘어요"));
    expect(screen.queryByRole("dialog", { name: "왜 샀나요?" })).toBeNull();
  });

  it("장기 보유 중이면 '장기' 배지·자동 매도 없음·현재가와 실시간 기준 시각, 산 이유를 열 수 있다", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/stocks/068270");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByText("보유 중")).toBeTruthy();
    expect(within(panel).getByText("장기")).toBeTruthy();
    expect(within(panel).getByText("없음 (내가 팔 때까지 보유)")).toBeTruthy();
    expect(within(panel).getByText("현재가")).toBeTruthy(); // 보유 평가는 시세 (종목 화면 — 2026-10-11)
    expect(within(panel).getByText(LIVE_ASOF)).toBeTruthy();
    expect(within(panel).queryByText("종가")).toBeNull();
    // 산 이유가 이미 있으면 버튼은 "산 이유 보기·고치기" (펀더멘털 조회가 끝난 뒤)
    fireEvent.click(await within(panel).findByRole("button", { name: "산 이유 보기·고치기" }));
    const dialog = await screen.findByRole("dialog", { name: "왜 샀나요?" });
    // 이미 적은 산 이유·축이 채워진 채로 열린다 (빈 폼으로 저장해 덮어쓰지 않게)
    const reasons = await within(dialog).findByRole("list", { name: "내 이유" });
    expect(within(reasons).getAllByRole("listitem").map((li) => li.textContent)).toEqual(["바이오시밀러 해외 판매가 늘고 있어서", "신약 개발 일정이 공개돼 있어서"]);
    expect((within(dialog).getByRole("checkbox", { name: "성장" }) as HTMLInputElement).checked).toBe(true);
    expect((within(dialog).getByRole("checkbox", { name: "재무 안정" }) as HTMLInputElement).checked).toBe(false);
    expect(within(dialog).getAllByRole("heading", { name: "왜 샀나요?" })).toHaveLength(1); // 제목·설명은 한 번만
  });

  it("'왜 샀나요?'는 펀더멘털 조회가 끝나야 폼을 그린다 (그 전에는 빈 폼이 아니라 불러오는 중)", async () => {
    freezeTime(TUE_MORNING);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get("/api/stocks/068270/fundamentals", async () => {
        await gate;
        return HttpResponse.json(db.fundamentals(1, "068270"));
      }),
    );
    renderApp("/stocks/068270");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.click(await within(panel).findByRole("button", { name: "왜 샀나요? (산 이유 적기)" }));
    const dialog = await screen.findByRole("dialog", { name: "왜 샀나요?" });
    expect(within(dialog).queryByRole("button", { name: "산 이유 저장" })).toBeNull();
    expect(within(dialog).getByLabelText("불러오는 중")).toBeTruthy();
    release();
    expect(await within(dialog).findByText("바이오시밀러 해외 판매가 늘고 있어서")).toBeTruthy();
  });

  it("펀더멘털 점검을 하지 않는 종목(금융업)은 장기 매수 뒤 '왜 샀나요?'를 열지 않고, 보유 패널에도 버튼이 없다", async () => {
    renderApp("/stocks/105560");
    await screen.findByText("금융업은 일반 기업용 점검을 적용하지 않아요");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.change(await within(panel).findByLabelText("수량"), { target: { value: "1" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    await waitFor(() => expect(toast().textContent).toContain("매수 체결"));
    expect(await within(panel).findByText("보유 중")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "왜 샀나요?" })).toBeNull();
    expect(within(panel).queryByRole("button", { name: "왜 샀나요? (산 이유 적기)" })).toBeNull();
  });

  it("쉬운 보기 매수는 확인 상자를 거친다 — '모의 매수 확정'을 눌러야 주문이 나간다", async () => {
    const seen = recordBodies("/api/orders");
    renderApp("/stocks/005380", "bob");
    fireEvent.click(await screen.findByRole("button", { name: /직접 주문\(고급\)/ }));
    fireEvent.change(await screen.findByLabelText("수량"), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: "매수하기" }));
    const box = screen.getByRole("group", { name: "모의 계좌로 현대차 1주를 살까요?" });
    expect(box.textContent).toContain("장기 보유");
    expect(seen).toEqual([]);
    fireEvent.click(within(box).getByRole("button", { name: "모의 매수 확정" }));
    await waitFor(() => expect(seen).toHaveLength(1));
    server.events.removeAllListeners();
    expect(seen[0]).toMatchObject({ symbol: "005380", quantity: 1, style: "long" });
  });

  it("주문이 접수돼 본문이 바뀌면(매수 폼 → 보유) 새 제목으로 포커스가 옮겨 간다 (누른 버튼이 사라져도 자리를 잃지 않게)", async () => {
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.click(within(await within(panel).findByRole("group", { name: "보유 방식" })).getByRole("button", { name: "스윙" }));
    fireEvent.change(within(panel).getByLabelText("수량"), { target: { value: "1" } });
    fireEvent.change(within(panel).getByLabelText("목표가"), { target: { value: "270000" } });
    fireEvent.change(within(panel).getByLabelText("손절가"), { target: { value: "230000" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    const title = await within(panel).findByRole("heading", { name: /보유 중/ });
    await waitFor(() => expect(document.activeElement).toBe(title));
  });

  it("거절 사유는 토스트와 함께 매수 버튼 위에 남고(수량 칸 aria-invalid), 수량을 바꾸면 지운다", async () => {
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    const qty = await within(panel).findByLabelText("수량");
    fireEvent.change(qty, { target: { value: "6" } }); // 총 금액 한도를 넘는다
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    await waitFor(() => expect(within(panel).getByRole("alert").textContent).toBe("총 투자 금액 한도를 넘어요"));
    expect(qty.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(qty, { target: { value: "1" } });
    expect(within(panel).getByRole("alert").textContent).toBe("");
    expect(qty.hasAttribute("aria-invalid")).toBe(false);
  });

  it("예약으로 접수된 장기 매수는 '왜 사려고 하나요?' — 맨 위의 예약 결과가 대화상자 설명, 처음 포커스는 '나중에 적기'", async () => {
    db.resetDb({ jitter: false, persist: false, jobPolls: 1, marketOpen: { KR: false, US: false } });
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.change(await within(panel).findByLabelText("수량"), { target: { value: "1" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수 예약하기" }));
    const dialog = await screen.findByRole("dialog", { name: "왜 사려고 하나요?" });
    const band = within(dialog).getByText(/^모의 계좌에서 .+에 현대차 1주를 사도록 예약했어요$/);
    expect(within(dialog).getByText(/^사고 나면 이 이유로 점검해요\. 현대차를 사려는 이유를/)).toBeTruthy();
    // 결과는 대화상자 설명이라 화면 읽기가 제목 다음에 읽는다. 포커스는 조작할 곳(건너뛰기)에 둔다
    expect(band.id).not.toBe("");
    expect(dialog.getAttribute("aria-describedby")).toBe(band.id);
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "나중에 적기" }));
  });
});

describe("모의투자 탭", () => {
  it("전문가 보기(앨리스): 진행 중·보유(배지·장마감 기준)·끝난 계획·AI 추천", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/portfolio");
    expect(await screen.findByRole("heading", { name: "모의투자" })).toBeTruthy();
    const holdings = await screen.findByRole("list", { name: "보유 종목" });
    const samsung = within(holdings).getByText("삼성전자").closest("li")!;
    expect(within(samsung).getByText("스윙")).toBeTruthy();
    expect(within(samsung).getByText(/종가 71,200원/)).toBeTruthy();
    const celltrion = within(holdings).getByText("셀트리온").closest("li")!;
    expect(within(celltrion).getByText("장기")).toBeTruthy();
    expect(within(celltrion).getByText("장기 보유 · 자동 매도 없음")).toBeTruthy();
    const basis = screen.getByLabelText("평가 기준");
    expect(within(basis).getByText(KR_ASOF)).toBeTruthy();
    expect(within(basis).getByText("10월 5일(월) 16:00(뉴욕) 장마감 기준")).toBeTruthy();

    const ended = await screen.findByRole("list", { name: "끝난 계획" });
    expect(within(ended).getByRole("link", { name: "삼성전자 계획 보기" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "AI 추천" })).toBeTruthy();
    expect(await screen.findByRole("list", { name: "새 계획 제안 목록" })).toBeTruthy();
  });

  it("쉬운 보기(밥): 새 계획 제안은 리포트에서 나온 것만, 나머지는 '다른 계획 ○개'로 접는다", async () => {
    renderApp("/portfolio", "bob");
    expect(await screen.findByRole("heading", { name: "진행 중 모의 자동매매" })).toBeTruthy();
    const main = await screen.findByRole("list", { name: "새 계획 제안 목록" });
    expect(within(main).getAllByRole("link").map((a) => a.getAttribute("aria-label"))).toEqual(["SK하이닉스 계획 제안 보기"]);
    const fold = screen.getByRole("button", { name: /다른 계획 2개/ });
    expect(fold.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(fold);
    const others = screen.getByRole("list", { name: "다른 계획 목록" });
    expect(within(others).getByText("연습용 예시 · AI 아님")).toBeTruthy();
    expect(within(others).getByText("AI 교차검증 분석")).toBeTruthy();
    expect(screen.getByText("모든 매매는 모의 계좌에서만 이뤄져요 (실제 돈이 아니에요).")).toBeTruthy();
  });

  it("체결 내역의 청산 사유는 docs/API.md 표 이름", async () => {
    renderApp("/portfolio?tab=fills");
    const fills = await screen.findByRole("list", { name: "체결 내역" });
    expect(within(fills).getAllByText(/목표가 도달/).length).toBeGreaterThan(0);
    expect(within(fills).getAllByText(/매수 체결/).length).toBeGreaterThan(0);
  });

  it("탭은 ←/→로 옮기고(선택한 탭만 Tab으로 들어온다) 패널은 고른 탭 하나", async () => {
    renderApp("/portfolio");
    const holdings = await screen.findByRole("tab", { name: "보유 종목" });
    expect(holdings.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "체결 내역" }).getAttribute("tabindex")).toBe("-1");
    holdings.focus();
    fireEvent.keyDown(holdings, { key: "ArrowRight" });
    const orders = screen.getByRole("tab", { name: "대기 주문·예약" });
    expect(orders.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(orders);
    expect(screen.getByRole("tabpanel").getAttribute("aria-labelledby")).toBe("tab-orders");
    expect(await screen.findByRole("heading", { name: "체결 대기 주문" })).toBeTruthy();
  });

  it("처음 쓰는 사람(밥): 빈 칸은 한 줄로 줄이고, 진행 중이 비면 '새 계획 제안 보기'가 같은 화면의 제안으로 데려간다", async () => {
    renderApp("/portfolio", "bob");
    expect(await screen.findByText(/^아직 산 종목이 없어요 · 현금/)).toBeTruthy();
    expect(screen.queryByText("보유 평가액")).toBeNull(); // '0원 (-)' 카드는 그리지 않는다
    expect(await screen.findByText("아직 끝난 계획이 없어요.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "새 계획 제안 보기" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "새 계획 제안" }));
  });

  it("쉬운 보기에서는 보유 행도 쉬운 말(산 가격·목표 가격·손절 가격)", async () => {
    renderApp("/portfolio?view=easy");
    const holdings = await screen.findByRole("list", { name: "보유 종목" });
    const samsung = within(holdings).getByText("삼성전자").closest("li")!;
    expect(within(samsung).getByText(/· 산 가격 69,500원 ·/)).toBeTruthy();
    expect(within(samsung).getByText(/^목표 가격/)).toBeTruthy();
    expect(within(samsung).queryByText(/평균/)).toBeNull();
  });
});

describe("새 계획 제안 · 실행 확인 (쉬운 보기)", () => {
  it("목록: 제목 '새 계획 제안', 리포트에서 나온 계획만 앞에", async () => {
    renderApp("/recommendations", "bob");
    expect(await screen.findByRole("heading", { name: "새 계획 제안" })).toBeTruthy();
    const list = await screen.findByRole("list", { name: "추천 목록" });
    expect(within(list).getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("button", { name: /다른 계획 2개/ })).toBeTruthy();
  });

  it("넣을 돈(% 칩) → 이 금액으로 사는 수량·금액(장마감 기준) → 체크 셋을 모두 켜야 '모의 자동매매 시작'(acknowledged: true, 금액은 하나만)", async () => {
    freezeTime(TUE_MORNING);
    const seen = recordBodies("/activate");
    renderApp("/recommendations/91", "bob");
    expect(await screen.findByRole("heading", { name: "SK하이닉스 계획 제안" })).toBeTruthy();
    expect(screen.getByText("AI는 제안만 해요. 넣을 돈은 내가 정하고, 모의 자동매매를 시작할 수 있는지는 안전장치가 확인해요.")).toBeTruthy();
    expect(await screen.findByText("시작할 수 있음")).toBeTruthy(); // 머리 칩 = 금액 없는 안전장치 미리 보기 결과
    // 기본값 없음: 정하기 전에는 빈 상태·확인 칸 없음·꺼진 시작 버튼과 안내. 언제 사는지는 미리 보인다
    expect(screen.getByText("얼마를 넣을까요?")).toBeTruthy();
    const box = screen.getByRole("region", { name: "이 금액으로 사는 수량" });
    expect(within(box).getByText("금액을 정하면 몇 주를 사는지 보여 드려요.")).toBeTruthy();
    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("넣을 돈을 먼저 정해 주세요.")).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText(/181,000원 이하가 될 때까지 .+까지만 기다려요/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    expect(await within(box).findByText(/^이 금액으로 5주 · 905,000원$/, undefined, { timeout: 3000 })).toBeTruthy();
    expect(within(box).getByText(KR_ASOF)).toBeTruthy();
    expect(within(box).getByText(/^\(내 자산의 0\.\d+%\)$/)).toBeTruthy();
    expect(within(box).getByText(/^내가 정한 금액으로 계산했어요\. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요\.$/)).toBeTruthy();
    expect(screen.queryByText("넣을 돈을 먼저 정해 주세요.")).toBeNull();

    const checks = screen.getAllByRole("checkbox");
    expect(checks).toHaveLength(3);
    expect(screen.getByLabelText(/^손절 가격\(173,000원\)에 팔리면 약 [\d,]+원을 잃어요/)).toBeTruthy();
    expect(screen.getByLabelText(/^산 뒤 최대 10거래일 보유해요/)).toBeTruthy();
    expect(screen.getByLabelText("AI의 제안이며, 실제 돈이 아닌 모의 투자예요.")).toBeTruthy();
    fireEvent.click(checks[0]);
    fireEvent.click(checks[1]);
    expect(start.disabled).toBe(true);
    fireEvent.click(checks[2]);
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    expect(await screen.findByRole("heading", { name: "SK하이닉스 모의 자동매매" })).toBeTruthy();
    server.events.removeAllListeners();
    expect(seen).toEqual([{ budgetPercent: 10, acknowledged: true }]);
    const steps = screen.getByRole("list", { name: "모의 자동매매 단계" });
    expect(within(steps).getByText("사는 가격 기다리는 중").closest("li")?.getAttribute("aria-current")).toBe("step");
    const events = screen.getByRole("list", { name: "계획 사건" });
    expect(within(events).getByText(/^모의 계좌에서 181,000원 이하에 5주를 사는 주문을 넣었어요$/)).toBeTruthy();
    expect(within(events).getByText(/^모의 자동매매를 시작했어요 \(넣은 돈: 내 자금의 10% · [\d,]+원\)$/)).toBeTruthy();
  });

  it("넣을 돈을 바꿔 금액이 바뀌면 체크를 다시 해야 한다", async () => {
    renderApp("/recommendations/91", "bob");
    const box = await screen.findByRole("region", { name: "이 금액으로 사는 수량" });
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    await within(box).findByText(/^이 금액으로 5주/, undefined, { timeout: 3000 });
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    await waitFor(() => expect(within(box).getByText(/이 금액으로 14주/)).toBeTruthy(), { timeout: 3000 });
    await waitFor(() => expect(screen.getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked)).toBe(true));
    expect(start.disabled).toBe(true);
    // 말없이 지워지면 '고장'으로 읽힌다: 왜 지워졌는지 한 번 알린다 (trade-16)
    expect(screen.getByText(/^금액이 바뀌어 다시 확인해 주세요 · 손절 시 약 [\d,]+원 → [\d,]+원$/)).toBeTruthy();
  });

  it("금액이 처음 값으로 돌아와도(A → B → A) 체크는 다시 해야 하고, 금액을 지우면 다시 '먼저 정해 주세요'", async () => {
    renderApp("/recommendations/91", "bob");
    const box = await screen.findByRole("region", { name: "이 금액으로 사는 수량" });
    const input = (await screen.findByLabelText("직접 입력 (%)")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "10" } });
    expect(screen.getByRole("button", { name: "10%" }).getAttribute("aria-pressed")).toBe("true"); // 칩은 입력 칸과 같은 값
    const first = (await within(box).findByText(/^이 금액으로/, undefined, { timeout: 3000 })).textContent ?? "";
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.change(input, { target: { value: "25" } });
    await waitFor(() => expect(within(box).getByText(/이 금액으로 14주/)).toBeTruthy(), { timeout: 3000 });
    fireEvent.change(input, { target: { value: "10" } });
    await waitFor(() => expect(within(box).getByText(/^이 금액으로/).textContent).toBe(first), { timeout: 3000 });
    await waitFor(() => expect(box.getAttribute("aria-busy")).toBe("false"), { timeout: 3000 });
    expect(screen.getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    expect(start.disabled).toBe(true);
    expect(screen.getByText("위의 확인 셋을 모두 켜면 시작할 수 있어요.")).toBeTruthy();
    // 처음 금액으로 돌아왔으면 'A → A' 같은 안내는 남기지 않는다
    expect(screen.queryByText(/^금액이 바뀌어 다시 확인해 주세요/)).toBeNull();
    // 지우면 정하기 전으로 (확인 칸·미리 보기가 사라지고 버튼 아래 안내)
    fireEvent.change(input, { target: { value: "" } });
    expect(within(box).getByText("금액을 정하면 몇 주를 사는지 보여 드려요.")).toBeTruthy();
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.getByText("넣을 돈을 먼저 정해 주세요.")).toBeTruthy();
    // 범위 밖 %는 입력 아래 오류 (요청을 보내지 않는다)
    fireEvent.change(input, { target: { value: "150" } });
    expect(screen.getByText("1~100 사이의 정수로 입력해 주세요.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(start.disabled).toBe(true);
  });

  it("'금액이 바뀌어 다시 확인' 안내가 떠 있는 채로 금액이 또 바뀌면 안내도 지금 금액으로 (확인한 금액 → 지금 금액)", async () => {
    renderApp("/recommendations/91", "bob");
    const box = await screen.findByRole("region", { name: "이 금액으로 사는 수량" });
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    // 미리 보기가 처음 도착한 것은 '바뀐 금액'이 아니다 → 중립 강조 없음. 넣을 돈을 바꾼 뒤에만 강조
    expect((await within(box).findByText(/^이 금액으로/, undefined, { timeout: 3000 })).className).not.toContain("animate-flash-neutral");
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    fireEvent.click(screen.getByRole("button", { name: "25%" }));
    await waitFor(() => expect(within(box).getByText(/이 금액으로 14주/)).toBeTruthy(), { timeout: 3000 });
    expect(within(box).getByText(/이 금액으로 14주/).className).toContain("animate-flash-neutral"); // 방향 없는 중립 강조 (파랑·빨강 아님)
    expect(within(box).getByText(/이 금액으로 14주/).className).not.toMatch(/animate-flash-(up|down)/);
    const [, from, second] = screen.getByText(/^금액이 바뀌어 다시 확인해 주세요/).textContent!.match(/약 ([\d,]+원) → ([\d,]+원)$/)!;
    fireEvent.change(screen.getByLabelText("직접 입력 (%)"), { target: { value: "15" } });
    await waitFor(() => expect(within(box).getByText(/이 금액으로 8주/)).toBeTruthy(), { timeout: 3000 });
    const note = screen.getByText(/^금액이 바뀌어 다시 확인해 주세요/).textContent!;
    expect(note).toContain(`약 ${from} → `);
    expect(note).not.toContain(`→ ${second}`);
  });

  it("넣을 돈이 한도를 넘으면 줄이지 않고 계획 문장으로 막는다 — 입력은 그대로 고칠 수 있다 (cash_short·total_limit)", async () => {
    renderApp("/recommendations/91", "bob");
    fireEvent.click(await screen.findByRole("button", { name: "금액(원)" }));
    const amount = screen.getByLabelText("넣을 금액 (원)") as HTMLInputElement;
    expect(amount.value).toBe("");
    fireEvent.change(amount, { target: { value: "20,000,000" } });
    const reasons = await screen.findByRole("list", { name: "시작할 수 없는 이유" }, { timeout: 3000 });
    expect(within(reasons).getByText("넣을 돈이 매수 가능 금액보다 많아요")).toBeTruthy();
    expect(within(reasons).getByText("모의 자동매매에 넣을 수 있는 총 금액 한도를 넘어요")).toBeTruthy();
    expect(screen.getByText("위에서 넣을 돈을 바꾸면 다시 계산해요.")).toBeTruthy();
    expect(screen.getByText(/^매수 가능 금액 [\d,]+원 중 20,000,000원 \(\d+\.\d%\)$/)).toBeTruthy();
    expect(amount.value).toBe("20,000,000");
    expect((screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: /다른 계획 제안 보기/ })).toBeNull();
    // 같은 사유 코드라도 장기 매수 주문 화면의 문장은 그대로다 (lib/plainText.ts ReasonContext)
    expect(screen.queryByText("매수 가능 금액보다 사려는 금액이 커요")).toBeNull();
    // 막혔을 때는 사유 상자가 말한다 — 손실 경고('막지 않는다')를 같이 보이지 않는다
    expect(screen.queryByText(/^손절되면 내 자산의/)).toBeNull();
  });

  it("손절 시 손실이 내 자산의 1%를 넘으면 경고 한 줄 — 막지 않는다 (largeLoss)", async () => {
    renderApp("/recommendations/91", "bob");
    fireEvent.click(await screen.findByRole("button", { name: "25%" }));
    expect(
      await screen.findByText(/^손절되면 내 자산의 1\.\d%를 잃어요\. 안전장치 기준\(1%\)보다 커요\. 금액을 줄이면 손실도 줄어요\.$/, undefined, { timeout: 3000 }),
    ).toBeTruthy();
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    await waitFor(() => expect((screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement).disabled).toBe(false));
    // 금액을 줄이면 경고가 사라진다
    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    await waitFor(() => expect(screen.queryByText(/^손절되면 내 자산의/)).toBeNull(), { timeout: 3000 });
  });

  it("장이 닫혀 있으면 다음 장 시작 안내 (opensAt)", async () => {
    freezeTime("2026-10-06T18:00:00+09:00", { marketOpen: {} });
    renderApp("/recommendations/91", "bob");
    expect(await screen.findByText("지금은 장이 닫혀 있어요. 10월 7일(수) 오전 9시에 장이 열리면 사는 가격을 확인해요")).toBeTruthy();
  });

  it("시작할 수 없으면 사유 코드의 쉬운 문장 (중단 스위치)", async () => {
    db.options.halted = true;
    renderApp("/recommendations/93", "bob");
    const reasons = await screen.findByRole("list", { name: "시작할 수 없는 이유" });
    expect(within(reasons).getByText("지금은 새 모의 매수를 멈춰 두었어요")).toBeTruthy();
    // 시작할 수 없으면 넣을 돈·확인 칸·시작 버튼 대신 이유와 '다른 계획 제안 보기' (UX-2). 머리 칩도 같은 말을 한다 (기한이 남았다고 '시작할 수 있음'이라 하지 않는다)
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "넣을 돈 정하는 방식" })).toBeNull();
    expect(screen.queryByRole("button", { name: "모의 자동매매 시작" })).toBeNull();
    expect(screen.getByRole("link", { name: /다른 계획 제안 보기/ }).getAttribute("href")).toBe("/recommendations");
    expect(await screen.findByText("지금은 시작할 수 없음")).toBeTruthy();
    expect(screen.queryByText("시작할 수 있음")).toBeNull();
  });

  it("활성화 400(장중 확인 price_passed)은 쉬운 문장으로", async () => {
    renderApp("/recommendations/91", "bob");
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    await within(await screen.findByRole("region", { name: "이 금액으로 사는 수량" })).findByText(/^이 금액으로/, undefined, { timeout: 3000 });
    // 미리 보기를 본 뒤 장중 가격이 목표가(203,000원)를 넘었다 — 활성화의 장중 확인이 막는다
    db.setPrice("000660", 210_000);
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    const alert = await screen.findByText("지금은 시작할 수 없어요");
    expect(within(alert.closest("[role=alert]") as HTMLElement).getByText("가격이 이미 목표 가격을 넘었거나 손절 가격 아래로 내려왔어요")).toBeTruthy();
  });
});

describe("모의 자동매매 상세 (쉬운 보기)", () => {
  it("체결 대기 중 멈추기: 대화상자 문구 → 쉬운 문장 토스트", async () => {
    const plan = db.activate(userOf("bob"), 91, { budgetPercent: 10, acknowledged: true });
    renderApp(`/plans/${plan.id}`, "bob");
    expect(await screen.findByRole("heading", { name: "SK하이닉스 모의 자동매매" })).toBeTruthy();
    expect(screen.getByText("사는 가격 이하가 되면 모의 계좌에서 사요")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "멈추기" }));
    const dialog = screen.getByRole("dialog", { name: "SK하이닉스 모의 자동매매를 멈출까요?" });
    expect(within(dialog).getByText(/사는 주문을 취소하고 끝낼까요\? 아직 산 주식이 없어서 돈은 그대로예요/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "멈추기" }));
    await waitFor(() => expect(toast().textContent).toBe("내가 모의 자동매매를 멈췄어요"));
    expect(screen.getByRole("note").textContent).toBe("내가 모의 자동매매를 멈췄어요");
  });

  it("보유 중 멈추기는 '지금 가지고 있는 ○주를 모두 팔고 끝낼까요?'", async () => {
    const plan = db.activate(userOf("bob"), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000); // 진입가 아래 → 지정가 체결
    renderApp(`/plans/${plan.id}`, "bob");
    await screen.findByText("목표·손절을 지켜보는 중", { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: "멈추기" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(`지금 가지고 있는 ${plan.quantity}주를 모두 팔고 끝낼까요? 장이 닫혀 있으면 다음 장 시작(오전 9시)에 팔아요.`),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "모두 팔고 멈추기" }));
    await waitFor(() => expect(screen.getByRole("note").textContent).toContain("멈추기로 모의 계좌에서 팔았어요"));
  });

  it("진행 중: 도는 스피너 대신 차분한 점과 알림 약속, 가격 사다리와 '사는 가격까지 얼마나' (지금 가격 기준 · 실시간)", async () => {
    const plan = db.activate(userOf("bob"), 91, { budgetPercent: 10 });
    renderApp(`/plans/${plan.id}`, "bob");
    expect(await screen.findByText("자동으로 새로 받아요 · 단계가 바뀌면 알림으로 알려 드려요")).toBeTruthy();
    expect(screen.queryByText(/5초마다/)).toBeNull(); // 구현 세부는 title로만
    const ladder = screen.getByRole("figure", { name: "가격 사다리" });
    expect(await screen.findByText(/^사는 가격까지 -\d+\.\d%/)).toBeTruthy();
    expect(screen.getByText("· 지금 가격 기준")).toBeTruthy();
    expect(within(ladder).getByText(/^지금 가격 /)).toBeTruthy(); // 사다리 말풍선
    expect(screen.getByText(LIVE_ASOF)).toBeTruthy();
    // 멈추기는 이동 링크와 구분선으로 떨어져 있고, 누르면 무엇이 일어나는지 한 줄로 먼저 말한다
    expect(screen.getByText("멈추면 사는 주문을 취소해요. 돈은 그대로예요.")).toBeTruthy();
  });

  it("끝난 계획: 단계 모두 완료(과거형) + 쉬운 결과, 다음 행동은 '새 계획 제안 보기'. 전문가 보기는 청산 사유 표 이름", async () => {
    const easy = renderApp("/plans/95?view=easy");
    const steps = await screen.findByRole("list", { name: "모의 자동매매 단계" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    expect(within(steps).getByText("샀어요")).toBeTruthy();
    expect(within(steps).getByText("목표·손절 지켜봤어요")).toBeTruthy();
    expect((await screen.findByRole("link", { name: /새 계획 제안 보기/ })).getAttribute("href")).toBe("/recommendations");
    expect(screen.getByRole("note").textContent).toBe("목표 가격에 닿아 모의 계좌에서 팔았어요 · 손익 +102,850원");
    easy.unmount();

    renderApp("/plans/95");
    await waitFor(() => expect(screen.getAllByRole("note").some((n) => n.textContent?.includes("청산 완료 · 목표가 도달"))).toBe(true));
  });
});

describe("AI 교차검증 분석 (두 모드 모두 과정을 보인다)", () => {
  it("쉬운 보기: 과정 한 줄 + 제안 AI별 카드(통과·탈락), 점수·확률 없음, 뉴스 매체·시각·출처, 자료 기준일", async () => {
    freezeTime(TUE_MORNING); // 뉴스 시각은 올해면 연도를 빼고 보인다 — 1월 초에 작년 뉴스가 되어 깨지지 않게
    renderApp("/analyses/5", "bob");
    expect(await screen.findByRole("heading", { name: "에코프로비엠 AI 교차검증 분석" })).toBeTruthy();
    // 쉬운 보기는 제안 AI 이름을 Claude·GPT·Gemini로 (문장·카드·칩이 같은 표기)
    expect(screen.getByText("AI 세 곳이 각자 계획을 내고 서로 검증했어요 · 통과 2 · 최종 승인 Claude")).toBeTruthy();
    const claude = screen.getByRole("article", { name: "Claude 계획" });
    expect(within(claude).getByText("최종 승인")).toBeTruthy();
    expect(within(claude).getByText("사는 가격")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "Gemini 계획" })).getByText("탈락")).toBeTruthy();
    // 지표는 한국어 이름(눌러서 풀이), 원래 키는 보이지 않는다
    const ind = screen.getByRole("region", { name: "지표" });
    expect(within(ind).getByRole("button", { name: "RSI(14일)" })).toBeTruthy();
    expect(within(ind).queryByText("rsi14")).toBeNull();
    expect(screen.queryByText(/확률/)).toBeNull(); // 점수·확률은 전문가 보기에서만
    const news = screen.getByRole("list", { name: "뉴스 목록" });
    expect(within(news).getAllByRole("listitem")[0].textContent).toMatch(/연합뉴스 · \d{2}\.\d{2} \d{2}:\d{2}$/);
    expect(screen.getByText("출처: Google 뉴스 검색 결과 (각 언론사). 제목만 보여요.")).toBeTruthy();
    expect(screen.getByText(/분석 시각 가격.* · 지표·일봉 자료 기준일 \d+월 \d+일\(.\)/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "종목 화면으로" })).toBeTruthy();
  });

  it("종가를 받지 못하면 위쪽 큰 가격에 '분석 시각 가격'이라고 밝힌다 (장마감 종가로 읽히지 않게)", async () => {
    freezeTime(TUE_MORNING);
    server.use(http.get("*/api/quotes", () => HttpResponse.json({ detail: "증권사 조회 불가" }, { status: 503 })));
    renderApp("/analyses/5");
    const a = db.getAnalysis(5);
    expect(await screen.findByRole("heading", { name: "에코프로비엠 AI 교차검증 분석" })).toBeTruthy();
    const big = await screen.findByText(formatPrice(a.priceAtAnalysis, a.currency), { selector: "span.text-\\[26px\\]" });
    expect(big.parentElement?.textContent).toMatch(/^분석 시각 가격/);
    expect(big.parentElement?.textContent).not.toContain("종가");
  });

  it("전문가 보기: 같은 과정 + 점수·확률, 주문 바로가기", async () => {
    renderApp("/analyses/5");
    expect(await screen.findByText("AI 세 곳이 각자 계획을 내고 서로 검증했어요 · 통과 2 · 최종 승인 claude")).toBeTruthy();
    expect(screen.getAllByText(/확률/).length).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: "이 종목 주문하기" })).toBeTruthy();
    expect(await screen.findByText(LIVE_ASOF)).toBeTruthy(); // 위쪽 현재가 (분석의 가격은 "분석 시각 가격")
    expect(screen.getByText("현재가")).toBeTruthy();
    expect(screen.getByText(/^분석 시각 가격/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "지표" })).getByText("rsi14")).toBeTruthy(); // 진단용 원래 키
  });

  it("계획이 없을 뿐인 분석은 쉬운 보기에서 빨간 '오류'로 보이지 않고, 계획이 0개라는 같은 뜻의 줄을 '참고'에 또 적지 않는다 (전문가 보기는 원문)", async () => {
    const empty = db.listAnalyses(null, null).find((a) => a.scenarioCount === 0)!;
    const [note] = db.getAnalysis(empty.id).errors; // 가짜 데이터의 '제안 모델이 조건에 맞는 시나리오를 내지 않았습니다.'
    expect(note).toMatch(/시나리오를 내지 않았/);
    const easy = renderApp(`/analyses/${empty.id}`, "bob");
    // 계획이 없다는 말은 과정 카드 한 번만 ('AI별 계획 0개' 묶음·'참고'의 같은 뜻 줄로 두 번 하지 않는다)
    expect(await screen.findByText("AI가 낸 계획이 없어요 (조건에 맞는 계획이 없었어요)")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: /AI별 계획/ })).toBeNull();
    expect(screen.queryByText("조건에 맞는 계획이 없었어요.")).toBeNull();
    expect(screen.queryByText("분석 중 오류")).toBeNull();
    expect(screen.queryByRole("region", { name: "오류" })).toBeNull();
    expect(screen.queryByRole("region", { name: "참고" })).toBeNull();
    expect(screen.queryByText(note)).toBeNull();
    easy.unmount();
    renderApp(`/analyses/${empty.id}`);
    expect(await screen.findByText("분석 중 오류")).toBeTruthy();
    expect(screen.getByText(note)).toBeTruthy(); // 진단용 원문 그대로
    expect(screen.queryByRole("heading", { name: /^시나리오 \d+개$/ })).toBeNull();
  });

  it("계획이 0개라는 줄만 쉬운 보기에서 빠지고, 같이 온 장애 줄은 '참고'에 남는다 (전문가 보기는 둘 다 원문)", async () => {
    const note = "제안 모델이 조건에 맞는 시나리오를 내지 않았습니다.";
    const errors = [note, "gpt 웹 조사 실패: timeout"];
    const a = { ...db.getAnalysis(5), verdict: "PASS" as const, best: null, scenarioCount: 0, scenarios: [], errors };
    server.use(http.get("*/api/analyses/:id", ({ params }) => (Number(params.id) === 5 ? HttpResponse.json(a) : undefined)));
    const easy = renderApp("/analyses/5", "bob");
    expect(await screen.findByText("AI가 낸 계획이 없어요 (조건에 맞는 계획이 없었어요)")).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "참고" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "GPT: 응답하지 못해 웹 조사를 하지 못했어요",
    ]);
    easy.unmount();
    renderApp("/analyses/5");
    expect(await screen.findByText("분석 중 오류")).toBeTruthy();
    for (const e of errors) expect(screen.getByText(e)).toBeTruthy();
  });

  it("제안 AI가 응답하지 못해 계획이 없으면 쉬운 보기도 숨기지 않는다: 과정 문장이 그 사실을 말하고 '참고'에 쉬운 문장 (전문가 보기는 원문)", async () => {
    // 엔진 문구 그대로 (engine/paper_engine/pipeline.py "{모델} 시나리오 제안 실패: …")
    const errors = ["claude 시나리오 제안 실패: HTTP 503: upstream", "gpt 시나리오 제안 실패: 응답 형식 오류", "gemini 시나리오 제안 실패: 429 quota"];
    const a = { ...db.getAnalysis(5), verdict: "PASS" as const, best: null, scenarioCount: 0, scenarios: [], errors };
    server.use(http.get("*/api/analyses/:id", ({ params }) => (Number(params.id) === 5 ? HttpResponse.json(a) : undefined)));
    const easy = renderApp("/analyses/5", "bob");
    expect(await screen.findByText("AI가 낸 계획이 없어요 (AI 세 곳이 응답하지 못했어요)")).toBeTruthy();
    expect(screen.queryByText(/조건에 맞는 계획이 없었어요/)).toBeNull(); // 장애를 조건 탓으로 말하지 않는다
    expect(within(screen.getByRole("region", { name: "참고" })).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Claude: 응답하지 못해 계획을 내지 못했어요",
      "GPT: 응답하지 못해 계획을 내지 못했어요",
      "Gemini: 응답하지 못해 계획을 내지 못했어요",
    ]);
    expect(screen.queryByText("분석 중 오류")).toBeNull();
    easy.unmount();
    renderApp("/analyses/5");
    expect(await screen.findByText("분석 중 오류")).toBeTruthy();
    for (const e of errors) expect(screen.getByText(e)).toBeTruthy();
    expect(screen.getByText("AI가 낸 계획이 없어요 (AI 세 곳이 응답하지 못했어요)")).toBeTruthy();
  });

  it("쉬운 보기 지표는 엔진 스냅샷의 키(sma20·change5d…)를 한국어 이름과 가격·% 모양으로, 전문가 보기는 원래 키와 숫자 그대로", async () => {
    // 실제 분석의 지표 = 엔진 스냅샷 그대로 (engine/paper_engine/data/snapshot.py, docs/API.md). 비율은 소수로 온다
    const indicators = {
      sma20: 71_250,
      sma60: 69_800,
      sma120: 66_000,
      rsi14: 58.21,
      atr14: 1_850.25,
      volatility20: 0.3123,
      change5d: 0.0214,
      change20d: -0.05,
      change60d: 0.1,
      periodHigh: 78_900,
      periodLow: 54_300,
    };
    server.use(http.get("*/api/analyses/:id", ({ params }) => (Number(params.id) === 5 ? HttpResponse.json({ ...db.getAnalysis(5), indicators }) : undefined)));
    const rows = async () => {
      const ind = await screen.findByRole("region", { name: "지표" });
      return [...ind.querySelectorAll("dl > div")].map((d) => `${d.querySelector("dt")?.textContent} ${d.querySelector("dd")?.textContent}`);
    };
    const easy = renderApp("/analyses/5", "bob");
    expect(await rows()).toEqual([
      "20일 평균 가격 71,250원",
      "60일 평균 가격 69,800원",
      "120일 평균 가격 66,000원",
      "RSI(14일) 58.21",
      "하루 변동폭(ATR) 1,850원",
      "20일 변동성(1년 환산) 31.2%",
      "5일 등락률 +2.1%",
      "20일 등락률 -5.0%",
      "60일 등락률 +10.0%",
      "기간 최고 가격 78,900원",
      "기간 최저 가격 54,300원",
    ]);
    expect(within(screen.getByRole("region", { name: "지표" })).getByRole("button", { name: "20일 평균 가격" })).toBeTruthy(); // 눌러서 이동평균 풀이
    easy.unmount();
    renderApp("/analyses/5");
    const expert = await rows();
    expect(expert).toHaveLength(11);
    expect(expert[0]).toBe("sma20 71,250");
    expect(expert[5]).toBe("volatility20 0.312");
  });

  it("없는 분석·숫자가 아닌 주소는 기다리지 않고 '찾을 수 없음'과 목록으로 가는 길", async () => {
    renderApp("/analyses/abc");
    expect(await screen.findByText("분석을 찾을 수 없습니다.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "교차검증 분석 목록으로" }).getAttribute("href")).toBe("/reports?list=analyses");
    renderApp("/analyses/9999", "bob");
    expect(await screen.findByText("분석을 찾을 수 없어요")).toBeTruthy();
  });

  it("분석 카드: 쉬운 보기는 분석 상세로, 전문가 보기는 종목 주문으로 (가격은 현재가 + 받은 시각, 못 받은 종목은 종가 + 장마감 기준)", async () => {
    freezeTime(TUE_MORNING);
    db.setSession("alice");
    const a = db.listAnalyses("005930", null)[0];
    const quote = db.quotes(["005930"])[0];
    const wrap = (view: "easy" | "expert") =>
      render(
        <MemoryRouter>
          <Providers client={createQueryClient({ retry: false })}>
            <AnalysisCard a={a} quote={quote} view={view} />
          </Providers>
        </MemoryRouter>,
      );
    const easy = wrap("easy");
    expect(easy.getByRole("link").getAttribute("href")).toBe(`/analyses/${a.id}`);
    expect(easy.getByText("통과한 계획 있음")).toBeTruthy();
    expect(quote.basis).toBe("live");
    expect(easy.getByText(LIVE_ASOF)).toBeTruthy();
    expect(easy.getByText("지금 가격")).toBeTruthy();
    expect(easy.queryByText(/점수/)).toBeNull();
    easy.unmount();
    const expert = wrap("expert");
    expect(expert.getByRole("link").getAttribute("href")).toBe(`/stocks/005930?analysis=${a.id}`);
    expect(expert.getByText("매수")).toBeTruthy();
    expect(expert.getByText("현재가")).toBeTruthy();
    expert.unmount();
  });

  it("분석 카드: 현재가를 받지 못한 종목(basis close)은 종가와 '장마감 기준' 시각 그대로", () => {
    freezeTime(TUE_MORNING);
    db.setSession("alice");
    const a = db.listAnalyses("005930", null)[0];
    const quote = { ...db.quotes(["005930"])[0], asOf: "2026-10-05T15:30:00+09:00", basis: "close" as const };
    const view = render(
      <MemoryRouter>
        <Providers client={createQueryClient({ retry: false })}>
          <AnalysisCard a={a} quote={quote} view="expert" />
        </Providers>
      </MemoryRouter>,
    );
    expect(view.getByText("종가")).toBeTruthy();
    expect(view.getByText(KR_ASOF)).toBeTruthy();
    expect(view.queryByText(/^실시간/)).toBeNull();
  });

  it("계획이 0개인 분석의 카드·종목 화면 요약은 까닭을 단정하지 않는다 (목록 응답에는 오류가 없다 — 까닭은 분석 상세의 과정 카드가 말한다)", async () => {
    db.setSession("alice");
    const a = db.listAnalyses("AAPL", null)[0];
    expect(a.scenarioCount).toBe(0);
    const wrap = (view: "easy" | "expert") =>
      render(
        <MemoryRouter>
          <Providers client={createQueryClient({ retry: false })}>
            <AnalysisCard a={a} view={view} />
          </Providers>
        </MemoryRouter>,
      );
    const easy = wrap("easy");
    expect(easy.getByText("AI가 낸 계획이 없어요.")).toBeTruthy();
    expect(easy.queryByText(/조건에 맞는/)).toBeNull();
    easy.unmount();
    const expert = wrap("expert");
    expect(expert.getByText("제안된 계획이 없어요.")).toBeTruthy();
    expect(expert.queryByText(/조건에 맞는/)).toBeNull();
    expert.unmount();
    renderApp("/stocks/AAPL", "bob");
    const latest = await screen.findByRole("link", { name: /최근 교차검증 분석/ });
    expect(within(latest).getByText("AI가 낸 계획이 없어요.")).toBeTruthy();
    expect(within(latest).queryByText(/조건에 맞는/)).toBeNull();
  });
});

describe("검색", () => {
  // 최근 본 종목은 localStorage에 둔다. Node의 localStorage는 쓸 수 없을 수 있어 테스트마다 메모리 저장소로 바꿔 끼운다
  beforeEach(() => {
    const m = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      get length() {
        return m.size;
      },
      clear: () => m.clear(),
      getItem: (k: string) => m.get(k) ?? null,
      key: (i: number) => [...m.keys()][i] ?? null,
      removeItem: (k: string) => void m.delete(k),
      setItem: (k: string, v: string) => void m.set(k, String(v)),
    } satisfies Storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("결과 위에 '가격은 실시간이에요'와 받은 시각 한 줄", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/search?q=삼성");
    const basis = await screen.findByLabelText("가격 기준");
    expect(within(basis).getByText("가격은 실시간이에요")).toBeTruthy();
    expect(within(basis).getAllByText(LIVE_ASOF)).toHaveLength(1); // 종목마다 받은 시각이 달라도 가장 늦은 시각 하나
    expect(within(basis).queryByText(/장마감 기준/)).toBeNull();
    expect(within(screen.getByRole("region", { name: "검색 결과" })).getAllByText("현재가").length).toBeGreaterThan(0); // 화면 읽기용 이름
  });

  it("현재가를 받지 못한 종목이 섞이면 그 종목의 시장별 장마감 기준 시각을 함께 보인다", async () => {
    freezeTime(TUE_MORNING);
    server.use(
      http.get("*/api/quotes", ({ request }) => {
        const symbols = (new URL(request.url).searchParams.get("symbols") ?? "").split(",").filter(Boolean);
        const quotes = db.quotes(symbols).map((q, i) => (i === 0 ? { ...q, asOf: "2026-10-05T15:30:00+09:00", basis: "close" as const } : q));
        return HttpResponse.json({ quotes, asOf: new Date().toISOString() });
      }),
    );
    renderApp("/search?q=에코프로"); // 에코프로비엠·에코프로 두 종목 — 첫째만 현재가를 받지 못했다
    const basis = await screen.findByLabelText("가격 기준");
    expect(within(basis).getByText("가격은 실시간이에요 (받지 못한 종목은 직전 장마감 종가)")).toBeTruthy();
    expect(within(basis).getByText(KR_ASOF)).toBeTruthy();
    expect(within(basis).getByText(LIVE_ASOF)).toBeTruthy();
  });

  it("검색어는 주소(?q=)에 남아 — 종목을 열었다가 뒤로 와도 검색어와 결과가 그대로다", async () => {
    renderApp("/search");
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "현대" } });
    await screen.findByText(/^검색 결과 \d+개$/); // 디바운스 뒤 결과가 온 다음
    fireEvent.click(within(screen.getByRole("region", { name: "검색 결과" })).getByRole("link", { name: /현대차/ }));
    expect(await screen.findByRole("heading", { name: "현대차" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "뒤로 가기" }));
    expect(((await screen.findByRole("searchbox")) as HTMLInputElement).value).toBe("현대");
    expect(await within(screen.getByRole("region", { name: "검색 결과" })).findByRole("link", { name: /현대차/ })).toBeTruthy();
  });

  it("결과 개수를 화면 읽기에 알리고(aria-live), 없으면 철자·코드 안내", async () => {
    renderApp("/search");
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "현대" } });
    expect(await screen.findByText(/^검색 결과 \d+개$/)).toBeTruthy();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "zzzz" } });
    expect(await screen.findByText('"zzzz"에 맞는 종목이 없어요')).toBeTruthy();
    expect(screen.getByText("철자를 확인하거나 종목코드 6자리·영문 티커로 찾아보세요.")).toBeTruthy();
    expect(screen.getByText("맞는 종목이 없어요")).toBeTruthy();
  });

  it("검색칸 이름은 지우기 버튼이 보여도 '종목명 또는 종목코드' 그대로다 (버튼 이름이 섞이지 않게)", async () => {
    renderApp("/search?q=삼성");
    const clear = await screen.findByRole("button", { name: "검색어 지우기" });
    expect(screen.getByRole("searchbox", { name: "종목명 또는 종목코드" })).toBeTruthy();
    // Chrome은 label 안 버튼의 이름까지 검색칸 이름에 붙인다 (jsdom은 붙이지 않아 구조로 확인한다)
    expect(clear.closest("label")).toBeNull();
  });

  it("Enter(키보드 '검색')는 맞는 종목이 하나뿐이면 바로 그 종목으로 간다", async () => {
    renderApp("/search");
    fireEvent.change(await screen.findByRole("searchbox"), { target: { value: "005380" } });
    fireEvent.submit(screen.getByRole("search"));
    expect(await screen.findByRole("heading", { name: "현대차" })).toBeTruthy();
  });

  it("검색어가 없으면 바로가기: 최근 본 종목(지우기)·내 보유 종목. 탭의 첫 화면이라 뒤로 가기가 없다", async () => {
    renderApp("/stocks/005380");
    await screen.findByRole("heading", { name: "현대차" });
    // 이 기기에만, 계정마다 따로 (키에 사용자 id)
    expect(JSON.parse(localStorage.getItem(recentStocksKey(db.sessionUser()!.id)) ?? "[]")).toEqual([{ symbol: "005380", name: "현대차" }]);
    fireEvent.click(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("link", { name: "종목" }));
    const recent = await screen.findByRole("region", { name: "최근 본 종목" });
    expect(within(recent).getByRole("link", { name: "현대차" }).getAttribute("href")).toBe("/stocks/005380");
    const held = await screen.findByRole("region", { name: "내 보유 종목" });
    expect(within(held).getByRole("link", { name: /삼성전자/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "뒤로 가기" })).toBeNull();
    fireEvent.click(within(recent).getByRole("button", { name: "지우기" }));
    expect(screen.queryByRole("region", { name: "최근 본 종목" })).toBeNull();
  });

  it("최근 본 종목은 계정마다 따로 — 같은 기기에서 다른 계정으로 들어오면 앞 사람이 본 종목이 보이지 않는다", async () => {
    const alice = renderApp("/stocks/196170");
    await screen.findByRole("heading", { name: "알테오젠" });
    alice.unmount(); // 로그아웃 → 같은 기기에서 밥으로 로그인
    const bob = renderApp("/search", "bob");
    await screen.findByRole("searchbox");
    expect(screen.queryByRole("region", { name: "최근 본 종목" })).toBeNull();
    expect(screen.queryByRole("link", { name: "알테오젠" })).toBeNull();
    bob.unmount();
    renderApp("/search"); // 앨리스의 기록은 그대로
    const recent = await screen.findByRole("region", { name: "최근 본 종목" });
    expect(within(recent).getByRole("link", { name: "알테오젠" })).toBeTruthy();
  });

  it("'지우기'를 누르면 포커스가 다음 묶음 제목으로 옮겨 가고(사라진 버튼과 함께 길을 잃지 않게) 지운 것을 알린다", async () => {
    const first = renderApp("/stocks/005380");
    await screen.findByRole("heading", { name: "현대차" });
    first.unmount();
    renderApp("/search");
    const recent = await screen.findByRole("region", { name: "최근 본 종목" });
    await screen.findByRole("region", { name: "내 보유 종목" });
    const clear = within(recent).getByRole("button", { name: "지우기" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole("region", { name: "최근 본 종목" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "내 보유 종목" }));
    expect(within(toast()).getByText("최근 본 종목을 지웠어요")).toBeTruthy();
  });

  it("'지우기' 뒤 남은 바로가기 묶음이 없으면 포커스는 검색칸으로", async () => {
    server.use(http.get("*/api/reports", () => HttpResponse.json({ count: 0, results: [] }))); // 오늘 팀 리포트 없음
    const first = renderApp("/stocks/005380", "carol"); // 보유 없음
    await screen.findByRole("heading", { name: "현대차" });
    first.unmount();
    renderApp("/search", "carol");
    const clear = within(await screen.findByRole("region", { name: "최근 본 종목" })).getByRole("button", { name: "지우기" });
    clear.focus();
    fireEvent.click(clear);
    expect(screen.queryByRole("region", { name: "최근 본 종목" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("searchbox"));
  });
});

// ---------------------------------------------------------------- 매매 계획 카드

function renderCard(props: PlanCardProps, user = "bob") {
  db.setSession(user);
  return render(
    <MemoryRouter>
      <Providers client={createQueryClient({ retry: false })}>
        <PlanCard {...props} />
      </Providers>
    </MemoryRouter>,
  );
}

const report = (patch: Partial<PlanCardProps["report"]> = {}): PlanCardProps["report"] => ({
  id: 1,
  symbol: "000660",
  name: "SK하이닉스",
  market: "KR",
  status: "completed",
  opinion: "buy",
  finishedAt: new Date(Date.now() - 3_600_000).toISOString(),
  ...patch,
});

describe("매매 계획 카드 (docs/plans/컨셉변경계획.md 4-5)", () => {
  it("실행 가능: 넣을 돈은 실행 확인에서 정하므로 계좌 금액(0주) 대신 계획의 목표·손절 비율(1주 기준, 비용 전)과 '실행 준비'", async () => {
    freezeTime(TUE_MORNING);
    renderCard({ report: report() });
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("ready"));
    expect(within(card).getByText("넣을 돈은 실행 확인에서 정해요")).toBeTruthy();
    expect(within(card).getByText("1주 기준 비율 · 수수료·세금 빼기 전")).toBeTruthy(); // '세 가지 경우'의 1주 기준 칸과 같은 말
    expect(within(card).getByText("목표에 팔면")).toBeTruthy();
    expect(within(card).getByText("+12.15%")).toBeTruthy(); // 203,000 / 181,000 − 1
    expect(within(card).getByText("-4.42%")).toBeTruthy(); // 173,000 / 181,000 − 1
    expect(within(card).queryByText(/0주|이 계좌로는/)).toBeNull();
    expect(within(card).getByRole("link", { name: /실행 준비/ }).getAttribute("href")).toBe("/recommendations/91");
  });

  it("계획 미니: 손절·목표 비율과 실행 준비 한 줄", async () => {
    renderCard({ report: report(), variant: "mini" });
    const mini = await screen.findByLabelText("계획 미니");
    await waitFor(() => expect(mini.getAttribute("data-state")).toBe("ready"));
    expect(within(mini).getByText("-4.42%")).toBeTruthy();
    expect(within(mini).getByText("+12.15%")).toBeTruthy();
    expect(within(mini).getByRole("link", { name: "실행 준비" })).toBeTruthy();
  });

  it("실행 불가: 사유 코드 문장, 진행 중인 계획이 있으면 보기 링크", async () => {
    const plan = db.activate(userOf("bob"), 91, { budgetPercent: 10 });
    renderCard({ report: report() });
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("blocked"));
    const reasons = within(card).getByRole("list", { name: "실행할 수 없는 이유" });
    expect(within(reasons).getByText("이미 이 종목으로 진행 중인 계획이 있어요")).toBeTruthy();
    expect(within(card).getByRole("link", { name: "진행 중인 계획 보기" }).getAttribute("href")).toBe(`/plans/${plan.id}`);
  });

  it("지켜보기 · 부정적 · 계획 없음 · 계획 준비 중", async () => {
    const r = renderCard({ report: report({ id: 500, opinion: "hold" }) });
    expect(await screen.findByText("AI는 지금은 지켜보자는 의견이에요. 실행할 계획이 없어요.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "며칠 뒤 다시 만들기" }).getAttribute("href")).toBe("/stocks/000660");
    r.unmount();

    const n = renderCard({ report: report({ id: 500, opinion: "avoid" }) });
    expect(await screen.findByText("AI는 위험이 더 크다고 봤어요. 실행할 계획을 만들지 않았어요.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    n.unmount();

    const none = renderCard({ report: report({ id: 500 }) });
    expect(await screen.findByText(/AI가 낸 가격 계획이 맞지 않아/)).toBeTruthy();
    none.unmount();

    renderCard({ report: report({ id: 500, finishedAt: new Date().toISOString() }) });
    expect(await screen.findByText("실행 계획을 준비하는 중이에요…")).toBeTruthy();
    // '준비 중' 문장은 status 역할을 따로 갖지 않는다 — 앱의 status 영역은 토스트 하나 (getByRole('status')로 토스트를 찾는다)
    expect(screen.getAllByRole("status")).toHaveLength(1);
  });

  it("기한 지남: 날짜와 새로 만들기", async () => {
    freezeTime(TUE_MORNING);
    const expired: Recommendation = { ...db.getRecommendation(2, 90), source: "report", sourceId: 501 };
    server.use(http.get("*/api/recommendations", () => HttpResponse.json({ count: 1, results: [expired] })));
    renderCard({ report: report({ id: 501, symbol: "005930", name: "삼성전자" }) });
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("expired"));
    expect(within(card).getByText(`이 계획은 10월 6일(화)에 기한이 끝났어요. 가격이 바뀌었을 수 있으니 새로 만들어 보세요.`)).toBeTruthy();
    expect(within(card).getByRole("link", { name: "새로 만들기" }).getAttribute("href")).toBe("/stocks/005930");
  });

  it("추천 목록을 받지 못하면 스켈레톤 대신 안내와 '다시 시도' (full·mini)", async () => {
    let fail = true;
    server.use(
      http.get("*/api/recommendations", () => (fail ? HttpResponse.json({ detail: "증권사 조회 불가" }, { status: 503 }) : undefined)),
    );
    const mini = renderCard({ report: report(), variant: "mini" });
    expect(within(await screen.findByLabelText("계획 미니")).getByText("매매 계획을 불러오지 못했어요.")).toBeTruthy();
    mini.unmount();

    renderCard({ report: report() });
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("error"));
    expect(within(card).getByRole("alert").textContent).toBe("매매 계획을 불러오지 못했어요.");
    fail = false;
    fireEvent.click(within(card).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "매매 계획" }).getAttribute("data-state")).toBe("ready"));
  });

  it("리포트가 완성 전이면 full은 안내, mini는 그리지 않는다", async () => {
    const { container } = renderCard({ report: report({ status: "running", opinion: null }), variant: "mini" });
    expect(container.textContent).toBe("");
    renderCard({ report: report({ status: "running", opinion: null }) });
    expect(await screen.findByText("리포트가 완성되면 이 계좌 기준의 매매 계획을 보여 드려요.")).toBeTruthy();
  });

  it("전문가 보기는 원래 용어(진입·손익비)", async () => {
    renderCard({ report: report(), view: "expert" }, "alice");
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("ready"));
    expect(within(card).getByText(/진입 181,000원 · 목표 203,000원 · 손절 173,000원 · 손익비/)).toBeTruthy();
    expect(within(card).getByText("목표 도달 시 이익")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- 표시 규칙 (화면 없이)

const rec = (patch: Partial<Recommendation>): Recommendation => ({ ...db.getRecommendation(1, 91), ...patch });
const pv = (activatable: boolean): RiskPreview => ({ ...db.riskPreview(1, 91, null), activatable });

describe("lib/autotrade 표시 규칙", () => {
  it("청산 사유 이름은 docs/API.md 표 그대로, 모르는 값은 그대로", () => {
    expect(EXIT_REASON).toEqual({ TARGET: "목표가 도달", STOP: "손절가 도달", EXPIRED: "보유 기한 경과", MANUAL: "사용자 매도" });
    expect(exitReasonLabel("NEW")).toBe("NEW");
    expect(exitReasonLabel(null)).toBe("");
  });

  it("쉬운 단계 넷: 상태별 지금 단계", () => {
    const plan = (status: Parameters<typeof easySteps>[0]["status"]) => ({ status, exitReason: null, failureReason: null, pnlKrw: null });
    const states = (status: Parameters<typeof easySteps>[0]["status"]) => easySteps(plan(status)).map((s) => s.state);
    expect(easySteps(plan("active")).map((s) => s.label)).toEqual(["주문", "사는 가격 기다리는 중", "목표·손절 지켜보는 중", "팔았어요"]);
    expect(states("active")).toEqual(["current", "todo", "todo", "todo"]);
    expect(states("entry_pending")).toEqual(["done", "current", "todo", "todo"]);
    expect(states("holding")).toEqual(["done", "done", "current", "todo"]);
    expect(states("closed")).toEqual(["done", "done", "done", "done"]);
    expect(states("expired")).toEqual(["done", "stopped", "skipped", "skipped"]);
  });

  it("교차검증 과정 한 줄", () => {
    const s = (proposer: string, passed: boolean | null, selected = false) => ({ proposer, passed, selected });
    expect(crossCheckSummary([s("claude", true, true), s("gpt", true), s("gemini", false)]).sentence).toBe(
      "AI 세 곳이 각자 계획을 내고 서로 검증했어요 · 통과 2 · 최종 승인 claude",
    );
    expect(crossCheckSummary([s("gpt", false), s("gemini", null)])).toMatchObject({ passed: 0, selected: null, sentence: "AI 두 곳이 각자 계획을 내고 서로 검증했어요 · 통과 0 · 최종 승인 없음" });
    expect(crossCheckSummary([]).count).toBe(0);
  });

  it("매매 계획 카드 상태", () => {
    const now = Date.parse("2026-10-06T10:00:00+09:00");
    const done = { status: "completed" as const, opinion: "buy" as const, finishedAt: "2026-10-06T09:55:00+09:00" };
    expect(planCardState({ report: { ...done, status: "running" }, recs: undefined, preview: undefined, now })).toBe("not_completed");
    expect(planCardState({ report: done, recs: undefined, preview: undefined, now })).toBe("loading");
    expect(planCardState({ report: done, recs: [], preview: undefined, now })).toBe("preparing");
    expect(planCardState({ report: done, recs: [], preview: undefined, now: now + PREPARING_MS })).toBe("no_plan");
    expect(planCardState({ report: { ...done, opinion: "hold" }, recs: [], preview: undefined, now })).toBe("watch");
    expect(planCardState({ report: { ...done, opinion: "avoid" }, recs: [], preview: undefined, now })).toBe("negative");
    expect(planCardState({ report: done, recs: [rec({ status: "expired" })], preview: undefined, now })).toBe("expired");
    expect(planCardState({ report: done, recs: [rec({})], preview: undefined, now })).toBe("loading");
    expect(planCardState({ report: done, recs: [rec({})], preview: pv(true), now })).toBe("ready");
    expect(planCardState({ report: done, recs: [rec({})], preview: pv(false), now })).toBe("blocked");
  });

  it("추천 고르기·새 계획 제안 나누기", () => {
    const a = rec({ id: 1, status: "expired", createdAt: "2026-10-06T09:00:00+09:00" });
    const b = rec({ id: 2, status: "open", createdAt: "2026-10-05T09:00:00+09:00" });
    expect(pickRecommendation([a, b])?.id).toBe(2);
    expect(pickRecommendation([a])?.id).toBe(1);
    expect(pickRecommendation([])).toBeNull();
    const list = [rec({ id: 1, source: "report" }), rec({ id: 2, source: "demo" }), rec({ id: 3, source: "analysis" })];
    expect(splitProposals(list, true)).toMatchObject({ main: [{ id: 1 }], others: [{ id: 2 }, { id: 3 }] });
    expect(splitProposals(list, false).others).toEqual([]);
  });

  it("KST 날짜·장중 여부·장 시작 안내", () => {
    expect(kstDayOf("2026-10-05T16:30:00Z")).toBe("2026-10-06"); // UTC 16:30 = KST 다음 날 01:30
    expect(isTodayKst("2026-10-05T23:59:00+09:00", new Date("2026-10-06T00:30:00+09:00"))).toBe(false);
    expect(isTodayKst("2026-10-06T00:10:00+09:00", new Date("2026-10-05T15:30:00Z"))).toBe(true);
    expect(duringSession("2026-10-06T10:00:00+09:00", "KR")).toBe(true);
    expect(duringSession("2026-10-06T15:30:00+09:00", "KR")).toBe(false);
    expect(duringSession("2026-10-10T10:00:00+09:00", "KR")).toBe(false); // 토요일
    expect(duringSession("2026-10-06T23:00:00+09:00", "US")).toBe(true); // 뉴욕 10:00
    expect(formatOpensAt("2026-10-07T09:00:00+09:00")).toBe("10월 7일(수) 오전 9시");
    expect(formatOpensAt("2026-10-06T09:30:00-04:00", "US")).toBe("10월 6일(화) 오후 10시 30분(한국 시각)");
    expect(closedMarketNotice({ isOpen: true, opensAt: null })).toBeNull();
    expect(closedMarketNotice({ isOpen: false, opensAt: "2026-10-07T09:00:00+09:00" })).toBe(
      "지금은 장이 닫혀 있어요. 10월 7일(수) 오전 9시에 장이 열리면 사는 가격을 확인해요",
    );
  });
});
