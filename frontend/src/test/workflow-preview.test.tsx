import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { Providers } from "../App";
import { createQueryClient } from "../lib/queryClient";
import { setSession } from "../mocks/db";
import { WorkflowPreviewPage } from "../pages/WorkflowPreviewPage";
import { ErrorPreviewPage } from "../pages/ErrorPreviewPage";

describe("백엔드 없는 Workflow 미리보기", () => {
  it("기존 복구 시나리오를 재생해 Agent 상태·Trace·Feedback Loop를 보여준다", async () => {
    setSession("alice");
    render(
      <MemoryRouter>
        <Providers client={createQueryClient({ retry: false })}>
          <WorkflowPreviewPage />
        </Providers>
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByRole("button", { name: /③ 모델 실패/ }));
    fireEvent.click(screen.getByRole("button", { name: "멈춤" }));
    for (let i = 0; i < 17; i += 1) fireEvent.click(screen.getByRole("button", { name: "다음 사건" }));

    expect(screen.getByText("예시 데이터 — 실제 실행이 아닙니다")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "작업 계획(Planner) · Agent 상태" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Trace Timeline · 실행 사건" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Shared State · 공유 실행 상태" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Feedback Loop · 검토 후 재작성" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /④ 형식 오류/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /⑤ Feedback Loop 최대 횟수/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /⑥ 악성 지시 자료 차단/ })).toBeTruthy();
  });
});

describe("오류·복구 시나리오", () => {
  it("PDF 실패 뒤 웹 리포트를 유지하고 PDF만 다시 준비한다", () => {
    render(
      <MemoryRouter>
        <Providers client={createQueryClient({ retry: false })}>
          <ErrorPreviewPage />
        </Providers>
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: /PDF 생성 실패·재시도/ }));
    fireEvent.click(screen.getByRole("button", { name: "다음 단계" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 단계" }));
    expect(screen.getByRole("heading", { name: "PDF를 열지 못했어요" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(screen.getByRole("heading", { name: "PDF를 다시 준비하고 있습니다" })).toBeTruthy();
  });
});
