// 홈: 주린이모드 켬(쉬운 보기)과 끔(전문가 보기), 이 화면만 보기 바꾸기(?view=), 3단계 안내, 최근·만드는 중 리포트,
// 진행 중 모의 자동매매, 최근 알림, 자산 요약·랭킹 카드(장마감 기준).
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReportSummary } from "./api/types";
import { inProgressReports, pickRecentReports } from "./components/home/homeData";
import { formatAsOf } from "./lib/format";
import { REPORT_KEEPS_RUNNING } from "./lib/plainText";
import * as db from "./mocks/db";
import { renderApp } from "./test/render";
import { freezeTime } from "./test/time";

// 오늘의 내 종목 뉴스 카드는 F-ext가 만든다 — 홈이 어떤 보기·개수로 부르는지만 본다
vi.mock("./components/longterm/DailyMoveCard", () => ({
  DailyMoveCard: (p: { view: string; limit?: number }) => (
    <div data-testid="daily-move" data-view={p.view} data-limit={String(p.limit ?? "")} />
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
  return { view: el.getAttribute("data-view"), limit: el.getAttribute("data-limit") };
};

const GUIDE_LINE = "팀이 함께 쓰는 1,000만 원 모의 계좌로 연습해요 (되돌릴 수 없어요)";

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
    expect(within(guide).getByRole("link", { name: "종목 고르기" }).getAttribute("href")).toBe("/search");

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

    expect(dailyMove()).toEqual({ view: "easy", limit: "3" });
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
    fireEvent.click(within(guide).getByRole("button", { name: "안내 닫기" }));
    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
    expect(localStorage.getItem("home-guide-closed:2")).toBe("1");

    renderApp("/", "bob");
    await screen.findAllByRole("region", { name: "만드는 중인 리포트 1개" });
    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
  });

  it("진행 중인 모의 자동매매는 쉬운 상태 이름과 출처", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    db.activate(alice(), 91, {});
    renderApp("/");
    const live = await screen.findByRole("list", { name: "진행 중인 모의 자동매매 목록" });
    const row = within(live).getByRole("link", { name: "SK하이닉스 모의 자동매매 보기" });
    expect(row.getAttribute("href")).toMatch(/^\/plans\/\d+$/);
    expect(within(row).getByText(/사는 가격을 기다리는 중|시작했어요|목표·손절을 지켜보는 중/)).toBeTruthy();
    expect(within(row).getByText(/AI 리포트/)).toBeTruthy(); // 출처
    expect(within(row).queryByText(/체결 대기|활성화됨/)).toBeNull(); // 원래 용어는 전문가 보기에만
  });

  it("최근 알림 3개는 종류 이름과 함께, 누르면 읽음 처리하고 그 링크로 간다", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    renderApp("/");
    const notes = await screen.findByRole("list", { name: "최근 알림 목록" });
    const rows = within(notes).getAllByRole("button");
    expect(rows).toHaveLength(3);
    const latest = db.listNotifications(1, false).rows.slice(0, 3);
    expect(rows.map((b) => latest.findIndex((n) => b.textContent?.includes(n.title)))).toEqual([0, 1, 2]);
    expect(within(notes).getAllByText("안 읽음")).toHaveLength(2);
    expect(within(rows[2]).getByText("모의 매도 완료")).toBeTruthy(); // NOTIFICATION_KIND_TEXT.closed

    const rec = rows.find((b) => b.textContent?.includes("SK하이닉스 AI 추천"))!;
    expect(within(rec).getByText("새 계획 제안")).toBeTruthy(); // NOTIFICATION_KIND_TEXT.recommendation
    fireEvent.click(rec);
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
    expect(dailyMove()).toEqual({ view: "expert", limit: "3" });

    // 앨리스의 만드는 중인 리포트(삼성전자)는 전문가 보기에도 보인다 (상태는 원래 용어)
    const running = await screen.findByRole("region", { name: "만드는 중인 리포트 1개" });
    expect(within(running).getByText(/신청됨/)).toBeTruthy();

    expect(screen.queryByRole("region", { name: "3단계로 연습해요" })).toBeNull();
    expect(screen.queryByRole("button", { name: /이 화면만/ })).toBeNull(); // 전문가는 마이에서 바꾼다
    const asset = screen.getByRole("region", { name: "내 자산" });
    expect(within(asset).getByText("매수 가능액")).toBeTruthy();
  });

  it("?view=easy면 이 화면만 쉬운 보기, 버튼으로 되돌린다 (서버의 주린이모드는 그대로)", async () => {
    renderApp("/?view=easy");
    expect(await screen.findByRole("region", { name: "3단계로 연습해요" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "이 화면만 자세히 보기" }));
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
    fireEvent.click(screen.getByRole("button", { name: "이 화면만 쉬운 보기로" }));
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
