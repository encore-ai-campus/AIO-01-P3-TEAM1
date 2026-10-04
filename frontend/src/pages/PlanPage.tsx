// /plans/:id: 머리(상태·via·활성화 시각) → 자동매매 워크플로우 그래프 → 핵심 숫자 → 사건 타임라인 → 연결된 모의 주문 → 계획 중단.
// 진행 중이면 5초마다 다시 받는다 (queries.usePlan).
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useCancelPlan } from "../api/autotrade";
import { ApiError, errorMessage } from "../api/client";
import { isPlanLive, usePlan, useQuotes } from "../api/queries";
import type { TradePlanDetail } from "../api/types";
import { PlanStatusChip, SourceBadge } from "../components/autotrade/Badges";
import { PlanTimeline, WorkflowGraph } from "../components/autotrade/PlanWorkflow";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { Card, ErrorState, Flash, Notice, PageHeader, Row, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { EXIT_REASON, planWorkflow } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDateTime, formatKrw, formatPrice, formatQty, formatRate, formatSignedKrw, formatSignedPrice, trendClass } from "../lib/format";

function CancelDialog({ plan, onClose }: { plan: TradePlanDetail; onClose: () => void }) {
  const toast = useToast();
  const cancel = useCancelPlan(plan.id);
  const holding = plan.status === "holding";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center lg:items-center">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cancel-title"
        className="relative w-full animate-sheet-up rounded-t-3xl bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:max-w-md lg:animate-none lg:rounded-3xl"
      >
        <h2 id="cancel-title" className="text-[18px] font-bold">
          {plan.name} 계획을 중단할까요?
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-sub">
          {holding
            ? `보유 수량을 전량 매도합니다 (${formatQty(plan.quantity)}). 정규장 밖이면 다음 정규장 시작에 매도를 예약하고, 매도가 끝나면 계획이 청산 완료로 바뀝니다.`
            : "체결 대기 중인 진입 주문을 취소하고 계획을 끝냅니다. 다시 켜려면 추천에서 새로 활성화해야 합니다."}
        </p>
        {cancel.isError && (
          <Notice tone="error" className="mt-3">
            {errorMessage(cancel.error)}
          </Notice>
        )}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button type="button" onClick={onClose} className="h-12 rounded-xl bg-fill text-[16px] font-semibold text-sub hover:bg-line">
            닫기
          </button>
          <button
            type="button"
            disabled={cancel.isPending}
            onClick={() =>
              cancel.mutate(undefined, {
                onSuccess: (p) => {
                  const last = p.events.at(-1);
                  toast(last?.message ?? "계획을 중단했습니다.");
                  onClose();
                },
              })
            }
            className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-up text-[16px] font-semibold text-white hover:bg-up/90 disabled:opacity-40"
          >
            {cancel.isPending && <Spinner />}
            {holding ? "전량 매도하고 중단" : "중단하기"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Numbers({ p }: { p: TradePlanDetail }) {
  const holding = p.status === "holding";
  const { data: quotes } = useQuotes(holding ? [p.symbol] : []);
  const last = holding ? (quotes?.get(p.symbol)?.price ?? null) : null;
  // 현재 손익은 종목 통화로 (비용 전). 실현 손익은 서버 값(pnlKrw, 원화)
  const unrealized = last != null && p.fillPrice != null ? (last - p.fillPrice) * p.quantity : null;
  const rate = last != null && p.fillPrice ? last / p.fillPrice - 1 : null;
  return (
    <Card aria-labelledby="numbers-title">
      <h2 id="numbers-title" className="mb-2 text-[17px] font-bold">
        핵심 숫자
      </h2>
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded-xl bg-fill p-3">
          <dt className="text-[12px] text-mute">수량</dt>
          <dd className="text-[17px] font-bold tabular-nums">{formatQty(p.quantity)}</dd>
        </div>
        <div className="rounded-xl bg-fill p-3">
          <dt className="text-[12px] text-mute">체결가</dt>
          <dd className="text-[17px] font-bold tabular-nums">{formatPrice(p.fillPrice, p.currency)}</dd>
        </div>
        <div className="rounded-xl bg-fill p-3">
          <dt className="text-[12px] text-mute">{holding ? "현재 손익" : "실현 손익"}</dt>
          <dd className={cn("text-[17px] font-bold tabular-nums", trendClass(holding ? unrealized : p.pnlKrw))}>
            {holding ? <Flash value={unrealized}>{formatSignedPrice(unrealized, p.currency)}</Flash> : formatSignedKrw(p.pnlKrw)}
          </dd>
          {holding && <dd className={cn("text-[11px] tabular-nums", trendClass(rate))}>{formatRate(rate)} · 지금 {formatPrice(last, p.currency)}</dd>}
        </div>
        <div className="rounded-xl bg-fill p-3">
          <dt className="text-[12px] text-mute">청산가</dt>
          <dd className="text-[17px] font-bold tabular-nums">{formatPrice(p.exitPrice, p.currency)}</dd>
          {p.exitReason && <dd className="text-[11px] text-mute">{EXIT_REASON[p.exitReason]}</dd>}
        </div>
      </dl>
      <dl className="mt-3">
        <Row label="진입가 (지정가)">{formatPrice(p.entryPrice, p.currency)}</Row>
        <Row label="목표가">
          <span className="text-up">
            {formatPrice(p.targetPrice, p.currency)} ({formatRate(p.targetPrice / p.entryPrice - 1, 1)})
          </span>
        </Row>
        <Row label="손절가">
          <span className="text-down">
            {formatPrice(p.stopPrice, p.currency)} ({formatRate(p.stopPrice / p.entryPrice - 1, 1)})
          </span>
        </Row>
        <Row label="보유 기간">{p.holdingDays}거래일</Row>
        <Row label="진입 기한">{formatDateTime(p.entryDeadline)}</Row>
        {p.budgetKrw != null && <Row label="예산">{formatKrw(p.budgetKrw)}</Row>}
        {p.filledAt && <Row label="체결 시각">{formatDateTime(p.filledAt)}</Row>}
        {p.closedAt && <Row label="청산 시각">{formatDateTime(p.closedAt)}</Row>}
      </dl>
    </Card>
  );
}

export function PlanPage() {
  const { id } = useParams();
  const { data: p, isPending, isError, error, refetch } = usePlan(Number(id));
  const [confirming, setConfirming] = useState(false);

  if (isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-40" />} back />
        <SkeletonCard lines={6} />
      </>
    );
  }
  if (isError) {
    return (
      <>
        <PageHeader title="자동매매 계획" back />
        <Card>
          <ErrorState
            message={error instanceof ApiError && error.status === 404 ? "계획을 찾을 수 없습니다." : errorMessage(error)}
            onRetry={() => void refetch()}
          />
        </Card>
      </>
    );
  }

  const live = isPlanLive(p.status);
  const wf = planWorkflow(p, p.events);
  const exitRequested = p.events.some((e) => e.kind === "exit_requested");
  return (
    <>
      <PageHeader title={`${p.name} 자동매매`} back />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-3">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[14px] text-mute">
                  {p.symbol} · {p.market === "KR" ? "국내" : "미국"} · 계획 #{p.id}
                </p>
                <p className="mt-0.5 text-[22px] font-bold tracking-tight">{p.name}</p>
              </div>
              <PlanStatusChip status={p.status} className="h-7 px-2 text-[13px]" />
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-sub">
              <SourceBadge source={p.source} />
              <span className="inline-flex h-6 items-center gap-1 rounded-md bg-fill px-1.5 font-semibold">
                <Icon name={p.via === "discord" ? "bell" : "home"} className="size-3.5" />
                {p.via === "discord" ? "Discord 링크로 활성화" : "웹에서 활성화"}
              </span>
              <span>{formatDateTime(p.activatedAt)}</span>
            </div>
            {live && (
              <p className="mt-2 flex items-center gap-1.5 text-[13px] text-mute">
                <Spinner className="size-3" />
                진행 중 · 5초마다 새로 받습니다
              </p>
            )}
          </Card>

          <Card aria-labelledby="wf-title">
            <h2 id="wf-title" className="mb-4 text-[17px] font-bold">
              자동매매 워크플로우
            </h2>
            <WorkflowGraph wf={wf} />
          </Card>

          <Card aria-labelledby="events-title">
            <h2 id="events-title" className="mb-3 text-[17px] font-bold">
              사건 타임라인
            </h2>
            <PlanTimeline events={p.events} />
          </Card>
        </div>

        <div className="space-y-3 lg:sticky lg:top-8">
          <Numbers p={p} />
          <Card className="space-y-2">
            <Link
              to={p.status === "entry_pending" ? "/portfolio?tab=orders" : p.status === "holding" ? "/portfolio" : "/portfolio?tab=fills"}
              className="flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line"
            >
              연결된 모의 주문 보기{p.orderId != null ? ` (#${p.orderId})` : ""}
              <Icon name="chevron" className="size-4" />
            </Link>
            <Link
              to={`/recommendations/${p.recommendationId}`}
              className="flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line"
            >
              추천 #{p.recommendationId} 보기
              <Icon name="chevron" className="size-4" />
            </Link>
            {live && (
              <button
                type="button"
                disabled={exitRequested}
                onClick={() => setConfirming(true)}
                className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-up-soft text-[16px] font-bold text-up hover:bg-up-soft/70 disabled:opacity-50"
              >
                <Icon name="ban" className="size-4" />
                {exitRequested ? "매도 요청됨 (청산 대기)" : "계획 중단"}
              </button>
            )}
          </Card>
        </div>
      </div>
      {confirming && <CancelDialog plan={p} onClose={() => setConfirming(false)} />}
    </>
  );
}
