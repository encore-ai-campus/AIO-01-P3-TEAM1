// 시세 기준 판단: StockDetail.asOf가 실시간(진행 중인 봉)인지 장마감(완성 봉)인지.
import { describe, expect, it } from "vitest";
import type { Quote } from "../api/types";
import { stockAsOfBasis } from "./quote";

const quote = (over: Partial<Quote>): Quote => ({
  symbol: "005930",
  name: "삼성전자",
  currency: "KRW",
  price: 71_200,
  prevClose: 70_500,
  change: 700,
  changeRate: 0.0099,
  asOf: "2026-10-06T10:00:05+09:00",
  basis: "live",
  ...over,
});

describe("stockAsOfBasis", () => {
  it("실시간 시세이고 asOf가 quote.asOf와 같으면(마지막 봉이 오늘 진행 중) live", () => {
    expect(stockAsOfBasis({ asOf: "2026-10-06T10:00:05+09:00", quote: quote({}) })).toBe("live");
  });

  it("완성 봉의 정규장 종료 시각이면 시세가 실시간이어도 close (장이 닫힌 뒤·주말)", () => {
    expect(stockAsOfBasis({ asOf: "2026-10-05T15:30:00+09:00", quote: quote({}) })).toBe("close");
  });

  it("현재가를 받지 못한 종목(basis close)이거나 asOf가 없으면 close", () => {
    const close = quote({ basis: "close", asOf: "2026-10-05T15:30:00+09:00" });
    expect(stockAsOfBasis({ asOf: close.asOf, quote: close })).toBe("close");
    expect(stockAsOfBasis({ asOf: null, quote: quote({ price: null, asOf: null, basis: "close" }) })).toBe("close");
  });
});
