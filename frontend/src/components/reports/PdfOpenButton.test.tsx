import { fireEvent, render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { server } from "../../mocks/server";
import { PdfOpenButton } from "./PdfOpenButton";

describe("PdfOpenButton", () => {
  it("PDF 준비가 실패하면 웹 리포트는 유지하고 오류와 재시도를 보여준다", async () => {
    server.use(
      http.get("*/api/reports/99/pdf", () => HttpResponse.json({ detail: "완성된 리포트만 PDF로 볼 수 있습니다." }, { status: 409 })),
    );
    render(<PdfOpenButton reportId={99} />);

    fireEvent.click(screen.getByRole("button", { name: "PDF로 보기" }));
    expect(await screen.findByRole("heading", { name: "PDF를 열지 못했어요" })).toBeTruthy();
    expect(screen.getByText("완성된 리포트만 PDF로 볼 수 있습니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});
