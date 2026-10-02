import { cleanup } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, vi } from "vitest";
import { resetDb } from "./mocks/db";
import { server } from "./mocks/server";

// jsdom에는 캔버스가 없어 차트 라이브러리를 가짜로 바꾼다
vi.mock("lightweight-charts", () => {
  const series = { setData: vi.fn(), update: vi.fn(), priceScale: () => ({ applyOptions: vi.fn() }) };
  return {
    CandlestickSeries: {},
    HistogramSeries: {},
    createChart: () => ({
      addSeries: () => series,
      timeScale: () => ({ fitContent: vi.fn() }),
      remove: vi.fn(),
    }),
  };
});

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
beforeEach(() => resetDb({ jitter: false, persist: false, jobPolls: 1, marketOpen: { KR: true, US: false } }));
afterEach(() => {
  cleanup();
  server.resetHandlers();
  document.cookie = "csrftoken=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/";
});
afterAll(() => server.close());
