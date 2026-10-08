import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { ErrorPanel } from "./ErrorPanel";
import { errorKindOf } from "./errorTypes";

describe("ErrorPanel", () => {
  it("API 상태를 사용자용 오류 종류로 바꾼다", () => {
    expect(errorKindOf(new ApiError(0, "network"))).toBe("network");
    expect(errorKindOf(new ApiError(400, "bad"))).toBe("validation");
    expect(errorKindOf(new ApiError(429, "limit", { detail: "limit", limit: 3, used: 3 }))).toBe("rate_limit");
    expect(errorKindOf(new ApiError(429, "budget", { detail: "budget" }))).toBe("budget"); // 팀 비용 예산 (본문에 limit 없음)
    expect(errorKindOf(new ApiError(503, "down"))).toBe("unavailable");
    expect(errorKindOf(new ApiError(500, "server"))).toBe("unknown");
  });

  it("문제와 다음 행동을 보여주고 다시 시도한다", () => {
    const retry = vi.fn();
    render(
      <MemoryRouter>
        <ErrorPanel kind="workflow" onRetry={retry} />
      </MemoryRouter>,
    );
    expect(screen.getByRole("heading", { name: "리포트를 완성하지 못했어요" })).toBeTruthy();
    expect(screen.getByText(/Trace State/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("link", { name: "리포트 목록으로" }).getAttribute("href")).toBe("/reports");
  });
});
