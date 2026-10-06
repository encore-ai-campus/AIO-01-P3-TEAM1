import { describe, expect, it } from "vitest";
import { freezeTime } from "../test/time";
import {
  formatAsOf,
  formatDate,
  formatDateTime,
  formatDayLabel,
  formatKrw,
  formatLiveAsOf,
  formatPercent,
  formatPrice,
  formatQty,
  formatQuoteAsOf,
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
    // 올해(KST)면 연도를 뺀다. 시각을 고정한다 — 지역 시간대의 연도로 만들면 1월 1일 0~9시(KST)에 해가 갈려 깨진다
    freezeTime("2026-10-06T10:00:00+09:00");
    expect(formatDateTime("2026-10-02T00:05:00Z")).toBe("10.02 09:05");
    expect(formatDateTime("2025-12-31T16:00:00Z")).toBe("01.01 01:00"); // UTC로는 작년이지만 KST로 올해
    expect(formatDateTime("2025-12-31T14:00:00Z")).toBe("2025.12.31 23:00"); // KST로 작년이면 연도
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

  it("장마감 기준: 그 시장의 현지 시각으로, 미국은 (뉴욕)", () => {
    expect(formatAsOf("2026-10-02T15:30:00+09:00", "KR")).toBe("10월 2일(금) 15:30 장마감 기준");
    expect(formatAsOf("2026-10-02T06:30:00Z")).toBe("10월 2일(금) 15:30 장마감 기준"); // 기본 KR
    // 서머타임(EDT, -04:00)과 표준시(EST, -05:00) 모두 뉴욕 16:00
    expect(formatAsOf("2026-10-02T16:00:00-04:00", "US")).toBe("10월 2일(금) 16:00(뉴욕) 장마감 기준");
    expect(formatAsOf("2026-12-04T21:00:00Z", "US")).toBe("12월 4일(금) 16:00(뉴욕) 장마감 기준");
    expect(formatAsOf(null)).toBe("-");
    expect(formatAsOf("nope")).toBe("-");
  });

  it("실시간: 받은 시각을 한국 시간 초까지, basis에 따라 장마감 기준과 갈린다", () => {
    expect(formatLiveAsOf("2026-10-06T15:20:31+09:00")).toBe("실시간 · 15:20:31");
    expect(formatLiveAsOf("2026-10-06T06:20:31Z")).toBe("실시간 · 15:20:31"); // 시간대가 달라도 한국 시간
    expect(formatLiveAsOf("2026-10-06T09:30:05-04:00")).toBe("실시간 · 22:30:05"); // 미국 종목도 받은 시각은 한국 시간
    expect(formatLiveAsOf(null)).toBe("-");
    expect(formatLiveAsOf("nope")).toBe("-");
    expect(formatQuoteAsOf("2026-10-06T15:20:31+09:00", "KR", "live")).toBe("실시간 · 15:20:31");
    expect(formatQuoteAsOf("2026-10-02T15:30:00+09:00", "KR", "close")).toBe("10월 2일(금) 15:30 장마감 기준");
    expect(formatQuoteAsOf("2026-10-02T16:00:00-04:00", "US")).toBe("10월 2일(금) 16:00(뉴욕) 장마감 기준"); // basis를 안 주면 장마감 기준
  });

  it("날짜 라벨은 요일까지", () => {
    expect(formatDayLabel("2026-10-06")).toBe("10월 6일(화)");
    expect(formatDayLabel("2026-10-02")).toBe("10월 2일(금)");
    expect(formatDayLabel(null)).toBe("-");
    expect(formatDayLabel("오늘")).toBe("오늘");
  });
});
