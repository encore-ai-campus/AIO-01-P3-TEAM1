// 전문가 보기 홈의 "새 계획 제안"(열린 추천 최대 3개 → 목록)과 "진행 중 자동매매"(있을 때만) 요약.
// 쉬운 보기 홈은 components/home/LivePlans.tsx (쉬운 문장).
import { Link } from "react-router";
import { usePlans, useRecommendations } from "../../api/queries";
import { timeLeft } from "../../lib/autotrade";
import { formatPrice, formatRate } from "../../lib/format";
import { SectionHead } from "../home/SectionHead";
import { Icon } from "../Icon";
import { Skeleton } from "../ui";
import { PlanStatusChip, SourceBadge } from "./Badges";
import { PlanRow } from "./PlanRow";

export function HomeRecommendations() {
  const { data, isPending } = useRecommendations({ status: "open", limit: 3 });
  const list = (data?.results ?? []).slice(0, 3);
  return (
    <section aria-labelledby="home-rec-title" className="space-y-3">
      <SectionHead id="home-rec-title" title="새 계획 제안" to="/recommendations" more={data ? `전체 ${data.count}개` : "전체"} />
      {isPending ? (
        <Skeleton className="h-24 w-full rounded-2xl" />
      ) : list.length === 0 ? (
        <Link to="/recommendations" className="block rounded-2xl bg-card px-5 py-4 text-[15px] text-mute hover:text-sub">
          지금 활성화할 수 있는 계획 제안이 없습니다. 연습용 예시 계획(AI 아님)을 만들 수 있습니다.
        </Link>
      ) : (
        <ul aria-label="AI 추천 요약" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((r) => (
            <li key={r.id}>
              <Link to={`/recommendations/${r.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-fill/60">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-1.5">
                    <span className="truncate text-[16px] font-semibold">{r.name}</span>
                    <SourceBadge source={r.source} />
                    {r.myPlan && <PlanStatusChip status={r.myPlan.status} />}
                  </p>
                  <p className="mt-0.5 text-[13px] text-mute tabular-nums">
                    진입 {formatPrice(r.entryPrice, r.currency)} → 목표 <span className="text-up">{formatRate(r.targetReturn, 1)}</span> · 손절{" "}
                    <span className="text-down">{formatRate(r.stopLossRate, 1)}</span> · {timeLeft(r.validUntil)}
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

export function HomePlans() {
  const { data } = usePlans("active");
  const list = data?.results ?? [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="home-plans-title" className="space-y-3">
      <SectionHead id="home-plans-title" title="진행 중 자동매매" to="/plans" more={`${list.length}건`} />
      <ul aria-label="진행 중 자동매매 요약" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
        {list.slice(0, 3).map((p) => (
          <li key={p.id}>
            <PlanRow p={p} />
          </li>
        ))}
      </ul>
    </section>
  );
}
