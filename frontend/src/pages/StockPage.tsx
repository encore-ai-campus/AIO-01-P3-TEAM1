import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useAnalyses, useAnalysis, useStock } from "../api/queries";
import { useSymbolTrading } from "../api/trading";
import type { AnalysisSummary, StockDetail } from "../api/types";
import { AnalysisRequest } from "../components/AnalysisRequest";
import { Icon } from "../components/Icon";
import { OrderPanel, type Prefill } from "../components/OrderPanel";
import { ReportRequest } from "../components/reports/ReportRequest";
import { Card, ErrorState, Flash, Notice, PageHeader, PriceChange, Skeleton, SkeletonCard, VerdictBadge } from "../components/ui";
import { cn } from "../lib/cn";
import { formatDateTime, formatPercent, formatPrice, formatRequester } from "../lib/format";

// 차트 라이브러리는 종목 상세에서만 쓰므로 따로 불러온다
const CandleChart = lazy(() => import("../components/CandleChart").then((m) => ({ default: m.CandleChart })));

function LatestAnalysis({ a }: { a: AnalysisSummary }) {
  return (
    <Link to={`/analyses/${a.id}`} className="block rounded-2xl bg-fill p-4 hover:bg-line/60">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[14px] text-sub">
          최근 AI 분석 · {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)}
        </p>
        <VerdictBadge verdict={a.verdict} />
      </div>
      {a.best ? (
        <p className="mt-2 text-[14px] tabular-nums">
          진입 <b>{formatPrice(a.best.entryPrice, a.currency)}</b> · 목표 <b className="text-up">{formatPrice(a.best.targetPrice, a.currency)}</b>{" "}
          · 손절 <b className="text-down">{formatPrice(a.best.stopPrice, a.currency)}</b>
          <span className="text-mute">
            {" "}
            (점수 {a.best.score ?? "-"}, 확률 {formatPercent(a.best.probability)})
          </span>
        </p>
      ) : (
        <p className="mt-2 text-[14px] text-mute">조건에 맞는 시나리오가 없었습니다.</p>
      )}
      <p className="mt-2 flex items-center gap-0.5 text-[13px] font-semibold text-brand">
        분석 자세히 보기 <Icon name="chevron" className="size-4" />
      </p>
    </Link>
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

function Detail({ stock, prefill }: { stock: StockDetail; prefill: Prefill | null }) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const bar = useBarAction(stock.symbol);
  const { data: recent } = useAnalyses({ symbol: stock.symbol, limit: 1 });
  const latest = recent?.results[0];
  const q = stock.quote;

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
          <Card>
            <p className="text-[14px] text-mute">
              {stock.symbol} · {stock.exchange}
            </p>
            <p className="mt-1 text-[30px] leading-tight font-bold tracking-tight tabular-nums">
              <Flash value={q.price}>{formatPrice(q.price, stock.currency)}</Flash>
            </p>
            <p className="mt-0.5 text-[15px] font-semibold">
              <span className="sr-only">전일 대비 </span>
              <PriceChange change={q.change} rate={q.changeRate} currency={stock.currency} />
            </p>
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
            <p className="mt-1 text-right text-[12px] text-mute">일봉 · 최근 {stock.candles.length}일</p>
          </Card>

          <Card className="space-y-4">
            <AnalysisRequest symbol={stock.symbol} name={stock.name} />
            {latest && <LatestAnalysis a={latest} />}
          </Card>

          <Card>
            <ReportRequest symbol={stock.symbol} />
          </Card>
        </div>

        {/* 주문 패널: PC는 오른쪽 고정, 모바일은 하단 버튼 → 바텀시트 (한 벌만 그려 CSS로 위치를 바꾼다) */}
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
      </div>

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
