// AI 리포트 화면: 신청·목록·작업 계획 그래프·예시 Trace 재생·교육용 문서·Snapshot+SSE 합치기.
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportDetail, TraceEvent } from "../api/types";
import { DISCLAIMER } from "../lib/plainText";
import { EXPERT_FAILURE_NOTE, VERDICT_TEXT } from "../lib/reports";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";

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
/** 고른 종목의 오늘 리포트 확인이 끝나 '만들기'를 누를 수 있게 되면 그 버튼 (확인 중에는 막혀 있다). */
async function createButton() {
  const b = screen.getByRole("button", { name: "AI 리포트 만들기" }) as HTMLButtonElement;
  await waitFor(() => expect(b.disabled).toBe(false));
  return b;
}

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
    // 만드는 중인 내 리포트 띠 (앨리스의 삼성전자 — 탭의 점을 보고 들어온 사람의 목적지, 목록과 다른 이름)
    const making = screen.getByRole("list", { name: "만드는 중인 내 리포트" });
    expect(within(making).getByRole("link", { name: "삼성전자 리포트 진행 보기" }).getAttribute("href")).toBe("/reports/2");
    // 미리 보기는 접혀 있다 (열린 동안만 aria-controls)
    const toggle = screen.getByRole("button", { name: /작업 계획\(Planner\) 미리 보기/ });
    expect([toggle.getAttribute("aria-expanded"), toggle.getAttribute("aria-controls")]).toEqual(["false", null]);
    click(/작업 계획\(Planner\) 미리 보기/);
    expect(toggle.getAttribute("aria-controls")).toBe("plan-preview");
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
    // 고르면 검색 결과를 접고 고른 종목 칩을 보인다 (버튼이 입력칸 바로 아래로) — 칩을 누르면 다시 편다
    expect(screen.queryByRole("list", { name: "검색한 종목" })).toBeNull();
    // 포커스는 접힌 목록(사라진 결과 버튼)에서 body로 떨어지지 않고 고른 종목 칩으로 (화면 읽기에 고른 종목이 읽힌다)
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "고른 종목 현대차 005380 바꾸기" }));
    click("고른 종목 현대차 005380 바꾸기");
    expect(await screen.findByRole("list", { name: "검색한 종목" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("종목 검색"));
    fireEvent.click(screen.getByRole("button", { name: /^현대차/ }));
    fireEvent.click(await createButton());
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
    fireEvent.click(await createButton());
    expect(await screen.findByRole("heading", { name: "현대차 AI 리포트" })).toBeTruthy();
    const made = db.getReport(db.listReports("005380")[0].id);
    expect(made.chaos).toMatchObject({ enabled: true, scope: "primary", probability: 0.8 });
    expect(screen.getByText("주입")).toBeTruthy();

    renderApp("/reports");
    const lists = await screen.findAllByRole("list", { name: "리포트 목록" });
    fireEvent.click(screen.getAllByRole("button", { name: "장애 주입" }).at(-1)!);
    await waitFor(() => expect(within(lists.at(-1)!).getAllByRole("listitem")).toHaveLength(1));
  });

  it("오늘 그 종목 리포트가 이미 있으면 '오늘 리포트 보기'가 먼저, 새로 만들기는 작게 (종목 상세와 같은 규칙)", async () => {
    renderApp("/reports");
    fireEvent.change(await screen.findByLabelText("종목 검색"), { target: { value: "삼성" } });
    fireEvent.click(await screen.findByRole("button", { name: /^삼성전자/ }));
    const open = await screen.findByRole("link", { name: "오늘 리포트 보기" });
    expect(open.getAttribute("href")).toBe("/reports/2");
    expect(screen.getByText("앨리스 님이 만듦 · 신청됨")).toBeTruthy();
    expect(screen.getByRole("button", { name: "새로 만들기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "AI 리포트 만들기" })).toBeNull();
  });

  it("고른 종목의 오늘 리포트를 확인하는 동안은 '만들기'가 막혀 있다 (확인 전에 눌러 같은 날 리포트를 또 만들지 않게)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get("*/api/reports", async ({ request }) => {
        if (new URL(request.url).searchParams.get("symbol") === "005930") await gate;
        return undefined; // 기본 처리기로
      }),
    );
    renderApp("/reports");
    fireEvent.change(await screen.findByLabelText("종목 검색"), { target: { value: "삼성" } });
    fireEvent.click(await screen.findByRole("button", { name: /^삼성전자/ }));
    const make = screen.getByRole("button", { name: "AI 리포트 만들기" }) as HTMLButtonElement;
    expect([make.disabled, make.getAttribute("aria-busy")]).toEqual([true, "true"]);
    fireEvent.click(make);
    release();
    // 확인이 끝나면 오늘 리포트가 주 버튼이 되고, 막혀 있는 동안 누른 것으로는 아무것도 만들지 않았다
    expect(await screen.findByRole("link", { name: "오늘 리포트 보기" })).toBeTruthy();
    expect(db.listReports("005930")).toHaveLength(1);
  });

  it("장애 주입을 끄면 프리셋이 접힌다", async () => {
    renderApp("/reports");
    const sw = await screen.findByRole("switch", { name: /장애 주입/ });
    fireEvent.click(sw);
    expect(screen.getByRole("group", { name: "장애 주입 프리셋" })).toBeTruthy();
    fireEvent.click(sw);
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(screen.queryByRole("group", { name: "장애 주입 프리셋" })).toBeNull();
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
    // 밥이 신청한 실패 리포트(에코프로)는 팀 리포트에 없다 — 남의 실패는 팀 피드에서 뺀다 (UX-15)
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(4));
    expect(within(list).queryByText(/에코프로/)).toBeNull();
    const naver = within(list)
      .getAllByRole("listitem")
      .find((li) => li.textContent?.includes("NAVER"));
    expect(naver).toBeTruthy();
    expect(within(naver as HTMLElement).getByText("AI 의견 매수")).toBeTruthy();
    expect(within(naver as HTMLElement).getByText("완료")).toBeTruthy();
    expect(within(naver as HTMLElement).getByText(/오를 근거가 더 많다고 봤다/)).toBeTruthy();
    // '장애 주입' 거르기는 실패까지 그대로 (시연용 — 실패는 report-e2efix.test.tsx)

    click("내 리포트");
    await waitFor(() => expect(within(screen.getByRole("list", { name: "리포트 목록" })).getAllByRole("listitem")).toHaveLength(1));
    expect(screen.getByRole("heading", { name: "내 리포트" })).toBeTruthy();

    click("교차검증 분석");
    const rows = within(await screen.findByRole("list", { name: "교차검증 분석 목록" })).getAllByRole("listitem");
    const first = db.listAnalyses(null, null)[0];
    expect(rows[0].querySelector("a")?.getAttribute("href")).toBe(`/analyses/${first.id}`);
    // 판정은 전문가 보기도 한국어 (BUY 매수 · PASS 지켜보기)
    expect(within(rows[0]).getByText(VERDICT_TEXT[first.verdict])).toBeTruthy();
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
    expect(within(node("뉴스·심리 Agent")).getByText("gemini-3.8-flash", { exact: false })).toBeTruthy();
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

    // 뉴스: 주 모델 실패(주입) → 대체 모델로 전환 → 대체 모델도 실패 → 같은 대체 모델로 다시 시도 중. 호출 실패는 노드의 실패가 아니다
    const news = () => node("뉴스·심리 Agent");
    expect(within(news()).getByText("실행 중")).toBeTruthy();
    expect(within(news()).getAllByText("시간 초과")).toHaveLength(2);
    expect(within(news()).getByText("시도 중")).toBeTruthy();
    expect(within(news()).getByText("주입")).toBeTruthy();
    expect(within(news()).queryByText("자동 복구")).toBeNull();

    for (let i = 0; i < 13; i++) click("다음 사건");
    expect(screen.getByText(/사건 22 \/ 22/)).toBeTruthy();
    const chips = within(within(news()).getByRole("list", { name: "시도 이력" })).getAllByRole("listitem");
    // 주 모델 timeout은 바로 대체 모델, 대체 모델 timeout은 한 번 더 (2026-10-08)
    expect(chips.map((c) => c.textContent)).toEqual(["gemini-3.8-flash시간 초과", "gpt-5.6-luna시간 초과", "gpt-5.6-luna성공"]);
    expect(within(news()).getByText("자동 복구")).toBeTruthy();
    expect(within(region("단계 리포트 작성")).getByText(/검토 뒤 다시 작성 1/)).toBeTruthy();

    const summary = region("실행 요약");
    expect(within(summary).getByText("1건 (주입 1)")).toBeTruthy();
    expect(within(summary).getByText("1건")).toBeTruthy();
    expect(within(summary).getByText("3.14초")).toBeTruthy();

    // 주요 사건만: agent_started·join_completed는 빠진다
    expect(traceItems()).toHaveLength(14);
    expect(screen.getByText("대체 모델 gpt-5.6-luna(으)로 전환 (← gemini-3.8-flash)")).toBeTruthy();
    expect(screen.getByText("검토 → 리포트 작성 Agent 다시 작성 (1번째)")).toBeTruthy();
    const feedback = screen.getByRole("heading", { name: "Feedback Loop · 검토 후 재작성" }).closest("section") as HTMLElement;
    expect(within(feedback).getByText(/1번째 검토/)).toBeTruthy();
    expect(within(feedback).getByText(/수정할 점:/)).toBeTruthy();
    showAll();
    expect(traceItems()).toHaveLength(22);
  });

  it("재생 미니 줄: 띠가 가려지면 탭 줄에 붙고, 붙은 동안은 그 높이만큼 아래에서 본다 (스크롤 앵커링이 없는 브라우저에서 생겼다 사라지기를 되풀이하지 않게)", async () => {
    // 지켜보는 것을 손으로 알리는 가짜 IntersectionObserver (jsdom에는 없다)
    type Entry = { isIntersecting: boolean };
    const watchers: { cb: (entries: Entry[]) => void; margin: string; live: boolean }[] = [];
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        private w: (typeof watchers)[number];
        constructor(cb: (entries: Entry[]) => void, opts?: { rootMargin?: string }) {
          this.w = { cb, margin: opts?.rootMargin ?? "", live: true };
          watchers.push(this.w);
        }
        observe() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
        disconnect() {
          this.w.live = false;
        }
      },
    );
    renderApp("/reports/2?tab=more");
    fireEvent.click(await screen.findByRole("button", { name: /정상 흐름/ }));
    // 재생 띠를 지켜보는 것 (위쪽을 덮인 만큼 뺀다 — 타임라인 끝을 지켜보는 것은 아래쪽을 뺀다)
    const bar = () => watchers.filter((w) => w.live && w.margin.startsWith("-")).at(-1)!;
    await waitFor(() => expect(bar().margin).toBe("-120px 0px 0px 0px"));
    expect(screen.queryByRole("button", { name: "예시 다음 사건" })).toBeNull();
    act(() => bar().cb([{ isIntersecting: false }]));
    expect(screen.getByRole("button", { name: "예시 다음 사건" })).toBeTruthy();
    // 미니 줄(48px)만큼 붙은 탭 줄이 길어졌으니 보는 선도 내린다 — 미니 줄이 띠를 밀어도 다시 '보임'이 되지 않는다
    expect(bar().margin).toBe("-168px 0px 0px 0px");
    act(() => bar().cb([{ isIntersecting: true }]));
    expect(screen.queryByRole("button", { name: "예시 다음 사건" })).toBeNull();
    expect(bar().margin).toBe("-120px 0px 0px 0px");
  });

  it("'자세히' 탭에서 예시를 시작하면 탭이 '진행 기록'으로 바뀌는 사이에도 재생 미니 줄이 생겼다 사라지지 않는다 (붙은 탭 줄이 출렁이지 않게)", async () => {
    // 띠가 보이는지 아직 모르는 IntersectionObserver (알리지 않는다) — 미니 줄은 '띠가 가려짐'을 들은 뒤에만 붙는다
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        takeRecords() {
          return [];
        }
        disconnect() {}
      },
    );
    renderApp("/reports/2?tab=more");
    const start = await screen.findByRole("button", { name: /정상 흐름/ });
    // 탭 줄에 한 번이라도 미니 줄(예시 다음 사건 버튼)이 붙었는지 — 붙었다 바로 떼여도 기록에 남는다
    let added = 0;
    const mo = new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes) if (n instanceof Element && (n.matches('[aria-label="예시 다음 사건"]') || n.querySelector('[aria-label="예시 다음 사건"]'))) added++;
    });
    mo.observe(document.body, { childList: true, subtree: true });
    fireEvent.click(start);
    await waitFor(() => expect(screen.getByRole("tab", { name: "진행 기록" }).getAttribute("aria-selected")).toBe("true"));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    mo.disconnect();
    expect(added).toBe(0);
    expect(screen.queryByRole("button", { name: "예시 다음 사건" })).toBeNull();
  });

  it("모바일 전문가 상세는 붙은 탭 줄 높이를 문서의 --sticky-tabs-h로 알려 Tab 포커스 여백에 더하고(scroll-padding-top은 두지 않는다 — 붙은 줄로 Shift+Tab 할 때 페이지가 튄다), PC·화면을 떠나면 지운다", async () => {
    const resizes: (() => void)[] = [];
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(cb: () => void) {
          resizes.push(cb);
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    let pc = false;
    const changes = new Set<() => void>();
    vi.stubGlobal("matchMedia", (q: string) => ({
      get matches() {
        return q.includes("min-width: 64rem") ? pc : false;
      },
      media: q,
      addEventListener: (_: string, fn: () => void) => changes.add(fn),
      removeEventListener: (_: string, fn: () => void) => changes.delete(fn),
    }));
    const root = document.documentElement;
    const tabsH = () => root.style.getPropertyValue("--sticky-tabs-h");
    const view = renderApp("/reports/2?tab=run");
    const row = (await screen.findByRole("tablist", { name: "리포트 화면" })).parentElement!;
    // jsdom에는 레이아웃이 없어 탭 줄 높이를 정해 준다 (미니 줄이 붙으면 늘어난다)
    row.getBoundingClientRect = () => ({ height: 60 }) as DOMRect;
    act(() => resizes.forEach((cb) => cb()));
    expect(tabsH()).toBe("60px");
    row.getBoundingClientRect = () => ({ height: 107.5 }) as DOMRect;
    act(() => resizes.forEach((cb) => cb()));
    expect(tabsH()).toBe("108px");
    expect(root.style.scrollPaddingTop).toBe("");
    // PC는 탭 줄이 붙지 않으므로 지운다
    pc = true;
    act(() => changes.forEach((fn) => fn()));
    expect(tabsH()).toBe("");
    pc = false;
    act(() => changes.forEach((fn) => fn()));
    expect(tabsH()).toBe("108px");
    view.unmount();
    expect(tabsH()).toBe("");
    expect(root.style.scrollPaddingTop).toBe("");
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
    // PC 표의 리포트 링크: 파란 글자는 brand-ink (brand는 흰 바탕 3.7:1)
    const reportLinks = within(screen.getByRole("table")).getAllByRole("link", { name: /^리포트 #\d+$/ });
    expect(reportLinks).toHaveLength(4);
    for (const a of reportLinks) expect(a.className.split(" ")).toContain("text-brand-ink");
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

  it("교육용 문서는 리포트 목록이 아니라 관리자 화면에서 연다", async () => {
    const { unmount } = renderApp("/reports");
    await screen.findByRole("list", { name: "리포트 목록" });
    expect(screen.queryByRole("button", { name: /개념 문서/ })).toBeNull();
    unmount();
    renderApp("/ops");
    fireEvent.click(await screen.findByRole("button", { name: /개념 문서/ }));
    expect(await screen.findByRole("heading", { name: "04 Distributed Collaboration" }, { timeout: 5000 })).toBeTruthy();
  });

  it("개념 문서 끝의 '접기 · 맨 위로': 포커스는 바로 머리로, 스크롤은 문서가 빠진 뒤(다시 그린 뒤)에 머리로", async () => {
    const saved = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
    const seen: { el: Element; docShown: boolean }[] = [];
    // jsdom에는 scrollIntoView가 없다: 부를 때 문서가 아직 화면에 있는지 적는다
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: function (this: Element) {
        seen.push({ el: this, docShown: screen.queryByRole("heading", { name: "04 Distributed Collaboration" }) !== null });
      },
    });
    try {
      renderApp("/ops");
      const head = await screen.findByRole("button", { name: /개념 문서/ });
      fireEvent.click(head);
      await screen.findByRole("heading", { name: "04 Distributed Collaboration" }, { timeout: 5000 });
      fireEvent.click(screen.getByRole("button", { name: "접기 · 맨 위로" }));
      expect(head.getAttribute("aria-expanded")).toBe("false");
      expect(document.activeElement).toBe(head); // 누른 버튼이 사라져도 포커스가 body로 떨어지지 않는다
      await waitFor(() => expect(seen.some((s) => s.el === head)).toBe(true));
      expect(seen.filter((s) => s.el === head)).toEqual([{ el: head, docShown: false }]);
    } finally {
      if (saved) Object.defineProperty(Element.prototype, "scrollIntoView", saved);
      else delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it("없는 리포트는 안내하고 목록으로 가는 길을 준다 (숫자가 아닌 주소도 기다리지 않는다)", async () => {
    renderApp("/reports/999");
    expect(await screen.findByText("리포트를 찾을 수 없습니다.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "리포트 목록으로" }).getAttribute("href")).toBe("/reports");
    expect(screen.queryByRole("button", { name: "다시 시도" })).toBeNull(); // 다시 받아도 소용없다
    renderApp("/reports/abc", "bob");
    expect(await screen.findByText("리포트를 찾을 수 없어요")).toBeTruthy();
  });

  it("탭: 방향키로 옮기면 바로 고르고, aria-controls는 그린 패널(선택된 탭)에만. 보기 전환은 머리 카드 안", async () => {
    renderApp("/reports/2");
    const run = await screen.findByRole("tab", { name: "진행 기록" });
    expect(run.getAttribute("aria-selected")).toBe("true");
    expect(run.getAttribute("aria-controls")).toBe("panel-run");
    expect(screen.getByRole("tab", { name: "리포트" }).getAttribute("aria-controls")).toBeNull();
    // 선택된 탭만 Tab 키로 들어온다 (roving tabindex)
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"]);
    fireEvent.keyDown(run, { key: "ArrowRight" });
    const more = screen.getByRole("tab", { name: "자세히" });
    expect(more.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(more);
    expect(screen.getByRole("tabpanel", { name: "자세히" })).toBeTruthy();
    // 머리: 이름·상태 한 줄, 보기 전환은 쉬운 보기와 같은 자리 (화면 머리에는 제목·종만)
    const head = screen.getByRole("region", { name: "리포트 머리" });
    expect(within(head).getByRole("button", { name: "이 화면만 쉽게 보기" })).toBeTruthy();
    expect(within(head).getByText("신청됨")).toBeTruthy();
    expect(within(document.querySelector("header") as HTMLElement).queryByRole("button", { name: /보기/ })).toBeNull();
  });

  it("실패한 리포트(전문가): 쉬운 사유 문장 + 사유 코드 + 사유에 맞는 둘째 문장, 요약 띠에 '장애 없음'을 붙이지 않는다", async () => {
    db.addSampleReports();
    const failed = db.listReports("086520")[0];
    renderApp(`/reports/${failed.id}`);
    expect(await screen.findByRole("heading", { name: "리포트를 만들지 못했습니다" })).toBeTruthy();
    expect(screen.getByText("(review_failed)")).toBeTruthy();
    expect(screen.getByText(EXPERT_FAILURE_NOTE.review_failed)).toBeTruthy();
    const summary = region("실행 요약");
    expect(within(summary).getByText("실행 실패")).toBeTruthy();
    expect(within(summary).queryByText(/장애 없음/)).toBeNull();
  });

  it("완성 리포트(전문가): 본문 제목은 카드 제목 아래 단계(h3), PDF 보기 버튼, 완성된 리포트에는 미구현 안내가 없다", async () => {
    db.addSampleReports();
    const buy = db.listReports("035420")[0];
    renderApp(`/reports/${buy.id}?tab=report`);
    expect(await screen.findByRole("heading", { name: "NAVER 종목 리포트", level: 3 }, { timeout: 5000 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "리포트 본문", level: 2 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "PDF로 보기" })).toBeTruthy();
    expect(screen.queryByText(/Agent 실행은 아직 구현되지 않았습니다/)).toBeNull();
  });

  it("긍정적 완성 리포트(전문가)는 추천을 받는 동안 그 자리를 잡아 둔다 (받은 뒤 본문이 밀리거나 PC에서 한 열 → 두 열로 바뀌지 않게)", async () => {
    db.addSampleReports();
    const buy = db.listReports("035420")[0];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    server.use(
      http.get("*/api/recommendations", async ({ request }) => {
        if (new URL(request.url).searchParams.get("sourceId") === String(buy.id)) await gate;
        return undefined; // 기본 처리기로
      }),
    );
    renderApp(`/reports/${buy.id}?tab=report`);
    const panel = await screen.findByRole("tabpanel", { name: "리포트" });
    expect(within(panel).getByRole("group", { name: "이 리포트의 AI 추천 불러오는 중" })).toBeTruthy();
    release();
    expect(await within(panel).findByRole("heading", { name: /이 리포트의 AI 추천/ })).toBeTruthy();
    expect(within(panel).queryByRole("group", { name: "이 리포트의 AI 추천 불러오는 중" })).toBeNull();
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
