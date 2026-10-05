// /plans: 내 모의 자동매매(전문가 보기: 내 자동매매) 계획 목록 (진행 중 / 전체). 누르면 /plans/:id.
// 배치: 필터·제안 링크 → 목록 → 설명(접힘 한 줄). 다시 오는 사람에게 설명이 매번 목록을 밀어내지 않게 하고,
// 설명이 필요한 순간(목록이 빌 때)에는 빈 상태 안에 설명과 다음 행동 버튼을 둔다 (trade-28). PC는 제목과 같은 왼쪽 정렬 (trade-12).
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { usePlans } from "../api/queries";
import { PlanRow } from "../components/autotrade/PlanRow";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { Card, EmptyState, ErrorState, PageHeader, Segmented, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { revealList, useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";

type Filter = "active" | "all";

const HOW = {
  easy: "새 계획 제안에서 시작한 모의 자동매매예요. 사는 주문 → 사는 가격 기다리기 → 목표·손절 지켜보기 → 팔기를 모의 계좌에서 자동으로 하고, 단계마다 알려 드려요.",
  expert: "AI 추천에서 활성화한 계획입니다. 엔진이 진입 주문 → 체결 대기 → 보유 감시 → 청산을 자동으로 진행하고, 단계마다 알림을 보냅니다.",
};

/** 목록 아래 접힌 설명 한 줄 (필요할 때만 펼친다). */
function HowItWorks({ easy }: { easy: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="px-1">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? "plans-how" : undefined}
        onClick={() => setOpen((v) => !v)}
        className="press -mx-1 flex h-11 items-center gap-1 rounded-lg px-1 text-[14px] font-semibold text-sub hover:text-ink"
      >
        <Icon name="info" className="size-4 text-mute-weak" />
        {easy ? "모의 자동매매는 어떻게 진행되나요?" : "자동매매는 어떻게 진행되나요?"}
        <Icon name="chevron-down" className={cn("size-4 text-mute-weak transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id="plans-how">
        <p className="pb-1 text-[14px] leading-relaxed text-sub">{easy ? HOW.easy : HOW.expert}</p>
      </Collapse>
    </div>
  );
}

export function PlansPage() {
  const { easy } = useViewMode();
  const [params, setParams] = useSearchParams();
  const filter: Filter = params.get("status") === "all" ? "all" : "active";
  // 필터를 바꾸는 동안 이전 목록을 흐리게 남긴다 (스켈레톤으로 바뀌며 높이가 출렁이지 않게 — trade-17)
  const { data, isPending, isError, error, refetch, isFetching, isPlaceholderData } = usePlans(filter, { keepPrevious: true });
  const reveal = useRevealAfterLoading(isPending);
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
      <div className="max-w-[760px] space-y-3">
        <div className="flex items-center justify-between gap-3 px-1">
          <Segmented
            label="계획 필터"
            value={filter}
            onChange={setFilter}
            surface="page"
            options={[
              { value: "active", label: "진행 중" },
              { value: "all", label: "전체" },
            ]}
          />
          <span className="flex items-center gap-2">
            {isPlaceholderData && <Spinner className="size-3.5 text-mute" />}
            {/* 보이는 높이는 36px, 누르는 자리는 위아래로 넓혀 44px (trade-22) */}
            <Link
              to="/recommendations"
              className="press relative flex h-9 items-center gap-1 rounded-xl bg-card px-3 text-[14px] font-semibold text-brand-ink before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-line"
            >
              <Icon name="sparkle" className="size-4" />
              {easy ? "새 계획 제안" : "AI 추천"}
            </Link>
          </span>
        </div>
        {isPending || (isPlaceholderData && list.length === 0) ? (
          // 앞 필터의 빈 상태 문구는 새 결과가 올 때까지 보이지 않는다
          <SkeletonCard lines={4} />
        ) : isError ? (
          <Card>
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
          </Card>
        ) : list.length === 0 ? (
          <Card>
            <EmptyState
              icon="flow"
              title={
                filter === "active"
                  ? easy
                    ? "진행 중인 모의 자동매매가 없어요"
                    : "진행 중인 자동매매가 없습니다"
                  : easy
                    ? "아직 시작한 모의 자동매매가 없어요"
                    : "아직 활성화한 계획이 없습니다"
              }
              action={{ label: easy ? "새 계획 제안 보기" : "AI 추천 보기", to: "/recommendations" }}
            >
              {easy ? HOW.easy : HOW.expert}
            </EmptyState>
          </Card>
        ) : (
          <>
            <ul
              {...revealList(reveal)}
              aria-label="계획 목록"
              aria-busy={isPlaceholderData || undefined}
              className={cn("divide-y divide-line overflow-hidden rounded-2xl bg-card transition-opacity duration-fast", isPlaceholderData && "opacity-60")}
            >
              {list.map((p) => (
                <li key={p.id}>
                  <PlanRow p={p} easy={easy} />
                </li>
              ))}
            </ul>
            <HowItWorks easy={easy} />
          </>
        )}
      </div>
    </>
  );
}
