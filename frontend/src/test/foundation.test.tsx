// 프론트 기반: 하단 탭·서비스 이름·출처 줄, 장마감 기준 표시, 용어 풀이, 주린이모드·화면별 보기, 새 API 훅.
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { http } from "msw";
import { describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import faviconSvg from "../../public/favicon.svg?raw";
import robotsTxt from "../../public/robots.txt?raw";
import { Providers } from "../App";
import { useDailyMove, useDailyMoves, useFundamentals, useTheses } from "../api/longterm";
import { useInvestorProfile } from "../api/profile";
import { POLL, keys, useAccount, useAnalyses, useOrders, useQuotes, useReports, useStock } from "../api/queries";
import { useReportQuota } from "../api/reports";
import { Term } from "../components/Term";
import { AsOf } from "../components/ui";
import { useBeginnerMode, useViewMode } from "../hooks/useBeginnerMode";
import { createQueryClient } from "../lib/queryClient";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

/** index.html이 거는 아이콘 파일 (불러오지 않고 있는지만 본다). */
const PUBLIC_ICONS = import.meta.glob("../../public/*.{svg,png}");

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
    // 브랜드(홈 링크): 로고 32px(장식, 속이 빈 ㅁ 블록 셋) + 워드마크 — 옛 종이배·'AI' 글자 마크가 남지 않는다. 이름은 숨김 글자가 읽는다
    const brand = screen.getByRole("link", { name: "모매매" });
    expect(brand.getAttribute("href")).toBe("/");
    expect(brand.textContent).toBe("모매매");
    const logo = brand.querySelector("svg")!;
    expect([logo.getAttribute("width"), logo.getAttribute("aria-hidden"), logo.querySelectorAll("path").length]).toEqual(["32", "true", 3]);
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

  it("탭은 주소가 아니라 그린 구매 바를 따른다: 없는 종목(404)은 바가 없어 전문가 보기여도 하단 탭이 그대로다", async () => {
    renderApp("/stocks/NOPE999"); // 앨리스: 전문가 보기
    expect(await screen.findByText("종목을 찾을 수 없어요")).toBeTruthy();
    const tabs = screen.getByRole("navigation", { name: "하단 탭" }); // 숨기면(aria-hidden) 찾지 못한다
    expect(within(tabs).getByRole("link", { name: "종목" }).getAttribute("aria-current")).toBe("page");
    expect(document.documentElement.getAttribute("data-shell")).toBe("tabs");
    expect(screen.queryByRole("button", { name: /구매하기|주문/ })).toBeNull();
  });

  it("전문가 보기 첫 로딩: 뼈대도 하단 구매 바 자리(누를 수 없음)를 그려 탭이 내려가 있다 — 받은 뒤 탭이 올라왔다 다시 내려가지 않게", async () => {
    // 종목 응답을 붙잡아 두었다가 확인한 뒤 놓는다 (시간에 기대지 않게). 놓으면 원래 가짜 API가 답한다
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    server.use(http.get("*/api/stocks/:symbol", async () => void (await held)));
    renderApp("/stocks/005380");
    expect(await screen.findByRole("group", { name: "불러오는 중" })).toBeTruthy();
    const bar = screen.getByRole("button", { name: "주문" }) as HTMLButtonElement;
    expect([bar.disabled, bar.getAttribute("aria-busy")]).toEqual([true, "true"]);
    expect(screen.queryByRole("navigation", { name: "하단 탭" })).toBeNull();
    expect(document.documentElement.getAttribute("data-shell")).toBe("order");
    release();
    expect(await screen.findByRole("region", { name: "시세" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "하단 탭" })).toBeNull();
    expect(document.documentElement.getAttribute("data-shell")).toBe("order");
  });

  it("본문 아래 출처 줄은 MarketStatus.quoteProvider를 쓴다", async () => {
    renderApp("/");
    const footer = await screen.findByLabelText("자료 출처");
    await waitFor(() => expect(footer.textContent).toContain("시세: 키움증권 REST API 조회 · 실시간 (계좌·랭킹은 장마감 기준)"));
    expect(footer.textContent).toContain("공시·재무: 금융감독원 OpenDART, 금융위원회(공공데이터포털)");
    expect(footer.textContent).toContain("뉴스 제목: Google 뉴스 검색 결과(각 언론사)");
  });

  it("브라우저 제목·아이콘(파비콘·홈 화면 아이콘)과 검색엔진 색인 막기", () => {
    expect(indexHtml).toContain("<title>모매매</title>");
    expect(indexHtml).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(indexHtml).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="모매매" />');
    expect(Object.keys(PUBLIC_ICONS).sort()).toEqual(["../../public/apple-touch-icon.png", "../../public/favicon.svg"]);
    // 파비콘은 16px 전용 모양: 타일 + 속이 찬 사각형 셋(ㅁ 블록의 계단). 속이 빈 ㅁ(path)이나 선이 아니다 — 1배율에서 뭉개지므로
    expect(faviconSvg).toContain("ㅁ 블록 셋");
    expect(faviconSvg.match(/<rect/g)).toHaveLength(4);
    expect(faviconSvg).not.toContain("<path");
    expect(faviconSvg).not.toContain("stroke");
    expect(indexHtml).toContain('<meta name="robots" content="noindex,nofollow" />');
    expect(robotsTxt.trim()).toBe("User-agent: *\nDisallow: /");
  });

  it("폴링 간격: 시세 5초 · 계좌 10초 · 랭킹 30초 · 주문·계획 5초", () => {
    expect([POLL.quote, POLL.stock, POLL.account, POLL.ranking, POLL.orders, POLL.plan]).toEqual([5000, 5000, 10_000, 30_000, 5000, 5000]);
  });

  it("시세(useQuotes·useStock)는 5초마다, 탭이 가려져도 계속 받는다 — 계좌도 같고, 주문은 탭이 보일 때만 (docs/API.md 공통 규칙)", async () => {
    db.setSession("alice");
    const client = createQueryClient({ retry: false });
    const wrap = ({ children }: { children: ReactNode }) => (
      <MemoryRouter>
        <Providers client={client}>{children}</Providers>
      </MemoryRouter>
    );
    const { result } = renderHook(() => ({ quotes: useQuotes(["005930"]), stock: useStock("005930"), account: useAccount(), orders: useOrders() }), { wrapper: wrap });
    await waitFor(() => expect(Object.values(result.current).every((q) => q.isSuccess)).toBe(true));
    const polling = (key: readonly unknown[]) => {
      const o = client.getQueryCache().find({ queryKey: key })?.observers[0]?.options;
      return [o?.refetchInterval, o?.refetchIntervalInBackground];
    };
    expect(polling(keys.quotes(["005930"]))).toEqual([5000, true]);
    expect(polling(keys.stock("005930"))).toEqual([5000, true]);
    expect(polling(keys.account)).toEqual([10_000, true]);
    expect(polling(keys.orders("active"))).toEqual([5000, false]);
  });
});

describe("작은 조각", () => {
  it("<AsOf basis=live>는 받은 시각을 '실시간 · 시:분:초'(한국 시간)로, basis를 안 주면 장마감 기준 그대로", () => {
    const { container } = render(
      <>
        <AsOf at="2026-10-06T15:20:31+09:00" market="KR" basis="live" />
        <AsOf at="2026-10-06T06:20:31Z" market="US" basis="live" />
        <AsOf at="2026-10-02T15:30:00+09:00" market="KR" basis="close" />
        <AsOf at="2026-10-02T15:30:00+09:00" />
        <AsOf at={null} basis="live" />
      </>,
    );
    const times = container.querySelectorAll("time");
    expect([...times].map((t) => t.textContent)).toEqual([
      "실시간 · 15:20:31",
      "실시간 · 15:20:31",
      "10월 2일(금) 15:30 장마감 기준",
      "10월 2일(금) 15:30 장마감 기준",
    ]);
    expect(times[0].getAttribute("dateTime")).toBe("2026-10-06T15:20:31+09:00");
  });

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
        quota: useReportQuota(),
        mine: useReports({ mine: true }),
        analyses: useAnalyses({ mine: true }),
      }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(Object.values(result.current).every((q) => q.isSuccess)).toBe(true));
    expect(result.current.profile.data).toMatchObject({ beginnerMode: false, experienceLevel: "intermediate" });
    expect(result.current.quota.data).toMatchObject({ limit: 3, used: 1, remaining: 2 });
    expect(result.current.mine.data?.results.map((r) => r.symbol)).toEqual(["005930"]);
    expect(result.current.analyses.data?.results.length).toBeGreaterThan(0);
    expect(result.current.analyses.data?.results.every((a) => a.requestedBy === "앨리스")).toBe(true); // 닉네임 (로그인 아이디는 내지 않는다)
  });

  it("장기투자", async () => {
    freezeTime("2026-10-06T10:00:00+09:00"); // 화요일 장중 (오늘의 내 종목 뉴스는 KR 기준일 10월 5일)
    const { result } = renderHook(
      () => ({
        moves: useDailyMoves(),
        move: useDailyMove("005930"),
        theses: useTheses(),
        fundamentals: useFundamentals("068270"),
      }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(Object.values(result.current).every((q) => q.isSuccess)).toBe(true));
    expect(result.current.moves.data?.results.length).toBeGreaterThan(0);
    expect(result.current.move.data?.symbol).toBe("005930");
    expect(result.current.theses.data?.results[0].symbol).toBe("068270");
    expect(result.current.fundamentals.data?.rows).toHaveLength(9);
  });
});
