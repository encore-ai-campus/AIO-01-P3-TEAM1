// 운영 E2E 점검 뒤 고친 것 — 장기투자 쉬운 말 (docs/records/운영E2E점검_UX리뷰_2026-10-08.md UX-4).
// 쉬운 보기: "정기공시" → "실적 보고서(정기공시)", "점검할 축" → "먼저 볼 것", "기준선 …" → "… 숫자와 비교해요". 전문가 보기는 그대로.
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Providers } from "../App";
import { FundamentalsPanel } from "../components/longterm/FundamentalsPanel";
import { ThesisForm } from "../components/longterm/ThesisForm";
import { createQueryClient } from "../lib/queryClient";
import * as db from "../mocks/db";
import { freezeTime } from "./time";

const TUE_6PM = "2026-10-06T18:00:00+09:00";

function renderUi(ui: ReactNode, user = "alice") {
  db.setSession(user);
  const client = createQueryClient({ retry: false });
  return render(
    <MemoryRouter>
      <Providers client={client}>{ui}</Providers>
    </MemoryRouter>,
  );
}

describe("산 이유 입력 (ThesisForm)", () => {
  it("쉬운 보기: '실적 보고서(정기공시)'·'먼저 볼 것'", () => {
    renderUi(<ThesisForm symbol="068270" name="셀트리온" easy />);
    const form = screen.getByRole("form", { name: "셀트리온 산 이유" });
    expect(form.textContent).toContain("실적 보고서(정기공시)가 나올 때");
    expect(within(form).getByRole("group", { name: "먼저 볼 것 (선택)" })).toBeTruthy();
    expect(form.textContent).not.toMatch(/축/);
    expect(form.textContent).not.toContain("매도를 권하거나");
  });

  it("전문가 보기는 그대로: '정기공시'·'점검할 축'", () => {
    renderUi(<ThesisForm symbol="068270" name="셀트리온" />);
    const form = screen.getByRole("form", { name: "셀트리온 산 이유" });
    expect(form.textContent).toContain("정기공시가 나올 때");
    expect(form.textContent).not.toContain("실적 보고서");
    expect(within(form).getByRole("group", { name: "점검할 축 (선택)" })).toBeTruthy();
  });
});

describe("펀더멘털 패널의 내 산 이유", () => {
  it("쉬운 보기: '먼저 볼 것: …', 기준선은 '○○ 숫자와 비교해요', 고치기 폼도 쉬운 말", async () => {
    freezeTime(TUE_6PM);
    renderUi(<FundamentalsPanel symbol="068270" view="easy" />);
    const mine = await screen.findByRole("group", { name: "내 산 이유" });
    expect(mine.textContent).toContain("먼저 볼 것: 성장 · 수익성 · 2025 사업보고서 숫자와 비교해요");
    expect(mine.textContent).not.toContain("기준선");
    expect(mine.textContent).not.toContain("점검 축");
    expect(mine.textContent).not.toContain("정기공시 점검");
    fireEvent.click(within(mine).getByRole("button", { name: "산 이유 고치기" }));
    const form = screen.getByRole("form", { name: "셀트리온 산 이유" });
    expect(within(form).getByRole("group", { name: "먼저 볼 것 (선택)" })).toBeTruthy();
  });

  it("전문가 보기는 그대로: '점검 축: …' · '기준선 …'", async () => {
    freezeTime(TUE_6PM);
    renderUi(<FundamentalsPanel symbol="068270" view="expert" />);
    const mine = await screen.findByRole("group", { name: "내 산 이유" });
    expect(mine.textContent).toContain("점검 축: 성장 · 수익성 · 기준선 2025 사업보고서");
  });
});
