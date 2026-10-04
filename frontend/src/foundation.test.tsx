// 프론트 기반: 하단 탭·서비스 이름·출처 줄, 새 주소(단타 연습장), 장마감 기준 표시, 용어 풀이, 주린이모드·화면별 보기, 새 API 훅.
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import indexHtml from "../index.html?raw";
import robotsTxt from "../public/robots.txt?raw";
import { Providers } from "./App";
import { useDayPlans, useDayPreview, useDayReview, useDayStatus, useMinuteCandles } from "./api/day";
import { useDailyMove, useDailyMoves, useFundamentals, useTheses } from "./api/longterm";
import { useDayQuiz, useInvestorProfile } from "./api/profile";
import { POLL, useAnalyses, useReports } from "./api/queries";
import { useReportQuota } from "./api/reports";
import { Term } from "./components/Term";
import { AsOf } from "./components/ui";
import { useBeginnerMode, useViewMode } from "./hooks/useBeginnerMode";
import { createQueryClient } from "./lib/queryClient";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";
import { freezeTime } from "./test/time";

/** 라우터 + 쿼리 + 로그인 상태로 훅·조각을 그린다. */
function wrapper(path = "/", user: string | null = "alice") {
  db.setSession(user);
  const client = createQueryClient({ retry: false });
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[path]}>
      <Providers client={client}>{children}</Providers>
    </MemoryRouter>
  );
}

describe("화면 틀", () => {
  it("하단 탭 다섯 칸, 탭 안의 화면에서도 그 탭이 켜진다", async () => {
    renderApp("/plans");
    const tabs = await screen.findByRole("navigation", { name: "하단 탭" });
    const links = within(tabs).getAllByRole("link");
    expect(links.map((a) => [a.textContent, a.getAttribute("href")])).toEqual([
      ["홈", "/"],
      ["종목", "/search"],
      ["리포트", "/reports"],
      ["모의투자", "/portfolio"],
      ["마이", "/my"],
    ]);
    expect(within(tabs).getByRole("link", { name: "모의투자" }).getAttribute("aria-current")).toBe("page");
    expect(within(tabs).getByRole("link", { name: "홈" }).getAttribute("aria-current")).toBeNull();
    // 왼쪽 메뉴: 같은 순서 + 알림, 서비스 이름
    const side = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(side).getAllByRole("link").map((a) => a.textContent?.replace(/\d+$/, ""))).toEqual(["홈", "종목", "리포트", "모의투자", "알림", "마이"]);
    expect(screen.getByRole("link", { name: /AI 리포트 데스크/ }).getAttribute("href")).toBe("/");
  });

  it("만드는 중인 내 리포트가 있으면 '리포트' 탭(하단·왼쪽)에 점이 붙고, 링크 설명으로도 알린다", async () => {
    renderApp("/plans"); // 앨리스: 오늘 신청한 삼성전자 리포트가 대기 중
    const tabs = await screen.findByRole("navigation", { name: "하단 탭" });
    const tab = within(tabs).getByRole("link", { name: "리포트" });
    await waitFor(() => expect(tab.querySelector("[data-making-dot]")).toBeTruthy());
    expect(document.getElementById(tab.getAttribute("aria-describedby") ?? "")?.textContent).toBe("만드는 중인 내 리포트가 있어요");
    const side = within(screen.getByRole("navigation", { name: "주 메뉴" })).getByRole("link", { name: "리포트" });
    expect(side.querySelector("[data-making-dot]")).toBeTruthy();
    expect(within(tabs).getByRole("link", { name: "홈" }).querySelector("[data-making-dot]")).toBeNull();
  });

  it("만드는 중인 내 리포트가 없으면 점이 없다", async () => {
    let answered = false;
    server.events.on("response:mocked", ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname === "/api/reports" && url.searchParams.get("mine") === "1") answered = true;
    });
    renderApp("/plans", "carol");
    const tabs = await screen.findByRole("navigation", { name: "하단 탭" });
    await waitFor(() => expect(answered).toBe(true));
    server.events.removeAllListeners();
    const tab = within(tabs).getByRole("link", { name: "리포트" });
    expect(tab.querySelector("[data-making-dot]")).toBeNull();
    expect(tab.getAttribute("aria-describedby")).toBeNull();
  });

  it("종목 상세는 종목 탭, 분석 상세는 리포트 탭", async () => {
    renderApp("/analyses/1");
    const tabs = await screen.findByRole("navigation", { name: "하단 탭" });
    expect(within(tabs).getByRole("link", { name: "리포트" }).getAttribute("aria-current")).toBe("page");
  });

  it("종목 상세: 쉬운 보기는 하단 탭을 그대로 두고, 전문가 보기는 하단 주문 버튼 자리라 탭을 숨긴다", async () => {
    const easy = renderApp("/stocks/005380", "bob"); // 주린이모드 켬 — 하단 주문 버튼이 없다
    await screen.findByRole("button", { name: /직접 주문\(고급\)/ });
    const tabs = screen.getByRole("navigation", { name: "하단 탭" });
    expect(within(tabs).getByRole("link", { name: "종목" }).getAttribute("aria-current")).toBe("page");
    easy.unmount();

    renderApp("/stocks/005380"); // 앨리스: 전문가 보기 — 하단 주문 버튼
    await screen.findByRole("region", { name: "주문" });
    await waitFor(() => expect(screen.queryByRole("navigation", { name: "하단 탭" })).toBeNull());
  });

  it("본문 아래 출처 줄은 MarketStatus.quoteProvider를 쓴다", async () => {
    renderApp("/");
    const footer = await screen.findByLabelText("자료 출처");
    await waitFor(() => expect(footer.textContent).toContain("시세: 키움증권 REST API 조회 · 장마감 기준"));
    expect(footer.textContent).toContain("공시·재무: 금융감독원 OpenDART, 금융위원회(공공데이터포털)");
    expect(footer.textContent).toContain("뉴스 제목: Google 뉴스 검색 결과(각 언론사)");
  });

  it("단타 연습장 주소 셋 (자리 화면)", async () => {
    renderApp("/day");
    expect(await screen.findByRole("heading", { name: "단타 연습장" })).toBeTruthy();
    renderApp("/day/quiz");
    expect(await screen.findByRole("heading", { name: "단타 연습 퀴즈" })).toBeTruthy();
    renderApp("/day/review");
    expect(await screen.findByRole("heading", { name: "단타 복기" })).toBeTruthy();
  });

  it("브라우저 제목과 검색엔진 색인 막기", () => {
    expect(indexHtml).toContain("<title>AI 리포트 데스크</title>");
    expect(indexHtml).toContain('<meta name="robots" content="noindex,nofollow" />');
    expect(robotsTxt.trim()).toBe("User-agent: *\nDisallow: /");
  });

  it("폴링 간격: 시세 60초 · 계좌 10초 · 랭킹 30초 · 주문·계획 5초", () => {
    expect([POLL.quote, POLL.stock, POLL.account, POLL.ranking, POLL.orders, POLL.plan]).toEqual([60_000, 60_000, 10_000, 30_000, 5000, 5000]);
  });
});

describe("작은 조각", () => {
  it("<AsOf>는 장마감 기준 시각을 시장별로, 값이 없으면 그리지 않는다", () => {
    const { container } = render(
      <>
        <AsOf at="2026-10-02T15:30:00+09:00" market="KR" />
        <AsOf at="2026-10-02T16:00:00-04:00" market="US" />
        <AsOf at={null} />
      </>,
    );
    const times = container.querySelectorAll("time");
    expect([...times].map((t) => t.textContent)).toEqual(["10월 2일(금) 15:30 장마감 기준", "10월 2일(금) 16:00(뉴욕) 장마감 기준"]);
    expect(times[0].getAttribute("dateTime")).toBe("2026-10-02T15:30:00+09:00");
  });

  it("<Term>은 눌러서 풀이를 열고, 다시 누르거나 Esc·바깥을 누르면 닫는다", () => {
    render(
      <p>
        <Term k="손익비" /> 그리고 <Term k="손절">손절 가격</Term> <button type="button">바깥</button>
      </p>,
    );
    const term = screen.getByRole("button", { name: "손익비" });
    expect(term.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(term);
    const tip = screen.getByRole("tooltip");
    expect(tip.textContent).toContain("목표에 팔면 버는 돈이 손절에 팔면 잃는 돈의 몇 배인지예요");
    expect(term.getAttribute("aria-describedby")).toBe(tip.id);
    fireEvent.click(term);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "손절 가격" }));
    expect(screen.getByRole("tooltip").textContent).toMatch(/^손절/);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "손절 가격" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "바깥" }));
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("<Term> 풀이는 360px 화면 밖으로 나가지 않는다 (오른쪽 열 용어는 왼쪽으로 당기고, 아래에 자리가 없으면 위로)", () => {
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    let anchor = rect(245, 300, 40, 20); // grid-cols-3의 셋째 칸 (ROE)
    const spy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockImplementation(function (this: HTMLElement) {
        return this.getAttribute("role") === "tooltip" ? rect(0, 0, 288, 90) : anchor;
      });
    vi.stubGlobal("innerWidth", 360);
    vi.stubGlobal("innerHeight", 640);
    try {
      render(
        <div className="overflow-x-auto">
          <Term k="ROE" />
        </div>,
      );
      fireEvent.click(screen.getByRole("button", { name: "ROE" }));
      const tip = screen.getByRole("tooltip");
      expect(tip.closest(".overflow-x-auto")).toBeNull(); // 가로 스크롤 상자에 잘리지 않게 body에 띄운다
      expect(tip.style.left).toBe(`${360 - 16 - 288}px`); // 오른쪽 끝이 화면 - 16px
      expect(tip.style.top).toBe("326px"); // 용어 아래 6px
      fireEvent.click(screen.getByRole("button", { name: "ROE" }));

      anchor = rect(4, 600, 40, 20); // 왼쪽 끝·화면 아래쪽
      fireEvent.click(screen.getByRole("button", { name: "ROE" }));
      expect(screen.getByRole("tooltip").style.left).toBe("16px");
      expect(screen.getByRole("tooltip").style.top).toBe(`${600 - 6 - 90}px`); // 위로 연다
      fireEvent.mouseDown(screen.getByRole("tooltip")); // 풀이 상자 안을 눌러도 닫히지 않는다
      expect(screen.getByRole("tooltip")).toBeTruthy();
    } finally {
      spy.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe("주린이모드 · 화면별 보기", () => {
  it("진단 전 팀원은 쉬운 보기, ?view=expert는 그 화면만 전문가 보기 (저장하지 않음)", async () => {
    const { result } = renderHook(() => useViewMode(), { wrapper: wrapper("/reports/1?tab=report", "bob") });
    await waitFor(() => expect(result.current.beginnerMode).toBe(true));
    expect(result.current).toMatchObject({ view: "easy", easy: true, override: null });
    result.current.setView("expert");
    await waitFor(() => expect(result.current.view).toBe("expert"));
    expect(result.current.override).toBe("expert");
    expect(db.investorProfile(2).beginnerMode).toBe(true); // 서버 값은 그대로
    result.current.setView(null);
    await waitFor(() => expect(result.current.view).toBe("easy"));
  });

  it("주린이모드를 끈 팀원(앨리스)은 전문가 보기, ?view=easy로 그 화면만 쉬운 보기", async () => {
    const { result } = renderHook(() => useViewMode(), { wrapper: wrapper("/reports/2?view=easy", "alice") });
    await waitFor(() => expect(result.current.beginnerMode).toBe(false));
    expect(result.current).toMatchObject({ view: "easy", override: "easy" });
  });

  it("스위치(PATCH)는 Me를 먼저 바꾸고 서버에 저장한다", async () => {
    const { result } = renderHook(() => ({ mode: useBeginnerMode(), view: useViewMode() }), { wrapper: wrapper("/", "bob") });
    await waitFor(() => expect(result.current.mode.isLoading).toBe(false));
    expect(result.current.view.view).toBe("easy");
    result.current.mode.setBeginnerMode(false);
    await waitFor(() => expect(result.current.view.view).toBe("expert"));
    await waitFor(() => expect(db.investorProfile(2).beginnerMode).toBe(false));
    await waitFor(() => expect(result.current.mode.profile?.beginnerMode).toBe(false));
    expect(result.current.mode.isSaving).toBe(false);
  });
});

describe("새 API 훅 (가짜 API에 모두 있다)", () => {
  it("계정·리포트·분석", async () => {
    const { result } = renderHook(
      () => ({
        profile: useInvestorProfile(),
        quiz: useDayQuiz(),
        quota: useReportQuota(),
        mine: useReports({ mine: true }),
        analyses: useAnalyses({ mine: true }),
      }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(Object.values(result.current).every((q) => q.isSuccess)).toBe(true));
    expect(result.current.profile.data?.dayTradingUnlocked).toBe(true);
    expect(result.current.quiz.data?.questions).toHaveLength(5);
    expect(result.current.quota.data).toMatchObject({ limit: 3, used: 1, remaining: 2 });
    expect(result.current.mine.data?.results.map((r) => r.symbol)).toEqual(["005930"]);
    expect(result.current.analyses.data?.results.length).toBeGreaterThan(0);
    expect(result.current.analyses.data?.results.every((a) => a.requestedBy === "앨리스")).toBe(true); // 닉네임 (로그인 아이디는 내지 않는다)
  });

  it("장기투자·단타 연습", async () => {
    // 오늘의 단타 계획 목록이 비어 있는 시각으로 고정한다 (평일 15:40 뒤에는 기준일 = 오늘이라 앨리스의 끝난 계획이 오늘 목록에 들어온다)
    freezeTime("2026-10-06T10:00:00+09:00");
    const input = { symbol: "005380", entryPrice: 247_000, targetPrice: 262_000, stopPrice: 244_000 };
    const { result } = renderHook(
      () => ({
        moves: useDailyMoves(),
        move: useDailyMove("005930"),
        theses: useTheses(),
        fundamentals: useFundamentals("068270"),
        minute: useMinuteCandles("005930", { minutes: 5 }),
        status: useDayStatus(),
        preview: useDayPreview(input),
        plans: useDayPlans(),
        review: useDayReview(),
      }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(Object.values(result.current).every((q) => q.isSuccess)).toBe(true));
    expect(result.current.moves.data?.results.length).toBeGreaterThan(0);
    expect(result.current.move.data?.symbol).toBe("005930");
    expect(result.current.theses.data?.results[0].symbol).toBe("068270");
    expect(result.current.fundamentals.data?.rows).toHaveLength(9);
    expect(result.current.minute.data?.candles).toHaveLength(78);
    expect(result.current.status.data?.unlocked).toBe(true);
    expect(result.current.preview.data?.costsAtTarget.totalKrw).toBeGreaterThan(0);
    expect(result.current.plans.data?.results).toEqual([]);
    expect(result.current.review.data?.plans).toHaveLength(1);
  });
});
