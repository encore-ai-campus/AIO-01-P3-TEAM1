// 시연용 수동 시작 (2026-10-12, DECISIONS 31장 — docs/API.md manualStart): 손익비·기대값으로만 막힌 계획을 '수동매매 (시연용)'으로 시작한다.
// 매매 계획 카드(쉬운 보기 리포트) · 실행 확인 ?manual=1 (쉬운·전문가, 뒤로 갔다 다시 들어오면 확인을 다시 받기, Discord 링크 ?t=) · 자격이 없을 때
// (자격은 blockedBy가 아니라 금액 없는 미리 보기로) · 계획 화면 (쉬운·전문가) · 목록·홈·내 주식(주문·보유) 표시. 가짜 API(src/mocks).
// 밥은 쉬운 보기이고 보유·주문이 없다. 앨리스는 전문가 보기이고 005930 보유·035720 대기 주문이 있어 그 종목은 position_exists로 자격이 없다.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Providers } from "../App";
import { PlanCard, type PlanCardProps } from "../components/plan/PlanCard";
import { MANUAL_START_TEXT, REASON_TEXT } from "../lib/plainText";
import { createQueryClient } from "../lib/queryClient";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";

const userOf = (username: string) => {
  db.setSession(username);
  return db.sessionUser()!;
};

function renderCard(props: PlanCardProps, user = "bob") {
  db.setSession(user);
  return render(
    <MemoryRouter>
      <Providers client={createQueryClient({ retry: false })}>
        <PlanCard {...props} />
      </Providers>
    </MemoryRouter>,
  );
}

const report = (patch: Partial<PlanCardProps["report"]> = {}): PlanCardProps["report"] => ({
  id: 1,
  symbol: "000660",
  name: "SK하이닉스",
  market: "KR",
  status: "completed",
  opinion: "buy",
  finishedAt: new Date(Date.now() - 3_600_000).toISOString(),
  ...patch,
});

/** 손익비·기대값으로만 막히는 추천 (손익비 약 0.4, 확률 0.5라 기대값도 음수). 새 번호를 돌려준다. */
const lowRec = (symbol = "005930") => db.addRecommendation({ symbol, entryPrice: 71_000, targetPrice: 72_000, stopPrice: 69_000 });
/** 리포트 #1(SK하이닉스)의 손익비가 낮은 새 추천 — 매매 계획 카드가 고른다 (열린 것 중 최신). */
const lowReportRec = () => db.addRecommendation({ symbol: "000660", entryPrice: 181_000, targetPrice: 183_000, stopPrice: 173_000, source: "report", sourceId: 1 });

describe("매매 계획 카드의 수동매매 (시연용)", () => {
  it("실행 불가가 손익비·기대값뿐이면 사유 아래에 시연용 안내와 '수동매매 (시연용)' → 실행 확인 ?manual=1", async () => {
    const id = lowReportRec();
    renderCard({ report: report() });
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("blocked"));
    expect(within(card).getByRole("list", { name: "실행할 수 없는 이유" })).toBeTruthy(); // 안전장치 판정은 그대로 보인다
    expect(within(card).getByText(MANUAL_START_TEXT.cardNote.easy)).toBeTruthy();
    expect(within(card).getByRole("link", { name: /수동매매/ }).getAttribute("href")).toBe(`/recommendations/${id}?manual=1`);
  });

  it("다른 사유가 섞이면(같은 종목 진행 중 계획) 수동매매를 보이지 않는다", async () => {
    lowReportRec();
    db.activate(userOf("bob"), 91, { budgetPercent: 10 }); // 같은 000660
    renderCard({ report: report() });
    const card = await screen.findByRole("region", { name: "매매 계획" });
    await waitFor(() => expect(card.getAttribute("data-state")).toBe("blocked"));
    expect(within(within(card).getByRole("list", { name: "실행할 수 없는 이유" })).getByText(REASON_TEXT.plan_exists)).toBeTruthy();
    expect(within(card).queryByRole("link", { name: /수동매매/ })).toBeNull();
    expect(within(card).queryByText(MANUAL_START_TEXT.cardNote.easy)).toBeNull();
  });
});

describe("실행 확인 ?manual=1 (시연용 수동 시작)", () => {
  it("쉬운 보기: 막힌 화면의 링크 → 건너뛰는 안전장치 · 넣을 돈 · 확인 넷 · 경고색 시작 → 계획 화면 (manualStart는 그때만 보낸다)", async () => {
    db.options.planStepMs = 60_000; // 테스트 동안 체결로 넘어가지 않게
    const id = lowRec();
    const previews: URLSearchParams[] = [];
    const seen: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/preview")) previews.push(url.searchParams);
      if (url.pathname.endsWith("/activate")) seen.push(await request.clone().json());
    });
    renderApp(`/recommendations/${id}`, "bob");
    // 평소 막힌 화면: 이유 + 수동매매 링크 줄 (금액 없는 미리 보기의 사유가 손익비·기대값뿐이라)
    const link = await screen.findByRole("link", { name: MANUAL_START_TEXT.button });
    expect(link.getAttribute("href")).toBe(`/recommendations/${id}?manual=1`);
    expect(screen.getByRole("list", { name: "시작할 수 없는 이유" })).toBeTruthy();
    expect(screen.getByText(MANUAL_START_TEXT.linkHint.easy)).toBeTruthy();

    fireEvent.click(link);
    expect(await screen.findByText(MANUAL_START_TEXT.banner.easy)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "건너뛰는 안전장치" })).getByText(REASON_TEXT.reward_risk_low)).toBeTruthy();
    expect(screen.getByText(MANUAL_START_TEXT.topNote.easy, { exact: false })).toBeTruthy();
    expect(screen.getByText("지금은 시작할 수 없음")).toBeTruthy(); // 머리 칩은 안전장치 판정 그대로
    expect(screen.getByRole("heading", { name: "실행 확인" })).toBeTruthy();
    const start = screen.getByRole("button", { name: MANUAL_START_TEXT.start.easy }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(screen.getByText("넣을 돈을 먼저 정해 주세요.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    const box = screen.getByRole("region", { name: "이 금액으로 사는 수량" });
    expect(await within(box).findByText(/^이 금액으로/, undefined, { timeout: 3000 })).toBeTruthy();
    const checks = screen.getAllByRole("checkbox");
    expect(checks).toHaveLength(4);
    expect(screen.getByLabelText(MANUAL_START_TEXT.check)).toBeTruthy();
    expect(screen.getByText(MANUAL_START_TEXT.checksHint)).toBeTruthy();
    for (const c of checks.slice(0, 3)) fireEvent.click(c);
    expect(start.disabled).toBe(true); // 넷 다 켜야 한다
    fireEvent.click(checks[3]);
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);

    expect(await screen.findByRole("heading", { name: "삼성전자 모의 자동매매" })).toBeTruthy();
    server.events.removeAllListeners();
    expect(screen.getByText(MANUAL_START_TEXT.badge)).toBeTruthy();
    expect(screen.getByText(MANUAL_START_TEXT.planNote.easy)).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "계획 사건" })).getByText(/^시연용으로 모의 자동매매를 직접 시작했어요/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain(`${MANUAL_START_TEXT.toast}삼성전자 모의 자동매매를 시작했어요`));
    // 요청: 수동 미리 보기는 금액과 함께만, 금액 없는 미리 보기(머리 칩)에는 manualStart가 없다
    const manualPreviews = previews.filter((q) => q.get("manualStart") === "1");
    expect(manualPreviews.length).toBeGreaterThan(0);
    for (const q of manualPreviews) expect(q.get("budgetPercent")).toBe("10");
    for (const q of previews.filter((x) => !x.has("budgetPercent") && !x.has("budgetKrw"))) expect(q.has("manualStart")).toBe(false);
    expect(seen).toEqual([{ budgetPercent: 10, acknowledged: true, manualStart: true }]);
  });

  it("전문가 보기: 제목은 그대로, 건너뛰는 점검 원문 · '기준 미달 — 건너뜀' · 요약 확인 끝 줄 → '수동매매 활성화 (시연용)'", async () => {
    const id = db.addRecommendation({ symbol: "105560", entryPrice: 84_000, targetPrice: 85_000, stopPrice: 82_000 });
    renderApp(`/recommendations/${id}?manual=1`);
    expect(await screen.findByText(MANUAL_START_TEXT.banner.expert)).toBeTruthy();
    expect(screen.getByRole("heading", { name: "계획 활성화" })).toBeTruthy();
    expect(screen.getByRole("list", { name: "건너뛰는 점검" })).toBeTruthy();
    expect(screen.getByText(MANUAL_START_TEXT.topNote.expert, { exact: false })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    expect(await screen.findByText(MANUAL_START_TEXT.previewSkipped, undefined, { timeout: 3000 })).toBeTruthy();
    expect(screen.queryByText("리스크 엔진 거절")).toBeNull();
    expect(screen.getByText(MANUAL_START_TEXT.expertCheck)).toBeTruthy();
    const start = screen.getByRole("button", { name: MANUAL_START_TEXT.start.expert }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "위 내용을 확인했습니다" }));
    await waitFor(() => expect(start.disabled).toBe(false));
  });

  it("확인 넷을 켠 뒤 뒤로 갔다가 다시 '수동매매 (시연용)'으로 들어오면 확인을 다시 받는다 (빈 칸 아래에서 시작 버튼이 켜지지 않게)", async () => {
    const id = lowRec();
    const seen: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/activate")) seen.push(await request.clone().json());
    });
    renderApp(`/recommendations/${id}`, "bob");
    fireEvent.click(await screen.findByRole("link", { name: MANUAL_START_TEXT.button }));
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    expect(await within(screen.getByRole("region", { name: "이 금액으로 사는 수량" })).findByText(/^이 금액으로/, undefined, { timeout: 3000 })).toBeTruthy();
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = () => screen.getByRole("button", { name: MANUAL_START_TEXT.start.easy }) as HTMLButtonElement;
    await waitFor(() => expect(start().disabled).toBe(false));

    // 뒤로 가면 평소 막힌 화면(확인 칸이 빠진다). 같은 주소라 화면은 새로 그려지지 않고 넣을 돈(10%)은 남는다
    fireEvent.click(screen.getByRole("button", { name: "뒤로 가기" }));
    fireEvent.click(await screen.findByRole("link", { name: MANUAL_START_TEXT.button }));
    expect(await screen.findByText(MANUAL_START_TEXT.banner.easy)).toBeTruthy();
    const checks = (await screen.findAllByRole("checkbox")) as HTMLInputElement[];
    expect(checks).toHaveLength(4);
    expect(checks.map((c) => c.checked)).toEqual([false, false, false, false]);
    expect(start().disabled).toBe(true);
    expect(screen.getByText(MANUAL_START_TEXT.checksHint)).toBeTruthy();
    fireEvent.click(start());
    for (const c of checks) fireEvent.click(c);
    await waitFor(() => expect(start().disabled).toBe(false)); // 다시 넷을 켜면 시작할 수 있다
    server.events.removeAllListeners();
    expect(seen).toEqual([]);
  });

  it("일반 실행 확인도 같은 규칙: 확인 셋을 켠 뒤 중단 스위치로 막혔다가 풀리면 확인을 다시 받는다", async () => {
    const { client } = renderApp("/recommendations/91", "bob");
    fireEvent.click(await screen.findByRole("button", { name: "10%" }));
    expect(await within(screen.getByRole("region", { name: "이 금액으로 사는 수량" })).findByText(/^이 금액으로/, undefined, { timeout: 3000 })).toBeTruthy();
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = () => screen.getByRole("button", { name: "모의 자동매매 시작" }) as HTMLButtonElement;
    await waitFor(() => expect(start().disabled).toBe(false));

    db.options.halted = true;
    await act(() => client.invalidateQueries({ queryKey: ["recommendation", 91] }));
    // 금액 없는 미리 보기가 막히면 평소 막힌 화면 (넣을 돈·확인 칸이 빠진다)
    await waitFor(() => expect(screen.queryByRole("group", { name: "넣을 돈 정하는 방식" })).toBeNull());
    db.options.halted = false;
    await act(() => client.invalidateQueries({ queryKey: ["recommendation", 91] }));
    await waitFor(() => expect(screen.getAllByRole("checkbox")).toHaveLength(3));
    await waitFor(() => expect(screen.getByText("위의 확인 셋을 모두 켜면 시작할 수 있어요.")).toBeTruthy());
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((c) => c.checked)).toEqual([false, false, false]);
    expect(start().disabled).toBe(true);
  });

  it("손익비가 낮아도 내 계좌 사유(같은 종목 진행 중 계획)가 섞이면 ?manual=1을 무시한다 — blockedBy가 아니라 금액 없는 미리 보기로 정한다", async () => {
    db.options.planStepMs = 60_000;
    const bob = userOf("bob");
    db.activate(bob, 91, { budgetPercent: 10 }); // 000660 진행 중 계획
    const id = db.addRecommendation({ symbol: "000660", entryPrice: 181_000, targetPrice: 183_000, stopPrice: 173_000 });
    expect(db.getRecommendation(bob.id, id).blockedBy).toEqual(["reward_risk_low", "ev_negative"]); // blockedBy만 보면 자격이 되는 추천
    renderApp(`/recommendations/${id}?manual=1`, "bob");
    const reasons = await screen.findByRole("list", { name: "시작할 수 없는 이유" });
    await waitFor(() => expect(within(reasons).getByText(REASON_TEXT.plan_exists)).toBeTruthy());
    expect(screen.queryByRole("link", { name: /수동매매/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /수동매매/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "넣을 돈 정하는 방식" })).toBeNull();
    expect(screen.queryByText(MANUAL_START_TEXT.banner.easy)).toBeNull();
    expect(screen.queryByText(MANUAL_START_TEXT.topNote.easy, { exact: false })).toBeNull();
  });

  it("Discord 링크(?t=)에서도: 수동 링크가 token을 잇고, 위쪽 띠는 Discord 띠 하나가 '시연용'과 실제 시작 버튼 이름을 말하며, 활성화에 token과 manualStart를 싣는다", async () => {
    db.options.planStepMs = 60_000;
    const bobId = userOf("bob").id;
    const id = lowRec();
    const seen: unknown[] = [];
    server.events.on("request:start", async ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/activate")) seen.push(await request.clone().json());
    });
    renderApp(`/recommendations/${id}?t=demo-${id}`, "bob");
    const link = await screen.findByRole("link", { name: MANUAL_START_TEXT.button });
    expect(link.getAttribute("href")).toBe(`/recommendations/${id}?manual=1&t=demo-${id}`);
    fireEvent.click(link);
    expect(await screen.findByText(MANUAL_START_TEXT.banner.easy)).toBeTruthy();
    expect(MANUAL_START_TEXT.discordNote.easy).toContain(`“${MANUAL_START_TEXT.start.easy}”`); // 띠가 말하는 버튼 = 화면의 시작 버튼
    expect(screen.getByText(MANUAL_START_TEXT.discordNote.easy, { exact: false }).textContent).toContain("Discord에서 연 활성화 링크");
    expect(screen.queryByText("모의 자동매매 시작", { exact: false })).toBeNull(); // 화면에 없는 버튼 이름을 말하지 않는다
    expect(screen.queryByText(MANUAL_START_TEXT.topNote.easy, { exact: false })).toBeNull();
    expect(screen.getAllByRole("button", { name: /실행 확인으로 이동/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "10%" }));
    expect(await within(screen.getByRole("region", { name: "이 금액으로 사는 수량" })).findByText(/^이 금액으로/, undefined, { timeout: 3000 })).toBeTruthy();
    for (const c of screen.getAllByRole("checkbox")) fireEvent.click(c);
    const start = screen.getByRole("button", { name: MANUAL_START_TEXT.start.easy }) as HTMLButtonElement;
    await waitFor(() => expect(start.disabled).toBe(false));
    fireEvent.click(start);
    expect(await screen.findByRole("heading", { name: "삼성전자 모의 자동매매" })).toBeTruthy();
    server.events.removeAllListeners();
    expect(seen).toEqual([{ budgetPercent: 10, token: `demo-${id}`, acknowledged: true, manualStart: true }]);
    expect(screen.getByText(/^Discord 링크로 시작/)).toBeTruthy();
    const plan = db.listPlans(bobId, null).find((p) => p.symbol === "005930")!;
    expect(plan.via).toBe("discord");
    expect(db.getPlan(bobId, plan.id).events.find((e) => e.kind === "activated")?.message).toBe("Discord 링크에서 계획 활성화 (시연용 수동 시작)");
  });

  it("자격이 없으면 ?manual=1을 무시한다: 다른 사유(중단 스위치)면 평소 막힌 화면, 시작할 수 있으면 평소 시작 버튼", async () => {
    db.options.halted = true;
    const blocked = renderApp("/recommendations/93?manual=1", "bob");
    expect(await screen.findByRole("list", { name: "시작할 수 없는 이유" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "넣을 돈 정하는 방식" })).toBeNull();
    expect(screen.queryByRole("link", { name: /수동매매/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /수동매매/ })).toBeNull();
    expect(screen.queryByText(MANUAL_START_TEXT.banner.easy)).toBeNull();
    expect(screen.queryByText(MANUAL_START_TEXT.topNote.easy, { exact: false })).toBeNull();
    blocked.unmount();

    db.options.halted = false;
    renderApp("/recommendations/91?manual=1", "bob");
    expect(await screen.findByText("시작할 수 있음")).toBeTruthy(); // 금액 없는 미리 보기를 받았다
    expect(screen.getByRole("button", { name: "모의 자동매매 시작" })).toBeTruthy();
    expect(screen.queryByText(MANUAL_START_TEXT.banner.easy)).toBeNull();
    expect(screen.queryByText(MANUAL_START_TEXT.topNote.easy, { exact: false })).toBeNull();
  });
});

describe("시연용 수동 시작 계획의 표시", () => {
  it("계획 목록 · 쉬운 홈 '진행 중인 모의 자동매매' · 내 주식 대기 주문에 '시연용'", async () => {
    db.options.planStepMs = 60_000; // 테스트 동안 체결 대기 그대로
    db.activate(userOf("bob"), lowRec(), { budgetPercent: 10, manualStart: true });

    // 화면 읽기: 링크 이름은 짧게 두고 배지 글자를 설명(aria-describedby)으로 읽는다
    const descriptions = (el: HTMLElement) => (el.getAttribute("aria-describedby") ?? "").split(" ").map((x) => document.getElementById(x)?.textContent ?? "");

    const plans = renderApp("/plans", "bob");
    const row = await screen.findByRole("link", { name: "삼성전자 계획 보기" });
    expect(within(row).getByText(MANUAL_START_TEXT.badge)).toBeTruthy();
    expect(descriptions(row).join(" · ")).toContain(MANUAL_START_TEXT.badge);
    plans.unmount();

    const home = renderApp("/", "bob");
    const live = await screen.findByRole("list", { name: "진행 중인 모의 자동매매 목록" });
    expect(within(live).getByText(MANUAL_START_TEXT.badge)).toBeTruthy();
    expect(descriptions(within(live).getByRole("link", { name: "삼성전자 모의 자동매매 보기" }))).toContain(MANUAL_START_TEXT.badge);
    home.unmount();

    renderApp("/portfolio?tab=orders", "bob");
    expect(await screen.findByText("모의 자동매매 · 시연용")).toBeTruthy();
  });

  it("체결 뒤 내 주식 › 보유의 계획 줄에도 '시연용' (쉬운·전문가), 일반 계획의 줄은 그대로", async () => {
    db.options.planStepMs = 60_000; // 체결 뒤 목표가 청산으로 넘어가지 않게
    db.activate(userOf("bob"), lowRec(), { budgetPercent: 10, manualStart: true });
    db.setPrice("005930", 70_500); // 사는 가격(71,000) 아래 → 다음 조회에서 체결. 손절 69,000·목표 72,000 사이라 보유가 이어진다
    const easy = renderApp("/portfolio", "bob");
    const holdings = await screen.findByRole("list", { name: "보유 종목" });
    expect(await within(holdings).findByRole("link", { name: "시연용 모의 자동매매가 목표·손절에 자동으로 팔아요 · 계획 보기" })).toBeTruthy();
    easy.unmount();

    // 앨리스(전문가 보기)는 005930을 이미 보유해 다른 종목으로. 일반 계획(91, 000660)의 줄은 글자가 그대로다
    const alice = userOf("alice");
    const manual = db.activate(alice, db.addRecommendation({ symbol: "105560", entryPrice: 84_000, targetPrice: 85_000, stopPrice: 82_000 }), {
      budgetPercent: 10,
      manualStart: true,
    });
    const normal = db.activate(alice, 91, { budgetPercent: 10 });
    db.setPrice("105560", 83_500);
    db.setPrice("000660", 180_000);
    renderApp("/portfolio");
    const rows = await screen.findByRole("list", { name: "보유 종목" });
    expect(await within(rows).findByRole("link", { name: `시연용 자동매매 #${manual.id}가 청산을 관리합니다 · 계획 보기` })).toBeTruthy();
    expect(within(rows).getByRole("link", { name: `자동매매 #${normal.id}가 청산을 관리합니다 · 계획 보기` })).toBeTruthy();
  });

  it("전문가 보기 계획 화면: 배지 · 경고 한 줄(planNote.expert) · 타임라인은 서버 문장 그대로", async () => {
    db.options.planStepMs = 60_000;
    const id = db.addRecommendation({ symbol: "105560", entryPrice: 84_000, targetPrice: 85_000, stopPrice: 82_000 });
    const plan = db.activate(userOf("alice"), id, { budgetPercent: 10, manualStart: true });
    renderApp(`/plans/${plan.id}`);
    expect(await screen.findByText(MANUAL_START_TEXT.planNote.expert)).toBeTruthy();
    expect(screen.getByText(MANUAL_START_TEXT.badge)).toBeTruthy();
    expect(screen.queryByText(MANUAL_START_TEXT.planNote.easy)).toBeNull();
    const events = screen.getByRole("list", { name: "계획 사건" });
    expect(within(events).getByText("웹에서 계획 활성화 (시연용 수동 시작)")).toBeTruthy();
    expect(within(events).getByText(/^리스크 엔진 점검: .+ — 시연용 수동 시작으로 건너뜀\. 내가 정한 금액/)).toBeTruthy();
  });
});
