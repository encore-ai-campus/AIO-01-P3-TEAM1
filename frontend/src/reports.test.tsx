// AI 리포트 화면: 신청·목록·작업 계획 그래프·예시 Trace 재생·교육용 문서·Snapshot+SSE 합치기.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportDetail, TraceEvent } from "./api/types";
import { DISCLAIMER } from "./lib/plainText";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";

/** 브라우저 EventSource 대신 쓰는 가짜. emit으로 서버 사건을 흉내 낸다. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, ((e: Event) => void)[]>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener() {}
  close() {
    this.closed = true;
  }
  emit(type: string, data?: unknown) {
    const ev = new MessageEvent(type, { data: data === undefined ? "" : JSON.stringify(data) });
    act(() => {
      for (const fn of this.listeners.get(type) ?? []) fn(ev);
    });
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
});
afterEach(() => {
  vi.unstubAllGlobals();
  server.events.removeAllListeners();
});

const region = (name: string | RegExp) => screen.getByRole("region", { name });
const node = (title: string) => within(region(/^작업 계획/)).getByRole("article", { name: title });
const traceItems = () => within(screen.getByRole("list", { name: "Trace 사건" })).getAllByRole("listitem");
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole("button", { name }));
const tab = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));
/** 타임라인을 "전체"로 (기본은 주요 사건만). */
const showAll = () => click("전체");

function ev(step: number, actor: string, action: string, status: TraceEvent["status"]): TraceEvent {
  return { step, actor, action, status, provider: null, model: null, latencyMs: null, details: {}, at: "2026-10-02T10:00:00+09:00" };
}

describe("리포트 목록·신청", () => {
  it("팀 리포트 목록과 미구현 안내, 작업 계획(Planner) 미리 보기를 보인다", async () => {
    renderApp("/reports");
    const list = await screen.findByRole("list", { name: "리포트 목록" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // 최신순
    expect(within(rows[0]).getByText("삼성전자")).toBeTruthy();
    expect(within(rows[0]).getByText(/앨리스/)).toBeTruthy();
    expect(within(rows[0]).getByText("신청됨")).toBeTruthy();
    expect(within(rows[1]).getByText("SK하이닉스")).toBeTruthy();
    expect(within(rows[1]).getByText(/밥/)).toBeTruthy();
    expect(rows[1].querySelector("a")?.getAttribute("href")).toBe("/reports/1");

    expect(await screen.findByText("Agent 실행은 아직 구현되지 않았습니다. 신청은 기록되고 구조만 볼 수 있습니다.")).toBeTruthy();
    // 미리 보기는 접혀 있다
    click(/작업 계획\(Planner\) 미리 보기/);
    const preview = await screen.findByRole("region", { name: /^작업 계획\(Planner\) 미리 보기/ });
    expect(await within(preview).findByRole("region", { name: "Join Guard" })).toBeTruthy();
    // 미리 보기는 모두 대기
    expect(within(within(preview).getByRole("article", { name: "시세·차트 Agent" })).getByText("대기")).toBeTruthy();
  });

  it("종목을 검색해 골라 만들면 만들어진 리포트 상세로 간다", async () => {
    renderApp("/reports");
    fireEvent.change(await screen.findByLabelText("종목 검색"), { target: { value: "현대" } });
    fireEvent.click(await screen.findByRole("button", { name: /현대차/ }));
    expect(screen.getByText("현대차", { selector: "b" })).toBeTruthy();
    click("AI 리포트 만들기");
    expect(await screen.findByRole("heading", { name: "현대차 AI 리포트" })).toBeTruthy();
    // 실행 전이라 "진행 기록" 탭이 기본 (과제 용어는 사용자 용어 "실행 준비·실행 확인"과 겹치지 않게 — 컨셉 4-3)
    expect(screen.getByRole("tab", { name: "진행 기록" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("tab", { name: /실행/ })).toBeNull();
    expect(screen.getByRole("region", { name: /^작업 계획\(Planner\)/ })).toBeTruthy();
    // 전문가 보기에도 통일 면책 문장 (탭과 상관없이)
    expect(screen.getByText(DISCLAIMER)).toBeTruthy();
    tab("리포트");
    expect(screen.getByText(DISCLAIMER)).toBeTruthy();
    expect(screen.getByText("리포트 본문은 Agent 구현 뒤에 표시됩니다 (미구현)")).toBeTruthy();
    expect(db.listReports("005380")).toHaveLength(1);
    expect(db.listReports("005380")[0].chaosEnabled).toBe(false);
  });

  it("장애 주입을 켜면 복구 시연 프리셋(주 모델만, 확률 0.8)으로 신청하고 목록에서 거를 수 있다", async () => {
    renderApp("/reports");
    fireEvent.change(await screen.findByLabelText("종목 검색"), { target: { value: "현대" } });
    fireEvent.click(await screen.findByRole("button", { name: /현대차/ }));
    fireEvent.click(screen.getByRole("switch", { name: /장애 주입/ }));
    expect(screen.getByRole("button", { name: /복구 시연/ }).getAttribute("aria-pressed")).toBe("true");
    click("AI 리포트 만들기");
    expect(await screen.findByRole("heading", { name: "현대차 AI 리포트" })).toBeTruthy();
    const made = db.getReport(db.listReports("005380")[0].id);
    expect(made.chaos).toMatchObject({ enabled: true, scope: "primary", probability: 0.8 });
    expect(screen.getByText("주입")).toBeTruthy();

    renderApp("/reports");
    const lists = await screen.findAllByRole("list", { name: "리포트 목록" });
    fireEvent.click(screen.getAllByRole("button", { name: "장애 주입" }).at(-1)!);
    await waitFor(() => expect(within(lists.at(-1)!).getAllByRole("listitem")).toHaveLength(1));
  });

  it("종목 상세의 AI 리포트 만들기 버튼도 리포트 상세로 간다 (AI 교차검증 분석과 별개)", async () => {
    renderApp("/stocks/005380");
    await screen.findByRole("button", { name: /AI 교차검증 분석/ });
    fireEvent.click(await screen.findByRole("button", { name: "AI 리포트 만들기" }));
    expect(await screen.findByRole("heading", { name: "현대차 AI 리포트" })).toBeTruthy();
    expect(db.listReports("005380")).toHaveLength(1);
  });

  it("전문가 목록: 칩(내·팀·교차검증), 완성 리포트에 의견(전문가 용어)·한 줄 요약, 교차검증은 점수·분석 시각 가격과 분석 상세 링크", async () => {
    db.addSampleReports();
    renderApp("/reports");
    const list = await screen.findByRole("list", { name: "리포트 목록" });
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(5));
    const naver = within(list)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("NAVER"));
    expect(naver).toBeTruthy();
    expect(within(naver as HTMLElement).getByText("AI 의견 매수")).toBeTruthy();
    expect(within(naver as HTMLElement).getByText("완료")).toBeTruthy();
    expect(within(naver as HTMLElement).getByText(/오를 근거가 더 많다고 봤다/)).toBeTruthy();
    // 만드는 중·실패에는 의견이 없다
    const failed = within(list)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("에코프로"));
    expect(within(failed as HTMLElement).queryByText(/AI 의견/)).toBeNull();
    expect(within(failed as HTMLElement).getByText("실패")).toBeTruthy();

    click("내 리포트");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "리포트 목록" })).getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "내 리포트" })).toBeTruthy();

    click("교차검증 분석");
    const rows = within(await screen.findByRole("list", { name: "교차검증 분석 목록" })).getAllByRole("listitem");
    const first = db.listAnalyses(null, null)[0];
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe(`/analyses/${first.id}`);
    expect(within(rows[0]).getByText(first.verdict)).toBeTruthy();
    if (first.best) expect(within(rows[0]).getByText(/점수/)).toBeTruthy();
    if (first.priceAtAnalysis !== null) expect(within(rows[0]).getByText(/분석 시각 가격/)).toBeTruthy();
  });

  it("하단 탭과 왼쪽 메뉴에 리포트가 있다", async () => {
    renderApp("/reports");
    const tabs = await screen.findByRole("navigation", { name: "하단 탭" });
    expect(within(tabs).getAllByRole("link").map((a) => a.textContent)).toEqual(["홈", "종목", "리포트", "모의투자", "마이"]);
    expect(within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("link", { name: "리포트" })).toBeTruthy();
  });
});

describe("리포트 상세", () => {
  it("작업 계획 그래프가 Worker·필수/선택·병렬·Join Guard·Handoff를 그린다", async () => {
    renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    const graph = region(/^작업 계획/);
    expect(within(graph).getByRole("region", { name: "단계 조사" })).toBeTruthy();
    expect(within(graph).getByText("병렬")).toBeTruthy();
    expect(within(node("시세·차트 Agent")).getByText("필수")).toBeTruthy();
    expect(within(node("재무·공시 Agent")).getByText("필수")).toBeTruthy();
    expect(within(node("뉴스·심리 Agent")).getByText("선택")).toBeTruthy();
    expect(within(node("뉴스·심리 Agent")).getByText("미정")).toBeTruthy();
    expect(within(node("뉴스·심리 Agent")).getByText("NewsResult")).toBeTruthy();
    const join = within(graph).getByRole("region", { name: "Join Guard" });
    expect(within(join).getByText("시세·차트 Agent, 재무·공시 Agent")).toBeTruthy();
    // Handoff: 검토 → 리스크 점검 (점선, 책임 이전)
    expect(within(graph).getByText("Handoff · 책임 이전")).toBeTruthy();
    expect(within(node("리스크 점검 Agent")).getByText("Handoff 대상")).toBeTruthy();
    expect(within(node("검토 Agent")).getByText("대기")).toBeTruthy();

    expect(screen.getByText("아직 실행 사건이 없습니다.")).toBeTruthy();
    tab("리포트");
    expect(screen.getByText("리포트 본문은 Agent 구현 뒤에 표시됩니다 (미구현)")).toBeTruthy();
    tab("자세히");
    // 정책 안내: 이 팀의 정책 강조, Handoff 계약 필드
    const policy = region("정책 안내");
    expect(within(policy).getByRole("row", { current: true }).textContent).toContain("Required/Optional");
    expect(within(within(policy).getByRole("list", { name: "Handoff 계약 필드" })).getAllByRole("listitem")).toHaveLength(8);
  });

  it("예시 ① 정상 흐름: 노드 상태·타임라인·State가 바뀌고 예시 표시가 보인다 (서버에 보내지 않음)", async () => {
    const sent: string[] = [];
    renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    server.events.on("request:start", ({ request }) => {
      sent.push(`${request.method} ${new URL(request.url).pathname}`);
    });

    click(/① 정상 흐름/);
    click("멈춤");
    expect(screen.getByText("예시 데이터 — 실제 실행이 아닙니다")).toBeTruthy();
    for (let i = 0; i < 6; i++) click("다음 사건");
    showAll();

    // 병렬 3개 시작 → 재무가 먼저 완료 → 뉴스(선택) 실패, 시세는 아직 실행 중
    expect(within(node("재무·공시 Agent")).getByText("완료")).toBeTruthy();
    expect(within(node("뉴스·심리 Agent")).getByText("실패")).toBeTruthy();
    expect(within(node("시세·차트 Agent")).getByText("실행 중")).toBeTruthy();
    expect(within(node("뉴스·심리 Agent")).getByText("llama3.2", { exact: false })).toBeTruthy();
    expect(traceItems()).toHaveLength(6);
    tab("자세히");
    const state = region(/^Shared State/);
    expect(within(state).getByText("뉴스·심리 Agent")).toBeTruthy();
    expect(within(state).getByText("parallel_research")).toBeTruthy();
    tab("진행 기록");
    showAll();

    for (let i = 0; i < 7; i++) click("다음 사건");
    expect(screen.getByText(/사건 13 \/ 13/)).toBeTruthy();
    expect(within(region("Join Guard")).getByText("완료")).toBeTruthy();
    expect(within(node("리포트 작성 Agent")).getByText("완료")).toBeTruthy();
    expect(within(node("검토 Agent")).getByText("완료")).toBeTruthy();
    expect(traceItems()).toHaveLength(13);
    expect(within(traceItems()[12]).getByText("workflow_completed")).toBeTruthy();
    // 요약 띠: 예시 ①은 호출 실패(final: false)가 없어 장애 0건
    expect(within(region("실행 요약")).getByText(/장애 없음/)).toBeTruthy();
    expect(screen.getByText("예시 데이터 — 실제 실행이 아닙니다")).toBeTruthy();
    expect(sent.filter((s) => !s.startsWith("GET"))).toEqual([]);

    // 처음으로 → 비어 있음, 예시 끄기 → 실제 기록(빈 Trace)으로
    click("처음으로");
    expect(screen.getByText("아직 실행 사건이 없습니다.")).toBeTruthy();
    click("예시 끄기");
    expect(screen.queryByText("예시 데이터 — 실제 실행이 아닙니다")).toBeNull();
  });

  it("예시 ① 자동 재생은 사건을 차례로 흘린다", async () => {
    renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    click(/① 정상 흐름/);
    fireEvent.click(await screen.findByRole("button", { name: "전체" }));
    await waitFor(() => expect(traceItems().length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
  });

  it("예시 ② 필수 Worker 실패: Join 차단과 건너뜀", async () => {
    renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    click(/② 필수 Worker 실패/);
    click("멈춤");
    for (let i = 0; i < 11; i++) click("다음 사건");

    expect(within(node("재무·공시 Agent")).getByText("실패")).toBeTruthy();
    expect(within(region("Join Guard")).getByText("차단")).toBeTruthy();
    expect(within(node("리포트 작성 Agent")).getByText("건너뜀")).toBeTruthy();
    expect(within(node("검토 Agent")).getByText("건너뜀")).toBeTruthy();
    // 주요 사건(기본): 문장으로
    expect(screen.getByText("필수 결과가 없어 Join을 막음")).toBeTruthy();
    expect(screen.getByText(/^리포트 실패 — 필수 Worker/)).toBeTruthy();
    showAll();
    expect(screen.getByText("join_blocked")).toBeTruthy();
    expect(screen.getByText("workflow_failed")).toBeTruthy();
    expect(within(region("실행 요약")).getByText("실행 실패")).toBeTruthy();
    expect(screen.getByText("예시 데이터 — 실제 실행이 아닙니다")).toBeTruthy();
  });

  it("예시 ③ 모델 실패 → 대체 모델로 복구: 시도 이력·자동 복구·요약·검토 반복", async () => {
    renderApp("/reports/2?tab=more");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    // "자세히" 탭에서 고르면 "진행 기록" 탭으로 옮긴다
    click(/③ 모델 실패/);
    expect(screen.getByRole("tab", { name: "진행 기록" }).getAttribute("aria-selected")).toBe("true");
    click("멈춤");
    for (let i = 0; i < 9; i++) click("다음 사건");

    // 뉴스: 두 번 실패(주입) → 대체 모델로 전환해 시도 중. 호출 실패는 노드의 실패가 아니다
    const news = () => node("뉴스·심리 Agent");
    expect(within(news()).getByText("실행 중")).toBeTruthy();
    expect(within(news()).getAllByText("시간 초과")).toHaveLength(2);
    expect(within(news()).getByText("시도 중")).toBeTruthy();
    expect(within(news()).getByText("주입")).toBeTruthy();
    expect(within(news()).queryByText("자동 복구")).toBeNull();

    for (let i = 0; i < 13; i++) click("다음 사건");
    expect(screen.getByText(/사건 22 \/ 22/)).toBeTruthy();
    const chips = within(within(news()).getByRole("list", { name: "시도 이력" })).getAllByRole("listitem");
    expect(chips.map((c) => c.textContent)).toEqual(["llama3.2시간 초과", "llama3.2시간 초과", "gpt-4.1-mini성공"]);
    expect(within(news()).getByText("자동 복구")).toBeTruthy();
    expect(within(region("단계 리포트 작성")).getByText(/검토 뒤 다시 작성 1/)).toBeTruthy();

    const summary = region("실행 요약");
    expect(within(summary).getByText("1건 (주입 1)")).toBeTruthy();
    expect(within(summary).getByText("1건")).toBeTruthy();
    expect(within(summary).getByText("3.14초")).toBeTruthy();

    // 주요 사건만: agent_started·join_completed는 빠진다
    expect(traceItems()).toHaveLength(14);
    expect(screen.getByText("대체 모델 gpt-4.1-mini(으)로 전환 (← llama3.2)")).toBeTruthy();
    expect(screen.getByText("검토 → 리포트 작성 Agent 다시 작성 (1번째)")).toBeTruthy();
    showAll();
    expect(traceItems()).toHaveLength(22);
  });

  it("복구 지표는 리포트 목록이 아니라 관리자 화면에 있다", async () => {
    renderApp("/reports");
    await screen.findByRole("list", { name: "리포트 목록" });
    expect(screen.queryByRole("link", { name: "복구 지표 보기" })).toBeNull();
  });

  it("관리자 화면의 복구 지표: 자동 복구율·평균 복구시간·유형별·최근 사례", async () => {
    renderApp("/ops");
    expect(await screen.findByRole("heading", { name: "관리자" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "복구 지표" })).toBeTruthy();
    expect(await screen.findByText("85.7%")).toBeTruthy();
    expect(screen.getByText("3.42초")).toBeTruthy();
    expect(within(region("장애 유형별")).getByText("복구 7 · 미복구 0")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "최근 장애 사례" })).getAllByRole("listitem")).toHaveLength(4);
  });

  it("개념 문서: 자세히 탭의 접이식 영역에서 교육용 문서를 렌더한다", async () => {
    renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    tab("자세히");
    fireEvent.click(screen.getByRole("button", { name: /개념 문서/ }));
    expect(await screen.findByRole("heading", { name: "04 Distributed Collaboration" }, { timeout: 5000 })).toBeTruthy();
    // 표도 그린다
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);
  });

  it("목록 화면에서도 교육용 문서를 열 수 있다", async () => {
    renderApp("/reports");
    fireEvent.click(await screen.findByRole("button", { name: /개념 문서/ }));
    expect(await screen.findByRole("heading", { name: "04 Distributed Collaboration" }, { timeout: 5000 })).toBeTruthy();
  });

  it("없는 리포트는 안내한다", async () => {
    renderApp("/reports/999");
    expect(await screen.findByText("리포트를 찾을 수 없습니다.")).toBeTruthy();
  });
});

describe("Snapshot + SSE", () => {
  it("Agent 구현 전(implemented=false)이고 신청됨이면 SSE를 열지 않는다", async () => {
    renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    expect(screen.getByText("대기", { selector: "span span" })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 50));
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it("Snapshot 뒤 SSE로 trace·state·end를 이어 받아 합친다 (같은 step은 한 번만)", async () => {
    const base = db.getReport(2);
    const running: ReportDetail = {
      ...base,
      status: "running",
      currentStep: "parallel_research",
      plan: { ...base.plan, implemented: true },
      state: { ...base.state, status: "running", currentStep: "parallel_research" },
      trace: [ev(1, "orchestrator", "workflow_started", "started"), ev(2, "market_agent", "agent_started", "started")],
    };
    let current = running;
    server.use(http.get("*/api/reports/:id", () => HttpResponse.json(current)));

    const { client } = renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    expect(es.url).toBe("/api/reports/2/events?after=2");
    expect(screen.getByText("Snapshot")).toBeTruthy();

    es.emit("open");
    expect(screen.getByText("실시간 SSE")).toBeTruthy();
    showAll();
    expect(traceItems()).toHaveLength(2);

    es.emit("trace", ev(2, "market_agent", "agent_started", "started")); // 다시 붙을 때 겹쳐 온 사건
    es.emit("trace", ev(3, "market_agent", "agent_completed", "completed"));
    es.emit("trace", ev(3, "market_agent", "agent_completed", "completed"));
    // TanStack Query는 구독자에게 다음 틱에 알린다
    await waitFor(() => expect(traceItems()).toHaveLength(3));
    expect((client.getQueryData(["report", 2]) as ReportDetail).trace.map((e) => e.step)).toEqual([1, 2, 3]);
    expect(within(traceItems()[2]).getByText("agent_completed")).toBeTruthy();
    expect(within(node("시세·차트 Agent")).getByText("완료")).toBeTruthy();

    es.emit("state", { ...running.state, completedAgents: ["market_agent"], results: { market_agent: { trend: "상승" } } });
    tab("자세히");
    const state = region("Shared State");
    expect(await within(state).findByText("시세·차트 Agent")).toBeTruthy();
    expect(within(state).getByText("market_agent")).toBeTruthy();
    tab("진행 기록");

    // 끊기면 Snapshot 폴링으로 바뀐다
    es.emit("error");
    expect(screen.getByText("Snapshot")).toBeTruthy();
    es.emit("open");

    current = {
      ...running,
      status: "completed",
      finishedAt: "2026-10-02T10:01:00+09:00",
      content: "## 요약\n\n삼성전자 리포트 본문",
      state: { ...running.state, status: "completed", currentStep: null },
      trace: [...running.trace, ev(3, "market_agent", "agent_completed", "completed")],
    };
    es.emit("end", { status: "completed" });
    expect(es.closed).toBe(true);
    // 보던 탭을 강제로 바꾸지 않고 요약 띠에 버튼을 띄운다
    fireEvent.click(await screen.findByRole("button", { name: "리포트 완성 · 보기" }));
    expect(await screen.findByText("삼성전자 리포트 본문")).toBeTruthy();
    tab("진행 기록");
    showAll();
    expect(traceItems()).toHaveLength(3);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it("종료 state가 먼저 와도 남은 trace와 end를 받을 때까지 연결을 닫지 않는다", async () => {
    // 실제 서버 순서: state(completed) → 마지막 trace → end. state에서 닫으면 마지막 사건과 본문을 놓친다
    const base = db.getReport(2);
    const running: ReportDetail = {
      ...base,
      status: "running",
      currentStep: "review",
      plan: { ...base.plan, implemented: true },
      state: { ...base.state, status: "running", currentStep: "review" },
      trace: [ev(1, "review_agent", "agent_completed", "completed")],
    };
    const done = ev(2, "orchestrator", "workflow_completed", "completed");
    let current = running;
    server.use(http.get("*/api/reports/:id", () => HttpResponse.json(current)));

    renderApp("/reports/2");
    await screen.findByRole("heading", { name: "삼성전자 AI 리포트" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const es = FakeEventSource.instances[0];
    es.emit("open");
    showAll();

    current = {
      ...running,
      status: "completed",
      currentStep: null,
      content: "## 요약\n\n끝난 뒤 받은 본문",
      state: { ...running.state, status: "completed", currentStep: null },
      trace: [...running.trace, done],
    };
    es.emit("state", current.state);
    expect(es.closed).toBe(false);
    es.emit("trace", done);
    await waitFor(() => expect(traceItems()).toHaveLength(2));
    expect(within(traceItems()[1]).getByText("workflow_completed")).toBeTruthy();
    es.emit("end", { status: "completed" });
    expect(es.closed).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "리포트 완성 · 보기" }));
    expect(await screen.findByText("끝난 뒤 받은 본문")).toBeTruthy();
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
