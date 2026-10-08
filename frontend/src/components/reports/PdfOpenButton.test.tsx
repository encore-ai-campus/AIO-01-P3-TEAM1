import { fireEvent, render, screen } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { server } from "../../mocks/server";
import { PdfOpenButton } from "./PdfOpenButton";

describe("PdfOpenButton", () => {
  it("현재 화면의 보기(easy/expert)를 PDF 요청에 전달한다", async () => {
    let requestedView: string | null = null;
    server.use(
      http.get("*/api/reports/99/pdf", ({ request }) => {
        requestedView = new URL(request.url).searchParams.get("view");
        return HttpResponse.text("pdf", { headers: { "Content-Type": "application/pdf" } });
      }),
    );
    const objectUrl = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
    const open = vi.spyOn(window, "open").mockReturnValue({} as Window);

    render(<PdfOpenButton reportId={99} view="expert" />);
    fireEvent.click(screen.getByRole("button", { name: "PDF로 보기" }));

    expect(await screen.findByRole("button", { name: "PDF로 보기" })).toBeTruthy();
    expect(requestedView).toBe("expert");
    expect(open).toHaveBeenCalledWith("blob:report", "_blank", "noopener,noreferrer");
    objectUrl.mockRestore();
    open.mockRestore();
  });

  it("PDF 준비가 실패하면 웹 리포트는 유지하고 오류와 재시도를 보여준다", async () => {
    server.use(
      http.get("*/api/reports/99/pdf", () => HttpResponse.json({ detail: "완성된 리포트만 PDF로 볼 수 있습니다." }, { status: 409 })),
    );
    render(<PdfOpenButton reportId={99} view="easy" />);

    fireEvent.click(screen.getByRole("button", { name: "PDF로 보기" }));
    expect(await screen.findByRole("heading", { name: "PDF를 열지 못했어요" })).toBeTruthy();
    expect(screen.getByText("완성된 리포트만 PDF로 볼 수 있습니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
  });
});
