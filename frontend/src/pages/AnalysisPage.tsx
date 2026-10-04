// /analyses/:id AI 교차검증 분석 상세 (docs/DECISIONS.md 13-1 D-1): 여러 AI가 각자 계획을 내고 서로 검증해 최종 승인하는 과정을 두 모드 모두에서 보인다.
// 쉬운 보기: "AI 세 곳이 각자 계획을 내고 서로 검증했어요 · 통과 n · 최종 승인 ○○" + 제안 AI별 카드(사는·목표·손절 가격, 통과/탈락) — 점수·확률 없이.
// 전문가 보기: 시나리오 카드에 점수·확률·탈락 사유.
// 가격: 위쪽은 직전 장마감 종가(AsOf), 분석의 가격은 "분석 시각 가격"(장중이었으면 "장중 가격"이라고 밝힌다 — 일부러 둔 예외).
// 뉴스는 제목·매체·게시 시각과 출처 표기(newsProvider), 지표·일봉 자료의 기준일(dataAsOf).
import { Link, useParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useAnalysis, useQuotes } from "../api/queries";
import type { AnalysisDetail, Currency, NewsItem, Scenario } from "../api/types";
import { SourceRecommendations } from "../components/autotrade/SourceRecommendations";
import { AsOf, Card, ErrorState, Flash, PageHeader, PriceChange, Skeleton, SkeletonCard, VerdictBadge } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { crossCheckSummary, duringSession } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDate, formatDateTime, formatDayLabel, formatPercent, formatPrice, formatRate, formatRequester, formatUsd } from "../lib/format";
import { ANALYSIS_PRICE_LABEL } from "../lib/plainText";

const DIRECTION: Record<string, { label: string; cls: string }> = {
  positive: { label: "긍정", cls: "bg-up-soft text-up" },
  bullish: { label: "긍정", cls: "bg-up-soft text-up" },
  up: { label: "긍정", cls: "bg-up-soft text-up" },
  negative: { label: "부정", cls: "bg-down-soft text-down" },
  bearish: { label: "부정", cls: "bg-down-soft text-down" },
  down: { label: "부정", cls: "bg-down-soft text-down" },
};

function PassChip({ s }: { s: Scenario }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[12px] font-bold",
        s.passed === true && "bg-brand-soft text-brand-dark",
        s.passed !== true && "bg-fill text-mute",
      )}
    >
      {s.passed === true ? "통과" : s.passed === false ? "탈락" : "판정 없음"}
    </span>
  );
}

function ScenarioCard({ s, currency, easy }: { s: Scenario; currency: Currency; easy: boolean }) {
  const pct = (p: number) => formatRate(p / s.entryPrice - 1, 1);
  return (
    <Card as="article" aria-label={`${s.proposer} 계획`} className={cn(s.selected && "ring-2 ring-brand")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[16px] font-bold">{s.proposer}</h3>
        {s.selected && <span className="rounded-md bg-brand px-1.5 py-0.5 text-[12px] font-bold text-white">최종 승인</span>}
        <PassChip s={s} />
        {!easy && (
          <span className="ml-auto text-[14px] text-sub tabular-nums">
            점수 <b className="text-ink">{s.score ?? "-"}</b> · 확률 <b className="text-ink">{formatPercent(s.probability)}</b>
          </span>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-fill p-3 text-center">
        <div>
          <dt className="text-[12px] text-mute">{easy ? "사는 가격" : "진입"}</dt>
          <dd className="text-[14px] font-semibold tabular-nums">{formatPrice(s.entryPrice, currency)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">{easy ? "목표 가격" : "목표"}</dt>
          <dd className="text-[14px] font-semibold tabular-nums text-up">{formatPrice(s.targetPrice, currency)}</dd>
          <dd className="text-[11px] text-up tabular-nums">{pct(s.targetPrice)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">{easy ? "손절 가격" : "손절"}</dt>
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
          <span className="font-semibold text-sub">{easy ? "이 계획이 틀렸다고 볼 때 " : "무효 조건 "}</span>
          {s.invalidation}
        </p>
      )}
      {s.rejectReasons.length > 0 && (
        <div className="mt-3 rounded-xl bg-up-soft/60 p-3">
          <h4 className="text-[13px] font-semibold text-up">{easy ? "떨어진 이유" : "탈락 사유"}</h4>
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

/** 교차검증 과정 한눈에: 쉬운 문장 + 제안 AI별 통과/탈락 (점수 없이). */
function Process({ a }: { a: AnalysisDetail }) {
  const c = crossCheckSummary(a.scenarios);
  return (
    <Card aria-labelledby="process-title">
      <h2 id="process-title" className="text-[17px] font-bold">
        교차검증 과정
      </h2>
      <p className="mt-1 text-[15px] leading-relaxed">{c.sentence}</p>
      {a.scenarios.length > 0 && (
        <ol aria-label="제안 AI" className="mt-3 flex flex-wrap gap-2">
          {a.scenarios.map((s, i) => (
            <li key={`${s.proposer}-${i}`} className="flex items-center gap-1.5 rounded-xl bg-fill px-3 py-2 text-[14px]">
              <b>{s.proposer}</b>
              <span className="text-mute">→</span>
              <span className={s.passed === true ? "text-brand-dark" : "text-mute"}>{s.passed === true ? "통과" : s.passed === false ? "탈락" : "판정 없음"}</span>
              {s.selected && <span className="rounded-md bg-brand px-1.5 py-0.5 text-[12px] font-bold text-white">최종 승인</span>}
            </li>
          ))}
        </ol>
      )}
      <p className="mt-2 text-[13px] text-mute">AI 계획은 참고 자료예요. 수량과 실행 여부는 안전장치가 정하고, 매매는 모의 계좌에서만 해요.</p>
    </Card>
  );
}

function News({ a }: { a: AnalysisDetail }) {
  const items: NewsItem[] = a.newsItems?.length ? a.newsItems : a.news.map((title) => ({ title, source: null, publishedAt: null }));
  return (
    <Card aria-labelledby="news-title">
      <h2 id="news-title" className="text-[17px] font-bold">
        뉴스
      </h2>
      {items.length === 0 ? (
        <p className="mt-2 text-[14px] text-mute">수집한 뉴스가 없습니다.</p>
      ) : (
        <ul aria-label="뉴스 목록" className="mt-2 space-y-2 text-[14px] leading-snug">
          {items.map((n, i) => (
            <li key={i} className="border-b border-line pb-2 last:border-0 last:pb-0">
              {n.title}
              {(n.source || n.publishedAt) && (
                <span className="block text-[12px] text-mute">{[n.source, n.publishedAt && formatDateTime(n.publishedAt)].filter(Boolean).join(" · ")}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[12px] text-mute">출처: {a.newsProvider || "Google 뉴스 검색 결과"} (각 언론사). 제목만 보여요.</p>
    </Card>
  );
}

export function AnalysisPage() {
  const { id } = useParams();
  const { easy } = useViewMode();
  const { data: a, isPending, isError, error, refetch } = useAnalysis(Number(id));
  const { data: quotes, isPending: quotePending } = useQuotes(a ? [a.symbol] : []);
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
        <PageHeader title="AI 교차검증 분석" back />
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
  const intraday = duringSession(a.analyzedAt, a.market);

  return (
    <>
      <PageHeader title={`${a.name} AI 교차검증 분석`} back />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-3">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[14px] text-mute">
                  {a.symbol} · {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)} 요청
                </p>
                {quote?.price != null ? (
                  <>
                    <p className="mt-1 flex items-baseline gap-2">
                      <span className="text-[14px] font-semibold text-sub">종가</span>
                      <span className="text-[26px] font-bold tabular-nums">
                        <Flash value={quote.price}>{formatPrice(quote.price, a.currency)}</Flash>
                      </span>
                    </p>
                    <PriceChange change={quote.change} rate={quote.changeRate} currency={a.currency} className="text-[14px] font-semibold" />
                    <AsOf at={quote.asOf} market={a.market} className="block" />
                  </>
                ) : quotePending ? (
                  <Skeleton className="mt-2 h-8 w-40" />
                ) : (
                  // 종가를 받지 못했을 때: 분석 시각 가격임을 밝힌다 (장마감 종가로 읽히지 않게)
                  <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                    <span className="text-[14px] font-semibold text-sub">
                      {ANALYSIS_PRICE_LABEL}
                      {intraday ? "(장중 가격)" : ""}
                    </span>
                    <span className="text-[26px] font-bold tabular-nums">{formatPrice(a.priceAtAnalysis, a.currency)}</span>
                  </p>
                )}
              </div>
              {easy ? (
                <span
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center rounded-md px-3 text-[14px] font-bold",
                    a.verdict === "BUY" ? "bg-brand-soft text-brand-dark" : "bg-fill text-mute",
                  )}
                >
                  {a.verdict === "BUY" ? "통과한 계획 있음" : "통과한 계획 없음"}
                </span>
              ) : (
                <VerdictBadge verdict={a.verdict} className="h-8 px-3 text-[15px]" />
              )}
            </div>
            <p className="mt-3 text-[14px] text-sub">
              {a.verdict === "BUY"
                ? easy
                  ? "검증·안전장치·최종 승인을 모두 통과한 계획이 있어요."
                  : "교차검증·리스크 엔진·최종 승인을 통과한 시나리오가 있습니다."
                : easy
                  ? "최종 승인까지 통과한 계획이 없어요."
                  : "최종 승인까지 통과한 시나리오가 없습니다."}
            </p>
            <p className="mt-1 text-[13px] text-mute">
              {ANALYSIS_PRICE_LABEL}
              {intraday ? "(장중 가격)" : ""} {formatPrice(a.priceAtAnalysis, a.currency)}
              {a.dataAsOf && ` · 지표·일봉 자료 기준일 ${formatDayLabel(a.dataAsOf)}`}
              {!easy && a.costUsd != null && ` · 비용 ${formatUsd(a.costUsd)}`}
            </p>
            {easy ? (
              <Link
                to={`/stocks/${encodeURIComponent(a.symbol)}`}
                className="mt-4 flex h-12 items-center justify-center rounded-xl bg-fill text-[16px] font-bold text-ink hover:bg-line"
              >
                종목 화면으로
              </Link>
            ) : (
              <Link
                to={`/stocks/${encodeURIComponent(a.symbol)}?analysis=${a.id}`}
                className="mt-4 flex h-12 items-center justify-center rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark"
              >
                이 종목 주문하기
              </Link>
            )}
          </Card>

          <Process a={a} />

          <SourceRecommendations source="analysis" sourceId={a.id} />

          <h2 className="px-1 pt-2 text-[17px] font-bold">{easy ? `AI별 계획 ${a.scenarioCount}개` : `시나리오 ${a.scenarioCount}개`}</h2>
          {scenarios.length === 0 ? (
            <Card>
              <p className="text-[14px] text-mute">{easy ? "조건에 맞는 계획이 없었어요." : "조건에 맞는 시나리오가 없었습니다."}</p>
            </Card>
          ) : (
            scenarios.map((s, i) => <ScenarioCard key={`${s.proposer}-${i}`} s={s} currency={a.currency} easy={easy} />)
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
          <News a={a} />

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
              {a.dataAsOf && <p className="text-[12px] text-mute">{formatDayLabel(a.dataAsOf)} 일봉까지의 자료</p>}
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
