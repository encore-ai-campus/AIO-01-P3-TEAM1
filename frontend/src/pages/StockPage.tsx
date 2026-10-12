// /stocks/:symbol 종목 상세 (docs/plans/컨셉변경계획.md 4-2, docs/DECISIONS.md 13-1 D-1, docs/plans/투자서비스확장계획.md 2-3).
// 모바일 한 열(= DOM·읽는 순서): 시세(+ 내 모의 주문 한 줄)·차트 → 큰 버튼 "AI 리포트 만들기"(여정 ① 만들기) + 보조 "AI 교차검증 분석"
//   → 펀더멘털 → 주문.
// PC 2단: 왼쪽은 '보기'(시세·차트·펀더멘털), 오른쪽 sticky는 '하기' — 전문가 보기는 주문 패널, 쉬운 보기는 AI 리포트 묶음(그 사람의 주 행동).
//   쉬운 보기의 직접 주문(고급)은 왼쪽 맨 아래 (펼치면 길어지므로 sticky 열에 두지 않는다). 같은 요소를 두 번 그리지 않고 grid 자리만 바꾼다.
// 시세는 실시간(5초마다 새로 받음, Quote.basis "live" → "실시간 · 15:20:31"), 현재가를 받지 못한 종목만 직전 종가("장마감 기준").
// 내 보유 평가('내 모의 주문' 한 줄·주문 패널의 보유 블록)도 이 시세와 체결가·수량으로 종목 통화로 계산한다 (lib/holding — 오늘 산 종목도 실시간 숫자).
//   시세 가격을 받지 못하면 장마감 기준 계좌 값 (홈·마이·랭킹은 늘 장마감 기준).
// 차트: 쉬운 보기는 종가 선(낮게 — 360×740에서 큰 버튼이 첫 화면에 들어오게), 전문가 보기는 캔들·이동평균·거래량.
// 전문가 보기 모바일은 하단 고정 버튼 → 주문 바텀시트 (.order-dock: PC 패널과 한 벌 DOM, 열린 동안만 모달 — hooks/useModal).
import { Suspense, lazy, type MouseEvent, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useAnalyses, useAnalysis, useMe, useReportPlan, useReports, useStock } from "../api/queries";
import { useReportQuota, useRequestReport } from "../api/reports";
import { addRecentStock, useSymbolTrading } from "../api/trading";
import type { AnalysisSummary, ChaosRequest, StockDetail } from "../api/types";
import { AnalysisRequest } from "../components/analysis/AnalysisRequest";
import { isCountLimit } from "../components/errors/errorTypes";
import { Icon } from "../components/Icon";
import { FundamentalsPanel } from "../components/longterm/FundamentalsPanel";
import { Collapse } from "../components/motion/Collapse";
import { ACTED_MS, OrderPanel, type Prefill } from "../components/stock/OrderPanel";
import { ChaosForm } from "../components/reports/ChaosForm";
import { AsOf, EmptyState, ErrorState, Flash, Notice, PageHeader, PriceChange, Skeleton, Spinner, VerdictBadge } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useModal } from "../hooks/useModal";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { formatOpensAt } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDateTime, formatDayLabel, formatKrw, formatPercent, formatPrice, formatQty, formatRate, formatRequester, trendClass } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { useOrderBarPresence } from "../lib/orderBar";
import { quoteHolding } from "../lib/holding";
import { isTodayFill, todayFillText } from "../lib/orderText";
import { quotePriceName, reportStatusText } from "../lib/plainText";
import { stockAsOfBasis } from "../lib/quote";
import { quotaSentence, todayReport } from "../lib/reports";

// 차트 라이브러리는 종목 상세에서만 쓰므로 따로 불러온다. 불러온 적이 있으면(다시 온 화면) 차트를 페이드하지 않는다
let chartLoaded = false;
const CandleChart = lazy(() =>
  import("../components/charts/CandleChart").then((m) => {
    chartLoaded = true;
    return { default: m.CandleChart };
  }),
);

// 2단 배치: 왼쪽(보기)은 1열에 차례로, 오른쪽(하기)은 2열 1~3행을 걸치는 sticky 하나 (블록마다 좌우를 정하면 같은 행 높이가 묶여 빈틈이 생긴다)
const GRID = "grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-x-6";
const LEFT = "min-w-0 lg:col-start-1";
const RIGHT = "lg:sticky lg:top-8 lg:col-start-2 lg:row-span-3 lg:row-start-1";
/** 차트 높이: 쉬운 보기는 낮은 선 차트, 전문가 보기 PC는 화면 높이에 맞춰(800px 화면에서 300px) 큰 버튼이 첫 화면에 들어오게. */
const CHART_H = {
  easy: "h-[208px] lg:h-[320px]",
  expert: "h-[280px] lg:h-[clamp(280px,calc(100dvh-500px),380px)]",
} as const;

/** 마지막으로 있던 값 (닫히는 접힘 안에 내용을 남겨 두려고 — 닫히는 동안 빈 상자가 접히지 않게). */
function useLast<T>(value: T | null): T | null {
  const [last, setLast] = useState(value);
  if (value !== null && value !== last) setLast(value); // 렌더 중 조건부 파생 상태
  return value ?? last;
}

function LatestAnalysis({ a, easy }: { a: AnalysisSummary; easy: boolean }) {
  return (
    <Link to={`/analyses/${a.id}`} className="block rounded-2xl bg-fill p-4 transition-colors hover:bg-line/60 active:bg-line">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[14px] text-sub">
          최근 교차검증 분석 · {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)}
        </p>
        {!easy && <VerdictBadge verdict={a.verdict} />}
      </div>
      {a.best ? (
        <p className="mt-2 text-[14px] tabular-nums">
          {easy ? "사는 가격" : "진입"} <b>{formatPrice(a.best.entryPrice, a.currency)}</b> · {easy ? "목표 가격" : "목표"}{" "}
          <b className="text-up">{formatPrice(a.best.targetPrice, a.currency)}</b> · {easy ? "손절 가격" : "손절"}{" "}
          <b className="text-down">{formatPrice(a.best.stopPrice, a.currency)}</b>
          {!easy && (
            <span className="text-mute">
              {" "}
              (점수 {a.best.score ?? "-"}, 확률 {formatPercent(a.best.probability)})
            </span>
          )}
        </p>
      ) : (
        // 목록 요약에는 오류가 없어 까닭(조건 불충족인지 AI가 응답하지 못했는지)을 모른다 → 사실만 말하고, 까닭은 분석 상세의 과정 카드가 말한다
        <p className="mt-2 text-[14px] text-mute">{easy ? "AI가 낸 계획이 없어요." : "제안된 시나리오가 없어요."}</p>
      )}
      <p className="mt-2 flex items-center gap-0.5 text-[13px] font-semibold text-brand-ink">
        {easy ? "검증 과정 보기" : "분석 자세히 보기"} <Icon name="chevron" className="size-4" />
      </p>
    </Link>
  );
}

/** 장애 주입 폼 (펼쳤을 때만 실행 계획을 받는다 — Worker 고르기용). */
function ChaosPanel({ value, onChange }: { value: ChaosRequest | null; onChange: (v: ChaosRequest | null) => void }) {
  const { data: plan } = useReportPlan();
  const workers = plan ? plan.workers.filter((w) => plan.steps.some((st) => st.workers.includes(w.id))) : [];
  return <ChaosForm value={value} onChange={onChange} workers={workers} />;
}

/**
 * 큰 버튼 "AI 리포트 만들기" + 오늘 남은 횟수. 오늘 이 종목 리포트가 이미 있으면 "오늘 리포트 보기"가 먼저 (docs/plans/컨셉변경계획.md 4-2 —
 * 고르는 규칙은 리포트 탭의 만들기 카드와 같은 lib/reports todayReport).
 * 리포트 목록과 한도를 둘 다 받을 때까지 버튼 자리에 뼈대를 둔다 — 틀린 버튼(누를 수 있는 '만들기')이 먼저 보였다가 바뀌지 않게.
 * 전문가 보기에는 접힌 '장애 주입(시연)'이 있다 (docs/tasks/05-프론트.md T5-22 — 끔 모드에서만).
 */
function ReportCta({ stock, easy }: { stock: StockDetail; easy: boolean }) {
  const navigate = useNavigate();
  const { data: me } = useMe();
  const quotaQ = useReportQuota();
  const reportsQ = useReports({ symbol: stock.symbol, limit: 20 });
  const request = useRequestReport();
  const [chaos, setChaos] = useState<ChaosRequest | null>(null);
  const [chaosOpen, setChaosOpen] = useState(false);
  const titleId = useId();
  const chaosId = useId();
  const settled = !reportsQ.isPending && !quotaQ.isPending;
  const reveal = useRevealAfterLoading(!settled);
  const quota = quotaQ.data;
  const existing = reportsQ.data ? todayReport(reportsQ.data.results) : null;
  const spent = quota?.remaining === 0;
  const chaosOn = !easy && chaos !== null;
  const create = () => request.mutate({ symbol: stock.symbol, chaos: chaosOn ? chaos : null }, { onSuccess: (r) => navigate(`/reports/${r.id}`) });
  // 429는 둘: 내 하루 횟수 한도(본문에 limit)면 한도 문장, 팀 비용 예산이면 서버 문장 (사람마다 한도가 남아 있어도 막힌다)
  const limitError = request.error instanceof ApiError && isCountLimit(request.error);
  const errorText = request.isError ? (limitError ? "오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요" : errorMessage(request.error)) : null;
  const shownError = useLast(errorText);
  const chaosLabel = chaosOn ? " · 장애 주입" : "";

  return (
    <section aria-labelledby={titleId} aria-busy={!settled || undefined} className="rounded-2xl bg-card p-5">
      <h2 id={titleId} className="text-[17px] font-bold">
        AI 리포트
      </h2>
      <p className="mt-0.5 text-[13px] leading-snug text-sub">
        {easy ? (
          <>
            AI 여러 곳이 시세·재무·뉴스를 읽고 리포트를 써요.
            <span className="max-lg:hidden"> 검토 AI가 근거와 대조한 뒤 완성돼요.</span>
          </>
        ) : (
          "Agent 워크플로우가 쓰는 종목 리포트예요. 진행 기록(Trace)을 따라갈 수 있어요."
        )}
      </p>

      {!settled ? (
        <div aria-hidden="true">
          <Skeleton className="mt-3 h-14 w-full rounded-2xl" />
          <Skeleton className="mx-auto mt-3 h-4 w-44" />
        </div>
      ) : (
        <div className={reveal ? "reveal-fade" : undefined}>
          {existing ? (
            <>
              <Link
                to={`/reports/${existing.id}`}
                className="press mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark"
              >
                <Icon name="doc" className="size-5" />
                오늘 리포트 보기
              </Link>
              <p className="mt-1.5 text-center text-[13px] text-mute">
                {me && existing.requestedBy === me.nickname ? "내가 만듦" : `${existing.requestedBy} 님이 만듦`} · {reportStatusText(existing.status, easy)}
              </p>
              <button
                type="button"
                disabled={spent || request.isPending}
                onClick={create}
                className="press mx-auto mt-1 flex h-11 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-semibold text-sub hover:bg-fill disabled:opacity-40"
              >
                {request.isPending ? <Spinner /> : <Icon name="restart" className="size-4" />}
                새로 만들기{chaosLabel}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={spent || request.isPending}
              onClick={create}
              className="press mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
            >
              {request.isPending ? <Spinner /> : <Icon name="doc" className="size-5" />}
              AI 리포트 만들기{chaosLabel}
            </button>
          )}

          {!quota ? (
            <p className="mt-2 flex items-center justify-center gap-2 text-center text-[13px] text-sub" role="alert">
              오늘 남은 횟수를 확인하지 못했어요.
              <button
                type="button"
                onClick={() => void quotaQ.refetch()}
                disabled={quotaQ.isFetching}
                className="press relative h-8 rounded-lg bg-fill px-2.5 text-[13px] font-semibold text-ink before:absolute before:inset-x-0 before:-inset-y-1.5 hover:bg-line disabled:opacity-40"
              >
                다시 확인
              </button>
            </p>
          ) : (
            <p className="mt-2 text-center text-[13px] text-sub" aria-live="polite">
              {quotaSentence(quota)}
            </p>
          )}
        </div>
      )}

      <Collapse open={errorText !== null}>
        <div className="pt-3">
          <Notice tone="error">{shownError}</Notice>
        </div>
      </Collapse>

      {!easy && (
        <div className="mt-3 border-t border-line pt-1">
          <button
            type="button"
            aria-expanded={chaosOpen}
            aria-controls={chaosOpen ? chaosId : undefined}
            onClick={() => setChaosOpen(!chaosOpen)}
            className="-mx-2 flex h-11 w-[calc(100%+1rem)] items-center justify-between rounded-lg px-2 text-[14px] font-semibold text-sub transition-colors hover:bg-fill active:bg-line/60"
          >
            <span className="flex items-center gap-1.5">
              <Icon name="bolt" className="size-4 text-warn" />
              장애 주입 (시연)
              {chaosOn && <span className="rounded-full bg-warn-soft px-2 py-0.5 text-[12px] font-bold text-warn-ink">켬</span>}
            </span>
            <Icon name="chevron-down" className={cn("size-5 text-mute-weak transition-transform duration-fast", chaosOpen && "rotate-180")} />
          </button>
          <Collapse open={chaosOpen} id={chaosId}>
            <div className="pt-2">
              <ChaosPanel value={chaos} onChange={setChaos} />
            </div>
          </Collapse>
        </div>
      )}
    </section>
  );
}

type Trading = ReturnType<typeof useSymbolTrading>;

/** 이 종목의 보유를 시세로 평가한 값 (종목 통화). 시세 가격이 없으면 null — 장마감 기준 계좌 값으로 돌아간다. */
function holdingNow(t: Trading, stock: StockDetail) {
  if (t.state !== "holding" || !t.order) return null;
  return quoteHolding(stock.quote, {
    avgPrice: t.position?.avgPrice ?? t.order.fillPrice,
    quantity: t.order.quantity,
    // 계좌를 아직 받지 못했으면 오늘 산 종목인지 모른다 — 시세가 직전 종가일 때 체결가와 견주지 않게 오늘 산 것으로 본다 (독립 리뷰)
    todayFill: !t.position || isTodayFill(t.position),
  });
}

/**
 * 내 모의 주문 한 줄 (보유·체결 대기·매수 예약). 한 줄 문장으로 — 시세 카드의 가격 이름('현재가'·'종가')·가격 글자와 겹치지 않게.
 * 보유는 시세로 평가한다 (오늘 산 종목도 실시간 숫자). 시세 가격이 없으면 장마감 기준 계좌 값이고, 그때 오늘 산 보유(priceBasis "today_fill")는
 * 수익률 대신 언제 평가되는지 (체결가로 평가해 손익이 0이다 — 어제 종가와 비교한 가짜 손익을 보이지 않는다).
 */
function summaryLine(t: Trading, stock: StockDetail, easy: boolean): ReactNode | null {
  if (t.state === "holding" && t.order) {
    const p = t.position;
    const hv = holdingNow(t, stock);
    return (
      <span className="min-w-0 tabular-nums">
        <b className="font-semibold">모의 보유</b> {formatQty(t.order.quantity)}
        {hv ? (
          <>
            {" "}
            · {formatPrice(hv.value, stock.currency)}
            {hv.rate !== null && (
              <>
                {" "}
                <span className={trendClass(hv.rate)}>{formatRate(hv.rate)}</span>
              </>
            )}
          </>
        ) : (
          p &&
          (isTodayFill(p) ? (
            <>
              {" "}
              · {formatKrw(p.valueKrw)} <span className="text-mute">· {todayFillText(p.market, easy)}</span>
            </>
          ) : (
            <>
              {" "}
              · {formatKrw(p.valueKrw)} <span className={trendClass(p.profitKrw)}>{formatRate(p.profitRate)}</span>
            </>
          ))
        )}
        {t.sellReservation && " · 매도 예약됨"}
      </span>
    );
  }
  if (t.state === "pending" && t.order) {
    return (
      <span className="min-w-0 tabular-nums">
        <b className="font-semibold">체결 대기</b> {formatQty(t.order.quantity)}
        {t.order.limitPrice != null && ` · ${formatPrice(t.order.limitPrice, t.order.currency)} 이하`}
      </span>
    );
  }
  if (t.state === "reserved" && t.buyReservation) {
    return (
      <span className="min-w-0 tabular-nums">
        <b className="font-semibold">매수 예약됨</b> {formatQty(t.buyReservation.quantity)} · {formatOpensAt(t.buyReservation.runAt, stock.market)}
      </span>
    );
  }
  return null;
}

/** 한 줄 요약이 바뀌었는지 가리는 열쇠 (같은 내용이면 같은 문자열). */
function summaryKey(t: Trading, stock: StockDetail): string | null {
  if (t.state === "holding") {
    const hv = holdingNow(t, stock);
    return `h:${t.order?.quantity}:${hv ? `${hv.value}:${hv.rate}` : `${t.position?.valueKrw}:${t.position?.profitKrw}:${t.position?.priceBasis}`}:${Boolean(t.sellReservation)}`;
  }
  if (t.state === "pending") return `p:${t.order?.quantity}:${t.order?.limitPrice}`;
  if (t.state === "reserved") return `r:${t.buyReservation?.quantity}:${t.buyReservation?.runAt}`;
  return null;
}

/** 시세 카드 안 '내 모의 주문' 한 줄: 보유자가 이 화면에 오는 가장 잦은 이유(내 것 확인)를 맨 위에. 누르면 주문으로. */
function MySummary({
  t,
  stock,
  easy,
  onOpen,
  className,
}: {
  t: Trading;
  stock: StockDetail;
  easy: boolean;
  onOpen: (e: MouseEvent<HTMLButtonElement>) => void;
  className?: string;
}) {
  const line = summaryLine(t, stock, easy);
  const key = summaryKey(t, stock);
  // 접히는 동안 보일 마지막 내용 (요약이 바뀐 때만 새로 담는다 — 새 엘리먼트를 그대로 비교하면 매번 달라 끝없이 다시 그린다)
  const [last, setLast] = useState<{ key: string | null; line: ReactNode }>({ key, line });
  if (key !== null && key !== last.key) setLast({ key, line }); // 렌더 중 조건부 파생 상태
  const shown = line ?? last.line;
  return (
    <Collapse open={line !== null} className={className}>
      <div className="pt-3">
        <button
          type="button"
          onClick={onOpen}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl bg-fill px-3.5 py-2 text-left text-[14px] transition-colors hover:bg-line/60 active:bg-line"
        >
          {shown}
          <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
        </button>
      </div>
    </Collapse>
  );
}

type BarTone = "buy" | "sell" | "plain" | "wait";
const BAR_BUTTON = "press flex h-14 w-full flex-col items-center justify-center rounded-2xl text-[17px] leading-tight font-bold";
const BAR_TONE: Record<BarTone, string> = {
  buy: "bg-up text-white hover:bg-up-dark",
  sell: "bg-down text-white hover:bg-brand-dark",
  plain: "bg-fill text-ink hover:bg-line",
  wait: "bg-fill text-mute",
};

/** 모바일 하단 고정 버튼: 받기 전에는 중립(누를 수 없음), 보유 중이면 판매, 대기 주문·예약이면 확인, 분석에서 왔으면 채운 가격으로 주문. */
function barAction(t: Trading, prefill: Prefill | null): { label: string; sub?: string; tone: BarTone } {
  switch (t.state) {
    case "loading":
      return { label: "주문", tone: "wait" };
    case "error":
      return { label: "주문", tone: "plain" };
    case "holding":
      return t.sellReservation ? { label: "매도 예약 보기", tone: "plain" } : { label: "판매하기", tone: "sell" };
    case "pending":
      return { label: "대기 주문 보기", tone: "plain" };
    case "reserved":
      return { label: "예약 보기", tone: "plain" };
    default:
      return prefill
        ? { label: "분석 가격으로 주문하기", sub: `AI 분석 #${prefill.analysisId}의 목표가·손절가를 채워 뒀어요`, tone: "buy" }
        : { label: "구매하기", tone: "buy" };
  }
}

/**
 * 모바일 하단 고정 구매 바 (전문가 보기). 그려져 있는 동안 Layout이 하단 탭을 내려 숨긴다 (lib/orderBar — 주소가 아니라 이 바를 따른다:
 * 없는 종목·오류 화면은 바를 그리지 않으므로 탭이 남는다). 첫 로딩의 뼈대도 같은 자리에 누를 수 없는 바를 그린다 — 받은 뒤 탭이 다시 올라왔다 내려가지 않게.
 */
function BuyBar({ children }: { children: ReactNode }) {
  useOrderBarPresence();
  return (
    <div className="fixed inset-x-0 bottom-0 z-(--z-nav) border-t border-line bg-card px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:hidden">
      {children}
    </div>
  );
}

/** 쉬운 보기의 주문: "직접 주문(고급)"으로 접어 둔다. 이 종목에 내 모의 주문·보유·예약이 있으면 "내 모의 주문"으로 펼친 채 시작한다. */
function AdvancedOrder({
  stock,
  prefill,
  busy,
  open,
  onToggle,
  onDone,
  sectionRef,
  toggleRef,
  className,
}: {
  stock: StockDetail;
  prefill: Prefill | null;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  /** 패널에서 주문·매도·취소가 끝났을 때 (OrderPanel onDone — 그 결과로 저절로 접히면 포커스를 접힘 버튼으로 옮기는 표시) */
  onDone: () => void;
  sectionRef: RefObject<HTMLElement | null>;
  toggleRef: RefObject<HTMLButtonElement | null>;
  className?: string;
}) {
  return (
    <section ref={sectionRef} aria-label="주문" className={cn("scroll-mt-16 rounded-2xl bg-card p-5 lg:scroll-mt-8", className)}>
      <button
        ref={toggleRef}
        type="button"
        aria-expanded={open}
        aria-controls={open ? "advanced-order" : undefined}
        onClick={onToggle}
        className="-my-1 flex min-h-12 w-full items-center justify-between gap-3 text-left"
      >
        <span className="min-w-0">
          <span className="block text-[17px] font-bold">{busy ? "내 모의 주문" : "직접 주문(고급)"}</span>
          {!busy && <span className="mt-0.5 block text-[13px] font-normal text-mute">AI 리포트 없이 내가 직접 정해서 모의 계좌로 사요</span>}
        </span>
        <Icon name="chevron-down" className={cn("size-5 shrink-0 text-mute-weak transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id="advanced-order">
        <div className="pt-4">
          <OrderPanel key={prefill ? `analysis-${prefill.analysisId}` : "plain"} stock={stock} prefill={prefill} onDone={onDone} layout="inline" easy />
        </div>
      </Collapse>
    </section>
  );
}

/**
 * 화면 머리 제목: 종목 이름. 모바일에서 시세의 가격 줄이 머리 아래로 지나가면 둘째 줄에 작은 가격이 올라온다 (판단 기준인 '지금 가격'을 잃지 않게).
 * 가격 줄은 화면 읽기에서 뺀다 (제목 이름은 종목 이름 그대로). PC는 머리가 붙지 않으므로 그리지 않는다.
 */
function HeaderTitle({ stock, show }: { stock: StockDetail; show: boolean }) {
  const q = stock.quote;
  return (
    <>
      <span className="block truncate leading-tight">{stock.name}</span>
      <span
        aria-hidden="true"
        className={cn("grid transition-[grid-template-rows] duration-fast ease-standard lg:hidden", show ? "grid-rows-[1fr]" : "grid-rows-[0fr]")}
      >
        <span className="min-h-0 overflow-hidden">
          <span
            className={cn(
              "block pt-0.5 text-[13px] leading-tight font-semibold tabular-nums transition-[opacity,translate] duration-fast ease-standard",
              show ? "translate-y-0 opacity-100" : "translate-y-1.5 opacity-0",
            )}
          >
            {formatPrice(q.price, stock.currency)} <span className={trendClass(q.changeRate)}>{formatRate(q.changeRate)}</span>
          </span>
        </span>
      </span>
    </>
  );
}

function Detail({ stock, prefill, reveal }: { stock: StockDetail; prefill: Prefill | null; reveal: boolean }) {
  const { easy, view } = useViewMode();
  const { data: me } = useMe();
  const userId = me?.id ?? null;
  const t = useSymbolTrading(stock.symbol);
  const busy = t.state === "holding" || t.state === "pending" || t.state === "reserved";
  const [sheetOpen, setSheetOpen] = useState(false);
  const [orderOpen, setOrderOpen] = useState<boolean | null>(null); // 쉬운 보기 '직접 주문(고급)' (null이면 주문이 있을 때 펼침)
  const [priceHidden, setPriceHidden] = useState(false);
  const [chartWasLoaded] = useState(() => chartLoaded);
  const { data: recent } = useAnalyses({ symbol: stock.symbol, limit: 1 });
  const latest = useLast(recent?.results[0] ?? null);
  const q = stock.quote;
  const lastBar = stock.candles.at(-1);
  const sheet = useRef<HTMLElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const barButton = useRef<HTMLButtonElement>(null);
  const closedByAction = useRef(false); // 시트가 매도·취소로 닫히는 중 (Esc·닫기 버튼과 나눈다)
  const orderSection = useRef<HTMLElement>(null);
  const orderToggle = useRef<HTMLButtonElement>(null);
  const orderActedAt = useRef(0); // 쉬운 보기 '내 모의 주문'에서 매도·취소(주문)가 끝난 때
  const priceRow = useRef<HTMLParagraphElement>(null);
  const dockId = useId();
  const dockTitleId = useId();
  const crossTitleId = useId();
  const bar = barAction(t, prefill);
  const expanded = orderOpen ?? busy;

  // 최근 본 종목 (종목 검색 첫 화면의 바로가기 — 이 기기에, 계정마다 따로)
  useEffect(() => {
    if (userId !== null) addRecentStock(userId, { symbol: stock.symbol, name: stock.name });
  }, [userId, stock.symbol, stock.name]);

  // 주문 시트: 열린 동안만 모달 (처음 포커스·Esc·배경 잠금·스크롤 잠금, 닫히면 연 버튼으로). PC 패널일 때는 아무것도 하지 않는다
  useModal(sheet, { active: sheetOpen, onClose: () => setSheetOpen(false), initialFocus: sheet, returnFocus: opener });

  // 매도·취소가 끝나 닫혔으면 포커스는 하단 버튼으로 (useModal이 연 버튼으로 돌려준 다음 — 같은 컴포넌트의 layout effect는 선언 순서로 돈다).
  // '내 모의 주문' 한 줄에서 열었어도 그 줄은 보유·대기가 끝나면 접혀 사라지므로(접히는 동안 inert) 거기 두면 포커스가 body로 빠진다.
  // 아무것도 하지 않고 닫았으면(Esc·닫기·배경) 연 줄로 돌아간다
  useLayoutEffect(() => {
    if (sheetOpen || !closedByAction.current) return;
    closedByAction.current = false;
    const button = barButton.current;
    if (button && opener.current !== button) button.focus({ preventScroll: true });
  }, [sheetOpen]);

  // 쉬운 보기 '내 모의 주문': 주문을 취소하거나 팔아 이 종목의 주문이 없어지면 그 묶음이 저절로 접힌다(접히는 동안 inert, 그 뒤 사라짐).
  // 그 안에 있던 포커스는 body로 빠지므로 접힘 버튼으로 옮긴다 (a11y-11). 조건: 포커스가 묶음 안에 있거나, 방금 한 동작의 결과로 잃었을 때
  // (주문 패널의 새 본문 제목 포커스는 접히는 inert 안이라 받지 못한다 — 자식 layout effect가 먼저 돈다). 사용자가 다른 곳으로 옮겼으면 그대로
  useLayoutEffect(() => {
    if (expanded) return;
    const acted = orderActedAt.current > 0 && Date.now() - orderActedAt.current <= ACTED_MS;
    orderActedAt.current = 0;
    const active = document.activeElement;
    const inside = active !== null && active !== document.body && Boolean(orderSection.current?.contains(active));
    const lost = !active || active === document.body || !active.isConnected;
    if (inside || (acted && lost)) orderToggle.current?.focus();
  }, [expanded]);

  // 화면이 PC 폭으로 넓어지면 시트를 닫는다 (같은 패널이 오른쪽 열로 돌아간다)
  useEffect(() => {
    if (!sheetOpen || typeof window.matchMedia !== "function") return;
    const wide = window.matchMedia("(min-width: 64rem)");
    const onChange = () => {
      if (wide.matches) setSheetOpen(false);
    };
    wide.addEventListener("change", onChange);
    return () => wide.removeEventListener("change", onChange);
  }, [sheetOpen]);

  // 숫자 키패드가 시트 아래쪽을 덮으면 시트를 키보드 위로 올린다 (수량을 치는 동안 바닥의 매수 버튼이 키보드 뒤로 숨지 않게)
  useEffect(() => {
    const el = sheet.current;
    const vv = typeof window !== "undefined" ? window.visualViewport : null;
    if (!sheetOpen || !el || !vv) return;
    const update = () => {
      const inset = vv.scale > 1.01 ? 0 : Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
      el.style.setProperty("--kb", `${inset}px`);
    };
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
      el.style.removeProperty("--kb");
    };
  }, [sheetOpen]);

  // 가격 줄이 모바일 머리(56px) 아래로 지나가면 머리에 작은 가격을 올린다
  useEffect(() => {
    const el = priceRow.current;
    if (!el || typeof IntersectionObserver !== "function") return;
    const io = new IntersectionObserver(([entry]) => setPriceHidden(!entry.isIntersecting && entry.boundingClientRect.top < 64), {
      rootMargin: "-56px 0px 0px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const openSheet = (e: MouseEvent<HTMLButtonElement>) => {
    opener.current = e.currentTarget; // 닫히면 연 버튼으로 (iOS Safari는 눌러도 버튼에 포커스를 주지 않는다)
    setSheetOpen(true);
  };

  // '내 모의 주문' 한 줄: 쉬운 보기는 직접 주문을 펼치고 그 자리로, 전문가 모바일은 주문 시트를 연다
  const openOrder = (e: MouseEvent<HTMLButtonElement>) => {
    if (!easy) {
      openSheet(e);
      return;
    }
    setOrderOpen(true);
    requestAnimationFrame(() => {
      orderToggle.current?.focus({ preventScroll: true });
      const s = orderSection.current;
      if (s && typeof s.scrollIntoView === "function") s.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    });
  };

  const chart = (
    <Suspense fallback={<ChartSkeleton easy={easy} />}>
      <div className={chartWasLoaded ? undefined : "reveal-fade"}>
        <CandleChart candles={stock.candles} currency={stock.currency} variant={easy ? "line" : "candle"} className={CHART_H[view]} />
      </div>
    </Suspense>
  );

  // 마지막 봉이 오늘 진행 중인 봉이면(StockDetail.asOf가 실시간 시세의 받은 시각) 그 봉의 종가는 아직 정해지지 않았다
  const barLive = stockAsOfBasis(stock) === "live";
  const caption = lastBar
    ? easy
      ? `${barLive ? "일봉 선 (마지막은 오늘 진행 중)" : "종가"} · 최근 ${stock.candles.length}일 · ${formatDayLabel(lastBar.date)}까지`
      : barLive
        ? `일봉 · 최근 ${stock.candles.length}일 · 마지막 봉 ${formatDayLabel(lastBar.date)}은 진행 중`
        : `일봉 · 최근 ${stock.candles.length}일 · 완성된 봉만 (마지막 봉 ${formatDayLabel(lastBar.date)} 종가)`
    : `일봉 · 최근 ${stock.candles.length}일`;

  const quoteCard = (
    <section aria-label="시세" className={cn("rounded-2xl bg-card p-5", LEFT)}>
      <p className="text-[14px] text-mute">
        {stock.symbol} · {stock.exchange}
      </p>
      <p ref={priceRow} className="mt-1 flex items-baseline gap-2">
        <span className="text-[14px] font-semibold text-sub">{quotePriceName(q.basis, easy)}</span>
        <span className="text-[30px] leading-tight font-bold tracking-tight tabular-nums">
          <Flash value={q.price}>{formatPrice(q.price, stock.currency)}</Flash>
        </span>
      </p>
      <p className="mt-0.5 text-[15px] font-semibold">
        <span className="sr-only">전 거래일 종가 대비 </span>
        <PriceChange change={q.change} rate={q.changeRate} currency={stock.currency} />
      </p>
      {q.asOf ? (
        <AsOf at={q.asOf} market={stock.market} basis={q.basis} className="mt-1 block" />
      ) : (
        // 시세를 못 받았을 때: 가격은 없고 마지막 봉의 장마감 시각만 있다
        <AsOf at={stock.asOf} market={stock.market} className="mt-1 block" />
      )}
      <MySummary t={t} stock={stock} easy={easy} onOpen={openOrder} className={easy ? undefined : "lg:hidden"} />
      {stock.warnings.length > 0 && (
        <div className="mt-3 space-y-2">
          {stock.warnings.map((w) => (
            <Notice key={w} tone="warn">
              {w}
            </Notice>
          ))}
        </div>
      )}
      <div className="mt-4">{chart}</div>
      <div className="mt-1.5 flex items-start justify-between gap-3 text-[12px] text-mute">
        {/* 차트 라이브러리 고지 (lightweight-charts — 차트 안 로고 대신) */}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          title="Charting by TradingView"
          // 글자(링크)라 text-mute (mute-weak는 아이콘·자리표시자용 — 글자로는 대비가 모자란다)
          className="shrink-0 rounded-sm text-mute transition-colors hover:text-sub hover:underline"
        >
          TradingView
        </a>
        <p className="min-w-0 text-right text-balance">{caption}</p>
      </div>
    </section>
  );

  const actions = (
    <div className={cn("space-y-3", easy ? RIGHT : LEFT)}>
      <ReportCta stock={stock} easy={easy} />
      <section aria-labelledby={crossTitleId} className="rounded-2xl bg-card p-5">
        <AnalysisRequest symbol={stock.symbol} name={stock.name} easy={easy} titleId={crossTitleId} />
        <Collapse open={recent?.results[0] !== undefined}>
          <div className="pt-4">{latest && <LatestAnalysis a={latest} easy={easy} />}</div>
        </Collapse>
      </section>
    </div>
  );

  return (
    <>
      <PageHeader title={<HeaderTitle stock={stock} show={priceHidden} />} docTitle={stock.name} back />
      <div className={cn(GRID, reveal && "reveal-fade")}>
        {quoteCard}
        {actions}
        <FundamentalsPanel symbol={stock.symbol} view={view} className={LEFT} />

        {easy ? (
          <AdvancedOrder
            stock={stock}
            prefill={prefill}
            busy={busy}
            open={expanded}
            onToggle={() => setOrderOpen(!expanded)}
            onDone={() => {
              orderActedAt.current = Date.now();
            }}
            sectionRef={orderSection}
            toggleRef={orderToggle}
            className={LEFT}
          />
        ) : (
          /* 주문 패널: PC는 오른쪽 sticky(화면 높이에 맞춰 안에서 스크롤, 버튼 묶음은 바닥에), 모바일은 하단 버튼 → 바텀시트. 한 벌만 그린다.
             scroll-pt·pb: 붙어 있는 머리(약 72px)·바닥 묶음(약 180px)만큼 — Tab으로 옮긴 칸이 그 밑에 가려지지 않게 (브라우저가 그만큼 비켜 스크롤한다) */
          <div data-open={sheetOpen || undefined} className={cn("order-dock lg:self-start", RIGHT)}>
            <div aria-hidden="true" data-inert-exempt="" className="dock-scrim absolute inset-0 lg:hidden" onClick={() => setSheetOpen(false)} />
            <section
              ref={sheet}
              id={dockId}
              tabIndex={-1}
              role={sheetOpen ? "dialog" : undefined}
              aria-modal={sheetOpen || undefined}
              aria-labelledby={sheetOpen ? dockTitleId : undefined}
              aria-label="주문"
              className="dock-sheet absolute inset-x-0 bottom-[var(--kb,0px)] max-h-[calc(88dvh-var(--kb,0px))] scroll-pt-20 scroll-pb-52 overflow-y-auto overscroll-contain rounded-t-3xl bg-card px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none lg:static lg:max-h-[calc(100dvh-7rem)] lg:rounded-2xl lg:pb-5"
            >
              <div className="sticky top-0 z-10 -mx-5 mb-1 flex items-center justify-between gap-2 bg-card px-5 pt-4 pb-3 lg:pt-5">
                <h2 id={dockTitleId} className="text-[18px] font-bold lg:text-[17px]">
                  {busy ? "내 모의 주문" : "주문하기"}
                </h2>
                <button
                  type="button"
                  aria-label="닫기"
                  onClick={() => setSheetOpen(false)}
                  className="-mr-2 grid size-11 place-items-center rounded-full text-sub transition-colors hover:bg-fill active:bg-line/60 lg:hidden"
                >
                  <Icon name="close" className="size-5" />
                </button>
              </div>
              <OrderPanel
                key={prefill ? `analysis-${prefill.analysisId}` : "plain"}
                stock={stock}
                prefill={prefill}
                onDone={() => {
                  if (sheetOpen) closedByAction.current = true; // PC 패널(시트 아님)에서는 표시하지 않는다
                  setSheetOpen(false);
                }}
              />
            </section>
          </div>
        )}
      </div>

      {!easy && (
        <BuyBar>
          <button
            ref={barButton}
            type="button"
            onClick={openSheet}
            disabled={bar.tone === "wait"}
            aria-busy={bar.tone === "wait" || undefined}
            aria-haspopup="dialog"
            aria-expanded={sheetOpen}
            aria-controls={dockId}
            className={cn(BAR_BUTTON, BAR_TONE[bar.tone])}
          >
            {bar.label}
            {bar.sub && <span className="mt-0.5 text-[12px] font-medium opacity-90">{bar.sub}</span>}
          </button>
        </BuyBar>
      )}
    </>
  );
}

/** 차트 자리 (범례 줄 + 차트 상자 — 실제와 같은 높이). */
function ChartSkeleton({ easy }: { easy: boolean }) {
  return (
    <div aria-hidden="true">
      <Skeleton className="h-4 w-2/5" />
      <Skeleton className={cn("mt-1 w-full", CHART_H[easy ? "easy" : "expert"])} />
    </div>
  );
}

/** 첫 로딩: 실제 배치를 따른 뼈대 (시세·차트 → 큰 버튼, PC 오른쪽은 보기에 맞춰 — 전문가는 주문 패널, 쉬운 보기는 리포트 묶음. 전문가 모바일은 하단 구매 바 자리까지). */
function DetailSkeleton({ easy }: { easy: boolean }) {
  return (
    <>
      <PageHeader title={<Skeleton className="h-6 w-32" />} docTitle="종목" back />
      <div className={GRID} role="group" aria-busy="true" aria-label="불러오는 중">
        <div className={cn("rounded-2xl bg-card p-5", LEFT)}>
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="mt-2.5 h-9 w-1/2" />
          <Skeleton className="mt-2 h-4 w-1/4" />
          <Skeleton className="mt-2 h-3 w-2/5" />
          <div className="mt-4">
            <ChartSkeleton easy={easy} />
          </div>
        </div>
        <div className={cn("rounded-2xl bg-card p-5", easy ? RIGHT : LEFT)}>
          <Skeleton className="h-5 w-24" />
          <Skeleton className="mt-2 h-4 w-3/4" />
          <Skeleton className="mt-3 h-14 w-full rounded-2xl" />
          <Skeleton className="mx-auto mt-3 h-4 w-44" />
        </div>
        {!easy && (
          <div className={cn("hidden space-y-4 rounded-2xl bg-card p-5 lg:block", RIGHT)}>
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-10 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-14 w-full rounded-2xl" />
          </div>
        )}
      </div>
      {!easy && (
        <BuyBar>
          <button type="button" disabled aria-busy="true" className={cn(BAR_BUTTON, BAR_TONE.wait)}>
            주문
          </button>
        </BuyBar>
      )}
    </>
  );
}

export function StockPage() {
  const { symbol = "" } = useParams();
  const [params] = useSearchParams();
  const analysisId = Number(params.get("analysis") ?? NaN);
  const { data: stock, isPending, isError, error, refetch, isFetching } = useStock(symbol);
  const { data: analysis } = useAnalysis(analysisId);
  const { easy } = useViewMode();
  // 기다린 끝에 왔을 때만 본문이 페이드로 들어온다 (캐시로 바로 그리면 움직이지 않는다)
  const reveal = useRevealAfterLoading(isPending);

  const best = analysis && analysis.symbol === stock?.symbol ? analysis.best : null;
  const prefill: Prefill | null = best
    ? { analysisId: analysis!.id, targetPrice: best.targetPrice, stopPrice: best.stopPrice, days: best.holdingDays }
    : null;

  if (isPending) return <DetailSkeleton easy={easy} />;
  if (isError) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <>
        <PageHeader title="종목" back />
        <section className="rounded-2xl bg-card p-5">
          {notFound ? (
            // 같은 요청을 다시 보내도 결과가 같다 — 다시 시도 대신 검색으로 (검색어를 채워서)
            <EmptyState icon="search" title="종목을 찾을 수 없어요" action={{ label: "종목 검색으로", to: `/search?q=${encodeURIComponent(symbol)}` }}>
              종목코드를 확인해 주세요 ({symbol})
            </EmptyState>
          ) : (
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
          )}
        </section>
      </>
    );
  }
  return <Detail stock={stock} prefill={prefill} reveal={reveal} />;
}
