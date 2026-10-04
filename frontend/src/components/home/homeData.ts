// 홈 카드가 목록에서 무엇을 고르는지 (화면 없이 테스트한다).
import type { ReportSummary } from "../../api/types";

/** 완성된 리포트 중 자동 리포트를 먼저, 그다음 받은 순서(최신순)로 n개. */
export function pickRecentReports(list: readonly ReportSummary[], n = 3): ReportSummary[] {
  const done = list.filter((r) => r.status === "completed");
  const auto = done.filter((r) => r.source === "auto");
  const rest = done.filter((r) => r.source !== "auto");
  return [...auto, ...rest].slice(0, n);
}

/** 아직 끝나지 않은 리포트 (대기 중·만드는 중). */
export function inProgressReports(list: readonly ReportSummary[]): ReportSummary[] {
  return list.filter((r) => r.status === "requested" || r.status === "running");
}
