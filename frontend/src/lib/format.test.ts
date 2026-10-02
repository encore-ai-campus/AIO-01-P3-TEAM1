import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatDateTime,
  formatKrw,
  formatPercent,
  formatPrice,
  formatQty,
  formatRate,
  formatRelative,
  formatRequester,
  formatSignedKrw,
  formatSignedPrice,
  trendClass,
} from "./format";

describe("format", () => {
  it("원화는 천 단위 쉼표 + 원, 원 단위 반올림", () => {
    expect(formatKrw(1234567)).toBe("1,234,567원");
    expect(formatKrw(1234567.6)).toBe("1,234,568원");
    expect(formatKrw(0)).toBe("0원");
    expect(formatKrw(null)).toBe("-");
    expect(formatSignedKrw(12345)).toBe("+12,345원");
    expect(formatSignedKrw(-12345)).toBe("-12,345원");
    expect(formatSignedKrw(0)).toBe("0원");
  });

  it("수익률은 부호가 붙은 백분율 두 자리", () => {
    expect(formatRate(0.0123)).toBe("+1.23%");
    expect(formatRate(-0.005)).toBe("-0.50%");
    expect(formatRate(0)).toBe("0.00%");
    expect(formatRate(-0.00001)).toBe("0.00%");
    expect(formatRate(null)).toBe("-");
    expect(formatPercent(0.62)).toBe("62%");
  });

  it("달러 종목은 $123.45", () => {
    expect(formatPrice(123.45, "USD")).toBe("$123.45");
    expect(formatPrice(1234.5, "USD")).toBe("$1,234.50");
    expect(formatPrice(71000, "KRW")).toBe("71,000원");
    expect(formatSignedPrice(1.234, "USD")).toBe("+$1.23");
    expect(formatSignedPrice(-2.5, "USD")).toBe("-$2.50");
    expect(formatSignedPrice(-700, "KRW")).toBe("-700원");
  });

  it("상승 빨강, 하락 파랑, 보합 회색", () => {
    expect(trendClass(0.01)).toBe("text-up");
    expect(trendClass(-0.01)).toBe("text-down");
    expect(trendClass(0)).toBe("text-sub");
  });

  it("시각은 한국 시간으로", () => {
    const year = new Date().getFullYear();
    expect(formatDateTime(`${year}-10-02T00:05:00Z`)).toBe("10.02 09:05");
    expect(formatDateTime("2020-01-03T09:00:00+09:00")).toBe("2020.01.03 09:00");
    expect(formatDate("2026-10-02")).toBe("2026.10.02");
    const now = new Date("2026-10-02T10:00:00+09:00");
    expect(formatRelative("2026-10-02T09:55:00+09:00", now)).toBe("5분 전");
  });

  it("수량과 요청자", () => {
    expect(formatQty(10)).toBe("10주");
    expect(formatQty(1.5)).toBe("1.5주");
    expect(formatRequester("strategy:3")).toBe("전략 3");
    expect(formatRequester("cli")).toBe("엔진 CLI");
    expect(formatRequester("alice")).toBe("alice");
  });
});
