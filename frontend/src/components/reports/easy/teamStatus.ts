// PC 쉬운 보기 오른쪽 '지금 상황' 카드(AiTeamCard)의 한 문장. 왼쪽 진행 표시와 같은 자료(progressOf 단계)·같은 결과로 정해
// 두 카드가 서로 반대로 말하지 않게 한다 (끝난 예시에 '다음 담당에게 넘기는 중'이라고 하지 않는다 — 리뷰 5).
import type { ProgressStep } from "../../../lib/reports";

/** running: 만드는 중(또는 차례 대기) · completed: 예시가 완성됨 · failed: 만들지 못함(실제 또는 예시). */
export type TeamOutcome = "running" | "completed" | "failed";

/** 종목 리포트 다섯 담당의 이름과 '~ 없이 끝냈어요'에 쓰는 짧은 이름. 다른 팀은 '한 담당'·'일부 조사'로 말한다. */
const ROLES = [
  { name: "시세 담당", short: "시세" },
  { name: "재무 담당", short: "재무" },
  { name: "뉴스 담당", short: "뉴스" },
  { name: "작성 담당", short: "작성" },
  { name: "검토 담당", short: "검토" },
];

export const stockTeam = (team: string | null | undefined) => team === "stock_report" || !team;

/** 지금 상황 한 문장 (왼쪽 진행 표시의 제목·단계와 같은 자료로). */
export function teamHeadline(steps: ProgressStep[], outcome: TeamOutcome, stopAt: number, requested: boolean, team?: string | null): string {
  if (outcome === "failed") return stopAt >= 0 && stockTeam(team) ? `${ROLES[stopAt]?.name ?? "한 담당"}에서 멈췄어요` : "중간에 멈췄어요";
  const writeAndReview = steps.slice(3);
  const finished = outcome === "completed" || (writeAndReview.length > 0 && writeAndReview.every((s) => s.state === "done"));
  if (finished) {
    const missed = steps.slice(0, 3).flatMap((s, i) => (s.state === "failed" || s.state === "skipped" ? [i] : []));
    if (missed.length === 0) return "모두 끝났어요";
    return stockTeam(team) ? `${missed.map((i) => ROLES[i].short).join("·")} 없이 끝냈어요` : "일부 조사 없이 끝냈어요";
  }
  const active = steps.slice(0, 3).filter((s) => s.state === "active");
  if (steps.every((s) => s.state === "waiting")) return requested ? "차례가 오면 세 담당이 동시에 조사를 시작해요" : "곧 조사를 시작해요";
  if (active.length > 0) return `${active.length}명이 동시에 조사하고 있어요`;
  if (steps[3]?.state === "active") return "조사 결과로 리포트를 쓰고 있어요";
  if (steps[4]?.state === "active" || steps[4]?.state === "again") return "근거와 사실을 확인하고 있어요";
  return "다음 담당에게 넘기는 중이에요";
}
