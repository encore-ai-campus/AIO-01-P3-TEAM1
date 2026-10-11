import { describe, expect, it } from "vitest";
import { holdingValue, quoteHolding } from "./holding";

describe("holdingValue (보유 평가: 가격 × 수량, 종목 통화, 비용 전)", () => {
  it("평가 금액·손익·수익률을 가격과 체결가·수량으로 셈한다", () => {
    const h = holdingValue({ price: 77_000, avgPrice: 70_000, quantity: 10 });
    expect(h).not.toBeNull();
    expect(h!.value).toBe(770_000);
    expect(h!.profit).toBe(70_000);
    expect(h!.rate).toBeCloseTo(0.1, 10);
  });

  it("가격이 체결가보다 낮으면 손익·수익률이 음수", () => {
    const h = holdingValue({ price: 63_000, avgPrice: 70_000, quantity: 3 });
    expect(h!.value).toBe(189_000);
    expect(h!.profit).toBe(-21_000);
    expect(h!.rate).toBeCloseTo(-0.1, 10);
  });

  it("미국 종목은 달러 그대로 (환율을 곱하지 않는다), 소수점 수량도 된다", () => {
    const h = holdingValue({ price: 200, avgPrice: 180, quantity: 2.5 });
    expect(h!.value).toBe(500);
    expect(h!.profit).toBe(50);
    expect(h!.rate).toBeCloseTo(200 / 180 - 1, 10);
  });

  it("가격이 없으면(시세를 받지 못함) null — 부른 쪽이 서버 값으로 돌아간다", () => {
    expect(holdingValue({ price: null, avgPrice: 70_000, quantity: 10 })).toBeNull();
    expect(holdingValue({ price: undefined, avgPrice: 70_000, quantity: 10 })).toBeNull();
  });

  it("체결가를 모르면 평가 금액만 (손익·수익률은 null — 모의 자동매매 상세의 체결 전 계획과 같다)", () => {
    const h = holdingValue({ price: 77_000, avgPrice: null, quantity: 10 });
    expect(h).toEqual({ value: 770_000, profit: null, rate: null });
  });

  it("가격이 체결가와 같으면 손익 0, 수익률 0", () => {
    const h = holdingValue({ price: 70_000, avgPrice: 70_000, quantity: 10 });
    expect(h).toEqual({ value: 700_000, profit: 0, rate: 0 });
  });
});

describe("quoteHolding (종목 화면 보유: 시세로 평가, 오늘 산 종목은 실시간일 때만)", () => {
  const held = { avgPrice: 70_000, quantity: 10, todayFill: false };

  it("실시간 시세면 시세로 평가한다", () => {
    expect(quoteHolding({ price: 77_000, basis: "live" }, held)).toEqual({ value: 770_000, profit: 70_000, rate: 77_000 / 70_000 - 1 });
  });

  it("오늘 산 종목도 실시간 시세로 평가한다 (체결가와 지금 가격의 차이)", () => {
    const h = quoteHolding({ price: 71_000, basis: "live" }, { ...held, todayFill: true });
    expect(h!.value).toBe(710_000);
    expect(h!.profit).toBe(10_000);
  });

  it("직전 종가 시세(현재가를 받지 못함)면 보유는 종가로 평가하되, 오늘 산 종목은 null — 어제 종가와 견준 가짜 손익을 내지 않는다", () => {
    expect(quoteHolding({ price: 69_000, basis: "close" }, held)!.profit).toBe(-10_000);
    expect(quoteHolding({ price: 69_000, basis: "close" }, { ...held, todayFill: true })).toBeNull();
  });

  it("시세 가격이 null이면 null", () => {
    expect(quoteHolding({ price: null, basis: "live" }, held)).toBeNull();
    expect(quoteHolding({ price: null, basis: "close" }, held)).toBeNull();
  });
});
