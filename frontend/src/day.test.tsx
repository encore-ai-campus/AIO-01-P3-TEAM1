// 단타 연습: 분봉 차트(시각·체결 표시·가격 선) · 단타 연습장(잠금·상태·계획 만들기 → 미리 보기 → 체크리스트 → 시작) · 퀴즈 · 복기.
// 세션(15:15 진입 마감)과 기준일이 시각에 기대므로 테스트마다 시각을 고정한다 (KST 기준 — 10월 6일은 화요일).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createChart, createSeriesMarkers, type ISeriesMarkersPluginApi, type Time } from "lightweight-charts";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { MinuteCandle, TradePlanDetail } from "./api/types";
import { barTimeFor, buildMarkers, chartTime, includePrices } from "./components/day/chartMarks";
import { formatPriceInput, hm, kstToday, parsePrice, pctFrom, reviewEntry, shiftSession, usageLevel } from "./components/day/dayUtil";
import { MinuteChart } from "./components/day/MinuteChart";
import { formatKrw } from "./lib/format";
import { setThemePref } from "./lib/theme";
import { DAY_AI_REVIEW_PENDING, DAY_COST_NOTE, DAY_LAG_NOTE, DAY_LOCK_TEXT, PLAN_STATUS_TEXT, REASON_TEXT } from "./lib/plainText";
import * as db from "./mocks/db";
import { quizAnswerKey, quizQuestions } from "./mocks/quiz";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";
import { freezeTime, moveTime } from "./test/time";

const TUE_10AM = "2026-10-06T10:00:00+09:00"; // 화요일 장중 · 계획을 만들 수 있음 · KR 기준일 10월 5일(월)
const TUE_1520 = "2026-10-06T15:20:00+09:00"; // 15:15 진입 마감 뒤

/** 우리 문장에 쓰지 않는 권유 표현 (docs/API.md "금지 표현" PERSUASION 최소 목록). 공백을 지우고 비교한다. */
const PERSUASION = ["사세요", "사볼만", "매수하세요", "매수기회", "지금사면", "담으세요", "좋아요", "파세요", "팔아야", "매도하세요", "매도기회", "지금팔면", "정리하세요", "비중을줄이세요", "비중을늘리세요", "손절하세요"];
const persuasionIn = (text: string) => PERSUASION.filter((p) => text.replace(/\s+/g, "").includes(p));

const bar = (time: string, close: number): MinuteCandle => ({ time, open: close, high: close + 100, low: close - 100, close, volume: 1000 });
const CANDLES = [bar("2026-10-05T09:00:00+09:00", 70_000), bar("2026-10-05T09:01:00+09:00", 70_100), bar("2026-10-05T09:02:00+09:00", 70_200)];

/** 차트 가짜(setupTests)의 시리즈는 하나를 같이 쓴다 — 가격 선 호출을 보려고 꺼낸다. */
function fakeSeries() {
  const chart = createChart(document.createElement("div"));
  return chart.addSeries(null as never) as unknown as { createPriceLine: Mock; setData: Mock; applyOptions: Mock };
}

/** 단타 연습장 계획 만들기: 종목을 찾아 고르고 가격을 넣는다. */
async function fillPlan(query: string, name: RegExp, prices: { entry: string; target: string; stop: string; budget?: string }) {
  fireEvent.change(await screen.findByLabelText("종목 (국내만)"), { target: { value: query } });
  const list = await screen.findByRole("list", { name: "종목 검색 결과" });
  fireEvent.click(await within(list).findByRole("button", { name }));
  fireEvent.change(await screen.findByLabelText("사는 가격"), { target: { value: prices.entry } });
  fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: prices.target } });
  fireEvent.change(screen.getByLabelText("손절 가격"), { target: { value: prices.stop } });
  if (prices.budget) fireEvent.change(screen.getByLabelText("예산 (원, 선택)"), { target: { value: prices.budget } });
}

/** 이미 고른 종목(?symbol=)에 가격을 넣고, 미리 보기가 멈추면 시작 전 확인 셋을 켠다. 시작 버튼을 돌려준다. */
async function readyToStart() {
  fireEvent.change(await screen.findByLabelText("사는 가격"), { target: { value: "191000" } });
  fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "203000" } });
  fireEvent.change(screen.getByLabelText("손절 가격"), { target: { value: "189000" } });
  const preview = await screen.findByRole("region", { name: "단타 미리 보기" }, { timeout: 3000 });
  await waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
  for (const c of within(screen.getByRole("group", { name: /시작 전 확인/ })).getAllByRole("checkbox")) fireEvent.click(c);
  return screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement;
}

describe("분봉 차트 계산", () => {
  it("시각은 KST 벽시계로 (차트는 UTC로 그린다)", () => {
    expect(chartTime("2026-10-05T09:00:00+09:00")).toBe(Date.UTC(2026, 9, 5, 9, 0) / 1000);
    expect(chartTime("2026-10-05T00:00:00Z")).toBe(Date.UTC(2026, 9, 5, 9, 0) / 1000);
    expect(chartTime("아님")).toBeNull();
  });

  it("체결 표시는 그 시각이 들어가는 봉에 붙인다 (앞이면 첫 봉, 뒤면 마지막 봉)", () => {
    expect(barTimeFor(CANDLES, "2026-10-05T09:01:40+09:00")).toBe(chartTime("2026-10-05T09:01:00+09:00"));
    expect(barTimeFor(CANDLES, "2026-10-05T09:00:00+09:00")).toBe(chartTime("2026-10-05T09:00:00+09:00"));
    expect(barTimeFor(CANDLES, "2026-10-05T08:59:00+09:00")).toBe(chartTime("2026-10-05T09:00:00+09:00"));
    expect(barTimeFor(CANDLES, "2026-10-05T15:15:06+09:00")).toBe(chartTime("2026-10-05T09:02:00+09:00"));
    expect(barTimeFor([], "2026-10-05T09:01:00+09:00")).toBeNull();
  });

  it("표시는 시각 순서로, 진입은 봉 아래 · 청산은 봉 위", () => {
    const marks = buildMarkers(CANDLES, [
      { time: "2026-10-05T09:02:10+09:00", price: 70_200, kind: "exit" },
      { time: "2026-10-05T09:00:30+09:00", price: 70_000, kind: "entry", label: "샀어요" },
    ]);
    expect(marks.map((m) => [m.text, m.position, m.shape])).toEqual([
      ["샀어요", "belowBar", "arrowUp"],
      ["청산", "aboveBar", "arrowDown"],
    ]);
    expect(buildMarkers([], [{ time: "2026-10-05T09:00:30+09:00", price: 1, kind: "entry" }])).toEqual([]);
  });

  it("가격 축 범위에 가격 선을 넣는다 (목표가가 그날 고가보다 높아도 보이게)", () => {
    const base = { priceRange: { minValue: 69_800, maxValue: 70_300 } };
    expect(includePrices(base, [70_000, 71_000, 69_500])?.priceRange).toEqual({ minValue: 69_500, maxValue: 71_000 });
    expect(includePrices(base, [])).toBe(base);
    expect(includePrices(null, [1])).toBeNull();
  });

  it("작은 도구: 가격 입력 읽기 · HH:MM · 오늘(KST)", () => {
    expect(parsePrice("191,000원")).toBe(191_000);
    expect(parsePrice("")).toBeNull();
    expect(parsePrice("-5")).toBeNaN();
    expect(parsePrice("abc")).toBeNaN();
    expect(hm("2026-10-05T00:12:04Z")).toBe("09:12");
    expect(kstToday(new Date("2026-10-05T16:30:00Z"))).toBe("2026-10-06"); // UTC로는 5일이지만 KST로는 6일 01:30
  });

  it("세션 넘기기(주말 건너뜀) · 칸을 떠날 때 쉼표 · 기준 대비 % · 복기 입구 · 쓴 양 단계", () => {
    expect(shiftSession("2026-10-05", -1)).toBe("2026-10-02"); // 월 → 금
    expect(shiftSession("2026-10-02", 1)).toBe("2026-10-05"); // 금 → 월
    expect(shiftSession("2026-10-06", 1)).toBe("2026-10-07");
    expect(shiftSession("아님", 1)).toBeNull();
    expect(formatPriceInput("191000")).toBe("191,000");
    expect(formatPriceInput("191,000원")).toBe("191,000");
    expect(formatPriceInput("abc")).toBe("abc"); // 읽을 수 없으면 그대로 (오류 문장이 알려 준다)
    expect(formatPriceInput("")).toBe("");
    expect(pctFrom(191_000, 203_000)).toBe("+6.3%");
    expect(pctFrom(191_000, 189_000)).toBe("−1.0%");
    expect(pctFrom(null, 1)).toBeNull();
    // 오늘 단타가 끝난 뒤(15:15 이후·오늘 계획 있음)에만 오늘 날짜로. 그 밖에는 복기 기본값(KR 기준일)이라 글자에 그 날짜를 밝힌다
    expect(reviewEntry({ todayDate: "2026-10-06", hasTodayPlans: true, accepting: false, basis: "2026-10-05" })).toMatchObject({
      label: "오늘 세션 복기",
      to: "/day/review?date=2026-10-06",
    });
    expect(reviewEntry({ todayDate: "2026-10-06", hasTodayPlans: true, accepting: true, basis: "2026-10-05" })).toMatchObject({
      label: "최근 세션 복기 · 10월 5일(월)",
      to: "/day/review",
    });
    expect([usageLevel(0, 10), usageLevel(8, 10), usageLevel(10, 10), usageLevel(5, 0)]).toEqual(["ok", "near", "full", "ok"]);
  });
});

describe("<MinuteChart>", () => {
  it("분봉 · 가격 선 · 체결 표시를 그리고 범례에 글로도 적는다", () => {
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    series.setData.mockClear();
    series.applyOptions.mockClear();
    vi.mocked(createSeriesMarkers).mockClear();
    render(
      <MinuteChart
        candles={CANDLES}
        lines={[
          { price: 70_000, kind: "entry" },
          { price: 71_000, kind: "target" },
          { price: 69_500, kind: "stop", label: "내 손절" },
        ]}
        markers={[{ time: "2026-10-05T09:01:20+09:00", price: 70_050, kind: "entry" }]}
      />,
    );
    expect(screen.getByRole("img", { name: "분봉 차트" })).toBeTruthy();
    // 봉: KST 벽시계 시각으로 (첫 setData = 캔들)
    const bars = series.setData.mock.calls[0][0] as { time: number }[];
    expect(bars.map((b) => b.time)).toEqual(CANDLES.map((c) => chartTime(c.time)));
    expect(series.createPriceLine.mock.calls.map(([o]) => [o.price, o.title])).toEqual([
      [70_000, "사는 가격"],
      [71_000, "목표 가격"],
      [69_500, "내 손절"],
    ]);
    // 가격 축은 가격 선까지 담는다
    const provider = series.applyOptions.mock.calls.map(([o]) => o.autoscaleInfoProvider).find(Boolean);
    expect(provider(() => ({ priceRange: { minValue: 69_900, maxValue: 70_300 } })).priceRange).toEqual({ minValue: 69_500, maxValue: 71_000 });
    const plugin = vi.mocked(createSeriesMarkers).mock.results.at(-1)!.value as ISeriesMarkersPluginApi<Time>;
    const set = vi.mocked(plugin.setMarkers).mock.calls.at(-1)![0];
    expect(set).toEqual([{ time: chartTime("2026-10-05T09:01:00+09:00"), position: "belowBar", shape: "arrowUp", color: "#191F28", text: "진입" }]);
    const legend = screen.getByRole("list", { name: "차트 표시" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "사는 가격 70,000원",
      "목표 가격 71,000원",
      "내 손절 69,500원",
      "진입 09:01 70,050원",
    ]);
  });

  it("같은 값의 새 배열이면 가격 선을 다시 만들지 않는다", () => {
    const series = fakeSeries();
    const lines = () => [{ price: 70_000, kind: "entry" as const }];
    const { rerender } = render(<MinuteChart candles={CANDLES} lines={lines()} label="계획 차트" />);
    series.createPriceLine.mockClear();
    rerender(<MinuteChart candles={CANDLES} lines={lines()} label="계획 차트" />);
    expect(series.createPriceLine).not.toHaveBeenCalled();
    rerender(<MinuteChart candles={CANDLES} lines={[{ price: 70_500, kind: "entry" }]} label="계획 차트" />);
    expect(series.createPriceLine).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("img", { name: "계획 차트" })).toBeTruthy();
  });

  it("청산 표시는 경고 글자색(흰 바탕에서도 읽히게) — 화살표·글자와 범례 견본이 같은 색", () => {
    render(<MinuteChart candles={CANDLES} markers={[{ time: "2026-10-05T09:02:10+09:00", price: 70_200, kind: "exit" }]} />);
    const plugin = vi.mocked(createSeriesMarkers).mock.results.at(-1)!.value as ISeriesMarkersPluginApi<Time>;
    expect(vi.mocked(plugin.setMarkers).mock.calls.at(-1)![0][0]).toMatchObject({ color: "#9A5B00", text: "청산", position: "aboveBar" });
    const item = within(screen.getByRole("list", { name: "차트 표시" })).getByText(/^청산/);
    expect(item.querySelector("span")?.className).toContain("bg-warn-ink");
  });

  it("TradingView 고지는 차트 그림(role=img) 밖의 글자 링크 — 그림 안에 Tab 정지점을 두지 않는다", () => {
    render(<MinuteChart candles={CANDLES} lines={[{ price: 70_000, kind: "entry" }]} />);
    const img = screen.getByRole("img", { name: "분봉 차트" });
    const link = screen.getByRole("link", { name: "TradingView" });
    expect(link.getAttribute("href")).toBe("https://www.tradingview.com/");
    expect(img.contains(link)).toBe(false);
    expect(img.closest("figure")?.contains(link)).toBe(true);
    // 범례가 없어도 고지는 남는다
    render(<MinuteChart candles={CANDLES} label="범례 없는 차트" />);
    expect(screen.getByRole("img", { name: "범례 없는 차트" }).closest("figure")?.querySelector('a[href="https://www.tradingview.com/"]')).toBeTruthy();
  });

  it("테마가 바뀌면 다시 만들지 않고 색만 바꾼다 (보던 구간 유지 — 캔들을 다시 넣지 않는다)", () => {
    const series = fakeSeries();
    render(<MinuteChart candles={CANDLES} markers={[{ time: "2026-10-05T09:01:20+09:00", price: 70_050, kind: "entry" }]} />);
    const plugin = vi.mocked(createSeriesMarkers).mock.results.at(-1)!.value as ISeriesMarkersPluginApi<Time>;
    series.setData.mockClear();
    series.applyOptions.mockClear();
    act(() => setThemePref("dark"));
    // 진입 표시는 다크의 밝은 글자색(다크 card 위에서 묻히지 않게), 캔들은 다크 상승·하락색 (jsdom은 토큰을 못 읽어 대체값)
    expect(vi.mocked(plugin.setMarkers).mock.calls.at(-1)![0][0].color).toBe("#E9ECEF");
    expect(series.applyOptions).toHaveBeenCalledWith(expect.objectContaining({ upColor: "#F25C68", downColor: "#458EF7" }));
    // 다시 넣는 것은 봉마다 색이 있는 거래량뿐이다
    expect(series.setData).toHaveBeenCalledTimes(1);
    expect((series.setData.mock.calls[0][0] as { color: string }[])[0].color).toBe("rgba(242,92,104,0.32)");
  });
});

describe("단타 연습장 /day", () => {
  it("잠겨 있으면 사유와 퀴즈·마이 입구를 보이고 계획 만들기는 없다 (상태는 보인다)", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "bob"); // 주린이모드 켬 · 퀴즈 미통과
    expect(await screen.findByRole("heading", { name: "단타 연습장이 잠겨 있어요" })).toBeTruthy();
    const reasons = screen.getByRole("list", { name: "잠금 사유" });
    expect(within(reasons).getAllByRole("listitem").map((li) => li.textContent)).toEqual([DAY_LOCK_TEXT.beginner_mode, DAY_LOCK_TEXT.quiz_not_passed]);
    expect(screen.getByRole("link", { name: "단타 연습 퀴즈 풀기" }).getAttribute("href")).toBe("/day/quiz");
    expect(screen.getByRole("link", { name: "마이에서 주린이모드 끄기" }).getAttribute("href")).toBe("/my");
    expect(screen.queryByRole("heading", { name: "단타 계획 만들기" })).toBeNull();
    expect(screen.getByRole("heading", { name: "10월 6일(화) 세션" })).toBeTruthy();
    expect(screen.getByText(DAY_LAG_NOTE)).toBeTruthy();
  });

  it("잠겨 있으면 잠금 카드가 맨 위 · 버튼은 사유 순서 · 상태 배지는 '잠겨 있어요' · 빈 계획 카드는 숨긴다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "bob");
    const lock = await screen.findByRole("heading", { name: "단타 연습장이 잠겨 있어요" });
    // 이 사람이 지금 할 수 있는 일(잠금 풀기)이 경고 띠보다 먼저
    expect(lock.compareDocumentPosition(screen.getByText(DAY_LAG_NOTE)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(`${DAY_COST_NOTE}.`)).toBeTruthy(); // 쓸 수 없는 미리 보기 안내 문장은 뺀다
    const card = lock.closest("section")!;
    expect(within(card).getAllByRole("link").map((a) => a.textContent)).toEqual(["마이에서 주린이모드 끄기", "단타 연습 퀴즈 풀기"]);
    const status = screen.getByRole("region", { name: "10월 6일(화) 세션" });
    expect(status.textContent).toContain("잠겨 있어요");
    expect(status.textContent).toContain("잠금을 풀면 오늘 15:15 전까지 만들 수 있어요");
    expect(status.textContent).not.toContain("계획을 만들 수 있어요");
    expect(screen.queryByRole("region", { name: /오늘 단타 계획/ })).toBeNull();
  });

  it("퀴즈만 통과하고 주린이모드가 켜져 있으면 마이 입구만", async () => {
    freezeTime(TUE_10AM);
    db.setInvestorProfile("bob", { dayQuizPassedAt: "2026-10-01T10:00:00+09:00" });
    renderApp("/day", "bob");
    const reasons = await screen.findByRole("list", { name: "잠금 사유" });
    expect(within(reasons).getAllByRole("listitem").map((li) => li.textContent)).toEqual([DAY_LOCK_TEXT.beginner_mode]);
    expect(screen.queryByRole("link", { name: "단타 연습 퀴즈 풀기" })).toBeNull();
    expect(screen.getByRole("link", { name: "마이에서 주린이모드 끄기" })).toBeTruthy();
    expect(screen.getByText("퀴즈는 통과했어요. 마이에서 주린이모드를 끄면 열려요.")).toBeTruthy();
  });

  it("상태 카드: 세션 · 15:15 진입 마감 · 한도 · 오늘 쓴 양", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "alice");
    const card = await screen.findByRole("region", { name: "10월 6일(화) 세션" });
    const text = card.textContent ?? "";
    expect(text).toContain("계획을 만들 수 있어요");
    expect(text).toContain("오늘 15:15 전까지 만들 수 있어요");
    expect(text).toContain("단타 진입 마감15:15");
    expect(text).toContain("09:00~15:30 · 지금 열림");
    expect(text).toContain("총자산의 0.5%");
    expect(text).toContain("총자산의 2%");
    expect(text).toContain("10건");
    expect(text).toContain("0 / 10건");
    const status = db.dayStatus(1);
    expect(text).toContain(`${formatKrw(status.today.lossKrw)} / ${formatKrw(status.today.lossLimitKrw)}`);
  });

  it("계획 만들기: 종목 → 가격 → 미리 보기(비용 합계, 장마감 기준) → 체크 셋 → 시작 → 오늘 계획 목록", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "alice");
    expect(await screen.findByRole("heading", { name: "단타 계획 만들기" })).toBeTruthy();
    await fillPlan("NAVER", /NAVER/, { entry: "191,000", target: "203000", stop: "189000", budget: "1,000,000" });

    // 고른 종목의 직전 종가와 계획용 분봉(직전 세션 = 10월 5일) — 둘 다 장마감 기준
    const chartPanel = await screen.findByRole("region", { name: "NAVER 분봉" });
    expect(await within(chartPanel).findByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
    expect(within(chartPanel).getByRole("heading").textContent).toContain("10월 5일(월) 정규장");
    expect(await within(chartPanel).findByRole("img", { name: "NAVER 10월 5일(월) 1분봉 차트 (장마감 기준)" })).toBeTruthy();
    // 가격 선은 입력이 멈춘 뒤에 옮긴다 (고쳐 쓰는 도중의 값으로 축이 출렁이지 않게)
    await waitFor(() => expect(within(chartPanel).getByRole("list", { name: "차트 표시" }).textContent).toContain("목표 가격 203,000원"));

    const input = { symbol: "035420", entryPrice: 191_000, targetPrice: 203_000, stopPrice: 189_000, budgetKrw: 1_000_000 };
    const expected = db.dayPreview(1, input);
    const preview = await screen.findByRole("region", { name: "단타 미리 보기" }, { timeout: 3000 });
    await waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
    const pv = preview.textContent ?? "";
    expect(pv).toContain("리스크 엔진 통과"); // 앨리스는 전문가 보기
    expect(pv).toContain(`안전장치가 정한 수량${expected.quantity}주`);
    expect(pv).toContain("수량을 정한 기준예산");
    expect(pv).toContain(`목표 가격에 팔 때 비용${formatKrw(expected.costsAtTarget.totalKrw)}`);
    expect(pv).toContain(`손절 가격에 팔 때 비용${formatKrw(expected.costsAtStop.totalKrw)}`);
    expect(pv).toContain(DAY_COST_NOTE);
    expect(within(preview).getByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();

    // 체크 셋을 모두 켜야 시작할 수 있다
    const start = screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    const checks = within(screen.getByRole("group", { name: /시작 전 확인/ })).getAllByRole("checkbox");
    expect(checks).toHaveLength(3);
    expect(checks[0].closest("label")?.textContent).toContain(`약 ${formatKrw(expected.maxLossKrw)} 손실`);
    expect(checks[1].closest("label")?.textContent).toContain("15:15");
    expect(checks[2].closest("label")?.textContent).toContain(formatKrw(expected.costsAtStop.totalKrw));
    fireEvent.click(checks[0]);
    fireEvent.click(checks[1]);
    expect(start.disabled).toBe(true);
    fireEvent.click(checks[2]);
    expect(start.disabled).toBe(false);
    fireEvent.click(start);

    const plans = await screen.findByRole("region", { name: /오늘 단타 계획/ });
    await waitFor(() => expect(within(plans).getByText("NAVER")).toBeTruthy());
    const made = db.listDayPlans(1, "2026-10-06").results;
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ symbol: "035420", horizon: "DAY", source: "day", quantity: expected.quantity, entryPrice: 191_000 });
    expect(db.getPlan(1, made[0].id).events[0].details).toMatchObject({ acknowledged: true });
    // 폼 본문이 결과 카드 하나로 바뀐다 (같은 종목은 계획 하나만이라 입력 칸을 남기지 않는다): 제목에 포커스 · 진행 보기 · 다른 종목으로 새 계획
    await waitFor(() => expect(screen.queryByRole("region", { name: "단타 미리 보기" })).toBeNull());
    const done = screen.getByRole("heading", { name: "NAVER 모의 단타 계획을 시작했어요" });
    expect(document.activeElement).toBe(done);
    expect(screen.getByRole("link", { name: "진행 보기" }).getAttribute("href")).toBe(`/plans/${made[0].id}`);
    expect(screen.queryByLabelText("사는 가격")).toBeNull();
    expect(screen.queryAllByRole("status").some((el) => el.textContent?.includes("시작했어요"))).toBe(false); // 같은 말을 토스트로 되풀이하지 않는다
    expect(persuasionIn(document.body.textContent ?? "")).toEqual([]);
    // 다음 계획은 종목부터 처음으로 (검색 칸에 포커스)
    fireEvent.click(screen.getByRole("button", { name: "다른 종목으로 새 계획" }));
    expect(document.activeElement).toBe(screen.getByLabelText("종목 (국내만)"));
  });

  it("손익비가 모자라면 안전장치 사유(쉬운 문장)를 보이고 시작할 수 없다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "alice");
    await fillPlan("035420", /NAVER/, { entry: "191000", target: "192000", stop: "189000" });
    const reasons = await screen.findByRole("list", { name: "시작할 수 없는 사유" }, { timeout: 3000 });
    expect(reasons.textContent).toContain(REASON_TEXT.reward_risk_low);
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    expect((screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("가격 순서가 틀리면 미리 보기를 부르지 않고 안내한다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "alice");
    await fillPlan("NAVER", /NAVER/, { entry: "191000", target: "190000", stop: "189000" });
    expect(await screen.findByText("손절 가격 < 사는 가격 < 목표 가격 순서로 적어 주세요.")).toBeTruthy();
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByRole("region", { name: "단타 미리 보기" })).toBeNull();
  });

  it("15:15 뒤에는 다음 거래일 0시부터 — 미리 보기는 해 볼 수 있지만 시작은 막힌다", async () => {
    freezeTime(TUE_1520);
    renderApp("/day", "alice");
    const card = await screen.findByRole("region", { name: "10월 7일(수) 세션" });
    expect(card.textContent).toContain("지금은 만들 수 없어요");
    expect(card.textContent).toContain("10월 7일(수) 0시부터 만들 수 있어요");
    await fillPlan("NAVER", /NAVER/, { entry: "191000", target: "203000", stop: "189000", budget: "1000000" });
    const reasons = await screen.findByRole("list", { name: "시작할 수 없는 사유" }, { timeout: 3000 });
    expect(reasons.textContent).toContain(REASON_TEXT.day_entry_closed);
    expect(screen.getByRole("region", { name: "단타 미리 보기" }).textContent).toContain("10월 7일(수) 0시부터 만들 수 있어요");
    // 연습 모드: 제목 옆 배지, 미리 보기 머리는 결론(시작할 수 없음)이 먼저, 체크는 켤 수 없다
    expect(screen.getByText("연습 모드")).toBeTruthy();
    expect(screen.getByRole("region", { name: "단타 미리 보기" }).textContent).toContain("지금은 시작할 수 없어요 (사유 1개)");
    expect(screen.getAllByRole("checkbox").every((c) => c.matches(":disabled") && !(c as HTMLInputElement).checked)).toBe(true);
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    expect((screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement).disabled).toBe(true);
    // 다음 세션 카드 안의 쓴 양은 오늘 것임을 밝히고, '지금 열림'(오늘 시장)은 섞지 않는다
    expect(card.textContent).toContain("10월 6일(화) 쓴 양");
    expect(card.textContent).not.toContain("지금 열림");
  });

  it("국내 종목만 고를 수 있다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "alice");
    fireEvent.change(await screen.findByLabelText("종목 (국내만)"), { target: { value: "AAPL" } });
    const list = await screen.findByRole("list", { name: "종목 검색 결과" });
    expect(await within(list).findByText("단타 연습은 국내 종목만 돼요.")).toBeTruthy();
  });

  it("?symbol=로 종목을 미리 고른다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day?symbol=035420", "alice");
    expect(await screen.findByRole("region", { name: "035420 분봉" })).toBeTruthy();
    expect(await screen.findByText("NAVER")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "바꾸기" }));
    expect(screen.getByLabelText("종목 (국내만)")).toBeTruthy();
  });

  it("종목을 고르면 고른 종목에 포커스(키패드를 띄우지 않게), 바꾸기를 누르면 검색 칸에 포커스", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day", "alice");
    fireEvent.change(await screen.findByLabelText("종목 (국내만)"), { target: { value: "NAVER" } });
    const list = await screen.findByRole("list", { name: "종목 검색 결과" });
    fireEvent.click(await within(list).findByRole("button", { name: /NAVER/ }));
    const picked = await screen.findByRole("group", { name: /NAVER/ });
    expect(document.activeElement?.id).toBe("day-picked-name");
    fireEvent.click(within(picked).getByRole("button", { name: "바꾸기" }));
    expect(document.activeElement).toBe(screen.getByLabelText("종목 (국내만)"));
  });

  it("가격 칸: 칸을 떠나면 천 단위 쉼표 · 도움말은 기준 대비 % · 순서 오류는 입력이 멈춘 뒤에", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day?symbol=035420", "alice");
    const entry = (await screen.findByLabelText("사는 가격")) as HTMLInputElement;
    fireEvent.change(entry, { target: { value: "191000" } });
    fireEvent.blur(entry);
    expect(entry.value).toBe("191,000");
    const target = screen.getByLabelText("목표 가격") as HTMLInputElement;
    const stop = screen.getByLabelText("손절 가격") as HTMLInputElement;
    const help = (el: HTMLElement) => document.getElementById(el.getAttribute("aria-describedby")!.split(" ")[0])?.textContent;
    expect(help(target)).toBe("사는 가격보다 높게");
    fireEvent.change(stop, { target: { value: "189000" } });
    fireEvent.change(target, { target: { value: "203000" } });
    expect(help(target)).toBe("사는 가격보다 +6.3%");
    expect(help(stop)).toBe("사는 가격보다 −1.0%");
    // 목표가를 고쳐 쓰는 도중(2…)에는 바로 빨간 오류를 띄우지 않는다
    const order = "손절 가격 < 사는 가격 < 목표 가격 순서로 적어 주세요.";
    fireEvent.change(target, { target: { value: "2" } });
    expect(screen.queryByText(order)).toBeNull();
    expect(target.getAttribute("aria-invalid")).toBeNull();
    expect(await screen.findByText(order)).toBeTruthy();
    expect(target.getAttribute("aria-invalid")).toBe("true");
    expect(target.getAttribute("aria-describedby")).toContain("day-price-error");
    // 한 번 보인 오류는 같은 오류인 동안 고쳐 쓰는 중에도 남고(글자마다 깜빡이지 않게), 고치면 바로 지운다
    fireEvent.change(target, { target: { value: "20" } });
    expect(screen.getByText(order)).toBeTruthy();
    fireEvent.change(target, { target: { value: "203000" } });
    expect(screen.queryByText(order)).toBeNull();
    // 다시 고쳐 쓰는 도중에는 같은 문장이 이어져도(2 → 20) 첫 글자부터 400ms가 지났다고 띄우지 않는다 — 입력이 멈춘 뒤에
    fireEvent.change(target, { target: { value: "2" } });
    await new Promise((r) => setTimeout(r, 250));
    fireEvent.change(target, { target: { value: "20" } });
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.queryByText(order)).toBeNull();
    expect(await screen.findByText(order)).toBeTruthy();
  });

  it("가격을 고쳐 쓰는 동안 미리 보기·확인은 흐리게 남고(카드가 사라졌다 나타나지 않게), 차트 선은 입력이 멈춘 뒤에 옮긴다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day?symbol=035420", "alice");
    fireEvent.change(await screen.findByLabelText("사는 가격"), { target: { value: "191000" } });
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "203000" } });
    fireEvent.change(screen.getByLabelText("손절 가격"), { target: { value: "189000" } });
    const preview = await screen.findByRole("region", { name: "단타 미리 보기" }, { timeout: 3000 });
    await waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
    const legend = await screen.findByRole("list", { name: "차트 표시" });
    for (const c of within(screen.getByRole("group", { name: /시작 전 확인/ })).getAllByRole("checkbox")) fireEvent.click(c);

    // 목표가를 205000으로 고쳐 쓰는 도중(2…): 보던 숫자는 흐리게(aria-busy) 남고, 확인은 지워져 켤 수 없고, 시작도 막힌다
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "2" } });
    expect(screen.getByRole("region", { name: "단타 미리 보기" }).getAttribute("aria-busy")).toBe("true");
    const checks = within(screen.getByRole("group", { name: /시작 전 확인/ })).getAllByRole("checkbox");
    expect(checks.every((c) => c.matches(":disabled") && !(c as HTMLInputElement).checked)).toBe(true);
    expect((screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement).disabled).toBe(true);
    expect(legend.textContent).toContain("목표 가격 203,000원"); // 차트 선은 아직 그대로 (2원 선으로 축이 납작해지지 않게)
    // 첫 글자부터 400ms가 지나도 계속 쓰는 중이면 그대로 (2 → 20)
    await new Promise((r) => setTimeout(r, 250));
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "20" } });
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole("region", { name: "단타 미리 보기" }).getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("손절 가격 < 사는 가격 < 목표 가격 순서로 적어 주세요.")).toBeNull();
    expect(legend.textContent).toContain("목표 가격 203,000원");
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "205000" } });
    await waitFor(() => expect(screen.getByRole("list", { name: "차트 표시" }).textContent).toContain("목표 가격 205,000원"));
    await waitFor(() => expect(screen.getByRole("region", { name: "단타 미리 보기" }).getAttribute("aria-busy")).toBe("false"));
    expect(screen.getByText("숫자가 바뀌어 다시 확인해요")).toBeTruthy();

    // 멈췄는데도 틀린 값이면 그때 오류를 보이고 미리 보기를 내린다
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "190000" } });
    expect(await screen.findByText("손절 가격 < 사는 가격 < 목표 가격 순서로 적어 주세요.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "단타 미리 보기" })).toBeNull();
  });

  it("시작을 보내는 동안 버튼은 막지 않고 aria-disabled — 포커스가 남아, 실패하면 오류와 함께 제자리", async () => {
    freezeTime(TUE_10AM);
    // 서버가 늦게 거절하는 경우 (보내는 동안을 볼 수 있게 300ms)
    let sent = 0;
    server.use(
      http.post("*/api/day/plans", async () => {
        sent += 1;
        await delay(300);
        return HttpResponse.json({ detail: "지금은 단타 계획을 만들 수 없는 시각입니다.", reasonCodes: ["day_entry_closed"] }, { status: 400 });
      }),
    );
    renderApp("/day?symbol=035420", "alice");
    fireEvent.change(await screen.findByLabelText("사는 가격"), { target: { value: "191000" } });
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "203000" } });
    fireEvent.change(screen.getByLabelText("손절 가격"), { target: { value: "189000" } });
    const preview = await screen.findByRole("region", { name: "단타 미리 보기" }, { timeout: 3000 });
    await waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
    for (const c of within(screen.getByRole("group", { name: /시작 전 확인/ })).getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement;
    start.focus();
    fireEvent.click(start);
    await waitFor(() => expect(start.getAttribute("aria-disabled")).toBe("true"));
    expect(start.disabled).toBe(false); // 막으면 포커스가 body로 빠진다
    expect(start.getAttribute("aria-busy")).toBe("true");
    fireEvent.click(start); // 보내는 동안 다시 눌러도 한 번만 보낸다
    expect(await screen.findByText(REASON_TEXT.day_entry_closed, { exact: false })).toBeTruthy();
    expect(document.activeElement).toBe(start);
    expect(start.getAttribute("aria-disabled")).toBeNull();
    expect(sent).toBe(1);
    expect(db.listDayPlans(1, "2026-10-06").results).toHaveLength(0);
  });

  it("시작에 실패한 뒤 입력을 고치면 지난 오류를 지운다 (고친 값까지 틀린 것처럼 읽히지 않게) — 다시 켜고 시작하면 만든다", async () => {
    freezeTime(TUE_10AM);
    server.use(http.post("*/api/day/plans", () => HttpResponse.json({ detail: "증권사 조회가 잠시 안 돼요." }, { status: 503 }), { once: true }));
    renderApp("/day?symbol=035420", "alice");
    fireEvent.click(await readyToStart());
    expect(await screen.findByText("증권사 조회가 잠시 안 돼요.")).toBeTruthy();
    // 예산을 넣으면(입력이 바뀜) 지난 시도의 오류는 바로 내리고, 새 숫자로 다시 확인하게 한다
    fireEvent.change(screen.getByLabelText("예산 (원, 선택)"), { target: { value: "1000000" } });
    expect(screen.queryByText("증권사 조회가 잠시 안 돼요.")).toBeNull();
    await waitFor(() => expect(screen.getByRole("region", { name: "단타 미리 보기" }).getAttribute("aria-busy")).toBe("false"));
    expect(screen.getByRole("region", { name: "단타 미리 보기" }).textContent).toContain("시작할 수 있어요");
    expect(screen.getByText("숫자가 바뀌어 다시 확인해요")).toBeTruthy();
    expect(screen.queryByText("증권사 조회가 잠시 안 돼요.")).toBeNull();
    for (const c of within(screen.getByRole("group", { name: /시작 전 확인/ })).getAllByRole("checkbox")) fireEvent.click(c);
    fireEvent.click(screen.getByRole("button", { name: "모의 단타 계획 시작" }));
    expect(await screen.findByRole("heading", { name: "NAVER 모의 단타 계획을 시작했어요" })).toBeTruthy();
    expect(db.listDayPlans(1, "2026-10-06").results[0]).toMatchObject({ symbol: "035420", budgetKrw: 1_000_000 });
  });

  it("보내는 동안 입력을 고쳐도, 만들어진 계획의 결과 카드는 뜬다 (지난 시도를 지우느라 성공을 놓치지 않게)", async () => {
    freezeTime(TUE_10AM);
    server.use(
      http.post(
        "*/api/day/plans",
        async ({ request }) => {
          const body = (await request.json()) as Record<string, unknown>;
          await delay(300);
          return HttpResponse.json(db.createDayPlan(db.sessionUser()!, body), { status: 201 });
        },
        { once: true },
      ),
    );
    renderApp("/day?symbol=035420", "alice");
    fireEvent.click(await readyToStart());
    fireEvent.change(screen.getByLabelText("예산 (원, 선택)"), { target: { value: "1000000" } }); // 응답이 오기 전에
    expect(await screen.findByRole("heading", { name: "NAVER 모의 단타 계획을 시작했어요" })).toBeTruthy();
    expect(db.listDayPlans(1, "2026-10-06").results).toHaveLength(1);
  });

  it("시작 결과 카드의 상태는 만든 순간에 멈추지 않고 계획을 따라간다 (아래 오늘 계획 줄과 같은 말)", async () => {
    freezeTime(TUE_10AM, { planStepMs: 0 }); // 다음 조회 때 바로 체결 → 목표가 청산 (실서버도 엔진이 몇 초 안에 바꾼다)
    renderApp("/day?symbol=035420", "alice");
    fireEvent.click(await readyToStart());
    const title = await screen.findByRole("heading", { name: "NAVER 모의 단타 계획을 시작했어요" });
    const line = title.nextElementSibling!;
    await waitFor(() => expect(line.textContent).toContain(PLAN_STATUS_TEXT.closed.expert));
    expect(line.textContent).not.toContain(PLAN_STATUS_TEXT.entry_pending.expert);
    const plans = screen.getByRole("region", { name: /오늘 단타 계획/ });
    await waitFor(() => expect(within(plans).getByText(PLAN_STATUS_TEXT.closed.expert)).toBeTruthy());
    expect(document.activeElement).toBe(title); // 상태가 바뀌어도 카드는 제자리 (포커스 그대로)
  });

  it("PC(lg): 미리 보기는 오른쪽 칸(폼 밖)에 하나만 — 처음에는 점선 안내, 체크리스트·시작은 폼 안, 시작하면 칸이 빈다", async () => {
    freezeTime(TUE_10AM);
    // jsdom에는 matchMedia가 없어 늘 모바일 배치다. PC 폭(Tailwind lg = 64rem)만 맞다고 답하는 가짜를 끼운다
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("64rem"), media: query, addEventListener() {}, removeEventListener() {} }));
    try {
      renderApp("/day?symbol=035420", "alice");
      const form = await screen.findByRole("region", { name: "단타 계획 만들기" });
      const hint = await screen.findByText(/가격을 넣으면 여기에서/);
      expect(form.contains(hint)).toBe(false);
      const start = await readyToStart();
      expect(screen.queryByText(/가격을 넣으면 여기에서/)).toBeNull();
      const previews = screen.getAllByRole("region", { name: "단타 미리 보기" });
      expect(previews).toHaveLength(1);
      expect(form.contains(previews[0])).toBe(false);
      expect(previews[0].textContent).toContain("미리 보기 · NAVER");
      expect(form.contains(screen.getByRole("group", { name: /시작 전 확인/ }))).toBe(true);
      expect(form.contains(start)).toBe(true);
      fireEvent.click(start);
      expect(await screen.findByRole("heading", { name: "NAVER 모의 단타 계획을 시작했어요" })).toBeTruthy();
      expect(screen.queryByRole("region", { name: "단타 미리 보기" })).toBeNull();
      expect(screen.queryByText(/가격을 넣으면 여기에서/)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["전문가 보기는 서버 사유", "/day?symbol=035420", "모의 주문 접수가 거절되었습니다."],
    ["쉬운 보기는 쉬운 문장", "/day?symbol=035420&view=easy", PLAN_STATUS_TEXT.failed.line],
  ])("201이어도 계획이 failed면 결과 카드는 '넣지 못해 멈췄어요' · %s · 계획 보기", async (_, path, line) => {
    freezeTime(TUE_10AM);
    const made: { plan?: TradePlanDetail } = {};
    server.use(
      http.post("*/api/day/plans", async ({ request }) => {
        const plan = db.createDayPlan(db.sessionUser()!, (await request.json()) as Record<string, unknown>);
        made.plan = { ...plan, status: "failed", failureReason: "모의 주문 접수가 거절되었습니다." };
        return HttpResponse.json(made.plan, { status: 201 });
      }),
      // 실서버처럼 다시 받아도 같은 실패 상태 (결과 카드는 계획을 다시 받아 그린다)
      http.get("*/api/trade-plans/:id", ({ params }) => (made.plan && Number(params.id) === made.plan.id ? HttpResponse.json(made.plan) : undefined)),
    );
    const { client } = renderApp(path, "alice");
    fireEvent.click(await readyToStart());
    const title = await screen.findByRole("heading", { name: "모의 주문을 넣지 못해 계획이 멈췄어요" });
    expect(document.activeElement).toBe(title);
    expect(title.nextElementSibling?.textContent).toBe(`NAVER · ${line}`);
    expect(screen.getByRole("link", { name: "계획 보기" }).getAttribute("href")).toBe(`/plans/${made.plan!.id}`);
    expect(screen.queryByRole("link", { name: "진행 보기" })).toBeNull();
    await act(() => client.invalidateQueries({ queryKey: ["plan"] }));
    expect(screen.getByRole("heading", { name: "모의 주문을 넣지 못해 계획이 멈췄어요" })).toBeTruthy();
  });

  it("같은 종목에 진행 중인 계획이 있으면 가격을 넣기 전에 알리고, 사유에는 계획 보기 링크를 단다", async () => {
    freezeTime(TUE_10AM);
    db.setSession("alice");
    const plan = db.createDayPlan(db.sessionUser()!, { symbol: "035420", entryPrice: 191_000, targetPrice: 203_000, stopPrice: 189_000, budgetKrw: 1_000_000, acknowledged: true });
    renderApp("/day?symbol=035420", "alice");
    expect(await screen.findByText(/이 종목은 진행 중인 계획이 있어요/)).toBeTruthy();
    expect((await screen.findByRole("link", { name: /진행 중인 계획 보기 ·/ })).getAttribute("href")).toBe(`/plans/${plan.id}`);
    fireEvent.change(screen.getByLabelText("사는 가격"), { target: { value: "191000" } });
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "203000" } });
    fireEvent.change(screen.getByLabelText("손절 가격"), { target: { value: "189000" } });
    const reasons = await screen.findByRole("list", { name: "시작할 수 없는 사유" }, { timeout: 3000 });
    expect(reasons.textContent).toContain(REASON_TEXT.plan_exists);
    expect(reasons.textContent).not.toContain(REASON_TEXT.position_exists); // 같은 뜻은 한 번만
    expect(within(reasons).getByRole("link", { name: "진행 중인 계획 보기" }).getAttribute("href")).toBe(`/plans/${plan.id}`);
  });

  it("국내가 아닌 종목을 주소로 열면 분봉·가격 칸 대신 '국내만' 안내와 다른 종목 고르기", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day?symbol=AAPL", "alice");
    expect(await screen.findByText("단타 연습은 국내 종목만 돼요.")).toBeTruthy();
    expect(screen.queryByLabelText("사는 가격")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다른 종목 고르기" }));
    expect(document.activeElement).toBe(screen.getByLabelText("종목 (국내만)"));
  });

  it("보는 중에 15:15가 지나면 미리 보기를 다시 받아 시작을 막고, 켜 둔 확인도 지운다", async () => {
    freezeTime("2026-10-06T15:13:30+09:00");
    const { client } = renderApp("/day?symbol=035420", "alice");
    fireEvent.change(await screen.findByLabelText("사는 가격"), { target: { value: "191000" } });
    fireEvent.change(screen.getByLabelText("목표 가격"), { target: { value: "203000" } });
    fireEvent.change(screen.getByLabelText("손절 가격"), { target: { value: "189000" } });
    const preview = await screen.findByRole("region", { name: "단타 미리 보기" }, { timeout: 3000 });
    await waitFor(() => expect(preview.getAttribute("aria-busy")).toBe("false"));
    for (const c of within(screen.getByRole("group", { name: /시작 전 확인/ })).getAllByRole("checkbox")) fireEvent.click(c);
    expect((screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement).disabled).toBe(false);

    moveTime("2026-10-06T15:16:00+09:00");
    await act(() => client.invalidateQueries({ queryKey: ["day", "status"] })); // 30초 폴링 대신
    expect(await screen.findByText("15:15가 지나 오늘은 더 시작할 수 없어요.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("region", { name: "단타 미리 보기" }).textContent).toContain("지금은 시작할 수 없어요"));
    expect((screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole("checkbox").every((c) => !(c as HTMLInputElement).checked && c.matches(":disabled"))).toBe(true);
  });

  it("15:15 뒤 오늘 계획이 있으면 '오늘 단타가 끝났어요'가 폼보다 위 · 오늘 날짜 복기 · 폼은 접혀 있다가 펼친다", async () => {
    freezeTime(TUE_10AM);
    db.setSession("alice");
    db.createDayPlan(db.sessionUser()!, { symbol: "035420", entryPrice: 191_000, targetPrice: 203_000, stopPrice: 189_000, budgetKrw: 1_000_000, acknowledged: true });
    moveTime(TUE_1520);
    renderApp("/day", "alice");
    const done = await screen.findByRole("heading", { name: "오늘 단타가 끝났어요" });
    expect(screen.getByRole("link", { name: "오늘 세션 복기 보기" }).getAttribute("href")).toBe("/day/review?date=2026-10-06");
    const toggle = screen.getByRole("button", { name: /다음 세션 숫자 연습/ });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(done.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "단타 계획 만들기" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("heading", { name: "단타 계획 만들기" })).toBeTruthy();
    // 오늘 계획 카드 아래 복기 줄도 같은 날짜로
    const plans = screen.getByRole("region", { name: /오늘 단타 계획/ });
    expect(within(plans).getByRole("link", { name: "오늘 세션 복기" }).getAttribute("href")).toBe("/day/review?date=2026-10-06");
  });
});

describe("단타 연습 퀴즈 /day/quiz", () => {
  /** 문항마다 보기를 고른다 (answers: 문항 id → 보기 id). */
  async function answerAll(answers: Record<string, string>) {
    const questions = quizQuestions();
    for (const [i, q] of questions.entries()) {
      const group = await screen.findByRole("group", { name: `${i + 1}. ${q.text}` });
      const choice = q.choices.find((c) => c.id === answers[q.id])!;
      fireEvent.click(within(group).getByRole("radio", { name: choice.text }));
    }
  }

  it("5문항을 모두 맞히면 통과 — 주린이모드가 켜져 있으면 마이 안내", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day/quiz", "bob");
    const submit = (await screen.findByRole("button", { name: "채점하기" })) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await answerAll(quizAnswerKey());
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByRole("heading", { name: "통과했어요" })).toBeTruthy();
    expect(screen.getByText("5문항 중 5문항 맞혔어요.")).toBeTruthy();
    expect(screen.getByText(new RegExp(DAY_LOCK_TEXT.beginner_mode))).toBeTruthy();
    expect(screen.getByRole("link", { name: "마이로 가기" }).getAttribute("href")).toBe("/my");
    expect(screen.getAllByText("맞았어요")).toHaveLength(5);
    expect(db.investorProfile(2).dayQuizPassedAt).not.toBeNull();
    expect(db.investorProfile(2).dayTradingUnlocked).toBe(false);
  });

  it("하나라도 틀리면 통과하지 못하고, 해설을 본 뒤 다시 풀 수 있다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day/quiz", "bob");
    const key = quizAnswerKey();
    const wrongQ1 = quizQuestions()[0].choices.find((c) => c.id !== key.q1)!.id;
    await answerAll({ ...key, q1: wrongQ1 });
    fireEvent.click(screen.getByRole("button", { name: "채점하기" }));
    expect(await screen.findByRole("heading", { name: "아직 통과하지 못했어요" })).toBeTruthy();
    expect(screen.getByText("5문항 중 4문항 맞혔어요.")).toBeTruthy();
    const q1 = screen.getByLabelText("1번 채점");
    expect(q1.textContent).toContain("틀렸어요");
    expect(q1.textContent).toContain("15:15");
    expect(db.investorProfile(2).dayQuizPassedAt).toBeNull();
    // 채점 뒤에는 답을 바꿀 수 없고, 다시 풀면 처음부터
    expect(screen.getAllByRole("radio")[0].matches(":disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "다시 풀기" }));
    expect(screen.getAllByRole("radio").every((r) => !(r as HTMLInputElement).checked && !r.matches(":disabled"))).toBe(true);
    expect(screen.getByRole("button", { name: "채점하기" })).toBeTruthy();
  });

  it("주린이모드를 끈 팀원은 통과하면 연습장으로", async () => {
    freezeTime(TUE_10AM);
    db.setInvestorProfile("carol", { beginnerMode: false });
    renderApp("/day/quiz", "carol");
    await answerAll(quizAnswerKey());
    fireEvent.click(screen.getByRole("button", { name: "채점하기" }));
    expect((await screen.findByRole("link", { name: "단타 연습장으로" })).getAttribute("href")).toBe("/day");
    expect(db.investorProfile(3).dayTradingUnlocked).toBe(true);
  });

  it("이미 통과했으면 통과 시각을 보인다", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day/quiz", "alice");
    expect(await screen.findByText(/에 통과했어요 \(다시 풀어도 기록은 남아요\)/)).toBeTruthy();
    // 다시 들어온 통과자에게도 다음 행동 (잠금이 풀려 있으면 연습장)
    expect(screen.getByRole("link", { name: "단타 연습장으로" }).getAttribute("href")).toBe("/day");
  });

  it("답한 수와 안 푼 문항으로 가기 · 채점하면 결과가 문항보다 위(제목에 포커스) · 틀린 문항 해설로 · 다시 풀면 1번 첫 보기로", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day/quiz", "bob");
    const questions = quizQuestions();
    const key = quizAnswerKey();
    const pick = async (i: number, choiceId: string) => {
      const q = questions[i];
      const group = await screen.findByRole("group", { name: `${i + 1}. ${q.text}` });
      fireEvent.click(within(group).getByRole("radio", { name: q.choices.find((c) => c.id === choiceId)!.text }));
    };
    await pick(0, questions[0].choices.find((c) => c.id !== key.q1)!.id); // 1번은 틀리게
    await pick(2, key.q3);
    expect(screen.getByRole("progressbar", { name: "답한 문항" }).getAttribute("aria-valuenow")).toBe("2");
    // 빠뜨린 문항으로 바로 간다 (그 문항 첫 보기에 포커스)
    fireEvent.click(screen.getByRole("button", { name: "2번 문항으로" }));
    expect(document.activeElement).toBe(within(screen.getByRole("group", { name: `2. ${questions[1].text}` })).getAllByRole("radio")[0]);
    await pick(1, key.q2);
    await pick(3, key.q4);
    await pick(4, key.q5);
    expect(screen.queryByRole("button", { name: /문항으로$/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "채점하기" }));

    const title = await screen.findByRole("heading", { name: "아직 통과하지 못했어요" });
    expect(document.activeElement).toBe(title); // 사라진 채점 버튼 대신
    const q1 = screen.getByLabelText("1번 채점");
    expect(title.compareDocumentPosition(q1) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy(); // 결과 → 1번 해설 순서로 읽는다
    fireEvent.click(screen.getByRole("button", { name: "1번 문항 해설 보기" }));
    expect(document.activeElement).toBe(q1);
    fireEvent.click(screen.getByRole("button", { name: "다시 풀기" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getAllByRole("radio")[0]));
  });
});

describe("단타 복기 /day/review", () => {
  it("기본은 KR 기준일: 합계 · 진입·청산·사유(장 마감 전 정리) · 분봉(진입·청산 표시) · AI 복기 준비 중", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day/review", "alice");
    const item = await screen.findByRole("article", { name: "에코프로 복기" });
    expect((screen.getByLabelText("세션 날짜") as HTMLInputElement).value).toBe("2026-10-05");
    const review = db.dayReview(1, "2026-10-05");
    const r = review.plans[0];
    const text = item.textContent ?? "";
    expect(text).toContain("장 마감 전 정리");
    expect(text).toContain(`진입 체결${hm(r.entryAt)} · ${formatKrw(r.entryPrice)}`);
    expect(text).toContain(`청산${hm(r.exitAt)} · ${formatKrw(r.exitPrice)}`);
    expect(text).toContain(`비용 (수수료·거래세)${formatKrw(r.costsKrw)}`);
    expect(within(item).getByRole("link", { name: /계획 #97/ }).getAttribute("href")).toBe("/plans/97");

    const totals = screen.getByRole("region", { name: "10월 5일(월) 합계" });
    expect(totals.textContent).toContain("진입 체결1건");
    expect(totals.textContent).toContain(`비용 합계${formatKrw(review.totals.costsKrw)}`);
    expect(screen.getByText(DAY_AI_REVIEW_PENDING)).toBeTruthy();

    // 그 세션 분봉: 장마감 기준 + 진입·청산 표시
    expect(await within(item).findByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
    const legend = await within(item).findByRole("list", { name: "차트 표시" });
    expect(legend.textContent).toContain(`진입 ${hm(r.entryAt)} ${formatKrw(r.entryPrice)}`);
    expect(legend.textContent).toContain(`청산 ${hm(r.exitAt)} ${formatKrw(r.exitPrice)}`);
    expect(legend.textContent).toContain("사는 가격");
  });

  it("날짜를 바꾸면 그 세션을 보이고, 계획이 없으면 빈 안내", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day/review", "alice");
    await screen.findByRole("article", { name: "에코프로 복기" });
    fireEvent.change(screen.getByLabelText("세션 날짜"), { target: { value: "2026-10-02" } });
    expect(await screen.findByText(/이 날짜에 만든 단타 계획이 없어요/)).toBeTruthy();
    expect(screen.getByRole("region", { name: "10월 2일(금) 합계" })).toBeTruthy();
    expect(screen.queryByRole("article", { name: "에코프로 복기" })).toBeNull();
  });

  it("아직 끝나지 않은 오늘 세션은 분봉 대신 안내 (계획은 보인다)", async () => {
    freezeTime(TUE_10AM);
    db.setSession("alice");
    db.createDayPlan(db.sessionUser()!, { symbol: "035420", entryPrice: 191_000, targetPrice: 203_000, stopPrice: 189_000, budgetKrw: 1_000_000, acknowledged: true });
    renderApp("/day/review?date=2026-10-06", "alice");
    const item = await screen.findByRole("article", { name: "NAVER 복기" });
    expect(await within(item).findByText("아직 끝나지 않은 세션이에요. 분봉은 장 마감 뒤(15:40)부터 볼 수 있어요.")).toBeTruthy();
    expect(item.textContent).toContain("진입 체결체결 안 됨");
  });

  it("날짜 넘기기: 이전 세션은 주말을 건너뛰고 · 다음은 오늘을 넘지 않고 · '최근 세션으로' 돌아온다. AI 복기 준비 중은 기록 아래", async () => {
    freezeTime(TUE_10AM);
    renderApp("/day/review", "alice");
    const item = await screen.findByRole("article", { name: "에코프로 복기" });
    // 아직 없는 기능의 안내는 실제 기록 아래 한 줄
    expect(item.compareDocumentPosition(screen.getByRole("region", { name: "AI 복기" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const totals = screen.getByRole("region", { name: "10월 5일(월) 합계" });
    expect(within(totals).getByText("최근 세션")).toBeTruthy();
    const dateInput = screen.getByLabelText("세션 날짜") as HTMLInputElement;

    fireEvent.click(screen.getByRole("button", { name: "이전 세션" }));
    expect(dateInput.value).toBe("2026-10-02"); // 월요일의 앞 세션은 금요일
    expect(screen.getByRole("region", { name: "10월 2일(금) 합계" })).toBeTruthy(); // 불러오는 동안에도 제목은 고른 날짜
    expect(await screen.findByText(/이 날짜에 만든 단타 계획이 없어요/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "AI 복기" })).toBeNull(); // 기록이 없으면 준비 중 안내도 없다

    // 키보드로 넘기듯 버튼에 포커스를 둔 채 누른다
    const next = screen.getByRole("button", { name: "다음 세션" }) as HTMLButtonElement;
    next.focus();
    fireEvent.click(next);
    fireEvent.click(next);
    expect(dateInput.value).toBe("2026-10-06");
    // 오늘 뒤는 없다: disabled 대신 aria-disabled — 누른 버튼에 포커스가 남고(body로 빠지지 않게), 더 눌러도 그대로
    expect(next.getAttribute("aria-disabled")).toBe("true");
    expect(next.disabled).toBe(false);
    expect(document.activeElement).toBe(next);
    fireEvent.click(next);
    expect(dateInput.value).toBe("2026-10-06");
    // '최근 세션으로'는 누르면 사라지므로 포커스를 날짜 칸으로 옮긴다 (새 날짜가 들어간 뒤)
    const recent = screen.getByRole("button", { name: /최근 세션으로/ });
    recent.focus();
    fireEvent.click(recent);
    await waitFor(() => expect(dateInput.value).toBe("2026-10-05"));
    expect(screen.queryByRole("button", { name: /최근 세션으로/ })).toBeNull();
    expect(document.activeElement).toBe(dateInput);
    expect(await screen.findByRole("article", { name: "에코프로 복기" })).toBeTruthy();
  });
});
