// 리포트 탭의 "교차검증 분석" 묶음 (D-1): 여러 AI가 각자 계획을 내고 서로 검증한 분석 목록 → 분석 상세 /analyses/:id.
// 쉬운 보기는 과정만 쉬운 말로, 점수·확률·분석 시각 가격은 전문가 보기에서만 (docs/DECISIONS.md 13-1).
// 분석 시각 가격은 장마감 기준이 아니다 (일부러 둔 예외 — 화면 "분석 시각 가격").
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { useAnalyses } from "../../api/queries";
import type { AnalysisSummary } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatDateTime, formatPercent, formatPrice, formatRequester } from "../../lib/format";
import { ANALYSIS_PRICE_LABEL } from "../../lib/plainText";
import { CROSS_CHECK_TEXT } from "../../lib/reports";
import { Icon } from "../Icon";
import { EmptyState, ErrorState, Skeleton, VerdictBadge } from "../ui";

function Row({ a, expert }: { a: AnalysisSummary; expert: boolean }) {
  const t = CROSS_CHECK_TEXT[a.verdict];
  const best = a.best;
  return (
    <Link to={`/analyses/${a.id}`} className="flex min-h-16 items-start gap-3 px-5 py-3 hover:bg-fill/60">
      <article aria-label={`${a.name} 교차검증 분석`} className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="truncate text-[16px] font-semibold">{a.name}</span>
          {expert ? (
            <VerdictBadge verdict={a.verdict} />
          ) : (
            <span
              className={cn(
                "inline-flex h-6 items-center rounded-md px-1.5 text-[12px] font-bold",
                a.verdict === "BUY" ? "bg-brand-soft text-brand-dark" : "bg-fill text-sub",
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
          <span className="mt-0.5 block text-[13px] leading-snug text-sub">{t.line}</span>
        )}
        <span className="mt-0.5 block text-[12px] text-mute">
          {a.symbol} · {formatRequester(a.requestedBy)} 요청 · {formatDateTime(a.analyzedAt)} · 제안 {a.scenarioCount}개
          {expert && a.priceAtAnalysis !== null && ` · ${ANALYSIS_PRICE_LABEL} ${formatPrice(a.priceAtAnalysis, a.currency)}`}
        </span>
      </article>
      <Icon name="chevron" className="mt-1 size-4 shrink-0 text-mute" />
    </Link>
  );
}

export function CrossCheckList({ expert }: { expert: boolean }) {
  const { data, isPending, isError, error, refetch } = useAnalyses({ limit: 20 });
  const rows = data?.results ?? [];
  return (
    <div>
      <p className="px-5 text-[13px] leading-snug text-mute">
        여러 AI가 각자 계획(사는·목표·손절 가격)을 내고 서로 검증해 최종 승인하는 과정이에요. 리포트와 별개 기능이에요.
      </p>
      {isPending ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : isError ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>아직 교차검증 분석이 없어요. 종목 화면의 "AI 교차검증 분석"으로 요청할 수 있어요.</EmptyState>
      ) : (
        <ul aria-label="교차검증 분석 목록" className="mt-2 divide-y divide-line">
          {rows.map((a) => (
            <li key={a.id}>
              <Row a={a} expert={expert} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
