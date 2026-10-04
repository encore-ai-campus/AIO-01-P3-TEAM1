import { describe, expect, it } from "vitest";
import { SECRET_GAP_MS, SECRET_TAPS, nextTaps } from "./secretTaps";

/** times의 시각으로 차례로 누른 뒤 마지막 누름에서 열렸는지. */
function tapAt(times: number[]) {
  let taps: number[] = [];
  let unlocked = false;
  for (const t of times) ({ taps, unlocked } = nextTaps(taps, t));
  return { taps, unlocked };
}

describe("nextTaps (숨은 관리자 입구)", () => {
  const quick = (n: number, start = 0) => Array.from({ length: n }, (_, i) => start + i * 300);

  it(`${SECRET_TAPS}번 연속이면 열리고 기록을 비운다`, () => {
    expect(tapAt(quick(SECRET_TAPS))).toEqual({ taps: [], unlocked: true });
  });

  it(`${SECRET_TAPS - 1}번으로는 열리지 않는다`, () => {
    expect(tapAt(quick(SECRET_TAPS - 1)).unlocked).toBe(false);
  });

  it("간격이 길면 처음부터 다시 센다", () => {
    const times = [...quick(SECRET_TAPS - 1), (SECRET_TAPS - 2) * 300 + SECRET_GAP_MS + 1];
    const { taps, unlocked } = tapAt(times);
    expect(unlocked).toBe(false);
    expect(taps).toHaveLength(1);
  });

  it("간격이 딱 한도면 이어서 센다", () => {
    expect(tapAt(Array.from({ length: SECRET_TAPS }, (_, i) => i * SECRET_GAP_MS)).unlocked).toBe(true);
  });
});
