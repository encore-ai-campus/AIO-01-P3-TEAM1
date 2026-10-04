// 홈의 "만드는 중인 리포트": 내가 만든 리포트 중 아직 끝나지 않은 것. 없으면 그리지 않는다.
import { Link } from "react-router";
import type { ReportSummary } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { formatRelative } from "../../lib/format";
import { REPORT_KEEPS_RUNNING, reportStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";
import { inProgressReports } from "./homeData";
import { SectionHead } from "./SectionHead";

/** mine: 내 리포트 목록 (useReports({mine: true})의 results). */
export function ReportsInProgress({ mine, view }: { mine: readonly ReportSummary[]; view: ViewMode }) {
  const list = inProgressReports(mine);
  if (list.length === 0) return null;
  const easy = view === "easy";
  return (
    <section aria-labelledby="home-running-title" className="space-y-3">
      <SectionHead id="home-running-title" title={`만드는 중인 리포트 ${list.length}개`} />
      <div className="overflow-hidden rounded-2xl bg-card">
        <ul aria-label="만드는 중인 리포트 목록" className="divide-y divide-line">
          {list.map((r) => (
            <li key={r.id}>
              <Link to={`/reports/${r.id}`} aria-label={`${r.name} 리포트 진행 보기`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-fill/60">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-dark" aria-hidden="true">
                  <Icon name="doc" className={r.status === "running" ? "size-4 animate-pulse" : "size-4"} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-semibold">{r.name}</span>
                  <span className="block text-[13px] text-mute">
                    {reportStatusText(r.status, easy)} · {formatRelative(r.createdAt)} 신청
                  </span>
                </span>
                <Icon name="chevron" className="size-4 shrink-0 text-mute" />
              </Link>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-5 py-3 text-[13px] leading-snug text-sub">{REPORT_KEEPS_RUNNING}</p>
      </div>
    </section>
  );
}
