// 새로고침으로 다시 연 문서: 탭 저장소(sessionStorage 'paper-scroll')의 기록으로 보던 자리에 돌아간다 (components/motion/ScrollManager).
// 기록은 모듈 상태라 문서마다(처음 읽을 때) 한 번만 저장소를 읽는다 — 다른 ScrollManager 테스트와 섞이지 않게 파일을 나눈다
// (vitest는 테스트 파일마다 모듈을 새로 읽는다).
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { ScrollManager } from "../components/motion/ScrollManager";

afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(document.documentElement, "scrollHeight");
});

it("새로고침이면 저장해 둔 자리로 (첫 항목은 키가 늘 'default'라 주소로 가린다). 문서가 그때의 높이가 될 때까지 앵커링을 끄고 맞춘다", async () => {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([{ type: "reload" } as unknown as PerformanceEntry]);
  sessionStorage.setItem(
    "paper-scroll",
    JSON.stringify([
      ["default|/reports", 900, 2018], // [키, 자리, 그때의 문서 높이]
      ["default|/my", 300], // 높이가 없는 옛 기록도 읽는다
    ]),
  );
  const setHeight = (h: number) => Object.defineProperty(document.documentElement, "scrollHeight", { value: h, configurable: true });
  setHeight(1684); // 새로고침 직후: 위쪽 목록이 아직 덜 왔다
  const scrollTo = vi.spyOn(window, "scrollTo");
  render(
    <MemoryRouter initialEntries={["/reports"]}>
      <ScrollManager />
    </MemoryRouter>,
  );
  expect(scrollTo).toHaveBeenLastCalledWith(0, 900);
  expect(scrollTo).not.toHaveBeenCalledWith(0, 300);
  expect(document.documentElement.style.overflowAnchor).toBe("none");
  await new Promise((r) => setTimeout(r, 120));
  expect(document.documentElement.style.overflowAnchor).toBe("none"); // 아직 그때의 높이가 아니다
  setHeight(2018);
  await waitFor(() => expect(document.documentElement.style.overflowAnchor).toBe(""));
  expect(scrollTo).toHaveBeenLastCalledWith(0, 900);
});
