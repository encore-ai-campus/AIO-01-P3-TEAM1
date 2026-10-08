// 직접 주문(종목 상세 주문 패널)의 쉬운 결과 문장 (UX-6)과 오늘 산 종목 표기 (UX-1, docs/API.md "장마감 기준"의 "오늘 산 종목").
// - 쉬운 보기의 토스트는 서버 원문(`[모의 체결 #3] … @ 32,450원 (수수료 5원, 요청 …)`) 대신 응답 숫자로 만든 정해진 문장이다. 전문가 보기는 원문 그대로.
// - 주문·체결·예약을 말하는 쉬운 문장에는 "모의"를 꼭 넣는다. 권유 표현을 쓰지 않는다 (docs/API.md "금지 표현").
import type { Market, OrderResult, Position } from "../api/types";
import { formatOpensAt } from "./autotrade";
import { formatPrice, formatQty, formatSignedKrw } from "./format";

/** 예약 문장: "모의 계좌에서 10월 9일(금) 오전 9시에 {무엇}하도록 예약했어요" (실행 예정 시각을 모르면 "다음 정규장이 열리면 모의 계좌에서 …"). */
const reservedText = (runAt: string | null | undefined, market: Market, what: string) =>
  runAt ? `모의 계좌에서 ${formatOpensAt(runAt, market)}에 ${what}도록 예약했어요` : `다음 정규장이 열리면 모의 계좌에서 ${what}도록 예약했어요`;

/**
 * 매수 결과 한 문장 (쉬운 보기 토스트 · '왜 샀나요?' 맨 위 결과 띠): 체결·예약·체결 대기를 구분한다.
 * 예: "모의 계좌에서 카카오 1주를 32,450원에 샀어요" · "모의 계좌에서 10월 9일(금) 오전 9시에 카카오 1주를 사도록 예약했어요".
 */
export function buyResultText(res: OrderResult, name: string, market: Market): string {
  const o = res.order;
  const r = res.reservation;
  if (r) return reservedText(r.runAt, market, `${name} ${formatQty(r.quantity)}를 사`);
  if (o?.status === "EXIT_WATCHING") return `모의 계좌에서 ${name} ${formatQty(o.quantity)}를 ${formatPrice(o.fillPrice ?? o.entryPrice, o.currency)}에 샀어요`;
  if (o?.status === "ENTRY_PENDING") {
    return `${name} ${formatQty(o.quantity)}를 ${formatPrice(o.limitPrice ?? o.entryPrice, o.currency)} 이하가 되면 사요 (모의 계좌 체결 대기)`;
  }
  return res.message;
}

/**
 * 팔기('모두 팔기') 결과 한 문장 (쉬운 보기 토스트). 손익은 실현 손익(수수료·세금 포함)이다.
 * 예: "모의 계좌에서 카카오 1주를 32,450원에 팔았어요 · 손익 -75원 (수수료·세금 포함)".
 */
export function sellResultText(res: OrderResult, name: string, market: Market): string {
  const o = res.order;
  const r = res.reservation;
  if (r) return reservedText(r.runAt, market, `${name} ${formatQty(r.quantity)}를 모두 팔`);
  if (o?.status === "CLOSED") {
    const pnl = o.pnlKrw != null ? ` · 손익 ${formatSignedKrw(o.pnlKrw)} (수수료·세금 포함)` : "";
    return `모의 계좌에서 ${name} ${formatQty(o.quantity)}를 ${formatPrice(o.exitPrice, o.currency)}에 팔았어요${pnl}`;
  }
  if (o?.status === "CANCELED") return `${name} 모의 주문을 취소했어요 (아직 사지 않은 주문이었어요)`;
  return res.message;
}

/** 취소 토스트 (쉬운 보기는 "모의"를 넣는다). */
export const CANCEL_TEXT = {
  order: { easy: "모의 주문을 취소했어요.", expert: "주문을 취소했어요." },
  buyReservation: { easy: "모의 계좌에서 사도록 한 예약을 취소했어요.", expert: "예약을 취소했어요." },
  sellReservation: { easy: "모의 계좌에서 팔도록 한 예약을 취소했어요.", expert: "매도 예약을 취소했어요." },
} as const;

/** 오늘 산 종목이 그날 종가로 평가되기 시작하는 시각 (그 시장의 장마감 기준일이 오늘로 바뀌는 때 — 정규장 종료 + 10분). */
const SETTLE_AT: Record<Market, string> = { KR: "15:40", US: "뉴욕 16:10" };

/** 오늘 산 종목(장마감 기준 시각 뒤에 산 보유)이라 체결가로 평가했는지. priceBasis가 없으면 close로 본다. */
export const isTodayFill = (p: Pick<Position, "priceBasis"> | null | undefined): boolean => p?.priceBasis === "today_fill";

/** 오늘 산 종목 한 줄 (종가·손익 대신): 쉬운 보기 "오늘 산 종목 · 장 마감(15:40) 뒤에 평가돼요", 전문가 보기 "당일 매수 · 15:40 이후 종가 평가". */
export function todayFillText(market: Market, easy: boolean): string {
  return easy ? `오늘 산 종목 · 장 마감(${SETTLE_AT[market]}) 뒤에 평가돼요` : `당일 매수 · ${SETTLE_AT[market]} 이후 종가 평가`;
}

/** 계좌 요약(홈 자산 카드 등) 안내: 오늘 산 종목이 있는 시장들 (없으면 null). */
export function todayFillNote(positions: readonly Pick<Position, "market" | "priceBasis">[], easy: boolean): string | null {
  const markets = (["KR", "US"] as const).filter((m) => positions.some((p) => p.market === m && isTodayFill(p)));
  if (markets.length === 0) return null;
  const at = markets.map((m) => SETTLE_AT[m]).join(" · ");
  return easy ? `오늘 산 종목은 산 가격으로 셈하고, 장 마감(${at}) 뒤에 평가돼요` : `당일 매수 종목은 체결가로 계산 · ${at} 이후 종가 평가`;
}
