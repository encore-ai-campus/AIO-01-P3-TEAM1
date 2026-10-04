import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";
import { freezeTime } from "./test/time";

const toast = () => screen.getByRole("status");

describe("로그인", () => {
  it("미로그인이면 /login으로 보낸다", async () => {
    renderApp("/portfolio", null);
    expect(await screen.findByRole("button", { name: "로그인" })).toBeTruthy();
    expect(screen.getByLabelText("아이디")).toBeTruthy();
  });

  it("로그인 성공하면 CSRF 쿠키를 받아 로그인하고 원래 화면으로 간다", async () => {
    const seen: (string | null)[] = [];
    server.events.on("request:start", ({ request }) => {
      if (request.url.endsWith("/api/auth/login")) seen.push(request.headers.get("X-CSRFToken"));
    });
    renderApp("/ranking", null);
    fireEvent.change(await screen.findByLabelText("아이디"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "alice1234" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("heading", { name: "랭킹" })).toBeTruthy();
    expect(seen).toEqual(["mock-csrf-token"]);
    server.events.removeAllListeners();
  });

  it("로그인 실패면 서버 메시지를 보여 준다", async () => {
    renderApp("/", null);
    fireEvent.change(await screen.findByLabelText("아이디"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect((await screen.findByRole("alert")).textContent).toBe("아이디 또는 비밀번호가 올바르지 않습니다.");
  });

  it("로그인 화면에 서비스 이름과 모의 계좌 안내", async () => {
    renderApp("/", null);
    expect(await screen.findByRole("heading", { name: "AI 리포트 데스크" })).toBeTruthy();
    expect(screen.getByText("실제 주문은 나가지 않아요. 모든 매매는 모의 계좌에서만 이뤄집니다.")).toBeTruthy();
    expect(screen.queryByText(/팀 모의매매/)).toBeNull();
  });

  it("API가 401을 주면 로그인 화면으로 간다", async () => {
    renderApp("/portfolio");
    await screen.findByRole("heading", { name: "모의투자" }); // F-trade: 페이지 제목 "내 주식" → "모의투자"
    await screen.findByRole("list", { name: "보유 종목" }); // 계좌를 한 번 받아 그린 뒤에 세션을 끊는다
    db.setSession(null);
    server.use(http.get("*/api/account", () => HttpResponse.json({ detail: "로그인이 필요합니다." }, { status: 401 })));
    fireEvent.click(screen.getByRole("tab", { name: "체결 내역" }));
    fireEvent.click(screen.getByRole("tab", { name: "보유 종목" }));
    expect(await screen.findByRole("button", { name: "로그인" }, { timeout: 3000 })).toBeTruthy();
  });
});

describe("홈 (전문가 보기 — 앨리스는 주린이모드 끔)", () => {
  it("내 자산 카드와 AI 교차검증 분석 카드를 그린다", async () => {
    renderApp("/");
    const asset = await screen.findByRole("region", { name: "내 자산" });
    const acc = db.account(1);
    await waitFor(() => expect(within(asset).getByText(`${acc.equityKrw.toLocaleString("ko-KR")}원`)).toBeTruthy());
    expect(within(asset).getByText("투자금액")).toBeTruthy();
    expect(within(asset).getByText(`${acc.investedKrw.toLocaleString("ko-KR")}원`)).toBeTruthy();

    const dash = await screen.findByRole("region", { name: "AI 교차검증 분석" });
    const cards = await within(dash).findAllByRole("article");
    // BUY 먼저 → 최신순, 종목당 최신 분석 하나
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual([
      "삼성전자 AI 분석",
      "SK하이닉스 AI 분석",
      "에코프로비엠 AI 분석",
      "NVIDIA AI 분석",
      "카카오 AI 분석",
      "Apple AI 분석",
    ]);
    const samsung = cards[0];
    expect(within(samsung).getByText("BUY")).toBeTruthy();
    expect(within(samsung).getByText("진입")).toBeTruthy();
    // 현재가는 /api/quotes로 따로 받는다
    await waitFor(() => expect(within(samsung).getByText("71,200원")).toBeTruthy());
    expect(within(samsung).getByText("+0.99%")).toBeTruthy();
    expect(samsung.closest("a")?.getAttribute("href")).toBe("/stocks/005930?analysis=1");
  });

  it("BUY 필터는 BUY 판정만", async () => {
    renderApp("/");
    const dash = await screen.findByRole("region", { name: "AI 교차검증 분석" });
    await within(dash).findAllByRole("article");
    fireEvent.click(within(dash).getByRole("button", { name: "BUY" }));
    await waitFor(() => expect(within(dash).getAllByRole("article")).toHaveLength(3));
  });
});

describe("종목 상세 주문", () => {
  it("시장가 매수 요청 결과를 토스트로 보여 주고 보유로 바뀐다", async () => {
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    fireEvent.change(await within(panel).findByLabelText("수량"), { target: { value: "3" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    await waitFor(() => expect(toast().textContent).toContain("현대차 3주 248,000원에 매수 체결"));
    expect(await within(panel).findByRole("button", { name: "전량 매도" })).toBeTruthy();
    expect(db.listOrders(1, "active").some((o) => o.symbol === "005380" && o.status === "EXIT_WATCHING")).toBe(true);
  });

  it("정규장 밖이면 예약 안내를 보이고 예약으로 접수한다", async () => {
    db.resetDb({ jitter: false, jobPolls: 1, marketOpen: { KR: false, US: false } });
    renderApp("/stocks/005380");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByText("장이 닫혀 있어 다음 정규장 시작에 예약됩니다.")).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText("수량"), { target: { value: "2" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수 예약하기" }));
    await waitFor(() => expect(toast().textContent).toContain("다음 정규장 시작에 예약했습니다"));
    expect(await within(panel).findByText("매수 예약됨")).toBeTruthy();
  });

  it("AI 분석 카드에서 오면 목표가·손절가를 채워 준다", async () => {
    renderApp("/stocks/000660?analysis=2");
    const panel = await screen.findByRole("region", { name: "주문" });
    const best = db.getAnalysis(2).best!;
    await waitFor(() => expect((within(panel).getByLabelText("목표가") as HTMLInputElement).value).toBe(String(best.targetPrice)));
    expect((within(panel).getByLabelText("손절가") as HTMLInputElement).value).toBe(String(best.stopPrice));
    expect((within(panel).getByLabelText("보유 기한") as HTMLInputElement).value).toBe(String(best.holdingDays));
  });

  it("주문이 거절되면 서버 사유를 보여 준다", async () => {
    renderApp("/stocks/373220");
    const panel = await screen.findByRole("region", { name: "주문" });
    await within(panel).findByText("매수 가능액");
    server.use(http.post("*/api/orders", () => HttpResponse.json({ detail: "새 모의 매수가 중단되어 있습니다." }, { status: 400 })));
    fireEvent.change(within(panel).getByLabelText("수량"), { target: { value: "1" } });
    fireEvent.click(within(panel).getByRole("button", { name: "매수하기" }));
    await waitFor(() => expect(toast().textContent).toContain("새 모의 매수가 중단되어 있습니다."));
  });

  it("보유 중이면 보유 정보와 전량 매도", async () => {
    renderApp("/stocks/005930");
    const panel = await screen.findByRole("region", { name: "주문" });
    expect(await within(panel).findByText("보유 중")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: "전량 매도" }));
    fireEvent.click(within(panel).getByRole("button", { name: "매도하기" }));
    await waitFor(() => expect(toast().textContent).toContain("삼성전자 10주 71,200원에 매도 체결"));
  });

  it("AI 교차검증 분석을 요청하면 작업이 끝난 뒤 분석 상세로 간다", async () => {
    renderApp("/stocks/005380");
    const btn = await screen.findByRole("button", { name: "AI 교차검증 분석" }); // D-1 보조 버튼 이름
    await screen.findByText(/오늘 남은 횟수 4회/);
    fireEvent.click(btn);
    // F-trade: 분석 상세 제목 "{name} AI 분석" → "{name} AI 교차검증 분석"
    expect(await screen.findByRole("heading", { name: "현대차 AI 교차검증 분석" }, { timeout: 3000 })).toBeTruthy();
    const order = screen.getByRole("link", { name: "이 종목 주문하기" }); // 전문가 보기(앨리스): 주문 화면으로 목표가·손절가를 채워 간다
    expect(order.getAttribute("href")).toMatch(/^\/stocks\/005380\?analysis=\d+$/);
  });
});

describe("마이", () => {
  it("수익률·투자금액을 보이고 공개 체크박스가 PATCH를 보낸다", async () => {
    const patches: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.method === "PATCH") patches.push(await request.clone().json());
    });
    db.setSession("carol");
    renderApp("/my", "carol");
    const acc = db.account(3);
    const sign = acc.profitRate > 0 ? "+" : "";
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    expect(await within(mine).findByText(`${sign}${(acc.profitRate * 100).toFixed(2)}%`)).toBeTruthy();
    expect(within(mine).getByText("투자금액")).toBeTruthy();

    const box = screen.getByRole("checkbox", { name: "내 정보 공개" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    expect((screen.getByRole("checkbox", { name: "내 정보 공개" }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(db.sessionUser()?.isPublic).toBe(true));
    expect(patches).toEqual([{ isPublic: true }]);
    expect(await screen.findByText("랭킹보드에 수익률을 공개합니다.")).toBeTruthy();
    server.events.removeAllListeners();
  });

  it("보유가 있으면 투자금액은 매수 원금 합계", async () => {
    renderApp("/my");
    const acc = db.account(1);
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    expect(await within(mine).findByText(`${acc.investedKrw.toLocaleString("ko-KR")}원`)).toBeTruthy();
  });
});

describe("랭킹", () => {
  it("공개한 팀원의 순위와 내 순위를 보인다", async () => {
    renderApp("/ranking");
    const list = await screen.findByRole("list", { name: "랭킹 목록" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent?.replace(/[+-]?\d+\.\d+%/, "").trim())).toContain("1밥");
    expect(rows).toHaveLength(4); // 비공개인 캐롤은 빠진다
    const mine = rows.find((r) => r.getAttribute("aria-current") === "true")!;
    expect(within(mine).getByText("나")).toBeTruthy();
    const me = db.ranking(1).me;
    expect(screen.getByText(`${me.rank}위`)).toBeTruthy();
  });

  it("평가에 쓴 종가의 기준 시각(보유한 시장마다)과 계산 시각, 뒤로 가기", async () => {
    freezeTime("2026-10-06T10:00:00+09:00"); // KR·뉴욕 기준일 모두 10월 5일(월)
    renderApp("/ranking");
    const section = await screen.findByRole("region", { name: "수익률 순위" });
    expect(await within(section).findByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
    expect(within(section).getByText("10월 5일(월) 16:00(뉴욕) 장마감 기준")).toBeTruthy();
    expect(within(section).getByText(/계산$/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "뒤로 가기" })).toBeTruthy();
  });

  it("내가 비공개면 공개 안내를 보인다", async () => {
    renderApp("/ranking", "carol");
    expect(await screen.findByText("마이에서 공개를 켜면 랭킹에 나옵니다")).toBeTruthy();
    expect(screen.getByRole("link", { name: "마이로 가기" })).toBeTruthy();
  });
});

describe("알림 화면", () => {
  it("알림마다 종류 이름을 보인다 (리포트 완성·실패, 오늘의 내 종목 뉴스, 펀더멘털 점검)", async () => {
    const at = new Date().toISOString();
    const item = (id: number, kind: string, title: string, link: string | null) => ({ id, kind, title, body: "본문", link, createdAt: at, readAt: null });
    const results = [
      item(1, "report_completed", "삼성전자 리포트가 완성됐어요", "/reports/2"),
      item(2, "report_failed", "에코프로비엠 리포트를 만들지 못했어요", "/reports/1"),
      item(3, "daily_move", "오늘 내 종목 2개의 소식", "/portfolio"),
      item(4, "thesis_check", "셀트리온 펀더멘털 점검 결과", "/stocks/068270"),
      item(5, "something_new", "모르는 종류", null),
    ];
    server.use(http.get("*/api/notifications", () => HttpResponse.json({ count: results.length, results, unreadCount: results.length })));
    renderApp("/notifications");
    const list = await screen.findByRole("list", { name: "알림 목록" });
    const rows = within(list).getAllByRole("listitem");
    const labels = ["리포트 완성", "리포트 만들지 못함", "오늘의 내 종목 뉴스", "펀더멘털 점검", "알림"]; // 모르는 종류는 "알림"
    expect(rows).toHaveLength(labels.length);
    labels.forEach((label, i) => expect(within(rows[i]).getByText(label)).toBeTruthy());
    expect(within(list).getByRole("button", { name: "안 읽음: 삼성전자 리포트가 완성됐어요" })).toBeTruthy();
  });
});

describe("내 주식", () => {
  it("보유·대기 주문·체결 내역 탭", async () => {
    renderApp("/portfolio");
    const holdings = await screen.findByRole("list", { name: "보유 종목" });
    expect(within(holdings).getByText("삼성전자")).toBeTruthy();
    expect(within(holdings).getByText("NVIDIA")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "대기 주문·예약" }));
    fireEvent.click(await screen.findByRole("button", { name: "카카오 주문 취소" }));
    await waitFor(() => expect(toast().textContent).toContain("주문을 취소했습니다."));

    fireEvent.click(screen.getByRole("tab", { name: "체결 내역" }));
    const fills = await screen.findByRole("list", { name: "체결 내역" });
    expect(within(fills).getAllByRole("listitem").length).toBeGreaterThanOrEqual(4);
  });
});
