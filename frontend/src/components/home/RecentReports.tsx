// 홈의 "최근 AI 리포트": 팀이 최근 완성한 리포트 3개 (자동 리포트가 있으면 그것부터). AI 의견 배지 + 한 줄 요약.
// 쉬운 보기는 "AI 의견: 긍정적" 같은 쉬운 이름, 전문가 보기는 원래 용어(매수·보유·회피). 배지는 리포트 화면과 같은 것(reports/OpinionBadge).
// 완성된 리포트만 보인다(homeData pickRecentReports) — 남의 실패·자동 리포트 실패는 팀 피드에 나오지 않는다 (UX-15). 한 줄 요약은 리포트 화면과 같이 다듬는다(cleanReportText).
import { useId } from "react";
import { Link } from "react-router";
import { useReports } from "../../api/queries";
import type { ReportSummary } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { revealList, useRevealAfterLoading } from "../../hooks/useMotionState";
import { formatDateTime } from "../../lib/format";
import { cleanReportText } from "../../lib/reports";
import { OpinionBadge } from "../reports/OpinionBadge";
import { pickRecentReports } from "./homeData";
import { useShownCount } from "./homeHooks";
import { EmptyRow, HOME_ROW, RowChevron, RowsSkeleton, SectionError } from "./HomeStates";
import { SectionHead } from "./SectionHead";

function ReportItem({ r, easy }: { r: ReportSummary; easy: boolean }) {
  const id = useId();
  return (
    <li>
      {/* 링크 이름은 짧게, AI 의견·한 줄 요약은 이어서 읽힌다 (aria-describedby) — 보이는 결론을 화면 읽기도 목록에서 바로 듣게 */}
      <Link
        to={`/reports/${r.id}`}
        aria-label={`${r.name} AI 리포트 보기`}
        aria-describedby={r.oneLiner ? `${id}-o ${id}-l` : `${id}-o`}
        className={HOME_ROW}
      >
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[16px] font-semibold">{r.name}</span>
            <span id={`${id}-o`}>
              <OpinionBadge opinion={r.opinion} expert={!easy} labeled />
            </span>
          </p>
          {r.oneLiner && (
            <p id={`${id}-l`} className="mt-0.5 line-clamp-2 text-[14px] leading-snug text-sub">
              {cleanReportText(r.oneLiner)}
            </p>
          )}
          <p className="mt-0.5 text-[12px] text-mute tabular-nums">
            {formatDateTime(r.finishedAt ?? r.createdAt)} · {r.source === "auto" ? "자동" : `${r.requestedBy} 님이 만듦`}
          </p>
        </div>
        <RowChevron />
      </Link>
    </li>
  );
}

export function RecentReports({ view }: { view: ViewMode }) {
  const { data, isPending, isFetching, refetch } = useReports({ limit: 30 });
  const reveal = useRevealAfterLoading(isPending);
  const list = pickRecentReports(data?.results ?? []);
  const easy = view === "easy";
  // 받기 전 자리: 지난번에 본 행 수만큼 (기억이 없으면 3줄 — 팀이 완성한 리포트는 보통 있다)
  const rows = useShownCount("reports", data ? list.length : undefined, 3);
  return (
    <section aria-labelledby="home-reports-title" className="space-y-3">
      <SectionHead id="home-reports-title" title="최근 AI 리포트" to="/reports" />
      {isPending ? (
        <RowsSkeleton rows={rows} shape="report" />
      ) : !data ? (
        <SectionError onRetry={() => void refetch()} retrying={isFetching} />
      ) : list.length === 0 ? (
        <EmptyRow icon="doc" className={reveal ? "reveal-fade" : undefined}>
          {easy ? "아직 완성된 리포트가 없어요. 종목 상세에서 AI 리포트를 만들 수 있어요." : "완성된 리포트가 아직 없습니다."}
        </EmptyRow>
      ) : (
        <ul {...revealList(reveal)} aria-label="최근 AI 리포트 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((r) => (
            <ReportItem key={r.id} r={r} easy={easy} />
          ))}
        </ul>
      )}
    </section>
  );
}
