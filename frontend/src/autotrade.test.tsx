// AI 추천 → 계획 활성화 → 내 자동매매 → 알림 화면 (가짜 API: src/mocks). 앨리스는 주린이모드 끔(전문가 보기)이다.
// 쉬운 보기(새 계획 제안 → 실행 확인 → 모의 자동매매)와 모의투자 탭은 src/trade.test.tsx.
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";

const toast = () => screen.getByRole("status");
const alice = () => {
  db.setSession("alice");
  return db.sessionUser()!;
};

describe("AI 추천 목록", () => {
  it("진행 중 추천을 최신순으로, 출처 배지(연습용 예시는 AI 아님 표시)와 함께 보인다", async () => {
    renderApp("/recommendations");
    const list = await screen.findByRole("list", { name: "추천 목록" });
    const cards = within(list).getAllByRole("link");
    expect(cards.map((c) => c.getAttribute("aria-label"))).toEqual(["NAVER 추천 보기", "SK하이닉스 추천 보기", "에코프로비엠 추천 보기"]);
    expect(within(cards[0]).getByText("연습용 예시 · AI 아님")).toBeTruthy();
    expect(within(cards[0]).getByText("(가정)")).toBeTruthy(); // 확률을 AI가 주지 않음
    expect(within(cards[1]).getByText("AI 리포트")).toBeTruthy();
    expect(within(cards[1]).getByText("리스크 보통")).toBeTruthy();
    expect(within(cards[1]).getByText("+12.2%")).toBeTruthy(); // 목표 수익률 203,000 / 181,000 - 1
    expect(within(cards[2]).getByText("AI 교차검증 분석")).toBeTruthy();
    expect(cards[1].getAttribute("href")).toBe("/recommendations/91");

    fireEvent.click(screen.getByRole("button", { name: "전체" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "추천 목록" })).getAllByRole("link")).toHaveLength(4));
    const expired = screen.getByRole("link", { name: "삼성전자 추천 보기" });
    expect(within(expired).getByText("만료")).toBeTruthy();
  });

  it("연습용 예시 계획 만들기: 성공하면 상세로, 꺼져 있으면 서버 메시지를 그대로", async () => {
    renderApp("/recommendations");
    fireEvent.change(await screen.findByLabelText("종목 코드 (선택)"), { target: { value: "005380" } });
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    expect(await screen.findByRole("heading", { name: "현대차 추천" })).toBeTruthy();
    expect(screen.getByText(/연습용 예시 계획입니다 \(AI 아님\)/)).toBeTruthy();

    db.options.demoEnabled = false;
    renderApp("/recommendations");
    fireEvent.click((await screen.findAllByRole("button", { name: "만들기" })).at(-1)!);
    expect(await screen.findByText("시연용 추천이 꺼져 있습니다 (AUTOTRADE_DEMO=off).")).toBeTruthy();
  });

  it("추천·자동매매는 하단 탭과 왼쪽 메뉴의 모의투자 탭 안이고, 알림은 왼쪽 메뉴에 있다", async () => {
    renderApp("/recommendations");
    const tabs = await screen.findByRole("navigation", { name: "하단 탭" });
    const trade = within(tabs).getByRole("link", { name: "모의투자" });
    expect(trade.getAttribute("href")).toBe("/portfolio");
    expect(trade.getAttribute("aria-current")).toBe("page"); // /recommendations도 모의투자 탭
    const side = screen.getByRole("navigation", { name: "주 메뉴" });
    expect(within(side).getByRole("link", { name: "모의투자" }).getAttribute("aria-current")).toBe("page");
    expect(within(side).getByRole("link", { name: /^알림/ }).getAttribute("href")).toBe("/notifications");
  });
});

describe("추천 상세 · 활성화", () => {
  it("예산 → 리스크 미리 보기(종가 기준) → 요약 확인 → 계획 활성화 → 계획 화면", async () => {
    renderApp("/recommendations/91");
    expect(await screen.findByRole("heading", { name: "SK하이닉스 추천" })).toBeTruthy();
    expect(screen.getByRole("figure", { name: "가격 사다리" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /AI 리포트 #1 보기/ }).getAttribute("href")).toBe("/reports/1");
    const preview = screen.getByRole("region", { name: "리스크 미리 보기" });
    await within(preview).findByText("리스크 엔진 통과");
    expect(within(preview).getByText("건당 위험 한도")).toBeTruthy();
    expect(within(preview).getByText("직전 종가")).toBeTruthy();
    expect(within(preview).getByText(/장마감 기준$/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("예산 (원, 선택)"), { target: { value: "1,000,000" } });
    await waitFor(() => expect(within(preview).getByText("예산")).toBeTruthy(), { timeout: 3000 });
    expect(within(preview).getByText("5주")).toBeTruthy();

    const seen: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.url.endsWith("/activate")) seen.push(await request.clone().json());
    });
    const button = screen.getByRole("button", { name: "계획 활성화" });
    // 전문가 보기는 체크 셋(손절 시 손실·보유 기간 끝 매도·AI 제안/모의)을 한 줄 요약 확인으로 켠다
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "위 내용을 확인했습니다" }));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "SK하이닉스 자동매매" })).toBeTruthy();
    server.events.removeAllListeners();
    expect(seen).toEqual([{ budgetKrw: 1_000_000, acknowledged: true }]);
    expect(screen.getAllByText("체결 대기").length).toBeGreaterThan(0);
    const events = screen.getByRole("list", { name: "계획 사건" });
    expect(within(events).getByText("SK하이닉스 5주 181,000원 지정가 매수 주문 접수")).toBeTruthy();
    expect(screen.getByText("웹에서 활성화")).toBeTruthy();
    // 지금 단계 강조
    const steps = screen.getByRole("list", { name: "자동매매 단계" });
    expect(within(steps).getByText("체결 대기").closest("li")?.getAttribute("aria-current")).toBe("step");
  });

  it("Discord 링크(?t=)로 열면 띠를 보이고 token을 활성화 요청에 싣는다", async () => {
    const seen: Record<string, unknown>[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (request.url.endsWith("/activate")) seen.push(await request.clone().json());
    });
    renderApp("/recommendations/92?t=demo-92");
    expect(await screen.findByText("Discord에서 연 활성화 링크")).toBeTruthy();
    await within(screen.getByRole("region", { name: "리스크 미리 보기" })).findByText("리스크 엔진 통과");
    fireEvent.click(screen.getByRole("checkbox", { name: "위 내용을 확인했습니다" }));
    const button = screen.getByRole("button", { name: "계획 활성화" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "에코프로비엠 자동매매" })).toBeTruthy();
    server.events.removeAllListeners();
    expect(seen).toEqual([{ token: "demo-92", acknowledged: true }]);
    expect(screen.getByText("Discord 링크로 활성화")).toBeTruthy();
  });

  it("로그인 전에 Discord 링크를 열면 로그인 뒤 같은 주소(쿼리 포함)로 돌아온다", async () => {
    renderApp("/recommendations/92?t=demo-92", null);
    fireEvent.change(await screen.findByLabelText("아이디"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "alice1234" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    expect(await screen.findByRole("heading", { name: "에코프로비엠 추천" })).toBeTruthy();
    expect(screen.getByText("Discord에서 연 활성화 링크")).toBeTruthy();
  });

  it("활성화할 수 없으면 사유를 보이고 버튼을 막는다", async () => {
    db.options.halted = true;
    renderApp("/recommendations/93");
    const reasons = await screen.findByRole("list", { name: "활성화할 수 없는 사유" });
    expect(within(reasons).getByText("새 모의 매수가 중단되어 있습니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "계획 활성화" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("만료된 추천은 활성화 대신 안내와 내 계획 보기", async () => {
    renderApp("/recommendations/90");
    expect(await screen.findByText(/유효 기한\(.+\)이 지나 활성화할 수 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "계획 활성화" })).toBeNull();
    expect(screen.getByRole("link", { name: /내 계획 보기/ }).getAttribute("href")).toBe("/plans/95");
  });
});

describe("내 자동매매", () => {
  it("목록: 진행 중이 없으면 안내, 전체는 끝난 계획", async () => {
    renderApp("/plans");
    expect(await screen.findByText(/진행 중인 자동매매가 없습니다/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "전체" }));
    const row = await screen.findByRole("link", { name: "삼성전자 계획 보기" });
    expect(within(row).getByText("청산 완료")).toBeTruthy();
    expect(within(row).getByText("손익 +102,850원")).toBeTruthy();
  });

  it("체결 대기 중 계획 중단: 확인 → 주문 취소 → 중단됨", async () => {
    const plan = db.activate(alice(), 91, {});
    renderApp(`/plans/${plan.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "계획 중단" }));
    const dialog = screen.getByRole("dialog", { name: "SK하이닉스 계획을 중단할까요?" });
    expect(within(dialog).getByText(/체결 대기 중인 진입 주문을 취소/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "중단하기" }));
    await waitFor(() => expect(toast().textContent).toContain("사용자가 계획을 중단해 체결 대기 주문을 취소했습니다"));
    expect(screen.getAllByText("중단됨").length).toBeGreaterThan(0);
    expect(screen.getByRole("note").textContent).toContain("사용자가 중단");
    expect(screen.queryByRole("button", { name: "계획 중단" })).toBeNull();
    expect(db.listOrders(1, "all").find((o) => o.id === plan.orderId)?.status).toBe("CANCELED");
  });

  it("보유 중 계획 중단은 전량 매도 안내 → 청산 완료(직접 매도)", async () => {
    const plan = db.activate(alice(), 91, {});
    db.setPrice("000660", 180_000); // 진입가 아래 → 지정가 체결
    renderApp(`/plans/${plan.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "계획 중단" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/보유 수량을 전량 매도합니다/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "전량 매도하고 중단" }));
    await waitFor(() => expect(screen.getByRole("note").textContent).toContain("청산 완료 · 사용자 매도")); // docs/API.md "청산 사유" 표
  });

  it("시간이 지나면 체결 → 목표가 청산까지 진행하고 사건·알림이 쌓인다", async () => {
    db.options.planStepMs = 0;
    const plan = db.activate(alice(), 92, {});
    renderApp(`/plans/${plan.id}`);
    const events = await screen.findByRole("list", { name: "계획 사건" });
    await waitFor(() => expect(within(events).getAllByRole("listitem")).toHaveLength(5));
    expect(within(events).getByText(/에코프로비엠 .+ 200,000원에 체결/)).toBeTruthy();
    expect(within(events).getByText(/목표가 도달로 청산 \(225,000원/)).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("청산 완료 · 목표가 도달");
    const kinds = db.listNotifications(1, true).rows.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["plan_activated", "order_placed", "filled", "closed"]));
  });
});

describe("알림", () => {
  it("헤더 종에 안 읽은 수, 누르면 읽음 + 이동", async () => {
    renderApp("/notifications");
    const bells = await screen.findAllByRole("link", { name: "알림 (안 읽은 알림 2개)" });
    expect(bells.length).toBeGreaterThan(0);
    const list = await screen.findByRole("list", { name: "알림 목록" });
    expect(within(list).getAllByText("새 알림")).toHaveLength(2);
    fireEvent.click(within(list).getByRole("button", { name: "안 읽음: SK하이닉스 AI 추천" }));
    expect(await screen.findByRole("heading", { name: "SK하이닉스 추천" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("link", { name: "알림 (안 읽은 알림 1개)" }).length).toBeGreaterThan(0));
  });

  it("모두 읽음", async () => {
    renderApp("/notifications");
    fireEvent.click(await screen.findByRole("button", { name: "모두 읽음" }));
    await waitFor(() => expect(screen.getAllByRole("link", { name: "알림" }).length).toBeGreaterThan(0));
    expect(screen.queryByText("새 알림")).toBeNull();
  });
});

describe("알림 설정 (My Page)", () => {
  it("Webhook 미설정 안내, Discord ID 검증 메시지, 저장, 테스트 알림", async () => {
    renderApp("/my");
    expect(await screen.findByText("서버에 Discord Webhook이 설정되지 않아 웹 알림만 갑니다.")).toBeTruthy();
    const input = screen.getByLabelText("Discord 사용자 ID");
    fireEvent.change(input, { target: { value: "12345" } });
    fireEvent.blur(input);
    expect((await screen.findByRole("alert")).textContent).toBe("Discord 사용자 ID는 숫자 17~20자리입니다 (지금 5자리).");

    fireEvent.change(input, { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(toast().textContent).toContain("Discord 사용자 ID를 저장했습니다"));
    expect(db.notificationSettings(1).discordUserId).toBe("123456789012345678");

    fireEvent.click(screen.getByRole("switch", { name: /Discord로도 받기/ }));
    await waitFor(() => expect(db.notificationSettings(1).discordEnabled).toBe(false));

    fireEvent.click(screen.getByRole("button", { name: "테스트 알림 보내기" }));
    await waitFor(() => expect(toast().textContent).toContain("서버에 Discord Webhook이 없어 Discord로는 보내지 않았습니다."));
  });
});

describe("다른 화면과 잇기", () => {
  it("홈에 AI 추천 요약과 진행 중 자동매매", async () => {
    db.activate(alice(), 91, {});
    renderApp("/");
    const recs = await screen.findByRole("list", { name: "AI 추천 요약" });
    expect(within(recs).getAllByRole("listitem")).toHaveLength(3);
    const plans = await screen.findByRole("list", { name: "진행 중 자동매매 요약" });
    expect(within(plans).getByRole("link", { name: "SK하이닉스 계획 보기" })).toBeTruthy();
  });

  it("리포트 상세·분석 상세에 그 출처의 추천 카드", async () => {
    renderApp("/reports/1?tab=report");
    expect(await screen.findByRole("heading", { name: "이 리포트의 AI 추천 → 계획 활성화" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "SK하이닉스 추천 보기" }).getAttribute("href")).toBe("/recommendations/91");

    renderApp("/analyses/5");
    expect(await screen.findByRole("heading", { name: "이 분석의 AI 추천 → 계획 활성화" })).toBeTruthy();
  });

  it("모의투자 탭 위쪽에 진행 중 자동매매와 전체 보기 링크", async () => {
    db.activate(alice(), 91, {});
    renderApp("/portfolio");
    const live = await screen.findByRole("list", { name: "진행 중 계획" });
    expect(within(live).getByRole("link", { name: "SK하이닉스 계획 보기" })).toBeTruthy();
    const section = screen.getByRole("heading", { name: "진행 중 자동매매" }).closest("section")!;
    expect(within(section).getByRole("link", { name: /모두 보기/ }).getAttribute("href")).toBe("/plans");
  });
});
