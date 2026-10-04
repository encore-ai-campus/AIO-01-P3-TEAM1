// 마이: 주린이모드 스위치(끌 때 한 줄 확인), 투자 성향·경험 진단 7문항(결과·추천대로 바꾸기·다시 진단),
// 단타 연습 입구(주린이모드 끔일 때), 랭킹 카드, 내 수익률(장마감 기준).
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";
import { completeAnswers, resultLine, toggleProduct } from "./components/my/diagnosis";
import { INVESTOR_QUESTIONS, NOT_SUITABILITY } from "./lib/plainText";
import * as db from "./mocks/db";
import { server } from "./mocks/server";
import { renderApp } from "./test/render";
import { freezeTime } from "./test/time";

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

  it("확인하면 끄고(PATCH) 단타 연습 입구가 나온다. 다시 켜기는 확인 없이 바로", async () => {
    renderApp("/my", "carol");
    await waitFor(() => expect(modeSwitch().checked).toBe(true));
    expect(screen.queryByRole("region", { name: "단타 연습장" })).toBeNull();
    fireEvent.click(modeSwitch());
    fireEvent.click(screen.getByRole("button", { name: "주린이모드 끄기" }));
    await waitFor(() => expect(db.investorProfile(3).beginnerMode).toBe(false));
    await waitFor(() =>
      expect(requests).toEqual([{ method: "PATCH", url: expect.stringContaining("/api/me/investor-profile"), body: { beginnerMode: false } }]),
    );
    expect(modeSwitch().checked).toBe(false);
    await waitFor(() => expect(toast().textContent).toContain("주린이모드를 껐어요"));

    const day = await screen.findByRole("region", { name: "단타 연습장" });
    expect(within(day).getByText("단타 연습 퀴즈 5문항을 모두 맞혀야 열려요")).toBeTruthy();
    expect(within(day).getByRole("link", { name: "단타 연습 퀴즈 풀기" }).getAttribute("href")).toBe("/day/quiz");

    fireEvent.click(modeSwitch());
    expect(screen.queryByRole("group", { name: "주린이모드 끄기 확인" })).toBeNull();
    await waitFor(() => expect(db.investorProfile(3).beginnerMode).toBe(true));
    await waitFor(() => expect(screen.queryByRole("region", { name: "단타 연습장" })).toBeNull());
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
    fireEvent.click(within(card).getByRole("button", { name: "진단 시작" }));
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
});

describe("마이 · 단타 연습 입구 · 랭킹 · 내 수익률", () => {
  it("주린이모드 끔 + 퀴즈 통과(앨리스)면 단타 연습장·퀴즈 다시 풀기", async () => {
    renderApp("/my");
    const day = await screen.findByRole("region", { name: "단타 연습장" });
    expect(await within(day).findByText(/연습 퀴즈 통과/)).toBeTruthy();
    expect(within(day).getByRole("link", { name: "단타 연습장 가기" }).getAttribute("href")).toBe("/day");
    expect(within(day).getByRole("link", { name: "퀴즈 다시 풀기" }).getAttribute("href")).toBe("/day/quiz");
    expect(within(day).queryByText(/성향 진단:/)).toBeNull(); // 위험중립형
  });

  it("안정형·안정추구형이면 단타 입구에 성향 안내 한 줄", async () => {
    db.setInvestorProfile("alice", {
      answers: { q1: "1_3y", q2: ["kr_stock", "us_stock"], q3: "monthly", q4: "explain", q5: "no_loss", q6: "years", q7: "practice" },
    });
    renderApp("/my");
    const day = await screen.findByRole("region", { name: "단타 연습장" });
    expect(await within(day).findByText("하루 안에 사고파는 연습은 손실 변동이 커요. 성향 진단: 안정형")).toBeTruthy();
  });

  it("프로필을 받지 못하면 진단·단타 입구 카드가 스켈레톤에 멈추지 않고 오류와 '다시 시도'", async () => {
    let fail = true;
    server.use(
      http.get("*/api/me/investor-profile", () => (fail ? HttpResponse.json({ detail: "잠시 후 다시 시도해 주세요." }, { status: 500 }) : undefined)),
    );
    renderApp("/my"); // 앨리스: 주린이모드 끔 → 단타 입구도 보인다
    const diagnosis = await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    expect(await within(diagnosis).findByText("잠시 후 다시 시도해 주세요.")).toBeTruthy();
    const day = await screen.findByRole("region", { name: "단타 연습장" });
    expect(within(day).getByRole("button", { name: "다시 시도" })).toBeTruthy();
    fail = false;
    fireEvent.click(within(diagnosis).getByRole("button", { name: "다시 시도" }));
    expect(await within(day).findByText(/연습 퀴즈 통과/)).toBeTruthy();
    expect(within(screen.getByRole("region", { name: "투자 성향·경험 진단" })).queryByRole("alert")).toBeNull();
  });

  it("주린이모드 켬이면 단타 입구가 없다", async () => {
    renderApp("/my", "bob");
    await screen.findByRole("region", { name: "투자 성향·경험 진단" });
    await waitFor(() => expect(modeSwitch().checked).toBe(true));
    expect(screen.queryByRole("region", { name: "단타 연습장" })).toBeNull();
  });

  it("랭킹 카드(공개면 내 순위)와 내 수익률·랭킹의 장마감 기준 시각", async () => {
    freezeTime("2026-10-06T10:00:00+09:00");
    renderApp("/my");
    const ranking = await screen.findByRole("region", { name: "랭킹" });
    expect(await within(ranking).findByText(`${db.ranking(1).me.rank}위`)).toBeTruthy();
    expect(within(ranking).getByRole("link", { name: /랭킹/ }).getAttribute("href")).toBe("/ranking");
    expect(within(ranking).getByRole("list", { name: "랭킹 상위 3명" })).toBeTruthy();
    const mine = await screen.findByRole("region", { name: "내 수익률" });
    expect(await within(mine).findByText("10월 5일(월) 15:30 장마감 기준")).toBeTruthy();
    expect(within(mine).getByText("10월 5일(월) 16:00(뉴욕) 장마감 기준")).toBeTruthy();
    expect(within(mine).getByText("일별 자산 추이 (30일 · 장마감 기준)")).toBeTruthy();
  });

  it("비공개면 랭킹 카드에 공개 안내", async () => {
    renderApp("/my", "carol");
    const ranking = await screen.findByRole("region", { name: "랭킹" });
    expect(await within(ranking).findByText(/내 정보 공개.*켜면 랭킹에 나와요/)).toBeTruthy();
  });

  it("알림 설정 카드에 웹 전용 알림 안내", async () => {
    renderApp("/my");
    const card = await screen.findByRole("region", { name: "알림 설정" });
    expect(within(card).getByText(/오늘의 내 종목 뉴스·펀더멘털 점검·단타 연습 알림은 웹에만 와요/)).toBeTruthy();
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
