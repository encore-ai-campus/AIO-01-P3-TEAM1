// /recommendations/:id: 머리 → 가격 사다리 → 지표 → 결론·근거·리스크 → 출처 링크 → 활성화 카드 (예산 → 리스크 미리 보기 → 계획 활성화).
// Discord 활성화 링크(?t=)로 들어오면 위에 띠를 보이고 활성화 요청에 token으로 넣는다 (via=discord).
import { useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useActivate } from "../api/autotrade";
import { ApiError, errorMessage } from "../api/client";
import { isPlanLive, useQuotes, useRecommendation, useRiskPreview } from "../api/queries";
import type { Recommendation } from "../api/types";
import { PlanStatusChip, RecStatusChip, RiskLevelBadge, SourceBadge } from "../components/autotrade/Badges";
import { PriceLadder } from "../components/autotrade/PriceLadder";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { Card, ErrorState, Notice, PageHeader, Row, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { SOURCE, parseBudget, timeLeft } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDateTime, formatKrw, formatPercent, formatPrice, formatQty, formatRate } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";

function Metric({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className="rounded-xl bg-fill p-3">
      <dt className="text-[12px] text-mute">{label}</dt>
      <dd className={cn("mt-0.5 text-[17px] font-bold tabular-nums", className)}>{value}</dd>
      {sub && <dd className="text-[11px] text-mute">{sub}</dd>}
    </div>
  );
}

function sourceLink(r: Recommendation): { to: string; label: string } | null {
  if (r.source === "report" && r.sourceId != null) return { to: `/reports/${r.sourceId}`, label: `AI 리포트 #${r.sourceId} 보기` };
  if (r.source === "analysis" && r.sourceId != null) return { to: `/analyses/${r.sourceId}`, label: `AI 분석 #${r.sourceId} 보기` };
  return null;
}

function ActivateCard({ r, token }: { r: Recommendation; token: string | null }) {
  const navigate = useNavigate();
  const toast = useToast();
  const [raw, setRaw] = useState("");
  const budget = parseBudget(raw);
  const debounced = useDebounced(budget.value, 400);
  const open = r.status === "open";
  const live = r.myPlan && isPlanLive(r.myPlan.status);
  const preview = useRiskPreview(r.id, debounced, open && !budget.error);
  const activate = useActivate(r.id);
  const pv = preview.data;
  const settling = debounced !== budget.value || preview.isFetching;
  const canActivate = open && !budget.error && !settling && pv?.activatable === true && !activate.isPending;

  return (
    <Card aria-labelledby="activate-title" className={cn(token && "ring-2 ring-brand")}>
      <h2 id="activate-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="bolt" className="size-5 text-brand" />
        계획 활성화
      </h2>
      <p className="mt-1 text-[13px] leading-snug text-mute">
        AI는 제안만 합니다. 수량과 활성화 가능 여부는 리스크 엔진(건당 위험 1%, 손익비·매수 가능 금액·한도)이 정합니다.
      </p>

      {r.myPlan && (
        <Link
          to={`/plans/${r.myPlan.id}`}
          className="mt-3 flex h-11 items-center justify-between gap-2 rounded-xl bg-brand-soft px-3.5 text-[15px] font-semibold text-brand-dark hover:bg-brand-soft/70"
        >
          <span className="flex items-center gap-2">
            내 계획 보기 <PlanStatusChip status={r.myPlan.status} />
          </span>
          <Icon name="chevron" className="size-4" />
        </Link>
      )}

      {!open ? (
        <Notice tone="warn" className="mt-3">
          유효 기한({formatDateTime(r.validUntil)})이 지나 활성화할 수 없습니다.
        </Notice>
      ) : (
        <>
          <div className="mt-4">
            <label htmlFor="budget" className="block text-[15px] font-semibold">
              예산 (원, 선택)
            </label>
            <input
              id="budget"
              inputMode="numeric"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder="비우면 리스크 엔진이 정한 수량"
              aria-describedby="budget-help"
              aria-invalid={budget.error ? true : undefined}
              className="mt-1.5 h-12 w-full rounded-xl bg-fill px-3.5 text-[16px] tabular-nums outline-none focus:ring-2 focus:ring-brand"
            />
            <p id="budget-help" className={cn("mt-1 text-[13px]", budget.error ? "text-up" : "text-mute")}>
              {budget.error ?? "예산을 주면 수량을 그만큼 줄입니다 (늘리지는 않습니다)."}
            </p>
          </div>

          <section aria-label="리스크 미리 보기" aria-busy={settling} className="mt-3 rounded-xl border border-line p-3.5">
            {preview.isError ? (
              <Notice tone="error">{errorMessage(preview.error)}</Notice>
            ) : !pv ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : (
              <div className={cn("transition-opacity", settling && "opacity-60")}>
                <p className="flex items-center gap-1.5 text-[14px] font-semibold">
                  <Icon name={pv.approved ? "check" : "ban"} className={cn("size-4", pv.approved ? "text-ok" : "text-up")} />
                  {pv.approved ? "리스크 엔진 통과" : "리스크 엔진 거절"}
                  {settling && <Spinner className="ml-auto text-mute" />}
                </p>
                <dl className="mt-2">
                  <Row label="수량">{formatQty(pv.quantity)}</Row>
                  <Row label="매수 금액">{formatKrw(pv.amountKrw)}</Row>
                  <Row label="목표 도달 시 이익">
                    <span className="text-up">+{formatKrw(pv.expectedProfitKrw)}</span>
                  </Row>
                  <Row label="손절 시 손실">
                    <span className="text-down">-{formatKrw(pv.maxLossKrw)}</span>
                  </Row>
                  <Row label="수량을 정한 제약">{pv.limitedBy}</Row>
                  {pv.lastPrice != null && <Row label="지금 가격">{formatPrice(pv.lastPrice, r.currency)}</Row>}
                </dl>
                {pv.reasons.length > 0 && (
                  <div role="alert" className="mt-2 rounded-lg bg-up-soft/70 p-3">
                    <p className="text-[13px] font-semibold text-up">활성화할 수 없는 사유</p>
                    <ul aria-label="활성화할 수 없는 사유" className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
                      {pv.reasons.map((x, i) => (
                        <li key={i}>{x}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </section>

          <button
            type="button"
            disabled={!canActivate}
            onClick={() =>
              activate.mutate(
                { ...(budget.value !== null ? { budgetKrw: budget.value } : {}), ...(token ? { token } : {}) },
                {
                  onSuccess: (plan) => {
                    toast(`${plan.name} 계획을 활성화했습니다. 진입 주문을 냈습니다.`);
                    navigate(`/plans/${plan.id}`);
                  },
                },
              )
            }
            className="mt-4 flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
          >
            {activate.isPending && <Spinner />}
            계획 활성화
          </button>
          {live && <p className="mt-2 text-[13px] text-mute">이미 이 종목에 진행 중인 내 계획이 있습니다.</p>}
          {activate.isError && (
            <Notice tone="error" className="mt-3">
              {errorMessage(activate.error)}
            </Notice>
          )}
        </>
      )}
    </Card>
  );
}

export function RecommendationPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t");
  const { data: r, isPending, isError, error, refetch } = useRecommendation(Number(id));
  const { data: quotes } = useQuotes(r ? [r.symbol] : []);
  const last = r ? (quotes?.get(r.symbol)?.price ?? null) : null;

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
        <PageHeader title="AI 추천" back />
        <Card>
          <ErrorState
            message={error instanceof ApiError && error.status === 404 ? "추천을 찾을 수 없습니다." : errorMessage(error)}
            onRetry={() => void refetch()}
          />
        </Card>
      </>
    );
  }

  const open = r.status === "open";
  const src = sourceLink(r);
  return (
    <>
      <PageHeader title={`${r.name} 추천`} back />
      {token && (
        <Notice className="mb-3">
          <b>Discord에서 연 활성화 링크</b> · 내용을 확인하고 &ldquo;계획 활성화&rdquo;를 누르면 내 모의 계좌에 계획이 만들어집니다 (Discord로 활성화한 것으로 기록).
        </Notice>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6">
        <div className="min-w-0 space-y-3">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[14px] text-mute">
                  {r.symbol} · {r.market === "KR" ? "국내" : "미국"} · 추천 #{r.id}
                </p>
                <p className="mt-0.5 text-[22px] font-bold tracking-tight">{r.name}</p>
              </div>
              <RecStatusChip open={open} className="h-7 px-2 text-[13px]" />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <SourceBadge source={r.source} />
              <RiskLevelBadge level={r.riskLevel} />
            </div>
            <p className="mt-2 text-[14px] text-sub">
              {r.requestedBy ? `${r.requestedBy} 신청` : "자동"} · {formatDateTime(r.createdAt)}
              {" · "}
              {open ? `${timeLeft(r.validUntil)} (${formatDateTime(r.validUntil)}까지)` : `${formatDateTime(r.validUntil)}에 만료`}
            </p>
            {r.source === "demo" && (
              <Notice tone="warn" className="mt-3">
                시연용 규칙 추천입니다 (AI 아님). {SOURCE.demo.hint}.
              </Notice>
            )}
            <div className="mt-5">
              <PriceLadder stop={r.stopPrice} entry={r.entryPrice} target={r.targetPrice} last={last} currency={r.currency} />
            </div>
          </Card>

          <Card aria-labelledby="metrics-title">
            <h2 id="metrics-title" className="mb-3 text-[17px] font-bold">
              지표
            </h2>
            <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="목표 수익률" value={formatRate(r.targetReturn)} className="text-up" sub="비용 전" />
              <Metric label="손절률" value={formatRate(r.stopLossRate)} className="text-down" sub="비용 전" />
              <Metric label="손익비" value={r.rewardRisk.toFixed(2)} sub="비용 반영" />
              <Metric label="목표 도달 확률" value={formatPercent(r.probability)} sub={r.probabilityAssumed ? "가정 (AI가 주지 않음)" : undefined} />
              <Metric label="기대수익률" value={formatRate(r.expectedReturn)} className={r.expectedReturn >= 0 ? "text-up" : "text-down"} sub="비용 반영" />
              <Metric label="보유 기간" value={`${r.holdingDays}거래일`} />
              <Metric label="신뢰도" value={r.confidence == null ? "-" : `${Math.round(r.confidence)}점`} sub={r.confidence == null ? "없음" : "0~100"} />
              <Metric label="추천 때 가격" value={formatPrice(r.priceAtCreation, r.currency)} />
            </dl>
          </Card>

          <Card aria-labelledby="summary-title">
            <h2 id="summary-title" className="text-[17px] font-bold">
              결론
            </h2>
            <p className="mt-1 text-[15px] leading-relaxed">{r.summary}</p>
            {r.reasons.length > 0 && (
              <div className="mt-3">
                <h3 className="text-[14px] font-semibold text-sub">근거</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[14px] leading-relaxed">
                  {r.reasons.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {r.risks.length > 0 && (
              <div className="mt-3">
                <h3 className="text-[14px] font-semibold text-sub">리스크</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[14px] leading-relaxed">
                  {r.risks.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {src && (
              <Link to={src.to} className="mt-4 flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line">
                {src.label}
                <Icon name="chevron" className="size-4" />
              </Link>
            )}
          </Card>
        </div>

        <div className="space-y-3 lg:sticky lg:top-8">
          <ActivateCard key={r.id} r={r} token={token} />
          <p className="px-1 text-[13px] text-mute">팀에서 이 추천으로 활성화한 계획 {r.planCount}건</p>
        </div>
      </div>
    </>
  );
}
