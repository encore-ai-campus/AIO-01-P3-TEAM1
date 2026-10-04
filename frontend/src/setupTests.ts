import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { resetDb } from "./mocks/db";
import { server } from "./mocks/server";
import { TEST_DB } from "./test/time";

// jsdom에는 캔버스가 없어 차트 라이브러리를 가짜로 바꾼다 (가격 선·표시(markers)를 쓰는 차트도 그릴 수 있게)
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
    createChart: () => ({
      addSeries: () => series,
      removeSeries: vi.fn(),
      applyOptions: vi.fn(),
      timeScale: () => ({ fitContent: vi.fn(), setVisibleRange: vi.fn(), applyOptions: vi.fn() }),
      priceScale: () => ({ applyOptions: vi.fn() }),
      subscribeCrosshairMove: vi.fn(),
      unsubscribeCrosshairMove: vi.fn(),
      remove: vi.fn(),
    }),
  };
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => resetDb(TEST_DB));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  vi.useRealTimers(); // freezeTime(src/test/time.ts)으로 고정한 시각을 되돌린다
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});
afterAll(() => server.close());
