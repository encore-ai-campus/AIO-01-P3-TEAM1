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

/** 규칙 선별 결과 (점수 순 후보 8개). 예시 선별 셋이 같이 쓴다. */
function ruleCandidates(): Record<string, unknown>[] {
  return [
    { symbol: "005930", name: "삼성전자", score: 82, tradingAmountRank: 1 },
    { symbol: "000660", name: "SK하이닉스", score: 77, tradingAmountRank: 2 },
    { symbol: "005380", name: "현대차", score: 71, tradingAmountRank: 6 },
    { symbol: "042700", name: "한미반도체", score: 69, tradingAmountRank: 9 },
    { symbol: "086520", name: "에코프로", score: 66, tradingAmountRank: 4 },
    { symbol: "035420", name: "NAVER", score: 63, tradingAmountRank: 11 },
    { symbol: "373220", name: "LG에너지솔루션", score: 61, tradingAmountRank: 7 },
    { symbol: "105560", name: "KB금융", score: 58, tradingAmountRank: 14 },
  ];
}

/** 선정 키가 없는 부분 (예전 파일 모양 그대로). */
function screeningBase(): ScreeningResult {
  return {
    market: "KR",
    at: "2026-10-04T08:40:00+09:00",
    rankCount: 50,
    eligibleCount: 31,
    checked: 12,
    picks: ruleCandidates().slice(0, 3),
    dropped: [
      { symbol: "035720", name: "카카오", reason: "20일선 아래" },
      { symbol: "068270", name: "셀트리온", reason: "거래대금 급감" },
      { symbol: "051910", name: "LG화학", reason: "20일선 아래" },
    ],
    excluded: [{ symbol: "069500", name: "KODEX 200", reason: "ETF" }],
    reportIds: [],
  };
}

/**
 * AI 선정 팀이 고른 날의 선별 결과: AI 순위 5개 중 같은 테마 셋째·투자유의 종목을 안전장치(선정 Guard)가 빼고 셋을 남겼다.
 * selection.reportId는 null — 서버가 없을 때(404) 보이는 예시라 다른 리포트로 가는 길을 만들지 않는다 (가짜 API는 자기 선정 실행 번호로 바꾼다).
 */
export function sampleScreening(): ScreeningResult {
  const byCode = new Map(ruleCandidates().map((c) => [c.symbol, c]));
  const pick = (symbol: string, aiRank: number | null, aiReason: string | null, theme: string | null, filledByRule = false) => ({
    ...byCode.get(symbol),
    aiRank,
    aiReason,
    theme,
    filledByRule,
  });
  return {
    ...screeningBase(),
    candidates: ruleCandidates(),
    selection: { reportId: null, status: "done" },
    selectedBy: "ai",
    fallbackReason: null,
    aiPicks: [
      { symbol: "000660", rank: 1, reason: "HBM 공급 확대 뉴스가 이어졌고 외국인 순매수가 사흘째예요", evidence: ["뉴스: HBM 공급 확대 (10월 3일)", "수급: 외국인 3일 순매수"] },
      { symbol: "005930", rank: 2, reason: "거래대금 1위이고 공시에 위험 신호가 없었어요", evidence: ["공시: 위험 신호 없음"] },
      { symbol: "042700", rank: 3, reason: "장비 수주 공시가 있었어요", evidence: ["공시: 단일판매·공급계약 체결 (10월 2일)"] },
      { symbol: "086520", rank: 4, reason: "거래대금이 늘며 20일선 위로 올라왔어요", evidence: ["시세: 20일선 위"] },
      { symbol: "005380", rank: 5, reason: "신차 판매 뉴스가 있었고 기관 순매수가 이어졌어요", evidence: ["뉴스: 신차 판매 (10월 2일)", "수급: 기관 순매수"] },
    ],
    filtered: [
      { symbol: "042700", name: "한미반도체", reason: "같은 테마(반도체) 종목이 이미 2개예요", stage: "theme" },
      { symbol: "086520", name: "에코프로", reason: "투자유의: 투자경고 종목", stage: "warnings" },
    ],
    picks: [
      pick("000660", 1, "HBM 공급 확대 뉴스가 이어졌고 외국인 순매수가 사흘째예요", "반도체"),
      pick("005930", 2, "거래대금 1위이고 공시에 위험 신호가 없었어요", "반도체"),
      pick("005380", 5, "신차 판매 뉴스가 있었고 기관 순매수가 이어졌어요", "자동차"),
    ],
    coverSent: false,
  };
}

/** AI 선정 팀이 실패해 규칙 점수 상위로 고른 날 (Fallback). reason: fallbackReason 코드. */
export function sampleRuleScreening(reason = "join_blocked"): ScreeningResult {
  const none = reason === "no_candidates";
  return {
    ...screeningBase(),
    candidates: none ? [] : ruleCandidates(),
    picks: none ? [] : ruleCandidates().slice(0, 3).map((p) => ({ ...p, aiRank: null, aiReason: null, theme: null, filledByRule: true })),
    selection: { reportId: none ? null : 41, status: "done" },
    selectedBy: "rule",
    fallbackReason: reason,
    aiPicks: [],
    filtered: [],
    coverSent: false,
  };
}

/** AI 선정 팀이 고르는 중 (picks는 그때까지 규칙 상위 셋 — 시연 추천과 호환). */
export function sampleRunningScreening(reportId = 41): ScreeningResult {
  return {
    ...screeningBase(),
    candidates: ruleCandidates(),
    selection: { reportId, status: "running" },
    selectedBy: null,
    fallbackReason: null,
    aiPicks: [],
    filtered: [],
    coverSent: false,
  };
}
