import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { server } from "../../mocks/server";
import { PdfOpenButton } from "./PdfOpenButton";

/** 서버(DRF)는 JSON 렌더러만 쓴다 — Accept가 JSON을 받지 않으면 PDF가 있어도 406 (backend/config/settings.py). */
function acceptsJson(request: Request) {
  const accept = request.headers.get("accept") ?? "*/*";
  return /application\/json|\*\/\*/.test(accept);
}

function pdfServer(onRequest: (request: Request) => void = () => {}) {
  server.use(
    http.get("*/api/reports/99/pdf", ({ request }) => {
      onRequest(request);
      if (!acceptsJson(request)) return HttpResponse.json({ detail: "요청 Accept 헤더를 만족시킬 수 없습니다." }, { status: 406 });
      return HttpResponse.text("pdf", { headers: { "Content-Type": "application/pdf" } });
    }),
  );
}

/** 클릭 때 미리 여는 빈 탭 (window.open이 돌려주는 창). */
function fakeTab() {
  return {
    opener: {} as unknown,
    closed: false,
    close: vi.fn(),
    location: { replace: vi.fn() },
    document: { title: "", body: { textContent: "" } },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("PdfOpenButton", () => {
  it("현재 화면의 보기(easy/expert)로 PDF를 받아, 누를 때 미리 연 탭 하나에 띄운다", async () => {
    let requestedView: string | null = null;
    pdfServer((request) => {
      requestedView = new URL(request.url).searchParams.get("view");
    });
    const tab = fakeTab();
    const open = vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:report");
    const linkClick = vi.spyOn(HTMLAnchorElement.prototype, "click");

    render(<PdfOpenButton reportId={99} view="expert" />);
    fireEvent.click(screen.getByRole("button", { name: "PDF로 보기" }));

    // 팝업 차단을 피하려고 응답을 기다리기 전에 연다 — noopener 없이 열어야 탭을 다룰 수 있다
    expect(open).toHaveBeenCalledWith("", "_blank");
    expect(tab.document.body.textContent).toBe("PDF를 준비하고 있어요…");
    expect(tab.opener).toBeNull();
    await waitFor(() => expect(tab.location.replace).toHaveBeenCalledWith("blob:report"));
    expect(requestedView).toBe("expert");
    // 탭은 하나만: 다시 열거나 링크를 대신 누르지 않는다
    expect(open).toHaveBeenCalledTimes(1);
    expect(linkClick).not.toHaveBeenCalled();
    expect(tab.close).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: "PDF로 보기" })).toBeTruthy();
  });

  it("PDF 준비가 실패하면 미리 연 탭을 닫고, 웹 리포트는 유지한 채 오류와 재시도를 보여준다", async () => {
    server.use(
      http.get("*/api/reports/99/pdf", () => HttpResponse.json({ detail: "완성된 리포트만 PDF로 볼 수 있습니다." }, { status: 409 })),
    );
    const tab = fakeTab();
    vi.spyOn(window, "open").mockReturnValue(tab as unknown as Window);
    render(<PdfOpenButton reportId={99} view="easy" />);

    fireEvent.click(screen.getByRole("button", { name: "PDF로 보기" }));
    expect(await screen.findByRole("heading", { name: "PDF를 열지 못했어요" })).toBeTruthy();
    expect(screen.getByText("완성된 리포트만 PDF로 볼 수 있습니다.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    expect(tab.close).toHaveBeenCalledTimes(1);
    expect(tab.location.replace).not.toHaveBeenCalled();
  });

  it("새 창이 막히면 PDF가 준비된 뒤 직접 누르는 링크를 보여 준다", async () => {
    pdfServer();
    vi.spyOn(window, "open").mockReturnValue(null);
    const objectUrl = vi.spyOn(URL, "createObjectURL");
    render(<PdfOpenButton reportId={99} view="easy" />);

    fireEvent.click(screen.getByRole("button", { name: "PDF로 보기" }));
    const link = await screen.findByRole("link", { name: "여기를 눌러 PDF 열기" });
    expect(link.getAttribute("href")).toBe("/api/reports/99/pdf?view=easy");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(screen.getByText(/새 창이 막혀 PDF를 띄우지 못했어요/)).toBeTruthy();
    expect(objectUrl).not.toHaveBeenCalled();
  });
});
