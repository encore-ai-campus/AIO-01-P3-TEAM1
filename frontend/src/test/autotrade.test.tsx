// AI 추천 → 계획 활성화 → 내 자동매매 → 알림 화면 (가짜 API: src/mocks). 앨리스는 주린이모드 끔(전문가 보기)이다.
// 쉬운 보기(새 계획 제안 → 실행 확인 → 모의 자동매매)와 모의투자 탭은 src/test/trade.test.tsx.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { QueryClient } from "@tanstack/react-query";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";

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

    // '전체': 기한이 지난 추천은 '지금은 활성화할 수 없는 추천'으로 아래에 모이고, 이 필터에서는 펼쳐 둔다 (UX-2)
    fireEvent.click(screen.getByRole("button", { name: "전체" }));
    const blocked = await screen.findByRole("list", { name: "활성화할 수 없는 추천 목록" });
    expect(screen.getByRole("button", { name: "지금은 활성화할 수 없는 추천 1개" }).getAttribute("aria-expanded")).toBe("true");
    const expired = within(blocked).getByRole("link", { name: "삼성전자 추천 보기" });
    expect(within(expired).getByText("만료")).toBeTruthy();
    expect(within(expired).getByText("활성화 불가 · 만료")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "추천 목록" })).getAllByRole("link")).toHaveLength(3);
  });

  it("연습용 예시 계획 만들기: 성공하면 상세로, 서버가 꺼 두었으면(403) 설정 이름 없이 한 줄로 접는다", async () => {
    renderApp("/recommendations");
    fireEvent.change(await screen.findByLabelText("종목 코드 (선택)"), { target: { value: "005380" } });
    fireEvent.click(screen.getByRole("button", { name: "만들기" }));
    expect(await screen.findByRole("heading", { name: "현대차 추천" })).toBeTruthy();
    expect(screen.getByText(/연습용 예시 계획입니다 \(AI 아님\)/)).toBeTruthy();

    db.options.demoEnabled = false;
    renderApp("/recommendations");
    fireEvent.click((await screen.findAllByRole("button", { name: "만들기" })).at(-1)!);
    expect(await screen.findByText("연습용 예시 계획은 지금 꺼져 있습니다 (서버 설정).")).toBeTruthy();
    expect(screen.queryByText(/AUTOTRADE_DEMO/)).toBeNull(); // 개발용 설정 이름은 사용자 문장에 넣지 않는다
    expect(screen.queryAllByRole("button", { name: "만들기" })).toHaveLength(0);
  });

  it.each([
    ["alice", "연습용 예시 계획은 지금 꺼져 있습니다 (서버 설정)."],
    ["bob", "연습용 예시 계획은 지금 만들 수 없어요 (서버에서 꺼 두었어요)."],
  ])("연습용 예시가 꺼져 있으면(403) 사라진 '만들기' 대신 그 한 줄로 포커스가 옮겨 가 읽힌다 (body로 떨어지지 않게) · %s", async (user, line) => {
    db.options.demoEnabled = false;
    renderApp("/recommendations", user);
    if (user === "bob") fireEvent.click(await screen.findByRole("button", { name: /연습용 예시 계획 만들기/ })); // 쉬운 보기는 접혀 있다
    const make = await screen.findByRole("button", { name: "만들기" });
    make.focus();
    fireEvent.click(make);
    const off = await screen.findByText(line);
    await waitFor(() => expect(document.activeElement).toBe(off));
  });

  it("오른쪽 위 칩은 유효 기한(시간 사실), 배지 줄은 계좌와 무관한 사유(blockedBy)로 '활성화 가능'. 목록 제목·필터는 시간 사실만 (UX-2)", async () => {
    renderApp("/recommendations");
    expect(await screen.findByRole("heading", { name: /^유효한 추천/ })).toBeTruthy();
    const list = await screen.findByRole("list", { name: "추천 목록" });
    expect(within(list).getAllByText(/^유효 · \d+(일|시간|분) 남음$/).length).toBeGreaterThan(0);
    expect(within(list).getAllByText("활성화 가능")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "유효" }).getAttribute("aria-pressed")).toBe("true");
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
  it("투자 금액(% 칩 → 금액) → 리스크 미리 보기(종가 기준) → 요약 확인 → 계획 활성화 → 계획 화면 (요청에는 금액 하나만)", async () => {
    const previews: URLSearchParams[] = [];
    const seen: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/preview")) previews.push(url.searchParams);
      if (request.url.endsWith("/activate")) seen.push(await request.clone().json());
    });
    renderApp("/recommendations/91");
    expect(await screen.findByRole("heading", { name: "SK하이닉스 추천" })).toBeTruthy();
    expect(screen.getByRole("figure", { name: "가격 사다리" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /AI 리포트 #1 보기/ }).getAttribute("href")).toBe("/reports/1");
    // 머리 안내: 투자 금액은 내가 정한다 (건당 위험 1%로 수량을 정한다는 말은 없다)
    expect(screen.getByText(/투자 금액은 내가 정하고, 수량 계산과 활성화 가능 여부/)).toBeTruthy();
    expect(screen.queryByText(/건당 위험 1%/)).toBeNull();

    // 기본값이 없다: 정하기 전에는 미리 보기 대신 빈 상태, 버튼은 꺼지고 아래에 안내. 도움말은 매수 가능 금액만
    const preview = screen.getByRole("region", { name: "리스크 미리 보기" });
    expect(within(preview).getByText("투자 금액을 정하면 수량·매수 금액·손절 시 손실을 계산합니다.")).toBeTruthy();
    const button = screen.getByRole("button", { name: "계획 활성화" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("투자 금액을 정하면 활성화할 수 있습니다.")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const help = await screen.findByText(/^매수 가능 금액 [\d,]+원$/);
    const power = Number(help.textContent!.replace(/[^\d]/g, ""));

    // % 칩: 매수 가능 금액의 10%를 원으로 바꿔 보이고, 미리 보기 요청은 budgetPercent 하나
    const methods = screen.getByRole("group", { name: "투자 금액 방식" });
    expect(within(methods).getByRole("button", { name: "내 자금의 %" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    expect(screen.getByRole("button", { name: "10%" }).getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByLabelText("직접 입력 (%)") as HTMLInputElement).value).toBe("10");
    expect(help.textContent).toBe(`매수 가능 금액 ${power.toLocaleString("ko-KR")}원 중 ${Math.floor(power * 0.1).toLocaleString("ko-KR")}원`);
    await within(preview).findByText("리스크 엔진 통과", undefined, { timeout: 3000 });
    expect(within(preview).getByText("3주")).toBeTruthy();
    expect(within(preview).getByText("내가 정한 금액")).toBeTruthy();
    expect(within(preview).getByText(/^\(총자산의 \d+\.\d+%\)$/)).toBeTruthy();
    expect(within(preview).getByText("직전 종가")).toBeTruthy();
    expect(within(preview).getByText(/장마감 기준$/)).toBeTruthy();
    const sized = previews.filter((q) => q.size > 0);
    expect(sized.map((q) => [q.get("budgetPercent"), q.get("budgetKrw")])).toEqual([["10", null]]);

    // 방식을 바꾸면 입력을 비운다 (10이 10원으로 남지 않게) → 다시 정하기 전 상태
    fireEvent.click(within(methods).getByRole("button", { name: "금액(원)" }));
    const amount = screen.getByLabelText("투자 금액 (원)") as HTMLInputElement;
    expect(amount.value).toBe("");
    expect(screen.queryByRole("button", { name: "10%" })).toBeNull();
    expect(within(preview).getByText("투자 금액을 정하면 수량·매수 금액·손절 시 손실을 계산합니다.")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);

    // 금액(원): 쉼표 허용, 미리 보기 요청은 budgetKrw 하나
    fireEvent.change(amount, { target: { value: "1,000,000" } });
    await waitFor(() => expect(within(preview).getByText("5주")).toBeTruthy(), { timeout: 3000 });
    expect(help.textContent).toMatch(/^매수 가능 금액 [\d,]+원 중 1,000,000원 \(\d+\.\d%\)$/);
    expect(previews.filter((q) => q.size > 0).map((q) => [q.get("budgetPercent"), q.get("budgetKrw")]).at(-1)).toEqual([null, "1000000"]);

    // 전문가 보기는 체크 셋(손절 시 손실·보유 기간 끝 매도·AI 제안/모의)을 한 줄 요약 확인으로 켠다
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "위 내용을 확인했습니다" }));
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "SK하이닉스 자동매매" })).toBeTruthy();
    server.events.removeAllListeners();
    expect(seen).toEqual([{ budgetKrw: 1_000_000, acknowledged: true }]); // budgetPercent는 보내지 않는다
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
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    await within(screen.getByRole("region", { name: "리스크 미리 보기" })).findByText("리스크 엔진 통과", undefined, { timeout: 3000 });
    fireEvent.click(screen.getByRole("checkbox", { name: "위 내용을 확인했습니다" }));
    const button = screen.getByRole("button", { name: "계획 활성화" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByRole("heading", { name: "에코프로비엠 자동매매" })).toBeTruthy();
    server.events.removeAllListeners();
    expect(seen).toEqual([{ budgetPercent: 10, token: "demo-92", acknowledged: true }]);
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

  it("활성화할 수 없으면 사유를 보이고 예산·확인·활성화 버튼 대신 다른 추천으로 가는 길 (UX-2)", async () => {
    db.options.halted = true;
    renderApp("/recommendations/93");
    const reasons = await screen.findByRole("list", { name: "활성화할 수 없는 사유" });
    expect(within(reasons).getByText("새 모의 매수가 중단되어 있습니다.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "계획 활성화" })).toBeNull();
    expect(screen.queryByRole("group", { name: "투자 금액 방식" })).toBeNull();
    expect(screen.queryByLabelText("직접 입력 (%)")).toBeNull();
    expect(screen.getByRole("link", { name: /다른 추천 보기/ }).getAttribute("href")).toBe("/recommendations");
  });

  it("만료된 추천은 활성화 대신 안내와 내 계획 보기", async () => {
    renderApp("/recommendations/90");
    expect(await screen.findByText(/유효 기한\(.+\)이 지나 활성화할 수 없습니다/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "계획 활성화" })).toBeNull();
    expect(screen.getByRole("link", { name: /내 계획 보기/ }).getAttribute("href")).toBe("/plans/95");
  });

  it("머리 칩은 안전장치(미리 보기) 결과로 말한다: 통과면 '활성화 가능', 막히면 '활성화 불가'와 그 아래 사유 한 줄(확인 칸은 없다), 진행 중이면 그것", async () => {
    const first = renderApp("/recommendations/91");
    expect(await screen.findByText("활성화 가능")).toBeTruthy();
    first.unmount();

    db.options.halted = true;
    const blocked = renderApp("/recommendations/93");
    expect(await screen.findByText("활성화 불가")).toBeTruthy();
    expect(screen.queryByText("활성화 가능")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // 머리 배지 아래 사유 한 줄 (실행 확인 카드의 사유 목록과 같은 말)
    const head = screen.getByText("NAVER", { selector: "p" }).closest("section")!;
    expect(within(head).getByText("새 모의 매수가 중단되어 있습니다.")).toBeTruthy();
    blocked.unmount();

    db.options.halted = false;
    db.activate(alice(), 92, { budgetPercent: 10 });
    renderApp("/recommendations/92");
    expect(await screen.findByText("진행 중 계획 있음")).toBeTruthy();
  });

  it("손익비 등으로 이 계획 자체가 막히면 시작 버튼 아래에 다른 추천으로 가는 길", async () => {
    db.setPrice("000660", 210_000); // 직전 종가는 그대로 → 장중 확인만 막히는 경우와 구분: 미리 보기는 종가로 본다
    server.use(
      http.get("*/api/recommendations/91/preview", () =>
        HttpResponse.json({ ...db.riskPreview(1, 91, null), approved: false, activatable: false, reasons: ["손익비 부족"], reasonCodes: ["reward_risk_low"] }),
      ),
    );
    renderApp("/recommendations/91");
    const link = await screen.findByRole("link", { name: /다른 추천 보기/ });
    expect(link.getAttribute("href")).toBe("/recommendations");
    expect(screen.queryByRole("button", { name: "계획 활성화" })).toBeNull();
    expect(within(screen.getByRole("list", { name: "활성화할 수 없는 사유" })).getByText("손익비 부족")).toBeTruthy();
  });

  it("리스크 미리 보기를 받지 못하면(503) 머리 칩은 뼈대로 남지 않고 기한으로 돌아가고, 실행 확인 카드에서 다시 받으면 칩도 바뀐다 (trade-r5)", async () => {
    let fail = true;
    server.use(
      http.get("*/api/recommendations/91/preview", () => (fail ? HttpResponse.json({ detail: "증권사 조회를 할 수 없습니다." }, { status: 503 }) : undefined)),
    );
    renderApp("/recommendations/91");
    // 금액을 정하기 전: 금액 없는 미리 보기(머리 칩과 같은 쿼리)의 오류를 실행 확인 카드가 보이고 거기서 다시 받는다
    const preview = await screen.findByRole("region", { name: "리스크 미리 보기" });
    expect(await within(preview).findByText("증권사 조회를 할 수 없습니다.")).toBeTruthy();
    const head = screen.getByText("SK하이닉스", { selector: "p" }).closest("section")!;
    expect(head.querySelector(".skeleton")).toBeNull(); // '불러오는 중'으로 읽히지 않게
    expect(within(head).getByText(/^유효/)).toBeTruthy();
    fail = false;
    fireEvent.click(within(preview).getByRole("button", { name: "다시 시도" }));
    expect(await within(head).findByText("활성화 가능")).toBeTruthy();
    expect(await within(preview).findByText("투자 금액을 정하면 수량·매수 금액·손절 시 손실을 계산합니다.")).toBeTruthy();
    // 금액을 정한 미리 보기가 실패해도 같은 자리에서 다시 받는다
    fail = true;
    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    expect(await within(preview).findByText("증권사 조회를 할 수 없습니다.", undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByLabelText("직접 입력 (%)")).toBeTruthy(); // 입력은 그대로
    fail = false;
    fireEvent.click(within(preview).getByRole("button", { name: "다시 시도" }));
    expect(await within(preview).findByText("리스크 엔진 통과")).toBeTruthy();
  });

  it("손절 시 손실이 총자산 1%를 넘으면 경고 한 줄만 보이고 막지 않는다 (largeLoss)", async () => {
    server.use(
      http.get("*/api/recommendations/91/preview", ({ request }) => {
        const budget = new URL(request.url).searchParams.get("budgetKrw");
        if (!budget) return undefined;
        return HttpResponse.json({ ...db.riskPreview(1, 91, null, budget), largeLoss: true, maxLossRate: 0.0123 });
      }),
    );
    renderApp("/recommendations/91");
    fireEvent.click(await screen.findByRole("button", { name: "금액(원)" }));
    fireEvent.change(screen.getByLabelText("투자 금액 (원)"), { target: { value: "1000000" } });
    expect(await screen.findByText("손절 시 손실이 총자산의 1.2%로 건당 위험 기준 1%를 넘습니다 (경고만, 활성화는 가능).", undefined, { timeout: 3000 })).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "위 내용을 확인했습니다" }));
    await waitFor(() => expect((screen.getByRole("button", { name: "계획 활성화" }) as HTMLButtonElement).disabled).toBe(false));
  });

  it("금액이 한도를 넘어 막혀도(cash_short·total_limit) 입력 블록은 그대로 — 줄이지 않고 사유와 '바꾸면 다시 계산'", async () => {
    renderApp("/recommendations/91");
    fireEvent.click(await screen.findByRole("button", { name: "금액(원)" }));
    const amount = screen.getByLabelText("투자 금액 (원)") as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "50,000,000" } });
    const reasons = await screen.findByRole("list", { name: "활성화할 수 없는 사유" }, { timeout: 3000 });
    expect(within(reasons).getByText(/보다 큼$/)).toBeTruthy(); // cash_short (서버 원문)
    expect(within(reasons).getByText(/^총 금액 한도/)).toBeTruthy();
    expect(screen.getByText("투자 금액을 바꾸면 다시 계산합니다.")).toBeTruthy();
    expect(screen.getByText("리스크 엔진 거절")).toBeTruthy();
    expect(amount.value).toBe("50,000,000");
    expect((screen.getByRole("button", { name: "계획 활성화" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("link", { name: /다른 추천 보기/ })).toBeNull(); // 금액을 고치면 되므로 다른 곳으로 보내지 않는다
    // 금액을 줄이면 다시 계산해 시작할 수 있다
    fireEvent.change(amount, { target: { value: "500000" } });
    expect(await screen.findByText("리스크 엔진 통과", undefined, { timeout: 3000 })).toBeTruthy();
  });

  it("Discord 링크로 열면 띠의 '활성화 카드로 이동'이 실행 확인 제목으로 데려간다 (모바일에서 2,000px 아래)", async () => {
    renderApp("/recommendations/92?t=demo-92");
    fireEvent.click(await screen.findByRole("button", { name: "활성화 카드로 이동" }));
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "계획 활성화" }));
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
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
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

  it("보유 중 계획 중단은 전량 매도 안내 → 청산 완료(사용자 매도)", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
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
    const plan = db.activate(alice(), 92, { budgetPercent: 10 });
    renderApp(`/plans/${plan.id}`);
    const events = await screen.findByRole("list", { name: "계획 사건" });
    await waitFor(() => expect(within(events).getAllByRole("listitem")).toHaveLength(5));
    expect(within(events).getByText(/에코프로비엠 .+ 200,000원에 체결/)).toBeTruthy();
    expect(within(events).getByText(/목표가 도달로 청산 \(225,000원/)).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("청산 완료 · 목표가 도달");
    const kinds = db.listNotifications(1, true).rows.map((n) => n.kind);
    expect(kinds).toEqual(expect.arrayContaining(["plan_activated", "order_placed", "filled", "closed"]));
  });

  it("중단 확인: 처음 포커스는 안전한 '닫기', Esc로 닫으면 계획 중단 버튼으로 돌아간다", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    renderApp(`/plans/${plan.id}`);
    const stop = await screen.findByRole("button", { name: "계획 중단" });
    stop.focus();
    fireEvent.click(stop);
    const dialog = screen.getByRole("dialog", { name: "SK하이닉스 계획을 중단할까요?" });
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "닫기" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(stop);
  });

  it("대화상자가 열린 채 체결되면 문구를 새 상태로 바꾸고 주의를 띄운 뒤 확인 버튼을 잠깐 막는다 (읽은 내용 = 실행되는 내용)", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    const { client } = renderApp(`/plans/${plan.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "계획 중단" }));
    const dialog = screen.getByRole("dialog", { name: "SK하이닉스 계획을 중단할까요?" });
    expect(within(dialog).getByRole("button", { name: "중단하기" })).toBeTruthy();
    db.setPrice("000660", 180_000); // 다음 조회에서 체결된다
    await act(() => client.invalidateQueries({ queryKey: ["plan"] }));
    expect(await within(dialog).findByText(`방금 체결됨 — 이제 중단하면 ${plan.quantity}주 전량 매도`)).toBeTruthy();
    expect(within(dialog).getByText(/보유 수량을 전량 매도합니다/)).toBeTruthy();
    const sell = within(dialog).getByRole("button", { name: "전량 매도하고 중단" }) as HTMLButtonElement;
    expect(sell.disabled).toBe(true);
    await waitFor(() => expect(sell.disabled).toBe(false), { timeout: 2000 });
  });

  it("대화상자가 열린 채 계획이 끝나면(내 주식에서 사는 주문을 취소 등) 닫고 결과를 한 줄로 알린다", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    const { client } = renderApp(`/plans/${plan.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "계획 중단" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    db.cancelOrder(1, plan.orderId!);
    await act(() => client.invalidateQueries({ queryKey: ["plan"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast().textContent).toBe("이미 끝난 계획입니다 · 중단됨");
  });

  it("매도 예약을 내 주식에서 취소하면 '매도 요청됨'에 멈추지 않고 다시 중단할 수 있다 (지금 예약이 있는지로 본다)", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000); // 진입가 아래 → 지정가 체결
    const { client } = renderApp(`/plans/${plan.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "계획 중단" }));
    db.options.marketOpen = { KR: false, US: false }; // 장이 닫혀 있으면 다음 장 시작에 매도를 예약한다
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "전량 매도하고 중단" }));
    const waiting = (await screen.findByRole("button", { name: "매도 요청됨 (청산 대기)" })) as HTMLButtonElement;
    expect(waiting.disabled).toBe(true);

    const sell = db.listReservations(1).find((r) => r.kind === "SELL" && r.orderId === plan.orderId)!;
    db.deleteReservation(1, sell.id);
    await act(() => client.invalidateQueries());
    expect(await screen.findByText("매도 예약이 취소되어 보유 감시를 계속합니다. 다시 중단할 수 있습니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "계획 중단" }) as HTMLButtonElement).disabled).toBe(false);
    // 다음 폴링에서도 예약이 없으면 그대로 둔다 (확인을 다시 하느라 '매도 요청됨'으로 깜빡이지 않는다)
    const flips: string[] = [];
    const watch = new MutationObserver(() => {
      if (document.body.textContent?.includes("매도 요청됨")) flips.push("pending");
    });
    watch.observe(document.body, { subtree: true, childList: true, characterData: true });
    await act(() => client.invalidateQueries({ queryKey: ["reservations"] }));
    await act(() => new Promise((r) => setTimeout(r, 50)));
    watch.disconnect();
    expect(flips).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "계획 중단" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "전량 매도하고 중단" }));
    expect(await screen.findByRole("button", { name: "매도 요청됨 (청산 대기)" })).toBeTruthy();
  });

  // 매도 예약이 사라지는 때는 내가 지울 때만이 아니다: 장이 열리면 엔진이 예약을 먼저 지우고 팔며, 계획은 같은 바퀴의 뒤 단계에서야 청산 완료가 된다
  // (run_engine '예약 실행' → '자동매매'). 예약·계획 조회는 따로 5초마다 받으므로 예약 응답이 먼저 올 수 있다 (trade-r1).
  const stopOutsideHours = async (client: QueryClient, planId: number) => {
    fireEvent.click(await screen.findByRole("button", { name: "계획 중단" }));
    db.options.marketOpen = { KR: false, US: false }; // 장 밖 → 다음 장 시작에 매도 예약
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "전량 매도하고 중단" }));
    await screen.findByRole("button", { name: "매도 요청됨 (청산 대기)" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.listReservations(1).some((r) => r.kind === "SELL" && r.orderId === db.getPlan(1, planId).orderId)).toBe(true);
    // 화면이 예약 목록을 처음 받을 때까지 (그 요청이 끝나기 전에 다시 받으라고 하면 같은 요청으로 합쳐진다)
    await waitFor(() => expect(client.getQueryState(["reservations"])).toMatchObject({ status: "success", fetchStatus: "idle" }));
  };
  /** '취소됨' 안내나 켜진 멈추기 버튼이 한 번이라도 그려졌는지 지켜본다. */
  const watchFalseCancel = () => {
    const seen = new Set<string>();
    const watch = new MutationObserver(() => {
      if (document.body.textContent?.includes("매도 예약이 취소되어")) seen.add("notice");
      if ([...document.querySelectorAll("button")].some((b) => b.textContent?.trim() === "계획 중단")) seen.add("stop");
    });
    watch.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    return () => {
      watch.disconnect();
      return [...seen];
    };
  };

  it("장 시작에 예약 매도가 실행된 순간 예약 조회가 계획 조회보다 먼저 와도 '취소됨'이라 하지 않고 멈추기를 다시 켜지 않는다", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000); // 진입가 아래 → 지정가 체결
    const { client } = renderApp(`/plans/${plan.id}`);
    await stopOutsideHours(client, plan.id);
    await act(() => client.invalidateQueries({ queryKey: ["market"] })); // 장 시작 전에 받은 시장 정보 (닫힘)
    // 서버: 엔진이 예약을 지우고 팔았다. 계획 조회는 '자동매매' 단계 전이라 아직 보유 중 + 매도 요청
    const holding = db.getPlan(1, plan.id);
    server.use(http.get(`*/api/trade-plans/${plan.id}`, () => HttpResponse.json(holding)));
    const gets: string[] = [];
    server.events.on("response:mocked", ({ request }) => {
      if (request.method === "GET") gets.push(new URL(request.url).pathname);
    });
    /** 예약 응답 뒤에 path 응답이 있었는지. */
    const after = (path: string) => {
      const i = gets.indexOf("/api/reservations");
      return i >= 0 && gets.indexOf(path, i + 1) > i;
    };
    db.options.marketOpen = { KR: true, US: false };
    const stop = watchFalseCancel();
    await act(() => client.invalidateQueries({ queryKey: ["reservations"] })); // 두 폴링 중 예약 조회가 먼저
    // 확인하려고 바로 다시 받은 계획(아직 보유 중)과 주문(이미 팔림)까지 기다린다
    await waitFor(() => expect(after("/api/orders") && after(`/api/trade-plans/${plan.id}`)).toBe(true));
    await act(() => new Promise((r) => setTimeout(r, 30)));
    expect(screen.getByRole("button", { name: "매도 요청됨 (청산 대기)" })).toBeTruthy();

    server.resetHandlers(); // '자동매매' 단계가 지나 계획도 청산 완료
    await act(() => client.invalidateQueries({ queryKey: ["plan"] }));
    await waitFor(() => expect(screen.getByRole("note").textContent).toContain("청산 완료 · 사용자 매도"));
    server.events.removeAllListeners();
    expect(stop()).toEqual([]);
  });

  it("내 주식에서 예약 목록을 본 적이 있어도(예약 없음 캐시) 장 밖 멈추기 직후 '취소됨'이 깜빡이지 않는다", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000);
    const { client } = renderApp(`/plans/${plan.id}`);
    await screen.findByRole("button", { name: "계획 중단" });
    await waitFor(() => expect(screen.getAllByText("보유 중").length).toBeGreaterThan(0));
    // 대기 주문·예약 탭을 본 적이 있다 (그때는 예약이 없었다). 예약을 다시 받는 데는 왕복 시간이 걸린다
    await act(() => client.fetchQuery({ queryKey: ["reservations"], queryFn: () => ({ results: [] }) }));
    server.use(
      http.get("*/api/reservations", async () => {
        await delay(150);
        return undefined;
      }),
    );
    const stop = watchFalseCancel();
    fireEvent.click(screen.getByRole("button", { name: "계획 중단" }));
    db.options.marketOpen = { KR: false, US: false };
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "전량 매도하고 중단" }));
    expect(await screen.findByRole("button", { name: "매도 요청됨 (청산 대기)" })).toBeTruthy();
    await act(() => new Promise((r) => setTimeout(r, 300))); // 예약을 다시 받을 때까지
    expect(stop().filter((x) => x === "notice")).toEqual([]);
    expect(screen.getByRole("button", { name: "매도 요청됨 (청산 대기)" })).toBeTruthy();
  });

  it("장이 열려 있을 때는 예약이 한 번 안 보인 것만으로 '취소됨'이라 하지 않는다 (엔진이 실행하는 동안 잠깐 없을 수 있다) — 다음에도 없으면 알린다", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000);
    const { client } = renderApp(`/plans/${plan.id}`);
    await stopOutsideHours(client, plan.id);
    // 시장 정보는 '열림', 예약 목록은 비었다 (엔진이 예약을 지우고 확인 가격을 받는 중). 주문은 아직 보유 중이다
    const status = db.marketStatus();
    server.use(
      http.get("*/api/market", () => HttpResponse.json({ ...status, markets: status.markets.map((m) => (m.market === "KR" ? { ...m, isOpen: true } : m)) })),
      http.get("*/api/reservations", () => HttpResponse.json({ results: [] })),
    );
    await act(() => client.invalidateQueries({ queryKey: ["market"] }));
    const stop = watchFalseCancel();
    await act(() => client.invalidateQueries({ queryKey: ["reservations"] }));
    await act(() => new Promise((r) => setTimeout(r, 100))); // 확인용 계획·주문 다시 받기까지
    expect(stop()).toEqual([]);
    // 다음 폴링에서도 없으면(엔진이 끝내 실행하지 못하고 지웠거나 장중에 직접 지움) 보유 감시를 계속한다고 알린다
    await act(() => client.invalidateQueries({ queryKey: ["reservations"] }));
    expect(await screen.findByText("매도 예약이 취소되어 보유 감시를 계속합니다. 다시 중단할 수 있습니다.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "계획 중단" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("대화상자를 닫아 둔 사이 체결됐으면 처음 열 때는 주의·잠금 없이 지금 상태(전량 매도) 문구로 연다 (주의는 열린 동안 바뀐 때만)", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    const { client } = renderApp(`/plans/${plan.id}`);
    await screen.findByRole("button", { name: "계획 중단" });
    db.setPrice("000660", 180_000); // 다음 조회에서 체결된다 (대화상자를 열기 전)
    await act(() => client.invalidateQueries({ queryKey: ["plan"] }));
    expect(await screen.findByText(`중단하면 보유 ${plan.quantity}주를 전량 매도합니다.`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "계획 중단" }));
    const dialog = screen.getByRole("dialog", { name: "SK하이닉스 계획을 중단할까요?" });
    expect(within(dialog).getByText(/보유 수량을 전량 매도합니다/)).toBeTruthy();
    expect(within(dialog).queryByText(/방금 체결됨/)).toBeNull();
    expect((within(dialog).getByRole("button", { name: "전량 매도하고 중단" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("중단 요청이 실패했는데 그사이 계획이 끝났으면(서버 '이미 끝난 계획') 대화상자를 닫고 결과를 한 줄로 알린다", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    const { client } = renderApp(`/plans/${plan.id}`);
    fireEvent.click(await screen.findByRole("button", { name: "계획 중단" }));
    const dialog = screen.getByRole("dialog", { name: "SK하이닉스 계획을 중단할까요?" });
    db.cancelOrder(1, plan.orderId!); // 화면이 모르는 사이 서버에서 끝난다
    fireEvent.click(within(dialog).getByRole("button", { name: "중단하기" }));
    expect(await within(dialog).findByText("이미 끝난 계획입니다.")).toBeTruthy();
    await act(() => client.invalidateQueries({ queryKey: ["plan"] }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toast().textContent).toBe("이미 끝난 계획입니다 · 중단됨");
  });

  it("중단 요청이 실패한 안내는 대화상자를 다시 열면 남아 있지 않다", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    server.use(http.post(`*/api/trade-plans/${plan.id}/cancel`, () => HttpResponse.json({ detail: "잠시 뒤 다시 시도해 주세요." }, { status: 503 })));
    renderApp(`/plans/${plan.id}`);
    const stop = await screen.findByRole("button", { name: "계획 중단" });
    fireEvent.click(stop);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "중단하기" }));
    expect(await within(screen.getByRole("dialog")).findByText("잠시 뒤 다시 시도해 주세요.")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(stop);
    await waitFor(() => expect(within(screen.getByRole("dialog")).queryByText("잠시 뒤 다시 시도해 주세요.")).toBeNull());
  });
});

describe("알림", () => {
  it("헤더 종에 안 읽은 수, 누르면 읽음 + 이동 (화면을 옮기는 알림은 링크)", async () => {
    renderApp("/notifications");
    const bells = await screen.findAllByRole("link", { name: "알림 (안 읽은 알림 2개)" });
    expect(bells.length).toBeGreaterThan(0);
    const list = await screen.findByRole("list", { name: "알림 목록" });
    expect(within(list).getAllByText("안 읽음")).toHaveLength(2); // 홈 최근 알림과 같은 이름의 표시
    fireEvent.click(within(list).getByRole("link", { name: "안 읽음: SK하이닉스 AI 추천" }));
    expect(await screen.findByRole("heading", { name: "SK하이닉스 추천" })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByRole("link", { name: "알림 (안 읽은 알림 1개)" }).length).toBeGreaterThan(0));
  });

  it("모두 읽음: 목록·종 배지가 함께 바로 바뀌고, 버튼이 사라지면 포커스는 이웃한 알림 설정으로", async () => {
    renderApp("/notifications");
    const button = await screen.findByRole("button", { name: "모두 읽음" });
    button.focus();
    fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByRole("link", { name: "알림" }).length).toBeGreaterThan(0));
    expect(screen.queryByText("안 읽음")).toBeNull();
    expect(screen.queryByRole("button", { name: "모두 읽음" })).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("알림 설정");
    await waitFor(() => expect(toast().textContent).toContain("알림을 모두 읽었어요."));
  });

  it("읽음 처리에 실패하면 되돌리고 서버 사유를 알린다", async () => {
    server.use(http.post("*/api/notifications/read", () => HttpResponse.json({ detail: "잠시 뒤 다시 시도해 주세요." }, { status: 503 })));
    renderApp("/notifications");
    fireEvent.click(await screen.findByRole("button", { name: "모두 읽음" }));
    await waitFor(() => expect(toast().textContent).toContain("잠시 뒤 다시 시도해 주세요."));
    expect(within(screen.getByRole("list", { name: "알림 목록" })).getAllByText("안 읽음")).toHaveLength(2);
    expect(screen.getAllByRole("link", { name: "알림 (안 읽은 알림 2개)" }).length).toBeGreaterThan(0);
  });

  /** 읽음 요청을 받는 가짜 서버: n번째 요청을 늦게 처리하거나 실패시킨다. */
  const readServer = (handle: (n: number) => Promise<"ok" | "fail">) => {
    let n = 0;
    server.use(
      http.post("*/api/notifications/read", async ({ request }) => {
        const body = (await request.json()) as { ids?: number[]; all?: boolean };
        n += 1;
        if ((await handle(n)) === "fail") return HttpResponse.json({ detail: "잠시 뒤 다시 시도해 주세요." }, { status: 503 });
        db.markRead(1, body);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    return () => n;
  };

  it("연달아 읽어도 앞 요청의 다시 받기가 뒤 알림을 '안 읽음'으로 되돌리지 않는다 (다시 받기는 마지막 읽음 요청이 끝날 때 한 번)", async () => {
    const calls = readServer(async (n) => {
      if (n === 2) await delay(300); // 둘째 요청은 서버에서 늦게 처리된다
      return "ok";
    });
    renderApp("/notifications");
    const list = await screen.findByRole("list", { name: "알림 목록" });
    const count = () => within(list).queryAllByText("안 읽음").length;
    expect(count()).toBe(2);
    const timeline = [count()];
    const watch = new MutationObserver(() => {
      if (timeline.at(-1) !== count()) timeline.push(count());
    });
    watch.observe(list, { subtree: true, childList: true, characterData: true });
    // 새 탭으로 열기(⌘+클릭): 화면은 그대로이고 읽음만 보낸다
    fireEvent.click(within(list).getByRole("link", { name: "안 읽음: SK하이닉스 AI 추천" }), { metaKey: true });
    fireEvent.click(within(list).getByRole("link", { name: "안 읽음: NAVER 시연용 추천" }), { metaKey: true });
    await waitFor(() => expect(calls()).toBe(2));
    await act(() => new Promise((r) => setTimeout(r, 500))); // 둘째 요청과 마지막 다시 받기까지
    watch.disconnect();
    expect(timeline.at(-1)).toBe(0);
    expect(timeline.every((c, i) => i === 0 || c < timeline[i - 1])).toBe(true); // 줄기만 한다 (2 → 1 → 0)
  });

  it("연달아 읽다 앞 요청이 실패해도 뒤에 읽은 알림은 읽음 그대로, 다 끝나면 서버 값으로 맞춘다 (실패한 앞 알림만 다시 안 읽음)", async () => {
    readServer(async (n) => {
      if (n === 1) return "fail";
      await delay(200);
      return "ok";
    });
    renderApp("/notifications");
    const list = await screen.findByRole("list", { name: "알림 목록" });
    fireEvent.click(within(list).getByRole("link", { name: "안 읽음: SK하이닉스 AI 추천" }), { metaKey: true });
    fireEvent.click(within(list).getByRole("link", { name: "안 읽음: NAVER 시연용 추천" }), { metaKey: true });
    await waitFor(() => expect(toast().textContent).toContain("잠시 뒤 다시 시도해 주세요."));
    expect(within(list).queryByRole("link", { name: "안 읽음: NAVER 시연용 추천" })).toBeNull(); // 뒤 요청의 읽음을 지우지 않는다
    expect(await within(list).findByRole("link", { name: "안 읽음: SK하이닉스 AI 추천" })).toBeTruthy();
    expect(within(list).queryByRole("link", { name: "안 읽음: NAVER 시연용 추천" })).toBeNull();
    expect(within(list).getAllByText("안 읽음")).toHaveLength(1);
  });
});

describe("알림 설정 (My Page)", () => {
  it("Webhook 미설정: Discord 묶음은 접고 '지금은 웹 알림으로만 와요' 한 줄. 펼치면 ID 검증 메시지, 저장, 테스트 알림 (UX-14)", async () => {
    renderApp("/my");
    expect(await screen.findByText("지금은 웹 알림으로만 와요.")).toBeTruthy();
    expect(screen.queryByRole("switch", { name: /Discord로도 받기/ })).toBeNull();
    expect(screen.queryByLabelText("Discord 사용자 ID")).toBeNull();
    expect(screen.queryByRole("button", { name: "테스트 알림 보내기" })).toBeNull();
    const more = screen.getByRole("button", { name: /Discord 알림 설정/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    // 경고 상자 대신 스위치 설명 줄 (설명은 스위치에 이어 읽힌다)
    const sw = await screen.findByRole("switch", { name: /Discord로도 받기/ });
    expect(sw.getAttribute("aria-describedby")).toBe("discord-help");
    expect(document.getElementById("discord-help")?.textContent).toBe("지금은 서버 설정 전이라 웹으로만 와요.");
    const input = screen.getByLabelText("Discord 사용자 ID");
    fireEvent.change(input, { target: { value: "12345" } });
    fireEvent.blur(input);
    expect((await screen.findByRole("alert")).textContent).toBe("Discord 사용자 ID는 숫자 17~20자리입니다 (지금 5자리).");

    fireEvent.change(input, { target: { value: "123456789012345678" } });
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(toast().textContent).toContain("Discord 사용자 ID를 저장했어요"));
    expect(db.notificationSettings(1).discordUserId).toBe("123456789012345678");

    const toggle = screen.getByRole("switch", { name: /Discord로도 받기/ });
    toggle.focus();
    fireEvent.click(toggle);
    await waitFor(() => expect(db.notificationSettings(1).discordEnabled).toBe(false));
    // Discord를 끄면 ID 칸은 접힌다 (켰을 때만 쓰는 세부)
    await waitFor(() => expect(screen.queryByLabelText("Discord 사용자 ID")).toBeNull());
    expect(document.activeElement).toBe(toggle); // 저장 뒤에도 같은 스위치에 포커스가 남는다 (다시 그리지 않는다)

    fireEvent.click(screen.getByRole("button", { name: "테스트 알림 보내기" }));
    await waitFor(() => expect(toast().textContent).toContain("서버에 Discord Webhook이 없어 Discord로는 보내지 않았습니다."));
  });

  it("ID를 Enter로 저장해도 입력 칸을 다시 그리지 않아 포커스가 남고, 칸은 저장된 값(앞뒤 공백 없이)으로 맞춘다", async () => {
    db.options.webhookConfigured = true;
    renderApp("/my");
    const input = (await screen.findByLabelText("Discord 사용자 ID")) as HTMLInputElement;
    input.focus();
    fireEvent.change(input, { target: { value: " 123456789012345678 " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(toast().textContent).toContain("Discord 사용자 ID를 저장했어요"));
    expect(db.notificationSettings(1).discordUserId).toBe("123456789012345678");
    expect(screen.getByLabelText("Discord 사용자 ID")).toBe(input);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("123456789012345678");
  });

  it("Webhook이 있으면 '웹 알림은 항상 남아요', 'ID 찾는 법'은 접혀 있다", async () => {
    db.options.webhookConfigured = true;
    renderApp("/my");
    await screen.findByRole("switch", { name: /Discord로도 받기/ });
    expect(document.getElementById("discord-help")?.textContent).toBe("웹 알림은 항상 남아요.");
    const how = screen.getByText("ID 찾는 법").closest("details")!;
    expect(how.open).toBe(false);
  });
});

describe("다른 화면과 잇기", () => {
  it("홈에 AI 추천 요약과 진행 중 자동매매", async () => {
    db.activate(alice(), 91, { budgetPercent: 10 });
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

  it("출처의 추천이 모두 기한이 지났으면 강조 없이 접힌 한 줄, 눌러 펼친다 (기한이 남은 추천이 있을 때만 강조)", async () => {
    renderApp("/analyses/5"); // 분석 5: 기한이 남은 추천(92)
    const open = (await screen.findByRole("heading", { name: "이 분석의 AI 추천 → 계획 활성화" })).closest("section")!;
    expect(open.className).toContain("ring-2");
    cleanup();

    renderApp("/analyses/1"); // 분석 1: 만료된 추천(90)만
    const card = (await screen.findByRole("heading", { name: "이 분석의 AI 추천 → 계획 활성화" })).closest("section")!;
    expect(card.className).not.toContain("ring-2");
    expect(within(card).queryByRole("link", { name: "삼성전자 추천 보기" })).toBeNull();
    const more = within(card).getByRole("button", { name: "1개 · 만료" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(within(card).getByRole("link", { name: "삼성전자 추천 보기" }).getAttribute("href")).toBe("/recommendations/90");
  });

  it("모의투자 탭 위쪽에 진행 중 자동매매와 전체 보기 링크", async () => {
    db.activate(alice(), 91, { budgetPercent: 10 });
    renderApp("/portfolio");
    const live = await screen.findByRole("list", { name: "진행 중 계획" });
    expect(within(live).getByRole("link", { name: "SK하이닉스 계획 보기" })).toBeTruthy();
    const section = screen.getByRole("heading", { name: "진행 중 자동매매" }).closest("section")!;
    expect(within(section).getByRole("link", { name: /모두 보기/ }).getAttribute("href")).toBe("/plans");
  });

  it("내 주식: 자동매매에 묶인 대기 주문은 '취소' 대신 계획 보기 (바로 취소하면 계획까지 끝나므로), 일반 주문은 그대로 취소", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    renderApp("/portfolio?tab=orders");
    const link = await screen.findByRole("link", { name: "SK하이닉스 자동매매 계획 보기" });
    expect(link.getAttribute("href")).toBe(`/plans/${plan.id}`);
    expect(screen.queryByRole("button", { name: "SK하이닉스 주문 취소" })).toBeNull();
    expect(screen.getByText(`자동매매 #${plan.id}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: "카카오 주문 취소" })).toBeTruthy();
  });

  it("내 주식: 다른 탭·기기에서 막 시작한 계획의 사는 주문은 주문 목록이 계획 목록보다 먼저 와도 '취소'를 보이지 않고, 확인한 뒤 '계획 보기'로 (trade-r2)", async () => {
    const { client } = renderApp("/portfolio?tab=orders");
    expect(await screen.findByRole("button", { name: "카카오 주문 취소" })).toBeTruthy();
    // 계획 목록을 다시 받는 데는 왕복 시간이 걸린다
    server.use(
      http.get("*/api/trade-plans", async () => {
        await delay(150);
        return undefined;
      }),
    );
    const shown: string[] = [];
    const watch = new MutationObserver(() => {
      if (document.querySelector('[aria-label="SK하이닉스 주문 취소"]')) shown.push("cancel");
    });
    watch.observe(document.body, { subtree: true, childList: true, attributes: true });
    const plan = db.activate(alice(), 91, { budgetPercent: 10 }); // 화면 밖(다른 탭·Discord 링크)에서 시작
    await act(() => client.invalidateQueries({ queryKey: ["orders"] })); // 5초 폴링 둘 중 주문 목록이 먼저
    const checking = (await screen.findByRole("button", { name: "SK하이닉스 주문 확인 중" })) as HTMLButtonElement;
    expect(checking.disabled).toBe(true);
    const link = await screen.findByRole("link", { name: "SK하이닉스 자동매매 계획 보기" });
    expect(link.getAttribute("href")).toBe(`/plans/${plan.id}`);
    watch.disconnect();
    expect(shown).toEqual([]);
    expect(screen.getByRole("button", { name: "카카오 주문 취소" })).toBeTruthy(); // 처음부터 있던 일반 주문은 그대로
  });

  it("내 주식: '취소'를 누른 순간 계획 목록을 다시 받아, 계획의 주문이면 취소하지 않고 '계획 보기'로 안내한다 (확인 없이 계획이 끝나지 않게)", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    let stale = true; // 처음 받은 계획 목록이 이 계획을 모른다 (다른 화면이 남긴 오래된 목록 등)
    server.use(http.get("*/api/trade-plans", () => (stale ? HttpResponse.json({ count: 0, results: [] }) : undefined)));
    renderApp("/portfolio?tab=orders");
    const cancel = await screen.findByRole("button", { name: "SK하이닉스 주문 취소" });
    stale = false;
    cancel.focus();
    fireEvent.click(cancel);
    const link = await screen.findByRole("link", { name: "SK하이닉스 자동매매 계획 보기" });
    await waitFor(() => expect(document.activeElement).toBe(link));
    expect(toast().textContent).toContain("자동매매 계획의 진입 주문입니다. 계획 화면에서 중단하세요.");
    expect(db.getPlan(1, plan.id).status).toBe("entry_pending");
    expect(db.listOrders(1, "all").find((o) => o.id === plan.orderId)?.status).toBe("ENTRY_PENDING");
  });

  it("내 주식: 자동매매의 매도 예약 취소는 확인을 거친다 — 취소하면 계획은 보유 감시를 계속하고, 포커스는 예약 목록 제목으로", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000); // 진입가 아래 → 다음 조회에서 체결
    db.getPlan(1, plan.id);
    db.options.marketOpen = { KR: false, US: false }; // 장이 닫혀 있으면 멈추기가 다음 장 시작 매도 예약이 된다
    db.cancelPlan(1, plan.id);
    renderApp("/portfolio?tab=orders");
    expect(await screen.findByText(`자동매매 #${plan.id} 매도`)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "SK하이닉스 예약 취소" }));
    const dialog = screen.getByRole("dialog", { name: "매도 예약을 취소할까요?" });
    expect(within(dialog).getByText(new RegExp(`자동매매 #${plan.id}는 보유 감시를 계속합니다`))).toBeTruthy();
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "닫기" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "예약 취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await screen.findByText("예약된 주문이 없습니다.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "예약 (다음 정규장 시작에 실행)" })));
    expect(db.getPlan(1, plan.id).status).toBe("holding");
  });

  it("내 주식: 대기 주문을 취소하면 사라진 행 대신 같은 자리의 다음 행(마지막 행이면 앞 행, 혼자였으면 목록 제목)으로 포커스 — 보내는 동안에도 누른 버튼에 남고 다시 눌러도 한 번만 (a11y-11)", async () => {
    const u = alice();
    for (const symbol of ["005380", "105560"]) db.placeOrder(u.id, { symbol, quantity: 1, orderType: "LIMIT", limitPrice: 1_000, targetPrice: 1_100, stopPrice: 900 });
    let calls = 0;
    server.use(
      http.post("*/api/orders/:id/cancel", async () => {
        calls++;
        await delay(60);
        return undefined;
      }),
    );
    renderApp("/portfolio?tab=orders");
    const title = await screen.findByRole("heading", { name: "체결 대기 주문" });
    await screen.findAllByRole("button", { name: /주문 취소$/ });
    const rows = within(title.closest("section")!).getAllByRole("listitem");
    expect(rows).toHaveLength(3);
    const [first, second, third] = rows;
    const cancelOf = (row: HTMLElement) => within(row).getByRole("button", { name: /주문 취소$/ });

    const c1 = cancelOf(first);
    c1.focus();
    fireEvent.click(c1);
    expect(c1.getAttribute("aria-disabled")).toBe("true"); // 계획 목록을 다시 확인하는 동안부터: disabled가 아니라 포커스가 남는다
    expect((c1 as HTMLButtonElement).disabled).toBe(false);
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.click(c1); // 보내는 동안 다시 눌러도 무시
    expect(document.activeElement).toBe(c1);
    await waitFor(() => expect(first.isConnected).toBe(false));
    expect(calls).toBe(1);
    expect(document.activeElement).toBe(second); // 같은 자리로 올라온 다음 행 (행이라 Enter를 또 눌러도 다른 주문이 취소되지 않는다)

    const c3 = cancelOf(third);
    c3.focus();
    fireEvent.click(c3);
    await waitFor(() => expect(third.isConnected).toBe(false));
    expect(document.activeElement).toBe(second); // 마지막 행이면 앞 행

    const c2 = cancelOf(second);
    c2.focus();
    fireEvent.click(c2);
    expect(await screen.findByText("체결 대기 중인 주문이 없습니다.")).toBeTruthy();
    expect(document.activeElement).toBe(title); // 혼자였으면 목록 제목
  });

  it("내 주식: 예약을 취소해도 같은 규칙 — 사라진 행 대신 이웃 행, 혼자였으면 예약 목록 제목으로 포커스 (a11y-11)", async () => {
    const u = alice();
    db.options.marketOpen = { KR: false, US: false }; // 장 밖 시장가 주문은 다음 정규장 시작 예약이 된다
    for (const symbol of ["005380", "105560"]) db.placeOrder(u.id, { symbol, quantity: 1, orderType: "MARKET" });
    renderApp("/portfolio?tab=orders");
    const title = await screen.findByRole("heading", { name: "예약 (다음 정규장 시작에 실행)" });
    await screen.findAllByRole("button", { name: /예약 취소$/ });
    const [first, second] = within(title.closest("section")!).getAllByRole("listitem");
    const c1 = within(first).getByRole("button", { name: /예약 취소$/ });
    c1.focus();
    fireEvent.click(c1);
    await waitFor(() => expect(first.isConnected).toBe(false));
    expect(document.activeElement).toBe(second);
    const c2 = within(second).getByRole("button", { name: /예약 취소$/ });
    c2.focus();
    fireEvent.click(c2);
    expect(await screen.findByText("예약된 주문이 없습니다.")).toBeTruthy();
    expect(document.activeElement).toBe(title);
  });

  it("내 주식: 확인 시트로 자동매매의 매도 예약을 취소해도 시트가 닫힌 뒤 사라진 행 대신 이웃 행으로 포커스 (a11y-11)", async () => {
    const plan = db.activate(alice(), 91, { budgetPercent: 10 });
    db.setPrice("000660", 180_000); // 진입가 아래 → 다음 조회에서 체결
    db.getPlan(1, plan.id);
    db.options.marketOpen = { KR: false, US: false }; // 장이 닫혀 있으면 멈추기가 다음 장 시작 매도 예약이 된다
    db.cancelPlan(1, plan.id);
    const price = db.quotes(["005380"])[0].price!;
    // 다른 예약 하나 더 (스윙: 장기 보유는 총 금액 한도를 먼저 따진다)
    db.placeOrder(1, { symbol: "005380", quantity: 1, orderType: "MARKET", targetPrice: Math.round(price * 1.1), stopPrice: Math.round(price * 0.9) });
    renderApp("/portfolio?tab=orders");
    const cancel = await screen.findByRole("button", { name: "SK하이닉스 예약 취소" });
    const other = screen.getByRole("button", { name: "현대차 예약 취소" }).closest("li")!;
    cancel.focus();
    fireEvent.click(cancel);
    const dialog = screen.getByRole("dialog", { name: "매도 예약을 취소할까요?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "예약 취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.queryByRole("button", { name: "SK하이닉스 예약 취소" })).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(other));
  });
});
