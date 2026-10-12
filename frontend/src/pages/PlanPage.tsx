// /plans/:id 모의 자동매매 상세 (docs/plans/컨셉변경계획.md 4-2). 진행 중이면 5초마다 다시 받는다 (queries.usePlan).
// 쉬운 보기: 단계 넷(주문 → 사는 가격 기다리는 중 → 목표·손절 지켜보는 중 → 팔았어요) · 일어난 일을 쉬운 문장으로(kind + details) ·
//   숫자 · "멈추기"(대화상자 "지금 가지고 있는 ○주를 모두 팔고 끝낼까요? …").
// 전문가 보기: 머리(상태·via·활성화 시각) → 자동매매 워크플로우 그래프 → 사건 타임라인(서버 message) → 핵심 숫자 → 연결된 모의 주문 → 계획 중단.
// 배치: PC는 왼쪽 본문(머리·단계·기록) + 오른쪽 고정 열(숫자·이동·멈추기 — 보유 중이면 노트북 화면보다 길 수 있어, 길면 아래 끝(멈추기)이
//   보이게 붙는다: stickyFit). 모바일은 머리 → 단계(+가격 사다리) → 숫자 → 일어난 일 → 이동·멈추기
//   ('어디쯤·얼마'를 기록보다 먼저, 위험 동작은 맨 끝에 구분선으로 떼어 — trade-24). 열 래퍼는 모바일에서 contents라 카드 순서(order)만 바뀐다.
// 산 뒤에는 가격 사다리의 기준점이 산 가격이고 손절·목표 %도 산 가격 기준이다 (UX-3). 사는 가격을 기다리는 기한은 사기 전에만 보이고
//   토·일이면 앞 금요일 장 마감으로, 보유 기한은 "11월 5일(목)까지 (최대 20거래일)"처럼 날짜와 거래일을 함께 (UX-11).
//   보유 중 평가는 수수료·세금 빼기 전이라고 밝힌다 (UX-10).
// 숫자 카드에 "넣은 돈"이 있다 (TradePlan.budgetMode — 2026-10-11부터: 내 자금의 %와 그때 바꾼 금액, 또는 금액. 그 전 계획은 "예산"만).
// 시연용 수동 시작 계획(TradePlan.manualStart, DECISIONS 31장)은 출처 배지 옆 "시연용 수동 시작" 배지와 머리 카드 안 경고 한 줄 (쉬운·전문가 둘 다).
// PC (2026-10-12 PC 재설계): 머리 카드는 화면 제목 아래 부제 줄로 합친다 (이름은 제목 h1에만 — 카드 안의 큰 이름은 PC에서 숨긴다).
//   왼쪽 열에 가격 차트(종목 일봉 + 사는 가격/산 가격·목표·손절·판 가격 선, PC에서만 그린다 — useIsPc), 오른쪽 숫자 칸은 22px로 크게.
//   사용자 화면의 원시 번호(계획 #·주문 #·추천 #·사건 #)는 빼고 무엇으로 가는지로 이름을 붙인다.
//   머리 줄은 두 열 위에 걸친다(상태 칩은 코드·시장 바로 옆). 핵심 숫자 칸은 상태마다 뜻이 있는 것만 — 사기 전: 수량·넣은 돈·진입가·진입가까지,
//   산 뒤: 수량·체결가·현재 손익·목표까지, 판 뒤: 수량·체결가·실현 손익·청산가 ('-' 칸을 그리지 않는다).
//   끝난 계획의 오른쪽 열: 기본 버튼은 다음 순환(새 계획 제안 보기 / 새 AI 추천 고르기), 보조 링크는 출처(이 계획을 만든 제안 다시 보기 / 원래 AI 추천 보기).
import { type ReactNode, type RefObject, Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigationType, useParams } from "react-router";
import { useCancelPlan, useExitWatch, useOrderExpireDate } from "../api/autotrade";
import { ApiError, errorMessage } from "../api/client";
import { isPlanLive, useMarket, usePlan, useQuotes, useStock } from "../api/queries";
import type { MarketSession, PlanEvent, TradePlanDetail } from "../api/types";
import type { ChartLine } from "../components/charts/CandleChart";
import { ManualStartBadge, PlanStatusChip, SourceBadge } from "../components/autotrade/Badges";
import { EasySteps, OutcomeNote, Pnl, PlanTimeline, WorkflowGraph } from "../components/autotrade/PlanWorkflow";
import { PriceLadder } from "../components/autotrade/PriceLadder";
import { Icon } from "../components/Icon";
import { Sheet } from "../components/motion/Sheet";
import { useToast } from "../components/toast";
import { AsOf, Card, ErrorState, Flash, LiveDot, Notice, PageHeader, Row, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useIsPc } from "../hooks/useIsPc";
import { useChanged, useRevealAfterLoading } from "../hooks/useMotionState";
import {
  STICKY_FIT_TOP,
  closedMarketNotice,
  easySteps,
  entryDeadlineLabel,
  exitReasonLabel,
  ladderDistances,
  planStatusOf,
  planWorkflow,
  stickyFit,
} from "../lib/autotrade";
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
import { holdingValue } from "../lib/holding";
import { MANUAL_START_TEXT, PLAN_STATUS_TEXT, planEventSentence, planExitText, quotePriceName } from "../lib/plainText";

// 차트 라이브러리는 PC 계획 화면에서만 쓰므로 따로 불러온다 (종목 상세와 같은 방식)
const CandleChart = lazy(() => import("../components/charts/CandleChart").then((m) => ({ default: m.CandleChart })));

/** 차트 높이 (PC 왼쪽 열의 보조 차트 — 종목 상세의 큰 차트보다 낮게). */
const PLAN_CHART_H = "h-[300px] xl:h-[340px] 2xl:h-[380px]";

/**
 * 차트 위 가격 선: 사기 전 = 사는 가격·목표·손절, 산 뒤 = 산 가격·목표·손절, 판 뒤 = 산 가격·판 가격 (+ 판 가격과 겹치지 않는 목표·손절).
 * 판 가격 선은 산 가격보다 높으면 목표 색, 낮으면 손절 색. 사는 가격까지 가지 못하고 끝난 계획은 사기 전과 같다.
 */
function planChartLines(p: TradePlanDetail, easy: boolean): ChartLine[] {
  const name = easy
    ? { entry: "사는 가격", fill: "산 가격", target: "목표 가격", stop: "손절 가격", exit: "판 가격" }
    : { entry: "진입가", fill: "체결가", target: "목표가", stop: "손절가", exit: "청산가" };
  const lines: ChartLine[] = [];
  if (p.fillPrice != null) lines.push({ price: p.fillPrice, title: name.fill, tone: "entry" });
  else lines.push({ price: p.entryPrice, title: name.entry, tone: "entry" });
  const exit = p.exitPrice;
  const apart = (x: number) => exit == null || Math.abs(x - exit) / exit > 0.003;
  if (apart(p.targetPrice)) lines.push({ price: p.targetPrice, title: name.target, tone: "target" });
  if (apart(p.stopPrice)) lines.push({ price: p.stopPrice, title: name.stop, tone: "stop" });
  if (exit != null) lines.push({ price: exit, title: name.exit, tone: exit >= (p.fillPrice ?? p.entryPrice) ? "target" : "stop" });
  return lines;
}

/** PC 왼쪽 열의 가격 차트 (종목 일봉 + 계획의 가격 선). 선 이름표·차트 이름(role=img)은 CandleChart가 붙인다. */
function PlanChart({ p, easy }: { p: TradePlanDetail; easy: boolean }) {
  const { data: stock, isPending, isError } = useStock(p.symbol);
  const lines = planChartLines(p, easy);
  const skeleton = <Skeleton className={cn("mt-3 w-full rounded-xl", PLAN_CHART_H)} />;
  return (
    <Card aria-labelledby="plan-chart-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 id="plan-chart-title" className="text-[17px] font-bold">
          {easy ? "가격 흐름과 내 계획" : "가격 차트"}
        </h2>
        <Link to={`/stocks/${encodeURIComponent(p.symbol)}`} className="flex h-8 items-center gap-0.5 text-[13px] font-semibold text-brand-ink">
          {easy ? "종목 화면 보기" : "종목 상세"}
          <Icon name="chevron" className="size-3.5" />
        </Link>
      </div>
      {isPending ? (
        skeleton
      ) : isError || !stock || stock.candles.length === 0 ? (
        <p className="mt-3 rounded-xl bg-fill px-4 py-6 text-center text-[14px] text-mute">
          {easy ? "가격 기록을 불러오지 못했어요. 잠시 뒤에 다시 열어 주세요." : "일봉을 불러오지 못했습니다."}
        </p>
      ) : (
        <Suspense fallback={skeleton}>
          <CandleChart candles={stock.candles} currency={p.currency} variant={easy ? "line" : "candle"} lines={lines} className={PLAN_CHART_H} />
        </Suspense>
      )}
    </Card>
  );
}

/**
 * 멈추기(계획 중단) 확인 시트. 문구·버튼은 연 순간의 상태로 고정한다 — 열린 채 5초 폴링으로 상태가 바뀌어도
 * '주문 취소'로 읽은 대화상자에서 '모두 팔기'(전량 매도)가 나가지 않게 (trade-02).
 * - 열린 동안 체결되어 보유로 바뀌면: 위에 주의 안내를 띄우고 문구를 새 상태로 바꾼 뒤, 확인 버튼을 0.8초 막는다 (손가락 밑에서 바로 눌리지 않게).
 * - 열린 동안 계획이 끝나면(목표 청산·기한 만료 등): 닫고 결과 한 줄을 토스트로 알린다.
 * 처음 포커스는 안전한 '닫기'. 닫히면 연 버튼으로 돌아간다 (Sheet·useModal).
 */
function StopSheet({
  plan,
  easy,
  open,
  onClose,
  onStopped,
  returnFocus,
}: {
  plan: TradePlanDetail;
  easy: boolean;
  open: boolean;
  onClose: () => void;
  /** 멈추기가 끝난 뒤 (멈추기 버튼이 사라지므로 포커스를 줄 곳을 화면이 정한다) */
  onStopped: () => void;
  returnFocus: RefObject<HTMLButtonElement | null>;
}) {
  const toast = useToast();
  const cancel = useCancelPlan(plan.id);
  const closeRef = useRef<HTMLButtonElement>(null);
  // 이 시트에서 멈추기를 눌렀는지. 그 결과로 끝난 계획에는 '이미 끝난 계획' 안내를 하지 않는다 (effect에서만 읽고 쓴다)
  const mine = useRef(false);
  const live = isPlanLive(plan.status);

  const [opened, setOpened] = useState(open);
  const [snap, setSnap] = useState({ status: plan.status, quantity: plan.quantity });
  const [boughtNow, setBoughtNow] = useState<number | null>(null); // 열린 동안 체결된 수량 (주의 안내)
  const [locked, setLocked] = useState(false);
  // 이번 렌더에서 비교할 고정값. 여는 렌더에서는 지금 상태다 — 지난번(또는 화면을 연 때)의 값과 비교하면
  // 닫혀 있던 사이 체결된 계획을 처음 열 때도 '방금 샀어요'와 잠금이 잘못 뜬다
  let base = snap;
  if (open !== opened) {
    setOpened(open);
    if (open) {
      base = { status: plan.status, quantity: plan.quantity };
      setSnap(base);
      setBoughtNow(null);
      setLocked(false);
    }
  }
  if (open && live && plan.status !== base.status) {
    setSnap({ status: plan.status, quantity: plan.quantity });
    if (plan.status === "holding") {
      setBoughtNow(plan.quantity);
      setLocked(true);
    }
  }

  // 열 때마다 새로: 지난번에 실패한 안내가 다시 연 시트에 남지 않게 한다
  const resetCancel = cancel.reset;
  useEffect(() => {
    if (!open) return;
    mine.current = false;
    resetCancel();
  }, [open, resetCancel]);

  useEffect(() => {
    if (!locked) return;
    const t = window.setTimeout(() => setLocked(false), 800);
    return () => window.clearTimeout(t);
  }, [locked]);

  // 내가 누른 멈추기로 끝났으면 알리지 않는다. 멈추기가 실패했으면(그사이 끝나 '이미 끝난 계획' 등) 내가 끝낸 것이 아니므로 닫고 결과를 알린다
  const failed = cancel.isError;
  useEffect(() => {
    if (!open || live || (mine.current && !failed)) return;
    onClose();
    const result = plan.status === "closed" && plan.exitReason ? planExitText(plan.exitReason, easy) : easy ? PLAN_STATUS_TEXT[plan.status]?.line : planStatusOf(plan.status).label;
    toast(easy ? `이미 끝난 계획이에요 · ${result}` : `이미 끝난 계획입니다 · ${result}`);
  }, [open, live, failed, plan.status, plan.exitReason, easy, onClose, toast]);

  const holding = snap.status === "holding";
  const qty = formatQty(snap.quantity);
  const text = easy
    ? holding
      ? `지금 가지고 있는 ${qty}를 모두 팔고 끝낼까요? 장이 닫혀 있으면 다음 장 시작(${plan.market === "KR" ? "오전 9시" : "한국 시각 밤"})에 팔아요.`
      : "사는 주문을 취소하고 끝낼까요? 아직 산 주식이 없어서 돈은 그대로예요. 다시 하려면 새 계획 제안에서 새로 시작해요."
    : holding
      ? `보유 수량을 전량 매도합니다 (${qty}). 정규장 밖이면 다음 정규장 시작에 매도를 예약하고, 매도가 끝나면 계획이 청산 완료로 바뀝니다.`
      : "체결 대기 중인 진입 주문을 취소하고 계획을 끝냅니다. 다시 켜려면 추천에서 새로 활성화해야 합니다.";

  return (
    <Sheet open={open} onClose={onClose} labelledBy="cancel-title" initialFocus={closeRef} returnFocus={returnFocus}>
      <h2 id="cancel-title" className="text-[18px] font-bold">
        {easy ? `${plan.name} 모의 자동매매를 멈출까요?` : `${plan.name} 계획을 중단할까요?`}
      </h2>
      {boughtNow !== null && (
        <Notice tone="warn" className="mt-3">
          {easy
            ? `방금 모의 계좌에서 ${formatQty(boughtNow)}를 샀어요. 이제 멈추면 ${formatQty(boughtNow)}를 모두 팔아요.`
            : `방금 체결됨 — 이제 중단하면 ${formatQty(boughtNow)} 전량 매도`}
        </Notice>
      )}
      <p className="mt-2 text-[15px] leading-relaxed text-sub">{text}</p>
      {cancel.isError && (
        <Notice tone="error" className="mt-3">
          {errorMessage(cancel.error)}
        </Notice>
      )}
      <div className="mt-5 grid grid-cols-2 gap-2">
        <button ref={closeRef} type="button" onClick={onClose} className="press h-12 rounded-xl bg-fill text-[16px] font-semibold text-sub hover:bg-line">
          닫기
        </button>
        <button
          type="button"
          disabled={cancel.isPending || locked}
          onClick={() => {
            mine.current = true;
            cancel.mutate(undefined, {
              onSuccess: (p) => {
                const last = p.events.at(-1);
                if (easy) toast(last ? planEventSentence(last, p.currency) : "모의 자동매매를 멈췄어요.", "success");
                else toast(last?.message ?? "계획을 중단했습니다.", "success");
                onClose();
                onStopped();
              },
            });
          }}
          className="press flex h-12 items-center justify-center gap-1.5 rounded-xl bg-up text-[16px] font-semibold text-white hover:bg-up-dark disabled:opacity-40"
        >
          {cancel.isPending && <Spinner />}
          {easy ? (holding ? "모두 팔고 멈추기" : "멈추기") : holding ? "전량 매도하고 중단" : "중단하기"}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * 시세의 현재가 (진행 중일 때만 받는다 — 사기 전에는 '사는 가격까지', 보유 중에는 평가와 '목표·손절까지'에 쓴다).
 * 시세는 실시간(basis "live")이고, 현재가를 받지 못한 종목만 직전 장마감 종가("close")다. 화면은 basis로 이름과 기준 표기를 고른다.
 */
function useLastPrice(p: TradePlanDetail) {
  const live = isPlanLive(p.status);
  const { data: quotes } = useQuotes(live ? [p.symbol] : []);
  const quote = live ? quotes?.get(p.symbol) : undefined;
  return { last: quote?.price ?? null, asOf: quote?.asOf ?? null, basis: quote?.basis };
}

/** 보유 중이면 현재가(못 받으면 직전 종가)로 평가한 손익 (종목 통화, 비용 전). */
function useHoldingValue(p: TradePlanDetail) {
  const holding = p.status === "holding";
  const { last: price, asOf, basis } = useLastPrice(p);
  const last = holding ? price : null;
  const value = holdingValue({ price: last, avgPrice: p.fillPrice, quantity: p.quantity }); // 종목 화면의 보유 평가와 같은 식 (lib/holding)
  return { holding, last, asOf: holding ? asOf : null, basis, unrealized: value?.profit ?? null, rate: value?.rate ?? null };
}

/**
 * 넣은 돈 한 줄의 값 (2026-10-11 — 사용자가 정한 금액). 쉬운 보기 "내 자금의 25% (1,234,000원)", 전문가 보기 "매수 가능 금액의 25% · 1,234,000원",
 * 금액으로 정했으면 "1,234,000원". 그 전에 활성화한 계획(budgetMode 없음)은 null — 리스크 엔진이 수량을 정했으므로 보이지 않는다.
 */
function budgetText(p: TradePlanDetail, easy: boolean): string | null {
  const won = p.budgetKrw != null ? formatKrw(p.budgetKrw) : null;
  if (p.budgetMode === "percent" && p.budgetPercent != null) {
    const base = easy ? `내 자금의 ${p.budgetPercent}%` : `매수 가능 금액의 ${p.budgetPercent}%`;
    if (won === null) return base;
    return easy ? `${base} (${won})` : `${base} · ${won}`;
  }
  if (p.budgetMode === "amount" || p.budgetMode === "percent") return won;
  return null;
}

/** 진행 중 계획의 가격 사다리 + 남은 거리 한 줄 ("얼마나 남았나" — trade-25). 실행 확인에서 본 그림을 다시 쓴다. */
function LadderNow({ p, easy }: { p: TradePlanDetail; easy: boolean }) {
  const { last, asOf, basis } = useLastPrice(p);
  const d = ladderDistances(p.status, p, last);
  const name = { entry: easy ? "사는 가격" : "진입가", target: easy ? "목표 가격" : "목표가", stop: easy ? "손절 가격" : "손절가" };
  const line =
    d.length === 0
      ? null
      : d[0].key === "entry" && d[0].rate >= 0
        ? easy
          ? `${basis === "live" ? "지금 가격이" : "직전 종가가"} 이미 사는 가격 이하예요. 장이 열리면 그 가격 이하에서 사요`
          : `${basis === "live" ? "현재가" : "직전 종가"}가 진입가 이하입니다 (장중 가격으로 체결 판단)`
        : d.map((x) => `${name[x.key]}까지 ${formatRate(x.rate, 1)}`).join(" · ");
  // 시세가 화면을 연 뒤에 왔을 때만 짧게 나타난다 (캐시로 바로 그린 화면은 움직이지 않는다)
  const lateLine = useChanged(line !== null);
  return (
    <div className="mt-5 border-t border-line pt-4">
      <PriceLadder
        stop={p.stopPrice}
        entry={p.entryPrice}
        target={p.targetPrice}
        fill={p.status === "holding" ? p.fillPrice : null}
        last={last}
        basis={basis}
        currency={p.currency}
        easy={easy}
      />
      {/* 시세는 따로 받아 늦게 온다: 거리 한 줄과 기준 시각의 자리를 미리 잡아 둔다 (늦게 끼어들어 아래 카드를 밀지 않게) */}
      <div className="min-h-10">
        {line && (
          <p className={cn("mt-2 text-[13px] leading-snug text-sub tabular-nums", lateLine && "reveal-fade")}>
            {line}{" "}
            {/* 기준 표시는 한 덩어리로 (좁은 화면에서 '기준'만 다음 줄로 떨어지지 않게) */}
            <span className="whitespace-nowrap text-mute">
              {basis === "live" ? (easy ? "· 지금 가격 기준" : "(현재가 기준)") : easy ? "· 직전 종가 기준" : "(직전 종가 기준)"}
            </span>
          </p>
        )}
        <AsOf at={asOf} market={p.market} basis={basis} className="mt-0.5 block text-right" />
      </div>
    </div>
  );
}

/** 사기 전인지 (사는 가격을 기다리는 기한이 아직 뜻이 있는 동안). */
const beforeFill = (p: TradePlanDetail) => p.status === "active" || p.status === "entry_pending";

/**
 * 보유 기간 줄: 보유 중이면 연결된 모의 주문의 보유 기한 날짜와 거래일을 함께 "11월 5일(목)까지 (최대 20거래일)" (내 주식의 보유 카드와 같은 날짜),
 * 사기 전이면 "산 뒤 최대 20거래일", 그 밖(끝남·날짜를 못 받음)이면 "최대 20거래일".
 */
function useHoldingSpan(p: TradePlanDetail): string {
  const holding = p.status === "holding";
  const { data: expire } = useOrderExpireDate(p.orderId, holding);
  if (holding && expire) return `${formatDayLabel(expire)}까지 (최대 ${p.holdingDays}거래일)`;
  return beforeFill(p) ? `산 뒤 최대 ${p.holdingDays}거래일` : `최대 ${p.holdingDays}거래일`;
}

/**
 * 숫자 칸 하나. 값은 줄을 바꾸지 않고(자릿수 중간에서 갈라지지 않게), 보조 줄은 넘치면 줄임표 + 전체는 title (trade-03).
 * PC는 22px로 크게 — 오른쪽 열 2칸(한 칸 약 130px)에서 넘치지 않게 11자 넘는 값(예: +1,234,567원)은 19px (text: 보이는 값).
 */
function Cell({
  label,
  children,
  text,
  sub,
  subClass,
  className,
}: {
  label: string;
  children: ReactNode;
  text?: string;
  sub?: string;
  subClass?: string;
  className?: string;
}) {
  const long = (text?.length ?? 0) > 10;
  return (
    <div className={cn("min-w-0 rounded-xl bg-fill p-3 lg:px-3.5", className)}>
      <dt className="text-[12px] text-mute lg:text-[13px]">{label}</dt>
      <dd className={cn("text-[17px] font-bold whitespace-nowrap tabular-nums lg:mt-0.5 lg:leading-tight", long ? "lg:text-[19px]" : "lg:text-[22px]")}>{children}</dd>
      {sub && (
        <dd className={cn("truncate text-[11px] tabular-nums", subClass ?? "text-mute")} title={sub}>
          {sub}
        </dd>
      )}
    </div>
  );
}

/** 숫자 칸 수 → 넓은 카드(@lg)의 열 수 (칸 수만큼 한 줄로 — 빈 칸을 남기지 않는다). */
const TILE_COLS = { 1: "@lg:grid-cols-1", 2: "@lg:grid-cols-2", 3: "@lg:grid-cols-3", 4: "@lg:grid-cols-4" } as const;

function Numbers({ p, className }: { p: TradePlanDetail; className?: string }) {
  const { holding, last, asOf, basis, unrealized, rate } = useHoldingValue(p);
  // 사기 전 '진입가까지'는 시세의 가격으로 (가격 사다리의 거리 한 줄과 같은 셈 — ladderDistances)
  const quote = useLastPrice(p);
  const span = useHoldingSpan(p);
  const budget = budgetText(p, false);
  // 산 뒤에는 목표·손절 %를 체결가 기준으로 (UX-3)
  const base = p.fillPrice ?? p.entryPrice;
  const before = beforeFill(p) || p.fillPrice == null;
  // 넣은 돈은 사기 전에만 큰 칸으로 (그때 가장 궁금한 숫자). 칸으로 보이면 아래 줄에서는 뺀다
  const budgetTile = before && p.budgetMode != null && p.budgetKrw != null;
  const [toEntry] = ladderDistances(p.status, p, quote.last);
  const [toTarget, toStop] = ladderDistances(p.status, p, last);
  const won = (v: number | null) => formatPrice(v, p.currency);
  // 상태마다 뜻이 있는 칸만 (값이 없는 '-' 칸을 그리지 않는다 — 막 시작한 계획의 오른쪽 열이 비어 보이지 않게).
  // 사기 전: 수량 · 넣은 돈 · 진입가 · 진입가까지 / 산 뒤: 수량 · 체결가 · 현재 손익 · 목표까지 / 판 뒤: 수량 · 체결가 · 실현 손익 · 청산가
  const tiles: { key: string; label: string; text?: string; sub?: string; subClass?: string; value: ReactNode }[] = [
    { key: "qty", label: "수량", value: formatQty(p.quantity) },
  ];
  if (before) {
    if (budgetTile) {
      tiles.push({
        key: "budget",
        label: "넣은 돈",
        text: formatKrw(p.budgetKrw),
        sub: p.budgetMode === "percent" && p.budgetPercent != null ? `매수 가능 금액의 ${p.budgetPercent}%` : undefined,
        value: formatKrw(p.budgetKrw),
      });
    }
    tiles.push({ key: "entry", label: "진입가", text: won(p.entryPrice), sub: "지정가", value: won(p.entryPrice) });
    if (toEntry) {
      const reached = toEntry.rate >= 0;
      tiles.push({
        key: "to-entry",
        label: "진입가까지",
        text: reached ? "도달" : formatRate(toEntry.rate, 1),
        sub: `${quotePriceName(quote.basis)} ${won(quote.last)}`,
        value: reached ? "도달" : formatRate(toEntry.rate, 1),
      });
    }
  } else {
    tiles.push({ key: "fill", label: "체결가", text: won(p.fillPrice), value: won(p.fillPrice) });
    if (holding) {
      tiles.push({
        key: "pnl",
        label: "현재 손익",
        text: formatSignedPrice(unrealized, p.currency),
        sub: `${formatRate(rate)} · ${quotePriceName(basis)} ${won(last)}`,
        subClass: trendClass(rate),
        value: (
          <span className={trendClass(unrealized)}>
            <Flash value={unrealized}>{formatSignedPrice(unrealized, p.currency)}</Flash>
          </span>
        ),
      });
      if (toTarget) {
        tiles.push({
          key: "to-target",
          label: "목표까지",
          text: formatRate(toTarget.rate, 1),
          sub: toStop ? `손절까지 ${formatRate(toStop.rate, 1)}` : undefined,
          value: formatRate(toTarget.rate, 1),
        });
      }
    } else {
      if (p.pnlKrw != null) {
        tiles.push({
          key: "pnl",
          label: "실현 손익",
          text: formatSignedKrw(p.pnlKrw),
          value: <span className={trendClass(p.pnlKrw)}>{formatSignedKrw(p.pnlKrw)}</span>,
        });
      }
      if (p.exitPrice != null) {
        tiles.push({ key: "exit", label: "청산가", text: won(p.exitPrice), sub: p.exitReason ? exitReasonLabel(p.exitReason) : undefined, value: won(p.exitPrice) });
      }
    }
  }
  const n = Math.min(tiles.length, 4) as keyof typeof TILE_COLS;
  return (
    // 칸 수는 화면이 아니라 카드 폭으로 정한다 (PC 오른쪽 열 360px에서는 2칸, 넓은 한 열에서는 칸 수만큼 한 줄)
    <Card aria-labelledby="numbers-title" className={cn("@container", className)}>
      <h2 id="numbers-title" className="mb-2 text-[17px] font-bold">
        핵심 숫자
      </h2>
      <dl className={cn("grid grid-cols-2 gap-2", TILE_COLS[n])}>
        {tiles.map((t, i) => (
          // 두 칸 줄에서 칸 수가 홀수면 마지막 칸이 줄을 채운다 (빈 자리 없이)
          <Cell
            key={t.key}
            label={t.label}
            text={t.text}
            sub={t.sub}
            subClass={t.subClass}
            className={tiles.length % 2 === 1 && i === tiles.length - 1 ? "col-span-2 @lg:col-span-1" : undefined}
          >
            {t.value}
          </Cell>
        ))}
      </dl>
      {holding && <AsOf at={asOf} market={p.market} basis={basis} className="mt-1 block text-right" />}
      <dl className="mt-3">
        {budget && !budgetTile && <Row label="넣은 돈">{budget}</Row>}
        {!before && <Row label="진입가 (지정가)">{formatPrice(p.entryPrice, p.currency)}</Row>}
        <Row label={p.fillPrice != null ? "목표가 (체결가 기준)" : "목표가"}>
          <span className="text-up">
            {formatPrice(p.targetPrice, p.currency)} ({formatRate(p.targetPrice / base - 1, 1)})
          </span>
        </Row>
        <Row label={p.fillPrice != null ? "손절가 (체결가 기준)" : "손절가"}>
          <span className="text-down">
            {formatPrice(p.stopPrice, p.currency)} ({formatRate(p.stopPrice / base - 1, 1)})
          </span>
        </Row>
        <Row label={p.status === "holding" ? "보유 기한" : "보유 기간"}>{span}</Row>
        {beforeFill(p) && <Row label="진입 기한">{formatDateTime(p.entryDeadline)}</Row>}
        {!p.budgetMode && p.budgetKrw != null && <Row label="예산">{formatKrw(p.budgetKrw)}</Row>}
        {p.filledAt && <Row label="체결 시각">{formatDateTime(p.filledAt)}</Row>}
        {p.closedAt && <Row label="청산 시각">{formatDateTime(p.closedAt)}</Row>}
      </dl>
    </Card>
  );
}

function EasyNumbers({ p, className }: { p: TradePlanDetail; className?: string }) {
  const { holding, last, asOf, basis, unrealized, rate } = useHoldingValue(p);
  const span = useHoldingSpan(p);
  const budget = budgetText(p, true);
  return (
    <Card aria-labelledby="numbers-title" className={className}>
      <h2 id="numbers-title" className="mb-2 text-[17px] font-bold">
        숫자로 보기
      </h2>
      {holding && (
        <div className="mb-2 rounded-xl bg-fill p-3">
          <p className="text-[12px] text-mute lg:text-[13px]">{basis === "live" ? "지금 가격으로 본 평가 (수수료·세금 빼기 전)" : "직전 종가로 본 평가 (수수료·세금 빼기 전)"}</p>
          {/* 시세로 바뀌는 금액이라 전문가 보기와 같은 Flash로 알린다 (trade-31) */}
          <p className={cn("text-[19px] font-bold tabular-nums lg:text-[24px] lg:leading-tight", trendClass(unrealized))}>
            <Flash value={unrealized}>{formatSignedPrice(unrealized, p.currency)}</Flash> <span className="text-[13px]">({formatRate(rate)})</span>
          </p>
          <p className="text-[12px] text-sub tabular-nums">
            {quotePriceName(basis, true)} {formatPrice(last, p.currency)}
          </p>
          <AsOf at={asOf} market={p.market} basis={basis} className="block" />
          {/* +1,200원이 멈추자 −917원이 된 이유를 미리 (UX-10) */}
          <p className="mt-1 text-[12px] leading-snug text-sub">팔 때 수수료와 세금이 빠져서 받는 돈은 조금 적어요.</p>
        </div>
      )}
      {p.status === "closed" && (
        <div className="mb-2 rounded-xl bg-fill p-3">
          <p className="text-[12px] text-mute lg:text-[13px]">손익 (수수료·세금 포함)</p>
          <p className={cn("text-[19px] font-bold tabular-nums lg:text-[24px] lg:leading-tight", trendClass(p.pnlKrw))}>{formatSignedKrw(p.pnlKrw)}</p>
          {p.exitReason && <p className="text-[13px] text-sub">{planExitText(p.exitReason, true)}</p>}
        </div>
      )}
      <dl>
        {budget && <Row label="넣은 돈">{budget}</Row>}
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
        <Row label={holding ? "보유 기한" : "보유 기간"}>{span}</Row>
        {beforeFill(p) && <Row label="사는 가격을 기다리는 기한">{entryDeadlineLabel(p.entryDeadline, p.market)}까지</Row>}
        {!p.budgetMode && p.budgetKrw != null && <Row label="예산">{formatKrw(p.budgetKrw)}</Row>}
      </dl>
    </Card>
  );
}

/** 쉬운 보기의 결과 상자 (끝난 계획). 끝까지 간 계획은 중립 + 체크이고 손익 숫자만 색을 입힌다 (trade-23). */
function EasyOutcome({ p }: { p: TradePlanDetail }) {
  if (p.status === "closed") {
    return (
      <OutcomeNote tone="done" className="mt-4">
        {p.exitReason ? planExitText(p.exitReason, true) : "모의 계좌에서 팔았어요"} · 손익 <Pnl value={p.pnlKrw} />
      </OutcomeNote>
    );
  }
  if (p.status === "cancelled" || p.status === "expired") {
    return (
      <OutcomeNote tone="neutral" className="mt-4">
        {PLAN_STATUS_TEXT[p.status].line}
      </OutcomeNote>
    );
  }
  if (p.status === "failed") {
    return (
      <OutcomeNote tone="error" className="mt-4">
        {PLAN_STATUS_TEXT.failed.line}
      </OutcomeNote>
    );
  }
  return null;
}

/** 진행 중 표시: 계속 도는 스피너 대신 차분한 점 + 알림 약속 한 줄 (자동 갱신 주기는 title로 — trade-09·10). */
function LiveLine({ easy }: { easy: boolean }) {
  return (
    <p className="mt-3 flex items-center gap-2 text-[13px] leading-snug text-mute" title={easy ? "5초마다 새로 받아요" : "5초마다 다시 받습니다"}>
      <LiveDot />
      {easy ? "자동으로 새로 받아요 · 단계가 바뀌면 알림으로 알려 드려요" : "자동 갱신 · 단계가 바뀌면 알림이 옵니다"}
    </p>
  );
}

/** 장 시작 이만큼 전부터는 장이 열린 것으로 본다 (기기 시계 차이·늦게 받은 시장 정보를 넘는다). */
const OPEN_MARGIN_MS = 5 * 60_000;

/** 지금 매도 요청(마지막 exit_requested 사건)에 대해 이 화면이 본 것. */
interface ExitSeen {
  step: number; // 그 사건 번호 (다시 멈추면 새 번호 — 처음부터 다시 본다)
  since: number; // 그 요청이 든 계획 응답을 처음 받은 시각. 이보다 늦게 받은 예약 응답만 믿는다
  absent: { count: number; last: number } | null; // '예약 없음'이 이어진 응답 수와 마지막 응답 시각
  cancelled: boolean; // 예약이 취소됐다고 확인했다 (예약이 다시 보이거나 보유가 끝날 때까지 유지 — 폴링마다 깜빡이지 않게)
}

/** 같은 입력이면 같은 객체를 돌려준다 (렌더 중 상태 갱신이 한 번에 멈추게). */
function nextExitSeen(
  prev: ExitSeen | null,
  step: number | null,
  planAt: number,
  resv: { at: number; has: boolean } | null,
  held: { at: number; held: boolean } | null,
  closedUntil: number | null,
): ExitSeen | null {
  if (step === null) return null;
  let s: ExitSeen = prev?.step === step ? prev : { step, since: planAt, absent: null, cancelled: false };
  // 다른 화면이 남긴 캐시·멈추기 전에 나간 응답은 '예약 없음'의 증거가 아니다
  if (resv && resv.at > s.since) {
    if (resv.has) {
      if (s.absent || s.cancelled) s = { ...s, absent: null, cancelled: false };
    } else if (s.absent?.last !== resv.at) {
      s = { ...s, absent: { count: (s.absent?.count ?? 0) + 1, last: resv.at } };
    }
  }
  if (s.cancelled && held?.held === false) return { ...s, cancelled: false }; // 그사이 팔렸다 (곧 청산 완료로 바뀐다)
  // 예약 응답 뒤에 받은 계획·주문이 아직 보유 중이어야 한다 (장 시작에 예약이 실행됐으면 주문이 보유 목록에서 빠진다)
  if (!s.cancelled && s.absent && held?.held === true && planAt > s.absent.last && held.at > s.absent.last) {
    // 장이 닫혀 있던 때의 응답이면 한 번으로 족하다. 열려 있었을 수 있으면 엔진이 실행하는 동안(확인 가격을 받는 동안) 잠깐 없을 수 있어
    // 다음 응답에서도 없어야 한다 (일시 오류면 예약이 같은 번호로 되살아난다 — backend/trading/service.py run_reservations)
    const closed = closedUntil !== null && s.absent.last < closedUntil - OPEN_MARGIN_MS;
    if (closed || s.absent.count >= 2) s = { ...s, cancelled: true };
  }
  return s;
}

/**
 * 보유 중 계획의 매도 요청 상태: 'pending'(매도 요청됨 — 장 시작에 판다) 또는 'cancelled'(내 주식에서 예약을 지워 보유 감시를 계속한다 — 다시 멈출 수 있다).
 * '예약 없음' 응답 하나로 취소라고 말하지 않는다 (trade-r1): 예약은 내가 지울 때 말고도, 장이 열려 엔진이 실행할 때(예약을 먼저 지우고 판 뒤
 * 같은 바퀴의 뒤 단계에서야 계획이 청산 완료가 된다) 없어진다. 두 조회는 따로 5초마다 받으므로 예약 응답이 계획 응답보다 먼저 올 수 있다.
 * 확인이 필요하면 계획·주문을 바로 다시 받는다. 확인 전까지는 '매도 요청됨'을 유지한다 (멈추기 버튼도 막아 둔 채).
 */
function useExitStatus(p: TradePlanDetail | undefined, planAt: number, refetchPlan: () => unknown, session: MarketSession | undefined) {
  const step = p?.status === "holding" ? lastExitStep(p.events) : null;
  const watch = useExitWatch(p?.orderId ?? null, step !== null);
  const { reservation, held } = watch;
  const resv = reservation.data === undefined ? null : { at: reservation.dataUpdatedAt, has: reservation.data };
  const hold = held.data === undefined ? null : { at: held.dataUpdatedAt, held: held.data };
  const closedUntil = session && !session.isOpen && session.opensAt ? Date.parse(session.opensAt) : null;
  const [seen, setSeen] = useState<ExitSeen | null>(null);
  const next = nextExitSeen(seen, step, planAt, resv, hold, closedUntil);
  if (next !== seen) setSeen(next);
  // 예약이 없다는 응답 뒤의 계획·주문이 아직 없으면 바로 다시 받는다 (다음 폴링까지 '매도 요청됨'에 머물지 않게)
  const checkAt = next && !next.cancelled && next.absent && !(planAt > next.absent.last && (hold?.at ?? 0) > next.absent.last) ? next.absent.last : null;
  const refetchHeld = held.refetch;
  useEffect(() => {
    if (checkAt === null) return;
    void refetchPlan();
    void refetchHeld();
  }, [checkAt, refetchPlan, refetchHeld]);
  const cancelled = next?.cancelled ?? false;
  return { pending: step !== null && !cancelled, cancelled };
}

/** 마지막 매도 요청 사건의 번호 (없으면 null). */
function lastExitStep(events: PlanEvent[]): number | null {
  for (let i = events.length - 1; i >= 0; i--) if (events[i].kind === "exit_requested") return events[i].step;
  return null;
}

export function PlanPage() {
  const { id } = useParams();
  const { easy } = useViewMode();
  const location = useLocation();
  const navType = useNavigationType();
  // 실행 확인에서 막 시작해 온 화면이면 끝난 단계의 체크가 한 번 튄다 (배너 없이 시작된 순간을 보인다 — trade-10).
  // state는 기록에 남으므로 뒤로·앞으로 가기와 새로 고침(POP)에서는 다시 튀지 않게 한다
  const [celebrate] = useState(() => navType !== "POP" && (location.state as { started?: unknown } | null)?.started === true);
  const { data: p, isPending, isError, error, refetch, isFetching, dataUpdatedAt: planAt } = usePlan(Number(id));
  const reveal = useRevealAfterLoading(isPending);
  const { data: market } = useMarket();
  const pc = useIsPc();
  const [confirming, setConfirming] = useState(false);
  const stopRef = useRef<HTMLButtonElement>(null);
  const stepsTitle = useRef<HTMLHeadingElement>(null);
  const session = p ? market?.markets.find((m) => m.market === p.market) : undefined;
  // 매도 요청 중인지는 사건 이력만이 아니라 지금 매도 예약이 있는지로 본다 (trade-v06). 예약이 사라졌으면 취소인지 실행인지 확인한 뒤에만 바꾼다 (trade-r1)
  const exit = useExitStatus(p, planAt, refetch, session);

  if (isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-40" />} docTitle={easy ? "모의 자동매매" : "자동매매 계획"} back />
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
            retrying={isFetching}
          />
        </Card>
      </>
    );
  }

  const live = isPlanLive(p.status);
  // 매도 예약이 취소된 것을 확인하기 전에는(받는 중·확인 중 포함) 멈추기를 막아 둔다 (두 번 누르지 않게)
  const exitPending = exit.pending;
  const exitCanceled = exit.cancelled;
  // 예약을 취소해 다시 보유 감시 중이면 단계도 '파는 중'에서 되돌린다
  const events = exitCanceled ? p.events.filter((e) => e.kind !== "exit_requested") : p.events;
  const waitingNotice = p.status === "active" || p.status === "entry_pending" ? closedMarketNotice(session, p.market) : null;
  const orderLink = p.status === "entry_pending" ? "/portfolio?tab=orders" : p.status === "holding" ? "/portfolio" : "/portfolio?tab=fills";
  const linkCls = "press flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line";
  const onStopped = () => {
    // 멈추기 버튼이 사라지므로 결과가 보이는 단계 카드 제목으로 포커스를 옮긴다 (갈 곳을 잃지 않게)
    const move = () => {
      if (!document.activeElement || document.activeElement === document.body) stepsTitle.current?.focus({ preventScroll: true });
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(move);
    else move();
  };

  const stopArea = live && (
    <div className="mt-1 space-y-2 border-t border-line pt-3">
      {exitCanceled && (
        <Notice tone="warn">
          {easy
            ? "매도 예약이 취소돼 장 시작에 팔지 않아요. 목표·손절은 계속 지켜봐요."
            : "매도 예약이 취소되어 보유 감시를 계속합니다. 다시 중단할 수 있습니다."}
        </Notice>
      )}
      <p className="px-0.5 text-[13px] leading-snug text-sub">
        {exitPending
          ? easy
            ? "다음 장이 시작되면 모의 계좌에서 모두 팔아요."
            : "다음 정규장 시작에 전량 매도가 예약되어 있습니다."
          : p.status === "holding"
            ? easy
              ? `멈추면 가진 ${formatQty(p.quantity)}를 모두 팔고 끝내요.`
              : `중단하면 보유 ${formatQty(p.quantity)}를 전량 매도합니다.`
            : easy
              ? "멈추면 사는 주문을 취소해요. 돈은 그대로예요."
              : "중단하면 진입 주문을 취소합니다."}
      </p>
      <button
        ref={stopRef}
        type="button"
        disabled={exitPending}
        onClick={() => setConfirming(true)}
        className="press flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-up-soft text-[16px] font-bold text-up-ink hover:bg-up-soft/70 disabled:opacity-50"
      >
        <Icon name="ban" className="size-4" />
        {exitPending ? (easy ? "팔도록 요청했어요 (기다리는 중)" : "매도 요청됨 (청산 대기)") : easy ? "멈추기" : "계획 중단"}
      </button>
    </div>
  );

  // 끝난 계획: 다음 순환(② 검토 → ③ 실행)으로 바로 잇는다 — 멈추기 문구가 약속한 길 (trade-v04)
  const next =
    !live && (
      <Link
        to="/recommendations"
        className="press flex h-12 items-center justify-center gap-1.5 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark"
      >
        <Icon name="sparkle" className="size-4" />
        {easy ? "새 계획 제안 보기" : "새 AI 추천 고르기"}
      </Link>
    );

  const links = (
    <Card className="order-5 space-y-2 lg:order-none">
      {next}
      <Link to={orderLink} className={linkCls}>
        연결된 모의 주문 보기
        <Icon name="chevron" className="size-4" />
      </Link>
      <Link to={`/recommendations/${p.recommendationId}`} className={linkCls}>
        {/* 위 기본 버튼(다음 순환 — 제안 목록)과 헷갈리지 않게 '이 계획이 나온 곳'이라고 이름 붙인다 */}
        {easy ? "이 계획을 만든 제안 다시 보기" : "원래 AI 추천 보기"}
        <Icon name="chevron" className="size-4" />
      </Link>
      {stopArea}
    </Card>
  );

  const sheet = (
    <StopSheet plan={p} easy={easy} open={confirming} onClose={() => setConfirming(false)} onStopped={onStopped} returnFocus={stopRef} />
  );
  // 머리 카드: PC는 카드 바탕 없이 화면 제목 바로 아래 부제 줄 (제목과 한 덩어리로 읽히게)
  // 두 열 위에 걸쳐 (머리 아래에서 왼쪽 본문과 오른쪽 열이 같은 높이에서 시작한다)
  const HEAD_PC = "lg:col-span-2 lg:-mt-2 lg:bg-transparent lg:px-1 lg:pt-0 lg:pb-0";
  // 두 열 래퍼는 모바일에서 contents(카드만 남아 order로 섞인다), PC에서 블록(왼쪽 본문 · 오른쪽 고정 열)
  const grid = cn("grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-x-6 lg:gap-y-4", reveal && "reveal-fade");

  if (easy) {
    return (
      <>
        <PageHeader title={`${p.name} 모의 자동매매`} back />
        <div className={grid}>
          {/* 머리: PC는 두 열 위에 걸친 한 줄 (두 열이 같은 높이에서 시작하고, 상태 칩은 코드·시장 바로 옆에 붙는다) */}
          <Card className={cn("order-1 lg:order-none", HEAD_PC)}>
            <div className="flex items-start justify-between gap-3 lg:items-center lg:justify-start">
              <div className="min-w-0">
                <p className="text-[14px] text-mute">
                  {p.symbol} · {p.market === "KR" ? "국내" : "미국"} · 모의 계좌
                </p>
                {/* PC는 화면 제목(h1)이 이름을 말한다 */}
                <p className="mt-0.5 text-[22px] font-bold tracking-tight lg:hidden">{p.name}</p>
              </div>
              <PlanStatusChip status={p.status} easy className="h-7 px-2 text-[13px]" />
            </div>
            {/* 상태가 바뀌면(체결·청산) 화면 읽기 프로그램이 이 줄을 읽는다 (role 없이 — 토스트의 status와 겹치지 않게) */}
            <p aria-live="polite" className="mt-2 text-[15px] leading-relaxed">
              {PLAN_STATUS_TEXT[p.status]?.line ?? p.status}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-sub">
              <SourceBadge source={p.source} />
              {p.manualStart && <ManualStartBadge />}
              <span>
                {p.via === "discord" ? "Discord 링크로 시작" : "웹에서 시작"} · {formatDateTime(p.activatedAt)}
              </span>
            </div>
            {p.manualStart && (
              <Notice tone="warn" className="mt-3">
                {MANUAL_START_TEXT.planNote.easy}
              </Notice>
            )}
            {waitingNotice && <Notice className="mt-3">{waitingNotice}</Notice>}
            {live && <LiveLine easy />}
          </Card>

          <div className="contents lg:block lg:min-w-0 lg:space-y-3">
            <Card aria-labelledby="steps-title" className="order-2 lg:order-none">
              <h2 id="steps-title" ref={stepsTitle} tabIndex={-1} className="mb-4 text-[17px] font-bold outline-none">
                지금 어디쯤인가요
              </h2>
              <EasySteps steps={easySteps(p, events)} celebrate={celebrate} />
              {live && <LadderNow p={p} easy />}
              <EasyOutcome p={p} />
              {p.failureReason && (p.status === "failed" || p.status === "expired") && (
                <details className="mt-2 text-[13px] text-mute">
                  <summary className="cursor-pointer">자세한 사유</summary>
                  <p className="mt-1">{p.failureReason}</p>
                </details>
              )}
            </Card>

            {pc && <PlanChart p={p} easy />}

            <Card aria-labelledby="events-title" className="order-4 lg:order-none">
              <h2 id="events-title" className="mb-3 text-[17px] font-bold">
                일어난 일
              </h2>
              <PlanTimeline events={p.events} easy currency={p.currency} />
            </Card>
          </div>

          <div ref={stickyFit} className="contents lg:sticky lg:block lg:space-y-3" style={{ top: STICKY_FIT_TOP }}>
            <EasyNumbers p={p} className="order-3 lg:order-none" />
            {links}
          </div>
        </div>
        {sheet}
      </>
    );
  }

  const wf = planWorkflow(p, events);
  return (
    <>
      <PageHeader title={`${p.name} 자동매매`} back />
      <div className={grid}>
        {/* 머리: PC는 두 열 위에 걸친 한 줄 (두 열이 같은 높이에서 시작하고, 상태 칩은 코드·시장 바로 옆에 붙는다) */}
        <Card className={cn("order-1 lg:order-none", HEAD_PC)}>
          <div className="flex items-start justify-between gap-3 lg:items-center lg:justify-start">
            <div className="min-w-0">
              <p className="text-[14px] text-mute">
                {p.symbol} · {p.market === "KR" ? "국내" : "미국"} · 모의 계좌
              </p>
              {/* PC는 화면 제목(h1)이 이름을 말한다 */}
              <p className="mt-0.5 text-[22px] font-bold tracking-tight lg:hidden">{p.name}</p>
            </div>
            <span aria-live="polite" className="shrink-0">
              <PlanStatusChip status={p.status} className="h-7 px-2 text-[13px]" />
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[13px] text-sub">
            <SourceBadge source={p.source} />
            {p.manualStart && <ManualStartBadge />}
            <span className="inline-flex h-6 items-center gap-1 rounded-md bg-fill px-1.5 font-semibold">
              <Icon name={p.via === "discord" ? "bell" : "home"} className="size-3.5" />
              {p.via === "discord" ? "Discord 링크로 활성화" : "웹에서 활성화"}
            </span>
            <span>{formatDateTime(p.activatedAt)}</span>
          </div>
          {p.manualStart && (
            <Notice tone="warn" className="mt-3">
              {MANUAL_START_TEXT.planNote.expert}
            </Notice>
          )}
          {waitingNotice && <Notice className="mt-3">{waitingNotice}</Notice>}
          {live && <LiveLine easy={false} />}
        </Card>

        <div className="contents lg:block lg:min-w-0 lg:space-y-3">
          <Card aria-labelledby="wf-title" className="order-2 lg:order-none">
            <h2 id="wf-title" ref={stepsTitle} tabIndex={-1} className="mb-4 text-[17px] font-bold outline-none">
              자동매매 워크플로우
            </h2>
            <WorkflowGraph wf={wf} celebrate={celebrate} />
            {live && <LadderNow p={p} easy={false} />}
          </Card>

          {pc && <PlanChart p={p} easy={false} />}

          <Card aria-labelledby="events-title" className="order-4 lg:order-none">
            <h2 id="events-title" className="mb-3 text-[17px] font-bold">
              사건 타임라인
            </h2>
            <PlanTimeline events={p.events} />
          </Card>
        </div>

        <div ref={stickyFit} className="contents lg:sticky lg:block lg:space-y-3" style={{ top: STICKY_FIT_TOP }}>
          <Numbers p={p} className="order-3 lg:order-none" />
          {links}
        </div>
      </div>
      {sheet}
    </>
  );
}
