// 관리자 화면(/ops): "리포트" 메뉴 8번 연속 → 관리자 화면, 관리자만 보기, 예전 /reports/health 주소.
import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SECRET_GAP_MS, SECRET_TAPS } from "../lib/secretTaps";
import { renderApp } from "./render";

/** 하단 탭의 "리포트" (왼쪽 메뉴에도 같은 이름이 있다 — 둘이 같은 횟수를 센다). */
const reportsTab = () => screen.getAllByRole("link", { name: "리포트" })[0];

afterEach(() => vi.restoreAllMocks());

describe("숨은 관리자 입구", () => {
  it(`"리포트" 메뉴를 ${SECRET_TAPS}번 연속 누르면 관리자 화면으로 간다`, async () => {
    renderApp("/");
    await screen.findByRole("heading", { name: "홈" });
    for (let i = 0; i < SECRET_TAPS; i++) fireEvent.click(reportsTab());
    expect(await screen.findByRole("heading", { name: "관리자" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "복구 지표" })).toBeTruthy();
  });

  it(`${SECRET_TAPS - 1}번이면 리포트 화면에 머문다`, async () => {
    renderApp("/");
    await screen.findByRole("heading", { name: "홈" });
    for (let i = 0; i < SECRET_TAPS - 1; i++) fireEvent.click(reportsTab());
    expect(await screen.findByRole("heading", { name: "AI 리포트" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "관리자" })).toBeNull();
  });

  it("누름 사이가 길면 처음부터 다시 센다", async () => {
    let now = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    renderApp("/");
    await screen.findByRole("heading", { name: "홈" });
    for (let i = 0; i < SECRET_TAPS; i++) {
      now += i === SECRET_TAPS - 1 ? SECRET_GAP_MS + 1 : 100; // 마지막 한 번만 늦게
      fireEvent.click(reportsTab());
    }
    expect(await screen.findByRole("heading", { name: "AI 리포트" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "관리자" })).toBeNull();
  });
});

describe("관리자 화면", () => {
  it("관리자가 아니면 안내만 보인다", async () => {
    renderApp("/ops", "bob");
    expect(await screen.findByText(/관리자 계정만 볼 수 있습니다/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "복구 지표" })).toBeNull();
  });

  it("예전 /reports/health 주소는 관리자 화면으로 간다", async () => {
    renderApp("/reports/health");
    expect(await screen.findByRole("heading", { name: "관리자" })).toBeTruthy();
  });
});
