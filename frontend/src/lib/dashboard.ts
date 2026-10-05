import type { AnalysisSummary } from "../api/types";

/**
 * 홈에 보이는 교차검증 분석 수 (PC 2×2, 모바일 4장). 홈은 요약과 입구라 팀이 분석을 쌓아도 길어지지 않게 하고,
 * 전체 목록은 리포트 탭의 '교차검증 분석' 묶음(/reports?list=analyses)이 맡는다.
 */
export const DASHBOARD_SHOWN = 4;

/** 종목마다 가장 최근 분석 하나만, BUY 먼저 → 최신순. */
export function dashboardOrder(list: AnalysisSummary[]): AnalysisSummary[] {
  const latest = new Map<string, AnalysisSummary>();
  for (const a of list) {
    const prev = latest.get(a.symbol);
    if (!prev || a.analyzedAt > prev.analyzedAt) latest.set(a.symbol, a);
  }
  return [...latest.values()].sort(
    (a, b) => Number(b.verdict === "BUY") - Number(a.verdict === "BUY") || b.analyzedAt.localeCompare(a.analyzedAt),
  );
}
