// 홈의 "만드는 중인 리포트": 내가 만든 리포트 중 아직 끝나지 않은 것. 없으면 그리지 않는다.
// - 나타나고 사라질 때 높이가 펼쳐지고 접힌다 (Collapse — 늦게 와도 아래 내용이 툭 밀리지 않게). 간격도 펼쳐지는 안쪽에 둔다.
// - 만드는 중은 LiveDot(퍼지는 초록 점 — 오래 이어지는 '진행 중'), 대기 중은 점 없이. 아이콘은 움직이지 않는다.
// - 다 만들어지면 그 행을 '완성됐어요 · 보기'로 잠깐 남긴다 (최근 AI 리포트에 나타날 때까지 빈틈을 메운다), 그 뒤 접힌다.
import { useId } from "react";
import { Link } from "react-router";
import type { ReportSummary } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";
import { formatRelative } from "../../lib/format";
import { REPORT_KEEPS_RUNNING, reportStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { LiveDot } from "../ui";
import { inProgressReports } from "./homeData";
import { useJustFinished } from "./homeHooks";
import { HOME_ROW, HOME_ROW_ABOVE, RowChevron } from "./HomeStates";
import { SectionHead } from "./SectionHead";

function RunningItem({ r, easy, row }: { r: ReportSummary; easy: boolean; row: string }) {
  const id = useId();
  return (
    <li>
      <Link to={`/reports/${r.id}`} aria-label={`${r.name} 리포트 진행 보기`} aria-describedby={`${id}-s`} className={row}>
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-soft text-brand-ink" aria-hidden="true">
          <Icon name="doc" className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold">{r.name}</span>
          <span id={`${id}-s`} className="flex items-center gap-1.5 text-[13px] text-mute">
            {r.status === "running" && <LiveDot />}
            {reportStatusText(r.status, easy)} · {formatRelative(r.createdAt)} 신청
          </span>
        </span>
        <RowChevron />
      </Link>
    </li>
  );
}

/** 방금 끝난 리포트: 바뀐 행이 제자리에서 한 번 페이드된다 (key가 바뀌어 새로 그린다). */
function FinishedItem({ r, easy, row }: { r: ReportSummary; easy: boolean; row: string }) {
  const ok = r.status === "completed";
  const word = ok ? (easy ? "완성됐어요" : "완료") : easy ? "만들지 못했어요" : "실패";
  return (
    <li>
      <Link to={`/reports/${r.id}`} aria-label={`${r.name} 리포트 ${word} · 보기`} className={cn(row, "reveal-fade")}>
        <span
          aria-hidden="true"
          className={cn("grid size-9 shrink-0 place-items-center rounded-full", ok ? "bg-ok-soft text-ok" : "bg-up-soft text-up-ink")}
        >
          <Icon name={ok ? "check" : "alert"} className="size-4 animate-pop-in" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[16px] font-semibold">{r.name}</span>
          <span className={cn("block text-[13px] font-semibold", ok ? "text-ink" : "text-up-ink")}>{word} · 보기</span>
        </span>
        <RowChevron />
      </Link>
    </li>
  );
}

/** mine: 내 리포트 목록 (useReports({mine: true})의 results, 아직 받지 않았으면 undefined). */
export function ReportsInProgress({ mine, view }: { mine: readonly ReportSummary[] | undefined; view: ViewMode }) {
  const list = inProgressReports(mine ?? []);
  const finished = useJustFinished(mine);
  const easy = view === "easy";
  const open = list.length > 0 || finished.length > 0;
  // 만드는 중이면 목록 아래 같은 카드에 안내 한 줄이 이어진다 — 마지막 행도 아래 모서리를 둥글리지 않는다
  const row = list.length > 0 ? HOME_ROW_ABOVE : HOME_ROW;
  return (
    // 부모의 space-y 간격 대신 안쪽 pb-6 — 펼쳐지고 접힐 때 간격까지 같이 움직인다
    <Collapse open={open} className="mb-0">
      <section aria-labelledby="home-running-title" className="space-y-3 pb-6">
        <SectionHead id="home-running-title" title={list.length > 0 ? `만드는 중인 리포트 ${list.length}개` : "방금 끝난 리포트"} />
        <div className="overflow-hidden rounded-2xl bg-card">
          <ul aria-label="만드는 중인 리포트 목록" className="divide-y divide-line">
            {finished.map((r) => (
              <FinishedItem key={`done-${r.id}`} r={r} easy={easy} row={row} />
            ))}
            {list.map((r) => (
              <RunningItem key={r.id} r={r} easy={easy} row={row} />
            ))}
          </ul>
          {list.length > 0 && <p className="border-t border-line px-5 py-3 text-[13px] leading-snug text-sub">{REPORT_KEEPS_RUNNING}</p>}
        </div>
      </section>
    </Collapse>
  );
}
