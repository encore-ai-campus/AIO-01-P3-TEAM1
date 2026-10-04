// 종목 상세 · 주문(보유 방식) · 모의투자 탭 · 실행 확인 · 모의 자동매매 상세 · 매매 계획 카드 · 교차검증 분석 (F-trade).
// 앨리스는 주린이모드 끔(전문가 보기), 밥은 진단 전이라 켬(쉬운 보기). 시각에 기대는 테스트는 freezeTime으로 KST 시각을 고정한다.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Providers } from "./App";
import type { Recommendation, RiskPreview } from "./api/types";
import { AnalysisCard } from "./components/AnalysisCard";
import { PlanCard, type PlanCardProps } from "./components/plan/PlanCard";
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
} from "./lib/autotrade";
import { formatPrice } from "./lib/format";
import { createQueryClient } from "./lib/queryClient";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";
import { freezeTime } from "./test/time";

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

/** 투자자 프로필(단타 잠금) 응답이 화면에 닿을 때까지 기다리는 함수를 돌려준다. "없다"를 확인하는 테스트가 응답 전에 통과하지 않게. */
function watchProfile() {
  let seen = false;
  server.events.on("response:mocked", ({ request }) => {
    if (new URL(request.url).pathname === "/api/me/investor-profile") seen = true;
  });
  return async () => {
    await waitFor(() => expect(seen).toBe(true));
    server.events.removeAllListeners();
    await act(() => new Promise((r) => setTimeout(r, 30)));
  };
}

// 화요일 장중 (KR 기준일 = 10월 5일 월요일 — 가짜 API는 휴일을 모른다)
const TUE_MORNING = "2026-10-06T10:00:00+09:00";
const KR_ASOF = "10월 5일(월) 15:30 장마감 기준";

describe("종목 상세: 장마감 기준 시세와 AI 리포트 만들기", () => {
  it("종가·기준 시각·완성 봉 안내, 오늘 이 종목 리포트가 있으면 '오늘 리포트 보기'와 남은 횟수", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/stocks/005930");
    const quote = await screen.findByRole("region", { name: "시세" });
    expect(within(quote).getByText("종가")).toBeTruthy();
    expect(within(quote).getByText("71,200원")).toBeTruthy();
    expect(within(quote).getByText(KR_ASOF)).toBeTruthy();
    expect(within(quote).getByText(/일봉 · 최근 120일 · 완성된 봉만 \(마지막 봉 10월 5일\(월\) 종가\)/)).toBeTruthy();

    // 앨리스가 오늘 신청한 삼성전자 리포트(#2)가 있다 → 큰 버튼이 "오늘 리포트 보기"
    const link = await screen.findByRole("link", { name: "오늘 리포트 보기" });
    expect(link.getAttribute("href")).toBe("/reports/2");
    expect(screen.getByText(/앨리스 님이 만듦/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "새로 만들기" })).toBeTruthy();
    expect(await screen.findByText("오늘 2번 더 만들 수 있어요")).toBeTruthy();
    // 보조 버튼 (D-1)
    expect(screen.getByRole("button", { name: "AI 교차검증 분석" })).toBeTruthy();
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

  it("교차검증 분석 요청은 보조 버튼에서 → 끝나면 분석 상세", async () => {
    renderApp("/stocks/005380");
    const btn = await screen.findByRole("button", { name: "AI 교차검증 분석" });
    await screen.findByText(/오늘 남은 횟수 4회/);
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

  it("단타 연습장 링크: 잠금이 풀린 사람(앨리스)의 국내 종목에만, 이 종목을 골라 둔 채로", async () => {
    renderApp("/stocks/005380");
    const link = await screen.findByRole("link", { name: "이 종목으로 단타 연습" });
    expect(link.getAttribute("href")).toBe("/day?symbol=005380");
  });

  it("단타 연습장 링크는 미국 종목에는 없다 (앨리스도)", async () => {
    const profileLoaded = watchProfile();
    renderApp("/stocks/AAPL");
    await screen.findByRole("region", { name: "시세" });
    await profileLoaded();
    expect(screen.queryByRole("link", { name: "이 종목으로 단타 연습" })).toBeNull();
  });

  it("잠긴 사람(밥, 주린이모드 켬)은 국내 종목에도 단타 연습장 링크가 없다", async () => {
    const profileLoaded = watchProfile();
    renderApp("/stocks/005380", "bob");
    await screen.findByRole("button", { name: /직접 주문\(고급\)/ });
    await profileLoaded();
    expect(screen.queryByRole("link", { name: "이 종목으로 단타 연습" })).toBeNull();
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
});

describe("주문: 보유 방식(스윙·장기 보유)", () => {
  it("장기 보유가 기본(분석에서 오지 않으면): 시장가 추정 안내, style long으로 주문하고 '왜 샀나요?'를 연다", async () => {
    const seen = recordBodies("/api/orders");
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    const group = await within(panel).findByRole("group", { name: "보유 방식" });
    expect(within(group).getByRole("button", { name: "장기 보유" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(panel).getByText("직전 장마감 가격 기준 추정이에요. 시장가는 주문 시점 가격으로 체결돼요.")).toBeTruthy();
    expect(within(panel).queryByLabelText("목표가")).toBeNull();
    fireEvent.change(within(panel).getByLabelText("수량"), { target: { value: "2" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    const dialog = await screen.findByRole("dialog", { name: "왜 샀나요?" });
    expect(within(dialog).getByText(/현대차을\(를\) 산 이유를 1~3개 적어 두면/)).toBeTruthy();
    server.events.removeAllListeners();
    expect(seen).toEqual([{ symbol: "005380", quantity: 2, orderType: "MARKET", style: "long" }]);
    expect(toast().textContent).toContain("현대차 2주 248,000원에 매수 체결");
    fireEvent.click(within(dialog).getByRole("button", { name: "나중에 적기" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "왜 샀나요?" })).toBeNull());
    expect(db.listOrders(1, "active").find((o) => o.symbol === "005380")?.style).toBe("long");
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
    expect(within(panel).getByRole("alert").textContent).toBe("손절가 < 직전 종가 < 목표가 순서여야 합니다.");
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

  it("장기 보유 중이면 '장기' 배지·자동 매도 없음·종가 기준 시각, 산 이유를 열 수 있다", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/stocks/068270");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByText("보유 중")).toBeTruthy();
    expect(within(panel).getByText("장기")).toBeTruthy();
    expect(within(panel).getByText("없음 (내가 팔 때까지 보유)")).toBeTruthy();
    expect(within(panel).getByText("종가")).toBeTruthy();
    expect(within(panel).getByText(KR_ASOF)).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "왜 샀나요? (산 이유 적기)" }));
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
});

describe("모의투자 탭", () => {
  it("전문가 보기(앨리스): 진행 중·보유(배지·장마감 기준)·끝난 계획·AI 추천·단타 연습장 입구", async () => {
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
    expect(screen.getByRole("link", { name: "단타 연습장 열기" }).getAttribute("href")).toBe("/day");
  });

  it("쉬운 보기(밥): 새 계획 제안은 리포트에서 나온 것만, 나머지는 '다른 계획 ○개'로 접고, 단타 연습장은 잠김 안내", async () => {
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
    expect(screen.getByRole("heading", { name: /단타 연습장 · 잠김/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "단타 연습장 열기" })).toBeNull();
    expect(screen.getByText("모든 매매는 모의 계좌에서만 이뤄져요 (실제 돈이 아니에요).")).toBeTruthy();
  });

  it("주린이모드 끔 + 퀴즈 미통과면 퀴즈 입구", async () => {
    db.setInvestorProfile("carol", { beginnerMode: false });
    renderApp("/portfolio", "carol");
    expect(await screen.findByRole("link", { name: "단타 연습 퀴즈 풀기" })).toBeTruthy();
  });

  it("체결 내역의 청산 사유는 docs/API.md 표 이름", async () => {
    renderApp("/portfolio?tab=fills");
    const fills = await screen.findByRole("list", { name: "체결 내역" });
    expect(within(fills).getAllByText(/목표가 도달/).length).toBeGreaterThan(0);
    expect(within(fills).getAllByText(/장 마감 전 정리/).length).toBeGreaterThan(0);
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

  it("예산 → 안전장치가 정한 수량·금액(장마감 기준) → 체크 셋을 모두 켜야 '모의 자동매매 시작'(acknowledged: true)", async () => {
    freezeTime(TUE_MORNING);
    const seen = recordBodies("/activate");
    renderApp("/recommendations/91", "bob");
    expect(await screen.findByRole("heading", { name: "SK하이닉스 계획 제안" })).toBeTruthy();
    const box = screen.getByRole("region", { name: "안전장치가 정한 수량" });
    expect(await within(box).findByText(/^이 계좌로는 \d+주 · /)).toBeTruthy();
    expect(within(box).getByText(KR_ASOF)).toBeTruthy();
    expect(within(box).getByText(/안전장치: 손절에 팔려도 계좌의 약 1%만 잃게 정했어요/)).toBeTruthy();
    expect(screen.getByText(/181,000원 이하가 될 때까지 .+까지만 기다려요/)).toBeTruthy();

    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
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
    expect(seen).toEqual([{ acknowledged: true }]);
    const steps = screen.getByRole("list", { name: "모의 자동매매 단계" });
    expect(within(steps).getByText("사는 가격 기다리는 중").closest("li")?.getAttribute("aria-current")).toBe("step");
    const events = screen.getByRole("list", { name: "계획 사건" });
    expect(within(events).getByText(/^모의 계좌에서 181,000원 이하에 \d+주를 사는 주문을 넣었어요$/)).toBeTruthy();
    expect(within(events).getByText("모의 자동매매를 시작했어요")).toBeTruthy();
  });

  it("예산을 바꿔 금액이 바뀌면 체크를 다시 해야 한다", async () => {
    renderApp("/recommendations/91", "bob");
    const box = await screen.findByRole("region", { name: "안전장치가 정한 수량" });
    await within(box).findByText(/^이 계좌로는/);
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("예산 (원, 선택)"), { target: { value: "1,000,000" } });
    await waitFor(() => expect(within(box).getByText(/이 계좌로는 5주/)).toBeTruthy(), { timeout: 3000 });
    await waitFor(() => expect(screen.getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked)).toBe(true));
    expect(start.disabled).toBe(true);
  });

  it("예산을 지워 금액이 처음 값으로 돌아와도 체크는 다시 해야 한다 (확인 상태가 남지 않는다)", async () => {
    renderApp("/recommendations/91", "bob");
    const box = await screen.findByRole("region", { name: "안전장치가 정한 수량" });
    const first = (await within(box).findByText(/^이 계좌로는/)).textContent ?? "";
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    const budget = screen.getByLabelText("예산 (원, 선택)");
    fireEvent.change(budget, { target: { value: "1,000,000" } });
    await waitFor(() => expect(within(box).getByText(/이 계좌로는 5주/)).toBeTruthy(), { timeout: 3000 });
    fireEvent.change(budget, { target: { value: "" } });
    await waitFor(() => expect(within(box).getByText(/^이 계좌로는/).textContent).toBe(first), { timeout: 3000 });
    await waitFor(() => expect(box.getAttribute("aria-busy")).toBe("false"), { timeout: 3000 });
    expect(screen.getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked)).toBe(true);
    expect(start.disabled).toBe(true);
    expect(screen.getByText("위의 확인 셋을 모두 켜면 시작할 수 있어요.")).toBeTruthy();
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
    expect(screen.getAllByRole("checkbox")).toHaveLength(3);
    expect(screen.getByLabelText("AI가 아닌 연습용 예시 계획이며, 실제 돈이 아닌 모의 투자예요.")).toBeTruthy(); // 연습용 예시는 AI 제안이 아니다
  });

  it("활성화 400(장중 확인 price_passed)은 쉬운 문장으로", async () => {
    db.setPrice("000660", 210_000); // 장중 가격이 목표가(203,000원) 이상 — 종가 미리 보기는 통과한다
    renderApp("/recommendations/91", "bob");
    await within(await screen.findByRole("region", { name: "안전장치가 정한 수량" })).findByText(/^이 계좌로는/);
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
    const plan = db.activate(userOf("bob"), 91, { acknowledged: true });
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
    const plan = db.activate(userOf("bob"), 91, {});
    db.setPrice("000660", 180_000); // 진입가 아래 → 지정가 체결
    renderApp(`/plans/${plan.id}`, "bob");
    await screen.findByText("목표·손절을 지켜보는 중", { selector: "span" });
    fireEvent.click(screen.getByRole("button", { name: "멈추기" }));
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(`지금 가지고 있는 ${plan.quantity}주를 모두 팔고 끝낼까요? 장이 닫혀 있으면 다음 장 시작(오전 9시)에 팔아요.`),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "모두 팔고 멈추기" }));
    await waitFor(() => expect(screen.getByRole("note").textContent).toContain("직접 모의 계좌에서 팔았어요"));
  });

  it("끝난 단타 계획: 단계 모두 완료 + 쉬운 결과, 전문가 보기는 '장 마감 전 정리'", async () => {
    renderApp("/plans/97?view=easy");
    const steps = await screen.findByRole("list", { name: "모의 자동매매 단계" });
    expect(within(steps).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("note").textContent).toMatch(/^단타라 장 마감 전에 모의 계좌에서 정리했어요 · 손익 /);
    expect(screen.getByText("단타라 그날 15:15가 지나면 정리해요.")).toBeTruthy();

    renderApp("/plans/97");
    await waitFor(() => expect(screen.getAllByRole("note").some((n) => n.textContent?.includes("청산 완료 · 장 마감 전 정리"))).toBe(true));
  });
});

describe("AI 교차검증 분석 (두 모드 모두 과정을 보인다)", () => {
  it("쉬운 보기: 과정 한 줄 + 제안 AI별 카드(통과·탈락), 점수·확률 없음, 뉴스 매체·시각·출처, 자료 기준일", async () => {
    freezeTime(TUE_MORNING); // 뉴스 시각은 올해면 연도를 빼고 보인다 — 1월 초에 작년 뉴스가 되어 깨지지 않게
    renderApp("/analyses/5", "bob");
    expect(await screen.findByRole("heading", { name: "에코프로비엠 AI 교차검증 분석" })).toBeTruthy();
    expect(screen.getByText("AI 세 곳이 각자 계획을 내고 서로 검증했어요 · 통과 2 · 최종 승인 claude")).toBeTruthy();
    const claude = screen.getByRole("article", { name: "claude 계획" });
    expect(within(claude).getByText("최종 승인")).toBeTruthy();
    expect(within(claude).getByText("사는 가격")).toBeTruthy();
    expect(within(screen.getByRole("article", { name: "gemini 계획" })).getByText("탈락")).toBeTruthy();
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
    expect(await screen.findByText(/장마감 기준$/)).toBeTruthy(); // 위쪽 종가 (분석의 가격은 "분석 시각 가격")
    expect(screen.getByText(/^분석 시각 가격/)).toBeTruthy();
  });

  it("분석 카드: 쉬운 보기는 분석 상세로, 전문가 보기는 종목 주문으로 (가격은 종가 + 기준 시각)", async () => {
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
    expect(easy.getByText(KR_ASOF)).toBeTruthy();
    expect(easy.queryByText(/점수/)).toBeNull();
    easy.unmount();
    const expert = wrap("expert");
    expect(expert.getByRole("link").getAttribute("href")).toBe(`/stocks/005930?analysis=${a.id}`);
    expect(expert.getByText("BUY")).toBeTruthy();
  });
});

describe("검색", () => {
  it("결과 위에 시장별 장마감 기준 시각", async () => {
    freezeTime(TUE_MORNING);
    renderApp("/search?q=삼성");
    const basis = await screen.findByLabelText("가격 기준");
    expect(within(basis).getByText(KR_ASOF)).toBeTruthy();
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

describe("매매 계획 카드 (docs/컨셉변경계획.md 4-5)", () => {
  it("실행 가능: 이 계좌 기준 금액(장마감 기준)과 '실행 준비'", async () => {
    freezeTime(TUE_MORNING);
    renderCard({ report: report() });
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("ready"));
    expect(within(card).getByText(/^이 계좌로는 \d+주 · [\d,]+원$/)).toBeTruthy();
    expect(within(card).getByText("목표에 팔면")).toBeTruthy();
    expect(within(card).getByText(KR_ASOF)).toBeTruthy();
    expect(within(card).getByRole("link", { name: /실행 준비/ }).getAttribute("href")).toBe("/recommendations/91");
  });

  it("계획 미니: 손절 시 손실·목표 이익·실행 준비 한 줄", async () => {
    renderCard({ report: report(), variant: "mini" });
    const mini = await screen.findByLabelText("계획 미니");
    await waitFor(() => expect(mini.getAttribute("data-state")).toBe("ready"));
    expect(within(mini).getByText(/^-[\d,]+원$/)).toBeTruthy();
    expect(within(mini).getByText(/^\+[\d,]+원$/)).toBeTruthy();
    expect(within(mini).getByRole("link", { name: "실행 준비" })).toBeTruthy();
  });

  it("실행 불가: 사유 코드 문장, 진행 중인 계획이 있으면 보기 링크", async () => {
    const plan = db.activate(userOf("bob"), 91, {});
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
    expect(EXIT_REASON).toEqual({ TARGET: "목표가 도달", STOP: "손절가 도달", EXPIRED: "보유 기한 경과", MANUAL: "사용자 매도", EOD: "장 마감 전 정리" });
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
