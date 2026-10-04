// 복구 지표·선별 결과의 예시 데이터 (docs/API.md의 RecoveryStats·ScreeningResult 모양 그대로).
// 서버에 그 API가 아직 없을 때(404) 화면이 "예시" 표시와 함께 보여 주고, 가짜 API(src/mocks)도 같은 값을 돌려준다.
import type { RecoveryStats, ScreeningResult } from "../api/types";

export function sampleRecoveryStats(days: number): RecoveryStats {
  return {
    from: "2026-09-28",
    to: "2026-10-04",
    days,
    reports: 24,
    reportsWithFailures: 9,
    failures: 14,
    recovered: 12,
    unrecovered: 2,
    injected: 11,
    autoRecoveryRate: 85.7,
    meanRecoveryMs: 3420,
    byErrorType: [
      { errorType: "timeout", failures: 7, recovered: 7 },
      { errorType: "server_error", failures: 4, recovered: 3 },
      { errorType: "bad_output", failures: 3, recovered: 2 },
    ],
    byWorker: [
      { worker: "news_agent", failures: 6, recovered: 6 },
      { worker: "report_agent", failures: 4, recovered: 3 },
      { worker: "market_agent", failures: 2, recovered: 2 },
      { worker: "fundamental_agent", failures: 2, recovered: 1 },
    ],
    recent: [
      { reportId: 2, symbol: "005930", worker: "news_agent", errorType: "timeout", injected: true, recovered: true, recoveryMs: 3140, at: "2026-10-04T10:12:04+09:00" },
      { reportId: 2, symbol: "005930", worker: "report_agent", errorType: "bad_output", injected: true, recovered: true, recoveryMs: 5210, at: "2026-10-04T10:12:11+09:00" },
      { reportId: 1, symbol: "000660", worker: "fundamental_agent", errorType: "server_error", injected: false, recovered: false, recoveryMs: null, at: "2026-10-03T15:40:22+09:00" },
      { reportId: 1, symbol: "000660", worker: "market_agent", errorType: "timeout", injected: true, recovered: true, recoveryMs: 1890, at: "2026-10-03T15:40:09+09:00" },
    ],
  };
}

export function sampleScreening(): ScreeningResult {
  return {
    market: "KR",
    at: "2026-10-04T08:40:00+09:00",
    rankCount: 50,
    eligibleCount: 31,
    checked: 12,
    picks: [
      { symbol: "005930", name: "삼성전자", score: 82, tradingAmountRank: 1 },
      { symbol: "000660", name: "SK하이닉스", score: 77, tradingAmountRank: 2 },
      { symbol: "005380", name: "현대차", score: 71, tradingAmountRank: 6 },
    ],
    dropped: [
      { symbol: "035720", name: "카카오", reason: "20일선 아래" },
      { symbol: "068270", name: "셀트리온", reason: "거래대금 급감" },
      { symbol: "051910", name: "LG화학", reason: "20일선 아래" },
    ],
    excluded: [{ symbol: "069500", name: "KODEX 200", reason: "ETF" }],
    reportIds: [],
  };
}
