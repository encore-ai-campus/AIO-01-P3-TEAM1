// /stocks/:symbol 종목 상세 (docs/컨셉변경계획.md 4-2, docs/DECISIONS.md 13-1 D-1):
// 시세(장마감 기준 종가)·차트(완성 봉만) → 큰 버튼 "AI 리포트 만들기"(오늘 남은 횟수, 오늘 이 종목 리포트가 있으면 "오늘 리포트 보기") →
// 보조 버튼 "AI 교차검증 분석" → 펀더멘털 패널 → (단타 잠금이 풀렸고 국내 종목이면) 단타 연습장 링크 → 주문. 주린이모드(쉬운 보기)면 주문은 "직접 주문(고급)"으로 접어 둔다.
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useAnalyses, useAnalysis, useReports, useStock } from "../api/queries";
import { useReportQuota, useRequestReport } from "../api/reports";
import { useSymbolTrading } from "../api/trading";
import type { AnalysisSummary, ReportSummary, StockDetail } from "../api/types";
import { AnalysisRequest } from "../components/AnalysisRequest";
import { Icon } from "../components/Icon";
import { FundamentalsPanel } from "../components/longterm/FundamentalsPanel";
import { OrderPanel, type Prefill } from "../components/OrderPanel";
import { AsOf, Card, ErrorState, Flash, Notice, PageHeader, PriceChange, Skeleton, SkeletonCard, Spinner, VerdictBadge } from "../components/ui";
import { useBeginnerMode, useViewMode } from "../hooks/useBeginnerMode";
import { isTodayKst } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDateTime, formatDayLabel, formatPercent, formatPrice, formatRequester } from "../lib/format";
import { reportStatusText } from "../lib/plainText";

// 차트 라이브러리는 종목 상세에서만 쓰므로 따로 불러온다
const CandleChart = lazy(() => import("../components/CandleChart").then((m) => ({ default: m.CandleChart })));

function LatestAnalysis({ a, easy }: { a: AnalysisSummary; easy: boolean }) {
  return (
    <Link to={`/analyses/${a.id}`} className="block rounded-2xl bg-fill p-4 hover:bg-line/60">
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
        <p className="mt-2 text-[14px] text-mute">조건에 맞는 계획이 없었어요.</p>
      )}
      <p className="mt-2 flex items-center gap-0.5 text-[13px] font-semibold text-brand">
        {easy ? "검증 과정 보기" : "분석 자세히 보기"} <Icon name="chevron" className="size-4" />
      </p>
    </Link>
  );
}

/** 오늘(KST) 만든 이 종목 리포트 중 보일 하나: 완성된 것 중 최신, 없으면 만드는 중인 것 중 최신 (실패는 빼고). */
function todayReport(reports: readonly ReportSummary[]): ReportSummary | null {
  const today = reports.filter((r) => r.status !== "failed" && isTodayKst(r.createdAt));
  const newest = (list: ReportSummary[]) => list.reduce<ReportSummary | null>((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
  return newest(today.filter((r) => r.status === "completed")) ?? newest(today);
}

/** 큰 버튼 "AI 리포트 만들기" + 오늘 남은 횟수. 오늘 이 종목 리포트가 이미 있으면 "오늘 리포트 보기"가 먼저 (docs/컨셉변경계획.md 4-2). */
function ReportCta({ stock, easy }: { stock: StockDetail; easy: boolean }) {
  const navigate = useNavigate();
  const quotaQ = useReportQuota();
  const quota = quotaQ.data;
  const { data: reports } = useReports({ symbol: stock.symbol, limit: 20 });
  const request = useRequestReport();
  const existing = reports ? todayReport(reports.results) : null;
  const spent = quota ? quota.remaining <= 0 : false;
  const create = () => request.mutate({ symbol: stock.symbol }, { onSuccess: (r) => navigate(`/reports/${r.id}`) });
  const limitError = request.error instanceof ApiError && request.error.status === 429;

  return (
    <Card aria-labelledby="report-cta-title">
      <h2 id="report-cta-title" className="text-[17px] font-bold">
        AI 리포트
      </h2>
      <p className="mt-0.5 text-[13px] leading-snug text-sub">
        {easy
          ? "AI 여러 곳이 시세·재무·뉴스를 읽고 리포트를 써요. 검토 AI가 근거와 대조한 뒤 완성돼요."
          : "Agent 워크플로우가 쓰는 종목 리포트입니다. 진행 기록(Trace)을 따라갈 수 있습니다."}
      </p>

      {existing ? (
        <>
          <Link
            to={`/reports/${existing.id}`}
            className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark"
          >
            <Icon name="doc" className="size-5" />
            오늘 리포트 보기
          </Link>
          <p className="mt-1.5 text-center text-[13px] text-mute">
            {existing.requestedBy} 님이 만듦 · {reportStatusText(existing.status, easy)}
          </p>
          <button
            type="button"
            disabled={spent || request.isPending}
            onClick={create}
            className="mx-auto mt-1 flex h-10 items-center gap-1 rounded-lg px-3 text-[14px] font-semibold text-sub hover:bg-fill disabled:opacity-40"
          >
            {request.isPending && <Spinner />}
            새로 만들기
          </button>
        </>
      ) : (
        <button
          type="button"
          disabled={spent || request.isPending}
          onClick={create}
          className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {request.isPending ? <Spinner /> : <Icon name="doc" className="size-5" />}
          AI 리포트 만들기
        </button>
      )}

      {!quota && quotaQ.isError ? (
        <p className="mt-2 flex items-center justify-center gap-2 text-center text-[13px] text-sub" role="alert">
          오늘 남은 횟수를 확인하지 못했어요.
          <button
            type="button"
            onClick={() => void quotaQ.refetch()}
            disabled={quotaQ.isFetching}
            className="h-8 rounded-lg bg-fill px-2.5 text-[13px] font-semibold text-ink hover:bg-line disabled:opacity-40"
          >
            다시 확인
          </button>
        </p>
      ) : (
        <p className="mt-2 text-center text-[13px] text-sub" aria-live="polite">
          {!quota
            ? "오늘 남은 횟수를 확인하는 중…"
            : spent
              ? "오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요"
              : `오늘 ${quota.remaining}번 더 만들 수 있어요`}
        </p>
      )}
      {request.isError && (
        <Notice tone="error" className="mt-3">
          {limitError ? "오늘은 다 만들었어요. 내일 0시에 다시 만들 수 있어요" : errorMessage(request.error)}
        </Notice>
      )}
    </Card>
  );
}

/** 모바일 하단 고정 버튼의 문구: 보유 중이면 판매, 대기 주문·예약이면 확인, 아니면 구매. */
function useBarAction(symbol: string): { label: string; tone: "buy" | "sell" | "plain" } {
  const t = useSymbolTrading(symbol);
  if (t.order?.status === "EXIT_WATCHING") return { label: "판매하기", tone: "sell" };
  if (t.order?.status === "ENTRY_PENDING") return { label: "대기 주문 보기", tone: "plain" };
  if (t.buyReservation) return { label: "예약 보기", tone: "plain" };
  return { label: "구매하기", tone: "buy" };
}

/** 쉬운 보기의 주문: "직접 주문(고급)"으로 접어 둔다. 이 종목에 내 모의 주문·보유·예약이 있으면 펼친 채로 시작한다. */
function AdvancedOrder({ stock, prefill }: { stock: StockDetail; prefill: Prefill | null }) {
  const t = useSymbolTrading(stock.symbol);
  const busy = Boolean(t.order || t.buyReservation);
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? busy;
  return (
    <section aria-label="주문" className="rounded-2xl bg-card p-5">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="advanced-order"
        onClick={() => setOpen(!expanded)}
        className="flex h-11 w-full items-center justify-between text-left text-[16px] font-bold"
      >
        <span>
          {busy ? "내 모의 주문" : "직접 주문(고급)"}
          {!busy && <span className="block text-[13px] font-normal text-mute">AI 리포트 없이 내가 직접 정해서 모의 계좌로 사요</span>}
        </span>
        <span aria-hidden="true" className={cn("text-mute transition-transform", expanded && "rotate-180")}>
          ▾
        </span>
      </button>
      {expanded && (
        <div id="advanced-order" className="mt-3">
          <OrderPanel key={prefill ? `analysis-${prefill.analysisId}` : "plain"} stock={stock} prefill={prefill} />
        </div>
      )}
    </section>
  );
}

/** 단타 연습장으로 (이 종목을 미리 골라 둔다). 국내 종목이고 잠금이 풀린 사람(주린이모드 끔 + 퀴즈 통과)에게만 보인다 (docs/API.md "단타 연습"). */
function DayPracticeLink({ stock }: { stock: StockDetail }) {
  const { profile } = useBeginnerMode();
  if (stock.market !== "KR" || !profile?.dayTradingUnlocked) return null;
  return (
    <Link
      to={`/day?symbol=${encodeURIComponent(stock.symbol)}`}
      className="flex h-12 items-center justify-between rounded-2xl bg-card px-5 text-[15px] font-semibold hover:bg-line"
    >
      <span className="flex items-center gap-1.5">
        <Icon name="bolt" className="size-4 text-[#9a5b00]" />이 종목으로 단타 연습
      </span>
      <Icon name="chevron" className="size-4" />
    </Link>
  );
}

function Detail({ stock, prefill }: { stock: StockDetail; prefill: Prefill | null }) {
  const { easy, view } = useViewMode();
  const [sheetOpen, setSheetOpen] = useState(false);
  const bar = useBarAction(stock.symbol);
  const { data: recent } = useAnalyses({ symbol: stock.symbol, limit: 1 });
  const latest = recent?.results[0];
  const q = stock.quote;
  const lastBar = stock.candles.at(-1);

  const sheet = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!sheetOpen) return;
    sheet.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setSheetOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sheetOpen]);

  return (
    <>
      <PageHeader title={stock.name} back />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-3">
          <Card aria-label="시세">
            <p className="text-[14px] text-mute">
              {stock.symbol} · {stock.exchange}
            </p>
            <p className="mt-1 flex items-baseline gap-2">
              <span className="text-[14px] font-semibold text-sub">종가</span>
              <span className="text-[30px] leading-tight font-bold tracking-tight tabular-nums">
                <Flash value={q.price}>{formatPrice(q.price, stock.currency)}</Flash>
              </span>
            </p>
            <p className="mt-0.5 text-[15px] font-semibold">
              <span className="sr-only">전 거래일 종가 대비 </span>
              <PriceChange change={q.change} rate={q.changeRate} currency={stock.currency} />
            </p>
            <AsOf at={q.asOf ?? stock.asOf} market={stock.market} className="mt-1 block" />
            {stock.warnings.length > 0 && (
              <div className="mt-3 space-y-2">
                {stock.warnings.map((w) => (
                  <Notice key={w} tone="warn">
                    {w}
                  </Notice>
                ))}
              </div>
            )}
            <div className="mt-4">
              <Suspense fallback={<Skeleton className="h-[280px] w-full lg:h-[380px]" />}>
                <CandleChart candles={stock.candles} currency={stock.currency} />
              </Suspense>
            </div>
            <p className="mt-1 text-right text-[12px] text-mute">
              일봉 · 최근 {stock.candles.length}일 · 완성된 봉만{lastBar ? ` (마지막 봉 ${formatDayLabel(lastBar.date)} 종가)` : ""}
            </p>
          </Card>

          <ReportCta stock={stock} easy={easy} />

          <Card className="space-y-4">
            <AnalysisRequest symbol={stock.symbol} name={stock.name} easy={easy} />
            {latest && <LatestAnalysis a={latest} easy={easy} />}
          </Card>

          <FundamentalsPanel symbol={stock.symbol} view={view} />

          <DayPracticeLink stock={stock} />
        </div>

        {easy ? (
          // 모바일은 한 열이라 위 카드들 아래에, PC는 오른쪽 열에 (하단 고정 구매 버튼 없음)
          <div className="lg:sticky lg:top-8">
            <AdvancedOrder stock={stock} prefill={prefill} />
          </div>
        ) : (
          /* 주문 패널: PC는 오른쪽 고정, 모바일은 하단 버튼 → 바텀시트 (한 벌만 그려 CSS로 위치를 바꾼다) */
          <div className={cn(sheetOpen ? "fixed inset-0 z-50" : "hidden", "lg:sticky lg:inset-auto lg:top-8 lg:z-auto lg:block")}>
            <button
              type="button"
              aria-label="주문 닫기"
              tabIndex={sheetOpen ? 0 : -1}
              onClick={() => setSheetOpen(false)}
              className="absolute inset-0 bg-black/40 lg:hidden"
            />
            <section
              ref={sheet}
              tabIndex={-1}
              aria-label="주문"
              className="absolute inset-x-0 bottom-0 max-h-[88dvh] animate-sheet-up overflow-y-auto rounded-t-3xl bg-card px-5 pt-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))] outline-none lg:static lg:max-h-none lg:animate-none lg:rounded-2xl lg:p-5"
            >
              <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-line lg:hidden" aria-hidden="true" />
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-[19px] font-bold">주문하기</h2>
                <button
                  type="button"
                  aria-label="닫기"
                  tabIndex={sheetOpen ? 0 : -1}
                  onClick={() => setSheetOpen(false)}
                  className="-mr-2 grid size-11 place-items-center rounded-full text-sub hover:bg-fill lg:hidden"
                >
                  <Icon name="close" className="size-5" />
                </button>
              </div>
              <OrderPanel
                key={prefill ? `analysis-${prefill.analysisId}` : "plain"}
                stock={stock}
                prefill={prefill}
                onDone={() => setSheetOpen(false)}
              />
            </section>
          </div>
        )}
      </div>

      {!easy && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:hidden">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className={cn(
              "h-14 w-full rounded-2xl text-[17px] font-bold",
              bar.tone === "buy" && "bg-up text-white",
              bar.tone === "sell" && "bg-down text-white",
              bar.tone === "plain" && "bg-fill text-ink",
            )}
          >
            {bar.label}
          </button>
        </div>
      )}
    </>
  );
}

export function StockPage() {
  const { symbol = "" } = useParams();
  const [params] = useSearchParams();
  const analysisId = Number(params.get("analysis") ?? NaN);
  const { data: stock, isPending, isError, error, refetch } = useStock(symbol);
  const { data: analysis } = useAnalysis(analysisId);

  const best = analysis && analysis.symbol === stock?.symbol ? analysis.best : null;
  const prefill: Prefill | null = best
    ? { analysisId: analysis!.id, targetPrice: best.targetPrice, stopPrice: best.stopPrice, days: best.holdingDays }
    : null;

  if (isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-32" />} back />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <SkeletonCard lines={8} />
          <SkeletonCard lines={6} className="hidden lg:block" />
        </div>
      </>
    );
  }
  if (isError) {
    return (
      <>
        <PageHeader title="종목" back />
        <Card>
          <ErrorState
            message={error instanceof ApiError && error.status === 404 ? "종목을 찾을 수 없습니다." : errorMessage(error)}
            onRetry={() => void refetch()}
          />
        </Card>
      </>
    );
  }
  return <Detail stock={stock} prefill={prefill} />;
}
