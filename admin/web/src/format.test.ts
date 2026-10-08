import { describe, expect, it } from "vitest";
import { DASH, fmtAge, fmtMs, fmtTime, fmtUsd } from "./format";

describe("숫자 표기", () => {
  it("USD는 소수 3자리", () => {
    expect(fmtUsd(0.1234)).toBe("$0.123");
    expect(fmtUsd(0)).toBe("$0.000");
    expect(fmtUsd(null)).toBe(DASH);
  });
  it("ms는 1초 이상이면 초로", () => {
    expect(fmtMs(850)).toBe("850ms");
    expect(fmtMs(2300)).toBe("2.3초");
    expect(fmtMs(1000)).toBe("1.0초");
    expect(fmtMs(null)).toBe(DASH);
  });
  it("시각은 KST MM-DD HH:mm:ss", () => {
    expect(fmtTime("2026-10-08T00:30:05+00:00")).toBe("10-08 09:30:05");
    expect(fmtTime("2026-10-07T20:00:00-05:00")).toBe("10-08 10:00:00");
    expect(fmtTime(null)).toBe(DASH);
  });
  it("경과 시간", () => {
    expect(fmtAge(12)).toBe("12초");
    expect(fmtAge(200)).toBe("3분 20초");
    expect(fmtAge(7500)).toBe("2시간 5분");
  });
});
