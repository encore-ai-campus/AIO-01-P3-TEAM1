// /portfolio 모의투자 탭 (docs/컨셉변경계획.md 4-1·4-2): 진행 중 모의 자동매매 → 보유(스윙·장기·단타 배지, 장마감 기준 평가)·대기 주문·체결 내역 →
// 끝난 계획 → 새 계획 제안(쉬운 보기는 리포트에서 나온 것만, 나머지는 접힌 "다른 계획 ○개") → 단타 연습장 입구(주린이모드 끔) 또는 잠금 안내(켬).
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api/client";
import { isPlanLive, useAccount, useFills, useOrders, usePlans, useRecommendations, useReservations } from "../api/queries";
import { useRefreshTrading } from "../api/trading";
import type { Market, Order, Reservation } from "../api/types";
import { PlanRow } from "../components/autotrade/PlanRow";
import { RecommendationCard } from "../components/autotrade/RecommendationCard";
import { StyleBadge } from "../components/autotrade/Badges";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { AsOf, Card, EmptyState, ErrorState, Flash, Notice, PageHeader, SkeletonCard } from "../components/ui";
import { useBeginnerMode, useViewMode } from "../hooks/useBeginnerMode";
import { exitReasonLabel, splitProposals } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDate, formatDateTime, formatKrw, formatPrice, formatQty, formatRate, formatSignedKrw, trendClass } from "../lib/format";
import { DAY_COST_NOTE, DAY_LOCK_TEXT, errorSentence, exitReasonText } from "../lib/plainText";

type Tab = "holdings" | "orders" | "fills";
const TABS: { value: Tab; label: string }[] = [
  { value: "holdings", label: "보유 종목" },
  { value: "orders", label: "대기 주문·예약" },
  { value: "fills", label: "체결 내역" },
];

/** 체결 사유 (매수 체결 / 청산 사유 — docs/API.md "청산 사유" 표). 쉬운 보기는 쉬운 문장. */
const fillReason = (reason: string, easy: boolean) =>
  reason === "ENTRY" ? (easy ? "모의 계좌에서 샀어요" : "매수 체결") : easy ? exitReasonText(reason, true) : exitReasonLabel(reason);

function SectionTitle({ id, title, to, linkLabel }: { id: string; title: string; to?: string; linkLabel?: string }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3 px-1">
      <h2 id={id} className="text-[17px] font-bold">
        {title}
      </h2>
      {to && (
        <Link to={to} className="flex h-9 items-center gap-0.5 text-[14px] font-semibold text-brand">
          {linkLabel ?? "모두 보기"}
          <Icon name="chevron" className="size-4" />
        </Link>
      )}
    </div>
  );
}

/** 진행 중 모의 자동매매. */
function LivePlans({ easy }: { easy: boolean }) {
  const { data, isPending, isError, error, refetch } = usePlans("active");
  const list = data?.results ?? [];
  return (
    <section aria-labelledby="live-plans-title">
      <SectionTitle id="live-plans-title" title={easy ? "진행 중 모의 자동매매" : "진행 중 자동매매"} to="/plans" />
      {isPending ? (
        <SkeletonCard lines={3} />
      ) : isError ? (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
        </Card>
      ) : list.length === 0 ? (
        <Card>
          <p className="text-[14px] text-mute">
            {easy ? "진행 중인 모의 자동매매가 없어요. 아래 새 계획 제안에서 시작할 수 있어요." : "진행 중인 자동매매가 없습니다."}
          </p>
        </Card>
      ) : (
        <ul aria-label="진행 중 계획" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {list.map((p) => (
            <li key={p.id}>
              <PlanRow p={p} easy={easy} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 끝난 계획 (최근 3개와 결과 손익). */
function EndedPlans({ easy }: { easy: boolean }) {
  const { data } = usePlans("all");
  const ended = (data?.results ?? []).filter((p) => !isPlanLive(p.status)).slice(0, 3);
  if (!data) return null;
  return (
    <section aria-labelledby="ended-plans-title">
      <SectionTitle id="ended-plans-title" title="끝난 계획" to="/plans?status=all" />
      {ended.length === 0 ? (
        <Card>
          <p className="text-[14px] text-mute">{easy ? "아직 끝난 계획이 없어요." : "끝난 계획이 없습니다."}</p>
        </Card>
      ) : (
        <ul aria-label="끝난 계획" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {ended.map((p) => (
            <li key={p.id}>
              <PlanRow p={p} easy={easy} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 새 계획 제안 (전문가 보기: AI 추천). 쉬운 보기는 리포트에서 나온 것만 앞에. */
function Proposals({ easy }: { easy: boolean }) {
  const { data } = useRecommendations({ status: "open" });
  const [showOthers, setShowOthers] = useState(false);
  const { main, others } = splitProposals(data?.results ?? [], easy);
  return (
    <section aria-labelledby="proposals-title">
      <SectionTitle id="proposals-title" title={easy ? "새 계획 제안" : "AI 추천"} to="/recommendations" />
      {!data ? (
        <SkeletonCard lines={3} />
      ) : main.length === 0 && others.length === 0 ? (
        <Card>
          <p className="text-[14px] text-mute">
            {easy ? "지금 시작할 수 있는 계획이 없어요. 종목에서 AI 리포트를 만들어 보세요." : "활성화할 수 있는 추천이 없습니다."}
          </p>
        </Card>
      ) : (
        <div className="space-y-3">
          {main.length > 0 ? (
            <ul aria-label="새 계획 제안 목록" className="grid gap-3 sm:grid-cols-2">
              {main.map((r) => (
                <li key={r.id}>
                  <RecommendationCard r={r} compact easy={easy} />
                </li>
              ))}
            </ul>
          ) : (
            <Card>
              <p className="text-[14px] text-mute">AI 리포트에서 나온 계획이 아직 없어요.</p>
            </Card>
          )}
          {others.length > 0 && (
            <div>
              <button
                type="button"
                aria-expanded={showOthers}
                onClick={() => setShowOthers((v) => !v)}
                className="flex h-11 w-full items-center justify-between rounded-2xl bg-card px-4 text-[15px] font-semibold text-sub hover:bg-line"
              >
                다른 계획 {others.length}개 (교차검증 분석·연습용 예시)
                <span aria-hidden="true">{showOthers ? "▴" : "▾"}</span>
              </button>
              {showOthers && (
                <ul aria-label="다른 계획 목록" className="mt-3 grid gap-3 sm:grid-cols-2">
                  {others.map((r) => (
                    <li key={r.id}>
                      <RecommendationCard r={r} compact easy={easy} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 단타 연습장 입구 (주린이모드 끔) 또는 잠금 안내 (켬). 서버도 잠금을 막는다 (day_trading_locked). */
function DayEntry() {
  const { beginnerMode, profile } = useBeginnerMode();
  if (beginnerMode) {
    return (
      <Card aria-labelledby="day-title" className="bg-fill">
        <h2 id="day-title" className="flex items-center gap-1.5 text-[16px] font-bold text-sub">
          <Icon name="ban" className="size-4" />
          단타 연습장 · 잠김
        </h2>
        <p className="mt-1 text-[14px] leading-snug text-sub">
          단타는 초보에게 가장 위험한 방식이라 잠가 두었어요. {DAY_LOCK_TEXT.beginner_mode}. 그다음 단타 연습 퀴즈 5문항을 모두 맞히면 열려요.
        </p>
      </Card>
    );
  }
  const unlocked = profile?.dayTradingUnlocked ?? false;
  return (
    <Card aria-labelledby="day-title">
      <h2 id="day-title" className="flex items-center gap-1.5 text-[16px] font-bold">
        <Icon name="bolt" className="size-4 text-[#9a5b00]" />
        단타 연습장
      </h2>
      <p className="mt-1 text-[14px] leading-snug text-sub">
        분 단위로 계획을 세우고 그날 15:15에 정리하는 연습이에요 (국내 종목만). {DAY_COST_NOTE}.
      </p>
      {unlocked ? (
        <Link to="/day" className="mt-3 flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line">
          단타 연습장 열기
          <Icon name="chevron" className="size-4" />
        </Link>
      ) : (
        <>
          <p className="mt-2 text-[13px] text-mute">{DAY_LOCK_TEXT.quiz_not_passed}.</p>
          <Link to="/day/quiz" className="mt-2 flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line">
            단타 연습 퀴즈 풀기
            <Icon name="chevron" className="size-4" />
          </Link>
        </>
      )}
    </Card>
  );
}

function Holdings({ easy }: { easy: boolean }) {
  const { data: acc, isPending, isError, error, refetch } = useAccount();
  if (isPending) return <SkeletonCard lines={5} />;
  if (isError) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  const profit = acc.positions.reduce((n, p) => n + p.profitKrw, 0);
  const markets = (Object.keys(acc.pricesAsOf) as Market[]).sort();
  return (
    <div className="space-y-3">
      <Card>
        <p className="text-[14px] text-sub">보유 평가액</p>
        <p className="text-[26px] font-bold tracking-tight tabular-nums">
          <Flash value={acc.holdingsValueKrw}>{formatKrw(acc.holdingsValueKrw)}</Flash>
        </p>
        <p className={cn("text-[15px] font-semibold tabular-nums", trendClass(profit))}>
          {formatSignedKrw(profit)} ({formatRate(acc.investedKrw ? profit / acc.investedKrw : null)})
        </p>
        <p className="mt-2 text-[13px] text-mute">투자금액 {formatKrw(acc.investedKrw)} · 현금 {formatKrw(acc.cashKrw)}</p>
        {markets.length > 0 && (
          <p aria-label="평가 기준" className="mt-1 flex flex-wrap gap-x-3 text-[12px] text-mute">
            <span>{easy ? "평가는 직전 장마감 종가로 해요" : "평가: 직전 장마감 종가"}</span>
            {markets.map((m) => (
              <AsOf key={m} at={acc.pricesAsOf[m]} market={m} />
            ))}
          </p>
        )}
      </Card>
      {acc.positions.length === 0 ? (
        <Card>
          <EmptyState>{easy ? "가지고 있는 종목이 없어요." : "보유 중인 종목이 없습니다."}</EmptyState>
        </Card>
      ) : (
        <ul className="divide-y divide-line rounded-2xl bg-card" aria-label="보유 종목">
          {acc.positions.map((p) => (
            <li key={p.orderId}>
              <Link to={`/stocks/${encodeURIComponent(p.symbol)}`} className="block px-5 py-4 hover:bg-fill/60">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex items-center gap-1.5 truncate text-[16px] font-semibold">
                      {p.name}
                      <StyleBadge style={p.style} />
                    </p>
                    <p className="text-[13px] text-mute tabular-nums">
                      {formatQty(p.quantity)} · 평균 {formatPrice(p.avgPrice, p.currency)} · 종가 {formatPrice(p.lastPrice, p.currency)}
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-[16px] font-semibold tabular-nums">
                      <Flash value={p.valueKrw}>{formatKrw(p.valueKrw)}</Flash>
                    </p>
                    <p className={cn("text-[13px] font-medium tabular-nums", trendClass(p.profitKrw))}>
                      {formatSignedKrw(p.profitKrw)} ({formatRate(p.profitRate)})
                    </p>
                  </div>
                </div>
                {p.style === "long" ? (
                  <p className="mt-2 text-[12px] text-mute">{easy ? "장기 보유 · 자동으로 팔지 않아요" : "장기 보유 · 자동 매도 없음"}</p>
                ) : (
                  (p.targetPrice != null || p.expireDate || p.style === "day") && (
                    <p className="mt-2 text-[12px] text-mute tabular-nums">
                      {p.targetPrice != null && (
                        <>
                          목표 <span className="text-up">{formatPrice(p.targetPrice, p.currency)}</span> · 손절{" "}
                          <span className="text-down">{formatPrice(p.stopPrice, p.currency)}</span>
                        </>
                      )}
                      {p.style === "day" ? " · 그날 15:15 정리" : p.expireDate && ` · ${formatDate(p.expireDate)}까지`}
                    </p>
                  )
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {acc.notes.map((n) => (
        <p key={n} className="px-1 text-[13px] text-mute">
          {n}
        </p>
      ))}
    </div>
  );
}

function useCancel<T>(fn: (id: number) => Promise<T>, done: string) {
  const toast = useToast();
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      toast(done);
      await refresh();
    },
    onError: (err) => toast(errorSentence(err), "error"),
  });
}

function PendingRow({ o }: { o: Order }) {
  const cancel = useCancel((id) => api.post<Order>(`/api/orders/${id}/cancel`), "주문을 취소했습니다.");
  return (
    <li className="flex items-center gap-3 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 truncate text-[16px] font-semibold">
          {o.name}
          <StyleBadge style={o.style} />
        </p>
        <p className="text-[13px] text-mute tabular-nums">
          {o.orderType === "LIMIT" ? `지정가 ${formatPrice(o.limitPrice, o.currency)}` : "시장가"} · {formatQty(o.quantity)} · {formatDateTime(o.createdAt)}
        </p>
      </div>
      <button
        type="button"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(o.id)}
        className="h-11 shrink-0 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line disabled:opacity-50"
        aria-label={`${o.name} 주문 취소`}
      >
        취소
      </button>
    </li>
  );
}

function ReservationRow({ r }: { r: Reservation }) {
  const cancel = useCancel((id) => api.del(`/api/reservations/${id}`), "예약을 취소했습니다.");
  return (
    <li className="flex items-center gap-3 px-5 py-4">
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 truncate text-[16px] font-semibold">
          <span className={cn("rounded-md px-1.5 py-0.5 text-[12px] font-bold", r.kind === "BUY" ? "bg-up-soft text-up" : "bg-down-soft text-down")}>
            {r.kind === "BUY" ? "매수 예약" : "매도 예약"}
          </span>
          {r.name}
          {r.style && <StyleBadge style={r.style} />}
        </p>
        <p className="text-[13px] text-mute tabular-nums">
          {formatQty(r.quantity)} · {r.runAt ? `${formatDateTime(r.runAt)} 실행 예정` : "다음 정규장 시작에 실행"}
        </p>
      </div>
      <button
        type="button"
        disabled={cancel.isPending}
        onClick={() => cancel.mutate(r.id)}
        className="h-11 shrink-0 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line disabled:opacity-50"
        aria-label={`${r.name} 예약 취소`}
      >
        취소
      </button>
    </li>
  );
}

function OrdersTab() {
  const orders = useOrders("active");
  const resv = useReservations();
  if (orders.isPending || resv.isPending) return <SkeletonCard lines={4} />;
  if (orders.isError || resv.isError) {
    return <ErrorState message={errorMessage(orders.error ?? resv.error)} onRetry={() => void Promise.all([orders.refetch(), resv.refetch()])} />;
  }
  const pending = orders.data.results.filter((o) => o.status === "ENTRY_PENDING");
  return (
    <div className="space-y-4">
      <section aria-labelledby="pending-title">
        <h2 id="pending-title" className="mb-2 px-1 text-[15px] font-semibold text-sub">
          체결 대기 주문
        </h2>
        {pending.length === 0 ? (
          <Card>
            <EmptyState>체결 대기 중인 주문이 없습니다.</EmptyState>
          </Card>
        ) : (
          <ul className="divide-y divide-line rounded-2xl bg-card">
            {pending.map((o) => (
              <PendingRow key={o.id} o={o} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="resv-title">
        <h2 id="resv-title" className="mb-2 px-1 text-[15px] font-semibold text-sub">
          예약 (다음 정규장 시작에 실행)
        </h2>
        {resv.data.results.length === 0 ? (
          <Card>
            <EmptyState>예약된 주문이 없습니다.</EmptyState>
          </Card>
        ) : (
          <ul className="divide-y divide-line rounded-2xl bg-card">
            {resv.data.results.map((r) => (
              <ReservationRow key={r.id} r={r} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function FillsTab({ easy }: { easy: boolean }) {
  const { data, isPending, isError, error, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } = useFills();
  if (isPending) return <SkeletonCard lines={5} />;
  if (isError) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />;
  const fills = data.pages.flatMap((p) => p.results);
  if (fills.length === 0) {
    return (
      <Card>
        <EmptyState>체결 내역이 없습니다.</EmptyState>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-2xl bg-card" aria-label="체결 내역">
        {fills.map((f) => (
          <li key={f.id} className="flex items-start gap-3 px-5 py-4">
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-bold",
                f.side === "BUY" ? "bg-up-soft text-up" : "bg-down-soft text-down",
              )}
            >
              {f.side === "BUY" ? "매수" : "매도"}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px] font-semibold">{f.name}</p>
              <p className="text-[13px] text-mute tabular-nums">
                {formatQty(f.quantity)} × {formatPrice(f.price, f.currency)}
              </p>
              <p className="text-[12px] text-mute">
                {fillReason(f.reason, easy)} · {formatDateTime(f.filledAt)}
              </p>
            </div>
            <p className="shrink-0 text-right">
              <span className="block text-[15px] font-semibold tabular-nums">{formatSignedKrw(f.cashChangeKrw)}</span>
              <span className="block text-[12px] text-mute">현금</span>
            </p>
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <button
          type="button"
          onClick={() => void fetchNextPage()}
          disabled={isFetchingNextPage}
          className="h-12 w-full rounded-2xl bg-card text-[15px] font-semibold text-sub hover:bg-line disabled:opacity-50"
        >
          {isFetchingNextPage ? "불러오는 중…" : "더 보기"}
        </button>
      )}
    </div>
  );
}

export function PortfolioPage() {
  const { easy } = useViewMode();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((t) => t.value === params.get("tab"))?.value ?? "holdings") as Tab;
  const setTab = (v: Tab) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (v === "holdings") sp.delete("tab");
        else sp.set("tab", v);
        return sp;
      },
      { replace: true },
    );
  return (
    <>
      <PageHeader title="모의투자" />
      <div className="space-y-5 lg:max-w-[760px]">
        {easy && <Notice>모든 매매는 모의 계좌에서만 이뤄져요 (실제 돈이 아니에요).</Notice>}
        <LivePlans easy={easy} />

        <section aria-label="내 모의 계좌">
          <div role="tablist" aria-label="내 주식" className="mb-3 flex gap-1 overflow-x-auto">
            {TABS.map((t) => (
              <button
                key={t.value}
                role="tab"
                type="button"
                aria-selected={tab === t.value}
                aria-controls={`panel-${t.value}`}
                id={`tab-${t.value}`}
                onClick={() => setTab(t.value)}
                className={cn(
                  "h-11 shrink-0 rounded-full px-4 text-[15px] font-semibold transition-colors",
                  tab === t.value ? "bg-ink text-white" : "bg-card text-sub hover:bg-line",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
            {tab === "holdings" && <Holdings easy={easy} />}
            {tab === "orders" && <OrdersTab />}
            {tab === "fills" && <FillsTab easy={easy} />}
          </div>
        </section>

        <EndedPlans easy={easy} />
        <Proposals easy={easy} />
        <DayEntry />
      </div>
    </>
  );
}
