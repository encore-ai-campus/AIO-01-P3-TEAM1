// 매매 종목 선정 팀(stock_selection) 화면: 오늘의 선별 결과(AI 선정 · 규칙 Fallback · 고르는 중 · 예전 파일 · 예시),
// 선정 실행 상세(주린이모드여도 과정 화면, PDF·추천·다시 신청·예시 재생 없음), 그리고 lib의 팀별 진행 단계·문장.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { ReportDetail, ScreeningResult, TraceEvent } from "../api/types";
import * as plain from "../lib/plainText";
import { sampleRuleScreening, sampleRunningScreening, sampleScreening } from "../lib/reportSamples";
import * as lib from "../lib/reports";
import * as db from "../mocks/db";
import { selectionSample } from "../mocks/sampleReports";
import { selectionPlan } from "../mocks/seed";
import { server } from "../mocks/server";
import { renderApp } from "./render";

const panel = () => screen.findByRole("region", { name: /^오늘의 선별 결과/ });
const picks = (box: HTMLElement) => within(within(box).getByRole("list", { name: "선별 종목" })).getAllByRole("listitem");
/** 오늘의 선별 응답을 바꾼다 (가짜 API 기본은 AI 선정 예시). */
const serve = (s: ScreeningResult) => server.use(http.get("*/api/reports/screening", () => HttpResponse.json(s)));

describe("오늘의 선별 결과 — 선정 팀", () => {
  it("AI가 고른 날: 배지 · AI 순위·이유·테마 · 안전장치가 뺀 종목(접힘). 선정 실행이 없으면 과정 보기 링크가 없다", async () => {
    renderApp("/reports");
    const box = await panel();
    expect(await within(box).findByText("AI 선정 팀이 고르고 안전장치가 거른 종목")).toBeTruthy();
    expect(within(box).queryByText("오늘은 규칙으로 골랐어요")).toBeNull();
    expect(within(box).getByText(/후보 8개 · 3개 선별/)).toBeTruthy();
    const rows = picks(box);
    expect(rows).toHaveLength(3);
    expect(within(rows[0]).getByText("SK하이닉스")).toBeTruthy();
    expect(within(rows[0]).getByText("AI 1위")).toBeTruthy();
    expect(within(rows[0]).getByText("반도체")).toBeTruthy();
    expect(within(rows[0]).getByText("HBM 공급 확대 뉴스가 이어졌고 외국인 순매수가 사흘째예요")).toBeTruthy();
    // AI 3·4위는 안전장치가 빼서 최종 셋째는 AI 5위
    expect(within(rows[2]).getByText("AI 5위")).toBeTruthy();
    expect(within(rows[2]).getByText("자동차")).toBeTruthy();
    expect(within(box).queryByText("규칙으로 채움")).toBeNull();
    // 뺀 종목은 접혀 있다 (열린 동안만 aria-controls)
    const toggle = within(box).getByRole("button", { name: /AI는 골랐지만 안전장치가 뺀 종목 2개/ });
    expect([toggle.getAttribute("aria-expanded"), toggle.getAttribute("aria-controls")]).toEqual(["false", null]);
    expect(within(box).queryByRole("list", { name: "AI는 골랐지만 안전장치가 뺀 종목" })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-controls")).toBe("screening-filtered");
    const out = within(box).getByRole("list", { name: "AI는 골랐지만 안전장치가 뺀 종목" });
    expect(within(out).getAllByRole("listitem")).toHaveLength(2);
    expect(within(out).getByText("한미반도체")).toBeTruthy();
    expect(within(out).getByText(/같은 테마\(반도체\) 종목이 이미 2개예요/)).toBeTruthy();
    expect(within(out).getByText(/투자유의: 투자경고 종목/)).toBeTruthy();
    expect(within(box).queryByRole("link", { name: /AI 선정 과정 보기/ })).toBeNull();
  });

  it("선정 실행이 있으면 'AI 선정 과정 보기'로 그 실행의 과정 화면(선정 결과 탭)에 간다", async () => {
    const id = db.addSampleSelection();
    renderApp("/reports");
    const box = await panel();
    const link = await within(box).findByRole("link", { name: /AI 선정 과정 보기/ });
    expect(link.getAttribute("href")).toBe(`/reports/${id}`);
    fireEvent.click(link);
    expect(await screen.findByRole("heading", { name: "오늘의 매매 종목 선정", level: 1 })).toBeTruthy();
    // 끝난 실행이라 첫 탭(선정 결과)이 기본, 본문은 선정안 순위표
    expect(screen.getByRole("tab", { name: "선정 결과" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("heading", { name: "선정 결과", level: 2 })).toBeTruthy();
    expect(await screen.findByText("최종 종목은 안전장치(선정 Guard)를 거쳐 정해진다.")).toBeTruthy();
  });

  it("AI 선정 중 규칙 점수로 채운 종목에는 '규칙으로 채움' 꼬리표 (AI 순위·이유는 없다)", async () => {
    const s = sampleScreening();
    const filled = { symbol: "105560", name: "KB금융", score: 58, tradingAmountRank: 14, aiRank: null, aiReason: null, theme: null, filledByRule: true };
    serve({ ...s, picks: [...s.picks.slice(0, 2), filled] });
    renderApp("/reports");
    const box = await panel();
    await within(box).findByText("KB금융");
    const rows = picks(box);
    expect(within(rows[2]).getByText("KB금융")).toBeTruthy();
    expect(within(rows[2]).getByText("규칙으로 채움")).toBeTruthy();
    expect(within(rows[2]).queryByText(/^AI \d위$/)).toBeNull();
  });

  it("다시 시도한 날: 더한 종목에 'n차' 꼬리표, 위 줄에 다시 시도 횟수", async () => {
    const s = sampleScreening();
    const retried = { symbol: "105560", name: "KB금융", score: 58, tradingAmountRank: 14, aiRank: null, aiReason: null, theme: null, filledByRule: true, retryRound: 1 };
    serve({ ...s, picks: [...s.picks, retried], retries: 1 });
    renderApp("/reports");
    const box = await panel();
    await within(box).findByText("KB금융");
    const rows = picks(box);
    expect(rows).toHaveLength(4);
    expect(within(rows[3]).getByText("다시 시도 1차")).toBeTruthy();
    expect(within(rows[0]).queryByText(/다시 시도/)).toBeNull();
    expect(within(box).getByText(/4개 선별 \(손익비 기준을 넘는 추천이 없어 다시 시도 1번\)/)).toBeTruthy();
  });

  it("규칙으로 고른 날(Fallback): '오늘은 규칙으로 골랐어요' + 사유 문장 + 과정 보기, 칸마다 꼬리표를 되풀이하지 않는다", async () => {
    serve(sampleRuleScreening("join_blocked"));
    renderApp("/reports");
    const box = await panel();
    expect(await within(box).findByText("오늘은 규칙으로 골랐어요")).toBeTruthy();
    expect(within(box).getByText(plain.SELECTION_FALLBACK_TEXT.join_blocked)).toBeTruthy();
    expect(within(box).queryByText("AI 선정 팀이 고르고 안전장치가 거른 종목")).toBeNull();
    expect(picks(box)).toHaveLength(3);
    expect(within(box).queryByText("규칙으로 채움")).toBeNull();
    expect(within(box).getByRole("link", { name: /AI 선정 과정 보기/ }).getAttribute("href")).toBe("/reports/41");
    expect(within(box).queryByRole("button", { name: /안전장치가 뺀 종목/ })).toBeNull();
  });

  it("규칙 선별을 통과한 후보가 없던 날: 사유 문장과 빈 목록 안내 (과정 보기 없음)", async () => {
    serve(sampleRuleScreening("no_candidates"));
    renderApp("/reports");
    const box = await panel();
    expect(await within(box).findByText("규칙 선별을 통과한 종목이 없었어요")).toBeTruthy();
    expect(within(box).getByText("오늘 선별된 종목이 없어요.")).toBeTruthy();
    expect(within(box).queryByRole("list", { name: "선별 종목" })).toBeNull();
    expect(within(box).queryByRole("link", { name: /AI 선정 과정 보기/ })).toBeNull();
  });

  it("고르는 중: 그 사실과 지금 종목이 규칙 점수 순서라는 안내, 과정 보기", async () => {
    serve(sampleRunningScreening(57));
    renderApp("/reports");
    const box = await panel();
    expect(await within(box).findByText("AI가 오늘의 종목을 고르는 중이에요")).toBeTruthy();
    expect(within(box).getByText(/지금 보이는 종목은 규칙 점수 순서예요/)).toBeTruthy();
    expect(picks(box)).toHaveLength(3);
    expect(within(box).queryByText(/^AI \d위$/)).toBeNull();
    expect(within(box).getByRole("link", { name: /AI 선정 과정 보기/ }).getAttribute("href")).toBe("/reports/57");
  });

  it("예전 파일(선정 키 없음): 배지·안내 없이 예전 화면 그대로, 없는 값은 '-'", async () => {
    const old: ScreeningResult = {
      market: "KR",
      at: "2026-10-04T08:40:00+09:00",
      rankCount: 50,
      eligibleCount: 31,
      checked: 12,
      picks: [{ symbol: "005930", name: "삼성전자" }],
      dropped: [{ symbol: "035720", name: "카카오", reason: "20일선 아래" }],
      excluded: [],
      reportIds: [],
    };
    serve(old);
    renderApp("/reports");
    const box = await panel();
    const rows = await waitFor(() => {
      const r = picks(box);
      expect(r).toHaveLength(1);
      return r;
    });
    expect(within(rows[0]).getByText("005930 · 거래대금 -위")).toBeTruthy();
    expect(within(rows[0]).getByText("-")).toBeTruthy();
    expect(within(box).getByText(/탈락 1개: 20일선 아래 1/)).toBeTruthy();
    for (const t of ["AI 선정 팀이 고르고 안전장치가 거른 종목", "오늘은 규칙으로 골랐어요", "AI가 오늘의 종목을 고르는 중이에요"]) {
      expect(within(box).queryByText(t)).toBeNull();
    }
    expect(within(box).queryByText(/후보 \d+개/)).toBeNull();
  });

  it("서버에 선별이 없으면(404) AI 선정 예시를 '예시'로 보이고, 다른 리포트로 가는 과정 보기 링크는 두지 않는다", async () => {
    server.use(http.get("*/api/reports/screening", () => HttpResponse.json({ detail: "없음" }, { status: 404 })));
    renderApp("/reports");
    const box = await panel();
    expect(await within(box).findByText("예시")).toBeTruthy();
    expect(within(box).getByText("AI 선정 팀이 고르고 안전장치가 거른 종목")).toBeTruthy();
    expect(within(box).queryByRole("link", { name: /AI 선정 과정 보기/ })).toBeNull();
  });
});

/** 끝난 예시 선정 실행을 실패(사유 reason)로 바꾼 것. */
function failedSelection(id: number, reason: string): ReportDetail {
  const r = selectionSample(id, "2026-10-06T08:00:00+09:00");
  const trace: TraceEvent[] = [
    ...r.trace.filter((e) => e.actor !== "selection_review_agent" && e.action !== "workflow_completed"),
    {
      step: 99,
      actor: "orchestrator",
      action: "workflow_failed",
      status: "failed",
      provider: null,
      model: null,
      latencyMs: null,
      details: { reason },
      at: "2026-10-06T08:03:00+09:00",
    },
  ];
  return {
    ...r,
    status: "failed",
    content: null,
    plan: { ...r.plan, implemented: true },
    trace,
    state: { ...r.state, status: "failed", currentStep: "select_review", errors: { selection_review_agent: "timeout" } },
  };
}

describe("선정 실행 상세", () => {
  it("주린이모드여도 과정 화면: 선정 결과 탭(본문, PDF 없음) · 진행 기록(그래프·타임라인) · 자세히(State, 예시 재생 없음), 보기 전환 없음", async () => {
    const id = db.addSampleSelection();
    renderApp(`/reports/${id}`, "bob"); // bob은 주린이모드 켬
    expect(await screen.findByRole("heading", { name: "오늘의 매매 종목 선정", level: 1 })).toBeTruthy();
    expect(screen.getByText(`국내 · AI 종목 선정 #${id}`)).toBeTruthy();
    // 쉬운 보기(단계 막대·AI 의견)가 아니고 보기를 바꾸는 버튼도 없다
    expect(screen.queryByRole("button", { name: /이 화면만/ })).toBeNull();
    expect(screen.queryByText(/AI 의견/)).toBeNull();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["선정 결과", "진행 기록", "자세히"]);
    expect(within(screen.getByRole("region", { name: "실행 요약" })).getByText("실행 완료")).toBeTruthy();
    const report = screen.getByRole("tabpanel", { name: "선정 결과" });
    expect(await within(report).findByRole("heading", { name: "오늘의 매매 종목 선정", level: 3 })).toBeTruthy();
    expect(within(report).getByRole("cell", { name: /SK하이닉스 \(000660\)/ })).toBeTruthy();
    expect(within(report).queryByRole("button", { name: "PDF로 보기" })).toBeNull();
    expect(within(report).queryByText(/이 리포트의 AI 추천/)).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "진행 기록" }));
    const graph = await screen.findByRole("region", { name: /^작업 계획\(Planner\)/ });
    expect(within(graph).getByText(/매매 종목 선정 · 실패 정책 Required\/Optional/)).toBeTruthy();
    for (const title of ["후보 뉴스 점검 Agent", "후보 공시 점검 Agent", "수급 해석 Agent", "종목 선정 Agent", "선정 검토 Agent"]) {
      expect(within(graph).getByRole("article", { name: title })).toBeTruthy();
    }
    const timeline = within(screen.getByRole("list", { name: "Trace 사건" }));
    expect(timeline.getByText("선정 실행 시작")).toBeTruthy();
    expect(timeline.getByText("선정 완료")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "자세히" }));
    expect(await screen.findByRole("heading", { name: "Shared State" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "예시 Trace 재생" })).toBeNull();
  });

  it("실패한 선정 실행: 선정에 맞는 사유 문장 · 코드 · 둘째 문장 · 규칙 Fallback 안내, 다시 신청은 없다", async () => {
    const failed = failedSelection(77, "agent_failed");
    server.use(http.get("*/api/reports/:id", () => HttpResponse.json(failed)));
    renderApp("/reports/77?tab=report");
    expect(await screen.findByRole("heading", { name: "AI 선정을 끝내지 못했습니다" })).toBeTruthy();
    expect(screen.getByText(plain.SELECTION_FALLBACK_TEXT.agent_failed, { exact: false })).toBeTruthy();
    expect(screen.getByText("(agent_failed)")).toBeTruthy();
    expect(screen.getByText(lib.EXPERT_FAILURE_NOTE.agent_failed)).toBeTruthy();
    expect(screen.getByText(/이날 종목은 규칙 점수 순으로 고릅니다/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /다시 신청/ })).toBeNull();
    expect(screen.getByText("본문이 없습니다.")).toBeTruthy();
  });

  it("종목 리포트는 그대로: 첫 탭 이름은 '리포트', (미구현) 자리 표시는 implemented가 false일 때만", async () => {
    renderApp("/reports/2?tab=report");
    expect(await screen.findByRole("heading", { name: "삼성전자 AI 리포트" })).toBeTruthy();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["리포트", "진행 기록", "자세히"]);
    expect(screen.getByText("리포트 본문은 Agent 구현 뒤에 표시됩니다 (미구현)")).toBeTruthy();
  });

  it("구현된 계획(implemented)이면 실행 전 선정 실행에 (미구현) 자리 표시 대신 '고르는 중'", async () => {
    const base = selectionSample(78, "2026-10-06T08:00:00+09:00");
    const running: ReportDetail = {
      ...base,
      status: "running",
      content: null,
      finishedAt: null,
      currentStep: "select",
      plan: { ...base.plan, implemented: true },
      trace: base.trace.slice(0, 3),
      state: { ...base.state, status: "running", currentStep: "select" },
    };
    server.use(http.get("*/api/reports/:id", () => HttpResponse.json(running)));
    renderApp("/reports/78?tab=report");
    expect(await screen.findByText("AI가 종목을 고르는 중입니다.")).toBeTruthy();
    expect(screen.queryByText(/미구현/)).toBeNull();
    expect(screen.queryByText(lib.NOT_IMPLEMENTED, { exact: false })).toBeNull();
  });
});

describe("팀별 문장·진행 단계 (lib)", () => {
  it("실패 사유 코드 8개와 새 세 코드의 문장 (docs/tasks/00-공통.md 9절과 같다)", () => {
    expect(Object.keys(plain.REPORT_FAILURE_TEXT).sort()).toEqual(
      ["agent_failed", "engine_restarted", "exception", "expired", "join_blocked", "no_llm", "review_failed", "timeout"].sort(),
    );
    expect(plain.reportFailureSentence("expired")).toBe("오래 기다린 신청이라 실행하지 않았어요");
    expect(plain.reportFailureSentence("agent_failed")).toBe("필요한 AI가 끝내 응답하지 않아 멈췄어요");
    expect(plain.reportFailureSentence("no_llm")).toBe("AI 연결 설정이 없어 리포트를 쓰지 못했어요");
    for (const code of Object.keys(plain.REPORT_FAILURE_TEXT)) {
      expect(lib.FAILURE_NEXT[code], code).toBeTruthy();
      expect(lib.EXPERT_FAILURE_NOTE[code], code).toBeTruthy();
    }
  });

  it("선별 Fallback 사유 문장: no_candidates 포함, 리포트를 말하는 문장만 선정에 맞게, 모르는 코드는 기본 문장", () => {
    expect(plain.selectionFallbackSentence("no_candidates")).toBe("규칙 선별을 통과한 종목이 없었어요");
    expect(plain.selectionFallbackSentence("timeout")).toBe(plain.REPORT_FAILURE_TEXT.timeout);
    expect(plain.selectionFallbackSentence("agent_failed")).toBe(plain.REPORT_FAILURE_TEXT.agent_failed);
    for (const code of ["join_blocked", "review_failed", "no_llm", "expired"]) {
      expect(plain.selectionFallbackSentence(code)).not.toBe(plain.REPORT_FAILURE_TEXT[code as "join_blocked"]);
      expect(plain.selectionFallbackSentence(code)).not.toContain("리포트");
    }
    expect(plain.selectionFallbackSentence("brand_new")).toBe(plain.SELECTION_FALLBACK_FALLBACK);
    expect(plain.selectionFallbackSentence(null)).toBe(plain.SELECTION_FALLBACK_FALLBACK);
    expect(Object.keys(plain.SELECTION_FALLBACK_TEXT)).toHaveLength(9);
  });

  it("선정 팀 담당자 쉬운 이름과 팀 판별", () => {
    expect(lib.workerEasyName("news_screen_agent")).toBe("후보 뉴스를 보는 AI");
    expect(lib.workerEasyName("filing_screen_agent")).toBe("후보 공시를 보는 AI");
    expect(lib.workerEasyName("flow_agent")).toBe("수급을 보는 AI");
    expect(lib.workerEasyName("selector_agent")).toBe("종목을 고르는 AI");
    expect(lib.workerEasyName("selection_review_agent")).toBe("선정을 검토하는 AI");
    expect(lib.isSelection({ team: "stock_selection" })).toBe(true);
    expect(lib.isSelection({ team: "stock_report" })).toBe(false);
    expect(lib.isSelection({})).toBe(false); // 예전 서버 (team 없음)
    expect(lib.isSelection(selectionPlan())).toBe(true);
  });

  it("진행 단계는 팀마다: 선정은 후보 조사(뉴스·공시·수급) → 고르기 → 검토, 팀이 없으면 종목 리포트 다섯 단계", () => {
    const { trace } = selectionSample(5, "2026-10-06T08:00:00+09:00");
    expect(lib.progressStepsOf(undefined)).toBe(lib.PROGRESS_STEPS);
    expect(lib.progressStepsOf("stock_report")).toBe(lib.PROGRESS_STEPS);
    expect(lib.progressOf([], "stock_selection").map((s) => s.actor)).toEqual([
      "news_screen_agent",
      "filing_screen_agent",
      "flow_agent",
      "selector_agent",
      "selection_review_agent",
    ]);
    const done = lib.progressOf(trace, "stock_selection");
    expect(done.map((s) => s.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(lib.progressPeak(trace, "stock_selection")).toBe(5);
    expect(lib.progressAnnouncement(done)).toBe("다섯 단계를 모두 끝냈어요 (5/5)");
    // 선정 트레이스를 종목 리포트 단계로 읽으면 아무것도 시작하지 않은 것이다 (섞이지 않는다)
    expect(lib.progressOf(trace).every((s) => s.state === "waiting")).toBe(true);
    const upToSelect = lib.progressOf(trace.slice(0, 9), "stock_selection");
    expect(upToSelect.map((s) => s.state)).toEqual(["done", "done", "done", "active", "waiting"]);
    expect(lib.progressAnnouncement(upToSelect)).toBe("지금: 종목을 고르는 중 (3/5)");
    expect(lib.stoppedStepIndex(upToSelect, "review_failed")).toBe(4);
    expect(lib.stoppedStepIndex(upToSelect, "agent_failed")).toBe(3);
    expect(lib.stoppedStepIndex(lib.progressOf([], "stock_selection"), "no_llm")).toBe(0);
  });

  it("종목 리포트용 읽기 함수는 선정 결과에서 깨지지 않고 비어 있다", () => {
    const { state, trace } = selectionSample(6, "2026-10-06T08:00:00+09:00");
    expect(lib.draftOf(state)).toBeNull();
    expect(lib.researchOf(state)).toEqual({ market: null, fundamental: null, news: null });
    expect(lib.trustOf(state, trace)).toMatchObject({ reviewed: false, citations: 0, rewrites: 0, dataAt: null, recovery: [] });
  });

  it("타임라인 문장의 주어: 선정 계획이면 '선정', 아니면 '리포트'", () => {
    const e = (action: string, details: Record<string, unknown> = {}): TraceEvent => ({
      step: 1, actor: "orchestrator", action, status: "completed", provider: null, model: null, latencyMs: null, details, at: "2026-10-06T08:00:00+09:00",
    });
    const plan = selectionPlan();
    expect(lib.eventText(e("workflow_started", { chaos: true }), plan)?.text).toBe("선정 실행 시작 · 장애 주입 켜짐");
    expect(lib.eventText(e("workflow_completed"), plan)?.text).toBe("선정 완료");
    expect(lib.eventText(e("workflow_failed", { reason: "no_llm" }), plan)?.text).toBe("선정 실패 — no_llm");
    expect(lib.eventText(e("workflow_started"), undefined)?.text).toBe("리포트 실행 시작");
    expect(lib.eventText(e("workflow_completed"), undefined)?.text).toBe("리포트 완성");
  });
});

describe("가짜 API — 팀", () => {
  it("목록은 기본이 종목 리포트만, ?team=stock_selection이면 선정 실행, 모르는 팀·source는 400", () => {
    const id = db.addSampleSelection();
    expect(db.listReports(null).every((r) => r.team === "stock_report")).toBe(true);
    expect(db.listReports(null).some((r) => r.id === id)).toBe(false);
    expect(db.listReports(null, { team: "stock_selection" }).map((r) => r.id)).toEqual([id]);
    expect(db.listReports(null, { team: "stock_selection" })[0]).toMatchObject({ source: "auto", requestedBy: "자동", opinion: null, hasPdf: false });
    expect(() => db.listReports(null, { team: "nope" })).toThrow(db.MockError);
    expect(() => db.listReports(null, { source: "robot" })).toThrow(db.MockError);
    expect(db.screening().selection).toEqual({ reportId: id, status: "done" });
  });

  it("GET /api/reports/plan?team=: 팀마다 계획, 모르는 팀은 400", async () => {
    db.setSession("alice");
    const get = (q: string) => fetch(`http://localhost/api/reports/plan${q}`);
    expect(((await (await get("")).json()) as { team: string }).team).toBe("stock_report");
    expect(((await (await get("?team=stock_selection")).json()) as { team: string }).team).toBe("stock_selection");
    expect((await get("?team=nope")).status).toBe(400);
    const list = (await (await fetch("http://localhost/api/reports?team=stock_selection")).json()) as { results: unknown[] };
    expect(list.results).toEqual([]);
  });
});
