// 테스트용 가짜 API 기본값과 시각 고정. 날짜·시각에 기대는 테스트는 freezeTime으로 시각을 고정한다 (오늘 날짜에 따라 깨지지 않게).
import { vi } from "vitest";
import { type MockOptions, resetDb } from "../mocks/db";

/** 테스트마다 가짜 API를 이 값으로 되돌린다 (setupTests.ts). 국내 장은 열림, 미국 장은 닫힘으로 고정. */
export const TEST_DB: Partial<MockOptions> = { jitter: false, persist: false, jobPolls: 1, marketOpen: { KR: true, US: false } };

/**
 * 시각을 iso로 고정하고(Date만 가짜 — 타이머는 진짜라 MSW·React Query가 그대로 돈다. 시각은 거기서부터 흐른다)
 * 가짜 API 상태를 그 시각 기준으로 다시 만든다. 테스트가 끝나면 setupTests가 진짜 시각으로 되돌린다.
 * 예: freezeTime("2026-10-06T10:00:00+09:00") — 화요일 장중, KR 기준일은 10월 5일.
 */
export function freezeTime(iso: string, opts: Partial<MockOptions> = {}) {
  vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(iso));
  resetDb({ ...TEST_DB, ...opts });
}
