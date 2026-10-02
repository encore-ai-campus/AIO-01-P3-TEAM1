import type { AnalysisSummary } from "../api/types";

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
