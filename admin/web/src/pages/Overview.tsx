import { Link } from "react-router";
import type { Overview as OverviewData, OverviewItem } from "../api";
import { LevelBadge, Loaded, PageHeader } from "../components/ui";
import { fmtTime } from "../format";
import { POLL_FAST, useApi } from "../hooks";

const LINK: Record<OverviewItem["key"], string> = {
  service: "/service",
  engine: "/engine",
  deploys: "/deploys",
  reports: "/reports",
  recovery: "/recovery",
  costs: "/costs",
  alerts: "/alerts",
};

export default function Overview() {
  const q = useApi<OverviewData>("/api/admin/overview", POLL_FAST);
  return (
    <>
      <PageHeader title="개요" />
      <Loaded q={q}>
        {(d) => (
          <>
            <p className="overall">
              전체 <LevelBadge level={d.level} /> <span className="muted">기준 시각 {fmtTime(d.at)}</span>
            </p>
            {/* 서버가 준 순서(나쁜 것부터) 그대로 */}
            <ol className="overview-list">
              {d.items.map((it) => (
                <li key={it.key} className={`overview-item lv-border-${it.level}`}>
                  <LevelBadge level={it.level} />
                  <div className="overview-text">
                    <strong>{it.title}</strong>
                    <span>{it.summary}</span>
                  </div>
                  <Link to={LINK[it.key]}>자세히</Link>
                </li>
              ))}
            </ol>
          </>
        )}
      </Loaded>
    </>
  );
}
