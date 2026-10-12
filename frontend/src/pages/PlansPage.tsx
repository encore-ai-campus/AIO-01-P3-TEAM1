// /plans: 내 모의 자동매매(전문가 보기: 내 자동매매) 계획 목록 (진행 중 / 전체). 누르면 /plans/:id.
// 배치: 필터·제안 링크 → 목록 → 설명(접힘 한 줄). 다시 오는 사람에게 설명이 매번 목록을 밀어내지 않게 하고,
// 설명이 필요한 순간(목록이 빌 때)에는 빈 상태 안에 설명과 다음 행동 버튼을 둔다 (trade-28). PC는 제목과 같은 왼쪽 정렬 (trade-12).
// PC (2026-10-12 PC 재설계): 목록은 열을 맞춘 표(PlanRow table + 머리), 오른쪽 열에 요약(진행 중·끝난 수, 누적 실현 손익, 목표 도달·손절 비율 —
//   받은 '전체' 목록으로 센다)과 펼친 진행 설명. 넓은 PC(85rem 이상)만 두 열이고, 그보다 좁으면 표가 짜부라지지 않게 한 열로 아래에 둔다 (B0-10).
//   요약·머리는 PC에서만 그린다 (useIsPc — 모바일 DOM은 그대로, '전체' 목록 요청과 폴링도 PC에서만).
//   계획이 0개여도 오른쪽 열(0 상태 요약 + 진행 순서)을 두고, 왼쪽 빈 상태는 작은 칸 하나(다음 행동 하나 — 머리줄 제안 링크는 그때 뺀다).
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { isPlanLive, usePlans } from "../api/queries";
import type { TradePlan } from "../api/types";
import { PlanRow, PlanTableHead } from "../components/autotrade/PlanRow";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { Card, EmptyState, ErrorState, PageHeader, Segmented, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useIsPc } from "../hooks/useIsPc";
import { revealList, useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatSignedKrw, trendClass } from "../lib/format";

type Filter = "active" | "all";

const HOW = {
  easy: "새 계획 제안에서 시작한 모의 자동매매예요. 사는 주문 → 사는 가격 기다리기 → 목표·손절 지켜보기 → 팔기를 모의 계좌에서 자동으로 하고, 단계마다 알려 드려요.",
  expert: "AI 추천에서 활성화한 계획입니다. 엔진이 진입 주문 → 체결 대기 → 보유 감시 → 청산을 자동으로 진행하고, 단계마다 알림을 보냅니다.",
};

/** 진행 순서 네 단계 (PC 오른쪽 열의 펼친 설명). 단계 이름은 계획 화면의 단계와 같은 말. */
const HOW_STEPS = {
  easy: [
    ["사는 주문", "정한 돈으로 살 수 있는 만큼 모의 계좌에 사는 주문을 넣어요."],
    ["사는 가격 기다리기", "가격이 사는 가격 이하가 되면 사요. 기한까지 안 되면 저절로 끝나요."],
    ["목표·손절 지켜보기", "산 뒤에는 목표 가격과 손절 가격을 계속 지켜봐요."],
    ["팔기", "목표·손절에 닿거나 보유 기한이 지나면 모의 계좌에서 팔아요."],
  ],
  expert: [
    ["진입 주문", "리스크 엔진이 수량·한도를 확인한 뒤 지정가 매수 주문을 냅니다."],
    ["체결 대기", "진입가 이하에서 체결됩니다. 진입 기한이 지나면 주문을 취소합니다."],
    ["보유 감시", "체결가 기준 목표가·손절가를 감시합니다."],
    ["청산", "목표가·손절가 도달 또는 보유 기한 경과 시 전량 매도합니다."],
  ],
} as const;

/** PC 오른쪽 열: 늘 펼친 진행 설명 (목록을 밀어내지 않는 자리라 접지 않는다). */
function HowItWorksCard({ easy }: { easy: boolean }) {
  const steps = easy ? HOW_STEPS.easy : HOW_STEPS.expert;
  return (
    <Card aria-labelledby="plans-how-title">
      <h2 id="plans-how-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="info" className="size-4 text-mute-weak" />
        {easy ? "모의 자동매매는 이렇게 진행돼요" : "자동매매 진행 순서"}
      </h2>
      <ol className="mt-4 space-y-3.5">
        {steps.map(([name, text], i) => (
          <li key={name} className="flex gap-3">
            <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-brand-soft text-[12px] font-bold text-brand-ink tabular-nums">
              {i + 1}
            </span>
            <p className="min-w-0 text-[14px] leading-snug">
              <span className="block font-semibold">{name}</span>
              <span className="text-sub">{text}</span>
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-4 border-t border-line pt-3 text-[13px] leading-relaxed text-mute">
        {easy
          ? "단계가 바뀔 때마다 알림으로 알려 드려요. 모든 매매는 모의 계좌에서만 이뤄져요."
          : "단계마다 알림을 보냅니다. 모든 체결은 모의 계좌에서만 일어납니다."}
      </p>
    </Card>
  );
}

/**
 * PC 오른쪽 열 요약 (PC에서만 그린다 — '전체' 목록 요청과 그 폴링도 PC에서만 나간다). 필터가 '전체'면 목록과 같은 쿼리라 요청이 늘지 않는다.
 * 계획이 하나도 없으면 0이 늘어선 칸 대신 한 줄 안내.
 */
function PlansSummaryCard({ easy }: { easy: boolean }) {
  const { data, isPending } = usePlans("all");
  if (isPending) return <SkeletonCard lines={3} />;
  if (!data) return null; // 받지 못하면 요약만 빠진다 (목록은 따로 오류를 보인다)
  if (data.results.length === 0) {
    return (
      <Card aria-labelledby="plans-summary-title">
        <h2 id="plans-summary-title" className="text-[17px] font-bold">
          {easy ? "한눈에 보기" : "계획 요약"}
        </h2>
        <p className="mt-2 text-[15px] font-semibold">{easy ? "아직 시작한 계획이 없어요" : "아직 활성화한 계획이 없습니다"}</p>
        <p className="mt-1 text-[13px] leading-relaxed text-mute">
          {easy
            ? "첫 계획을 시작하면 진행 중·끝난 계획 수와 판 계획의 손익이 여기에 모여요."
            : "활성화하면 진행 중·청산 건수와 누적 실현 손익이 여기에 집계됩니다."}
        </p>
      </Card>
    );
  }
  return <PlansSummary plans={data.results} total={data.count} easy={easy} />;
}

/** 요약 칸: 받은 '전체' 목록(최근 50개)으로 센다. 끝난 계획이 없으면 손익·비율 칸은 '아직 없음'. */
function PlansSummary({ plans, total, easy }: { plans: TradePlan[]; total: number; easy: boolean }) {
  const live = plans.filter((p) => isPlanLive(p.status)).length;
  const ended = plans.length - live;
  const closed = plans.filter((p) => p.status === "closed");
  const realized = closed.reduce((n, p) => n + (p.pnlKrw ?? 0), 0);
  const hit = closed.filter((p) => p.exitReason === "TARGET").length;
  const stop = closed.filter((p) => p.exitReason === "STOP").length;
  const rest = closed.length - hit - stop;
  const share = (n: number) => `${(n / Math.max(1, closed.length)) * 100}%`;
  const cell = "min-w-0 rounded-xl bg-fill p-3";
  return (
    <Card aria-labelledby="plans-summary-title">
      <h2 id="plans-summary-title" className="text-[17px] font-bold">
        {easy ? "한눈에 보기" : "계획 요약"}
      </h2>
      <dl className="mt-3 grid grid-cols-2 gap-2">
        <div className={cell}>
          <dt className="text-[13px] text-mute">진행 중</dt>
          <dd className="text-[22px] leading-tight font-bold tabular-nums">{live}건</dd>
        </div>
        <div className={cell}>
          <dt className="text-[13px] text-mute">끝난 계획</dt>
          <dd className="text-[22px] leading-tight font-bold tabular-nums">{ended}건</dd>
        </div>
        <div className={cn(cell, "col-span-2")}>
          <dt className="text-[13px] text-mute">{easy ? "판 계획의 손익 합계" : "누적 실현 손익"}</dt>
          <dd className={cn("text-[22px] leading-tight font-bold tabular-nums", closed.length > 0 && trendClass(realized))}>
            {closed.length > 0 ? formatSignedKrw(realized) : "아직 없음"}
          </dd>
          <dd className="mt-0.5 text-[12px] text-mute">수수료·세금 포함</dd>
        </div>
        <div className={cn(cell, "col-span-2")}>
          <dt className="text-[13px] text-mute">{easy ? "목표에 닿아 판 계획 · 손절한 계획" : "목표가 도달 · 손절가 도달"}</dt>
          {closed.length > 0 ? (
            <>
              <dd className="text-[17px] font-bold tabular-nums">
                <span className="text-up">
                  {easy ? "목표" : "목표가"} {hit}건
                </span>
                <span className="text-mute-weak"> · </span>
                <span className="text-down">
                  {easy ? "손절" : "손절가"} {stop}건
                </span>
                {rest > 0 && <span className="text-[13px] font-medium text-sub"> · 그 밖 {rest}건</span>}
              </dd>
              {/* 비율 막대 (장식 — 숫자는 위 글자가 말한다) */}
              <dd aria-hidden="true" className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-line">
                <span className="bg-up" style={{ width: share(hit) }} />
                <span className="bg-down" style={{ width: share(stop) }} />
              </dd>
            </>
          ) : (
            <dd className="text-[15px] font-semibold text-sub">{easy ? "아직 판 계획이 없어요" : "청산된 계획 없음"}</dd>
          )}
        </div>
      </dl>
      {total > plans.length && <p className="mt-2 text-[12px] text-mute">최근 {plans.length}개 기준</p>}
    </Card>
  );
}

/** 목록 아래 접힌 설명 한 줄 (필요할 때만 펼친다). PC는 오른쪽 열에 펼친 카드(HowItWorksCard). */
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
  const pc = useIsPc();
  // 모바일: 목록이 있을 때만 아래에 접힌 설명 한 줄 (비면 빈 상태 안에 설명이 있다)
  const showHow = list.length > 0;
  // PC는 계획이 없어도 오른쪽 열(요약 + 진행 순서)을 둔다 — 처음 온 사람에게 진행 순서가 가장 필요한 때다
  const rail = pc;
  const empty = !isPending && !isError && !isPlaceholderData && list.length === 0;
  const emptyTitle =
    filter === "active"
      ? easy
        ? "진행 중인 모의 자동매매가 없어요"
        : "진행 중인 자동매매가 없습니다"
      : easy
        ? "아직 시작한 모의 자동매매가 없어요"
        : "아직 활성화한 계획이 없습니다";
  const emptyAction = { label: easy ? "새 계획 제안 보기" : "AI 추천 보기", to: "/recommendations" };
  return (
    <>
      <PageHeader title={easy ? "모의 자동매매" : "내 자동매매"} back />
      <div
        className={cn(
          rail
            ? "space-y-5 min-[85rem]:grid min-[85rem]:grid-cols-[minmax(0,1fr)_340px] min-[85rem]:items-start min-[85rem]:gap-6 min-[85rem]:space-y-0 2xl:grid-cols-[minmax(0,1fr)_380px]"
            : "max-w-[760px] space-y-3",
        )}
      >
        <div className="min-w-0 space-y-3">
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
              {/* 보이는 높이는 36px, 누르는 자리는 위아래로 넓혀 44px (trade-22).
                  PC 빈 상태는 그 칸의 버튼 하나만 둔다 (같은 곳으로 가는 길이 둘이 되지 않게) */}
              {!(pc && empty) && (
                <Link
                  to="/recommendations"
                  className="press relative flex h-9 items-center gap-1 rounded-xl bg-card px-3 text-[14px] font-semibold text-brand-ink before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-line"
                >
                  <Icon name="sparkle" className="size-4" />
                  {easy ? "새 계획 제안" : "AI 추천"}
                </Link>
              )}
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
            pc ? (
              // PC: 작은 안내 칸 하나 (무엇이 없는지 · 어떻게 시작하는지 · 다음 행동 하나). 진행 순서 설명은 요약 옆 카드가 늘 보인다
              <div className="flex min-h-40 items-center gap-5 rounded-2xl bg-card px-6 py-6">
                <span aria-hidden="true" className="grid size-12 shrink-0 place-items-center rounded-full bg-fill text-mute-weak">
                  <Icon name="flow" className="size-6" />
                </span>
                <div className="min-w-0 flex-1">
                  <h2 className="text-[17px] font-bold">{emptyTitle}</h2>
                  <p className="mt-1 text-[14px] leading-snug text-sub">
                    {easy
                      ? "새 계획 제안에서 마음에 드는 계획을 골라 시작하면, 여기에서 단계별로 지켜볼 수 있어요."
                      : "AI 추천을 골라 활성화하면 진입부터 청산까지 여기서 지켜볼 수 있습니다."}
                  </p>
                </div>
                <Link
                  to={emptyAction.to}
                  className="press flex h-12 shrink-0 items-center gap-1.5 rounded-xl bg-brand px-5 text-[15px] font-bold text-white hover:bg-brand-dark"
                >
                  <Icon name="sparkle" className="size-4" />
                  {emptyAction.label}
                </Link>
              </div>
            ) : (
              <Card>
                <EmptyState icon="flow" title={emptyTitle} action={emptyAction}>
                  {easy ? HOW.easy : HOW.expert}
                </EmptyState>
              </Card>
            )
          ) : (
            <div className={cn("overflow-hidden rounded-2xl bg-card transition-opacity duration-fast", isPlaceholderData && "opacity-60")}>
              {pc && <PlanTableHead easy={easy} />}
              <ul {...revealList(reveal)} aria-label="계획 목록" aria-busy={isPlaceholderData || undefined} className="divide-y divide-line">
                {list.map((p) => (
                  <li key={p.id}>
                    <PlanRow p={p} easy={easy} table />
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
        {(rail || showHow) && (
          // 모바일: 목록 아래 접힌 설명 한 줄. PC: 오른쪽 열(좁은 PC는 아래) — 요약 + 펼친 설명
          <div className={cn(pc && "space-y-3 lg:grid lg:grid-cols-2 lg:items-start lg:gap-3 lg:space-y-0 min-[85rem]:grid-cols-1")}>
            {pc && <PlansSummaryCard easy={easy} />}
            {pc ? <HowItWorksCard easy={easy} /> : showHow && <HowItWorks easy={easy} />}
          </div>
        )}
      </div>
    </>
  );
}
