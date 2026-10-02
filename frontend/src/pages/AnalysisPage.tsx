import { Link, useParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useAnalysis, useQuotes } from "../api/queries";
import type { Currency, Scenario } from "../api/types";
import { Card, ErrorState, Flash, PageHeader, PriceChange, Skeleton, SkeletonCard, VerdictBadge } from "../components/ui";
import { cn } from "../lib/cn";
import { formatDate, formatDateTime, formatPercent, formatPrice, formatRate, formatRequester, formatUsd } from "../lib/format";

const DIRECTION: Record<string, { label: string; cls: string }> = {
  positive: { label: "긍정", cls: "bg-up-soft text-up" },
  bullish: { label: "긍정", cls: "bg-up-soft text-up" },
  up: { label: "긍정", cls: "bg-up-soft text-up" },
  negative: { label: "부정", cls: "bg-down-soft text-down" },
  bearish: { label: "부정", cls: "bg-down-soft text-down" },
  down: { label: "부정", cls: "bg-down-soft text-down" },
};

function ScenarioCard({ s, currency }: { s: Scenario; currency: Currency }) {
  const pct = (p: number) => formatRate(p / s.entryPrice - 1, 1);
  return (
    <Card as="article" className={cn(s.selected && "ring-2 ring-brand")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[16px] font-bold">{s.proposer}</h3>
        {s.selected && <span className="rounded-md bg-brand px-1.5 py-0.5 text-[12px] font-bold text-white">최종 승인</span>}
        <span
          className={cn(
            "rounded-md px-1.5 py-0.5 text-[12px] font-bold",
            s.passed === true && "bg-brand-soft text-brand-dark",
            s.passed === false && "bg-fill text-mute",
            s.passed === null && "bg-fill text-mute",
          )}
        >
          {s.passed === true ? "통과" : s.passed === false ? "탈락" : "판정 없음"}
        </span>
        <span className="ml-auto text-[14px] text-sub tabular-nums">
          점수 <b className="text-ink">{s.score ?? "-"}</b> · 확률 <b className="text-ink">{formatPercent(s.probability)}</b>
        </span>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-fill p-3 text-center">
        <div>
          <dt className="text-[12px] text-mute">진입</dt>
          <dd className="text-[14px] font-semibold tabular-nums">{formatPrice(s.entryPrice, currency)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">목표</dt>
          <dd className="text-[14px] font-semibold tabular-nums text-up">{formatPrice(s.targetPrice, currency)}</dd>
          <dd className="text-[11px] text-up tabular-nums">{pct(s.targetPrice)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">손절</dt>
          <dd className="text-[14px] font-semibold tabular-nums text-down">{formatPrice(s.stopPrice, currency)}</dd>
          <dd className="text-[11px] text-down tabular-nums">{pct(s.stopPrice)}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[13px] text-mute">보유 기간 {s.holdingDays}일</p>
      {s.rationale.length > 0 && (
        <div className="mt-3">
          <h4 className="text-[14px] font-semibold text-sub">근거</h4>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-[14px] leading-relaxed">
            {s.rationale.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
      {s.invalidation && (
        <p className="mt-3 text-[14px]">
          <span className="font-semibold text-sub">무효 조건 </span>
          {s.invalidation}
        </p>
      )}
      {s.rejectReasons.length > 0 && (
        <div className="mt-3 rounded-xl bg-up-soft/60 p-3">
          <h4 className="text-[13px] font-semibold text-up">탈락 사유</h4>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
            {s.rejectReasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

export function AnalysisPage() {
  const { id } = useParams();
  const { data: a, isPending, isError, error, refetch } = useAnalysis(Number(id));
  const { data: quotes } = useQuotes(a ? [a.symbol] : []);
  const quote = a ? quotes?.get(a.symbol) : undefined;

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
        <PageHeader title="AI 분석" back />
        <Card>
          <ErrorState
            message={error instanceof ApiError && error.status === 404 ? "분석을 찾을 수 없습니다." : errorMessage(error)}
            onRetry={() => void refetch()}
          />
        </Card>
      </>
    );
  }

  const scenarios = [...a.scenarios].sort((x, y) => Number(y.selected) - Number(x.selected) || (y.score ?? 0) - (x.score ?? 0));
  const indicators = Object.entries(a.indicators);

  return (
    <>
      <PageHeader title={`${a.name} AI 분석`} back />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-3">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[14px] text-mute">
                  {a.symbol} · {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)} 요청
                </p>
                <p className="mt-1 text-[26px] font-bold tabular-nums">
                  <Flash value={quote?.price}>{formatPrice(quote?.price ?? a.priceAtAnalysis, a.currency)}</Flash>
                </p>
                {quote && <PriceChange change={quote.change} rate={quote.changeRate} currency={a.currency} className="text-[14px] font-semibold" />}
              </div>
              <VerdictBadge verdict={a.verdict} className="h-8 px-3 text-[15px]" />
            </div>
            <p className="mt-3 text-[14px] text-sub">
              {a.verdict === "BUY"
                ? "교차검증·리스크 엔진·최종 승인을 통과한 시나리오가 있습니다."
                : "최종 승인까지 통과한 시나리오가 없습니다."}{" "}
              분석 시점 가격 {formatPrice(a.priceAtAnalysis, a.currency)}
              {a.costUsd != null && ` · 비용 ${formatUsd(a.costUsd)}`}
            </p>
            <Link
              to={`/stocks/${encodeURIComponent(a.symbol)}?analysis=${a.id}`}
              className="mt-4 flex h-12 items-center justify-center rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark"
            >
              이 종목 주문하기
            </Link>
          </Card>

          <h2 className="px-1 pt-2 text-[17px] font-bold">시나리오 {a.scenarioCount}개</h2>
          {scenarios.length === 0 ? (
            <Card>
              <p className="text-[14px] text-mute">조건에 맞는 시나리오가 없었습니다.</p>
            </Card>
          ) : (
            scenarios.map((s, i) => <ScenarioCard key={`${s.proposer}-${i}`} s={s} currency={a.currency} />)
          )}

          {a.errors.length > 0 && (
            <Card aria-label="오류">
              <h2 className="text-[15px] font-semibold text-up">분석 중 오류</h2>
              <ul className="mt-1 list-disc pl-5 text-[14px] text-sub">
                {a.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </Card>
          )}
        </div>

        <div className="space-y-3">
          <Card aria-labelledby="news-title">
            <h2 id="news-title" className="text-[17px] font-bold">
              뉴스
            </h2>
            {a.news.length === 0 ? (
              <p className="mt-2 text-[14px] text-mute">수집한 뉴스가 없습니다.</p>
            ) : (
              <ul className="mt-2 space-y-2 text-[14px] leading-snug">
                {a.news.map((n, i) => (
                  <li key={i} className="border-b border-line pb-2 last:border-0 last:pb-0">
                    {n}
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card aria-labelledby="research-title">
            <h2 id="research-title" className="text-[17px] font-bold">
              웹 조사
            </h2>
            {a.research.length === 0 && <p className="mt-2 text-[14px] text-mute">조사 결과가 없습니다.</p>}
            {a.research.map((r, i) => (
              <div key={`${r.researcher}-${i}`} className="mt-3">
                <h3 className="text-[14px] font-semibold text-sub">{r.researcher}</h3>
                <ul className="mt-1 space-y-2">
                  {r.findings.map((f, j) => {
                    const dir = f.direction ? DIRECTION[f.direction.toLowerCase()] : undefined;
                    return (
                      <li key={j} className="text-[14px] leading-snug">
                        {f.direction && (
                          <span className={cn("mr-1.5 rounded px-1 py-0.5 text-[11px] font-bold", dir?.cls ?? "bg-fill text-sub")}>
                            {dir?.label ?? f.direction}
                          </span>
                        )}
                        {f.claim}
                        {(f.sourceTitle || f.date) && (
                          <span className="block text-[12px] text-mute">
                            {[f.sourceTitle, f.date && formatDate(f.date)].filter(Boolean).join(" · ")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </Card>

          {indicators.length > 0 && (
            <Card aria-labelledby="ind-title">
              <h2 id="ind-title" className="text-[17px] font-bold">
                지표
              </h2>
              <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[14px]">
                {indicators.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-2">
                    <dt className="truncate text-mute">{k}</dt>
                    <dd className="font-medium tabular-nums">{v === null ? "-" : typeof v === "number" ? v.toLocaleString("ko-KR") : v}</dd>
                  </div>
                ))}
              </dl>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
