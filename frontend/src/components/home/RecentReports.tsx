// 홈의 "최근 AI 리포트": 팀이 최근 완성한 리포트 3개 (자동 리포트가 있으면 그것부터). AI 의견 배지 + 한 줄 요약.
// 쉬운 보기는 "AI 의견: 긍정적" 같은 쉬운 이름, 전문가 보기는 원래 용어(매수·보유·회피). 배지는 리포트 화면과 같은 것(reports/OpinionBadge).
import { Link } from "react-router";
import { useReports } from "../../api/queries";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { formatDateTime } from "../../lib/format";
import { Icon } from "../Icon";
import { OpinionBadge } from "../reports/OpinionBadge";
import { Skeleton } from "../ui";
import { pickRecentReports } from "./homeData";
import { SectionHead } from "./SectionHead";

export function RecentReports({ view }: { view: ViewMode }) {
  const { data, isPending } = useReports({ limit: 30 });
  const list = pickRecentReports(data?.results ?? []);
  const easy = view === "easy";
  return (
    <section aria-labelledby="home-reports-title" className="space-y-3">
      <SectionHead id="home-reports-title" title="최근 AI 리포트" to="/reports" more="전체 보기" />
      {isPending ? (
        <Skeleton className="h-24 w-full rounded-2xl" />
      ) : list.length === 0 ? (
        <p className="rounded-2xl bg-card px-5 py-4 text-[15px] text-mute">
          {easy ? "아직 완성된 리포트가 없어요. 종목 상세에서 AI 리포트를 만들 수 있어요." : "완성된 리포트가 아직 없습니다."}
        </p>
      ) : (
        <ul aria-label="최근 AI 리포트 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((r) => (
            <li key={r.id}>
              <Link to={`/reports/${r.id}`} aria-label={`${r.name} AI 리포트 보기`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-fill/60">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[16px] font-semibold">{r.name}</span>
                    <OpinionBadge opinion={r.opinion} expert={!easy} labeled />
                  </p>
                  {r.oneLiner && <p className="mt-0.5 line-clamp-2 text-[14px] leading-snug text-sub">{r.oneLiner}</p>}
                  <p className="mt-0.5 text-[12px] text-mute tabular-nums">
                    {formatDateTime(r.finishedAt ?? r.createdAt)} · {r.source === "auto" ? "자동" : `${r.requestedBy} 님이 만듦`}
                  </p>
                </div>
                <Icon name="chevron" className="size-4 shrink-0 text-mute" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
