// 전문가 보기 홈의 "진행 중 자동매매"(늘 같은 자리, 비었으면 한 줄)와 "새 계획 제안"(열린 추천 최대 3개 → 목록) 요약.
// 새 계획 제안은 활성화할 수 있는 것을 먼저 고른다 — 최신 셋만 받으면 셋 다 '활성화 불가'일 수 있다 (UX-2). 그래서 열린 목록을 받아(모의투자 탭과 같은 요청) 정렬해 자른다.
// 쉬운 보기 홈은 components/home/LivePlans.tsx (쉬운 문장).
// 진행 중 자동매매를 있을 때만 그리면, 늦게 도착할 때 아래 '새 계획 제안'이 손가락 밑에서 밀린다 — 그래서 자리를 늘 둔다.
import { Link } from "react-router";
import { usePlans, useRecommendations } from "../../api/queries";
import { revealList, useRevealAfterLoading } from "../../hooks/useMotionState";
import { startableFirst, timeLeft } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatPrice, formatRate } from "../../lib/format";
import { useChangedKeys, useShownCount } from "../home/homeHooks";
import { EmptyRow, HOME_ROW, RowChevron, RowsSkeleton, SectionError } from "../home/HomeStates";
import { SectionHead } from "../home/SectionHead";
import { BlockedMark, PlanStatusChip, SourceBadge } from "./Badges";
import { PlanRow } from "./PlanRow";

export function HomeRecommendations() {
  const { data, isPending, isFetching, refetch } = useRecommendations({ status: "open" });
  const reveal = useRevealAfterLoading(isPending);
  const list = startableFirst(data?.results ?? []).slice(0, 3);
  // 받기 전 자리: 지난번에 본 행 수만큼 (기억이 없으면 3줄 — 팀의 열린 제안은 보통 있다)
  const rows = useShownCount("recs", data ? list.length : undefined, 3);
  return (
    <section aria-labelledby="home-rec-title" className="space-y-3">
      <SectionHead id="home-rec-title" title="새 계획 제안" to="/recommendations" count={data?.count} />
      {isPending ? (
        <RowsSkeleton rows={rows} shape="rec" />
      ) : !data ? (
        <SectionError onRetry={() => void refetch()} retrying={isFetching} />
      ) : list.length === 0 ? (
        <EmptyRow icon="sparkle" to="/recommendations" className={reveal ? "reveal-fade" : undefined}>
          지금 활성화할 수 있는 계획 제안이 없습니다. 연습용 예시 계획(AI 아님)을 만들 수 있습니다.
        </EmptyRow>
      ) : (
        <ul {...revealList(reveal)} aria-label="AI 추천 요약" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((r) => (
            <li key={r.id}>
              <Link to={`/recommendations/${r.id}`} className={HOME_ROW}>
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[16px] font-semibold">{r.name}</span>
                    <SourceBadge source={r.source} />
                    {r.myPlan && <PlanStatusChip status={r.myPlan.status} />}
                    <BlockedMark r={r} />
                  </p>
                  {/* 조각마다 줄을 바꾸지 않는다 ('2일 / 22시간 남음'처럼 한 덩어리가 쪼개지지 않게) — 줄바꿈은 조각 사이에서만 */}
                  <p className="mt-0.5 flex flex-wrap gap-x-1 text-[13px] text-mute tabular-nums">
                    <span className="whitespace-nowrap">진입 {formatPrice(r.entryPrice, r.currency)} →</span>
                    <span className="whitespace-nowrap">
                      목표 <span className="text-up">{formatRate(r.targetReturn, 1)}</span> ·
                    </span>
                    <span className="whitespace-nowrap">
                      손절 <span className="text-down">{formatRate(r.stopLossRate, 1)}</span> ·
                    </span>
                    <span className="whitespace-nowrap">{timeLeft(r.validUntil)}</span>
                  </p>
                </div>
                <RowChevron />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomePlans() {
  const { data, isPending, isFetching, refetch } = usePlans("active");
  const reveal = useRevealAfterLoading(isPending);
  const list = data?.results ?? [];
  // 폴링으로 상태가 바뀐 계획(체결 대기 → 보유 중 등)을 2초 동안 강조한다
  const changed = useChangedKeys(list.map((p) => [p.id, p.status] as const));
  // 받기 전 자리: 지난번에 본 행 수만큼 (쉬운 보기 LivePlans와 같은 기억 — 같은 목록이다. 없으면 빈 줄 하나)
  const rows = useShownCount("plans", data ? Math.min(3, list.length) : undefined, 0);
  return (
    <section aria-labelledby="home-plans-title" className="space-y-3">
      <SectionHead id="home-plans-title" title="진행 중 자동매매" to="/plans" count={list.length} />
      {isPending ? (
        <RowsSkeleton rows={rows} shape="plan" />
      ) : !data ? (
        <SectionError onRetry={() => void refetch()} retrying={isFetching} />
      ) : list.length === 0 ? (
        <EmptyRow icon="flow" className={reveal ? "reveal-fade" : undefined}>
          진행 중인 자동매매가 없습니다. 새 계획 제안에서 시작할 수 있습니다.
        </EmptyRow>
      ) : (
        <ul {...revealList(reveal)} aria-label="진행 중 자동매매 요약" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.slice(0, 3).map((p) => (
            <li key={p.id} className={cn("transition-colors duration-fast", changed.has(p.id) && "bg-brand-soft/60")}>
              <PlanRow p={p} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
