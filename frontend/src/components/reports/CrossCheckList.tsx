// 리포트 탭 '오늘의 선별 결과' 카드의 "교차검증 분석" 칩 (D-1 — 2026-10-12 리포트 목록 칩에서 옮김, docs/DECISIONS.md 34장):
// 여러 AI가 각자 계획을 내고 서로 검증한 분석 목록 → 분석 상세 /analyses/:id. 10개씩 쪽으로 넘긴다 (쪽은 주소의 ?cpage=).
// 쉬운 보기는 과정만 쉬운 말로, 점수·확률·분석 시각 가격은 전문가 보기에서만 (docs/DECISIONS.md 13-1).
// 쉬운 행의 둘째 줄은 행마다 다른 정보(제안 수 · 최종 승인 AI)다 — 같은 설명은 목록 위에 한 번만 (훑어보는 비용을 줄인다).
// 분석 시각 가격은 장마감 기준이 아니다 (일부러 둔 예외 — 화면 "분석 시각 가격").
import { useEffect } from "react";
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { useAnalyses } from "../../api/queries";
import type { AnalysisSummary } from "../../api/types";
import { revealList, useRevealAfterLoading } from "../../hooks/useMotionState";
import { usePageParam } from "../../hooks/usePageParam";
import { cn } from "../../lib/cn";
import { formatDateTime, formatPercent, formatPrice, formatRequester } from "../../lib/format";
import { ANALYSIS_PRICE_LABEL } from "../../lib/plainText";
import { CROSS_CHECK_TEXT, crossCheckLine } from "../../lib/reports";
import { Icon } from "../Icon";
import { EmptyState, ErrorState } from "../ui";
import { ListSkeleton } from "./ListSkeleton";
import { Pager } from "./Pager";
import { VerdictText } from "./VerdictText";

const PAGE_SIZE = 10;

function Row({ a, expert }: { a: AnalysisSummary; expert: boolean }) {
  const t = CROSS_CHECK_TEXT[a.verdict];
  const best = a.best;
  return (
    <Link to={`/analyses/${a.id}`} className="press-row flex min-h-16 items-start gap-3 px-5 py-3 hover:bg-fill/60">
      <article aria-label={`${a.name} 교차검증 분석`} className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[16px] font-semibold">{a.name}</span>
          {expert ? (
            <VerdictText verdict={a.verdict} />
          ) : (
            <span
              className={cn(
                "inline-flex h-6 items-center rounded-md px-1.5 text-[12px] font-bold",
                a.verdict === "BUY" ? "bg-brand-soft text-brand-ink" : "bg-fill text-sub",
              )}
            >
              {t.badge}
            </span>
          )}
        </span>
        {expert ? (
          best && (
            <span className="mt-0.5 block text-[13px] text-sub tabular-nums">
              점수 {best.score ?? "-"} · 확률 {formatPercent(best.probability)} · 진입 {formatPrice(best.entryPrice, a.currency)} · 목표{" "}
              {formatPrice(best.targetPrice, a.currency)} · 손절 {formatPrice(best.stopPrice, a.currency)}
            </span>
          )
        ) : (
          <span className="mt-0.5 block text-[13px] leading-snug text-sub">{crossCheckLine(a)}</span>
        )}
        <span className="mt-0.5 block text-[12px] text-mute">
          {a.symbol} · {formatRequester(a.requestedBy)} 요청 · {formatDateTime(a.analyzedAt)}
          {expert && ` · 제안 ${a.scenarioCount}개`}
          {expert && a.priceAtAnalysis !== null && ` · ${ANALYSIS_PRICE_LABEL} ${formatPrice(a.priceAtAnalysis, a.currency)}`}
        </span>
      </article>
      <Icon name="chevron" className="mt-1 size-4 shrink-0 text-mute-weak" />
    </Link>
  );
}

export function CrossCheckList({ expert, anchorId }: { expert: boolean; anchorId?: string }) {
  const [page, setPage] = usePageParam("cpage");
  const { data, isPending, isError, error, refetch, isFetching, isPlaceholderData } = useAnalyses(
    { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE },
    { keepPrevious: true },
  );
  // 처음 불러온 목록만 한 번 페이드 (캐시로 바로 그리면 움직이지 않는다)
  const reveal = useRevealAfterLoading(isPending);
  const rows = data?.results ?? [];
  const pages = Math.ceil((data?.count ?? 0) / PAGE_SIZE);
  // 없는 쪽(주소를 직접 고쳤거나 목록이 줄었다)이면 마지막 쪽으로
  const over = data !== undefined && !isPlaceholderData && pages > 0 && page > pages;
  useEffect(() => {
    if (over) setPage(pages);
  }, [over, pages, setPage]);
  return (
    <div>
      <p className="px-5 text-[13px] leading-snug text-sub">
        여러 AI가 각자 계획(사는·목표·손절 가격)을 내고 서로 검증해 최종 승인하는 과정이에요. 리포트와 별개 기능이에요.
      </p>
      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <div className="px-5 py-3">
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
        </div>
      ) : rows.length === 0 && !over ? (
        <EmptyState icon="sparkle" compact className="px-5">
          아직 교차검증 분석이 없어요. 종목 화면의 &ldquo;AI 교차검증 분석&rdquo;으로 요청할 수 있어요.
        </EmptyState>
      ) : (
        <>
          <ul
            aria-label="교차검증 분석 목록"
            aria-busy={isPlaceholderData || undefined}
            {...revealList(reveal)}
            className={cn("mt-2 divide-y divide-line transition-opacity duration-fast", isPlaceholderData && "opacity-60")}
          >
            {rows.map((a) => (
              <li key={a.id}>
                <Row a={a} expert={expert} />
              </li>
            ))}
          </ul>
          <Pager page={Math.min(page, Math.max(pages, 1))} total={pages} onChange={setPage} name="교차검증 분석" anchorId={anchorId} />
        </>
      )}
    </div>
  );
}
