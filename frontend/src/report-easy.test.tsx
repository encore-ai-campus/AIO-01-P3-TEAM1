// 리포트 쉬운 보기 (주린이모드 켬): 목록(만들기 카드·한도·칩·카드), 상세(단계 막대·쉬운 진행·예시 재생·완성 화면·실패·보기 전환),
// 그리고 lib/reports.ts의 쉬운 문장·숫자 함수. 리포트는 아직 실제로 돌지 않으므로 가짜 API의 예시 리포트(db.addSampleReports)와 예시 재생으로 본다.
// bob·carol은 주린이모드 켬(진단 전), alice는 끔(전문가 보기). 시각은 고정한다 (2026-10-06 화요일 14:00 KST).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createChart } from "lightweight-charts";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReportDetail, ReportSummary, RiskPreview, TraceEvent } from "./api/types";
import { ResearchCards } from "./components/reports/easy/ResearchCards";
import { formatSignedKrw } from "./lib/format";
import { AI_REVIEW_NOTE, DISCLAIMER, OPINION_TEXT, REPORT_FAILURE_TEXT, REPORT_KEEPS_RUNNING } from "./lib/plainText";
import { SCENARIOS } from "./lib/reportExamples";
import * as lib from "./lib/reports";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";
import { freezeTime } from "./test/time";

const NOW = "2026-10-06T14:00:00+09:00"; // 화요일 장중 (KST)
/** NOW의 국내 기준일(가짜 API 달력은 평일만 — 10월 5일 월요일) 표기. */
const CLOSE_LABEL = "10월 5일(월) 15:30 장마감 기준";

/** 끝난 예시 리포트 셋: NAVER 완성(긍정적·추천 있음, 데이브) · LG에너지솔루션 완성(지켜보기, 에린) · 에코프로 실패(검토 실패, 밥). */
function samples() {
  db.addSampleReports();
  const all = db.listReports(null);
  const by = (symbol: string) => {
    const r = all.find((x) => x.symbol === symbol);
    if (!r) throw new Error(`no sample ${symbol}`);
    return r;
  };
  return { buy: by("035420"), hold: by("373220"), failed: by("086520") };
}

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const steps = () => within(screen.getByRole("list", { name: "진행 단계" })).getAllByRole("listitem");
const stepText = (i: number) => steps()[i].textContent ?? "";

// 차트 라이브러리 가짜(setupTests.ts)의 시리즈는 하나를 함께 쓴다
type FakeSeries = { createPriceLine: ReturnType<typeof vi.fn> };
const fakeSeries = () => (createChart(document.createElement("div")) as unknown as { addSeries: () => FakeSeries }).addSeries();

afterEach(() => {
  vi.unstubAllGlobals();
});

// docs/API.md 공통 규칙 "금지 표현"의 권유 목록 일부 (공백을 지우고 부분 문자열로 비교)
const PERSUASION = ["사세요", "사 볼 만", "매수하세요", "매수 기회", "지금 사면", "좋아요", "파세요", "팔아야", "매도하세요", "때문에", "오를 것", "내릴 것"];
const squash = (s: string) => s.replace(/\s+/g, "");
const persuasive = (text: string) => PERSUASION.filter((p) => squash(text).includes(squash(p)));

describe("쉬운 보기 — 리포트 목록", () => {
  it("만들기 카드·오늘 남은 횟수·칩, 카드에 AI 의견·한 줄 요약·상태 (장애 주입·작업 계획·개념 문서·선별은 숨김)", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    renderApp("/reports", "bob");

    expect(await screen.findByRole("button", { name: "AI 리포트 만들기" })).toBeTruthy();
    expect(await screen.findByText("오늘 3번 더 만들 수 있어요")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /장애 주입/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /작업 계획\(Planner\) 미리 보기/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /개념 문서/ })).toBeNull();
    expect(screen.queryByText("오늘의 선별 결과")).toBeNull();
    expect(screen.queryByText("Agent 실행은 아직 구현되지 않았습니다. 신청은 기록되고 구조만 볼 수 있습니다.")).toBeNull();

    const chips = screen.getByRole("group", { name: "리포트 묶음" });
    expect(within(chips).getAllByRole("button").map((b) => b.textContent)).toEqual(["내 리포트", "팀 리포트", "교차검증 분석"]);
    expect(within(chips).getByRole("button", { name: "팀 리포트" }).getAttribute("aria-pressed")).toBe("true");

    const list = await screen.findByRole("list", { name: "리포트 목록" });
    const card = (name: string) => within(list).getByRole("article", { name: `${name} 리포트` });
    // 긍정적 + 활성화할 수 있는 추천이 있으면 "실행 가능"
    await waitFor(() => expect(within(card("NAVER")).getByText("실행 가능")).toBeTruthy());
    expect(within(card("NAVER")).getByText("긍정적")).toBeTruthy();
    expect(within(card("NAVER")).getByText(buy.oneLiner ?? "-")).toBeTruthy();
    expect(within(card("LG에너지솔루션")).getByText("지켜보기")).toBeTruthy();
    expect(within(card("LG에너지솔루션")).getByText("완성")).toBeTruthy();
    expect(within(card("에코프로")).getByText("만들지 못함")).toBeTruthy();
    expect(within(card("에코프로")).getByText(/다시 만들 수 있어요/)).toBeTruthy();
    expect(within(card("에코프로")).queryByText("부정적")).toBeNull();
    // 추천이 있어도 완성 전이면 대기 중 (SK하이닉스 리포트는 신청됨)
    expect(within(card("SK하이닉스")).getByText("대기 중")).toBeTruthy();
    expect(within(card("SK하이닉스")).queryByText("실행 가능")).toBeNull();
    expect(card("NAVER").closest("a")?.getAttribute("href")).toBe(`/reports/${buy.id}`);
  });

  it("내 리포트 칩은 내가 만든 것만 (?mine=1), 교차검증 분석 칩은 분석 상세로 가는 목록 (점수·확률 없이)", async () => {
    freezeTime(NOW);
    samples();
    const asked: string[] = [];
    server.events.on("request:start", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/reports" || url.pathname === "/api/analyses") asked.push(`${url.pathname}${url.search}`);
    });
    renderApp("/reports", "bob");
    await screen.findByRole("list", { name: "리포트 목록" });

    click("내 리포트");
    await waitFor(() =>
      expect(
        within(screen.getByRole("list", { name: "리포트 목록" }))
          .getAllByRole("article")
          .map((a) => a.getAttribute("aria-label")),
      ).toEqual(["에코프로 리포트", "SK하이닉스 리포트"]),
    );
    expect(asked.some((u) => u.startsWith("/api/reports?") && u.includes("mine=1"))).toBe(true);

    click("교차검증 분석");
    const rows = within(await screen.findByRole("list", { name: "교차검증 분석 목록" })).getAllByRole("listitem");
    expect(rows.length).toBe(db.listAnalyses(null, null).length > 20 ? 20 : db.listAnalyses(null, null).length);
    const first = db.listAnalyses(null, null)[0];
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe(`/analyses/${first.id}`);
    expect(within(rows[0]).getByText(lib.CROSS_CHECK_TEXT[first.verdict].badge)).toBeTruthy();
    expect(within(rows[0]).queryByText(/점수/)).toBeNull();
    server.events.removeAllListeners();
  });

  it("한도를 다 쓰면 그 문장을 보이고 만들기 버튼을 막는다", async () => {
    freezeTime(NOW, { reportLimit: 0 });
    renderApp("/reports", "carol");
    expect(await screen.findByText("오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("종목 검색"), { target: { value: "현대" } });
    fireEvent.click(await screen.findByRole("button", { name: /현대차/ }));
    expect((screen.getByRole("button", { name: "AI 리포트 만들기" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("주린이모드 끔(alice)은 전문가 목록, '쉬운 보기'로 이 화면만 쉬운 목록", async () => {
    renderApp("/reports");
    expect(await screen.findByRole("switch", { name: /장애 주입/ })).toBeTruthy();
    click("쉬운 보기");
    await waitFor(() => expect(screen.queryByRole("switch", { name: /장애 주입/ })).toBeNull());
    expect(screen.getByRole("button", { name: "자세히 보기" })).toBeTruthy();
    expect(await screen.findByText("오늘 2번 더 만들 수 있어요")).toBeTruthy(); // 앨리스는 오늘 1개 신청
  });
});

describe("쉬운 보기 — 리포트 상세", () => {
  it("만들고 나면 쉬운 진행 표시: 단계 막대 ①, 다섯 단계, 닫아도 계속 만든다는 안내 (전문가 탭 없음)", async () => {
    freezeTime(NOW);
    renderApp("/reports", "carol");
    fireEvent.change(await screen.findByLabelText("종목 검색"), { target: { value: "현대" } });
    fireEvent.click(await screen.findByRole("button", { name: /현대차/ }));
    click("AI 리포트 만들기");
    expect(await screen.findByRole("heading", { name: "현대차 AI 리포트" })).toBeTruthy();

    const bar = within(screen.getByRole("list", { name: "리포트 단계" })).getAllByRole("listitem");
    expect(bar.map((li) => li.getAttribute("aria-current"))).toEqual(["step", null, null]);
    expect(screen.getByRole("heading", { name: "만들 차례를 기다리는 중이에요" })).toBeTruthy();
    expect(steps().map((li) => li.textContent)).toEqual([
      "시세를 보는 중기다리는 중",
      "재무제표를 읽는 중기다리는 중",
      "뉴스를 읽는 중기다리는 중",
      "리포트를 쓰는 중기다리는 중",
      "검토하는 중기다리는 중",
    ]);
    expect(screen.getByText(REPORT_KEEPS_RUNNING)).toBeTruthy();
    expect(screen.getByText(DISCLAIMER)).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "진행 기록" })).toBeNull();
    expect(screen.queryByText("Snapshot")).toBeNull();
  });

  it("AI 담당자 연결 전이면 예시 재생으로 진행 모습을 본다: 늦어진 AI를 다른 AI가 이어받는 문장 (서버에 보내지 않음)", async () => {
    freezeTime(NOW);
    const sent: string[] = [];
    renderApp("/reports/2", "bob");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    server.events.on("request:start", ({ request }) => {
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
    });

    click("예시로 보기: AI가 늦어지는 경우");
    click("멈춤");
    expect(screen.getByText("예시 데이터 — 실제 실행이 아닙니다")).toBeTruthy();
    for (let i = 0; i < 9; i++) click("다음 단계");
    // 뉴스: 두 번 늦어 다른 모델로 바꿔 시도하는 중
    expect(stepText(0)).toContain("지금 하는 중");
    expect(stepText(1)).toContain("끝났어요");
    expect(stepText(2)).toContain("지금 하는 중");
    expect(screen.queryByText("뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요")).toBeNull();

    for (let i = 0; i < 2; i++) click("다음 단계");
    expect(stepText(0)).toContain("끝났어요");
    expect(stepText(2)).toContain("끝났어요");
    expect(within(screen.getByRole("list", { name: "자동 복구" })).getByText("뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요")).toBeTruthy();

    for (let i = 0; i < 11; i++) click("다음 단계");
    expect(screen.getByRole("heading", { name: "예시 리포트가 완성됐어요" })).toBeTruthy();
    expect(steps().every((li) => (li.textContent ?? "").includes("끝났어요"))).toBe(true);
    expect((screen.getByRole("button", { name: "다음 단계" }) as HTMLButtonElement).disabled).toBe(true);

    click("예시 끄기");
    expect(screen.getByRole("heading", { name: "만들 차례를 기다리는 중이에요" })).toBeTruthy();
    expect(sent.filter((s) => !s.startsWith("GET"))).toEqual([]);
    server.events.removeAllListeners();
  });

  it("완성(긍정적): AI 의견 배지·한 줄 요약·신뢰 패널 → 쉬운 요약 3줄 → 근거·위험·틀리는 경우 → 시나리오(미리 보기 금액) → 차트 → PDF·면책", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    const rec = db.listRecommendations(2, { source: "report", sourceId: String(buy.id), status: "all" })[0];
    const preview: RiskPreview = db.riskPreview(2, rec.id, null);
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    renderApp(`/reports/${buy.id}`, "bob");

    expect(await screen.findByRole("heading", { name: "NAVER AI 리포트" })).toBeTruthy();
    expect(screen.getByText("AI 의견: 긍정적")).toBeTruthy();
    expect(screen.getByText(OPINION_TEXT.buy.line)).toBeTruthy();
    expect(screen.getByText(buy.oneLiner ?? "-")).toBeTruthy();
    // 단계: ① 끝, ② 지금 (검토·읽고 확인하기), ③ 아직
    const bar = within(screen.getByRole("list", { name: "리포트 단계" })).getAllByRole("listitem");
    expect(bar.map((li) => li.getAttribute("aria-current"))).toEqual([null, "step", null]);
    expect(bar[0].textContent).toContain("끝남");

    const trust = screen.getByRole("region", { name: "신뢰 정보" });
    expect(within(trust).getByText("검토 AI가 근거와 대조해 통과 · 인용 3개 · 10월 6일(화) 09:00 자료")).toBeTruthy();
    expect(within(trust).getByText(AI_REVIEW_NOTE)).toBeTruthy();
    expect(within(trust).getByText("검토 점수 86점 · 고쳐 쓴 횟수 0번")).toBeTruthy();

    expect(within(screen.getByRole("list", { name: "쉬운 요약 세 줄" })).getAllByRole("listitem")).toHaveLength(3);
    expect(within(screen.getByRole("list", { name: "근거" })).getAllByRole("listitem")).toHaveLength(3);
    // "손절 가격 아래로 … 다시 봐야" 위험은 "틀리는 경우"로 옮긴다
    expect(within(screen.getByRole("list", { name: "위험" })).getAllByRole("listitem")).toHaveLength(2);
    const wrong = screen.getByRole("list", { name: "이 의견이 틀리는 경우" });
    expect(within(wrong).getAllByRole("listitem")).toHaveLength(2);
    expect(wrong.textContent).toContain(`손절 가격(${rec.stopPrice.toLocaleString("ko-KR")}원) 아래로 내려가면 이 의견을 다시 봐야 해요`);
    expect(screen.getByText(/이 리포트가 인용한 자료 3개: DART 반기보고서 · KRX 일봉 · 연합뉴스/)).toBeTruthy();

    // 시나리오 세 칸: 리스크 미리 보기 금액 (안전장치가 정한 수량, 장마감 기준)
    expect(preview.quantity).toBeGreaterThan(0);
    const cases = await screen.findByRole("list", { name: "세 가지 경우" });
    expect(await within(cases).findByText(formatSignedKrw(preview.expectedProfitKrw))).toBeTruthy();
    expect(within(cases).getByText(formatSignedKrw(-preview.maxLossKrw))).toBeTruthy();
    expect(within(cases).getByText(`${rec.holdingDays}거래일 뒤`)).toBeTruthy();
    const scenarioCard = screen.getByRole("region", { name: "세 가지 경우" });
    expect(within(scenarioCard).getByText(CLOSE_LABEL)).toBeTruthy();
    expect(within(scenarioCard).getByText(`안전장치가 이 계좌로 정한 ${preview.quantity}주 기준 · 수수료·세금 반영`)).toBeTruthy();

    // 차트: 완성 일봉 + 사는·목표·손절 가격 선, 장마감 기준 표기
    expect(await screen.findByRole("img", { name: "일봉 차트와 계획 가격 선" })).toBeTruthy();
    await waitFor(() => expect(series.createPriceLine).toHaveBeenCalledTimes(3));
    expect(series.createPriceLine.mock.calls.map((c) => (c[0] as { title: string; price: number }).title)).toEqual(["목표 가격", "사는 가격", "손절 가격"]);
    expect(series.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ title: "손절 가격", price: rec.stopPrice }));
    expect(screen.getByRole("region", { name: "가격 흐름" }).querySelector("time")?.textContent).toBe(CLOSE_LABEL);

    // 조사 자료 요약: 시세 종가는 장마감 기준, 지표는 눌러서 풀이, 뉴스 출처 표기
    const research = screen.getByRole("region", { name: "조사 자료 요약" });
    expect(within(within(research).getByRole("region", { name: "시세" })).getByText(CLOSE_LABEL)).toBeTruthy();
    fireEvent.click(within(research).getByRole("button", { name: "PER" }));
    expect(screen.getByRole("tooltip").textContent).toContain("1주당 1년 순이익"); // 풀이 상자는 body에 뜬다
    expect(within(research).getByText("뉴스 제목: Google 뉴스 검색 결과(각 언론사)")).toBeTruthy();

    expect(screen.getByRole("link", { name: "PDF로 보기" }).getAttribute("href")).toBe(`/api/reports/${buy.id}/pdf`);
    expect(screen.getByText(DISCLAIMER)).toBeTruthy();
    // 쉬운 보기에서는 Agent 그래프·진행 기록·점수·확률이 없다
    expect(screen.queryByRole("tab", { name: "진행 기록" })).toBeNull();
    expect(screen.queryByText(/확률/)).toBeNull();
  });

  it("완성(지켜보기): 시나리오 세 칸이 없고 차트에 계획 가격 선이 없다", async () => {
    freezeTime(NOW);
    const { hold } = samples();
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    renderApp(`/reports/${hold.id}`, "bob");
    expect(await screen.findByText("AI 의견: 지켜보기")).toBeTruthy();
    expect(screen.getByText(OPINION_TEXT.hold.line)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "일봉 차트와 계획 가격 선" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "세 가지 경우" })).toBeNull();
    expect(series.createPriceLine).not.toHaveBeenCalled();
    expect(screen.queryByText("가로선은 AI가 제안한 사는 가격·목표 가격·손절 가격이에요.")).toBeNull();
    // 지켜보기에는 손절 문장 대신 위험에서 고른 문장
    const wrong = screen.getByRole("list", { name: "이 의견이 틀리는 경우" });
    expect(within(wrong).getAllByRole("listitem")).toHaveLength(1);
    expect(wrong.textContent).not.toContain("손절 가격(");
  });

  it("만들지 못한 리포트: 사유 코드의 쉬운 문장 + 다시 만들기 (같은 종목, 장애 주입 없이)", async () => {
    freezeTime(NOW);
    const { failed } = samples();
    renderApp(`/reports/${failed.id}`, "bob");
    expect(await screen.findByRole("heading", { name: "리포트를 만들지 못했어요" })).toBeTruthy();
    expect(screen.getByText(REPORT_FAILURE_TEXT.review_failed)).toBeTruthy();
    expect(screen.getByText("만들지 못한 리포트는 오늘 만들 수 있는 횟수에 세지 않아요.")).toBeTruthy();
    expect(await screen.findByText("오늘 3번 더 만들 수 있어요")).toBeTruthy();
    const bar = within(screen.getByRole("list", { name: "리포트 단계" })).getAllByRole("listitem");
    expect(bar[0].textContent).toContain("멈춤");

    click("다시 만들기");
    await waitFor(() => expect(db.listReports("086520")).toHaveLength(2));
    const made = db.listReports("086520")[0];
    expect(made.status).toBe("requested");
    expect(made.chaosEnabled).toBe(false);
    expect(await screen.findByRole("heading", { name: "만들 차례를 기다리는 중이에요" })).toBeTruthy();
  });

  it("'이 화면만 자세히 보기'로 전문가 화면(?view=expert), 탭을 옮겨도 그대로, '쉬운 보기'로 돌아온다", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    renderApp(`/reports/${buy.id}`, "bob");
    await screen.findByText("AI 의견: 긍정적");

    click("이 화면만 자세히 보기");
    expect(await screen.findByRole("tab", { name: "진행 기록" })).toBeTruthy();
    expect(screen.queryByText("AI 의견: 긍정적")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "자세히" }));
    expect(screen.getByRole("tab", { name: "자세히" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("region", { name: /^Shared State/ })).toBeTruthy(); // 여전히 전문가 보기

    click("쉬운 보기");
    expect(await screen.findByText("AI 의견: 긍정적")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "자세히" })).toBeNull();
  });

  it("주린이모드 끔(alice)은 전문가 화면이 기본, ?view=easy면 이 화면만 쉬운 보기", async () => {
    renderApp("/reports/2");
    expect(await screen.findByRole("tab", { name: "진행 기록" })).toBeTruthy();
    renderApp("/reports/2?view=easy");
    expect(await screen.findByRole("list", { name: "진행 단계" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "이 화면만 자세히 보기" })).toBeTruthy();
  });

  it("실제로 도는 리포트: Trace로 단계·자동 복구 문장, 지난 리포트들의 보통 걸린 시간", async () => {
    freezeTime(NOW);
    vi.stubGlobal("EventSource", undefined); // SSE 없이 Snapshot만
    const base = db.getReport(2);
    const at = (s: number) => `2026-10-06T13:5${s}:00+09:00`;
    const e = (step: number, actor: string, action: string, status: TraceEvent["status"], details: Record<string, unknown> = {}): TraceEvent => ({
      step,
      actor,
      action,
      status,
      provider: null,
      model: action === "agent_completed" && actor === "news_agent" ? "gpt-4.1-mini" : null,
      latencyMs: null,
      details,
      at: at(Math.min(step, 9)),
    });
    const running: ReportDetail = {
      ...base,
      status: "running",
      currentStep: "parallel_research",
      plan: { ...base.plan, implemented: true },
      state: { ...base.state, status: "running", currentStep: "parallel_research" },
      trace: [
        e(1, "orchestrator", "workflow_started", "started"),
        e(2, "market_agent", "agent_started", "started"),
        e(3, "news_agent", "agent_started", "started"),
        e(4, "market_agent", "agent_completed", "completed"),
        e(5, "news_agent", "agent_failed", "failed", { errorType: "server_error", final: false }),
        e(6, "news_agent", "agent_retry", "started", { attempt: 2 }),
        e(7, "news_agent", "agent_completed", "completed", { recovered: true }),
        e(8, "fundamental_agent", "agent_started", "started"),
      ],
    };
    const done = (id: number, startMin: number, mins: number): ReportSummary => ({
      ...db.listReports(null)[0],
      id,
      status: "completed",
      startedAt: `2026-10-05T10:${String(startMin).padStart(2, "0")}:00+09:00`,
      finishedAt: `2026-10-05T10:${String(startMin + mins).padStart(2, "0")}:00+09:00`,
    });
    server.use(
      http.get("*/api/reports/:id", ({ params }) => (params.id === "2" ? HttpResponse.json(running) : undefined)),
      http.get("*/api/reports", () => HttpResponse.json({ count: 3, results: [done(201, 0, 1), done(202, 10, 3), done(203, 20, 2)] })),
    );
    renderApp("/reports/2", "bob");

    expect(await screen.findByRole("heading", { name: "리포트를 만드는 중이에요" })).toBeTruthy();
    expect(stepText(0)).toContain("끝났어요");
    expect(stepText(1)).toContain("지금 하는 중");
    expect(stepText(2)).toContain("끝났어요");
    expect(stepText(3)).toContain("기다리는 중");
    expect(steps()[1].getAttribute("aria-current")).toBe("step");
    expect(screen.getByText("뉴스를 읽는 AI가 제대로 답하지 못해 한 번 더 시도해 끝냈어요")).toBeTruthy();
    expect(await screen.findByText("지난 리포트들은 보통 2분쯤 걸렸어요")).toBeTruthy();
    // 연결된 뒤에는 예시 버튼을 보이지 않는다
    expect(screen.queryByRole("button", { name: /예시로 보기/ })).toBeNull();
  });
});

describe("lib/reports 쉬운 보기 함수", () => {
  const recovery = SCENARIOS.find((s) => s.id === "recovery")?.frames.map((f) => f.event) ?? [];
  const normal = SCENARIOS.find((s) => s.id === "normal")?.frames.map((f) => f.event) ?? [];
  const ev = (step: number, actor: string, action: string, status: TraceEvent["status"], details: Record<string, unknown> = {}): TraceEvent => ({
    step,
    actor,
    action,
    status,
    provider: null,
    model: null,
    latencyMs: null,
    details,
    at: `2026-10-05T01:00:0${step}Z`,
  });

  it("progressOf: 담당자의 마지막 사건으로 다섯 단계 상태 (검토 RETRY로 다시 쓰면 다시 '지금 하는 중')", () => {
    expect(lib.progressOf([]).map((s) => s.state)).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
    expect(lib.progressOf(recovery).map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(lib.progressOf(recovery).find((s) => s.actor === "news_agent")?.recovered).toBe(true);
    // 예시 ③의 17번째 사건(review_retry) 뒤 다시 작성 시작
    expect(lib.progressOf(recovery.slice(0, 18)).map((s) => s.state)).toEqual(["done", "done", "done", "active", "done"]);
    // 예시 ①: 선택 Worker(뉴스) 실패, 리포트 작성 전
    expect(lib.progressOf(normal.slice(0, 7)).map((s) => s.state)).toEqual(["done", "done", "failed", "waiting", "waiting"]);
    expect(lib.progressOf([ev(1, "report_agent", "agent_skipped", "skipped")])[3].state).toBe("skipped");
  });

  it("recoverySentences: 다른 AI로 바꿈 · 같은 AI로 다시 · 끝내 못 함", () => {
    expect(lib.recoverySentences(recovery)).toEqual(["뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요"]);
    expect(lib.recoverySentences(normal)).toEqual(["뉴스를 읽는 AI가 끝내 답하지 못해 그 자료 없이 진행했어요"]);
    const retried = [
      ev(1, "market_agent", "agent_started", "started"),
      ev(2, "market_agent", "agent_failed", "failed", { errorType: "timeout", final: false }),
      ev(3, "market_agent", "agent_retry", "started"),
      ev(4, "market_agent", "agent_completed", "completed"),
      ev(5, "join_guard", "join_completed", "completed"),
    ];
    expect(lib.recoverySentences(retried)).toEqual(["시세를 보는 AI가 늦어 한 번 더 시도해 끝냈어요"]);
    expect(lib.recoverySentences([ev(1, "market_agent", "agent_started", "started"), ev(2, "market_agent", "agent_completed", "completed")])).toEqual([]);
  });

  it("trustOf: 검토 통과·점수·고쳐 쓴 횟수·인용 수·자료 시각(시세 AI가 끝낸 시각)", () => {
    const results = {
      report_agent: { verdict: "buy", citations: ["A", "B"], plainSummary: ["가"], reasons: [], risks: [], targets: {} },
      review_agent: { verdict: "PASS", score: 84 },
    };
    const t = lib.trustOf({ results }, recovery);
    expect(t).toMatchObject({ reviewed: true, score: 84, rewrites: 1, citations: 2, dataAt: recovery[9].at });
    expect(t.recovery).toEqual(["뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요"]);
    // 결과에 검토가 없으면 Trace의 마지막 검토 판정
    expect(lib.trustOf({ results: {} }, recovery).reviewed).toBe(true);
    expect(lib.trustOf({ results: { review_agent: { verdict: "RETRY" } } }, []).reviewed).toBe(false);
    expect(lib.dataTimeText("2026-10-05T16:30:00Z")).toBe("10월 6일(화) 01:30 자료"); // UTC → 한국 시간
    expect(lib.dataTimeText(null)).toBe("자료 시각 모름");
  });

  it("draftOf·opinionOf: 모양이 틀린 값은 비우고, 의견은 완성된 리포트만", () => {
    const state = { results: { report_agent: { verdict: "sell", oneLiner: " 한 줄 ", plainSummary: ["가", 3, "", "나", "다", "라"], targets: { entry: "1", stop: 9 } } } };
    const d = lib.draftOf(state);
    expect(d).toMatchObject({ verdict: null, oneLiner: "한 줄", plainSummary: ["가", "나", "다"], reasons: [], targets: { entry: null, stop: 9, target: null } });
    expect(lib.draftOf({ results: {} })).toBeNull();
    const r = { status: "completed" as const, opinion: null, oneLiner: null, state: { ...db.getReport(2).state, results: { report_agent: { verdict: "hold", oneLiner: "x" } } } };
    expect(lib.opinionOf(r)).toBe("hold");
    expect(lib.oneLinerOf(r)).toBe("x");
    expect(lib.opinionOf({ ...r, status: "running" })).toBeNull();
    expect(lib.opinionOf({ ...r, opinion: "buy" })).toBe("buy");
  });

  it("scenarioOf: 미리 보기 수량이 있으면 계좌 금액, 없으면 1주 비율, 가격 순서가 틀리면 없음", () => {
    const t = { entry: 10_000, target: 11_000, stop: 9_600, holdingDays: 7, probability: null };
    const p = { quantity: 5, expectedProfitKrw: 4_700, maxLossKrw: 2_300, lastPriceAsOf: "2026-10-05T15:30:00+09:00" } as RiskPreview;
    expect(lib.scenarioOf(t, p, 10)).toEqual({ basis: "account", gain: "+4,700원", loss: "-2,300원", quantity: 5, holdingDays: 10, asOf: p.lastPriceAsOf });
    expect(lib.scenarioOf(t, { ...p, quantity: 0 }, null)).toEqual({ basis: "share", gain: "+10.00%", loss: "-4.00%", quantity: null, holdingDays: 7, asOf: null });
    expect(lib.scenarioOf({ ...t, stop: 10_500 }, p, 10)).toBeNull();
    expect(lib.scenarioOf({ ...t, target: null }, p, 10)).toBeNull();
  });

  it("splitSource·whenWrongOf: 끝에 붙은 출처, 틀리는 경우로 옮길 위험 하나", () => {
    expect(lib.splitSource("매출이 늘었다 (출처: DART 반기보고서)")).toEqual({ text: "매출이 늘었다", source: "DART 반기보고서" });
    expect(lib.splitSource("거래대금 증가 [근거: KRX 일봉]")).toEqual({ text: "거래대금 증가", source: "KRX 일봉" });
    expect(lib.splitSource("출처 없음")).toEqual({ text: "출처 없음", source: null });
    expect(lib.whenWrongOf({ risks: ["환율", "70,000원 아래로 내려가면 다시 봐야 한다", "업황"] })).toEqual({
      risk: "70,000원 아래로 내려가면 다시 봐야 한다",
      others: ["환율", "업황"],
    });
    expect(lib.whenWrongOf({ risks: ["환율"] })).toEqual({ risk: null, others: ["환율"] });
  });

  it("typicalDurationMs: 최근 완성 리포트의 중앙값, 3건 미만이면 없음", () => {
    const r = (status: ReportSummary["status"], start: string | null, end: string | null) => ({ status, startedAt: start, finishedAt: end });
    const at = (m: number) => `2026-10-05T10:${String(m).padStart(2, "0")}:00+09:00`;
    expect(lib.typicalDurationMs([r("completed", at(0), at(1)), r("completed", at(2), at(4))])).toBeNull();
    expect(lib.typicalDurationMs([r("completed", at(0), at(1)), r("completed", at(2), at(5)), r("completed", at(10), at(12)), r("failed", at(0), at(30))])).toBe(120_000);
    expect(lib.typicalDurationMs([r("completed", at(0), at(1)), r("completed", at(2), at(5)), r("completed", at(10), at(12)), r("completed", at(20), at(24))])).toBe(150_000);
    // 최근 take개만
    expect(lib.typicalDurationMs([r("completed", at(0), at(9)), r("completed", at(10), at(11)), r("completed", at(20), at(21)), r("completed", at(30), at(31))], 3)).toBe(60_000);
    expect(lib.durationSentence(150_000)).toBe("지난 리포트들은 보통 3분쯤 걸렸어요");
    expect(lib.durationSentence(10_000)).toBe("지난 리포트들은 보통 1분쯤 걸렸어요");
  });

  it("단계 막대·목록 상태·한도 문장, 그리고 새 문장에 권유·단정 표현이 없다", () => {
    expect(lib.stepsOf("requested", false)).toEqual(["current", "todo", "todo"]);
    expect(lib.stepsOf("failed", false)).toEqual(["failed", "todo", "todo"]);
    expect(lib.stepsOf("completed", false)).toEqual(["done", "current", "todo"]);
    expect(lib.stepsOf("completed", true)).toEqual(["done", "done", "done"]);
    expect(lib.reportCardStatus("completed", true)).toBe("ready");
    expect(lib.reportCardStatus("running", true)).toBe("running");
    expect(lib.quotaSentence({ remaining: 2 })).toBe("오늘 2번 더 만들 수 있어요");
    expect(lib.quotaSentence({ remaining: 0 })).toBe("오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요");

    const copy = [
      ...Object.values(lib.REPORT_CARD_TEXT).flatMap((x) => [x.label, x.sentence]),
      ...Object.values(lib.CROSS_CHECK_TEXT).flatMap((x) => [x.badge, x.line]),
      ...Object.values(lib.PROGRESS_STATE_TEXT),
      ...lib.PROGRESS_STEPS.map((s) => s.label),
      ...lib.recoverySentences(recovery),
      ...lib.recoverySentences(normal),
    ];
    for (const line of copy) expect(persuasive(line), line).toEqual([]);
  });
});

describe("조사 자료 요약 — 시세 기준 시각", () => {
  const market = (asOf: string | null): lib.MarketView => ({ summary: null, price: 71_300, changePct: null, asOf, rsi: 55, volatilityPct: 1.2, signals: [] });
  const show = (asOf: string | null) => {
    render(<ResearchCards market={market(asOf)} fundamental={null} news={null} marketCode="KR" currency="KRW" />);
    return screen.getByRole("region", { name: "시세" });
  };

  it("asOf가 있으면 종가와 장마감 기준 시각", () => {
    const box = show("2026-10-05T15:30:00+09:00");
    expect(box.textContent).toContain("71,300원");
    expect(within(box).getByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
  });

  it.each([null, "어제"])("asOf가 %s이면 가격을 보이지 않고 기준 시각 자료 없음 (PDF와 같다)", (asOf) => {
    const box = show(asOf);
    expect(box.textContent).not.toContain("71,300");
    expect(box.textContent).not.toContain("장마감 기준");
    expect(within(box).getByText("시세 기준 시각: 자료 없음")).toBeTruthy();
  });
});
