// 마이: 주린이모드 스위치(끌 때 한 줄 확인), 투자 성향·경험 진단 7문항(결과·추천대로 바꾸기·다시 진단),
// 랭킹 카드, 내 수익률(장마감 기준).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completeAnswers, resultLine, toggleProduct } from "../components/my/diagnosis";
import { INVESTOR_QUESTIONS, NOT_SUITABILITY } from "../lib/plainText";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

const toast = () => screen.getByRole("status");
const modeSwitch = () => screen.getByRole("switch", { name: /주린이모드/ }) as HTMLInputElement;

/** 진단 문항 하나(fieldset)에서 보기를 누른다. */
function choose(question: RegExp, label: string) {
  const group = screen.getByRole("group", { name: question });
  fireEvent.click(within(group).getByLabelText(label));
}

/** 경험 4(초급) · 성향 4(위험중립형) → 주린이모드 켬 추천. */
function answerNoviceNeutral() {
  choose(/주식 투자를 해 본 기간/, "1년 미만");
  choose(/거래해 본 상품/, "국내 주식");
  choose(/주식 거래 빈도/, "1년에 몇 번");
  choose(/PER, 손절, 지정가/, "들어 봄");
  choose(/견딜 수 있는 손실/, "−20%까지");
  choose(/투자 기간/, "몇 주");
  choose(/투자 목적/, "꾸준한 자산 증식");
}

const requests: { method: string; url: string; body: unknown }[] = [];
server.events.on("request:start", async ({ request }) => {
  if (request.url.includes("/api/me/investor-profile") && request.method !== "GET") {
    requests.push({ method: request.method, url: request.url, body: await request.clone().json() });
  }
});
afterEach(() => {
  requests.length = 0;
});

describe("마이 · 주린이모드 스위치", () => {
  it("진단 전 팀원은 켬. 끄면 한 줄 확인을 먼저 보이고, 취소하면 그대로", async () => {
    renderApp("/my", "carol");
    expect(await screen.findByRole("heading", { name: "마이" })).toBeTruthy();
    await waitFor(() => expect(modeSwitch().checked).toBe(true));
    fireEvent.click(modeSwitch());
    const confirm = screen.getByRole("group", { name: "주린이모드 끄기 확인" });
    expect(within(confirm).getByText("어려운 용어·숫자가 그대로 나와요")).toBeTruthy();
    expect(modeSwitch().checked).toBe(true); // 확인 전에는 바뀌지 않는다
    fireEvent.click(within(confirm).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("group", { name: "주린이모드 끄기 확인" })).toBeNull();
    expect(requests).toEqual([]);
    expect(db.investorProfile(3).beginnerMode).toBe(true);
  });

  it("확인하면 끈다(PATCH). 다시 켜기는 확인 없이 바로", async () => {
    renderApp("/my", "carol");
    await waitFor(() => expect(modeSwitch().checked).toBe(true));
    fireEvent.click(modeSwitch());
    fireEvent.click(screen.getByRole("button", { name: "주린이모드 끄기" }));
    await waitFor(() => expect(db.investorProfile(3).beginnerMode).toBe(false));
    await waitFor(() =>
      expect(requests).toEqual([{ method: "PATCH", url: expect.stringContaining("/api/me/investor-profile"), body: { beginnerMode: false } }]),
    );
    expect(modeSwitch().checked).toBe(false);
    await waitFor(() => expect(toast().textContent).toContain("주린이모드를 껐어요"));

    fireEvent.click(modeSwitch());
    expect(screen.queryByRole("group", { name: "주린이모드 끄기 확인" })).toBeNull();
    await waitFor(() => expect(db.investorProfile(3).beginnerMode).toBe(true));
    expect(modeSwitch().checked).toBe(true);
  });

  it("끄기 확인이 열리면 '주린이모드 끄기'로 포커스가 가고, Esc는 취소 — 포커스는 스위치로 돌아온다", async () => {
    renderApp("/my", "carol");
    await waitFor(() => expect(modeSwitch().checked).toBe(true));
    fireEvent.click(modeSwitch());
    const confirm = screen.getByRole("group", { name: "주린이모드 끄기 확인" });
    expect(document.activeElement).toBe(within(confirm).getByRole("button", { name: "주린이모드 끄기" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "주린이모드 끄기 확인" })).toBeNull();
    expect(document.activeElement).toBe(modeSwitch());
    expect(modeSwitch().checked).toBe(true);
  });

  it("켬·끔에 따라 화면에 나오는 말 예시의 '지금' 줄이 바뀐다", async () => {
    renderApp("/my", "carol");
    const example = await screen.findByRole("list", { name: "화면에 나오는 말 예시" });
    const now = () => within(example).getAllByRole("listitem").find((li) => li.getAttribute("aria-current") === "true")?.textContent;
    expect(now()).toContain("목표에 팔면");
    fireEvent.click(modeSwitch());
    fireEvent.click(screen.getByRole("button", { name: "주린이모드 끄기" }));
    await waitFor(() => expect(now()).toContain("목표가"));
    // 저장(PATCH)이 서버에 닿을 때까지 기다린다. 화면은 먼저 바뀌므로(낙관적 갱신) 여기서 끝내면 보낸 요청이 다음 테스트의
    // 초기화(resetDb) 뒤에 도착해 캐럴의 주린이모드를 꺼 버린다 — 부하가 크면 다음 테스트가 켜진 스위치를 기다리다 1초를 넘겼다
    await waitFor(() => expect(db.investorProfile(3).beginnerMode).toBe(false));
  });

  it("저장에 실패하면 되돌리고 서버 사유를 보인다", async () => {
    server.use(http.patch("*/api/me/investor-profile", () => HttpResponse.json({ detail: "잠시 뒤 다시 시도해 주세요." }, { status: 503 })));
    renderApp("/my", "carol");
    await waitFor(() => expect(modeSwitch().checked).toBe(true));
    fireEvent.click(modeSwitch());
    fireEvent.click(screen.getByRole("button", { name: "주린이모드 끄기" }));
    await waitFor(() => expect(toast().textContent).toContain("잠시 뒤 다시 시도해 주세요."));
    expect(modeSwitch().checked).toBe(true);
  });
});

describe("마이 · 투자 성향·경험 진단", () => {
  it("7문항에 답하면 결과(초급 · 위험중립형 → 켬 추천)를 보이고, 지금 설정과 같으면 그렇게 알린다", async () => {
    renderApp("/my", "carol");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    expect(within(card).getByText(new RegExp(NOT_SUITABILITY))).toBeTruthy();
    fireEvent.click(await within(card).findByRole("button", { name: "진단 시작" }));
    const form = within(card).getByRole("form", { name: "투자 성향·경험 진단 문항" });
    expect(within(form).getAllByRole("group")).toHaveLength(7);
    const submit = within(form).getByRole("button", { name: "결과 보기" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    answerNoviceNeutral();
    expect(within(form).getByText("7/7 답함")).toBeTruthy();
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    expect(await within(card).findByText("진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천")).toBeTruthy();
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      method: "PUT",
      body: { answers: { q1: "under_1y", q2: ["kr_stock"], q3: "yearly", q4: "heard", q5: "loss_20", q6: "weeks", q7: "growth" } },
    });
    expect(within(card).getByText("지금 주린이모드(켬)가 추천과 같아요.")).toBeTruthy();
    expect(db.investorProfile(3)).toMatchObject({ experienceLevel: "novice", riskProfile: "neutral", beginnerMode: true });
  });

  it("\"예적금만\"은 다른 보기와 같이 고를 수 없다", async () => {
    renderApp("/my", "carol");
    fireEvent.click(await screen.findByRole("button", { name: "진단 시작" }));
    const group = screen.getByRole("group", { name: /거래해 본 상품/ });
    const box = (label: string) => within(group).getByLabelText(label) as HTMLInputElement;
    fireEvent.click(box("펀드·ETF"));
    fireEvent.click(box("국내 주식"));
    fireEvent.click(box("예적금만"));
    expect([box("예적금만").checked, box("펀드·ETF").checked, box("국내 주식").checked]).toEqual([true, false, false]);
    fireEvent.click(box("해외 주식"));
    expect([box("예적금만").checked, box("해외 주식").checked]).toEqual([false, true]);
  });

  it("진단한 팀원(앨리스): 결과를 보이고, 다시 진단하면 이전 답이 채워져 있고, 추천이 바뀌면 추천대로 켤 수 있다", async () => {
    renderApp("/my");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    expect(await within(card).findByText("진단 결과: 중급 · 위험중립형 → 주린이모드 끔 추천")).toBeTruthy();
    expect(within(card).getByText("지금 주린이모드(끔)가 추천과 같아요.")).toBeTruthy();

    fireEvent.click(within(card).getByRole("button", { name: "다시 진단" }));
    const q1 = screen.getByRole("group", { name: /주식 투자를 해 본 기간/ });
    expect((within(q1).getByLabelText("1~3년") as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText("7/7 답함")).toBeTruthy();
    choose(/주식 투자를 해 본 기간/, "없음");
    choose(/주식 거래 빈도/, "해 본 적 없음");
    choose(/PER, 손절, 지정가/, "모름");
    fireEvent.click(screen.getByRole("button", { name: "결과 보기" }));

    expect(await within(card).findByText(/진단 결과: 입문 · .* → 주린이모드 켬 추천/)).toBeTruthy();
    expect(db.investorProfile(1).beginnerMode).toBe(false); // 진단 제출은 주린이모드를 바꾸지 않는다
    fireEvent.click(within(card).getByRole("button", { name: "추천대로 주린이모드 켜기" }));
    await waitFor(() => expect(db.investorProfile(1).beginnerMode).toBe(true));
    await waitFor(() => expect(modeSwitch().checked).toBe(true));
    expect(within(card).getByText("지금 주린이모드(켬)가 추천과 같아요.")).toBeTruthy();
  });

  it("답하는 동안 진행 막대·'n/7 답함'이 붙어 있고, 건너뛴 문항은 'N번 빠짐'으로 데려간다", async () => {
    renderApp("/my", "carol");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    fireEvent.click(await within(card).findByRole("button", { name: "진단 시작" }));
    const form = within(card).getByRole("form", { name: "투자 성향·경험 진단 문항" });
    expect(document.activeElement?.textContent).toMatch(/^1\. /); // 폼을 열면 1번 문항으로
    expect(within(form).getByText("예적금만은 다른 보기와 함께 고를 수 없어요.")).toBeTruthy();
    choose(/거래해 본 상품/, "국내 주식"); // 1번을 건너뛰고 2번
    expect(within(form).getByText("1/7 답함")).toBeTruthy();
    fireEvent.click(within(form).getByRole("button", { name: "1번 빠짐" }));
    const q1 = screen.getByRole("group", { name: /주식 투자를 해 본 기간/ });
    expect(q1.contains(document.activeElement)).toBe(true);
    choose(/주식 투자를 해 본 기간/, "1년 미만");
    expect(within(form).queryByRole("button", { name: /빠짐/ })).toBeNull();
  });

  it("결과 보기를 누르면 폼이 결과로 접히고 결과 줄로 포커스를 옮긴다 (결과가 화면 위로 사라지지 않게)", async () => {
    renderApp("/my", "carol");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    fireEvent.click(await within(card).findByRole("button", { name: "진단 시작" }));
    answerNoviceNeutral();
    fireEvent.click(within(card).getByRole("button", { name: "결과 보기" }));
    const result = await within(card).findByText("진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천");
    await waitFor(() => expect(document.activeElement).toBe(result));
  });

  it("취소하면 '진단 시작'으로 포커스가 돌아온다", async () => {
    renderApp("/my", "carol");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    fireEvent.click(await within(card).findByRole("button", { name: "진단 시작" }));
    fireEvent.click(within(card).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByRole("button", { name: "진단 시작" })));
  });

  it("보내는 중에도 '결과 보기'를 막지 않아(aria-disabled) 포커스가 남고, 실패하면 폼이 그대로 있고 서버 사유를 알린다", async () => {
    server.use(
      http.put("*/api/me/investor-profile", async () => {
        await new Promise((r) => setTimeout(r, 150));
        return HttpResponse.json({ detail: "잠시 뒤 다시 시도해 주세요." }, { status: 503 });
      }),
    );
    renderApp("/my", "carol");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    fireEvent.click(await within(card).findByRole("button", { name: "진단 시작" }));
    answerNoviceNeutral();
    const submit = within(card).getByRole("button", { name: "결과 보기" }) as HTMLButtonElement;
    submit.focus();
    fireEvent.click(submit);
    await waitFor(() => expect(submit.getAttribute("aria-disabled")).toBe("true"));
    expect(submit.disabled).toBe(false);
    await waitFor(() => expect(toast().textContent).toContain("잠시 뒤 다시 시도해 주세요."));
    expect(within(card).getByRole("form", { name: "투자 성향·경험 진단 문항" })).toBeTruthy();
    expect(submit.getAttribute("aria-disabled")).toBeNull();
    expect(document.activeElement).toBe(submit);
  });

  it("'진단하기' 링크(/my#diagnosis)로 오면 진단 전 팀원은 폼이 펼쳐져 있다 (진단한 팀원은 결과)", async () => {
    renderApp("/my#diagnosis", "carol");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    expect(await within(card).findByRole("form", { name: "투자 성향·경험 진단 문항" })).toBeTruthy();
    await waitFor(() => expect(document.getElementById("diagnosis")).toBe(card));
  });

  it("추천이 끔인데 켜 두었으면 \"추천대로 끄기\"도 한 줄 확인 뒤에 끈다", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    renderApp("/my");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    fireEvent.click(await within(card).findByRole("button", { name: "추천대로 주린이모드 끄기" }));
    const confirm = within(card).getByRole("group", { name: "주린이모드 끄기 확인" });
    expect(within(confirm).getByText("어려운 용어·숫자가 그대로 나와요")).toBeTruthy();
    expect(db.investorProfile(1).beginnerMode).toBe(true);
    fireEvent.click(within(confirm).getByRole("button", { name: "주린이모드 끄기" }));
    await waitFor(() => expect(db.investorProfile(1).beginnerMode).toBe(false));
  });

  it("'추천대로 끄기' 확인을 연 채 다시 진단하면 그 확인은 닫힌다 — 취소·결과 보기 뒤 묻지 않은 확인이 열려 있지 않다 (my-r3)", async () => {
    db.setInvestorProfile("alice", { beginnerMode: true });
    renderApp("/my");
    const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    for (const how of ["취소", "결과 보기"] as const) {
      fireEvent.click(await within(card).findByRole("button", { name: "추천대로 주린이모드 끄기" }));
      expect(within(card).getByRole("group", { name: "주린이모드 끄기 확인" })).toBeTruthy();
      fireEvent.click(within(card).getByRole("button", { name: "다시 진단" }));
      fireEvent.click(within(card).getByRole("button", { name: how })); // 이전 답이 채워져 있어 바로 결과를 볼 수 있다
      await within(card).findByText("진단 결과: 중급 · 위험중립형 → 주린이모드 끔 추천");
      expect(within(card).queryByRole("group", { name: "주린이모드 끄기 확인" })).toBeNull();
      expect(within(card).getByRole("button", { name: "추천대로 주린이모드 끄기" })).toBeTruthy();
    }
    expect(db.investorProfile(1).beginnerMode).toBe(true);
  });

  it("붙는 바닥이 화면 아래에 붙어 있는 동안만 html[data-sticky-footer]와 높이를 달고, 취소·결과 보기·화면을 떠나면 지운다 (my-r6)", async () => {
    // jsdom은 크기가 늘 0이다: 진단 폼의 붙는 바닥만 화면 아래 끝에 붙은 87px로 흉내 낸다
    const real = HTMLElement.prototype.getBoundingClientRect;
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (!this.className.includes("sticky") || !this.closest("form")) return real.call(this);
      const bottom = window.innerHeight;
      return { x: 0, y: bottom - 87, top: bottom - 87, bottom, left: 0, right: 320, width: 320, height: 87, toJSON: () => ({}) } as DOMRect;
    });
    const root = document.documentElement;
    const flag = () => [root.hasAttribute("data-sticky-footer"), root.style.getPropertyValue("--sticky-footer-h")];
    try {
      const { unmount } = renderApp("/my", "carol");
      const card = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
      fireEvent.click(await within(card).findByRole("button", { name: "진단 시작" }));
      expect(flag()).toEqual([true, "87px"]);
      fireEvent.click(within(card).getByRole("button", { name: "취소" }));
      expect(flag()).toEqual([false, ""]);

      fireEvent.click(within(card).getByRole("button", { name: "진단 시작" }));
      expect(flag()).toEqual([true, "87px"]);
      answerNoviceNeutral();
      fireEvent.click(within(card).getByRole("button", { name: "결과 보기" }));
      await within(card).findByText("진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천");
      expect(flag()).toEqual([false, ""]);

      fireEvent.click(within(card).getByRole("button", { name: "다시 진단" }));
      expect(flag()).toEqual([true, "87px"]);
      unmount(); // 폼을 연 채 다른 화면으로
      expect(flag()).toEqual([false, ""]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("마이 · 프로필 오류 · 랭킹 · 내 수익률", () => {
  it("프로필을 받지 못하면 진단 카드가 스켈레톤에 멈추지 않고 오류와 '다시 시도'", async () => {
    let fail = true;
    server.use(
      http.get("*/api/me/investor-profile", () => (fail ? HttpResponse.json({ detail: "잠시 후 다시 시도해 주세요." }, { status: 500 }) : undefined)),
    );
    renderApp("/my");
    const diagnosis = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    expect(await within(diagnosis).findByText("잠시 후 다시 시도해 주세요.")).toBeTruthy();
    fail = false;
    fireEvent.click(within(diagnosis).getByRole("button", { name: "다시 시도" }));
    const card = screen.getByRole("region", { name: "투자 성향·경험 진단" });
    expect(await within(card).findByText("진단 결과: 중급 · 위험중립형 → 주린이모드 끔 추천")).toBeTruthy();
    expect(within(card).queryByRole("alert")).toBeNull();
  });

  it("내 성적: 공개면 수익률 옆에 랭킹 순위(→ 전체 순위), 랭킹 상위 3명, 장마감 기준 시각은 내 수익률에 한 번", async () => {
    freezeTime("2026-10-06T10:00:00+09:00");
    renderApp("/my");
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    // 자주 보는 순위는 수익률 머리 줄에 (첫 화면) — 같은 숫자를 랭킹 쪽에 다시 쓰지 않는다
    const chip = await within(mine).findByRole("link", { name: `랭킹 ${db.ranking(1).me.rank}위` });
    expect(chip.getAttribute("href")).toBe("/ranking");
    expect(await within(mine).findByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
    expect(within(mine).getByText("10월 5일(월) 16:00(뉴욕) 장마감 기준")).toBeTruthy();
    expect(within(mine).getByText("일별 자산 추이 (30일 · 장마감 기준)")).toBeTruthy();
    expect(within(mine).getByRole("link", { name: /현금·보유 종목 자세히/ }).getAttribute("href")).toBe("/portfolio");
    expect(within(mine).queryByText("초기 자금")).toBeNull(); // 홈·모의투자와 겹치는 줄은 뺐다

    const ranking = screen.getByRole("region", { name: "랭킹" });
    expect(within(ranking).getByRole("link", { name: /랭킹/ }).getAttribute("href")).toBe("/ranking");
    const top = within(ranking).getByRole("list", { name: "랭킹 상위 3명" });
    expect(within(top).getAllByRole("listitem").find((li) => li.getAttribute("aria-current") === "true")?.textContent).toContain("앨리스");
    expect(within(ranking).queryByText(/장마감 기준/)).toBeNull();
  });

  it("비공개면 수익률 옆 순위가 없고, 랭킹 바로 아래의 '내 정보 공개'를 가리킨다 (스위치가 랭킹 구역 안)", async () => {
    renderApp("/my", "carol");
    const ranking = await screen.findByRole("region", { name: "랭킹" });
    expect(await within(ranking).findByText(/내 정보 공개.*켜면 랭킹에 나와요/)).toBeTruthy();
    expect((within(ranking).getByRole("switch", { name: "내 정보 공개" }) as HTMLInputElement).checked).toBe(false);
    expect(within(screen.getByRole("region", { name: "내 수익률" })).queryByRole("link", { name: /랭킹 \d+위/ })).toBeNull();
  });

  it("계좌를 받지 못하면 '내 수익률' 자리에만 오류 — 계좌와 상관없는 랭킹·'내 정보 공개'(#public)는 그대로 쓸 수 있다 (my-r2)", async () => {
    server.use(http.get("*/api/account", () => HttpResponse.json({ detail: "계좌를 불러오지 못했어요." }, { status: 500 })));
    renderApp("/my#public", "carol");
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    expect(await within(mine).findByText("계좌를 불러오지 못했어요.")).toBeTruthy();
    expect(within(mine).getByRole("button", { name: "다시 시도" })).toBeTruthy();
    const sw = within(screen.getByRole("region", { name: "랭킹" })).getByRole("switch", { name: "내 정보 공개" });
    await waitFor(() => expect(document.getElementById("public")?.contains(sw)).toBe(true));
  });

  it("그린 뒤 계좌 다시 받기(폴링)가 실패해도 마지막 값을 그대로 두고, 랭킹·공개 스위치도 남는다 (my-r2)", async () => {
    const { client } = renderApp("/my");
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    const invested = await within(mine).findByText(`${db.account(1).investedKrw.toLocaleString("ko-KR")}원`);
    server.use(http.get("*/api/account", () => HttpResponse.json({ detail: "잠시 뒤 다시 시도해 주세요." }, { status: 503 })));
    void client.refetchQueries({ queryKey: ["account"] });
    await waitFor(() => expect(client.getQueryState(["account"])?.status).toBe("error"));
    expect(within(mine).getByText(invested.textContent!)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "랭킹" })).getByRole("switch", { name: "내 정보 공개" })).toBeTruthy();
  });

  it("쉬운 보기(밥)는 투자금액·총자산에 쉬운 설명을 붙인다 (라벨은 그대로)", async () => {
    renderApp("/my", "bob");
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    expect(within(mine).getByText("투자금액")).toBeTruthy();
    expect(within(mine).getByText("지금 주식에 들어간 돈")).toBeTruthy();
    expect(within(mine).getByText("현금과 주식을 합친 돈")).toBeTruthy();
  });

  it("일별 자산 추이: 모바일에서도 기간·변화율·최고·최저를 글자로, 화면 읽기에는 같은 값을 그림 이름으로", async () => {
    renderApp("/my");
    const chart = await screen.findByRole("img", { name: /^일별 자산 추이: .*거래일 \d+일, .*최고 .*최저/ });
    const figure = chart.closest("figure")!;
    expect(within(figure).getByText(/^\d+월 \d+일~\d+월 \d+일 · 거래일 \d+일$/)).toBeTruthy();
    expect(within(figure).getByText(/^최고 [\d,]+원 · 최저 [\d,]+원$/)).toBeTruthy();
    expect(chart.getAttribute("class")).toMatch(/text-(up|down)/); // 색은 토큰(currentColor)
  });

  it("알림 설정 카드에 웹 전용 알림 안내", async () => {
    renderApp("/my");
    const card = await screen.findByRole("region", { name: "알림 설정" });
    expect(within(card).getByText(/오늘의 내 종목 뉴스·펀더멘털 점검 알림은 웹에만 와요/)).toBeTruthy();
  });
});

describe("마이 · 배치 · 계정", () => {
  /** a가 b보다 문서에서 앞에 있는지 (모바일 한 열 순서 = PC 왼쪽 열 → 오른쪽 열 순서). */
  const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it("순서: 주린이모드(진단 포함) → 내 성적(수익률 → 랭킹) → 알림 설정 → 화면 모드 → 계정 → 로그아웃", async () => {
    renderApp("/my");
    const mode = await screen.findByRole("region", { name: "주린이모드" });
    const diagnosis = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    const ranking = screen.getByRole("region", { name: "랭킹" });
    const settings = await screen.findByRole("region", { name: "알림 설정" });
    const theme = screen.getByRole("region", { name: "화면 모드" });
    const account = screen.getByRole("region", { name: "계정" });
    const logout = screen.getByRole("button", { name: "로그아웃" });
    expect(mode.contains(diagnosis)).toBe(true); // 스위치와 '추천대로'가 한 카드에
    const order = [mode, mine, ranking, settings, theme, account, logout];
    order.slice(1).forEach((el, i) => expect(before(order[i], el)).toBe(true));
  });

  it("해시로 설정 하나를 가리켜 오면(/my#notification-settings) 위 카드가 다 그려진 뒤 그 자리에 id가 붙는다", async () => {
    renderApp("/my#notification-settings");
    const settings = await screen.findByRole("region", { name: "알림 설정" });
    await waitFor(() => expect(document.getElementById("notification-settings")?.contains(settings)).toBe(true));
    expect(document.getElementById("theme")?.contains(screen.getByRole("region", { name: "화면 모드" }))).toBe(true);
    expect(document.getElementById("public")?.contains(screen.getByRole("switch", { name: "내 정보 공개" }))).toBe(true);
  });

  /** 해시 대상 자리 (준비된 뒤에 id가 붙는다). */
  const anchorOf = (id: string) =>
    waitFor(() => {
      const el = document.getElementById(id);
      expect(el).toBeTruthy();
      return el!;
    });

  it("다른 화면이 가리켜 보내면(/my#public) 그 자리를 잠깐 물들이고 포커스를 옮긴다 — 뒤로 가기로 다시 올 때는 하지 않는다 (my-r5·a11y-10)", async () => {
    renderApp("/ranking");
    fireEvent.click(await screen.findByRole("link", { name: /공개 설정은 마이에서/ }));
    const target = await anchorOf("public");
    await waitFor(() => expect(document.activeElement).toBe(target)); // 다음 Tab은 그 안의 '내 정보 공개' 스위치
    expect(target.className).toContain("bg-brand-soft/60");

    fireEvent.click(within(screen.getByRole("region", { name: "랭킹" })).getByRole("link", { name: /전체 순위/ }));
    fireEvent.click(await screen.findByRole("button", { name: "뒤로 가기" }));
    const again = await anchorOf("public");
    await new Promise((r) => setTimeout(r, 0));
    expect(again.className).not.toContain("bg-brand-soft/60");
    expect(document.activeElement).not.toBe(again);
  });

  it("주소로 바로 열어도(/my#notification-settings) 그 카드로 포커스를 옮긴다 (a11y-10)", async () => {
    renderApp("/my#notification-settings");
    const target = await anchorOf("notification-settings");
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(target.contains(screen.getByRole("region", { name: "알림 설정" }))).toBe(true);
  });

  it("닉네임 '변경'은 바뀐 것이 없을 때·저장하는 동안 막지(disabled) 않고 aria-disabled로 알린다 — 저장 뒤에도 포커스가 버튼에 남는다 (a11y-11)", async () => {
    renderApp("/my");
    const account = await screen.findByRole("region", { name: "계정" });
    const input = within(account).getByLabelText("닉네임") as HTMLInputElement;
    const button = within(account).getByRole("button", { name: "변경" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true"); // 바뀐 것이 없다
    fireEvent.change(input, { target: { value: "앨리" } });
    expect(button.getAttribute("aria-disabled")).toBeNull();
    button.focus();
    fireEvent.click(button);
    expect(button.disabled).toBe(false); // 저장하는 동안에도
    await waitFor(() => expect(toast().textContent).toContain("닉네임을 앨리로 바꿨어요."));
    expect(button.disabled).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true"); // 이제 칸의 값이 지금 닉네임이다
    expect(document.activeElement).toBe(button);
  });

  it("계정 카드: 이름 @아이디와 닉네임. 2자 미만은 칸 아래에 이유, 겹치는 닉네임은 서버 사유를 칸 아래에", async () => {
    renderApp("/my");
    const account = await screen.findByRole("region", { name: "계정" });
    expect(within(account).getByRole("heading", { name: "앨리스 @alice" })).toBeTruthy();
    const input = within(account).getByLabelText("닉네임") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "앨" } });
    fireEvent.blur(input);
    expect(within(account).getByRole("alert").textContent).toBe("닉네임은 2~12자로 적어 주세요.");
    expect(input.getAttribute("aria-invalid")).toBe("true");

    fireEvent.change(input, { target: { value: "데이브" } }); // 다른 팀원 이름: 칸 검사는 통과, 서버가 거절한다
    expect(within(account).queryByRole("alert")).toBeNull();
    fireEvent.click(within(account).getByRole("button", { name: "변경" }));
    expect((await within(account).findByRole("alert")).textContent).toBe("이미 쓰고 있는 닉네임입니다.");
    expect(screen.queryByRole("status")?.textContent ?? "").not.toContain("이미 쓰고 있는"); // 토스트가 아니라 칸 아래

    fireEvent.change(input, { target: { value: "앨리" } });
    expect(within(account).queryByRole("alert")).toBeNull(); // 고치기 시작하면 서버 사유는 지운다
    fireEvent.click(within(account).getByRole("button", { name: "변경" }));
    await waitFor(() => expect(toast().textContent).toContain("닉네임을 앨리로 바꿨어요."));
  });
});

describe("진단 화면 계산", () => {
  it("q2 토글: 예적금만은 혼자, 다른 보기를 고르면 예적금만을 지운다", () => {
    expect(toggleProduct([], "deposit")).toEqual(["deposit"]);
    expect(toggleProduct(["fund_etf", "kr_stock"], "deposit")).toEqual(["deposit"]);
    expect(toggleProduct(["deposit"], "kr_stock")).toEqual(["kr_stock"]);
    expect(toggleProduct(["kr_stock"], "kr_stock")).toEqual([]);
  });

  it("일곱 문항이 모두 있어야 보낼 답이 된다", () => {
    expect(completeAnswers({ q2: [] })).toBeNull();
    const all = { q1: "none", q2: ["deposit"], q3: "never", q4: "heard", q5: "loss_10", q6: "weeks", q7: "practice" } as const;
    expect(completeAnswers({ ...all, q2: [] })).toBeNull();
    expect(completeAnswers({ ...all, q2: ["deposit"] })).toEqual({ ...all, q2: ["deposit"] });
    expect(INVESTOR_QUESTIONS.map((q) => q.key)).toEqual(["q1", "q2", "q3", "q4", "q5", "q6", "q7"]);
  });

  it("결과 문장", () => {
    expect(resultLine({ experienceLevel: "novice", riskProfile: "neutral", recommendedBeginnerMode: true })).toBe(
      "진단 결과: 초급 · 위험중립형 → 주린이모드 켬 추천",
    );
    expect(resultLine({ experienceLevel: "expert", riskProfile: "aggressive", recommendedBeginnerMode: false })).toBe(
      "진단 결과: 숙련 · 공격투자형 → 주린이모드 끔 추천",
    );
    expect(resultLine({ experienceLevel: null, riskProfile: null, recommendedBeginnerMode: null })).toBeNull();
  });
});
