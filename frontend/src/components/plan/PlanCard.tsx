// 리포트의 매매 계획 카드 (docs/컨셉변경계획.md 4-5). 리포트 상세(F-report)가 <PlanCard report={...} variant="full"|"mini" view />로 쓴다.
//
// - 스스로 받는다: useRecommendations({ source: "report", sourceId: report.id, status: "all" })로 이 리포트의 추천을 찾고
//   (기한이 지난 것까지 — "기한 지남"을 보이려고), 열린 추천이면 useRiskPreview(추천 id, 예산 없음)로 "이 계좌로는 ○주 · ○○원"(장마감 기준)을 보인다.
// - 상태 (PlanCardState, 계산은 lib/autotrade.ts planCardState): 리포트가 아직 완성 전 · 지켜보기(hold) · 부정적(avoid) ·
//   계획 준비 중(buy인데 추천이 아직 없음, 완성 직후 10분) · 계획 없음(buy인데 가격 조건이 맞지 않아 추천이 없음) · 기한 지남 ·
//   실행 가능("실행 준비" → /recommendations/{id}) · 실행 불가(RiskPreview.reasonCodes → lib/plainText.ts reasonSentences).
//   "AI 의견: 긍정적"인데 실행할 수 없는 경우를 숨기지 않는다 — 안전장치가 다른 말을 하면 그 이유를 쉬운 말로 보인다.
// - variant "mini": 리포트 상세 위쪽 "계획 미니" — 손절 시 손실·목표 이익·"실행 준비" 한 줄. "full": 쉬운 보기의 매매 계획 카드.
// - view "expert": 같은 상태에 원래 용어(진입·목표·손절·손익비)와 사유 원문을 보인다.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useRecommendations, useRiskPreview } from "../../api/queries";
import type { Recommendation, ReportSummary, RiskPreview } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { kstDayOf, pickRecommendation, planCardState } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatDayLabel, formatKrw, formatPrice, formatQty } from "../../lib/format";
import { reasonSentences } from "../../lib/plainText";
import { Icon } from "../Icon";
import { AsOf, Skeleton, Spinner } from "../ui";

export type PlanCardState =
  | "not_completed" // 리포트가 아직 만드는 중이거나 실패
  | "watch" // AI 의견: 지켜보기
  | "negative" // AI 의견: 부정적
  | "preparing" // 긍정적 + 계획 준비 중
  | "no_plan" // 긍정적 + 계획 없음 (가격 조건이 맞지 않음)
  | "expired" // 기한 지남
  | "ready" // 실행 가능
  | "blocked"; // 실행 불가 (사유 코드 문장)

export interface PlanCardProps {
  /** 계획을 찾을 리포트 (ReportSummary·ReportDetail 그대로 넘겨도 된다). */
  report: Pick<ReportSummary, "id" | "symbol" | "name" | "market" | "status" | "opinion" | "finishedAt">;
  /** "full"(기본): 매매 계획 카드 · "mini": 계획 미니 한 줄. */
  variant?: "full" | "mini";
  /** 쉬운 보기·전문가 보기 (화면의 useViewMode().view). 기본 "easy". */
  view?: ViewMode;
  className?: string;
}

/** "계획 준비 중"이 "계획 없음"으로 바뀌는 때를 알도록 지금 시각을 30초마다 새로 둔다. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const STATE_TEXT: Record<Exclude<PlanCardState, "ready" | "blocked" | "expired">, string> = {
  not_completed: "리포트가 완성되면 이 계좌 기준의 매매 계획을 보여 드려요.",
  watch: "AI는 지금은 지켜보자는 의견이에요. 실행할 계획이 없어요.",
  negative: "AI는 위험이 더 크다고 봤어요. 실행할 계획을 만들지 않았어요.",
  preparing: "실행 계획을 준비하는 중이에요…",
  no_plan: "AI가 낸 가격 계획이 맞지 않아(손절 가격이 사는 가격보다 높음 등) 실행 계획을 만들지 않았어요.",
};

/** 미니 한 줄의 짧은 문구. */
const MINI_TEXT: Record<Exclude<PlanCardState, "ready" | "blocked" | "not_completed">, string> = {
  watch: "지켜보기 — 실행할 계획이 없어요",
  negative: "부정적 — 실행할 계획을 만들지 않았어요",
  preparing: "실행 계획을 준비하는 중이에요…",
  no_plan: "가격 조건이 맞지 않아 실행 계획이 없어요",
  expired: "계획의 기한이 끝났어요",
};

function expiredText(rec: Recommendation): string {
  return `이 계획은 ${formatDayLabel(kstDayOf(rec.validUntil))}에 기한이 끝났어요. 가격이 바뀌었을 수 있으니 새로 만들어 보세요.`;
}

const linkBtn = "inline-flex h-11 items-center justify-center gap-1 rounded-xl px-4 text-[15px] font-semibold";

export function PlanCard({ report, variant = "full", view = "easy", className }: PlanCardProps) {
  const easy = view === "easy";
  const completed = report.status === "completed";
  const recsQ = useRecommendations({ source: "report", sourceId: report.id, status: "all" }, completed);
  const rec = recsQ.data ? pickRecommendation(recsQ.data.results) : null;
  const previewQ = useRiskPreview(rec?.id ?? NaN, null, rec?.status === "open");
  const preview = rec && previewQ.data && !previewQ.isPlaceholderData ? previewQ.data : undefined;
  const now = useNow(completed && report.opinion === "buy" && !rec);
  const state = planCardState({ report, recs: recsQ.data?.results, preview, now });

  // 추천 목록을 받지 못하면(500·503) 끝없는 스켈레톤 대신 안내와 다시 시도
  if (completed && recsQ.isError && !recsQ.data) {
    const msg = easy ? "매매 계획을 불러오지 못했어요." : "매매 계획(추천)을 불러오지 못했습니다.";
    const retry = (
      <button
        type="button"
        onClick={() => void recsQ.refetch()}
        disabled={recsQ.isFetching}
        className={cn(linkBtn, "bg-fill text-ink hover:bg-line disabled:opacity-40")}
      >
        {recsQ.isFetching && <Spinner />}
        다시 시도
      </button>
    );
    return variant === "mini" ? (
      <div role="alert" aria-label="계획 미니" className={cn("flex items-center justify-between gap-2 rounded-xl bg-fill px-3.5 py-2 text-[14px] text-sub", className)}>
        {msg}
        {retry}
      </div>
    ) : (
      <section aria-label="매매 계획" data-state="error" className={cn("rounded-2xl bg-card p-5", className)}>
        <p role="alert" className="text-[15px] text-sub">
          {msg}
        </p>
        <div className="mt-3">{retry}</div>
      </section>
    );
  }
  if (rec?.status === "open" && previewQ.isError && !preview) {
    const msg = "이 계좌 기준 금액을 받지 못했어요. 잠시 뒤 다시 보여 드려요.";
    return variant === "mini" ? (
      <p className={cn("rounded-xl bg-fill px-3.5 py-2.5 text-[14px] text-sub", className)}>{msg}</p>
    ) : (
      <section aria-label="매매 계획" className={cn("rounded-2xl bg-card p-5", className)}>
        <p className="text-[15px] text-sub">{msg}</p>
        <Link to={`/recommendations/${rec.id}`} className={cn(linkBtn, "mt-3 bg-fill text-ink hover:bg-line")}>
          계획 자세히 보기
        </Link>
      </section>
    );
  }
  if (state === "loading") {
    return variant === "mini" ? (
      <Skeleton className={cn("h-10 w-full", className)} />
    ) : (
      <div className={cn("space-y-2 rounded-2xl bg-card p-5", className)} aria-busy="true" aria-label="매매 계획 불러오는 중">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  }
  if (variant === "mini") return <Mini state={state} rec={rec} preview={preview} easy={easy} className={className} />;

  return (
    <section aria-label="매매 계획" data-state={state} className={cn("rounded-2xl bg-card p-5", className)}>
      <h2 className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="flow" className="size-5 text-brand" />
        매매 계획
        <span className="text-[13px] font-medium text-mute">내 모의 계좌 기준</span>
      </h2>
      <div className="mt-3">
        {state === "ready" && rec && preview ? (
          <Ready rec={rec} preview={preview} easy={easy} />
        ) : state === "blocked" && rec && preview ? (
          <Blocked rec={rec} preview={preview} easy={easy} />
        ) : state === "expired" && rec ? (
          <>
            <p className="text-[15px] leading-relaxed">{expiredText(rec)}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Link to={`/stocks/${encodeURIComponent(report.symbol)}`} className={cn(linkBtn, "bg-fill text-ink hover:bg-line")}>
                새로 만들기
              </Link>
              {rec.myPlan && (
                <Link to={`/plans/${rec.myPlan.id}`} className={cn(linkBtn, "bg-fill text-ink hover:bg-line")}>
                  내 모의 자동매매 보기
                </Link>
              )}
            </div>
          </>
        ) : state === "watch" ? (
          <>
            <p className="text-[15px] leading-relaxed">{STATE_TEXT.watch}</p>
            <Link to={`/stocks/${encodeURIComponent(report.symbol)}`} className={cn(linkBtn, "mt-3 bg-fill text-ink hover:bg-line")}>
              며칠 뒤 다시 만들기
            </Link>
          </>
        ) : state === "preparing" ? (
          <p className="flex items-center gap-2 text-[15px] leading-relaxed" role="status">
            <Spinner className="text-brand" />
            {STATE_TEXT.preparing}
          </p>
        ) : (
          <p className="text-[15px] leading-relaxed">{STATE_TEXT[state as keyof typeof STATE_TEXT]}</p>
        )}
      </div>
    </section>
  );
}

function amounts(preview: RiskPreview) {
  return {
    gain: `+${formatKrw(preview.expectedProfitKrw)}`,
    loss: `-${formatKrw(preview.maxLossKrw)}`,
  };
}

function Ready({ rec, preview, easy }: { rec: Recommendation; preview: RiskPreview; easy: boolean }) {
  const a = amounts(preview);
  return (
    <>
      <p className="text-[16px] font-semibold tabular-nums">
        이 계좌로는 {formatQty(preview.quantity)} · {formatKrw(preview.amountKrw)}
      </p>
      <dl className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-up-soft/60 p-3">
          <dt className="text-[12px] text-sub">{easy ? "목표에 팔면" : "목표 도달 시 이익"}</dt>
          <dd className="text-[17px] font-bold text-up tabular-nums">{a.gain}</dd>
        </div>
        <div className="rounded-xl bg-down-soft/60 p-3">
          <dt className="text-[12px] text-sub">{easy ? "손절에 팔면" : "손절 시 손실"}</dt>
          <dd className="text-[17px] font-bold text-down tabular-nums">{a.loss}</dd>
        </div>
      </dl>
      <p className="mt-2 text-[13px] leading-snug text-sub">
        {easy ? (
          <>
            사는 가격 {formatPrice(rec.entryPrice, rec.currency)} · 목표 가격 {formatPrice(rec.targetPrice, rec.currency)} · 손절 가격{" "}
            {formatPrice(rec.stopPrice, rec.currency)}. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요.
          </>
        ) : (
          <>
            진입 {formatPrice(rec.entryPrice, rec.currency)} · 목표 {formatPrice(rec.targetPrice, rec.currency)} · 손절 {formatPrice(rec.stopPrice, rec.currency)} ·
            손익비 {rec.rewardRisk.toFixed(2)} · 수량 제약 {preview.limitedBy}
          </>
        )}
      </p>
      <AsOf at={preview.lastPriceAsOf} market={rec.market} className="mt-1 block" />
      <Link
        to={`/recommendations/${rec.id}`}
        className="mt-3 flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark"
      >
        실행 준비
        <Icon name="chevron" className="size-4" />
      </Link>
    </>
  );
}

function Blocked({ rec, preview, easy }: { rec: Recommendation; preview: RiskPreview; easy: boolean }) {
  const lines = easy ? reasonSentences(preview.reasonCodes, preview.reasons) : preview.reasons;
  const planLink = rec.myPlan && preview.reasonCodes.includes("plan_exists") ? rec.myPlan.id : null;
  return (
    <>
      <p className="text-[15px] font-semibold">{easy ? "지금은 이 계획을 실행할 수 없어요" : "활성화할 수 없음"}</p>
      <ul aria-label="실행할 수 없는 이유" className="mt-2 list-disc space-y-1 pl-5 text-[14px] leading-snug text-sub">
        {lines.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        {planLink !== null && (
          <Link to={`/plans/${planLink}`} className={cn(linkBtn, "bg-brand-soft text-brand-dark hover:bg-brand-soft/70")}>
            진행 중인 계획 보기
          </Link>
        )}
        <Link to={`/recommendations/${rec.id}`} className={cn(linkBtn, "bg-fill text-ink hover:bg-line")}>
          계획 자세히 보기
        </Link>
      </div>
    </>
  );
}

function Mini({
  state,
  rec,
  preview,
  easy,
  className,
}: {
  state: PlanCardState;
  rec: Recommendation | null;
  preview: RiskPreview | undefined;
  easy: boolean;
  className?: string;
}) {
  if (state === "not_completed") return null;
  const box = cn("flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-fill px-3.5 py-2.5 text-[14px]", className);
  if (state === "ready" && rec && preview) {
    const a = amounts(preview);
    return (
      <div aria-label="계획 미니" data-state={state} className={box}>
        <span className="tabular-nums">
          {easy ? "손절 시" : "손절 시 손실"} <b className="text-down">{a.loss}</b>
        </span>
        <span className="tabular-nums">
          {easy ? "목표 시" : "목표 시 이익"} <b className="text-up">{a.gain}</b>
        </span>
        <Link to={`/recommendations/${rec.id}`} className="ml-auto flex h-9 items-center rounded-lg bg-brand px-3 text-[14px] font-bold text-white hover:bg-brand-dark">
          실행 준비
        </Link>
      </div>
    );
  }
  if (state === "blocked" && rec && preview) {
    const first = (easy ? reasonSentences(preview.reasonCodes, preview.reasons) : preview.reasons)[0] ?? "";
    return (
      <div aria-label="계획 미니" data-state={state} className={box}>
        <span className="min-w-0 flex-1">
          <b>실행할 수 없어요</b> · {first}
        </span>
        <Link to={`/recommendations/${rec.id}`} className="text-[14px] font-semibold text-brand">
          자세히
        </Link>
      </div>
    );
  }
  return (
    <div aria-label="계획 미니" data-state={state} className={box}>
      {state === "preparing" && <Spinner className="text-brand" />}
      <span>{MINI_TEXT[state as keyof typeof MINI_TEXT]}</span>
    </div>
  );
}
