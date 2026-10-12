// 리포트 쉬운 보기 (주린이모드 켬): 목록(만들기 카드·한도·칩·카드), 상세(단계 막대·쉬운 진행·예시 재생·완성 화면·실패·보기 전환),
// 그리고 lib/reports.ts의 쉬운 문장·숫자 함수. 리포트는 아직 실제로 돌지 않으므로 가짜 API의 예시 리포트(db.addSampleReports)와 예시 재생으로 본다.
// bob·carol은 주린이모드 켬(진단 전), alice는 끔(전문가 보기). 시각은 고정한다 (2026-10-06 화요일 14:00 KST).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createChart } from "lightweight-charts";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { keys } from "../api/queries";
import type { Market, QuoteBasis, ReportDetail, ReportSummary, RiskPreview, TraceEvent } from "../api/types";
import { ResearchCards } from "../components/reports/easy/ResearchCards";
import { AI_REVIEW_NOTE, DISCLAIMER, OPINION_TEXT, REPORT_FAILURE_TEXT, REPORT_KEEPS_RUNNING } from "../lib/plainText";
import { SCENARIOS } from "../lib/reportExamples";
import * as lib from "../lib/reports";
import { setThemePref } from "../lib/theme";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

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

/**
 * 이 리포트의 계획을 안전장치가 막은 것으로 바꿔 본다 (손익비 기준 미만). 가짜 API의 예시 계획(목표 +12%)은 기본으로 통과하므로
 * 막힌 경우를 보는 테스트가 미리 보기 응답만 바꾼다 — 금액·수량은 그대로라 막힌 이유가 숫자로 보인다.
 */
function blockPreview(recId: number): RiskPreview {
  const blocked: RiskPreview = { ...db.riskPreview(2, recId, null), approved: false, activatable: false, reasons: ["손익비 부족"], reasonCodes: ["reward_risk_low"] };
  server.use(http.get("*/api/recommendations/:id/preview", ({ params }) => (Number(params.id) === recId ? HttpResponse.json(blocked) : undefined)));
  return blocked;
}
const recOf = (reportId: number) => db.listRecommendations(2, { source: "report", sourceId: String(reportId), status: "all" })[0];

const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const steps = () => within(screen.getByRole("list", { name: "진행 단계" })).getAllByRole("listitem");
const stepText = (i: number) => steps()[i].textContent ?? "";

// 차트 라이브러리 가짜(setupTests.ts)의 시리즈는 하나를 함께 쓴다
type FakeSeries = { createPriceLine: ReturnType<typeof vi.fn>; applyOptions: ReturnType<typeof vi.fn> };
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
    blockPreview(recOf(buy.id).id);
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
    // 계획이 있어도 안전장치가 지금 막으면(위에서 손익비 기준 미만으로 바꿔 둠) '실행 가능'이 아니다 — 상세의 '실행할 수 없어요'와 같은 판단
    await waitFor(() => expect(within(card("NAVER")).getByText(lib.PLAN_NOTE.blocked)).toBeTruthy());
    expect(within(card("NAVER")).getByText("완성")).toBeTruthy();
    expect(within(card("NAVER")).queryByText("실행 가능")).toBeNull();
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
    // 완성 카드는 칩만 (같은 문장을 카드마다 되풀이하지 않는다)
    expect(card("LG에너지솔루션").textContent).not.toContain("다 만들었어요");
    // 만드는 중인 내 리포트 띠: 탭의 점을 보고 들어온 사람의 목적지 (밥의 SK하이닉스 — 대기 중)
    const making = screen.getByRole("list", { name: "만드는 중인 내 리포트" });
    expect(within(making).getByRole("link", { name: "SK하이닉스 리포트 진행 보기" }).getAttribute("href")).toMatch(/^\/reports\/\d+$/);
  });

  it("목록의 '실행 가능'은 상세와 같은 판단: 안전장치가 허락하는 계획만, 내 모의 자동매매가 진행 중이면 그 계획으로 바로", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    const rec = recOf(buy.id);
    // 가짜 API의 예시 계획(목표 +12%)은 안전장치가 허락한다 — 바꾸지 않고 그대로 본다
    expect(db.riskPreview(2, rec.id, null).activatable).toBe(true);
    const first = renderApp("/reports", "bob");
    const naver = (list: HTMLElement) => within(list).getByRole("article", { name: "NAVER 리포트" });
    const list = await screen.findByRole("list", { name: "리포트 목록" });
    await waitFor(() => expect(within(naver(list)).getByText("실행 가능")).toBeTruthy());
    expect(within(naver(list)).getByText(lib.REPORT_CARD_TEXT.ready.sentence)).toBeTruthy();
    first.unmount();

    // 이 리포트로 내 모의 자동매매가 진행 중이면: 칩은 '완성', 문장과 계획 바로가기 (미리 보기는 부르지 않는다)
    server.use(http.get("*/api/recommendations", () => HttpResponse.json({ count: 1, results: [{ ...rec, myPlan: { id: 999, status: "holding" } }] })));
    renderApp("/reports", "bob");
    const list2 = await screen.findByRole("list", { name: "리포트 목록" });
    await waitFor(() => expect(within(naver(list2)).getByText(lib.PLAN_NOTE.live)).toBeTruthy());
    expect(within(naver(list2)).getByText("완성")).toBeTruthy();
    expect(within(list2).getByRole("link", { name: "내 모의 자동매매 보기" }).getAttribute("href")).toBe("/plans/999");
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
    expect(screen.getByRole("button", { name: "전문가 보기" })).toBeTruthy(); // 머리의 좁은 전환 칩: 누르면 갈 보기 이름
    expect(await screen.findByText("오늘 2번 더 만들 수 있어요")).toBeTruthy(); // 앨리스는 오늘 1개 신청
  });
});

describe("쉬운 보기 — 리포트 상세", () => {
  it("만들고 나면 쉬운 진행 표시: 단계 막대 ①, 다섯 단계, 닫아도 계속 만든다는 안내 (전문가 탭 없음)", async () => {
    freezeTime(NOW);
    renderApp("/reports", "carol");
    fireEvent.change(await screen.findByLabelText("종목 검색"), { target: { value: "현대" } });
    fireEvent.click(await screen.findByRole("button", { name: /현대차/ }));
    // 고른 종목의 오늘 리포트를 확인하는 동안은 막혀 있다
    const make = screen.getByRole("button", { name: "AI 리포트 만들기" }) as HTMLButtonElement;
    await waitFor(() => expect(make.disabled).toBe(false));
    fireEvent.click(make);
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
    // 기다리는 사람이 먼저 묻는 것: 얼마나 기다렸나 · 진행 막대(n/5, 단계 목록 밖) · 화면 읽기용 알림
    // 기다린 시간은 늘 신청 시각 기준 한 문장 (시작 시각으로 기준을 바꾸지 않는다 — UX-7)
    expect(screen.getByText("신청한 지 1분이 안 됐어요")).toBeTruthy();
    const progress = screen.getByRole("progressbar", { name: "리포트 만들기 진행" });
    expect([progress.getAttribute("aria-valuenow"), progress.getAttribute("aria-valuemax")]).toEqual(["0", "5"]);
    expect(screen.getByText("진행 0/5").getAttribute("aria-live")).toBe("polite");
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
    // 검토 뒤 다시 쓰기(리포트를 쓰는 중이 다시 '지금')가 있었어도 진행 막대는 뒤로 가지 않고 끝까지 찬다
    expect(screen.getByRole("progressbar", { name: "리포트 만들기 진행" }).getAttribute("aria-valuenow")).toBe("5");
    expect((screen.getByRole("button", { name: "다음 단계" }) as HTMLButtonElement).disabled).toBe(true);

    click("예시 끄기");
    expect(screen.getByRole("heading", { name: "만들 차례를 기다리는 중이에요" })).toBeTruthy();
    expect(sent.filter((s) => !s.startsWith("GET"))).toEqual([]);
    server.events.removeAllListeners();
  });

  it("검토 뒤 다시 쓰는 동안 진행 막대는 4/5에서 기다리고(끝남으로 보이지 않게), 다 만들면 5/5 — 화면 읽기 알림도 같은 숫자", async () => {
    freezeTime(NOW);
    renderApp("/reports/2", "bob");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    click("예시로 보기: AI가 늦어지는 경우");
    click("멈춤");
    const bar = () => screen.getByRole("progressbar", { name: "리포트 만들기 진행" }).getAttribute("aria-valuenow");
    const seen: number[] = [];
    const next = () => {
      click("다음 단계");
      seen.push(Number(bar()));
    };
    // 검토가 RETRY를 낸 뒤 '리포트를 쓰는 중'이 다시 지금 단계가 될 때까지 넘긴다: 쓰기 단계 아래에 까닭 한 줄,
    // 검토 단계는 '끝났어요'가 아니라 '고친 글을 다시 봐요' (UX-7 — 끝난 단계가 말없이 '지금 하는 중'으로 돌아가 보이지 않게)
    const rewriting = () => stepText(3).includes("지금 하는 중") && stepText(3).includes(lib.rewriteNoteOf());
    for (let i = 0; i < 30 && !rewriting(); i++) next();
    expect(rewriting()).toBe(true);
    expect(stepText(4)).toContain("고친 글을 다시 봐요");
    expect(stepText(4)).not.toContain("끝났어요");
    expect(bar()).toBe("4");
    expect(screen.getByText(`지금: 리포트를 쓰는 중 (4/5) · ${lib.rewriteNoteOf()}`)).toBeTruthy();
    for (let i = 0; i < 30 && !screen.queryByRole("heading", { name: "예시 리포트가 완성됐어요" }); i++) next();
    expect(bar()).toBe("5");
    // 단계 수는 줄었다 늘었다 하지 않는다
    expect(seen.every((n, i) => i === 0 || n >= seen[i - 1])).toBe(true);
    expect(screen.getByText("다섯 단계를 모두 끝냈어요 (5/5)")).toBeTruthy();
  });

  it("완성(긍정적): AI 의견 배지·한 줄 요약·신뢰 패널 → 쉬운 요약 3줄 → 근거·위험·틀리는 경우 → 시나리오(미리 보기 금액) → 차트 → PDF·면책", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    const rec = recOf(buy.id);
    // 막힌 계획으로 본다: 안전장치가 막아도 금액은 그대로 보이고 '정했다'고 하지 않는다 (정상 흐름은 아래 '실행 준비' 테스트)
    const preview = blockPreview(rec.id);
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    renderApp(`/reports/${buy.id}`, "bob");

    expect(await screen.findByRole("heading", { name: "NAVER AI 리포트" })).toBeTruthy();
    expect(screen.getByText("AI 의견: 긍정적")).toBeTruthy();
    expect(screen.getByText(OPINION_TEXT.buy.line)).toBeTruthy();
    // 한 줄 요약 (AI 글 — 용어 풀이가 붙어 글자가 나뉠 수 있어 글 전체로 본다)
    expect(screen.getByRole("region", { name: "AI 의견" }).textContent).toContain(buy.oneLiner ?? "-");
    // 단계: ① 끝, ② 지금 (검토·읽고 확인하기), ③ 아직 — 안전장치가 막은 계획은 나중에 풀릴 수 있어 '없음'이 아니라 '아직'
    const bar = within(screen.getByRole("list", { name: "리포트 단계" })).getAllByRole("listitem");
    expect(bar.map((li) => li.getAttribute("aria-current"))).toEqual([null, "step", null]);
    expect(bar[0].textContent).toContain("끝남");
    expect(bar[2].textContent).toContain("아직");
    // 머리의 다음 행동 안내는 매매 계획 카드와 같은 말 (이 테스트는 손익비 기준 미만으로 막힘)
    expect(await screen.findByText(lib.planGuide("blocked") ?? "-")).toBeTruthy();
    expect(screen.queryByText(lib.planGuide("ready") ?? "-")).toBeNull();

    const trust = screen.getByRole("region", { name: "신뢰 정보" });
    expect(within(trust).getByText("검토 AI가 근거와 대조해 통과 · 인용 3개 · 10월 6일(화) 09:00 자료")).toBeTruthy();
    expect(within(trust).getByText(AI_REVIEW_NOTE)).toBeTruthy();
    expect(within(trust).getByText("검토 점수 86점 · 고쳐 쓴 횟수 0번")).toBeTruthy();

    expect(within(screen.getByRole("list", { name: "쉬운 요약 세 줄" })).getAllByRole("listitem")).toHaveLength(3);
    expect(within(screen.getByRole("list", { name: "근거" })).getAllByRole("listitem")).toHaveLength(3);
    // 프롬프트 형식의 "틀리는 경우" 위험("○○원 아래로 내려가거나 … 다시 봐야 해요")은 위험 목록에서 "틀리는 경우"로 옮긴다.
    // 가격 조건은 코드가 만든 손절 문장이 말하고, AI 문장은 다른 조건(실적 발표)이 붙어 있어 함께 보인다 (가격만 말하면 합친다 — lib.priceOnlyRisk)
    expect(within(screen.getByRole("list", { name: "위험" })).getAllByRole("listitem")).toHaveLength(2);
    const wrong = screen.getByRole("list", { name: "이 의견이 틀리는 경우" });
    const stopWon = `${rec.stopPrice.toLocaleString("ko-KR")}원`;
    expect(within(wrong).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      `가격이 손절 가격(${stopWon}) 아래로 내려가면 이 의견을 다시 봐야 해요`,
      // AI 문장 앞의 같은 가격 조건은 떼고 다른 조건만 (손절가를 두 번 보이지 않게)
      "다음 실적 발표가 기대보다 나쁘면 의견을 다시 봐야 해요",
    ]);
    expect(wrong.textContent?.split(stopWon)).toHaveLength(2);
    expect(wrong.textContent).not.toContain("다시 봐야 한다");
    expect(screen.getByText(/이 리포트가 인용한 자료 3개: DART 반기보고서 · KRX 일봉 · 연합뉴스/)).toBeTruthy();

    // 시나리오 세 칸: 넣을 돈은 실행 확인에서 정하므로(2026-10-11 DECISIONS 28장) 금액 없는 리스크 미리 보기는 0주다 —
    // 계좌 금액 대신 1주 기준 비율(비용 전)로 보인다 (lib/reports.ts scenarioOf, 매매 계획 카드와 같은 말)
    expect(preview.quantity).toBe(0);
    const cases = await screen.findByRole("list", { name: "세 가지 경우" });
    expect(await within(cases).findByText(/^\+\d+\.\d{2}%$/)).toBeTruthy();
    expect(within(cases).getByText(/^-\d+\.\d{2}%$/)).toBeTruthy();
    expect(within(cases).queryByText(/원$/)).toBeNull();
    expect(within(cases).getByText(`${rec.holdingDays}거래일 뒤`)).toBeTruthy();
    const scenarioCard = screen.getByRole("region", { name: "세 가지 경우" });
    expect(within(scenarioCard).getByText("1주 기준 비율 · 수수료·세금 빼기 전")).toBeTruthy();

    // 계획 미니의 '자세히'는 다른 화면으로 나가지 않고 아래 매매 계획 카드로 내려간다 (포커스도 그 카드로)
    const mini = screen.getByLabelText("계획 미니");
    fireEvent.click(within(mini).getByRole("button", { name: /자세히/ }));
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "매매 계획" }));

    // 차트: 일봉(오늘 장중이면 진행 중인 봉까지) + 사는·목표·손절 가격 선(범례에 이름과 값), 실시간 기준 표기
    expect(await screen.findByRole("img", { name: "종가 선 차트와 계획 가격 선" })).toBeTruthy();
    const legend = screen.getByRole("list", { name: "차트의 가로선" });
    expect(within(legend).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      `목표 가격 ${rec.targetPrice.toLocaleString("ko-KR")}원`,
      `사는 가격 ${rec.entryPrice.toLocaleString("ko-KR")}원`,
      `손절 가격 ${rec.stopPrice.toLocaleString("ko-KR")}원`,
    ]);
    await waitFor(() => expect(series.createPriceLine).toHaveBeenCalledTimes(3));
    expect(series.createPriceLine.mock.calls.map((c) => (c[0] as { title: string; price: number }).title)).toEqual(["목표 가격", "사는 가격", "손절 가격"]);
    expect(series.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ title: "손절 가격", price: rec.stopPrice }));
    // 마지막 봉이 오늘 진행 중이라 기준 표시는 시세를 받은 시각 (KST)
    expect(screen.getByRole("region", { name: "가격 흐름" }).querySelector("time")?.textContent).toMatch(/^실시간 · 14:0\d:\d{2}$/);

    // 조사 자료 요약: 시세 종가는 장마감 기준, 지표 칸은 "어려운 숫자 보기"에 접혀 있고(UX-4) 눌러서 풀이, 뉴스 출처 표기
    const research = screen.getByRole("region", { name: "조사 자료 요약" });
    expect(within(within(research).getByRole("region", { name: "시세" })).getByText(CLOSE_LABEL)).toBeTruthy();
    expect(within(research).queryByLabelText("재무 지표")).toBeNull();
    fireEvent.click(within(research).getByRole("button", { name: "어려운 숫자 보기" }));
    fireEvent.click(within(within(research).getByLabelText("재무 지표")).getByRole("button", { name: "PER" }));
    expect(screen.getByRole("tooltip").textContent).toContain("1주당 1년 순이익"); // 풀이 상자는 body에 뜬다
    expect(within(research).getByText("뉴스 제목: Google 뉴스 검색 결과(각 언론사)")).toBeTruthy();

    expect(screen.getByRole("button", { name: "PDF로 보기" })).toBeTruthy();
    expect(screen.getByText(DISCLAIMER)).toBeTruthy();
    // 다크에서도 읽히게: 반전 번호 원은 text-on-ink (흰 글자 고정이면 다크의 밝은 원 위에서 사라진다)
    const num = within(screen.getByRole("list", { name: "쉬운 요약 세 줄" })).getByText("1");
    expect(num.className).toContain("text-on-ink");
    expect(num.className).not.toContain("text-white");
    // 쉬운 보기에서는 Agent 그래프·진행 기록·점수·확률이 없다
    expect(screen.queryByRole("tab", { name: "진행 기록" })).toBeNull();
    expect(screen.queryByText(/확률/)).toBeNull();
  });

  it("틀리는 경우: 손절 가격만 말하는 문장만 합치고, 환율·매출·원자재처럼 '원'이 든 다른 조건은 지우거나 자르지 않는다", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    const draft = db.getReport(buy.id).state.results.report_agent as { risks: string[]; targets: { stop: number } };
    const stopLine = `가격이 손절 가격(${draft.targets.stop.toLocaleString("ko-KR")}원) 아래로 내려가면 이 의견을 다시 봐야 해요`;
    const show = async (risks: string[]) => {
      draft.risks = risks;
      const view = renderApp(`/reports/${buy.id}`, "bob");
      await screen.findByText("AI 의견: 긍정적");
      const items = (name: string) => {
        const list = screen.queryByRole("list", { name });
        return list ? within(list).getAllByRole("listitem").map((li) => li.textContent) : [];
      };
      const out = { risks: items("위험"), wrong: items("이 의견이 틀리는 경우") };
      view.unmount();
      return out;
    };
    const industry = "업황 지표가 나빠지면 실적 기대가 줄 수 있다";
    const fx = "원/달러 환율이 1,450원을 넘으면 광고 매출 환산이 줄어 의견을 다시 판단해야 해요";
    const sales = "광고 매출이 분기 1조원 아래로 떨어지거나 금리가 오르면 의견을 다시 봐야 해요";
    // 환율 문장(손절 가격과 다른 금액)은 틀리는 경우로 옮겨 원문 그대로, 매출 문장은 위험 목록에 그대로 — 어느 것도 사라지지 않는다
    expect(await show([industry, fx, sales])).toEqual({ risks: [industry, sales], wrong: [stopLine, fx] });
    // 매출 조건('1조원 아래로 떨어지거나')은 손절 가격 조건이 아니라 떼지 않는다
    expect(await show([industry, "경쟁 심화", sales])).toEqual({ risks: [industry, "경쟁 심화"], wrong: [stopLine, sales] });
    const raw = "원자재 가격이 오르면 이 의견을 다시 봐야 해요";
    expect(await show([industry, raw, "경쟁 심화"])).toEqual({ risks: [industry, "경쟁 심화"], wrong: [stopLine, raw] });
    // 손절 가격만 말하는 문장은 코드의 손절 문장과 같은 뜻이라 합친다 (같은 가격을 두 번 말하지 않게)
    const same = `주가가 ${draft.targets.stop.toLocaleString("ko-KR")}원 아래로 내려가면 의견을 다시 봐야 해요`;
    expect(await show([industry, "경쟁 심화", same])).toEqual({ risks: [industry, "경쟁 심화"], wrong: [stopLine] });
  });

  // 추천이 아직 없는 리포트 (추천 수집 전·추천을 만들 수 없음): 이 리포트의 추천 목록만 비운다
  const withoutRecommendation = (reportId: number) =>
    server.use(
      http.get("*/api/recommendations", ({ request }) => {
        const sp = new URL(request.url).searchParams;
        return sp.get("source") === "report" && sp.get("sourceId") === String(reportId) ? HttpResponse.json({ count: 0, results: [] }) : undefined;
      }),
    );
  const setDraft = (reportId: number, targets: Record<string, number | null>, risks: string[]) => {
    const draft = db.getReport(reportId).state.results.report_agent as { risks: string[]; targets: Record<string, number | null> };
    draft.targets = targets;
    draft.risks = risks;
  };
  const itemsOf = (name: string) => {
    const list = screen.queryByRole("list", { name });
    return list ? within(list).getAllByRole("listitem").map((li) => li.textContent) : null;
  };

  it("추천이 없으면 제안 가격을 추천처럼 호가 단위로 내린 값 하나로: 차트 가로선·세 가지 경우·'틀리는 경우'의 손절 가격이 같다 (쉬운 PDF와 같은 숫자)", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    setDraft(buy.id, { entry: 72_345, target: 77_777, stop: 69_123, holdingDays: 10, probability: 0.55 }, [
      "업황 지표가 나빠지면 실적 기대가 줄 수 있다",
      "다음 실적 발표가 기대보다 나쁘면 의견을 다시 봐야 해요",
    ]);
    withoutRecommendation(buy.id);
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    renderApp(`/reports/${buy.id}`, "bob");
    expect(await screen.findByText("AI 의견: 긍정적")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("region", { name: "매매 계획" }).getAttribute("data-state")).toBe("no_plan"));
    // 차트 가로선(범례)과 '이 의견이 틀리는 경우'가 같은 손절 가격 69,100원 (69,123원은 어디에도 없다)
    expect(itemsOf("차트의 가로선")).toEqual(["목표 가격 77,700원", "사는 가격 72,300원", "손절 가격 69,100원"]);
    expect(itemsOf("이 의견이 틀리는 경우")).toEqual([
      "가격이 손절 가격(69,100원) 아래로 내려가면 이 의견을 다시 봐야 해요",
      "다음 실적 발표가 기대보다 나쁘면 의견을 다시 봐야 해요",
    ]);
    const cases = screen.getByRole("list", { name: "세 가지 경우" });
    expect(within(cases).getByText("+7.47%")).toBeTruthy();
    expect(within(cases).getByText("-4.43%")).toBeTruthy();
    await waitFor(() => expect(series.createPriceLine).toHaveBeenCalledWith(expect.objectContaining({ title: "손절 가격", price: 69_100 })));
    expect(document.body.textContent).not.toContain("69,123");
  });

  it("호가 단위로 내리면 가격 순서가 무너지는 제안(69,080 · 69,020 → 69,000)은 손절 문장·세 가지 경우·가로선이 없다 (쉬운 PDF와 같다)", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    setDraft(buy.id, { entry: 69_080, target: 77_000, stop: 69_020, holdingDays: 10, probability: 0.55 }, [
      "업황 지표가 나빠지면 실적 기대가 줄 수 있다",
      "실적이 나빠지면 의견을 다시 봐야 해요",
    ]);
    withoutRecommendation(buy.id);
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    renderApp(`/reports/${buy.id}`, "bob");
    expect(await screen.findByText("AI 의견: 긍정적")).toBeTruthy();
    expect(await screen.findByRole("img", { name: "종가 선 차트와 계획 가격 선" })).toBeTruthy();
    expect(itemsOf("이 의견이 틀리는 경우")).toEqual(["실적이 나빠지면 의견을 다시 봐야 해요"]);
    expect(itemsOf("세 가지 경우")).toBeNull();
    expect(itemsOf("차트의 가로선")).toBeNull();
    expect(screen.queryByText("가로선은 AI가 제안한 사는 가격·목표 가격·손절 가격이에요.")).toBeNull();
    expect(series.createPriceLine).not.toHaveBeenCalled();
  });

  it("예시 계획(목표 +12%)은 안전장치를 통과한다: 머리 안내·계획 미니·매매 계획 카드가 모두 '실행 준비' (가짜 API의 정상 흐름)", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    const rec = recOf(buy.id);
    expect(rec.rewardRisk).toBeGreaterThanOrEqual(2); // 비용·손절 미끄러짐을 넣어도 기준 이상
    renderApp(`/reports/${buy.id}`, "bob");
    expect(await screen.findByText(lib.planGuide("ready") ?? "-")).toBeTruthy();
    expect(screen.queryByText(lib.planGuide("blocked") ?? "-")).toBeNull();
    const mini = screen.getByLabelText("계획 미니");
    await waitFor(() => expect(mini.getAttribute("data-state")).toBe("ready"));
    expect(within(mini).getByRole("link", { name: "실행 준비" }).getAttribute("href")).toBe(`/recommendations/${rec.id}`);
    const card = screen.getByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("ready"));
    expect(within(card).getByRole("link", { name: /실행 준비/ }).getAttribute("href")).toBe(`/recommendations/${rec.id}`);
    // 시나리오 칸은 '이 계획의 수량으로 계산'만 (막혔다는 덧말 없음)
    expect(screen.queryByText(/지금은 안전장치가 실행을 막았어요/)).toBeNull();
  });

  it("차트의 TradingView 고지는 그림(role=img) 밖의 글자 링크 — 그림 안에 Tab 정지점을 두지 않는다", async () => {
    freezeTime(NOW);
    const { hold } = samples();
    renderApp(`/reports/${hold.id}`, "bob");
    const img = await screen.findByRole("img", { name: "종가 선 차트와 계획 가격 선" });
    const link = screen.getByRole("link", { name: "TradingView" });
    expect(link.getAttribute("href")).toBe("https://www.tradingview.com/");
    expect(img.contains(link)).toBe(false);
  });

  it("차트 아래 기준 표시: 마지막 봉이 완성 봉(장이 닫힘)이면 '장마감 기준' 시각 (오늘 진행 중이면 '실시간' — 위 테스트)", async () => {
    freezeTime(NOW, { marketOpen: { KR: false, US: false } });
    const { hold } = samples();
    renderApp(`/reports/${hold.id}`, "bob");
    await screen.findByRole("img", { name: "종가 선 차트와 계획 가격 선" });
    const flow = screen.getByRole("region", { name: "가격 흐름" });
    await waitFor(() => expect(flow.querySelector("time")?.textContent).toBe(CLOSE_LABEL));
    expect(within(flow).getByRole("button", { name: CLOSE_LABEL })).toBeTruthy(); // 눌러서 풀이를 보는 용어
  });

  it("완성(지켜보기): 시나리오 세 칸이 없고 차트에 계획 가격 선이 없다", async () => {
    freezeTime(NOW);
    const { hold } = samples();
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    renderApp(`/reports/${hold.id}`, "bob");
    expect(await screen.findByText("AI 의견: 지켜보기")).toBeTruthy();
    expect(screen.getByText(OPINION_TEXT.hold.line)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "종가 선 차트와 계획 가격 선" })).toBeTruthy();
    expect(screen.queryByRole("list", { name: "세 가지 경우" })).toBeNull();
    expect(series.createPriceLine).not.toHaveBeenCalled();
    expect(screen.queryByText("가로선은 AI가 제안한 사는 가격·목표 가격·손절 가격이에요.")).toBeNull();
    // 실행할 계획이 없는 리포트: ③은 '없음'(할 일이 남은 것처럼 보이지 않게). "실행할 계획이 없어요"는 매매 계획 카드 한 곳만 (UX-8 — 머리 안내·계획 미니 없음)
    const bar = within(screen.getByRole("list", { name: "리포트 단계" })).getAllByRole("listitem");
    expect(await within(bar[2]).findByText(/없음/)).toBeTruthy();
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("watch"));
    expect(screen.getAllByText(/실행할 계획이 없어요/)).toHaveLength(1);
    expect(screen.queryByLabelText("계획 미니")).toBeNull();
    expect(screen.queryByText(lib.planGuide("ready") ?? "-")).toBeNull();
    // 결론 아래 뜻 한 줄: 가진 사람에게 팔라는 뜻이 아니다
    expect(within(screen.getByRole("region", { name: "AI 의견" })).getByText(lib.OPINION_MEANING.hold ?? "-")).toBeTruthy();
    // 막다른 길이 아니다: 다른 종목으로 · 시작할 수 있는 계획 제안 · 며칠 뒤 다시
    expect(within(card).getByRole("link", { name: "다른 종목으로 리포트 만들기" }).getAttribute("href")).toBe("/search");
    expect((await within(card).findByRole("link", { name: /^시작할 수 있는 계획 제안/ })).getAttribute("href")).toBe("/recommendations");
    expect(within(card).getByRole("link", { name: "며칠 뒤 다시 만들기" }).getAttribute("href")).toBe(`/stocks/${hold.symbol}`);
    // 지켜보기에는 손절 문장 대신 위험에서 고른 문장
    const wrong = screen.getByRole("list", { name: "이 의견이 틀리는 경우" });
    expect(within(wrong).getAllByRole("listitem")).toHaveLength(1);
    expect(wrong.textContent).not.toContain("손절 가격(");
  });

  it("테마를 바꾸면 차트를 다시 만들지 않고 색만 바꾼다 (확대 상태가 남게)", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    const series = fakeSeries();
    series.createPriceLine.mockClear();
    renderApp(`/reports/${buy.id}`, "bob");
    await screen.findByRole("img", { name: "종가 선 차트와 계획 가격 선" });
    await waitFor(() => expect(series.createPriceLine).toHaveBeenCalledTimes(3));
    const lines = series.createPriceLine.mock.results.map((r) => (r.value as { applyOptions: ReturnType<typeof vi.fn> }).applyOptions);
    series.applyOptions.mockClear();
    for (const l of lines) l.mockClear();

    act(() => setThemePref("dark"));
    await waitFor(() => expect(series.applyOptions).toHaveBeenCalled());
    // 봉 색과 가격 선 색이 다크 값으로 (다시 만들지 않는다 — 가격 선 수는 그대로 3)
    // 쉬운 보기는 종가 선 (UX-17) — 선 색이 다크의 상승·하락색 중 하나로
    expect(series.applyOptions).toHaveBeenLastCalledWith({ color: expect.stringMatching(/^#(F25C68|458EF7)$/) });
    for (const l of lines) expect(l).toHaveBeenCalledTimes(1);
    expect(series.createPriceLine).toHaveBeenCalledTimes(3);
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
    // 왜 → 무엇을 할 수 있나 (권유형이 아닌 다음 행동 한 줄) → 어디서 멈췄나(접힘) → 다른 길
    expect(screen.getByText(lib.FAILURE_NEXT.review_failed)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "멈춘 단계" })).toBeNull();
    const where = screen.getByRole("button", { name: "어디서 멈췄는지 보기" });
    fireEvent.click(where);
    expect(where.getAttribute("aria-expanded")).toBe("true");
    const stopped = within(screen.getByRole("list", { name: "멈춘 단계" })).getAllByRole("listitem");
    expect(stopped).toHaveLength(5);
    expect(stopped.map((li) => li.getAttribute("aria-current"))).toEqual([null, null, null, null, "step"]); // 검토에서 멈춤
    expect(stopped[4].textContent).toContain("여기서 멈췄어요");
    expect(stopped[0].textContent).toContain("끝났어요");
    expect(screen.getByRole("link", { name: "리포트 목록으로" }).getAttribute("href")).toBe("/reports");

    click("다시 만들기");
    await waitFor(() => expect(db.listReports("086520")).toHaveLength(2));
    const made = db.listReports("086520")[0];
    expect(made.status).toBe("requested");
    expect(made.chaosEnabled).toBe(false);
    expect(await screen.findByRole("heading", { name: "만들 차례를 기다리는 중이에요" })).toBeTruthy();
  });

  it("어디서 멈췄는지: 함께 도는 조사 단계(시세·재무·뉴스)는 순서가 아니라 단계마다 실제 상태로 말한다", async () => {
    freezeTime(NOW);
    const { failed } = samples();
    const detail = db.getReport(failed.id);
    let step = 0;
    const e = (actor: string, action: string, status: TraceEvent["status"], details: Record<string, unknown> = {}): TraceEvent => ({
      step: ++step,
      actor,
      action,
      status,
      provider: null,
      model: null,
      latencyMs: null,
      details,
      at: "2026-10-06T10:00:00+09:00",
    });
    const rows = async (trace: TraceEvent[]) => {
      detail.trace.splice(0, detail.trace.length, ...trace);
      const view = renderApp(`/reports/${failed.id}`, "bob");
      fireEvent.click(await screen.findByRole("button", { name: "어디서 멈췄는지 보기" }));
      const items = within(screen.getByRole("list", { name: "멈춘 단계" })).getAllByRole("listitem");
      const out = { text: items.map((li) => li.textContent), current: items.findIndex((li) => li.getAttribute("aria-current") === "step") };
      view.unmount();
      return out;
    };
    // 세 조사 담당자가 함께 시작 (사건 번호는 리포트마다 1부터)
    const research = () => {
      step = 0;
      return [
        e("orchestrator", "workflow_started", "started"),
        e("market_agent", "agent_started", "started"),
        e("fundamental_agent", "agent_started", "started"),
        e("news_agent", "agent_started", "started"),
      ];
    };
    // 필수 재무 담당자가 실패해 Join이 막힘: 같이 돈 시세·뉴스는 끝났다 (뉴스를 '하지 않았어요'라고 하지 않는다)
    expect(
      await rows([
        ...research(),
        e("market_agent", "agent_completed", "completed"),
        e("fundamental_agent", "agent_failed", "failed", { errorType: "timeout", final: true }),
        e("news_agent", "agent_completed", "completed"),
        e("join_guard", "join_blocked", "blocked", { step: "compose", missing: ["fundamental_agent"] }),
        e("report_agent", "agent_skipped", "skipped", { reason: "join_blocked" }),
        e("review_agent", "agent_skipped", "skipped", { reason: "join_blocked" }),
        e("orchestrator", "workflow_failed", "failed", { reason: "join_blocked" }),
      ]),
    ).toEqual({ text: ["시세 보기끝났어요", "재무제표 읽기여기서 멈췄어요", "뉴스 읽기끝났어요", "리포트 쓰기건너뛰었어요", "검토건너뛰었어요"], current: 1 });
    // 선택 담당자(뉴스)는 포기하고 계속했는데 검토에서 실패: 뉴스를 '끝났어요'라고 하지 않는다
    expect(
      await rows([
        ...research(),
        e("market_agent", "agent_completed", "completed"),
        e("fundamental_agent", "agent_completed", "completed"),
        e("news_agent", "agent_failed", "failed", { errorType: "timeout", final: true }),
        e("join_guard", "join_completed", "completed", { step: "compose" }),
        e("report_agent", "agent_started", "started"),
        e("report_agent", "agent_completed", "completed"),
        e("review_agent", "agent_started", "started"),
        e("review_agent", "agent_completed", "completed", { verdict: "FAIL" }),
        e("orchestrator", "workflow_failed", "failed", { reason: "review_failed" }),
      ]),
    ).toEqual({ text: ["시세 보기끝났어요", "재무제표 읽기끝났어요", "뉴스 읽기하지 못했어요", "리포트 쓰기끝났어요", "검토여기서 멈췄어요"], current: 4 });
  });

  it("'이 화면만 자세히 보기'로 전문가 화면(?view=expert), 탭을 옮겨도 그대로, '쉬운 보기'로 돌아온다", async () => {
    freezeTime(NOW);
    const { buy } = samples();
    renderApp(`/reports/${buy.id}`, "bob");
    await screen.findByText("AI 의견: 긍정적");
    // 보기 전환은 두 보기 모두 '리포트 머리' 카드의 같은 자리에 있다 (되돌아가는 버튼을 찾지 않게)
    const head = () => screen.getByRole("region", { name: "리포트 머리" });

    expect(screen.getByRole("button", { name: "PDF로 보기" })).toBeTruthy();

    fireEvent.click(within(head()).getByRole("button", { name: "이 화면만 자세히 보기" }));
    expect(await screen.findByRole("tab", { name: "진행 기록" })).toBeTruthy();
    expect(screen.queryByText("AI 의견: 긍정적")).toBeNull();
    expect(await screen.findByRole("button", { name: "PDF로 보기" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "자세히" }));
    expect(screen.getByRole("tab", { name: "자세히" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("region", { name: /^Shared State/ })).toBeTruthy(); // 여전히 전문가 보기

    // 이 화면만 바꾼 상태 → 원래 보기로 돌아가기 (화면 머리가 아니라 머리 카드 안 — 제목이 잘리지 않게)
    fireEvent.click(within(head()).getByRole("button", { name: "쉬운 보기로 돌아가기" }));
    expect(await screen.findByText("AI 의견: 긍정적")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "자세히" })).toBeNull();
    expect(screen.getByRole("button", { name: "PDF로 보기" })).toBeTruthy();
  });

  it("주린이모드 끔(alice)은 전문가 화면이 기본, ?view=easy면 이 화면만 쉬운 보기", async () => {
    renderApp("/reports/2");
    expect(await screen.findByRole("tab", { name: "진행 기록" })).toBeTruthy();
    renderApp("/reports/2?view=easy");
    expect(await screen.findByRole("list", { name: "진행 단계" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "전문가 보기로 돌아가기" })).toBeTruthy(); // 이 화면만 바꾼 상태 → 원래 보기로 돌아가기
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
    // 최근 완성 리포트(1·3·2분)의 범위 (UX-7 — 한 값으로 말하면 넘겼을 때 고장처럼 보인다)
    expect(await screen.findByText("보통 1~3분 걸려요")).toBeTruthy();
    // 끝난 단계 수 막대(2/5)와 화면 읽기 프로그램용 지금 단계
    expect(screen.getByRole("progressbar", { name: "리포트 만들기 진행" }).getAttribute("aria-valuenow")).toBe("2");
    expect(screen.getByText("지금: 재무제표를 읽는 중 (2/5)")).toBeTruthy();
    // 연결된 뒤에는 예시 버튼을 보이지 않는다
    expect(screen.queryByRole("button", { name: /예시로 보기/ })).toBeNull();
  });

  /**
   * 보는 중에 완성되는 순간 (만드는 중 → 완성 제자리 전환). SSE 'end'는 상태만 완성으로 바꾸고 종료 시각·의견은 Snapshot으로 다시 받는다 —
   * 그 처리(api/reports.ts)와 같은 캐시 변경을 직접 한다. 추천 목록(아직 없음)은 바로, Snapshot은 gate를 열 때 온다.
   */
  async function completeWhileWatching(scrollY: number) {
    freezeTime(NOW);
    vi.stubGlobal("EventSource", undefined);
    const { buy } = samples();
    const done = structuredClone(db.getReport(buy.id));
    done.finishedAt = new Date(Date.now() - 5_000).toISOString(); // 방금 끝남 — 추천은 엔진이 최대 10분 안에 만든다
    // 만드는 중: 조사 결과만 있고 리포트 초안·검토 결과는 아직 없다
    const research = Object.fromEntries(Object.entries(done.state.results).filter(([k]) => k !== "report_agent" && k !== "review_agent"));
    const running: ReportDetail = {
      ...structuredClone(done),
      status: "running",
      finishedAt: null,
      opinion: null,
      oneLiner: null,
      content: null,
      hasPdf: false,
      state: { ...structuredClone(done.state), status: "running", currentStep: "review", results: research },
    };
    let phase: "running" | "done" = "running";
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    let recsServed = 0;
    server.use(
      http.get("*/api/reports/:id", async ({ params }) => {
        if (Number(params.id) !== buy.id) return undefined;
        if (phase === "running") return HttpResponse.json(running);
        await gate;
        return HttpResponse.json(done);
      }),
      http.get("*/api/recommendations", () => {
        recsServed++;
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] });
      }),
    );
    Object.defineProperty(window, "scrollY", { value: scrollY, configurable: true });
    const view = renderApp(`/reports/${buy.id}`, "bob");
    expect(await screen.findByRole("heading", { name: "리포트를 만드는 중이에요" })).toBeTruthy();
    const bar = () => within(screen.getByRole("list", { name: "리포트 단계" })).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(bar()[0]).toContain("지금 단계");
    phase = "done";
    act(() => {
      view.client.setQueryData<ReportDetail>(keys.report(buy.id), (r) => (r ? { ...r, status: "completed", state: { ...done.state } } : r));
      void view.client.invalidateQueries({ queryKey: keys.report(buy.id) });
    });
    return { bar, open: () => open(), recsServed: () => recsServed };
  }

  it("보는 중에 완성되면 결론 카드가 올라오고, 아래로 내려가 있었으면 '리포트가 완성됐어요' 토스트를 한 번만 (종료 시각을 받기 전에도 '계획 없음'으로 뒤집히지 않는다)", async () => {
    const live = await completeWhileWatching(300);
    try {
      // 결론 카드가 이 화면에서 완성된 순간에만 올라온다
      expect((await screen.findByRole("region", { name: "AI 의견" })).className).toContain("animate-rise-in");
      const bar = live.bar();
      expect(bar[0]).toContain("끝남");
      expect(bar[1]).toContain("지금 단계");
      const toasts = () => within(screen.getByRole("status")).queryAllByText("리포트가 완성됐어요");
      expect(await screen.findByRole("button", { name: "결론 보기" })).toBeTruthy();
      expect(toasts()).toHaveLength(1);
      // 추천 목록(빈 목록)이 Snapshot보다 먼저 와도: 종료 시각이 없으니 '계획 없음'(③ 없음·안내·가격 계획이 맞지 않아)으로 정하지 않는다
      await waitFor(() => expect(live.recsServed()).toBeGreaterThan(0));
      await act(async () => {
        await new Promise((r) => setTimeout(r, 50));
      });
      expect(live.bar()[2]).not.toContain("없음");
      expect(screen.queryByText(lib.planGuide("no_plan") ?? "-")).toBeNull();
      expect(screen.queryByText(/가격 계획이 맞지 않아/)).toBeNull();
      // Snapshot(종료 시각)이 오면 '준비 중' — 다시 그려져도 토스트는 그대로 한 번
      live.open();
      expect((await screen.findAllByText("실행 계획을 준비하는 중이에요…")).length).toBeGreaterThan(0);
      expect(live.bar()[2]).toContain("아직");
      expect(toasts()).toHaveLength(1);
    } finally {
      Object.defineProperty(window, "scrollY", { value: 0, configurable: true });
    }
  });

  it("맨 위에서 보고 있었으면 완성돼도 토스트를 띄우지 않는다 (결론 카드가 바로 보인다)", async () => {
    const live = await completeWhileWatching(0);
    expect((await screen.findByRole("region", { name: "AI 의견" })).className).toContain("animate-rise-in");
    live.open();
    expect((await screen.findAllByText("실행 계획을 준비하는 중이에요…")).length).toBeGreaterThan(0);
    expect(screen.queryByText("리포트가 완성됐어요")).toBeNull();
    expect(screen.queryByRole("button", { name: "결론 보기" })).toBeNull();
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

  it("progressOf: 담당자의 마지막 사건으로 다섯 단계 상태 (검토 RETRY로 다시 쓰면 쓰기는 '지금 하는 중' + 까닭, 검토는 '고친 글을 다시 봐요')", () => {
    expect(lib.progressOf([]).map((s) => s.state)).toEqual(["waiting", "waiting", "waiting", "waiting", "waiting"]);
    expect(lib.progressOf(recovery).map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(lib.progressOf(recovery).find((s) => s.actor === "news_agent")?.recovered).toBe(true);
    // 예시 ③의 17번째 사건(review_retry) 뒤 다시 작성 시작: 검토의 끝남 표시를 지운다
    expect(lib.progressOf(recovery.slice(0, 18)).map((s) => s.state)).toEqual(["done", "done", "done", "active", "again"]);
    expect(lib.progressOf(recovery.slice(0, 18)).map((s) => s.rewriting)).toEqual([false, false, false, true, false]);
    // 검토가 RETRY를 낸 직후(지시 사건 전)에도 검토는 '끝났어요'가 아니다
    const retryAt = recovery.findIndex((e) => e.action === "review_retry");
    expect(lib.progressOf(recovery.slice(0, retryAt))[4].state).toBe("again");
    // 지시는 받았지만 쓰기를 아직 시작하지 않았어도 쓰기 단계는 '지금 하는 중' + 까닭
    expect(lib.progressOf(recovery.slice(0, retryAt + 1))[3]).toMatchObject({ state: "active", rewriting: true });
    // 다시 쓰기가 끝나면 까닭 한 줄은 사라진다
    expect(lib.progressOf(recovery).every((s) => !s.rewriting)).toBe(true);
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
    const account = { basis: "account", gain: "+4,700원", loss: "-2,300원", quantity: 5, holdingDays: 10, asOf: p.lastPriceAsOf, blocked: false, expired: false };
    expect(lib.scenarioOf(t, p, 10)).toEqual(account);
    expect(lib.scenarioOf(t, p, 10, "ready")).toEqual(account);
    // 안전장치가 막은 계획: 금액은 그대로(막힌 이유가 숫자로 보인다), '정했다'고 쓰지 않게 표시
    expect(lib.scenarioOf(t, p, 10, "blocked")).toEqual({ ...account, blocked: true });
    const share = { basis: "share", gain: "+10.00%", loss: "-4.00%", quantity: null, holdingDays: 7, asOf: null, blocked: false, expired: false };
    expect(lib.scenarioOf(t, { ...p, quantity: 0 }, null)).toEqual(share);
    // 기한이 지난 계획은 그때의 계좌 금액을 쓰지 않고 1주 비율로
    expect(lib.scenarioOf(t, p, null, "expired")).toEqual({ ...share, expired: true });
    expect(lib.scenarioOf({ ...t, stop: 10_500 }, p, 10)).toBeNull();
    expect(lib.scenarioOf({ ...t, target: null }, p, 10)).toBeNull();
  });

  it("floorTargets: 추천처럼 호가 단위로 내린다 (엔진 round_price·쉬운 PDF tick_prices와 같은 사례), 0 이하·없는 값은 그대로", () => {
    const t = { entry: 72_345, target: 77_777, stop: 69_123, holdingDays: 7.5, probability: 0.55 };
    expect(lib.floorTargets(t, "KRW")).toEqual({ entry: 72_300, target: 77_700, stop: 69_100, holdingDays: 7.5, probability: 0.55 });
    const us = { entry: 180.129, target: 0, stop: null, holdingDays: null, probability: null };
    expect(lib.floorTargets(us, "USD")).toEqual({ ...us, entry: 180.12 });
    expect(lib.floorTargets({ ...us, entry: 0.12345 }, "USD").entry).toBe(0.1234); // 1달러 미만은 0.0001 단위
    expect(lib.floorTargets({ ...t, entry: 1_999, target: 2_003, stop: 500_499 }, "KRW")).toMatchObject({ entry: 1_999, target: 2_000, stop: 500_000 });
    expect(lib.floorTargets({ ...t, entry: 69_080, stop: 69_020 }, "KRW")).toMatchObject({ entry: 69_000, stop: 69_000 });
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
    // 긍정적이 아닌 의견에는 손절 가격이 없어 '손절'이 든 위험은 옮기지 않는다 (다른 조건 문장은 옮긴다)
    const risks = ["손절 가격 아래로 내려가면 다시 봐야 한다", "실적이 나빠지면 의견을 다시 봐야 해요"];
    expect(lib.whenWrongOf({ risks }, "hold")).toEqual({ risk: risks[1], others: [risks[0]] });
    expect(lib.whenWrongOf({ risks }, "buy")).toEqual({ risk: risks[0], others: [risks[1]] });
    // 손절 가격(70,000원)만 말하는 문장(코드의 손절 문장과 같은 뜻)과 다른 조건이 붙은 문장
    const only = (line: string, stop = 70_000) => lib.priceOnlyRisk(line, stop, "KRW");
    expect(only("손절 가격 아래로 내려가면 다시 봐야 한다")).toBe(true);
    expect(only("70,000원 아래로 내려가면 다시 봐야 해요")).toBe(true);
    expect(only("주가가 70,100원 아래로 내려가면 다시 봐야 해요")).toBe(true); // 호가 한 칸 차이(반올림)는 같은 가격
    expect(only("70,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요")).toBe(false);
    expect(only("업황 지표가 나빠지면 다시 봐야 해요")).toBe(false);
    // 글자 '원'이나 손절 가격과 다른 금액만으로는 '가격만 말하는 문장'이 아니다 (숨기면 위험 목록에서도 사라진다)
    expect(only("원/달러 환율이 1,450원을 넘으면 광고 매출 환산이 줄어 의견을 다시 판단해야 해요")).toBe(false);
    expect(only("원자재 가격이 오르면 이 의견을 다시 봐야 해요")).toBe(false);
    expect(only("회원 수가 줄면 다시 봐야 해요")).toBe(false);
    expect(only("연구원 이탈이 이어지면 다시 봐야 해요")).toBe(false);
    expect(only("주가가 75,000원 아래로 내려가면 다시 봐야 해요")).toBe(false); // 손절 가격과 다른 가격 = 다른 조건
    expect(only("손절 매물이 늘면 다시 봐야 해요")).toBe(false);
    expect(lib.priceOnlyRisk("$110.00 아래로 내려가면 다시 봐야 해요", 110, "USD")).toBe(true);
    // 앞의 손절 가격 조건 떼기 (손절 문장이 이미 그 가격을 말할 때)
    const strip = (line: string, stop = 70_000) => lib.withoutPriceClause(line, stop, "KRW");
    expect(strip("70,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요")).toBe("실적 발표가 나쁘면 다시 봐야 해요");
    expect(strip("주가가 70,000원 밑으로 떨어지거나, 업황이 바뀌면 다시 봐야 해요")).toBe("업황이 바뀌면 다시 봐야 해요");
    expect(strip("주가가 손절가(70,000원) 아래로 내려가거나 업황이 바뀌면 다시 봐야 해요")).toBe("업황이 바뀌면 다시 봐야 해요");
    expect(lib.withoutPriceClause("$110.00 아래로 내려가거나 가이던스가 낮아지면 다시 봐야 해요", 110, "USD")).toBe("가이던스가 낮아지면 다시 봐야 해요");
    expect(strip("업황 지표가 나빠지면 다시 봐야 해요")).toBe("업황 지표가 나빠지면 다시 봐야 해요");
    // 손절 가격이 아닌 금액 조건(매출·다른 가격)이나 앞에 붙은 다른 조건은 떼지 않는다
    for (const line of [
      "광고 매출이 분기 1조원 아래로 떨어지거나 금리가 오르면 의견을 다시 봐야 해요",
      "영업이익이 1,000억원 아래로 내려가거나 수주가 줄면 의견을 다시 봐야 해요",
      "75,000원 아래로 내려가거나 실적 발표가 나쁘면 다시 봐야 해요",
      "실적이 나쁘면 70,000원 아래로 내려가거나 금리가 오르면 다시 봐야 해요",
    ])
      expect(strip(line)).toBe(line);
  });

  it("진행 막대·멈춘 단계·기다린 시간: 검토 뒤 다시 쓰기에도 막대는 뒤로 가지 않는다", () => {
    // 예시 ③의 18번째 사건까지: 다시 쓰는 중이라 끝난 단계는 3개(검토는 다시 볼 차례)지만, 막대는 지금까지의 최댓값(4)을 지킨다
    const upto = recovery.slice(0, 18);
    expect(lib.progressDone(lib.progressOf(upto))).toBe(3);
    expect(lib.progressPeak(upto)).toBe(4);
    expect(lib.progressPeak([])).toBe(0);
    expect(lib.progressAnnouncement(lib.progressOf(upto), 4)).toBe("지금: 리포트를 쓰는 중 (4/5)");
    expect(lib.progressAnnouncement(lib.progressOf(upto), 4, lib.rewriteNoteOf())).toBe(`지금: 리포트를 쓰는 중 (4/5) · ${lib.rewriteNoteOf()}`);
    expect(lib.progressAnnouncement(lib.progressOf(recovery))).toBe("다섯 단계를 모두 끝냈어요 (5/5)");
    // 멈춘 단계: 검토 실패는 검토, 필수 실패는 그 단계, 아무것도 시작하지 않았으면 첫 단계
    const steps = lib.progressOf(normal.slice(0, 7));
    expect(lib.stoppedStepIndex(steps, "review_failed")).toBe(4);
    expect(lib.stoppedStepIndex(steps, "join_blocked")).toBe(2);
    expect(lib.stoppedStepIndex(lib.progressOf([]), "timeout")).toBe(0);
    // 시세를 보던 중 엔진이 다시 시작: 먼저 포기한 뉴스(선택)가 아니라 하던 단계(시세)에서 멈췄다. Join 차단은 실패한 단계
    const cut = lib.progressOf([
      ev(1, "market_agent", "agent_started", "started"),
      ev(2, "news_agent", "agent_started", "started"),
      ev(3, "news_agent", "agent_failed", "failed", { final: true }),
    ]);
    expect(cut.map((s) => s.state)).toEqual(["active", "waiting", "failed", "waiting", "waiting"]);
    expect(lib.stoppedStepIndex(cut, "engine_restarted")).toBe(0);
    expect(lib.stoppedStepIndex(cut, "join_blocked")).toBe(2);
    // 선택 담당자(뉴스)가 먼저 포기했어도, 리포트를 쓰는 AI가 끝내 실패해 멈췄으면 그 단계다 (리뷰 C13)
    const writeFailed = [
      ev(1, "market_agent", "agent_completed", "completed"),
      ev(2, "fundamental_agent", "agent_completed", "completed"),
      ev(3, "news_agent", "agent_failed", "failed", { final: true }),
      ev(4, "report_agent", "agent_started", "started"),
      ev(5, "report_agent", "agent_failed", "failed", { final: true, errorType: "bad_output" }),
      ev(6, "review_agent", "agent_skipped", "skipped", { reason: "agent_failed" }),
    ];
    const ws = lib.progressOf(writeFailed);
    expect(lib.stoppedStepIndex(ws, "agent_failed", writeFailed)).toBe(3);
    expect(lib.stoppedStepIndex(ws, "timeout", writeFailed)).toBe(3);
    // 기다린 시간
    const at = Date.parse("2026-10-06T14:00:00+09:00");
    expect(lib.elapsedText("2026-10-06T13:59:40+09:00", at)).toBe("방금");
    expect(lib.elapsedText("2026-10-06T13:57:00+09:00", at)).toBe("3분");
    expect(lib.elapsedText("2026-10-06T11:30:00+09:00", at)).toBe("2시간");
    expect(lib.elapsedText("2026-10-04T14:00:00+09:00", at)).toBe("2일");
    expect(lib.elapsedText(null, at)).toBeNull();
    // 진행 화면의 한 문장: 늘 신청 시각 기준
    expect(lib.requestedAgoText("2026-10-06T13:59:40+09:00", at)).toBe("신청한 지 1분이 안 됐어요");
    expect(lib.requestedAgoText("2026-10-06T13:57:00+09:00", at)).toBe("신청한 지 3분");
    expect(lib.requestedAgoText(null, at)).toBeNull();
  });

  it("교차검증 목록 한 줄·AI 이름·오늘 리포트", () => {
    const best = { ...db.listAnalyses(null, null).find((a) => a.best?.selected)!.best!, proposer: "claude" };
    expect(lib.crossCheckLine({ scenarioCount: 3, best })).toBe("제안 3개 · 최종 승인 Claude");
    expect(lib.crossCheckLine({ scenarioCount: 3, best: { ...best, selected: false } })).toBe("제안 3개 · 최종 승인 없음");
    expect(lib.crossCheckLine({ scenarioCount: 0, best: null })).toBe("AI가 낸 계획이 없어요");
    expect(["claude", "gpt", "gemini", "llama"].map(lib.providerName)).toEqual(["Claude", "GPT", "Gemini", "llama"]);
    // 분석 오류(엔진 pipeline.py 문구)의 쉬운 문장 — AI 이름은 같은 표기로, 모르는 문구는 그대로 (숨기지 않는다)
    expect(lib.analysisErrorEasy("gpt-4.1-mini 웹 조사 실패: timeout")).toBe("GPT: 응답하지 못해 웹 조사를 하지 못했어요");
    expect(lib.analysisErrorEasy("gemini 검증 실패: HTTP 503")).toBe("Gemini: 응답하지 못해 다른 AI의 계획을 검증하지 못했어요");
    expect(lib.analysisErrorEasy("claude: 시간 초과로 이후 단계와 의결에서 제외함")).toBe("Claude: 응답이 늦어 이후 단계에서 빠졌어요");
    expect(lib.analysisErrorEasy("제안 모델이 조건에 맞는 시나리오를 내지 않았습니다.")).toBe("제안 모델이 조건에 맞는 시나리오를 내지 않았습니다.");
    // 계획이 0개인 까닭: 제안 AI가 응답하지 못했으면 그 수를 말하고, 아니면 기본 문장(null)
    expect(lib.noPlanSentence(["claude 시나리오 제안 실패: 503", "gpt 검증 실패: x"])).toBe("AI가 낸 계획이 없어요 (AI 한 곳이 응답하지 못했어요)");
    expect(lib.noPlanSentence(["APPROVER가 설정되지 않아 최종 컨펌을 하지 못함"])).toBeNull();
    expect(lib.noPlanSentence([])).toBeNull();

    const now = new Date("2026-10-06T14:00:00+09:00");
    const r = (id: number, status: ReportSummary["status"], createdAt: string) => ({ ...db.listReports(null)[0], id, status, createdAt });
    // 완성된 것이 먼저, 실패는 빼고, 오늘 것만
    expect(lib.todayReport([r(1, "running", "2026-10-06T13:00:00+09:00"), r(2, "completed", "2026-10-06T09:00:00+09:00")], now)?.id).toBe(2);
    expect(lib.todayReport([r(1, "running", "2026-10-06T13:00:00+09:00"), r(3, "failed", "2026-10-06T13:30:00+09:00")], now)?.id).toBe(1);
    expect(lib.todayReport([r(4, "completed", "2026-10-05T13:00:00+09:00")], now)).toBeNull();
  });

  it("typicalDurationMs: 최근 완성 리포트의 중앙값, 3건 미만이면 없음", () => {
    const r = (status: ReportSummary["status"], start: string | null, end: string | null) => ({ status, startedAt: start, finishedAt: end });
    const at = (m: number) => `2026-10-05T10:${String(m).padStart(2, "0")}:00+09:00`;
    expect(lib.typicalDurationMs([r("completed", at(0), at(1)), r("completed", at(2), at(4))])).toBeNull();
    expect(lib.typicalDurationMs([r("completed", at(0), at(1)), r("completed", at(2), at(5)), r("completed", at(10), at(12)), r("failed", at(0), at(30))])).toBe(120_000);
    expect(lib.typicalDurationMs([r("completed", at(0), at(1)), r("completed", at(2), at(5)), r("completed", at(10), at(12)), r("completed", at(20), at(24))])).toBe(150_000);
    // 최근 take개만
    expect(lib.typicalDurationMs([r("completed", at(0), at(9)), r("completed", at(10), at(11)), r("completed", at(20), at(21)), r("completed", at(30), at(31))], 3)).toBe(60_000);
    // 걸린 시간 범위: 가운데 절반(아래 1/4 ~ 위 1/4), 아래는 반올림(최소 1분) · 위는 올림
    expect(lib.typicalDurationRange([r("completed", at(0), at(1)), r("completed", at(2), at(4))])).toBeNull();
    expect(lib.typicalDurationRange([r("completed", at(0), at(1)), r("completed", at(10), at(13)), r("completed", at(20), at(22))])).toEqual({ lo: 1, hi: 3 });
    // 유난히 오래 걸린 한 건(20분)에 끌리지 않는다
    const many = [1, 2, 2, 2, 3, 20].map((m, i) => r("completed", at(i * 2), `2026-10-05T${String(10 + Math.floor((i * 2 + m) / 60)).padStart(2, "0")}:${String((i * 2 + m) % 60).padStart(2, "0")}:00+09:00`));
    expect(lib.typicalDurationRange(many)).toEqual({ lo: 2, hi: 3 });
    expect(lib.durationSentence({ lo: 1, hi: 3 })).toBe("보통 1~3분 걸려요");
    expect(lib.durationSentence({ lo: 2, hi: 2 })).toBe("보통 2분쯤 걸려요");
    expect(lib.durationSentence(null)).toBe("보통 몇 분 걸려요");
  });

  it("단계 막대·목록 상태·한도 문장, 그리고 새 문장에 권유·단정 표현이 없다", () => {
    expect(lib.stepsOf("requested", false)).toEqual(["current", "todo", "todo"]);
    expect(lib.stepsOf("failed", false)).toEqual(["failed", "todo", "todo"]);
    expect(lib.stepsOf("completed", false)).toEqual(["done", "current", "todo"]);
    expect(lib.stepsOf("completed", true)).toEqual(["done", "done", "done"]);
    // 실행할 계획이 없으면 ③은 '없음' — 안전장치가 막은 것(blocked)은 나중에 풀릴 수 있어 '아직'
    for (const plan of ["watch", "negative", "no_plan", "expired"] as const) expect(lib.stepsOf("completed", false, plan)).toEqual(["done", "current", "skipped"]);
    for (const plan of ["ready", "blocked", "preparing", "loading"] as const) expect(lib.stepsOf("completed", false, plan)).toEqual(["done", "current", "todo"]);
    expect(lib.stepsOf("completed", true, "watch")).toEqual(["done", "done", "done"]);
    expect(lib.planGuide("preparing")).toBeNull();
    expect(lib.planGuide("loading")).toBeNull();
    expect(lib.reportCardStatus("completed", true)).toBe("ready");
    expect(lib.reportCardStatus("running", true)).toBe("running");
    expect(lib.quotaSentence({ remaining: 2 })).toBe("오늘 2번 더 만들 수 있어요");
    expect(lib.quotaSentence({ remaining: 0 })).toBe("오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요");
    expect(lib.quotaSentence({ remaining: null })).toBe("오늘은 횟수 제한 없이 만들 수 있어요");

    const copy = [
      ...Object.values(lib.REPORT_CARD_TEXT).flatMap((x) => [x.label, x.sentence]),
      ...Object.values(lib.CROSS_CHECK_TEXT).flatMap((x) => [x.badge, x.line]),
      ...Object.values(lib.PROGRESS_STATE_TEXT),
      ...lib.PROGRESS_STEPS.map((s) => s.label),
      ...lib.recoverySentences(recovery),
      ...lib.recoverySentences(normal),
      ...Object.values(lib.PLAN_NOTE),
      ...Object.values(lib.FAILURE_NEXT),
      lib.FAILURE_NEXT_FALLBACK,
      ...(["ready", "blocked", "watch", "expired"] as const).map((p) => lib.planGuide(p) ?? ""),
    ];
    for (const line of copy) expect(persuasive(line), line).toEqual([]);
  });
});

describe("조사 자료 요약 — 시세 기준 시각", () => {
  const market = (asOf: string | null, basis: QuoteBasis = "close"): lib.MarketView => ({
    summary: null,
    price: 71_300,
    changePct: null,
    asOf,
    basis,
    rsi: 55,
    volatilityPct: 1.2,
    signals: [],
  });
  const show = (asOf: string | null, basis: QuoteBasis = "close", marketCode: Market = "KR") => {
    render(<ResearchCards market={market(asOf, basis)} fundamental={null} news={null} marketCode={marketCode} currency="KRW" />);
    return screen.getByRole("region", { name: "시세" });
  };

  it("asOf가 있으면 종가와 장마감 기준 시각", () => {
    const box = show("2026-10-05T15:30:00+09:00");
    expect(box.textContent).toContain("71,300원");
    expect(within(box).getByText("종가")).toBeTruthy();
    expect(within(box).getByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
  });

  it("장 중에 만든 리포트(basis live)는 장중 가격과 받은 시각 (날짜 포함 — PDF와 같다)", () => {
    const box = show("2026-10-08T15:23:05+09:00", "live");
    expect(box.textContent).toContain("71,300원");
    expect(within(box).getByText("장중 가격")).toBeTruthy();
    expect(within(box).getByText("10월 8일(목) 15:23 기준")).toBeTruthy();
    expect(box.textContent).not.toContain("장마감 기준");
    expect(box.textContent).not.toContain("종가");
  });

  it("미국 종목의 장중 가격 시각은 뉴욕 시각", () => {
    const box = show("2026-10-08T00:20:05+09:00", "live", "US");
    expect(within(box).getByText("10월 7일(수) 11:20(뉴욕) 기준")).toBeTruthy();
  });

  it("researchOf: priceBasis가 live일 때만 live (없거나 다른 값이면 close — 예전 결과)", () => {
    const of = (priceBasis: unknown) => lib.researchOf({ results: { market_agent: { price: 1, priceBasis } } }).market?.basis;
    expect([of("live"), of("close"), of(undefined), of("?")]).toEqual(["live", "close", "close", "close"]);
  });

  it.each([null, "어제"])("asOf가 %s이면 가격을 보이지 않고 기준 시각 자료 없음 (PDF와 같다)", (asOf) => {
    const box = show(asOf);
    expect(box.textContent).not.toContain("71,300");
    expect(box.textContent).not.toContain("장마감 기준");
    expect(within(box).getByText("시세 기준 시각: 자료 없음")).toBeTruthy();
  });
});
