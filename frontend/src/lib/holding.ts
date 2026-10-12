// 보유 평가 (종목 통화, 수수료·세금 빼기 전). 시세(Quote.price)와 체결가·수량으로 화면이 직접 계산한다 (docs/API.md "실시간 시세"의 "종목 화면의 내 보유").
// 종목 상세의 보유 블록·'내 모의 주문' 한 줄과 모의 자동매매 상세의 현재 손익이 한 식을 쓴다 — 홈·마이·랭킹은 서버가 낸 장마감 기준 값을 그대로 쓰고 이 함수를 쓰지 않는다.
import type { QuoteBasis } from "../api/types";

export interface HoldingValue {
  /** 평가 금액 = 가격 × 수량 */
  value: number;
  /** 평가 손익 = (가격 − 체결가) × 수량 (체결가를 모르면 null) */
  profit: number | null;
  /** 수익률 = 가격 ÷ 체결가 − 1 (체결가를 모르거나 0이면 null) */
  rate: number | null;
}

/**
 * 가격으로 평가한 보유 값. 가격을 모르면(시세를 받지 못함) null — 부른 쪽이 서버가 낸 값(Position)으로 돌아간다.
 * 체결가(avgPrice)를 모르면 평가 금액만 낸다 (아직 체결 전인 계획 등 — profit·rate는 null).
 */
export function holdingValue(input: { price: number | null | undefined; avgPrice: number | null | undefined; quantity: number }): HoldingValue | null {
  const { price, avgPrice, quantity } = input;
  if (price == null) return null;
  return {
    value: price * quantity,
    profit: avgPrice != null ? (price - avgPrice) * quantity : null,
    rate: avgPrice ? price / avgPrice - 1 : null,
  };
}

/**
 * 종목 화면의 내 보유 평가: 시세 가격으로 평가한다 (오늘 산 종목도 실시간 가격이면 그대로 — 체결가와 지금 가격의 차이는 진짜 손익이다).
 * 단 오늘 산 종목(todayFill — 계좌를 아직 받지 못해 모르면 부른 쪽이 true로 준다)인데 시세가 직전 종가(basis "close" — 현재가를 받지 못함)이면 null:
 * 체결가를 어제 종가와 견주면 가짜 손익이라, 부른 쪽이 서버 값(Position — 체결가로 평가, 장 마감 뒤 종가)으로 돌아간다.
 */
export function quoteHolding(
  quote: { price: number | null; basis: QuoteBasis },
  holding: { avgPrice: number | null | undefined; quantity: number; todayFill: boolean },
): HoldingValue | null {
  if (holding.todayFill && quote.basis !== "live") return null;
  return holdingValue({ price: quote.price, avgPrice: holding.avgPrice, quantity: holding.quantity });
}
