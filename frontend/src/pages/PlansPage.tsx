// /plans: 내 모의 자동매매(전문가 보기: 내 자동매매) 계획 목록 (진행 중 / 전체). 누르면 /plans/:id.
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { usePlans } from "../api/queries";
import { PlanRow } from "../components/autotrade/PlanRow";
import { Icon } from "../components/Icon";
import { Card, EmptyState, ErrorState, PageHeader, Segmented, SkeletonCard } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";

type Filter = "active" | "all";

export function PlansPage() {
  const { easy } = useViewMode();
  const [params, setParams] = useSearchParams();
  const filter: Filter = params.get("status") === "all" ? "all" : "active";
  const { data, isPending, isError, error, refetch } = usePlans(filter);
  const list = data?.results ?? [];
  const setFilter = (v: Filter) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (v === "all") sp.set("status", "all");
        else sp.delete("status");
        return sp;
      },
      { replace: true },
    );
  return (
    <>
      <PageHeader title={easy ? "모의 자동매매" : "내 자동매매"} back />
      <div className="mx-auto max-w-[760px] space-y-3">
        <p className="px-1 text-[14px] leading-snug text-sub">
          {easy
            ? "새 계획 제안에서 시작한 모의 자동매매예요. 사는 주문 → 사는 가격 기다리기 → 목표·손절 지켜보기 → 팔기를 모의 계좌에서 자동으로 하고, 단계마다 알려 드려요."
            : "AI 추천에서 활성화한 계획입니다. 엔진이 진입 주문 → 체결 대기 → 보유 감시 → 청산을 자동으로 진행하고, 단계마다 알림을 보냅니다."}
        </p>
        <div className="flex items-center justify-between gap-3 px-1">
          <Segmented
            label="계획 필터"
            value={filter}
            onChange={setFilter}
            options={[
              { value: "active", label: "진행 중" },
              { value: "all", label: "전체" },
            ]}
          />
          <Link to="/recommendations" className="flex h-9 items-center gap-1 rounded-xl bg-card px-3 text-[14px] font-semibold text-brand hover:bg-line">
            <Icon name="sparkle" className="size-4" />
            {easy ? "새 계획 제안" : "AI 추천"}
          </Link>
        </div>
        {isPending ? (
          <SkeletonCard lines={4} />
        ) : isError ? (
          <Card>
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </Card>
        ) : list.length === 0 ? (
          <Card>
            <EmptyState>
              {filter === "active"
                ? easy
                  ? "진행 중인 모의 자동매매가 없어요. 새 계획 제안에서 시작해 보세요."
                  : "진행 중인 자동매매가 없습니다. AI 추천에서 계획을 활성화해 보세요."
                : easy
                  ? "아직 시작한 모의 자동매매가 없어요."
                  : "아직 활성화한 계획이 없습니다."}
            </EmptyState>
          </Card>
        ) : (
          <ul aria-label="계획 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
            {list.map((p) => (
              <li key={p.id}>
                <PlanRow p={p} easy={easy} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
