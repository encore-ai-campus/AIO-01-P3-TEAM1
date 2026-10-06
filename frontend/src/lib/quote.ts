// 시세(Quote)·종목 상세(StockDetail)의 가격 기준 판단 (docs/API.md 공통 규칙 "실시간 시세").
import type { QuoteBasis, StockDetail } from "../api/types";

/**
 * StockDetail.asOf가 무슨 기준의 시각인지: 마지막 봉이 오늘 진행 중이면 서버가 quote.asOf와 같은 값(실시간 시세를 받은 시각)을 주고,
 * 완성 봉이면 그 봉 날짜의 정규장 종료 시각이다. 값이 quote.asOf와 같고 시세가 실시간이면 "live", 아니면 "close".
 */
export function stockAsOfBasis(stock: Pick<StockDetail, "asOf" | "quote">): QuoteBasis {
  return stock.quote.basis === "live" && stock.asOf !== null && stock.asOf === stock.quote.asOf ? "live" : "close";
}
