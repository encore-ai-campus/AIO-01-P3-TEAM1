// 쉬운 보기 홈의 "진행 중인 모의 자동매매": 계획마다 쉬운 상태 이름과 한 줄 설명 (lib/plainText.ts).
// 전문가 보기 홈은 components/autotrade/HomeSummaries.tsx의 HomePlans (원래 용어·가격).
// 있고 없음에 따라 자리를 옮기지 않는다: 늘 같은 자리, 비었으면 한 줄 (데이터가 늦게 와도 위쪽이 밀리지 않게).
// 폴링으로 상태가 바뀐 행은 2초 동안 연한 파랑으로 강조한다 (사용자가 가장 기다리는 소식 — 사는 가격을 기다리는 중 → 목표·손절을 지켜보는 중).
// 시연용 수동 시작 계획(DECISIONS 31장)은 상태 옆 "시연용 수동 시작" 배지 (링크 설명으로도 읽힌다).
import { useId } from "react";
import { Link } from "react-router";
import { usePlans } from "../../api/queries";
import type { TradePlan } from "../../api/types";
import { revealList, useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatQty } from "../../lib/format";
import { PLAN_STATUS_TEXT, SOURCE_TEXT } from "../../lib/plainText";
import { ManualStartBadge } from "../autotrade/Badges";
import { Icon } from "../Icon";
import { useChangedKeys, useShownCount } from "./homeHooks";
import { EmptyRow, HOME_ROW, RowChevron, RowsSkeleton, SectionError } from "./HomeStates";
import { SectionHead } from "./SectionHead";

function PlanItem({ p, changed }: { p: TradePlan; changed: boolean }) {
  const s = PLAN_STATUS_TEXT[p.status];
  const id = useId();
  return (
    <li>
      {/* 링크 이름은 짧게 두고, 지금 상태·설명은 이어서 읽힌다 (aria-describedby) */}
      <Link
        to={`/plans/${p.id}`}
        aria-label={`${p.name} 모의 자동매매 보기`}
        aria-describedby={`${id}-s ${id}-l${p.manualStart ? ` ${id}-m` : ""}`}
        className={cn(HOME_ROW, changed && "bg-brand-soft/60")}
      >
        <span
          aria-hidden="true"
          className={cn(
            "grid size-9 shrink-0 place-items-center rounded-full transition-colors",
            p.status === "holding" ? "bg-brand text-white" : "bg-brand-soft text-brand-ink",
          )}
        >
          <Icon name={p.status === "holding" ? "shield" : "clock"} className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-1.5">
            <span className="truncate text-[16px] font-semibold">{p.name}</span>
            <span id={`${id}-s`} className="text-[13px] font-semibold text-brand-ink">
              {s?.easy ?? p.status}
            </span>
            {p.manualStart && <ManualStartBadge id={`${id}-m`} />}
          </span>
          <span id={`${id}-l`} className="mt-0.5 block text-[13px] leading-snug text-sub">
            {s?.line}
          </span>
          <span className="mt-0.5 block text-[12px] text-mute tabular-nums">
            {formatQty(p.quantity)} · {SOURCE_TEXT[p.source]?.label ?? p.source}
          </span>
        </span>
        <RowChevron />
      </Link>
    </li>
  );
}

export function LivePlans() {
  const { data, isPending, isFetching, refetch } = usePlans("active");
  const reveal = useRevealAfterLoading(isPending);
  const list = data?.results ?? [];
  const changed = useChangedKeys(list.map((p) => [p.id, p.status] as const));
  // 받기 전 자리: 지난번에 본 행 수만큼 (기억이 없으면 처음 쓰는 사람처럼 빈 줄 하나)
  const rows = useShownCount("plans", data ? Math.min(3, list.length) : undefined, 0);
  return (
    <section aria-labelledby="home-live-title" className="space-y-3">
      <SectionHead id="home-live-title" title="진행 중인 모의 자동매매" to="/portfolio" count={list.length} />
      {isPending ? (
        <RowsSkeleton rows={rows} shape="live" />
      ) : !data ? (
        // 처음부터 받지 못했다 — '없어요'라고 하면 계획이 사라진 줄 안다 (다시 받기만 실패했으면 받아 둔 목록을 그대로 둔다)
        <SectionError onRetry={() => void refetch()} retrying={isFetching} />
      ) : list.length === 0 ? (
        <EmptyRow icon="clock" className={reveal ? "reveal-fade" : undefined}>
          진행 중인 모의 자동매매가 없어요. 리포트를 검토한 뒤 시작할 수 있어요.
        </EmptyRow>
      ) : (
        <ul {...revealList(reveal)} aria-label="진행 중인 모의 자동매매 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.slice(0, 3).map((p) => (
            <PlanItem key={p.id} p={p} changed={changed.has(p.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}
