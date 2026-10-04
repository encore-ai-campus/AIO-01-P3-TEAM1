// 리포트 목록: 칩 "내 리포트 · 팀 리포트 · 교차검증 분석" (B8 ?mine=1, D-1). 고른 칩은 주소의 ?list=에 둔다 (기본 팀 리포트).
// 카드 = 종목 · AI 의견 배지 · 한 줄 요약 · 상태(대기 중·만드는 중·완성·실행 가능·만들지 못함).
// "실행 가능"은 추천 API로 맞춘다: GET /api/recommendations?source=report&status=open&limit=100 한 번 → sourceId(리포트 id)로 붙인다 (docs/API.md).
// 전문가 보기는 예전 행 모양 그대로에 의견·한 줄 요약을 더하고, 팀 리포트에서 전체·자동·장애 주입으로 거른다.
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { useRecommendations, useReports } from "../../api/queries";
import type { ReportSummary } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { REPORT_CARD_TEXT, formatCost, reportCardStatus } from "../../lib/reports";
import { Icon } from "../Icon";
import { Card, EmptyState, ErrorState, Segmented, Skeleton } from "../ui";
import { CrossCheckList } from "./CrossCheckList";
import { OpinionBadge } from "./OpinionBadge";
import { AutoBadge, InjectedBadge, ReportStatusBadge } from "./StatusChip";

type Group = "mine" | "team" | "analyses";
const GROUPS: { value: Group; label: string }[] = [
  { value: "mine", label: "내 리포트" },
  { value: "team", label: "팀 리포트" },
  { value: "analyses", label: "교차검증 분석" },
];
const isGroup = (v: string | null): v is Group => GROUPS.some((g) => g.value === v);

type Filter = "all" | "auto" | "chaos";

function EasyCard({ r, hasOpenPlan }: { r: ReportSummary; hasOpenPlan: boolean }) {
  const s = REPORT_CARD_TEXT[reportCardStatus(r.status, hasOpenPlan)];
  const completed = r.status === "completed";
  return (
    <Link to={`/reports/${r.id}`} className="flex min-h-16 items-start gap-3 px-5 py-3.5 hover:bg-fill/60">
      <article aria-label={`${r.name} 리포트`} className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[16px] font-semibold">{r.name}</span>
          {completed && <OpinionBadge opinion={r.opinion} />}
          {r.source === "auto" && <AutoBadge />}
        </span>
        {completed && r.oneLiner && <span className="mt-1 block text-[14px] leading-snug text-ink">{r.oneLiner}</span>}
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-sub">
          <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-bold", s.chip)}>
            <Icon name={s.icon} className="size-3.5" />
            {s.label}
          </span>
          {s.sentence}
        </span>
        <span className="mt-1 block text-[12px] text-mute">
          {r.symbol} · {r.requestedBy} · {formatDateTime(r.createdAt)}
        </span>
      </article>
      <Icon name="chevron" className="mt-1 size-4 shrink-0 text-mute" />
    </Link>
  );
}

function ExpertRow({ r }: { r: ReportSummary }) {
  return (
    <Link to={`/reports/${r.id}`} className="flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-fill/60">
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-[16px] font-semibold">{r.name}</span>
          {r.source === "auto" && <AutoBadge />}
          {r.chaosEnabled && <InjectedBadge />}
          {r.status === "completed" && <OpinionBadge opinion={r.opinion} expert />}
        </span>
        {r.status === "completed" && r.oneLiner && <span className="block truncate text-[13px] text-sub">{r.oneLiner}</span>}
        <span className="block text-[13px] text-mute">
          {r.symbol} · {r.requestedBy} · {formatDateTime(r.createdAt)}
          {typeof r.costUsd === "number" && ` · ${formatCost(r.costUsd)}`}
        </span>
      </span>
      <ReportStatusBadge status={r.status} />
      <Icon name="chevron" className="size-4 text-mute" />
    </Link>
  );
}

function Reports({ group, expert }: { group: "mine" | "team"; expert: boolean }) {
  const [filter, setFilter] = useState<Filter>("all");
  const byFilter = expert && group === "team" ? filter : "all";
  const { data, isPending, isError, error, refetch } = useReports(group === "mine" ? { mine: true } : byFilter === "auto" ? { source: "auto" } : {});
  // 쉬운 보기의 "실행 가능": 활성화할 수 있는 리포트 추천 (한 번에 받는다)
  const open = useRecommendations({ source: "report", status: "open", limit: 100 }, !expert);
  const openIds = new Set((open.data?.results ?? []).map((x) => x.sourceId));
  // "장애 주입"은 API에 조건이 없어 받은 목록에서 거른다. "자동"은 서버가 source를 아직 모를 수 있어 한 번 더 거른다
  const rows = (data?.results ?? []).filter((r) => (byFilter === "auto" ? r.source === "auto" : byFilter === "chaos" ? r.chaosEnabled : true));
  const empty =
    group === "mine"
      ? "아직 만든 리포트가 없어요. 위에서 종목을 골라 만들 수 있어요."
      : byFilter === "all"
        ? "아직 신청한 리포트가 없습니다."
        : byFilter === "auto"
          ? "자동 리포트가 아직 없습니다."
          : "장애 주입을 켠 리포트가 아직 없습니다.";

  return (
    <>
      {expert && group === "team" && (
        <div className="px-5">
          <Segmented
            label="리포트 거르기"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "전체" },
              { value: "auto", label: "자동" },
              { value: "chaos", label: "장애 주입" },
            ]}
          />
        </div>
      )}
      {isPending ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : isError ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>{empty}</EmptyState>
      ) : (
        <ul aria-label="리포트 목록" className="mt-2 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id}>{expert ? <ExpertRow r={r} /> : <EasyCard r={r} hasOpenPlan={openIds.has(r.id)} />}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function ReportList({ expert }: { expert: boolean }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("list");
  const group: Group = isGroup(raw) ? raw : "team";
  const choose = (g: Group) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (g === "team") sp.delete("list");
        else sp.set("list", g);
        return sp;
      },
      { replace: true },
    );
  const sub =
    group === "mine" ? "내가 만든 리포트 · 최신순" : group === "team" ? "팀 전체 공용 · 최신순" : "AI 교차검증 분석 · 팀 전체 공용 · 최신순";

  return (
    <Card aria-labelledby="list-title" className="px-0 pb-2">
      <div className="px-5">
        <h2 id="list-title" className="text-[17px] font-bold">
          {GROUPS.find((g) => g.value === group)?.label}
        </h2>
        <p className="mt-0.5 text-[13px] text-mute">{sub}</p>
        <Segmented label="리포트 묶음" className="mt-2.5 mb-2.5 w-full" value={group} onChange={choose} options={GROUPS} />
      </div>
      {group === "analyses" ? <CrossCheckList expert={expert} /> : <Reports key={group} group={group} expert={expert} />}
    </Card>
  );
}
