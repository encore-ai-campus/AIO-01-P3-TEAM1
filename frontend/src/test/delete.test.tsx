// 리포트·계획 제안 지우기와 가격이 지난 제안 표시 (2026-10-08, DECISIONS 25장, docs/API.md "리포트·계획 제안 지우기").
// 가짜 API의 예시 리포트(db.addSampleReports): NAVER 완성(긍정적·추천 있음, 데이브) · LG에너지솔루션 완성(지켜보기, 에린) · 에코프로 실패(밥).
// 밥·데이브는 쉬운 보기(주린이모드 켬), 앨리스는 전문가 보기다. 시각은 고정한다 (2026-10-06 화요일 14:00 KST, 국내 장 열림).
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { RecommendationCard } from "../components/autotrade/RecommendationCard";
import { PRICE_EXPIRED_TEXT, priceExpiredText } from "../lib/plainText";
import { planGuide } from "../lib/reports";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";
import { freezeTime } from "./time";

const NOW = "2026-10-06T14:00:00+09:00";

/** 예시 리포트와 NAVER 리포트의 계획 제안 번호. */
function samples() {
  db.addSampleReports();
  const all = db.listReports(null);
  const by = (symbol: string) => all.find((x) => x.symbol === symbol)!;
  const buy = by("035420");
  const rec = db.listRecommendations(4, { status: "all", source: "report", sourceId: String(buy.id) })[0];
  return { buy, hold: by("373220"), failed: by("086520"), rec };
}

/** 확인 시트를 열고 그 대화상자를 돌려준다. */
async function openConfirm(label: string) {
  fireEvent.click(await screen.findByRole("button", { name: label }));
  return screen.findByRole("dialog");
}

beforeEach(() => freezeTime(NOW));

describe("리포트 지우기", () => {
  it("남의 리포트·진행 중 리포트에는 버튼이 없다 (canDelete false)", async () => {
    const { buy } = samples();
    expect(db.getReport(buy.id, 2).canDelete).toBe(false); // 밥이 보는 데이브의 리포트
    renderApp(`/reports/${buy.id}`, "bob");
    expect(await screen.findByRole("heading", { name: "NAVER AI 리포트" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "리포트 지우기" })).toBeNull();
  });

  it("아직 끝나지 않은 내 리포트도 지울 수 없다", async () => {
    // seed 리포트 2: 앨리스가 신청한 대기 중 리포트
    expect(db.getReport(2, 1).canDelete).toBe(false);
    renderApp("/reports/2", "alice");
    expect(await screen.findByRole("heading", { name: "삼성전자 AI 리포트" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "리포트 지우기" })).toBeNull();
  });

  it("쉬운 보기: 내 실패 리포트 → 확인 → 지우기 → 리포트 목록으로, 토스트, 목록·상세에서 빠진다", async () => {
    const { failed } = samples();
    expect(db.getReport(failed.id, 2).canDelete).toBe(true);
    renderApp(`/reports/${failed.id}`, "bob");
    const dialog = await openConfirm("리포트 지우기");
    expect(within(dialog).getByRole("heading", { name: "이 리포트를 지울까요?" })).toBeTruthy();
    expect(within(dialog).getByText("리포트와 이 리포트의 계획 제안이 목록에서 사라져요. 오늘 쓴 리포트 횟수는 돌아오지 않아요.")).toBeTruthy();
    // 처음 포커스는 안전한 '취소'
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "취소" })));

    fireEvent.click(within(dialog).getByRole("button", { name: "지우기" }));
    expect(await screen.findByText("리포트를 지웠어요")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "AI 리포트" })).toBeTruthy(); // 리포트 목록
    expect(db.listReports(null).some((r) => r.id === failed.id)).toBe(false);
    expect(() => db.getReport(failed.id)).toThrow();
  });

  it("취소하면 아무것도 지우지 않는다", async () => {
    const { failed } = samples();
    renderApp(`/reports/${failed.id}`, "bob");
    const dialog = await openConfirm("리포트 지우기");
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(db.getReport(failed.id).id).toBe(failed.id);
  });

  it("전문가 보기: 내 완성 리포트를 지우면 그 리포트의 계획 제안도 같이 사라진다", async () => {
    const { buy, rec } = samples();
    db.setInvestorProfile("dave", { beginnerMode: false });
    renderApp(`/reports/${buy.id}`, "dave");
    const dialog = await openConfirm("리포트 지우기");
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기" }));
    expect(await screen.findByText("리포트를 지웠어요")).toBeTruthy();
    expect(db.listRecommendations(4, { status: "all" }).some((r) => r.id === rec.id)).toBe(false);
    expect(() => db.getRecommendation(4, rec.id)).toThrow();
  });

  it("실패하면 서버 detail 문장을 그대로 보이고 화면에 남는다", async () => {
    const { failed } = samples();
    server.use(http.delete("*/api/reports/:id", () => HttpResponse.json({ detail: "끝난 리포트만 지울 수 있어요." }, { status: 400 })));
    renderApp(`/reports/${failed.id}`, "bob");
    const dialog = await openConfirm("리포트 지우기");
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "끝난 리포트만 지울 수 있어요.");
    expect(screen.queryByText("리포트를 지웠어요")).toBeNull();
    expect(db.getReport(failed.id).id).toBe(failed.id);
  });
});

describe("계획 제안 지우기", () => {
  it("남이 만든 제안에는 버튼이 없다", async () => {
    const { rec } = samples();
    expect(db.getRecommendation(2, rec.id).canDelete).toBe(false);
    renderApp(`/recommendations/${rec.id}`, "bob");
    expect(await screen.findByRole("heading", { name: "NAVER 계획 제안" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "이 제안 지우기" })).toBeNull();
  });

  it("쉬운 보기: 리포트 제안 → '제안과 출처 리포트가 목록에서 사라져요' → 지우기 → 목록으로, 출처 리포트도 숨겨진다", async () => {
    const { buy, rec } = samples();
    expect(db.getRecommendation(4, rec.id).canDelete).toBe(true);
    renderApp(`/recommendations/${rec.id}`, "dave");
    const dialog = await openConfirm("이 제안 지우기");
    expect(within(dialog).getByRole("heading", { name: "이 제안을 지울까요?" })).toBeTruthy();
    expect(within(dialog).getByText("제안과 출처 리포트가 목록에서 사라져요.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기" }));
    expect(await screen.findByText("제안을 지웠어요")).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "새 계획 제안" })).toBeTruthy(); // 추천 목록
    expect(() => db.getRecommendation(4, rec.id)).toThrow();
    expect(() => db.getReport(buy.id)).toThrow();
  });

  it("전문가 보기: 시연 추천은 '추천 지우기', 설명은 제안만, 토스트 '추천을 지웠어요'", async () => {
    const demo = db.createDemo(db.login("alice", "alice1234"), { symbol: "035420" });
    expect(demo.canDelete).toBe(true);
    renderApp(`/recommendations/${demo.id}`, "alice");
    const dialog = await openConfirm("추천 지우기");
    expect(within(dialog).getByRole("heading", { name: "이 추천을 지울까요?" })).toBeTruthy();
    expect(within(dialog).getByText("제안이 목록에서 사라져요.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기" }));
    expect(await screen.findByText("추천을 지웠어요")).toBeTruthy();
    expect(db.listRecommendations(1, { status: "all" }).some((r) => r.id === demo.id)).toBe(false);
  });

  it("진행 중인 계획이 있으면 서버의 400 문장을 보이고 지우지 않는다", async () => {
    const { rec } = samples();
    db.activate(db.login("dave", "dave1234"), rec.id, { budgetPercent: 10, acknowledged: true });
    renderApp(`/recommendations/${rec.id}`, "dave");
    const dialog = await openConfirm("이 제안 지우기");
    fireEvent.click(within(dialog).getByRole("button", { name: "지우기" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("진행 중인 모의 자동매매가 있어 지울 수 없어요");
    expect(db.getRecommendation(4, rec.id).id).toBe(rec.id);
  });

  it("가짜 API: 남의 제안·리포트는 403", () => {
    const { rec, buy } = samples();
    const bob = db.login("bob", "bob1234");
    expect(() => db.deleteRecommendation(bob, rec.id)).toThrow(/내가 만든/);
    expect(() => db.deleteReport(bob, buy.id)).toThrow(/내가 신청한/);
  });
});

describe("가격이 지난 계획 제안 (expiredReason)", () => {
  it("문장: 쉬운 긴 문장·짧은 칩·전문가, 기한·모름은 null (지금 문구 그대로)", () => {
    expect(priceExpiredText("below_stop", true)).toBe("가격이 이미 손절 가격 아래로 내려가 끝난 제안이에요");
    expect(priceExpiredText("below_stop", true, "short")).toBe("손절 가격 아래로 내려감");
    expect(priceExpiredText("below_stop", false)).toBe("손절가 이탈로 만료");
    expect(priceExpiredText("above_target", true)).toBe("가격이 이미 목표 가격을 넘어 끝난 제안이에요");
    expect(priceExpiredText("above_target", true, "short")).toBe("목표 가격을 넘음");
    expect(priceExpiredText("above_target", false, "short")).toBe("목표가 도달로 만료");
    expect(priceExpiredText("deadline", true)).toBeNull();
    expect(priceExpiredText(null, false)).toBeNull();
    expect(priceExpiredText(undefined, true)).toBeNull();
    // 장중 가격 숫자를 넣지 않는다
    for (const t of Object.values(PRICE_EXPIRED_TEXT)) for (const s of Object.values(t)) expect(s).not.toMatch(/\d/);
    expect(planGuide("expired", "above_target")).toBe("가격이 이미 목표 가격을 넘어 끝난 제안이에요.");
    expect(planGuide("expired", "deadline")).toBe("계획 기한이 끝났어요.");
  });

  it("가짜 API: 기한 지남은 deadline, 가격으로 내리면 그 까닭, open은 null", () => {
    const { rec } = samples();
    expect(db.getRecommendation(4, rec.id).expiredReason).toBeNull();
    db.expireRecommendation(rec.id, "below_stop");
    const r = db.getRecommendation(4, rec.id);
    expect(r).toMatchObject({ status: "expired", expiredReason: "below_stop" });
    expect(r.blockedBy).toContain("expired");
    expect(db.listRecommendations(4, { status: null }).some((x) => x.id === rec.id)).toBe(false);
  });

  it("쉬운 보기 상세: 칩 '손절 가격 아래로 내려감', 머리 아래 긴 문장", async () => {
    const { rec } = samples();
    db.expireRecommendation(rec.id, "below_stop");
    renderApp(`/recommendations/${rec.id}`, "dave");
    expect(await screen.findByRole("heading", { name: "NAVER 계획 제안" })).toBeTruthy();
    // 머리 카드에서는 칩(짧게) 한 번 + 이름 아래 긴 문장 한 번 — 만든 사람 줄에서 다시 말하지 않는다
    expect(screen.getAllByText("손절 가격 아래로 내려감")).toHaveLength(1);
    expect(screen.getByText(/님이 만듦/).textContent).not.toMatch(/손절|기한/);
    expect(screen.getAllByText(/가격이 이미 손절 가격 아래로 내려가 끝난 제안이에요/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/기한 지남/)).toBeNull();
  });

  it("전문가 보기 상세: '목표가 도달로 만료'", async () => {
    const { rec } = samples();
    db.expireRecommendation(rec.id, "above_target");
    renderApp(`/recommendations/${rec.id}`, "alice");
    expect(await screen.findByRole("heading", { name: "NAVER 추천" })).toBeTruthy();
    expect(screen.getAllByText(/목표가 도달로 만료/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/에 만료$/)).toBeNull();
  });

  it("목록 카드: 까닭별 칩, 기한 지남은 그대로", () => {
    const { rec } = samples();
    const base = db.getRecommendation(4, rec.id);
    const card = (r: typeof base, easy: boolean) =>
      render(
        <MemoryRouter>
          <RecommendationCard r={r} easy={easy} />
        </MemoryRouter>,
      );
    const a = card({ ...base, status: "expired", expiredReason: "above_target", blockedBy: ["expired"] }, true);
    expect(within(a.container).getAllByText("목표 가격을 넘음").length).toBeGreaterThan(0);
    a.unmount();
    const b = card({ ...base, status: "expired", expiredReason: "below_stop", blockedBy: ["expired"] }, false);
    expect(within(b.container).getAllByText("손절가 이탈로 만료").length).toBeGreaterThan(0);
    b.unmount();
    const c = card({ ...base, status: "expired", expiredReason: "deadline", blockedBy: ["expired"] }, true);
    expect(within(c.container).getByText("기한 지남")).toBeTruthy();
  });
});
