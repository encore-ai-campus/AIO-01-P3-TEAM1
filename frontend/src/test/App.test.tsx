import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

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

  it("로그인 화면: 로고·이름·부제·풀이 한 줄, 아래 안심 줄은 '실제 주문은 나가지 않아요' (같은 말을 두 번 하지 않는다)", async () => {
    renderApp("/", null);
    const name = await screen.findByRole("heading", { name: "모매매" });
    const hero = name.parentElement!;
    // 로고 56px: 32px 이상이라 속이 빈 ㅁ 블록 셋, 이름 옆 장식이라 화면 읽기에서 숨는다 (이름은 제목 안의 숨김 글자가 읽는다)
    const logo = hero.querySelector("svg")!;
    expect([logo.getAttribute("width"), logo.getAttribute("aria-hidden"), logo.querySelectorAll("path").length]).toEqual(["56", "true", 3]);
    expect(within(hero).getByText("여러 AI가 함께 검증하는 모의투자")).toBeTruthy();
    expect(within(hero).getByText("AI들이 조사하고 서로 따져 본 리포트를 읽고, 가상 현금으로 매매를 연습해요.")).toBeTruthy();
    expect(screen.getByText("실제 주문은 나가지 않아요.")).toBeTruthy();
    // '가상 현금'은 풀이 한 줄이 말한다 — 안심 줄이 '모의 계좌에서만'을 되풀이하지 않는다
    expect(screen.queryByText(/모의 계좌에서만/)).toBeNull();
    expect(screen.queryByText(/팀 모의매매|리포트 데스크/)).toBeNull(); // 옛 이름(D-5)이 다시 나오지 않는다
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
    // BUY 먼저 → 최신순, 종목당 최신 분석 하나. 홈은 4장만 (나머지는 리포트 탭의 '교차검증 분석' 묶음)
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["삼성전자 AI 분석", "SK하이닉스 AI 분석", "에코프로비엠 AI 분석", "NVIDIA AI 분석"]);
    expect(within(dash).getByRole("link", { name: /교차검증 분석 전체 보기/ }).getAttribute("href")).toBe("/reports?list=analyses");
    const samsung = cards[0];
    expect(within(samsung).getByText("매수")).toBeTruthy();
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
    fireEvent.click(within(dash).getByRole("button", { name: "매수" }));
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
    expect(await within(panel).findByText("장이 닫혀 있어 다음 정규장 시작에 예약돼요.")).toBeTruthy();
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
    // 채운 칸은 시트·패널 첫 화면 밖이라, 무엇을 채웠는지 폼 맨 위에서 먼저 알린다
    const won = (n: number) => `${Math.round(n).toLocaleString("ko-KR")}원`;
    expect(within(panel).getByText("AI 분석 #2의 가격을 채웠어요")).toBeTruthy();
    expect(within(panel).getByText(`목표가 ${won(best.targetPrice)} · 손절가 ${won(best.stopPrice)} · 보유 기한 ${best.holdingDays}일`)).toBeTruthy();
    // 장기 보유로 바꾸면 (목표가·손절가를 쓰지 않으므로) 알림도 거둔다
    fireEvent.click(within(within(panel).getByRole("group", { name: "보유 방식" })).getByRole("button", { name: "장기 보유" }));
    expect(within(panel).queryByText("AI 분석 #2의 가격을 채웠어요")).toBeNull();
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
    await screen.findByText(/오늘 4번 더 분석할 수 있어요/);
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

    // 켬·끔 설정은 스위치 (my-06) — 랭킹 바로 아래에 있다 (my-02)
    const box = within(screen.getByRole("region", { name: "랭킹" })).getByRole("switch", { name: "내 정보 공개" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    box.focus();
    fireEvent.click(box);
    expect((screen.getByRole("switch", { name: "내 정보 공개" }) as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(db.sessionUser()?.isPublic).toBe(true));
    expect(patches).toEqual([{ isPublic: true }]);
    await waitFor(() => expect(toast().textContent).toContain("랭킹에 내 수익률을 공개했어요."));
    expect(document.activeElement).toBe(box); // 저장 뒤에도 같은 스위치에 포커스가 남는다 (다시 그리지 않는다)
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

  it("내가 비공개면 그 자리에서 공개를 켤 수 있고, 켜면 내 줄이 목록에 붙는다 (마이까지 가지 않는다)", async () => {
    renderApp("/ranking", "carol");
    expect(await screen.findByText("아직 랭킹에 내가 없어요")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "마이로 가기" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "랭킹 목록" })).getAllByRole("listitem")).toHaveLength(4);
    const sw = screen.getByRole("switch", { name: "랭킹에 내 수익률 공개" }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    await waitFor(() => expect(db.sessionUser()?.isPublic).toBe(true));
    const rows = await waitFor(() => {
      const r = within(screen.getByRole("list", { name: "랭킹 목록" })).getAllByRole("listitem");
      expect(r).toHaveLength(5);
      return r;
    });
    const mine = rows.find((r) => r.getAttribute("aria-current") === "true")!;
    expect(within(mine).getByText("캐롤")).toBeTruthy();
    expect(screen.getByText(`${db.ranking(3).me.rank}위`)).toBeTruthy(); // 위 카드는 내 순위로 바뀐다
    expect(screen.getByRole("link", { name: /공개 설정은 마이에서/ }).getAttribute("href")).toBe("/my#public");
  });

  it("순위 원은 1~3위 메달과 4위부터 숫자가 같은 폭 칸에 (닉네임 시작이 맞는다)", async () => {
    renderApp("/ranking");
    const rows = within(await screen.findByRole("list", { name: "랭킹 목록" })).getAllByRole("listitem");
    const medals = rows.map((r) => r.firstElementChild!.className);
    expect(medals.every((c) => c.includes("size-9"))).toBe(true);
    expect(medals[0]).toContain("bg-medal-gold");
    expect(medals[3]).not.toContain("bg-medal");
  });

  // 내 순위로 포커스를 옮기고 그 칸을 페이드하는 것은 이 화면에서 공개를 켠 때뿐이다 (my-r1).
  // 캐시 없이 처음 받은 공개 상태·폴링으로 받은 다른 곳의 변경은 사용자가 여기서 바꾼 것이 아니다
  const myRankBox = async () => (await screen.findByText("내 순위")).closest("dl")!;

  it("공개한 팀원이 캐시 없이 랭킹을 열면(새로고침·주소 직접 입력) 포커스를 내 순위로 옮기지 않고, 그 칸만 따로 페이드하지 않는다", async () => {
    renderApp("/ranking");
    const box = await myRankBox();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).not.toBe(box);
    expect(box.parentElement!.className).not.toContain("reveal-fade");
  });

  it("비공개 팀원이 이 화면에서 공개를 켜면 사라진 스위치 대신 새로 생긴 내 순위로 포커스가 간다", async () => {
    renderApp("/ranking", "carol");
    fireEvent.click(await screen.findByRole("switch", { name: "랭킹에 내 수익률 공개" }));
    const box = await myRankBox();
    await waitFor(() => expect(document.activeElement).toBe(box));
    expect(box.parentElement!.className).toContain("reveal-fade");
  });

  it("보는 동안 다른 곳(마이·다른 기기)에서 공개를 켜 다시 받기로 바뀌면 포커스를 옮기지 않는다", async () => {
    const { client } = renderApp("/ranking", "carol");
    await screen.findByText("아직 랭킹에 내가 없어요");
    db.updateProfile(db.sessionUser()!, { isPublic: true });
    void client.refetchQueries({ queryKey: ["ranking"] });
    const box = await myRankBox();
    await new Promise((r) => setTimeout(r, 0));
    expect(document.activeElement).not.toBe(box);
    expect(box.parentElement!.className).not.toContain("reveal-fade");
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
    // 화면을 옮기는 알림은 링크(새 탭에서 열기 가능), 링크가 없는 알림은 읽음 처리 버튼. 이름은 '안 읽음: 제목', 종류·본문·시각은 설명
    const link = within(list).getByRole("link", { name: "안 읽음: 삼성전자 리포트가 완성됐어요" });
    expect(link.getAttribute("href")).toBe("/reports/2");
    expect(link.getAttribute("aria-describedby")?.split(" ").map((id) => document.getElementById(id)?.textContent)).toEqual([
      "리포트 완성",
      "본문",
      "방금",
    ]);
    expect(within(list).getByRole("button", { name: "안 읽음: 모르는 종류" })).toBeTruthy();
  });

  it("알림이 없으면 무엇이 쌓이는지와 다음 할 일(리포트 만들기·알림 설정)", async () => {
    server.use(http.get("*/api/notifications", () => HttpResponse.json({ count: 0, results: [], unreadCount: 0 })));
    renderApp("/notifications");
    expect(await screen.findByText("아직 알림이 없어요")).toBeTruthy();
    expect(screen.getByRole("link", { name: "AI 리포트 만들기" }).getAttribute("href")).toBe("/reports");
    expect(screen.queryByRole("button", { name: "모두 읽음" })).toBeNull();
    // 머리의 톱니(알림 설정)는 알림이 없어도 늘 있다 — 마이의 알림 설정 카드 바로 앞으로 보낸다
    expect(screen.getAllByRole("link", { name: "알림 설정" }).map((a) => a.getAttribute("href"))).toEqual([
      "/my#notification-settings",
      "/my#notification-settings",
    ]);
  });

  it("링크 없는 알림을 읽으면 같은 버튼이 남아 포커스를 잃지 않고, 이름에서 '안 읽음'만 빠진다", async () => {
    const at = new Date().toISOString();
    let results = [{ id: 7, kind: "system", title: "점검 안내", body: "본문", link: null, createdAt: at, readAt: null as string | null }];
    server.use(
      http.get("*/api/notifications", () =>
        HttpResponse.json({ count: results.length, results, unreadCount: results.filter((n) => !n.readAt).length }),
      ),
      http.post("*/api/notifications/read", () => {
        results = results.map((n) => ({ ...n, readAt: at }));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderApp("/notifications");
    const row = await screen.findByRole("button", { name: "안 읽음: 점검 안내" });
    row.focus();
    fireEvent.click(row);
    await waitFor(() => expect(screen.getByRole("button", { name: "점검 안내" })).toBe(row));
    expect(document.activeElement).toBe(row);
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
