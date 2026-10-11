import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { resetThemeForTests } from "../lib/theme";
import { resetDb } from "../mocks/db";
import { server } from "../mocks/server";
import { TEST_DB } from "./time";

// jsdom의 window.scrollTo는 'Not implemented'를 낸다. 화면을 옮길 때마다 ScrollManager가 부르므로 빈 함수로 둔다
Object.defineProperty(window, "scrollTo", { value: () => {}, writable: true, configurable: true });

// jsdom에는 캔버스가 없어 차트 라이브러리를 가짜로 바꾼다 (가격 선·표시(markers)를 쓰는 차트도 그릴 수 있게).
// createChart·addSeries는 vi.fn이라 테스트가 만든 횟수(테마를 바꿔도 다시 만들지 않는지)와 시리즈 종류를 볼 수 있다. 시리즈는 모두 같은 가짜 하나다
vi.mock("lightweight-charts", () => {
  const series = {
    setData: vi.fn(),
    update: vi.fn(),
    applyOptions: vi.fn(),
    priceScale: () => ({ applyOptions: vi.fn() }),
    createPriceLine: vi.fn(() => ({ applyOptions: vi.fn() })),
    removePriceLine: vi.fn(),
  };
  return {
    CandlestickSeries: {},
    HistogramSeries: {},
    LineSeries: {},
    createSeriesMarkers: vi.fn(() => ({ setMarkers: vi.fn(), markers: () => [], detach: vi.fn() })),
    createChart: vi.fn(() => ({
      addSeries: vi.fn(() => series),
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      timeScale: () => ({ fitContent: vi.fn(), setVisibleRange: vi.fn(), applyOptions: vi.fn() }),
      priceScale: () => ({ applyOptions: vi.fn() }),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      remove: vi.fn(),
    })),
  };
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => resetDb(TEST_DB));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.useRealTimers(); // freezeTime(src/test/time.ts)으로 고정한 시각을 되돌린다
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
  // 화면 모드·모달·셸이 html에 남긴 것을 지운다 (다음 테스트가 이전 테마·스크롤 잠금으로 시작하지 않게)
  resetThemeForTests();
  const root = document.documentElement;
  for (const name of ["data-theme", "style", "data-scroll-lock", "data-shell"]) root.removeAttribute(name);
  try {
    sessionStorage.clear(); // 스크롤 위치 기록
  } catch {
    // 저장소를 쓸 수 없는 환경이면 지울 것도 없다
  }
});
afterAll(() => server.close());
