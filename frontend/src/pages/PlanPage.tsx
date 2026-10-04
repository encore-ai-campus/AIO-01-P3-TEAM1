// /plans/:id 모의 자동매매 상세 (docs/컨셉변경계획.md 4-2). 진행 중이면 5초마다 다시 받는다 (queries.usePlan).
// 쉬운 보기: 단계 넷(주문 → 사는 가격 기다리는 중 → 목표·손절 지켜보는 중 → 팔았어요) · 일어난 일을 쉬운 문장으로(kind + details) ·
//   숫자 · "멈추기"(대화상자 "지금 가지고 있는 ○주를 모두 팔고 끝낼까요? …").
// 전문가 보기(그대로): 머리(상태·via·활성화 시각) → 자동매매 워크플로우 그래프 → 사건 타임라인(서버 message) → 핵심 숫자 → 연결된 모의 주문 → 계획 중단.
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router";
import { useCancelPlan } from "../api/autotrade";
import { ApiError, errorMessage } from "../api/client";
import { isPlanLive, useMarket, usePlan, useQuotes } from "../api/queries";
import type { TradePlanDetail } from "../api/types";
import { PlanStatusChip, SourceBadge } from "../components/autotrade/Badges";
import { EasySteps, PlanTimeline, WorkflowGraph } from "../components/autotrade/PlanWorkflow";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { AsOf, Card, ErrorState, Flash, Notice, PageHeader, Row, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { closedMarketNotice, easySteps, exitReasonLabel, kstDayOf, planWorkflow } from "../lib/autotrade";
import { cn } from "../lib/cn";
import {
  formatDateTime,
  formatDayLabel,
  formatKrw,
  formatPrice,
  formatQty,
  formatRate,
  formatSignedKrw,
  formatSignedPrice,
  trendClass,
} from "../lib/format";
import { PLAN_STATUS_TEXT, exitReasonText, planEventSentence } from "../lib/plainText";

function CancelDialog({ plan, easy, onClose }: { plan: TradePlanDetail; easy: boolean; onClose: () => void }) {
  const toast = useToast();
  const cancel = useCancelPlan(plan.id);
  const holding = plan.status === "holding";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const text = easy
    ? holding
      ? `지금 가지고 있는 ${formatQty(plan.quantity)}를 모두 팔고 끝낼까요? 장이 닫혀 있으면 다음 장 시작(${plan.market === "KR" ? "오전 9시" : "한국 시각 밤"})에 팔아요.`
      : "사는 주문을 취소하고 끝낼까요? 아직 산 주식이 없어서 돈은 그대로예요. 다시 하려면 새 계획 제안에서 새로 시작해요."
    : holding
      ? `보유 수량을 전량 매도합니다 (${formatQty(plan.quantity)}). 정규장 밖이면 다음 정규장 시작에 매도를 예약하고, 매도가 끝나면 계획이 청산 완료로 바뀝니다.`
      : "체결 대기 중인 진입 주문을 취소하고 계획을 끝냅니다. 다시 켜려면 추천에서 새로 활성화해야 합니다.";

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
          {easy ? `${plan.name} 모의 자동매매를 멈출까요?` : `${plan.name} 계획을 중단할까요?`}
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-sub">{text}</p>
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
                  if (easy) toast(last ? planEventSentence(last, p.currency) : "모의 자동매매를 멈췄어요.");
                  else toast(last?.message ?? "계획을 중단했습니다.");
                  onClose();
                },
              })
            }
            className="flex h-12 items-center justify-center gap-1.5 rounded-xl bg-up text-[16px] font-semibold text-white hover:bg-up/90 disabled:opacity-40"
          >
            {cancel.isPending && <Spinner />}
            {easy ? (holding ? "모두 팔고 멈추기" : "멈추기") : holding ? "전량 매도하고 중단" : "중단하기"}
          </button>
        </div>
      </div>
    </div>
  );
}

/** 보유 중이면 직전 장마감 종가로 평가한 손익 (종목 통화, 비용 전). */
function useHoldingValue(p: TradePlanDetail) {
  const holding = p.status === "holding";
  const { data: quotes } = useQuotes(holding ? [p.symbol] : []);
  const quote = holding ? quotes?.get(p.symbol) : undefined;
  const last = quote?.price ?? null;
  const unrealized = last != null && p.fillPrice != null ? (last - p.fillPrice) * p.quantity : null;
  const rate = last != null && p.fillPrice ? last / p.fillPrice - 1 : null;
  return { holding, last, asOf: quote?.asOf ?? null, unrealized, rate };
}

function Numbers({ p }: { p: TradePlanDetail }) {
  const { holding, last, asOf, unrealized, rate } = useHoldingValue(p);
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
          {holding && <dd className={cn("text-[11px] tabular-nums", trendClass(rate))}>{formatRate(rate)} · 종가 {formatPrice(last, p.currency)}</dd>}
        </div>
        <div className="rounded-xl bg-fill p-3">
          <dt className="text-[12px] text-mute">청산가</dt>
          <dd className="text-[17px] font-bold tabular-nums">{formatPrice(p.exitPrice, p.currency)}</dd>
          {p.exitReason && <dd className="text-[11px] text-mute">{exitReasonLabel(p.exitReason)}</dd>}
        </div>
      </dl>
      {holding && <AsOf at={asOf} market={p.market} className="mt-1 block text-right" />}
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
        <Row label="보유 기간">{p.horizon === "DAY" ? "당일 (15:15 정리)" : `${p.holdingDays}거래일`}</Row>
        <Row label="진입 기한">{formatDateTime(p.entryDeadline)}</Row>
        {p.budgetKrw != null && <Row label="예산">{formatKrw(p.budgetKrw)}</Row>}
        {p.filledAt && <Row label="체결 시각">{formatDateTime(p.filledAt)}</Row>}
        {p.closedAt && <Row label="청산 시각">{formatDateTime(p.closedAt)}</Row>}
      </dl>
    </Card>
  );
}

function EasyNumbers({ p }: { p: TradePlanDetail }) {
  const { holding, last, asOf, unrealized, rate } = useHoldingValue(p);
  return (
    <Card aria-labelledby="numbers-title">
      <h2 id="numbers-title" className="mb-2 text-[17px] font-bold">
        숫자로 보기
      </h2>
      {holding && (
        <div className="mb-2 rounded-xl bg-fill p-3">
          <p className="text-[12px] text-mute">직전 종가로 본 평가 (비용 전)</p>
          <p className={cn("text-[19px] font-bold tabular-nums", trendClass(unrealized))}>
            {formatSignedPrice(unrealized, p.currency)} <span className="text-[13px]">({formatRate(rate)})</span>
          </p>
          <p className="text-[12px] text-sub tabular-nums">종가 {formatPrice(last, p.currency)}</p>
          <AsOf at={asOf} market={p.market} className="block" />
        </div>
      )}
      {p.status === "closed" && (
        <div className="mb-2 rounded-xl bg-fill p-3">
          <p className="text-[12px] text-mute">손익 (수수료·세금 포함)</p>
          <p className={cn("text-[19px] font-bold tabular-nums", trendClass(p.pnlKrw))}>{formatSignedKrw(p.pnlKrw)}</p>
          {p.exitReason && <p className="text-[13px] text-sub">{exitReasonText(p.exitReason, true)}</p>}
        </div>
      )}
      <dl>
        <Row label="수량">{formatQty(p.quantity)}</Row>
        <Row label="사는 가격">{formatPrice(p.entryPrice, p.currency)} 이하</Row>
        {p.fillPrice != null && <Row label="산 가격">{formatPrice(p.fillPrice, p.currency)}</Row>}
        {p.exitPrice != null && <Row label="판 가격">{formatPrice(p.exitPrice, p.currency)}</Row>}
        <Row label="목표 가격">
          <span className="text-up">{formatPrice(p.targetPrice, p.currency)}</span>
        </Row>
        <Row label="손절 가격">
          <span className="text-down">{formatPrice(p.stopPrice, p.currency)}</span>
        </Row>
        <Row label="보유 기간">{p.horizon === "DAY" ? "그날 15:15까지" : `최대 ${p.holdingDays}거래일`}</Row>
        <Row label="사는 가격을 기다리는 기한">{p.horizon === "DAY" ? "그날 15:15" : `${formatDayLabel(kstDayOf(p.entryDeadline))}까지`}</Row>
        {p.budgetKrw != null && <Row label="예산">{formatKrw(p.budgetKrw)}</Row>}
      </dl>
    </Card>
  );
}

/** 쉬운 보기의 결과 한 줄 (끝난 계획). */
function easyOutcome(p: TradePlanDetail): { tone: "ok" | "neutral" | "error"; text: string } | null {
  if (p.status === "closed") {
    return { tone: "ok", text: `${p.exitReason ? exitReasonText(p.exitReason, true) : "모의 계좌에서 팔았어요"} · 손익 ${formatSignedKrw(p.pnlKrw)}` };
  }
  if (p.status === "cancelled" || p.status === "expired") return { tone: "neutral", text: PLAN_STATUS_TEXT[p.status].line };
  if (p.status === "failed") return { tone: "error", text: PLAN_STATUS_TEXT.failed.line };
  return null;
}

const OUTCOME_CLS = { ok: "bg-ok-soft text-ok", neutral: "bg-fill text-sub", error: "bg-up-soft text-up" } as const;

export function PlanPage() {
  const { id } = useParams();
  const { easy } = useViewMode();
  const { data: p, isPending, isError, error, refetch } = usePlan(Number(id));
  const { data: market } = useMarket();
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
        <PageHeader title={easy ? "모의 자동매매" : "자동매매 계획"} back />
        <Card>
          <ErrorState
            message={error instanceof ApiError && error.status === 404 ? (easy ? "계획을 찾을 수 없어요." : "계획을 찾을 수 없습니다.") : errorMessage(error)}
            onRetry={() => void refetch()}
          />
        </Card>
      </>
    );
  }

  const live = isPlanLive(p.status);
  const exitRequested = p.events.some((e) => e.kind === "exit_requested");
  const session = market?.markets.find((m) => m.market === p.market);
  const waitingNotice = p.status === "active" || p.status === "entry_pending" ? closedMarketNotice(session, p.market) : null;
  const orderLink = p.status === "entry_pending" ? "/portfolio?tab=orders" : p.status === "holding" ? "/portfolio" : "/portfolio?tab=fills";

  const links = (
    <Card className="space-y-2">
      <Link to={orderLink} className="flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line">
        연결된 모의 주문 보기{p.orderId != null ? ` (#${p.orderId})` : ""}
        <Icon name="chevron" className="size-4" />
      </Link>
      {p.source !== "day" && (
        <Link
          to={`/recommendations/${p.recommendationId}`}
          className="flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line"
        >
          {easy ? "계획 제안 보기" : `추천 #${p.recommendationId} 보기`}
          <Icon name="chevron" className="size-4" />
        </Link>
      )}
      {live && (
        <button
          type="button"
          disabled={exitRequested}
          onClick={() => setConfirming(true)}
          className="flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-up-soft text-[16px] font-bold text-up hover:bg-up-soft/70 disabled:opacity-50"
        >
          <Icon name="ban" className="size-4" />
          {exitRequested ? (easy ? "팔도록 요청했어요 (기다리는 중)" : "매도 요청됨 (청산 대기)") : easy ? "멈추기" : "계획 중단"}
        </button>
      )}
    </Card>
  );

  if (easy) {
    const outcome = easyOutcome(p);
    return (
      <>
        <PageHeader title={`${p.name} 모의 자동매매`} back />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
          <div className="min-w-0 space-y-3">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[14px] text-mute">
                    {p.symbol} · {p.market === "KR" ? "국내" : "미국"} · 모의 계좌
                  </p>
                  <p className="mt-0.5 text-[22px] font-bold tracking-tight">{p.name}</p>
                </div>
                <PlanStatusChip status={p.status} easy className="h-7 px-2 text-[13px]" />
              </div>
              <p className="mt-2 text-[15px] leading-relaxed">{PLAN_STATUS_TEXT[p.status]?.line ?? p.status}</p>
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-sub">
                <SourceBadge source={p.source} />
                <span>
                  {p.via === "discord" ? "Discord 링크로 시작" : "웹에서 시작"} · {formatDateTime(p.activatedAt)}
                </span>
              </div>
              {p.horizon === "DAY" && <p className="mt-2 text-[13px] text-sub">단타라 그날 15:15가 지나면 정리해요.</p>}
              {waitingNotice && <Notice className="mt-3">{waitingNotice}</Notice>}
              {live && (
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-mute">
                  <Spinner className="size-3" />
                  진행 중 · 5초마다 새로 받아요
                </p>
              )}
            </Card>

            <Card aria-labelledby="steps-title">
              <h2 id="steps-title" className="mb-4 text-[17px] font-bold">
                지금 어디쯤인가요
              </h2>
              <EasySteps steps={easySteps(p, p.events)} />
              {outcome && (
                <p role="note" className={cn("mt-4 rounded-xl px-3.5 py-3 text-[14px]", OUTCOME_CLS[outcome.tone])}>
                  {outcome.text}
                </p>
              )}
              {p.failureReason && (p.status === "failed" || p.status === "expired") && (
                <details className="mt-2 text-[13px] text-mute">
                  <summary className="cursor-pointer">자세한 사유</summary>
                  <p className="mt-1">{p.failureReason}</p>
                </details>
              )}
            </Card>

            <Card aria-labelledby="events-title">
              <h2 id="events-title" className="mb-3 text-[17px] font-bold">
                일어난 일
              </h2>
              <PlanTimeline events={p.events} easy currency={p.currency} />
            </Card>
          </div>

          <div className="space-y-3 lg:sticky lg:top-8">
            <EasyNumbers p={p} />
            {links}
          </div>
        </div>
        {confirming && <CancelDialog plan={p} easy onClose={() => setConfirming(false)} />}
      </>
    );
  }

  const wf = planWorkflow(p, p.events);
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
            {waitingNotice && <Notice className="mt-3">{waitingNotice}</Notice>}
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
          {links}
        </div>
      </div>
      {confirming && <CancelDialog plan={p} easy={false} onClose={() => setConfirming(false)} />}
    </>
  );
}
