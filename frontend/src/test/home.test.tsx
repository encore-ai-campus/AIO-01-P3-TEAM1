// 홈: 주린이모드 켬(쉬운 보기)과 끔(전문가 보기), 이 화면만 보기 바꾸기(?view=), 3단계 안내, 최근·만드는 중 리포트,
// 진행 중 모의 자동매매, 최근 알림, 자산 요약·랭킹 카드(장마감 기준).
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { delay, http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../App";
import { keys } from "../api/queries";
import type { ReportSummary, TradePlan } from "../api/types";
import { AnalysisCard } from "../components/analysis/AnalysisCard";
import { guideFromHint, guideHintOf, guideStateOf, inProgressReports, pickRecentReports } from "../components/home/homeData";
import { CHANGED_MS, FINISHED_MS, useChangedKeys, useJustFinished } from "../components/home/homeHooks";
import { ReportsInProgress } from "../components/home/ReportsInProgress";
import { formatAsOf, formatRelative } from "../lib/format";
import { notificationHref } from "../lib/nav";
import { REPORT_KEEPS_RUNNING } from "../lib/plainText";
import { createQueryClient } from "../lib/queryClient";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

// 오늘의 내 종목 뉴스 카드 자체는 longterm.test.tsx가 본다 — 홈이 어떤 보기·개수·모양으로 부르는지만 본다
vi.mock("../components/longterm/DailyMoveCard", () => ({
  DailyMoveCard: (p: { view: string; limit?: number; density?: string; emptyMode?: string; focusKey?: string | null }) => (
    <div
      data-testid="daily-move"
      data-view={p.view}
      data-limit={String(p.limit ?? "")}
      data-density={p.density ?? "full"}
      data-empty={p.emptyMode ?? "full"}
      data-focus={p.focusKey ?? ""}
    />
  ),
}));

/** docs/API.md "금지 표현"의 PERSUASION (원본: engine/paper_engine/wording.py). 공백을 지우고 비교한다. */
const PERSUASION = [
  "사세요", "사 볼 만해요", "사 볼 만", "매수하세요", "매수 기회", "지금 사면", "담으세요", "좋아요",
  "파세요", "팔아야", "매도하세요", "매도 기회", "지금 팔면", "정리하세요", "비중을 줄이세요", "비중을 늘리세요", "손절하세요",
];
const squash = (s: string) => s.replace(/\s+/g, "");
const persuasionIn = (text: string) => PERSUASION.filter((p) => squash(text).includes(squash(p)));

const alice = () => {
  db.setSession("alice");
  return db.sessionUser()!;
};
const dailyMove = () => {
  const el = screen.getByTestId("daily-move");
  return {
    view: el.getAttribute("data-view"),
    limit: el.getAttribute("data-limit"),
    density: el.getAttribute("data-density"),
    empty: el.getAttribute("data-empty"),
  };
};

// 팀원마다 모의 계좌가 따로다 (docs/DECISIONS.md 8-1) — '팀이 함께 쓰는 계좌'로 읽히지 않게, 무엇을 되돌릴 수 없는지 밝힌다
const GUIDE_LINE = "내 모의 계좌 1,000만 원으로 연습해요 · 진짜 돈이 아니고, 계좌를 처음으로 되돌릴 수는 없어요";

// 3단계 안내 "닫았음"은 브라우저 저장소에 남는다. 테스트마다 빈 메모리 저장소로 바꾼다 (Node의 localStorage는 쓸 수 없을 수 있다)
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}
beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));
afterEach(() => vi.unstubAllGlobals());

describe("홈 · 쉬운 보기 (주린이모드 켬)", () => {
  it("3단계 안내 · 만드는 중인 리포트 · 진행 중 모의 자동매매 · 자산 요약 · 알림 · 랭킹, 교차검증 대시보드는 없다", async () => {
    renderApp("/", "bob"); // 밥: 진단 전(주린이모드 켬), 만드는 중인 리포트 1개(SK하이닉스)
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    expect(within(guide).getByText(GUIDE_LINE)).toBeTruthy();
    const steps = within(guide).getByRole("list", { name: "연습 순서" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      expect.stringContaining("1단계: 리포트 만들기"),
      expect.stringContaining("2단계: 검토"),
      expect.stringContaining("3단계: 모의 자동매매"),
    ]);
    // 지금 단계를 따라간다: 밥은 리포트를 만드는 중 → ① 단계가 지금, 버튼은 그 리포트의 진행 화면으로
    const cta = await within(guide).findByRole("link", { name: "만드는 중인 리포트 보기" });
    expect(cta.getAttribute("href")).toBe("/reports/1");
    expect(within(steps).getAllByRole("listitem").map((li) => li.getAttribute("aria-current"))).toEqual(["step", null, null]);
    expect(within(guide).queryByRole("link", { name: "삼성전자" })).toBeNull(); // 예시 종목은 아직 만들지 않은 사람에게만

    const running = await screen.findByRole("region", { name: "만드는 중인 리포트 1개" });
    const link = within(running).getByRole("link", { name: "SK하이닉스 리포트 진행 보기" });
    expect(link.getAttribute("href")).toBe("/reports/1");
    expect(within(link).getByText(/대기 중/)).toBeTruthy(); // 쉬운 상태 이름
    expect(within(running).getByText(REPORT_KEEPS_RUNNING)).toBeTruthy();

    expect(await screen.findByText("진행 중인 모의 자동매매가 없어요. 리포트를 검토한 뒤 시작할 수 있어요.")).toBeTruthy();
    expect(await screen.findByText(/아직 알림이 없어요/)).toBeTruthy();
    expect(await screen.findByText("아직 완성된 리포트가 없어요. 종목 상세에서 AI 리포트를 만들 수 있어요.")).toBeTruthy();

    const asset = await screen.findByRole("region", { name: "내 자산" });
    await within(asset).findByText("모의 계좌 총자산");
    expect(within(asset).getByText("처음 자금")).toBeTruthy();
    expect(within(asset).queryByText("매수 가능액")).toBeNull();

    const ranking = await screen.findByRole("region", { name: "랭킹" });
    const me = db.ranking(2).me;
    expect(await within(ranking).findByText(`${me.rank}위`)).toBeTruthy();
    expect(within(ranking).getByRole("link", { name: /랭킹/ }).getAttribute("href")).toBe("/ranking");

    // 쉬운 요약은 그대로(full), 보유가 없으면 카드를 그리지 않는다(compact — 카드 안에서 판단)
    expect(dailyMove()).toEqual({ view: "easy", limit: "3", density: "full", empty: "compact" });
    expect(screen.queryByRole("region", { name: "AI 교차검증 분석" })).toBeNull();
    expect(screen.queryByRole("list", { name: "AI 추천 요약" })).toBeNull();
    expect(persuasionIn(document.body.textContent ?? "")).toEqual([]);
  });

  it("최근 AI 리포트: 팀이 완성한 리포트(실패 제외)에 AI 의견 배지 + 한 줄 요약", async () => {
    db.addSampleReports(); // 완성 긍정적(NAVER) · 완성 지켜보기(LG에너지솔루션) · 실패(에코프로비엠)
    renderApp("/", "carol");
    const list = await screen.findByRole("list", { name: "최근 AI 리포트 목록" });
    const items = within(list).getAllByRole("link");
    expect(items.map((a) => a.getAttribute("aria-label"))).toEqual(["NAVER AI 리포트 보기", "LG에너지솔루션 AI 리포트 보기"]);
    expect(within(items[0]).getByText("AI 의견: 긍정적")).toBeTruthy();
    expect(within(items[0]).getByText("NAVER: 실적 개선과 수급이 이어져 오를 근거가 더 많다고 봤다.")).toBeTruthy();
    expect(within(items[0]).getByText(/데이브 님이 만듦/)).toBeTruthy();
    expect(within(items[1]).getByText("AI 의견: 지켜보기")).toBeTruthy();
    expect(items[0].getAttribute("href")).toMatch(/^\/reports\/\d+$/);
    expect(persuasionIn(document.body.textContent ?? "")).toEqual([]);

    // 배지 색은 리포트 목록과 같다 (긍정적이 홈에서는 빨강, 리포트에서는 파랑처럼 갈리지 않게 — 시장 오름·내림 색도 쓰지 않는다)
    const tone = (el: HTMLElement) => el.className.split(/\s+/).filter((c) => /^(bg|text)-(?!\[)/.test(c)).sort();
    const homeTone = tone(within(items[0]).getByText("AI 의견: 긍정적"));
    expect(homeTone.some((c) => /^(bg|text)-(up|down)/.test(c))).toBe(false);
    cleanup();
    renderApp("/reports", "carol");
    const reports = await screen.findByRole("list", { name: "리포트 목록" });
    expect(tone(await within(reports).findByText("긍정적"))).toEqual(homeTone);
  });

  it("내 리포트가 없으면 3단계 안내를 닫을 수 없고, 닫아 둔 기록이 있어도 보인다", async () => {
    localStorage.setItem("home-guide-closed:3", "1");
    renderApp("/", "carol"); // 캐롤: 내 리포트 0개
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    expect(within(guide).queryByRole("button", { name: "안내 닫기" })).toBeNull();
    expect(screen.queryByRole("region", { name: /만드는 중인 리포트/ })).toBeNull();
  });

  it("내 리포트가 있으면 처음 방문에만 보이고, 닫으면 다시 보이지 않는다", async () => {
    renderApp("/", "bob");
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    // 안내는 리포트 목록을 기다리지 않고 바로 그린다 — 닫기 버튼은 내 리포트가 있다고 확인된 뒤에 생긴다
    fireEvent.click(await within(guide).findByRole("button", { name: "안내 닫기" }));
    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
    expect(localStorage.getItem("home-guide-closed:2")).toBe("1");

    renderApp("/", "bob");
    await screen.findAllByRole("region", { name: "만드는 중인 리포트 1개" });
    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
  });

  it("진행 중인 모의 자동매매는 쉬운 상태 이름과 출처", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    db.activate(alice(), 91, { budgetPercent: 10 });
    renderApp("/");
    const live = await screen.findByRole("list", { name: "진행 중인 모의 자동매매 목록" });
    const row = within(live).getByRole("link", { name: "SK하이닉스 모의 자동매매 보기" });
    expect(row.getAttribute("href")).toMatch(/^\/plans\/\d+$/);
    expect(within(row).getByText(/사는 가격을 기다리는 중|시작했어요|목표·손절을 지켜보는 중/)).toBeTruthy();
    expect(within(row).getByText(/AI 리포트/)).toBeTruthy(); // 출처
    expect(within(row).queryByText(/체결 대기|활성화됨/)).toBeNull(); // 원래 용어는 전문가 보기에만
  });

  it("최근 알림 3개는 종류 이름과 함께, 누르면 읽음 처리하고 그 링크로 간다 (알림 화면과 같은 링크 줄)", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    renderApp("/");
    const notes = await screen.findByRole("list", { name: "최근 알림 목록" });
    const rows = within(notes).getAllByRole("link");
    expect(rows).toHaveLength(3);
    const latest = db.listNotifications(1, false).rows.slice(0, 3);
    expect(rows.map((a) => latest.findIndex((n) => a.textContent?.includes(n.title)))).toEqual([0, 1, 2]);
    const badges = within(notes).getAllByText("안 읽음"); // 알림 화면과 같은 표시 (연한 빨강 바탕 + 진한 글자 — 흰 글자 on 빨강은 대비가 모자랐다)
    expect(badges).toHaveLength(2);
    for (const b of badges) expect(b.className).toContain("text-up-ink");
    expect(within(rows[2]).getByText("모의 매도 완료")).toBeTruthy(); // NOTIFICATION_KIND_TEXT.closed

    // 이름은 '안 읽음: 제목', 종류·시각은 설명. 갈 곳은 서버 link
    const rec = within(notes).getByRole("link", { name: "안 읽음: SK하이닉스 AI 추천" });
    expect(rec.getAttribute("href")).toBe("/recommendations/91");
    const recNote = latest.find((n) => n.title === "SK하이닉스 AI 추천")!;
    expect(rec.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual([
      "새 계획 제안",
      formatRelative(recNote.createdAt),
    ]);
    fireEvent.click(rec);
    // 읽음은 화면에 먼저: 서버 응답을 기다리지 않고 종 배지가 같은 순간에 줄어든다 (알림 화면과 같은 훅)
    await waitFor(() => expect(screen.getAllByRole("link", { name: "알림 (안 읽은 알림 1개)" }).length).toBeGreaterThan(0));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "홈" })).toBeNull());
    await waitFor(() => expect(db.listNotifications(1, true).rows.some((n) => n.title === "SK하이닉스 AI 추천")).toBe(false));
  });

  it("자산 요약·랭킹 카드에 장마감 기준 시각 (보유한 시장마다)", async () => {
    freezeTime("2026-10-06T10:00:00+09:00"); // 화요일 장중 → KR 기준일 10월 5일, 뉴욕 기준일 10월 5일
    db.setInvestorProfile("alice", { beginnerMode: true });
    renderApp("/");
    const asset = await screen.findByRole("region", { name: "내 자산" });
    const acc = db.account(1);
    expect(acc.pricesAsOf.KR && formatAsOf(acc.pricesAsOf.KR, "KR")).toBe("10월 5일(월) 15:30 장마감 기준");
    expect(await within(asset).findByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
    expect(within(asset).getByText("10월 5일(월) 16:00(뉴욕) 장마감 기준")).toBeTruthy();
    const ranking = await screen.findByRole("region", { name: "랭킹" });
    expect(await within(ranking).findByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
  });

  it("랭킹 비공개면 안내 줄이 마이의 '내 정보 공개' 자리(/my#public)로 가는 링크 — 카드 전체 링크는 두지 않는다", async () => {
    renderApp("/", "carol"); // 캐롤: 비공개
    const ranking = await screen.findByRole("region", { name: "랭킹" });
    const toPublic = await within(ranking).findByRole("link", { name: /내 정보 공개.*켜면 랭킹에 나와요/ });
    expect(toPublic.getAttribute("href")).toBe("/my#public");
    // 랭킹 전체로 가는 입구는 머리에 그대로 (링크 안에 링크를 겹치지 않게 카드를 덮지 않는다)
    expect(within(ranking).getByRole("link", { name: /^랭킹/ }).getAttribute("href")).toBe("/ranking");
    expect(ranking.className).not.toContain("has-[a:active]");
  });

  it("보유가 없으면 장마감 기준 시각을 보이지 않는다 (평가할 종가가 없다)", async () => {
    renderApp("/", "bob");
    const asset = await screen.findByRole("region", { name: "내 자산" });
    await within(asset).findByText("모의 계좌 총자산");
    expect(within(asset).queryByText(/장마감 기준/)).toBeNull();
  });
});

describe("홈 · 전문가 보기 (주린이모드 끔)", () => {
  it("기존 홈(자산·시장·계획·새 계획 제안·교차검증 분석) + 오늘의 내 종목 뉴스(수치형) + 최근 리포트 + 랭킹, 3단계 안내 없음", async () => {
    db.addSampleReports();
    renderApp("/"); // 앨리스: 주린이모드 끔
    expect(await screen.findByRole("region", { name: "AI 교차검증 분석" })).toBeTruthy();
    expect(await screen.findByRole("list", { name: "정규장 상태" })).toBeTruthy();
    expect(await screen.findByRole("list", { name: "AI 추천 요약" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "새 계획 제안" })).toBeTruthy();

    const recent = await screen.findByRole("list", { name: "최근 AI 리포트 목록" });
    expect(within(recent).getByText("AI 의견 매수")).toBeTruthy(); // 원래 용어
    expect(within(recent).getByText("AI 의견 보유")).toBeTruthy();
    expect(await screen.findByRole("region", { name: "랭킹" })).toBeTruthy();
    // 홈의 전문가 보기는 종목마다 한 줄 요약 → 눌러 펼친다 (근거 목록이 홈을 덮지 않게)
    expect(dailyMove()).toEqual({ view: "expert", limit: "3", density: "summary", empty: "compact" });

    // 앨리스의 만드는 중인 리포트(삼성전자)는 전문가 보기에도 보인다 (상태는 원래 용어)
    const running = await screen.findByRole("region", { name: "만드는 중인 리포트 1개" });
    expect(within(running).getByText(/신청됨/)).toBeTruthy();

    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
    // 보기 바꾸기는 리포트 화면과 같은 규칙(공용 ViewToggle): 전문가도 이 화면만 쉬운 보기로 볼 수 있다 (맨 아래)
    expect(screen.getByRole("button", { name: "이 화면만 쉽게 보기" })).toBeTruthy();
    const asset = screen.getByRole("region", { name: "내 자산" });
    expect(within(asset).getByText("매수 가능액")).toBeTruthy();
  });

  it("?view=easy면 이 화면만 쉬운 보기, 버튼으로 되돌린다 (서버의 주린이모드는 그대로)", async () => {
    renderApp("/?view=easy");
    expect(await screen.findByRole("region", { name: "3단계로 연습해요" })).toBeTruthy();
    // 이 화면만 바꾼 상태라 버튼은 '원래 보기로 돌아가기'
    fireEvent.click(screen.getByRole("button", { name: "전문가 보기로 돌아가기" }));
    expect(await screen.findByRole("region", { name: "AI 교차검증 분석" })).toBeTruthy();
    expect(db.investorProfile(1).beginnerMode).toBe(false);
  });
});

describe("홈 · 이 화면만 자세히 보기", () => {
  it("주린이모드 켬에서 누르면 이 화면만 전문가 보기, 다시 누르면 쉬운 보기 (저장하지 않음)", async () => {
    renderApp("/", "bob");
    await screen.findByRole("region", { name: "3단계로 연습해요" });
    fireEvent.click(screen.getByRole("button", { name: "이 화면만 자세히 보기" }));
    expect(await screen.findByRole("region", { name: "AI 교차검증 분석" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "쉬운 보기로 돌아가기" }));
    expect(await screen.findByRole("region", { name: "3단계로 연습해요" })).toBeTruthy();
    expect(db.investorProfile(2).beginnerMode).toBe(true);
  });
});

describe("홈 카드가 고르는 리포트", () => {
  const r = (id: number, status: ReportSummary["status"], source: ReportSummary["source"] = "user") =>
    ({ id, status, source, symbol: "X", name: `R${id}` }) as ReportSummary;

  it("최근 리포트: 완성된 것만, 자동 리포트 먼저, 최대 3개", () => {
    const list = [r(1, "completed"), r(2, "failed"), r(3, "completed", "auto"), r(4, "running"), r(5, "completed"), r(6, "completed")];
    expect(pickRecentReports(list).map((x) => x.id)).toEqual([3, 1, 5]);
    expect(pickRecentReports([r(1, "failed")])).toEqual([]);
  });

  it("만드는 중: 대기 중·만드는 중만", () => {
    expect(inProgressReports([r(1, "requested"), r(2, "running"), r(3, "completed"), r(4, "failed")]).map((x) => x.id)).toEqual([1, 2]);
  });
});

describe("홈 · 3단계 안내는 지금 단계를 따라간다", () => {
  const r = (id: number, status: ReportSummary["status"]) => ({ id, status, source: "user", symbol: "X", name: `R${id}` }) as ReportSummary;
  const plan = { id: 7 } as TradePlan;

  it("지금 단계와 버튼: 아무것도 없으면 ① 종목 고르기, 만드는 중이면 그 리포트, 완성됐으면 ② 검토, 계획이 있으면 다 해 봤다", () => {
    expect(guideStateOf(undefined, undefined)).toEqual({ step: 1, cta: { label: "종목 고르기", to: "/search" }, making: false, examples: true });
    expect(guideStateOf([r(4, "failed")], [])).toMatchObject({ step: 1, cta: { to: "/search" }, examples: true }); // 실패만 있으면 다시 고르기
    expect(guideStateOf([r(3, "running")], [])).toMatchObject({ step: 1, cta: { label: "만드는 중인 리포트 보기", to: "/reports/3" }, making: true });
    // 완성된 내 리포트가 있으면 (만드는 중인 것이 더 있어도) 가장 최근에 완성된 것을 검토하러
    expect(guideStateOf([r(5, "requested"), r(2, "completed"), r(1, "completed")], [])).toMatchObject({
      step: 2,
      cta: { label: "내 리포트 검토하기", to: "/reports/2" },
    });
    expect(guideStateOf([r(2, "completed")], [plan])).toEqual({ step: "done", cta: null, making: false, examples: false });
    // 내 리포트가 없으면 계획이 있어도 ① (리포트 0개면 늘 보이는 안내 — 닫을 수 없는 '다 해 봤어요'가 되지 않게)
    expect(guideStateOf([], [plan])).toMatchObject({ step: 1, cta: { to: "/search" } });
  });

  it("리포트를 아직 만들지 않았으면 ① 지금 + 종목 고르기 + 예시 종목 (닫을 수 없다)", async () => {
    const { client } = renderApp("/", "carol");
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    await waitFor(() => expect(client.getQueryState(keys.reports({ mine: true }))?.status).toBe("success"));
    expect(within(guide).getByRole("link", { name: "종목 고르기" }).getAttribute("href")).toBe("/search");
    // 무엇을 고를지 몰라 빈 검색 화면에서 막히지 않게 — '추천'이 아니라 '예시'
    const examples = ["삼성전자", "SK하이닉스", "NAVER"].map((n) => within(guide).getByRole("link", { name: n }).getAttribute("href"));
    expect(examples).toEqual(["/stocks/005930", "/stocks/000660", "/stocks/035420"]);
    expect(within(guide).getByText("예시로 눌러 보기")).toBeTruthy();
    const items = within(within(guide).getByRole("list", { name: "연습 순서" })).getAllByRole("listitem");
    expect(items.map((li) => li.getAttribute("aria-current"))).toEqual(["step", null, null]);
    expect(within(guide).queryByRole("button", { name: "안내 닫기" })).toBeNull();
    expect(persuasionIn(document.body.textContent ?? "")).toEqual([]);
  });

  it("계획을 하나라도 만들었으면 '3단계를 모두 해 봤어요' 한 줄과 닫기 버튼만", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    db.activate(alice(), 91, { budgetPercent: 10 });
    renderApp("/");
    const done = await screen.findByRole("region", { name: "3단계를 모두 해 봤어요" });
    expect(within(done).getByText("리포트 만들기 → 검토 → 모의 자동매매")).toBeTruthy();
    expect(within(done).queryByRole("link")).toBeNull();
    // 다음 방문의 첫 그림을 위해 진행을 기억한다 (아래 '받기 전에는 …' 테스트)
    await waitFor(() => expect(localStorage.getItem("home-guide-progress:1")).toBe("done"));
    fireEvent.click(await within(done).findByRole("button", { name: "안내 닫기" }));
    expect(screen.queryByRole("region", { name: "3단계를 모두 해 봤어요" })).toBeNull();
    expect(localStorage.getItem("home-guide-closed:1")).toBe("1");
  });

  it("닫으면 포커스가 다음 섹션 제목으로 가고, 맨 아래 '3단계 안내 다시 보기'로 되살린다", async () => {
    renderApp("/", "bob");
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    expect(screen.queryByRole("button", { name: "3단계 안내 다시 보기" })).toBeNull(); // 보이는 동안은 없다
    fireEvent.click(await within(guide).findByRole("button", { name: "안내 닫기" }));
    // 닫히는 카드 안의 포커스가 body로 사라지지 않게
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "만드는 중인 리포트 1개" }));

    fireEvent.click(screen.getByRole("button", { name: "3단계 안내 다시 보기" }));
    const back = await screen.findByRole("region", { name: "3단계로 연습해요" });
    expect(localStorage.getItem("home-guide-closed:2")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(within(back).getByRole("heading", { name: "3단계로 연습해요" })));
    expect(screen.queryByRole("button", { name: "3단계 안내 다시 보기" })).toBeNull();
  });

  it("진단 전이면 단계 목록 위에 '먼저 1분 진단' 한 줄(/my#diagnosis — 마이가 진단 폼을 펼친다), 진단했으면 없다", async () => {
    renderApp("/", "bob"); // 밥: 진단 전
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    const go = within(guide).getByRole("link", { name: "진단하기" });
    expect(go.getAttribute("href")).toBe("/my#diagnosis");
    expect(document.getElementById(go.getAttribute("aria-describedby") ?? "")?.textContent).toBe("먼저 1분 진단으로 나에게 맞는 보기를 추천받을 수 있어요");
    // 단계 목록 밖이다 (단계는 셋 그대로)
    expect(within(within(guide).getByRole("list", { name: "연습 순서" })).queryByRole("link", { name: "진단하기" })).toBeNull();
    await waitFor(() => expect(localStorage.getItem("home-diagnosed:2")).toBeNull()); // 진단 전은 기억할 것이 없다
    cleanup();

    // 진단한 팀원(앨리스, 쉬운 보기): 프로필을 받으면 접히고, 다음부터는 처음부터 없다 (이 브라우저의 기억)
    db.setInvestorProfile("alice", { beginnerMode: true });
    renderApp("/");
    const aliceGuide = await screen.findByRole("region", { name: /3단계/ });
    await waitFor(() => expect(within(aliceGuide).queryByRole("link", { name: "진단하기" })).toBeNull());
    await waitFor(() => expect(localStorage.getItem("home-diagnosed:1")).toBe("1"));
    cleanup();
    server.use(http.get("*/api/me/investor-profile", async () => void (await delay(150)))); // 프로필이 늦게 와도
    renderApp("/");
    const again = await screen.findByRole("region", { name: /3단계/ });
    expect(within(again).queryByRole("link", { name: "진단하기" })).toBeNull();
  });

  // 안내는 데이터를 기다리지 않고 바로 그린다. 그때 처음 쓰는 사람 화면(① 종목 고르기·예시)을 먼저 그리면, 다 해 본 사람은 큰 카드가
  // 한 줄로 줄며 아래 내용이 수백 px 올라오고, 리포트가 있는 사람에게는 틀린 버튼·예시가 잠깐 보인다 — 지난번에 본 진행으로 먼저 그린다
  it("받기 전에는 지난번에 본 진행으로 그린다: 다 해 본 사람은 처음부터 한 줄", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    db.activate(alice(), 91, { budgetPercent: 10 });
    localStorage.setItem("home-guide-progress:1", "done");
    server.use(http.get("*/api/trade-plans", async () => void (await delay(150)))); // 계획이 늦게 온다 (그 뒤 원래 응답)
    const { client } = renderApp("/");
    expect(await screen.findByRole("region", { name: "3단계를 모두 해 봤어요" })).toBeTruthy();
    expect(client.getQueryState(keys.plans("all"))?.status).toBe("pending"); // 계획을 받기 전부터 한 줄
    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
    await waitFor(() => expect(client.getQueryState(keys.plans("all"))?.status).toBe("success"));
    expect(screen.getByRole("region", { name: "3단계를 모두 해 봤어요" })).toBeTruthy(); // 받은 뒤에도 그대로
  });

  it("받기 전에는 지난번에 본 진행으로 그린다: 리포트가 있는 사람에게 틀린 버튼·예시를 보이지 않는다", async () => {
    localStorage.setItem("home-guide-progress:2", "reports");
    server.use(http.get("*/api/reports", async () => void (await delay(150)))); // 내 리포트가 늦게 온다
    const { client } = renderApp("/", "bob");
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    expect(client.getQueryState(keys.reports({ mine: true }))?.status).toBe("pending");
    // 할 일은 아직 모른다: 같은 높이의 자리만 (종목 고르기·예시 종목을 잠깐이라도 누르게 하지 않는다), 지금 단계 표시도 없다
    // (밥은 진단 전이라 단계 목록 위의 '진단하기' 한 줄만 있다 — 할 일 버튼과 별개)
    expect(within(guide).queryAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/my#diagnosis"]);
    expect(within(guide).getByRole("group", { name: "불러오는 중" })).toBeTruthy();
    const steps = within(guide).getByRole("list", { name: "연습 순서" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.getAttribute("aria-current"))).toEqual([null, null, null]);
    // 받은 뒤: 지금 할 일로 (밥은 만드는 중)
    expect(await within(guide).findByRole("link", { name: "만드는 중인 리포트 보기" })).toBeTruthy();
    expect(within(steps).getAllByRole("listitem").map((li) => li.getAttribute("aria-current"))).toEqual(["step", null, null]);
    expect(within(guide).queryByRole("link", { name: "삼성전자" })).toBeNull();
    expect(localStorage.getItem("home-guide-progress:2")).toBe("reports");
  });

  // 기억은 받은 뒤 화면과 같은 첫 그림을 그리려고 둔다 — 예시 칩이 있고 없음이 다르면 받는 순간 예시가 펼쳐지며 아래 섹션을 민다
  it("기억으로 그린 첫 그림은 받은 뒤 화면과 예시·한 줄 여부가 같다 (실패한 리포트만 있으면 처음 쓰는 사람과 같은 그림)", () => {
    const cases: [ReportSummary[], TradePlan[]][] = [
      [[], []],
      [[r(4, "failed")], []],
      [[r(4, "failed"), r(6, "failed")], []],
      [[r(3, "running")], []],
      [[r(3, "running"), r(4, "failed")], []],
      [[r(2, "completed")], []],
      [[r(2, "completed")], [plan]],
      [[r(4, "failed")], [plan]],
      [[], [plan]],
    ];
    for (const [mine, plans] of cases) {
      const real = guideStateOf(mine, plans);
      const first = guideFromHint(guideHintOf(real), false); // null = 할 일 자리만 (예시 없음)
      expect([mine.map((x) => x.status), first?.examples ?? false, first?.step === "done"]).toEqual([
        mine.map((x) => x.status),
        real.examples,
        real.step === "done",
      ]);
    }
  });

  it("내 리포트가 실패뿐이면 '리포트 있음'으로 기억하지 않는다 (다음 방문에 예시가 늦게 펼쳐지지 않게)", async () => {
    server.use(
      http.get("*/api/reports", ({ request }) => {
        const mine = new URL(request.url).searchParams.get("mine") === "1";
        const list = db.listReports(null, { mineUserId: mine ? 2 : null }).map((x) => (mine ? { ...x, status: "failed" as const } : x));
        return HttpResponse.json({ count: list.length, results: list });
      }),
    );
    const { client } = renderApp("/", "bob");
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    expect(await within(guide).findByRole("link", { name: "종목 고르기" })).toBeTruthy();
    expect(within(guide).getByRole("link", { name: "삼성전자" })).toBeTruthy();
    await waitFor(() => expect(client.getQueryState(keys.plans("all"))?.status).toBe("success"));
    expect(localStorage.getItem("home-guide-progress:2")).toBeNull();
  });

  it("지금 할 일이 바뀌어도(리포트 완성) 버튼에 둔 키보드 포커스를 잃지 않고, 한 줄로 줄면 그 제목으로 옮긴다", async () => {
    const { client } = renderApp("/", "bob"); // 밥: 만드는 중인 리포트 1개
    const guide = await screen.findByRole("region", { name: "3단계로 연습해요" });
    const cta = await within(guide).findByRole("link", { name: "만드는 중인 리포트 보기" });
    act(() => cta.focus());
    expect(document.activeElement).toBe(cta);
    // 만들던 리포트가 완성됐다 (폴링으로 받은 목록이 바뀜)
    server.use(
      http.get("*/api/reports", ({ request }) => {
        const mine = new URL(request.url).searchParams.get("mine") === "1";
        const list = db.listReports(null, { mineUserId: mine ? 2 : null }).map((x) => (x.id === 1 ? { ...x, status: "completed" as const } : x));
        return HttpResponse.json({ count: list.length, results: list });
      }),
    );
    await act(() => client.refetchQueries({ queryKey: ["reports"] }));
    const review = await within(guide).findByRole("link", { name: "내 리포트 검토하기" });
    expect(review.getAttribute("href")).toBe("/reports/1");
    expect(document.activeElement).toBe(review);
    // 계획을 만들었다 → '3단계를 모두 해 봤어요' 한 줄 (버튼이 없다) — 포커스는 그 제목으로
    db.activate(db.sessionUser()!, 91, { budgetPercent: 10 });
    await act(() => client.refetchQueries({ queryKey: keys.plans("all") }));
    const done = await screen.findByRole("region", { name: "3단계를 모두 해 봤어요" });
    expect(document.activeElement).toBe(within(done).getByRole("heading", { name: "3단계를 모두 해 봤어요" }));
  });
});

describe("홈 · 불러오기 오류는 빈 상태와 다르게", () => {
  const fail = () => HttpResponse.json({ detail: "서버 오류" }, { status: 500 });

  it("처음부터 받지 못한 섹션은 '없어요' 대신 한 줄 오류 + 다시 시도 (섹션마다 경고 역할은 두지 않는다)", async () => {
    server.use(http.get("*/api/trade-plans", fail));
    renderApp("/", "bob");
    const live = await screen.findByRole("region", { name: "진행 중인 모의 자동매매" });
    expect(await within(live).findByText("불러오지 못했어요")).toBeTruthy();
    expect(within(live).queryByText(/진행 중인 모의 자동매매가 없어요/)).toBeNull(); // 계획이 사라진 줄 알면 안 된다
    expect(within(live).queryByRole("alert")).toBeNull();
    server.resetHandlers();
    fireEvent.click(within(live).getByRole("button", { name: "다시 시도" }));
    expect(await within(live).findByText("진행 중인 모의 자동매매가 없어요. 리포트를 검토한 뒤 시작할 수 있어요.")).toBeTruthy();
  });

  it("여러 섹션이 함께 실패하면 맨 위에 한 번만 알리고, '모두 다시 시도'로 한 번에 다시 받는다", async () => {
    server.use(http.get("*/api/trade-plans", fail), http.get("*/api/notifications", fail));
    renderApp("/", "bob");
    expect(await screen.findByText("일부 정보를 불러오지 못했어요")).toBeTruthy();
    server.resetHandlers();
    fireEvent.click(screen.getByRole("button", { name: "모두 다시 시도" }));
    await waitFor(() => expect(screen.queryByText("일부 정보를 불러오지 못했어요")).toBeNull());
    expect(await screen.findByText(/아직 알림이 없어요/)).toBeTruthy();
  });

  it("한 섹션만 실패해도 화면 읽기에는 맨 위에서 한 번 알린다 (보이는 띠·'모두 다시 시도'는 여럿일 때만)", async () => {
    server.use(http.get("*/api/account", fail));
    renderApp("/", "bob");
    const asset = await screen.findByRole("region", { name: "내 자산" });
    expect(await within(asset).findByText("불러오지 못했어요")).toBeTruthy();
    const note = await screen.findByText("일부 정보를 불러오지 못했어요");
    expect(note.closest("[aria-live='polite']")).toBeTruthy();
    expect(note.closest(".sr-only")).toBeTruthy(); // 보이는 띠는 아니다
    expect(screen.queryByRole("button", { name: "모두 다시 시도" })).toBeNull();
  });

  it("거의 함께 실패해도 같은 문장을 다시 만들지 않는다 — 둘째 실패에서는 띠가 보이고 '모두 다시 시도'만 더해진다", async () => {
    let failSecond!: () => void;
    const second = new Promise<void>((resolve) => (failSecond = resolve));
    server.use(
      http.get("*/api/account", fail),
      http.get("*/api/notifications", async () => {
        await second;
        return fail();
      }),
    );
    renderApp("/", "bob");
    const note = await screen.findByText("일부 정보를 불러오지 못했어요");
    expect(note.closest(".sr-only")).toBeTruthy();
    failSecond();
    expect(await screen.findByRole("button", { name: "모두 다시 시도" })).toBeTruthy();
    expect(screen.getByText("일부 정보를 불러오지 못했어요")).toBe(note); // 같은 문장 노드 (화면 읽기가 두 번 읽지 않게)
    expect(note.closest(".sr-only")).toBeNull();
  });

  it("랭킹을 받지 못해도 카드와 /ranking 입구는 남는다 (말없이 사라지지 않게)", async () => {
    server.use(http.get("*/api/ranking", fail));
    renderApp("/", "bob");
    const ranking = await screen.findByRole("region", { name: "랭킹" });
    expect(await within(ranking).findByText("불러오지 못했어요")).toBeTruthy();
    expect(within(ranking).getByRole("link", { name: /랭킹/ }).getAttribute("href")).toBe("/ranking");
  });
});

describe("홈 · 전문가 보기 섹션 자리", () => {
  it("진행 중 자동매매는 비어도 같은 자리에 한 줄 (늦게 와서 아래 '새 계획 제안'을 밀지 않게), 새 계획 제안은 개수 + 전체 보기", async () => {
    expect(db.listPlans(1, "active")).toEqual([]);
    renderApp("/");
    const plans = await screen.findByRole("region", { name: "진행 중 자동매매" });
    expect(await within(plans).findByText("진행 중인 자동매매가 없습니다. 새 계획 제안에서 시작할 수 있습니다.")).toBeTruthy();
    expect(within(plans).getByRole("link", { name: "진행 중 자동매매 전체 보기" }).getAttribute("href")).toBe("/plans");
    const recs = screen.getByRole("region", { name: "새 계획 제안" });
    const all = await within(recs).findByRole("link", { name: /^새 계획 제안 전체 보기, \d+개$/ });
    expect(all.getAttribute("href")).toBe("/recommendations");
    // 머리 순서: 진행 중인 일 → 할 수 있는 일 → 참고 → 사회적 요소 (모바일은 이 순서 그대로 위에서 아래)
    const order = ["진행 중 자동매매", "새 계획 제안", "최근 AI 리포트", "AI 교차검증 분석", "랭킹"].map((n) => screen.getByRole("heading", { name: n }));
    for (let i = 1; i < order.length; i++) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.getByRole("list", { name: "정규장 상태" }).textContent).toMatch(/국내 (열림|닫힘)/);
  });
});

// 받기 전 자리(스켈레톤)는 실제 행과 같은 높이로, 지난번에 본 행 수만큼 잡는다 — 진행 중 계획이 셋인 사람에게 한 줄 자리만 잡으면
// 받는 순간 아래 '최근 AI 리포트'가 200px 넘게 내려간다 (높이는 jsdom에서 잴 수 없어 화면에서 확인한다)
describe("홈 · 받기 전 자리는 지난번에 본 만큼", () => {
  const activateOpen = (n: number) => {
    const me = alice();
    let made = 0;
    for (const rec of db.listRecommendations(me.id, { status: "open" })) {
      if (made === n) break;
      try {
        db.activate(me, rec.id, { budgetPercent: 10 });
        made++;
      } catch {
        // 활성화할 수 없는 추천은 건너뛴다
      }
    }
    expect(made).toBe(n);
  };

  it("진행 중 계획이 있던 사람은 그 행 수만큼 자리를 잡고, 받은 뒤 다음 방문을 위해 개수(최대 3)를 기억한다", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    activateOpen(2);
    localStorage.setItem("home-rows:1:plans", "2");
    server.use(http.get("*/api/trade-plans", async () => void (await delay(150)))); // 계획이 늦게 온다 (그 뒤 원래 응답)
    renderApp("/");
    const live = await screen.findByRole("region", { name: "진행 중인 모의 자동매매" });
    expect(within(live).getByRole("group", { name: "불러오는 중" }).children).toHaveLength(2);
    const list = await within(live).findByRole("list", { name: "진행 중인 모의 자동매매 목록" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(localStorage.getItem("home-rows:1:plans")).toBe("2");
  });

  it("기억이 없으면 처음 쓰는 사람처럼 빈 줄 한 줄 자리 — 받아 보니 비었으면 0을, 자산 기준 시각 줄 수도 기억한다", async () => {
    server.use(http.get("*/api/trade-plans", async () => void (await delay(150))));
    renderApp("/", "bob"); // 밥: 진행 중 계획 없음, 보유 없음
    const live = await screen.findByRole("region", { name: "진행 중인 모의 자동매매" });
    expect(within(live).getByRole("group", { name: "불러오는 중" }).children).toHaveLength(1);
    expect(await within(live).findByText(/진행 중인 모의 자동매매가 없어요/)).toBeTruthy();
    await waitFor(() => expect(localStorage.getItem("home-rows:2:plans")).toBe("0"));
    await waitFor(() => expect(localStorage.getItem("home-rows:2:asof")).toBe("0"));
    await waitFor(() => expect(localStorage.getItem("home-rows:2:reports")).toBe("0")); // 팀이 완성한 리포트 없음
    cleanup();
    renderApp("/"); // 앨리스: 국내·미국 보유 → 기준 시각 두 줄
    await screen.findByRole("region", { name: "내 자산" });
    await waitFor(() => expect(localStorage.getItem("home-rows:1:asof")).toBe("2"));
  });
});

describe("홈 · 교차검증 분석 카드", () => {
  it("카드 안쪽이 272px보다 좁으면 진입·목표·손절을 세 줄로 (일곱 자리 가격 77px × 3 + 간격 16 + 안쪽 여백 24 — PC 1280px 2단 카드 안쪽은 243~250px)", () => {
    db.setSession("alice");
    const a = db.listAnalyses("005930", null)[0];
    render(
      <MemoryRouter>
        <Providers client={createQueryClient({ retry: false })}>
          <AnalysisCard a={a} view="expert" />
        </Providers>
      </MemoryRouter>,
    );
    const dl = screen.getByText("진입").closest("dl")!;
    expect(dl.className).toContain("@max-[272px]:grid-cols-1");
    expect(screen.getByText("진입").parentElement?.className).toContain("@max-[272px]:flex");
  });
});

describe("홈 · 바뀐 순간과 알림이 갈 곳", () => {
  const r = (id: number, status: ReportSummary["status"]) =>
    ({ id, status, source: "user", symbol: "X", name: `R${id}`, createdAt: "2026-10-05T09:00:00+09:00" }) as ReportSummary;

  it("오늘의 내 종목 뉴스 알림(link '/')은 홈의 그 카드로, 나머지는 서버 link 그대로", () => {
    expect(notificationHref({ kind: "daily_move", link: "/" })).toBe("/#daily-move");
    expect(notificationHref({ kind: "recommendation", link: "/recommendations/91" })).toBe("/recommendations/91");
    expect(notificationHref({ kind: "system", link: null })).toBe("/notifications");
  });

  it("알림을 눌러 오면 카드로 착지하고, 처음 연 주소·뒤로 가기(POP)는 보던 자리를 지킨다 (다시 내려가 강조하지 않는다)", async () => {
    const note = { id: 900, kind: "daily_move", title: "삼성전자 오늘의 뉴스", body: "시장과 비슷하게 움직였어요", link: "/" };
    const page = { count: 1, results: [{ ...note, createdAt: "2026-10-05T16:40:00+09:00", readAt: null }], unreadCount: 1 };
    server.use(http.get("*/api/notifications", () => HttpResponse.json(page)));
    renderApp("/#daily-move", "bob"); // 처음 연 주소: 새로고침과 같은 POP — 보던 자리는 ScrollManager가 되돌린다
    const focusKey = () => screen.getByTestId("daily-move").getAttribute("data-focus");
    const notes = await screen.findByRole("list", { name: "최근 알림 목록" });
    expect(focusKey()).toBe("");
    const daily = within(notes).getByRole("link", { name: /삼성전자 오늘의 뉴스/ });
    expect(daily.getAttribute("href")).toBe("/#daily-move"); // 같은 홈 주소라도 카드 자리로 (lib/nav notificationHref)
    fireEvent.click(daily);
    await waitFor(() => expect(focusKey()).not.toBe("")); // 앱 안 이동(PUSH) → 카드로 착지

    const ranking = await screen.findByRole("region", { name: "랭킹" });
    fireEvent.click(await within(ranking).findByRole("link", { name: /랭킹/ }));
    fireEvent.click(await screen.findByRole("button", { name: "뒤로 가기" }));
    await screen.findByRole("list", { name: "최근 알림 목록" });
    expect(focusKey()).toBe("");
  });

  it("폴링으로 상태가 바뀐 행만 잠깐 강조한다 (처음 받은 값·새로 생긴 항목은 아니다)", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ e }) => useChangedKeys(e), { initialProps: { e: [[1, "entry_pending"]] as [number, string][] } });
    expect(result.current.size).toBe(0);
    rerender({
      e: [
        [1, "holding"],
        [2, "active"],
      ],
    });
    expect([...result.current]).toEqual([1]);
    act(() => void vi.advanceTimersByTime(CHANGED_MS));
    expect(result.current.size).toBe(0);
  });

  it("만들던 내 리포트가 끝나면 잠깐 남기고(완성·실패), 처음부터 끝나 있던 것은 넣지 않는다", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ m }) => useJustFinished(m), { initialProps: { m: undefined as ReportSummary[] | undefined } });
    rerender({ m: [r(1, "running"), r(2, "completed")] });
    expect(result.current).toEqual([]);
    rerender({ m: [r(1, "completed"), r(2, "completed")] });
    expect(result.current.map((x) => x.id)).toEqual([1]);
    act(() => void vi.advanceTimersByTime(FINISHED_MS));
    expect(result.current).toEqual([]);
  });

  it("만드는 중인 리포트가 완성되면 그 자리에 '완성됐어요 · 보기' 행이 남는다", () => {
    const at = (mine: ReportSummary[]) => (
      <MemoryRouter>
        <ReportsInProgress mine={mine} view="easy" />
      </MemoryRouter>
    );
    const { rerender } = render(at([r(1, "running")]));
    const running = screen.getByRole("region", { name: "만드는 중인 리포트 1개" });
    expect(within(running).getByText(REPORT_KEEPS_RUNNING)).toBeTruthy();
    rerender(at([r(1, "completed")]));
    const done = screen.getByRole("region", { name: "방금 끝난 리포트" });
    expect(within(done).getByRole("link", { name: "R1 리포트 완성됐어요 · 보기" }).getAttribute("href")).toBe("/reports/1");
    expect(within(done).queryByText(REPORT_KEEPS_RUNNING)).toBeNull();
  });
});
