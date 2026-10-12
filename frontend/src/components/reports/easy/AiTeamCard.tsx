// PC(lg) 쉬운 보기에서 만드는 중·만들지 못한 리포트의 오른쪽 열 카드 = "지금 상황 한 문장"과 "기다리는 동안(끝나면 다음에) 할 수 있는 일".
// 단계별 상태는 왼쪽 진행 표시 한 곳만 말한다 — 여기서 다섯 담당을 다시 그리면 같은 내용이 다른 말(대기·완료 …)로 두 번 보인다 (리뷰 2·5·6).
// 한 문장은 왼쪽과 같은 자료(Trace → lib progressOf, 예시 재생 중이면 그 사건)와 같은 결과(outcome)로 정해 서로 반대로 말하지 않는다:
// 예시가 완성됐거나 작성·검토가 끝났으면 선택 조사(뉴스 등)를 못 했어도 '끝났어요'다 ("뉴스 없이 끝냈어요").
// PC에서만 그린다(EasyReport가 useIsPc로) — 모바일은 진행 표시가 같은 말을 한다.
import { Link } from "react-router";
import type { ReportDetail, TraceEvent } from "../../../api/types";
import { cn } from "../../../lib/cn";
import { failureReasonOf } from "../../../lib/plainText";
import { progressOf, stoppedStepIndex } from "../../../lib/reports";
import { Icon } from "../../Icon";
import { Card, LiveDot } from "../../ui";
import { type TeamOutcome, stockTeam, teamHeadline } from "./teamStatus";

const NEXT_LINK = "press-row -mx-2 flex min-h-11 items-center gap-2.5 rounded-xl px-2 text-[14px] font-semibold hover:bg-fill";

const TONE: Record<TeamOutcome, string> = { running: "bg-brand-soft", completed: "bg-ok-soft", failed: "bg-up-soft" };

/** 끝난 뒤·기다리는 동안 갈 곳. 제목·안내는 결과마다 다르다 (끝난 예시에 '기다리는 동안'을 남기지 않는다). */
const NEXT: Record<TeamOutcome, { title: string; body: string | null }> = {
  running: { title: "기다리는 동안", body: "완성되면 알림으로 알려 드려요." },
  completed: { title: "다음에 해 볼 일", body: "예시는 여기까지예요. 완성된 팀 리포트를 읽어 보거나 AI가 제안한 매매 계획을 살펴보세요." },
  failed: { title: "다른 길도 있어요", body: null },
};

export function AiTeamCard({ r, trace, outcome, className }: { r: ReportDetail; trace: TraceEvent[]; outcome: TeamOutcome; className?: string }) {
  const steps = progressOf(trace, r.team);
  // 실제 실패는 실패 사유로, 예시 실패는 그 사건으로 멈춘 곳을 찾는다
  const stopAt = outcome === "failed" ? stoppedStepIndex(steps, r.status === "failed" ? failureReasonOf(r.trace) : null, trace) : -1;
  const line = teamHeadline(steps, outcome, stopAt, r.status === "requested", r.team);
  const live = outcome === "running" && steps.some((s) => s.state === "active" || s.state === "again");
  const next = NEXT[outcome];
  return (
    <Card aria-labelledby="team-title" className={cn("space-y-4", className)}>
      <div>
        <h2 id="team-title" className="text-[16px] font-bold">
          지금 상황
        </h2>
        <p className={cn("mt-2 flex items-center gap-2.5 rounded-xl px-3.5 py-3 text-[16px] leading-snug font-bold", TONE[outcome])}>
          {outcome === "running" ? (
            live ? (
              <LiveDot className="mx-1" />
            ) : (
              <Icon name="clock" className="size-5 shrink-0 text-brand-ink" />
            )
          ) : (
            <Icon
              name={outcome === "completed" ? "check-circle" : "alert-circle"}
              className={cn("size-5 shrink-0", outcome === "completed" ? "text-ok-ink" : "text-up-ink")}
            />
          )}
          <span className="min-w-0">{line}</span>
        </p>
        {outcome === "running" && stockTeam(r.team) && (
          <p className="mt-2 text-[13px] leading-snug text-sub">시세·재무·뉴스 담당이 함께 조사하면, 작성 담당이 리포트를 쓰고 검토 담당이 근거를 확인해요.</p>
        )}
      </div>
      <div className="border-t border-line pt-3">
        <h3 className="text-[14px] font-bold">{next.title}</h3>
        {next.body && <p className="mt-0.5 text-[13px] leading-snug text-sub">{next.body}</p>}
        <ul className="mt-1.5">
          <li>
            <Link to="/reports" className={NEXT_LINK}>
              <Icon name="doc" className="size-4 shrink-0 text-brand-ink" />
              <span className="min-w-0 flex-1">팀 리포트 둘러보기</span>
              <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
            </Link>
          </li>
          <li>
            <Link to="/recommendations" className={NEXT_LINK}>
              <Icon name="flow" className="size-4 shrink-0 text-brand-ink" />
              <span className="min-w-0 flex-1">AI 계획 제안 보기</span>
              <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
            </Link>
          </li>
          {outcome !== "failed" && (
            <li>
              <Link to="/my#notification-settings" className={NEXT_LINK}>
                <Icon name="bell" className="size-4 shrink-0 text-brand-ink" />
                <span className="min-w-0 flex-1">알림 설정 보기</span>
                <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
              </Link>
            </li>
          )}
        </ul>
      </div>
    </Card>
  );
}
