// /portfolio 모의투자 탭 (docs/plans/컨셉변경계획.md 4-1·4-2): 진행 중 모의 자동매매 → 보유(스윙·장기 배지, 장마감 기준 평가)·대기 주문·체결 내역 →
// 끝난 계획 → 새 계획 제안(쉬운 보기는 리포트에서 나온 것만, 나머지는 접힌 "다른 계획 ○개").
// 배치 (문서 4-2 순서 그대로):
// - 모바일 한 열: 진행 중(가장 자주 보는 '지금 상태', 여정 ③) → 내 계좌 탭 → 끝난 계획(기록) → 새 계획 제안(다음 행동).
//   처음 쓰는 사람이 빈 카드를 여러 장 지나지 않게 빈 상태는 한 줄로 줄이고, 비어 있는 진행 중 칸에 '새 계획 제안 보기' 버튼을 둔다 (trade-11).
// - PC 2단: 왼쪽 = 감시(진행 중 + 계좌 탭, 자주 봄), 오른쪽 340px = 기록·다음 행동(끝난 계획 → 제안 압축 3개).
//   같은 탭의 계획 상세·실행 확인과 같은 [본문 | 오른쪽 열] 문법. DOM 순서가 모바일 순서와 같아 기기를 바꿔도 자리가 같다 (trade-12).
// - PC (2026-10-12 PC 재설계): 맨 위 계좌 요약 줄(총자산·평가손익·보유 평가액·현금·매수 가능액·진행 중 계획 — 보유 탭의 '보유 평가액' 카드를
//   이 줄로 옮겼다, 탭과 상관없이 보인다) → [진행 중 + 계좌 탭(보유는 열을 맞춘 표) | 오른쪽 열]. 오른쪽 열은 진행 중 계획이 없으면
//   새 계획 제안을 먼저(격자 자리만 바꾼다), 있으면 끝난 계획 → 제안. 표가 짜부라지지 않게 두 열은 85rem(1360px)부터,
//   그보다 좁은 PC는 한 열에 오른쪽 열 둘을 나란히 아래에 둔다 (B0-10). 요약 줄·표 머리는 PC에서만 그린다 (useIsPc — 모바일 DOM 그대로).
import { useMutation } from "@tanstack/react-query";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, errorMessage } from "../api/client";
import { isPlanLive, useAccount, useFills, useOrders, usePlans, useRecommendations, useReservations } from "../api/queries";
import { useRefreshTrading } from "../api/trading";
import type { AccountSummary, Market, Order, Reservation, TradePlan } from "../api/types";
import { AutoTradeBadge, StyleBadge } from "../components/autotrade/Badges";
import { PlanRow, PlanTableHead } from "../components/autotrade/PlanRow";
import { RecommendationRow } from "../components/autotrade/RecommendationCard";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { Sheet } from "../components/motion/Sheet";
import { useToast } from "../components/toast";
import { AsOf, Card, ErrorState, Flash, PageHeader, PillTabs, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useIsPc } from "../hooks/useIsPc";
import { revealList, useChanged, useNewKeys, useRevealAfterLoading } from "../hooks/useMotionState";
import { arrangeProposals, exitReasonLabel, otherKinds, plansByOrder } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDate, formatDateTime, formatKrw, formatPrice, formatQty, formatRate, formatSignedKrw, trendClass } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { isTodayFill, todayFillText } from "../lib/orderText";
import { errorSentence, exitReasonText } from "../lib/plainText";

type Tab = "holdings" | "orders" | "fills";
const TABS: { value: Tab; label: string }[] = [
  { value: "holdings", label: "보유 종목" },
  { value: "orders", label: "대기 주문·예약" },
  { value: "fills", label: "체결 내역" },
];

/** 체결 사유 (매수 체결 / 청산 사유 — docs/API.md "청산 사유" 표). 쉬운 보기는 쉬운 문장. */
const fillReason = (reason: string, easy: boolean) =>
  reason === "ENTRY" ? (easy ? "모의 계좌에서 샀어요" : "매수 체결") : easy ? exitReasonText(reason, true) : exitReasonLabel(reason);

/** 빈 상태 한 줄 카드 (큰 빈 카드 여러 장이 시작점을 밀어내지 않게). */
const ONE_LINE = "rounded-2xl bg-card px-5 py-4 text-[14px] leading-snug text-mute";

/**
 * 보유 종목 행의 링크(종목 · 아래 붙는 '계획 보기')는 키보드 포커스 테두리를 안쪽에 그린다: 목록 카드(ul)가 overflow-hidden rounded-2xl이라
 * 바깥 테두리는 잘려 선 하나만 남거나 이웃 행의 테두리처럼 보인다 (a11y-5). 카드 위 끝(첫 행의 첫 링크)·아래 끝(마지막 행의 마지막 링크)은
 * 테두리 모서리를 카드와 맞춘다.
 */
const HOLDING_FOCUS =
  "focus-visible:outline-offset-[-2px] [li:first-child>&:first-child]:rounded-t-2xl [li:last-child>&:last-child]:rounded-b-2xl";

/**
 * 취소하면 사라지는 행(체결 대기 주문·예약)은 포커스를 받을 수 있게 둔다(tabIndex -1, 탭 순서에는 없다): 누른 행이 사라질 때 포커스가 옮겨 갈 자리.
 * 카드(ul)가 overflow-hidden이 아니어도 테두리는 안쪽에 그리고(이웃 행·구분선에 겹치지 않게) 첫·마지막 행은 카드 모서리를 따른다.
 */
const REMOVABLE_ROW = "flex items-center gap-3 px-5 py-4 outline-offset-[-2px] first:rounded-t-2xl last:rounded-b-2xl";

/** 사라질 행 다음에 포커스를 둘 행: 같은 자리로 올라올 다음 행, 마지막 행이면 앞 행. 혼자였으면 null. */
const neighborRow = (row: Element | null) => (row?.nextElementSibling ?? row?.previousElementSibling ?? null) as HTMLElement | null;

/**
 * 누른 행이 곧 사라진다(취소 성공 — 목록을 다시 받기 전에 부른다): 포커스가 그 행 안에 있거나 이미 잃었으면 이웃 행으로, 혼자였으면 목록 제목으로
 * 미리 옮긴다 (행과 함께 사라져 body로 떨어지지 않게 — a11y-11). 이웃 '취소' 버튼이 아니라 행으로 옮기므로 Enter를 한 번 더 눌러도 다른 주문이
 * 취소되지 않는다. 사용자가 다른 곳으로 옮겼으면 그대로 둔다.
 */
function focusOffRow(row: HTMLElement | null, titleId: string) {
  const active = document.activeElement;
  if (!row || (active && active !== document.body && active.isConnected && !row.contains(active))) return;
  (neighborRow(row) ?? document.getElementById(titleId))?.focus();
}

function SectionTitle({ id, title, to, linkLabel, focusable = false }: { id: string; title: string; to?: string; linkLabel?: string; focusable?: boolean }) {
  return (
    <div className="mb-2 flex items-center justify-between gap-3 px-1">
      {/* focusable: 같은 화면의 버튼이 이 섹션으로 데려올 때 포커스를 받는다. scroll-mt: 모바일 고정 머리에 가리지 않게 */}
      <h2 id={id} tabIndex={focusable ? -1 : undefined} className="scroll-mt-20 lg:scroll-mt-(--rail-top) text-[17px] font-bold outline-none">
        {title}
      </h2>
      {to && (
        // 보이는 높이는 36px, 누르는 자리는 위아래로 넓혀 44px (trade-22)
        <Link
          to={to}
          className="press relative flex h-9 shrink-0 items-center gap-0.5 text-[14px] font-semibold text-brand-ink before:absolute before:inset-x-0 before:-inset-y-1"
        >
          {linkLabel ?? "모두 보기"}
          <Icon name="chevron" className="size-4" />
        </Link>
      )}
    </div>
  );
}

/** 진행 중 모의 자동매매 (행마다 4칸 단계 막대 — PlanRow). 비면 다음 행동으로 바로 가는 버튼. */
function LivePlans({ easy, pc, onShowProposals }: { easy: boolean; pc: boolean; onShowProposals: () => void }) {
  const { data, isPending, isError, error, refetch, isFetching } = usePlans("active");
  const reveal = useRevealAfterLoading(isPending);
  const list = data?.results ?? [];
  return (
    <section aria-labelledby="live-plans-title">
      <SectionTitle id="live-plans-title" title={easy ? "진행 중 모의 자동매매" : "진행 중 자동매매"} to="/plans" />
      {isPending ? (
        <SkeletonCard lines={3} />
      ) : isError ? (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} compact />
        </Card>
      ) : list.length === 0 ? (
        <div className="flex items-center justify-between gap-3 rounded-2xl bg-card py-3 pr-3 pl-5 lg:py-4 lg:pr-4">
          {/* PC는 아이콘과 다음 행동 한 줄을 더한다 (얇은 띠가 아니라 한 칸짜리 안내로) */}
          <div className="flex min-w-0 items-center gap-3">
            <span aria-hidden="true" className="hidden size-10 shrink-0 place-items-center rounded-full bg-fill text-mute-weak lg:grid">
              <Icon name="flow" className="size-5" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] leading-snug text-mute lg:text-[15px] lg:font-semibold lg:text-ink">
                {easy ? "진행 중인 모의 자동매매가 없어요." : "진행 중인 자동매매가 없습니다."}
              </p>
              <p className="hidden text-[13px] text-mute lg:block">
                {easy ? "새 계획 제안에서 마음에 드는 계획을 골라 시작할 수 있어요." : "AI 추천을 활성화하면 진입부터 청산까지 여기서 지켜볼 수 있습니다."}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onShowProposals}
            className="press h-11 shrink-0 rounded-xl bg-brand-soft px-3.5 text-[14px] font-semibold text-brand-ink hover:bg-brand-soft/70"
          >
            {easy ? "새 계획 제안 보기" : "AI 추천 보기"}
          </button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl bg-card">
          {pc && <PlanTableHead easy={easy} />}
          <ul {...revealList(reveal)} aria-label="진행 중 계획" className="divide-y divide-line">
            {list.map((p) => (
              <li key={p.id}>
                <PlanRow p={p} easy={easy} table />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

/** 끝난 계획 (최근 3개와 결과 손익). 불러오는 동안 자리를 미리 잡아 아래 섹션을 밀지 않는다 (motion-05·trade-17). */
function EndedPlans({ easy, pc }: { easy: boolean; pc: boolean }) {
  const { data, isPending, isError, error, refetch, isFetching } = usePlans("all");
  const reveal = useRevealAfterLoading(isPending);
  const ended = (data?.results ?? []).filter((p) => !isPlanLive(p.status)).slice(0, 3);
  return (
    <section aria-labelledby="ended-plans-title">
      <SectionTitle id="ended-plans-title" title="끝난 계획" to="/plans?status=all" />
      {isPending ? (
        <SkeletonCard lines={2} />
      ) : isError ? (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} compact />
        </Card>
      ) : ended.length === 0 ? (
        // PC는 같은 화면의 다른 빈 칸처럼 작은 안내 칸(아이콘 + 한 줄), 모바일은 글 한 줄 (trade-11)
        <p className={pc ? "flex items-center gap-3 rounded-2xl bg-card px-5 py-4 text-[14px] text-mute" : "px-1 text-[13px] text-mute"}>
          {pc && (
            <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-full bg-fill text-mute-weak">
              <Icon name="check" className="size-4" />
            </span>
          )}
          {easy ? "아직 끝난 계획이 없어요." : "끝난 계획이 없습니다."}
        </p>
      ) : (
        <ul {...revealList(reveal)} aria-label="끝난 계획" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
          {ended.map((p) => (
            <li key={p.id}>
              <PlanRow p={p} easy={easy} compact />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * 새 계획 제안 (전문가 보기: AI 추천). 탭은 요약이라 압축 행 최대 3개, 카드형 전체 목록은 /recommendations (trade-29).
 * 목록 화면과 같은 묶음 규칙(arrangeProposals — 같은 종목은 하나, 쉬운 보기는 리포트에서 나온 것만 앞에)으로 고르고 센다:
 * 시작할 수 있는 것 → 지금 시작할 수 없는 것(작은 표시) 순서. 여기서 본 행은 목록 화면에서 카드 또는 '지금은 시작할 수 없는 제안' 접힘으로
 * 그대로 있고, 'n개 모두 보기'의 n은 그 둘을 더한 수다 (같은 종목의 이전 제안·다른 출처는 목록 화면에서도 접혀 있어 세지 않는다).
 */
function Proposals({ easy }: { easy: boolean }) {
  const { data, isPending, isError, error, refetch, isFetching } = useRecommendations({ status: "open" });
  const reveal = useRevealAfterLoading(isPending);
  const [showOthers, setShowOthers] = useState(false);
  const arranged = arrangeProposals(data?.results ?? [], easy);
  const main = [...arranged.ready, ...arranged.blocked].map((g) => g.rec);
  const others = arranged.others.map((g) => g.rec);
  const shown = main.slice(0, 3);
  const total = main.length;
  return (
    <section aria-labelledby="proposals-title">
      <SectionTitle
        id="proposals-title"
        focusable
        title={easy ? "새 계획 제안" : "AI 추천"}
        to="/recommendations"
        linkLabel={total > shown.length ? `${total}개 모두 보기` : "모두 보기"}
      />
      {isPending ? (
        <SkeletonCard lines={3} />
      ) : isError ? (
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} compact />
        </Card>
      ) : main.length === 0 && others.length === 0 ? (
        <p className={ONE_LINE}>{easy ? "기한이 남은 계획 제안이 없어요. 종목에서 AI 리포트를 만들어 보세요." : "유효한 추천이 없습니다."}</p>
      ) : (
        <div className="space-y-3">
          {main.length > 0 ? (
            <ul {...revealList(reveal)} aria-label="새 계획 제안 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
              {shown.map((r) => (
                <li key={r.id}>
                  <RecommendationRow r={r} easy={easy} />
                </li>
              ))}
            </ul>
          ) : (
            <p className={ONE_LINE}>AI 리포트에서 나온 계획이 아직 없어요.</p>
          )}
          {others.length > 0 && (
            <div>
              <button
                type="button"
                aria-expanded={showOthers}
                aria-controls={showOthers ? "portfolio-others" : undefined}
                onClick={() => setShowOthers((v) => !v)}
                className="press flex min-h-12 w-full items-center justify-between gap-2 rounded-2xl bg-card px-4 py-2 text-left text-[15px] font-semibold text-sub hover:bg-line"
              >
                다른 계획 {others.length}개 ({otherKinds(others)})
                <Icon name="chevron-down" className={cn("size-5 shrink-0 text-mute-weak transition-transform duration-fast", showOthers && "rotate-180")} />
              </button>
              <Collapse open={showOthers} id="portfolio-others" className="mt-3">
                <ul aria-label="다른 계획 목록" className="divide-y divide-line overflow-hidden rounded-2xl bg-card">
                  {others.map((r) => (
                    <li key={r.id}>
                      <RecommendationRow r={r} easy={easy} />
                    </li>
                  ))}
                </ul>
              </Collapse>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** 평가 기준 문구 (보유 카드·PC 계좌 요약 줄이 같이 쓴다). 오늘 산 보유는 체결가로 평가했다 (손익 0, 장 마감 뒤에 종가로). */
function basisText(acc: AccountSummary, easy: boolean) {
  const boughtToday = acc.positions.some(isTodayFill);
  return easy
    ? `평가는 지난 장 마감 가격으로 해요${boughtToday ? " (오늘 산 종목은 장 마감 뒤에)" : ""}`
    : `평가: 직전 장마감 종가${boughtToday ? " (당일 매수는 장 마감 뒤에)" : ""}`;
}

/** 평가 기준 줄: 문구 + 시장별 장마감 기준 시각. 보유가 없으면(기준 시각이 없으면) 그리지 않는다. */
function BasisLine({ acc, easy, className }: { acc: AccountSummary; easy: boolean; className?: string }) {
  const markets = (Object.keys(acc.pricesAsOf) as Market[]).filter((m) => acc.pricesAsOf[m]).sort();
  if (markets.length === 0) return null;
  return (
    <p aria-label="평가 기준" className={cn("flex flex-wrap gap-x-3 text-[12px] text-mute", className)}>
      <span>{basisText(acc, easy)}</span>
      {/* 시장 이름을 붙인다 (날짜 두 개가 무엇인지 모른 채 이어지지 않게) */}
      {markets.map((m) => (
        <span key={m} className="whitespace-nowrap">
          {m === "KR" ? "국내" : "미국"} <AsOf at={acc.pricesAsOf[m]} market={m} />
        </span>
      ))}
    </p>
  );
}

/**
 * PC 보유 표의 열: 종목(이름·방식 배지 / 수량) · 평균가 · 종가 · 평가금액 · 손익 · 목표·손절·기한. 행과 머리가 같은 값을 쓴다.
 * 열 이름은 머리 줄(PC에서만, 화면 읽기에는 숨김)이 말하고, 칸 안의 이름('· 평균' 등)은 PC에서 화면 읽기용으로만 남긴다.
 */
const HOLD_COLS =
  "lg:grid-cols-[minmax(0,1fr)_5.5rem_5.5rem_6.5rem_6.5rem_8.75rem] 2xl:grid-cols-[minmax(0,1fr)_7rem_7rem_8.5rem_8.5rem_10.5rem]";
/** 두 줄 높이 숫자 칸 (가운데, 오른쪽 정렬). */
const HOLD_NUM = "lg:row-span-2 lg:row-start-1 lg:self-center lg:text-right";

function HoldingsHead({ easy }: { easy: boolean }) {
  return (
    <div aria-hidden="true" className={cn("grid gap-x-3 border-b border-line px-5 py-2.5 text-[12px] font-medium text-mute 2xl:gap-x-4", HOLD_COLS)}>
      <span>종목</span>
      <span className="text-right">{easy ? "산 가격" : "평균가"}</span>
      <span className="text-right">{easy ? "지난 종가" : "종가"}</span>
      <span className="text-right">평가금액</span>
      <span className="text-right">손익</span>
      <span className="lg:pl-3">{easy ? "목표 · 손절 가격" : "목표 · 손절 · 기한"}</span>
    </div>
  );
}

function Holdings({ easy, pc, byOrder, plansReady }: { easy: boolean; pc: boolean; byOrder: Map<number, TradePlan>; plansReady: boolean }) {
  const { data: acc, isPending, isError, error, refetch, isFetching } = useAccount();
  const reveal = useRevealAfterLoading(isPending || !plansReady);
  // 계획 연결 줄이 늦게 끼어들어 행이 밀리지 않게 진행 중 계획까지 받은 뒤에 그린다
  if (isPending || !plansReady) return <SkeletonCard lines={5} />;
  if (isError) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />;
  const notes = acc.notes.map((n) => (
    <p key={n} className="px-1 text-[13px] text-mute">
      {n}
    </p>
  ));
  if (acc.positions.length === 0) {
    // 보유가 없으면 평가액 '0원 (-)' 카드와 빈 목록 카드를 한 줄로 합친다 (trade-11).
    // PC는 위 계좌 요약 줄이 현금을 보이므로, 무엇을·어떻게 시작하는지와 다음 행동 하나만 둔 안내 칸
    return (
      <div className="space-y-3">
        {pc ? (
          <div className="flex items-center gap-4 rounded-2xl bg-card px-5 py-5">
            <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-fill text-mute-weak">
              <Icon name="chart" className="size-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[15px] font-semibold">{easy ? "아직 산 종목이 없어요" : "보유 중인 종목이 없습니다"}</p>
              <p className="text-[13px] text-mute">
                {easy ? "종목 화면에서 직접 사거나, 새 계획 제안으로 모의 자동매매를 시작해 보세요." : "종목 화면에서 직접 매수하거나 AI 추천을 활성화하세요."}
              </p>
            </div>
            <Link
              to="/search"
              className="press flex h-11 shrink-0 items-center rounded-xl bg-brand-soft px-4 text-[14px] font-semibold text-brand-ink hover:bg-brand-soft/70"
            >
              종목 찾아보기
            </Link>
          </div>
        ) : (
          <p className="rounded-2xl bg-card px-5 py-4 text-[15px] leading-snug text-sub">
            {easy ? "아직 산 종목이 없어요" : "보유 중인 종목이 없습니다"} · 현금 <b className="font-semibold text-ink tabular-nums">{formatKrw(acc.cashKrw)}</b>
          </p>
        )}
        {notes}
      </div>
    );
  }
  const profit = acc.positions.reduce((n, p) => n + p.profitKrw, 0);
  return (
    <div className="space-y-3">
      {/* 보유 평가액 카드: PC는 맨 위 계좌 요약 줄로 옮겼다 (같은 숫자를 두 번 보이지 않게) */}
      {!pc && (
        <Card>
          <p className="text-[14px] text-sub">보유 평가액</p>
          <p className="text-[26px] font-bold tracking-tight tabular-nums">
            <Flash value={acc.holdingsValueKrw}>{formatKrw(acc.holdingsValueKrw)}</Flash>
          </p>
          <p className={cn("text-[15px] font-semibold tabular-nums", trendClass(profit))}>
            {formatSignedKrw(profit)} ({formatRate(acc.investedKrw ? profit / acc.investedKrw : null)})
          </p>
          <p className="mt-2 text-[13px] text-mute">
            투자금액 {formatKrw(acc.investedKrw)} · 현금 {formatKrw(acc.cashKrw)}
          </p>
          <BasisLine acc={acc} easy={easy} className="mt-1" />
        </Card>
      )}
      <div className="overflow-hidden rounded-2xl bg-card">
        {pc && <HoldingsHead easy={easy} />}
        <ul {...revealList(reveal)} className="divide-y divide-line" aria-label="보유 종목">
          {acc.positions.map((p) => {
            const plan = byOrder.get(p.orderId);
            const today = isTodayFill(p);
            return (
              <li key={p.orderId}>
                {/* PC(lg)는 열을 맞춘 표 한 줄: 래퍼를 lg:contents로 풀어 칸마다 격자 자리를 준다 (DOM·모바일 모습은 그대로) */}
                <Link
                  to={`/stocks/${encodeURIComponent(p.symbol)}`}
                  className={cn(
                    "press-row block px-5 py-4 hover:bg-fill/50 lg:grid lg:min-h-16 lg:items-center lg:gap-x-3 lg:gap-y-0.5 lg:py-3 2xl:gap-x-4",
                    HOLD_COLS,
                    HOLDING_FOCUS,
                  )}
                >
                  <div className="flex items-start justify-between gap-3 lg:contents">
                    <div className="min-w-0 lg:contents">
                      <p className="flex min-w-0 items-center gap-1.5 text-[16px] font-semibold lg:col-start-1 lg:row-start-1 lg:self-end">
                        <span className="truncate">{p.name}</span>
                        <StyleBadge style={p.style} />
                      </p>
                      <p className="text-[13px] text-mute tabular-nums lg:contents">
                        <span className="lg:col-start-1 lg:row-start-2 lg:self-start">{formatQty(p.quantity)}</span>
                        <span className={cn("lg:col-start-2 lg:text-[14px] lg:text-ink", HOLD_NUM)}>
                          <span className="lg:sr-only">{` · ${easy ? "산 가격" : "평균"} `}</span>
                          {formatPrice(p.avgPrice, p.currency)}
                        </span>
                        {!today && (
                          <span className={cn("lg:col-start-3 lg:text-[14px] lg:text-ink", HOLD_NUM)}>
                            <span className="lg:sr-only"> · 종가 </span>
                            {formatPrice(p.lastPrice, p.currency)}
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="shrink-0 text-right lg:contents">
                      <p className={cn("text-[16px] font-semibold tabular-nums lg:col-start-4 lg:text-[15px]", HOLD_NUM)}>
                        <Flash value={p.valueKrw}>{formatKrw(p.valueKrw)}</Flash>
                      </p>
                      {!today && (
                        <p className={cn("text-[13px] font-medium tabular-nums lg:col-start-5 lg:text-[14px] lg:font-semibold", HOLD_NUM, trendClass(p.profitKrw))}>
                          {formatSignedKrw(p.profitKrw)} <span className="lg:block lg:text-[13px] lg:font-medium">({formatRate(p.profitRate)})</span>
                        </p>
                      )}
                    </div>
                  </div>
                  {today && (
                    <p className={cn("mt-1 text-[12px] leading-snug font-medium text-sub lg:col-start-5 lg:mt-0", HOLD_NUM)}>
                      {todayFillText(p.market, easy)}
                    </p>
                  )}
                  {p.style === "long" ? (
                    <p className="mt-2 text-[12px] text-mute lg:col-start-6 lg:row-span-2 lg:row-start-1 lg:mt-0 lg:self-center lg:pl-3">
                      {easy ? "장기 보유 · 자동으로 팔지 않아요" : "장기 보유 · 자동 매도 없음"}
                    </p>
                  ) : (
                    (p.targetPrice != null || p.expireDate) && (
                      <p className="mt-2 text-[12px] text-mute tabular-nums lg:col-start-6 lg:row-span-2 lg:row-start-1 lg:mt-0 lg:self-center lg:pl-3 lg:leading-snug">
                        {p.targetPrice != null && (
                          <span className="whitespace-nowrap">
                            <span className="lg:block">
                              {easy ? "목표 가격" : "목표"} <span className="text-up">{formatPrice(p.targetPrice, p.currency)}</span>
                            </span>
                            <span className="lg:hidden"> · </span>
                            <span className="lg:block">
                              {easy ? "손절 가격" : "손절"} <span className="text-down">{formatPrice(p.stopPrice, p.currency)}</span>
                            </span>
                          </span>
                        )}
                        {p.expireDate && (
                          <>
                            <span className="lg:hidden"> · </span>
                            <span className="lg:block">{formatDate(p.expireDate)}까지</span>
                          </>
                        )}
                      </p>
                    )
                  )}
                </Link>
                {/* 계획이 산 보유: 종목 화면에서 직접 팔면 계획이 끝나므로, 계획이 팔아 준다는 것과 계획으로 가는 길을 함께 보인다 (trade-05) */}
                {plan && (
                  <Link
                    to={`/plans/${plan.id}`}
                    className={cn(
                      "press-row flex items-center gap-2 border-t border-dashed border-line px-5 py-2.5 text-[13px] font-semibold text-brand-ink hover:bg-fill/50",
                      HOLDING_FOCUS,
                    )}
                  >
                    <Icon name="flow" className="size-4 shrink-0" />
                    {/* 시연용 수동 시작 계획이면 앞에 '시연용' (체결 전 주문 행의 자동매매 배지 ' · 시연용'과 같이 — DECISIONS 31장) */}
                    {plan.manualStart && "시연용 "}
                    {easy ? "모의 자동매매가 목표·손절에 자동으로 팔아요 · 계획 보기" : `자동매매 #${plan.id}가 청산을 관리합니다 · 계획 보기`}
                    <Icon name="chevron" className="ml-auto size-4 shrink-0" />
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      {notes}
    </div>
  );
}

/** PC 계좌 요약 줄의 한 칸 (ui.tsx Stat과 같은 글자 크기 — 칸 수가 폭에 따라 3열 ↔ 한 줄로 바뀌어 StatGrid 대신 격자로 늘어놓는다). */
function Kpi({
  label,
  value,
  sub,
  note,
  big = false,
  valueClass,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  /** 보조 줄 아래 짧은 설명 (예: 총자산에 판 주식 손익이 들어 있다는 말) */
  note?: string;
  big?: boolean;
  valueClass?: string;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0 min-[85rem]:border-l min-[85rem]:border-line min-[85rem]:pl-5 min-[85rem]:first:border-l-0 min-[85rem]:first:pl-0", className)}>
      <dt className="text-[13px] font-medium text-mute">{label}</dt>
      <dd className={cn("mt-1 truncate leading-tight font-bold tabular-nums", big ? "text-[28px] tracking-tight" : "text-[22px] min-[85rem]:text-[20px] 2xl:text-[22px]", valueClass)}>{value}</dd>
      {sub && <dd className="mt-1 truncate text-[13px] text-sub tabular-nums">{sub}</dd>}
      {note && <dd className="mt-0.5 truncate text-[12px] text-mute">{note}</dd>}
    </div>
  );
}

/**
 * PC 맨 위 계좌 요약 (탭과 상관없이). 보유 탭의 '보유 평가액' 카드 숫자를 여기로 옮겼다 — PC에서는 그 카드를 그리지 않는다.
 * 평가손익은 보유 종목의 손익 합계(매수 원금 대비), 총자산 아래 줄은 처음 자금 대비 (홈 자산 카드와 같은 숫자).
 */
function AccountStrip({ easy, live }: { easy: boolean; live: TradePlan[] | undefined }) {
  const { data: acc, isPending } = useAccount();
  if (isPending) return <SkeletonCard lines={2} className="mb-5" />;
  if (!acc) return null; // 받지 못하면 보유 탭이 오류와 다시 받기를 보인다
  const profit = acc.positions.reduce((n, p) => n + p.profitKrw, 0);
  const has = acc.positions.length > 0;
  const holding = live?.filter((p) => p.status === "holding").length ?? 0;
  const waiting = (live?.length ?? 0) - holding;
  const showPower = !easy && acc.buyingPowerKrw !== null;
  return (
    <Card aria-label={easy ? "내 모의 계좌 요약" : "계좌 요약"} className="mb-5">
      {/* 넓은 PC는 한 줄 (총자산 칸만 넓게), 좁은 PC는 3열 두 줄 */}
      <dl
        className={cn(
          "grid grid-cols-3 gap-x-6 gap-y-5 min-[85rem]:gap-x-4",
          showPower ? "min-[85rem]:grid-cols-[1.25fr_repeat(5,minmax(0,1fr))]" : "min-[85rem]:grid-cols-[1.25fr_repeat(4,minmax(0,1fr))]",
        )}
      >
        <Kpi
          big
          // 칸이 다섯이면 좁은 PC(3열 두 줄)에서 총자산이 두 칸을 차지한다 (빈 칸 없이)
          className={showPower ? undefined : "col-span-2 min-[85rem]:col-span-1"}
          label={easy ? "모의 계좌 총자산" : "총자산"}
          value={<Flash value={acc.equityKrw}>{formatKrw(acc.equityKrw)}</Flash>}
          sub={
            <span className={trendClass(acc.profitKrw)}>
              {easy ? "처음 자금보다 " : "누적 "}
              {formatSignedKrw(acc.profitKrw)} ({formatRate(acc.profitRate)})
            </span>
          }
          // 옆 칸 '산 주식의 손익'은 지금 가진 종목만이다 — 둘이 왜 다른지 (이미 판 주식의 손익은 총자산에만 들어 있다)
          note={easy ? "이미 판 주식의 손익까지 포함" : "실현 손익·비용 포함"}
        />
        <Kpi
          label={easy ? "지금 가진 주식의 손익" : "평가손익"}
          value={has ? formatSignedKrw(profit) : "0원"}
          valueClass={has ? trendClass(profit) : "text-mute"}
          sub={
            has ? (
              <>
                <span className={trendClass(profit)}>{formatRate(acc.investedKrw ? profit / acc.investedKrw : null)}</span> ·{" "}
                {easy ? "산 금액 대비" : "투자금액 대비"}
              </>
            ) : easy ? (
              "아직 산 종목이 없어요"
            ) : (
              "보유 없음"
            )
          }
        />
        <Kpi
          label={easy ? "주식 평가액" : "보유 평가액"}
          value={<Flash value={acc.holdingsValueKrw}>{formatKrw(acc.holdingsValueKrw)}</Flash>}
          sub={has ? `${acc.positions.length}종목` : undefined}
        />
        <Kpi label="현금" value={formatKrw(acc.cashKrw)} sub={easy ? "모의 계좌의 남은 돈" : undefined} />
        {showPower && (
          <Kpi label="매수 가능액" value={formatKrw(acc.buyingPowerKrw)} sub={acc.pendingKrw ? `대기 매수 ${formatKrw(acc.pendingKrw)}` : "현금 − 대기 매수"} />
        )}
        <Kpi
          label={easy ? "진행 중 모의 자동매매" : "진행 중 자동매매"}
          value={live ? `${live.length}건` : "—"}
          sub={live && live.length > 0 ? (easy ? `산 뒤 ${holding} · 사기 전 ${waiting}` : `보유 ${holding} · 체결 대기 ${waiting}`) : undefined}
        />
      </dl>
      <BasisLine acc={acc} easy={easy} className="mt-4 border-t border-line pt-3" />
    </Card>
  );
}

/**
 * 취소 요청. beforeRefresh: 성공한 뒤 목록을 다시 받기 전에 (다시 받으면 누른 행이 사라진다 — 그 전에 포커스를 옮길 자리).
 * 진행 중(isPending)은 다시 받기가 끝날 때까지 이어진다 (onSuccess를 기다린다) — 그동안 버튼은 눌러도 무시한다.
 */
function useCancel<T>(fn: (id: number) => Promise<T>, done: string, beforeRefresh?: () => void) {
  const toast = useToast();
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      toast(done, "success");
      beforeRefresh?.();
      await refresh();
    },
    onError: (err) => toast(errorSentence(err), "error"),
  });
}

const ROW_BTN =
  "press inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line disabled:opacity-50 aria-disabled:hover:bg-fill";

/** 진행 중 계획 목록을 지금 다시 받는다 (계획에 묶인 주문인지 확인용). */
type RecheckPlans = () => Promise<{ data?: { results: TradePlan[] } }>;

function PendingRow({
  o,
  plan,
  verified,
  recheckPlans,
  easy,
}: {
  o: Order;
  plan: TradePlan | undefined;
  /** 이 주문을 본 뒤에 계획 목록을 받아 계획에 묶인 주문이 아님을 확인했는지 (아니면 '확인 중'). */
  verified: boolean;
  recheckPlans: RecheckPlans;
  easy: boolean;
}) {
  const toast = useToast();
  const row = useRef<HTMLLIElement>(null);
  // 취소되면 이 행이 사라진다 → 포커스는 이웃 행, 혼자였으면 '체결 대기 주문' 제목으로
  const cancel = useCancel((id) => api.post<Order>(`/api/orders/${id}/cancel`), "주문을 취소했습니다.", () => focusOffRow(row.current, "pending-title"));
  const [checking, setChecking] = useState(false);
  // 확인·취소하는 동안: disabled 대신 aria-disabled로 누름만 무시한다 (막으면 누른 버튼의 포커스가 body로 빠진다 — a11y-11)
  const busy = checking || cancel.isPending;
  const planLink = useRef<HTMLAnchorElement>(null);
  // 누른 '취소'가 '계획 보기'로 바뀌면 그 링크로 포커스를 옮긴다 (누른 버튼이 사라져도 자리를 잃지 않게)
  const focusPlan = useRef(false);
  useEffect(() => {
    if (!plan || !focusPlan.current) return;
    focusPlan.current = false;
    planLink.current?.focus();
  }, [plan]);
  // 누른 순간에 계획 목록을 한 번 더 받아 본다: 계획의 사는 주문을 여기서 취소하면 확인 없이 계획까지 끝나므로 (trade-05·trade-r2)
  const cancelUnlinked = async () => {
    setChecking(true);
    focusPlan.current = true;
    const fresh = await recheckPlans();
    setChecking(false);
    if (fresh.data?.results.some((p) => p.orderId === o.id)) {
      toast(easy ? "모의 자동매매의 사는 주문이에요. 계획 화면에서 멈춰 주세요." : "자동매매 계획의 진입 주문입니다. 계획 화면에서 중단하세요.");
      return;
    }
    focusPlan.current = false;
    cancel.mutate(o.id);
  };
  return (
    <li ref={row} tabIndex={-1} className={REMOVABLE_ROW}>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-1.5 text-[16px] font-semibold">
          <span className="truncate">{o.name}</span>
          <StyleBadge style={o.style} />
          {plan && <AutoTradeBadge planId={plan.id} easy={easy} manual={plan.manualStart} />}
        </p>
        <p className="text-[13px] text-mute tabular-nums">
          {o.orderType === "LIMIT" ? `지정가 ${formatPrice(o.limitPrice, o.currency)}` : "시장가"} · {formatQty(o.quantity)} · {formatDateTime(o.createdAt)}
        </p>
      </div>
      {plan ? (
        // 계획의 사는 주문을 여기서 취소하면 계획까지 끝난다 → 확인 대화상자가 있는 계획 화면의 멈추기로 모은다 (trade-05)
        <Link ref={planLink} to={`/plans/${plan.id}`} aria-label={`${o.name} 자동매매 계획 보기`} className={ROW_BTN}>
          계획 보기
        </Link>
      ) : !verified ? (
        // 계획 목록보다 새로운 주문: 계획에 묶였는지 알 때까지 '취소'를 보이지 않는다 (다른 탭·기기에서 막 시작한 계획의 주문일 수 있다)
        <button type="button" disabled aria-busy="true" className={ROW_BTN} aria-label={`${o.name} 주문 확인 중`}>
          확인 중
        </button>
      ) : (
        <button
          type="button"
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          onClick={() => {
            if (!busy) void cancelUnlinked();
          }}
          className={cn(ROW_BTN, busy && "cursor-progress")}
          aria-label={`${o.name} 주문 취소`}
        >
          {busy && <Spinner />}
          취소
        </button>
      )}
    </li>
  );
}

function ReservationRow({
  r,
  plan,
  easy,
  onAsk,
}: {
  r: Reservation;
  plan: TradePlan | undefined;
  easy: boolean;
  /** 계획의 매도 예약 취소 확인을 연다. row: 이 행 (취소되면 사라질 자리 — 포커스를 옮길 이웃을 잡아 둔다). */
  onAsk: (row: HTMLLIElement | null) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  // 취소되면 이 행이 사라진다 → 포커스는 이웃 행, 혼자였으면 예약 목록 제목으로
  const cancel = useCancel((id) => api.del(`/api/reservations/${id}`), "예약을 취소했습니다.", () => focusOffRow(row.current, "resv-title"));
  const stopping = plan != null && r.kind === "SELL";
  return (
    <li ref={row} tabIndex={-1} className={REMOVABLE_ROW}>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[16px] font-semibold">
          <span className={cn("rounded-md px-1.5 py-0.5 text-[12px] font-bold", r.kind === "BUY" ? "bg-up-soft text-up-ink" : "bg-down-soft text-down-ink")}>
            {r.kind === "BUY" ? "매수 예약" : "매도 예약"}
          </span>
          <span className="truncate">{r.name}</span>
          {r.style && <StyleBadge style={r.style} />}
          {plan && <AutoTradeBadge planId={plan.id} easy={easy} stopping={stopping} manual={plan.manualStart} />}
        </p>
        <p className="text-[13px] text-mute tabular-nums">
          {formatQty(r.quantity)} · {r.runAt ? `${formatDateTime(r.runAt)} 실행 예정` : "다음 정규장 시작에 실행"}
        </p>
        {plan && (
          // 보이는 높이는 32px, 누르는 자리는 위아래로 넓혀 44px (trade-22)
          <Link
            to={`/plans/${plan.id}`}
            className="relative mt-0.5 inline-flex h-8 items-center gap-0.5 text-[13px] font-semibold text-brand-ink before:absolute before:-inset-x-1 before:-inset-y-1.5"
          >
            계획 보기
            <Icon name="chevron" className="size-3.5" />
          </Link>
        )}
      </div>
      <button
        type="button"
        // 취소하는 동안: disabled 대신 aria-disabled로 누름만 무시한다 (막으면 누른 버튼의 포커스가 body로 빠진다 — a11y-11)
        aria-disabled={cancel.isPending || undefined}
        aria-busy={cancel.isPending || undefined}
        onClick={() => {
          if (cancel.isPending) return;
          // 계획의 매도 예약은 취소하면 장 시작에 팔지 않고 자동매매가 계속된다 → 확인을 받는다 (trade-v06)
          if (stopping) onAsk(row.current);
          else cancel.mutate(r.id);
        }}
        className={cn(ROW_BTN, cancel.isPending && "cursor-progress")}
        aria-label={`${r.name} 예약 취소`}
      >
        {cancel.isPending && <Spinner />}
        취소
      </button>
    </li>
  );
}

/** 계획에 묶인 매도 예약 취소 확인. 시트는 탭에 하나만 두어, 취소로 행이 사라져도 닫힘 애니메이션이 끊기지 않는다. */
function KeepPlanSheet({
  ask,
  easy,
  onClose,
  onDone,
}: {
  ask: { r: Reservation; plan: TradePlan } | null;
  easy: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const cancel = useCancel((id) => api.del(`/api/reservations/${id}`), "예약을 취소했습니다.");
  const keep = useRef<HTMLButtonElement>(null);
  // 닫히는 동안에도 마지막 내용을 그린다
  const [shown, setShown] = useState(ask);
  if (ask && ask !== shown) setShown(ask);
  return (
    <Sheet open={ask !== null} onClose={onClose} labelledBy="keep-plan-title" initialFocus={keep}>
      {shown && (
        <>
          <h2 id="keep-plan-title" className="text-[18px] font-bold">
            매도 예약을 취소할까요?
          </h2>
          <p className="mt-2 text-[15px] leading-relaxed text-sub">
            {easy
              ? `취소하면 장 시작에 팔지 않고 ${shown.r.name} 모의 자동매매를 계속해요. 목표·손절은 계속 지켜봐요.`
              : `취소하면 다음 정규장 시작의 전량 매도가 실행되지 않고, 자동매매 #${shown.plan.id}는 보유 감시를 계속합니다.`}
          </p>
          <div className="mt-5 grid grid-cols-2 gap-2">
            <button ref={keep} type="button" onClick={onClose} className="press h-12 rounded-xl bg-fill text-[16px] font-semibold text-sub hover:bg-line">
              닫기
            </button>
            <button
              type="button"
              // 보내는 동안: disabled 대신 aria-disabled (막으면 누른 버튼의 포커스가 시트 밖 body로 빠진다)
              aria-disabled={cancel.isPending || undefined}
              aria-busy={cancel.isPending || undefined}
              onClick={() => {
                if (!cancel.isPending) cancel.mutate(shown.r.id, { onSuccess: onDone });
              }}
              className={cn(
                "press flex h-12 items-center justify-center gap-1.5 rounded-xl bg-ink text-[16px] font-semibold text-on-ink hover:bg-ink/85 aria-disabled:hover:bg-ink",
                cancel.isPending && "cursor-progress",
              )}
            >
              {cancel.isPending && <Spinner />}
              예약 취소
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

/** 진행 중 계획 목록을 언제 받았는지(받지 못했는지)와 지금 다시 받기 (계획에 묶인 주문인지 확인용). */
interface PlansCheck {
  at: number; // 마지막으로 받은 시각 (dataUpdatedAt)
  errorAt: number; // 마지막으로 받지 못한 시각 (errorUpdatedAt)
  recheck: RecheckPlans;
}

/**
 * 계획 목록이 아직 모르는 새 체결 대기 주문 (trade-r2). 계획은 서버에서 주문보다 먼저 생기지만 두 목록은 따로 5초마다 받으므로,
 * 다른 탭·기기(Discord 링크)에서 계획을 시작하면 주문 목록이 계획 목록보다 먼저 새 주문을 보일 수 있다.
 * 처음 그린 목록에 없던 주문은, 그 주문을 본 뒤에 계획 목록을 받을 때까지 확인되지 않은 것으로 두고 계획 목록을 바로 다시 받는다.
 * 확인은 계획 목록의 받은 시각으로 한다 — 같은 렌더에서 '계획 보기' 연결도 함께 바뀐다 (받기가 끝난 뒤 따로 표시하면 그 사이 '취소'가 깜빡인다).
 * 다시 받지 못했으면 기다리지 않는다 (연결 표시 없이 그린다 — 처음 불러올 때와 같은 규칙. 누를 때 한 번 더 확인한다).
 */
function useVerifiedOrders(pending: Order[] | null, ordersAt: number, plans: PlansCheck) {
  // 주문 번호 → 처음 본 주문 응답 시각. 처음 그린 목록은 계획 목록과 함께 받은 것이라 0 (확인된 것으로 본다)
  const [seen, setSeen] = useState<ReadonlyMap<number, number> | null>(null);
  let map = seen;
  if (pending) {
    const fresh = pending.filter((o) => !map?.has(o.id));
    if (map === null || fresh.length > 0) {
      const next = new Map(map ?? []);
      for (const o of fresh) next.set(o.id, map === null ? 0 : ordersAt);
      map = next;
      setSeen(next);
    }
  }
  const verified = (id: number) => {
    const at = map?.get(id) ?? 0;
    return at === 0 || plans.at > at || plans.errorAt > at;
  };
  const waitingSince = Math.max(0, ...(pending ?? []).filter((o) => !verified(o.id)).map((o) => map?.get(o.id) ?? 0));
  const recheck = plans.recheck;
  useEffect(() => {
    // 진행 중인 받기가 있으면 취소하고 새로 받는다 (이 주문을 본 뒤에 나간 요청의 목록이 되게)
    if (waitingSince > 0) void recheck();
  }, [waitingSince, recheck]);
  return verified;
}

function OrdersTab({ easy, byOrder, plansReady, plans }: { easy: boolean; byOrder: Map<number, TradePlan>; plansReady: boolean; plans: PlansCheck }) {
  const orders = useOrders("active");
  const resv = useReservations();
  // 계획에 묶인 주문인지 알기 전에는 '취소' 버튼을 보이지 않는다 (잠깐 보였다가 '계획 보기'로 바뀌면 잘못 누른다)
  const loading = orders.isPending || resv.isPending || !plansReady;
  const reveal = useRevealAfterLoading(loading);
  const verified = useVerifiedOrders(
    loading || !orders.data ? null : orders.data.results.filter((o) => o.status === "ENTRY_PENDING"),
    orders.dataUpdatedAt,
    plans,
  );
  const [ask, setAsk] = useState<{ r: Reservation; plan: TradePlan } | null>(null);
  const resvTitle = useRef<HTMLHeadingElement>(null);
  // 확인 시트에서 예약을 취소해 누른 행이 사라졌으면, 바로 취소한 행과 같은 규칙으로 이웃 행(시트를 연 순간에 잡아 둔다), 혼자였으면
  // 예약 목록 제목으로 포커스를 옮긴다 (갈 곳을 잃지 않게). 시트가 열린 동안은 배경이 inert라 포커스를 줄 수 없으므로,
  // 시트가 닫힌(잠금이 풀린) 커밋 뒤에 옮긴다
  const refocus = useRef(false);
  const askNeighbor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (ask || !refocus.current) return;
    refocus.current = false;
    const next = askNeighbor.current;
    (next?.isConnected ? next : resvTitle.current)?.focus();
  }, [ask]);
  if (loading) return <SkeletonCard lines={4} />;
  if (orders.isError || resv.isError) {
    return (
      <ErrorState
        message={errorMessage(orders.error ?? resv.error)}
        onRetry={() => void Promise.all([orders.refetch(), resv.refetch()])}
        retrying={orders.isFetching || resv.isFetching}
      />
    );
  }
  const pending = orders.data.results.filter((o) => o.status === "ENTRY_PENDING");
  const reservations = resv.data.results;
  return (
    <div className="space-y-4">
      <section aria-labelledby="pending-title">
        {/* tabIndex -1: 하나 남은 주문을 취소하면 포커스가 옮겨 오는 자리 (화면 머리 제목처럼 테두리 없이) */}
        <h2 id="pending-title" tabIndex={-1} className="mb-2 px-1 text-[15px] font-semibold text-sub outline-none">
          체결 대기 주문
        </h2>
        {pending.length === 0 ? (
          <p className={ONE_LINE}>체결 대기 중인 주문이 없습니다.</p>
        ) : (
          <ul {...revealList(reveal)} className="divide-y divide-line rounded-2xl bg-card">
            {pending.map((o) => (
              <PendingRow key={o.id} o={o} plan={byOrder.get(o.id)} verified={verified(o.id)} recheckPlans={plans.recheck} easy={easy} />
            ))}
          </ul>
        )}
      </section>
      <section aria-labelledby="resv-title">
        <h2 id="resv-title" ref={resvTitle} tabIndex={-1} className="mb-2 px-1 text-[15px] font-semibold text-sub outline-none">
          예약 (다음 정규장 시작에 실행)
        </h2>
        {reservations.length === 0 ? (
          <p className={ONE_LINE}>예약된 주문이 없습니다.</p>
        ) : (
          <ul {...revealList(reveal)} className="divide-y divide-line rounded-2xl bg-card">
            {reservations.map((r) => {
              const plan = r.orderId != null ? byOrder.get(r.orderId) : undefined;
              return (
                <ReservationRow
                  key={r.id}
                  r={r}
                  plan={plan}
                  easy={easy}
                  onAsk={(row) => {
                    if (!plan) return;
                    askNeighbor.current = neighborRow(row);
                    setAsk({ r, plan });
                  }}
                />
              );
            })}
          </ul>
        )}
      </section>
      <KeepPlanSheet
        ask={ask}
        easy={easy}
        onClose={() => setAsk(null)}
        onDone={() => {
          refocus.current = true;
          setAsk(null);
        }}
      />
    </div>
  );
}

function FillsTab({ easy }: { easy: boolean }) {
  const { data, isPending, isError, error, refetch, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = useFills();
  const reveal = useRevealAfterLoading(isPending);
  const fills = data?.pages.flatMap((p) => p.results) ?? [];
  // '더 보기'로 붙은 행만 짧게 페이드하고(행 목록이라 이동 없이), 그 첫 행으로 포커스를 옮긴다 (버튼이 아래로 밀려도 읽던 자리를 잃지 않게 — motion-16)
  const fresh = useNewKeys(
    fills.map((f) => f.id),
    !isPending,
  );
  const list = useRef<HTMLUListElement>(null);
  const focusFrom = useRef<number | null>(null);
  useEffect(() => {
    const at = focusFrom.current;
    if (at === null || fills.length <= at) return;
    focusFrom.current = null;
    (list.current?.children[at] as HTMLElement | undefined)?.focus();
  }, [fills.length]);
  if (isPending) return <SkeletonCard lines={5} />;
  if (isError) return <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />;
  if (fills.length === 0) return <p className={ONE_LINE}>체결 내역이 없습니다.</p>;
  return (
    <div className="space-y-3">
      <ul ref={list} {...revealList(reveal)} className="divide-y divide-line rounded-2xl bg-card" aria-label="체결 내역">
        {fills.map((f) => (
          <li
            key={f.id}
            tabIndex={-1}
            className={cn("flex items-start gap-3 px-5 py-4 outline-offset-[-2px] first:rounded-t-2xl last:rounded-b-2xl", fresh.has(f.id) && "reveal-fade")}
          >
            <span
              className={cn(
                "mt-0.5 shrink-0 rounded-md px-1.5 py-0.5 text-[12px] font-bold",
                f.side === "BUY" ? "bg-up-soft text-up-ink" : "bg-down-soft text-down-ink",
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
          onClick={() => {
            focusFrom.current = fills.length;
            void fetchNextPage();
          }}
          disabled={isFetchingNextPage}
          aria-busy={isFetchingNextPage || undefined}
          className="press flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-card text-[15px] font-semibold text-sub hover:bg-line disabled:opacity-60"
        >
          {isFetchingNextPage && <Spinner />}
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
  // 탭을 바꾼 뒤에만 패널이 짧게 페이드한다 (처음 그린 패널은 움직이지 않는다)
  const tabChanged = useChanged(tab);
  // 진행 중 계획을 주문 번호로 찾아 내 주식 행에 잇는다 (진행 중 목록과 같은 쿼리라 요청이 늘지 않는다)
  const livePlans = usePlans("active");
  const byOrder = plansByOrder(livePlans.data?.results ?? []);
  const plansReady = !livePlans.isPending; // 오류여도 기다리지 않는다 (연결 표시만 빠진다)
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
  // 비어 있는 진행 중 칸의 버튼: 같은 화면의 새 계획 제안으로 (해시 링크는 SPA에서 저절로 스크롤되지 않는다)
  const showProposals = () => {
    const h = document.getElementById("proposals-title");
    if (!h) return;
    h.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    h.focus({ preventScroll: true });
  };
  const pc = useIsPc();
  const live = livePlans.data?.results;
  // 진행 중 계획이 없으면 PC 오른쪽 열은 새 계획 제안을 먼저 (지금 할 다음 행동 — 격자 자리만 바꾼다, DOM·모바일 순서는 그대로)
  const proposalsFirst = live !== undefined && live.length === 0;
  return (
    <>
      <PageHeader title="모의투자" />
      {/* 안전 문구는 제목 아래 캡션으로 (예전 안내 띠가 첫 화면의 진행 중 칸을 밀어내지 않게 — trade-11) */}
      {easy && <p className="-mt-1 mb-3 px-1 text-[13px] text-sub lg:-mt-2 lg:mb-4">모든 매매는 모의 계좌에서만 이뤄져요 (실제 돈이 아니에요).</p>}
      {pc && <AccountStrip easy={easy} live={live} />}
      <div className="space-y-5 min-[85rem]:grid min-[85rem]:grid-cols-[minmax(0,1fr)_340px] min-[85rem]:items-start min-[85rem]:gap-6 min-[85rem]:space-y-0 2xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-5">
          <LivePlans easy={easy} pc={pc} onShowProposals={showProposals} />

          <section aria-label="내 모의 계좌">
            <PillTabs label="내 주식" value={tab} options={TABS} onChange={setTab} className="mb-3" />
            <div key={tab} role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className={tabChanged ? "reveal-fade" : undefined}>
              {tab === "holdings" && <Holdings easy={easy} pc={pc} byOrder={byOrder} plansReady={plansReady} />}
              {tab === "orders" && (
                <OrdersTab
                  easy={easy}
                  byOrder={byOrder}
                  plansReady={plansReady}
                  plans={{ at: livePlans.dataUpdatedAt, errorAt: livePlans.errorUpdatedAt, recheck: livePlans.refetch }}
                />
              )}
              {tab === "fills" && <FillsTab easy={easy} />}
            </div>
          </section>
        </div>

        {/* 좁은 PC(85rem 미만)는 한 열 아래에 둘을 나란히, 넓은 PC는 오른쪽 열에 위아래로 */}
        <div className="space-y-5 lg:grid lg:grid-cols-2 lg:items-start lg:gap-5 lg:space-y-0 min-[85rem]:grid-cols-1">
          <div className={cn("min-w-0", proposalsFirst && "lg:col-start-2 lg:row-start-1 min-[85rem]:col-start-1 min-[85rem]:row-start-2")}>
            <EndedPlans easy={easy} pc={pc} />
          </div>
          <div className={cn("min-w-0", proposalsFirst && "lg:col-start-1 lg:row-start-1")}>
            <Proposals easy={easy} />
          </div>
        </div>
      </div>
    </>
  );
}
