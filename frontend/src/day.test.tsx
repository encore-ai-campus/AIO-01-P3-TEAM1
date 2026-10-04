// 단타 연습: 분봉 차트(시각·체결 표시·가격 선) · 단타 연습장(잠금·상태·계획 만들기 → 미리 보기 → 체크리스트 → 시작) · 퀴즈 · 복기.
// 세션(15:15 진입 마감)과 기준일이 시각에 기대므로 테스트마다 시각을 고정한다 (KST 기준 — 10월 6일은 화요일).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createChart, createSeriesMarkers, type ISeriesMarkersPluginApi, type Time } from "lightweight-charts";
import { describe, expect, it, vi, type Mock } from "vitest";
import type { MinuteCandle } from "./api/types";
import { barTimeFor, buildMarkers, chartTime, includePrices } from "./components/day/chartMarks";
import { hm, kstToday, parsePrice } from "./components/day/dayUtil";
import { MinuteChart } from "./components/day/MinuteChart";
import { formatKrw } from "./lib/format";
import { DAY_AI_REVIEW_PENDING, DAY_COST_NOTE, DAY_LAG_NOTE, DAY_LOCK_TEXT, REASON_TEXT } from "./lib/plainText";
import * as db from "./mocks/db";
import { quizAnswerKey, quizQuestions } from "./mocks/quiz";
import { renderApp } from "./test/render";
import { freezeTime } from "./test/time";

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

  it("퀴즈만 통과하고 주린이모드가 켜져 있으면 마이 입구만", async () => {
    freezeTime(TUE_10AM);
    db.setInvestorProfile("bob", { dayQuizPassedAt: "2026-10-01T10:00:00+09:00" });
    renderApp("/day", "bob");
    const reasons = await screen.findByRole("list", { name: "잠금 사유" });
    expect(within(reasons).getAllByRole("listitem").map((li) => li.textContent)).toEqual([DAY_LOCK_TEXT.beginner_mode]);
    expect(screen.queryByRole("link", { name: "단타 연습 퀴즈 풀기" })).toBeNull();
    expect(screen.getByRole("link", { name: "마이에서 주린이모드 끄기" })).toBeTruthy();
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
    expect(within(chartPanel).getByRole("list", { name: "차트 표시" }).textContent).toContain("목표 가격 203,000원");

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
    // 입력을 비워 다음 계획을 처음부터 (미리 보기·체크리스트가 사라진다)
    await waitFor(() => expect(screen.queryByRole("region", { name: "단타 미리 보기" })).toBeNull());
    expect((screen.getByLabelText("사는 가격") as HTMLInputElement).value).toBe("");
    expect(persuasionIn(document.body.textContent ?? "")).toEqual([]);
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
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    expect((screen.getByRole("button", { name: "모의 단타 계획 시작" }) as HTMLButtonElement).disabled).toBe(true);
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
});
