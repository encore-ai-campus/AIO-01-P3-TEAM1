// 리포트의 매매 계획 카드 (docs/plans/컨셉변경계획.md 4-5). 리포트 상세(F-report)가 <PlanCard report={...} variant="full"|"mini" view />로 쓴다.
//
// - 자료와 상태는 api/reports.ts usePlanCardData: 이 리포트의 추천(기한이 지난 것까지 — "기한 지남"을 보이려고)과,
//   열린 추천이면 리스크 미리 보기(넣을 돈 없음 — 시작할 수 있는지만). 쉬운 보기의 단계 막대·안내 문장도 같은 훅이라 서로 다른 말을 하지 않는다.
//   넣을 돈은 실행 확인에서 사용자가 정하므로(2026-10-11 DECISIONS 28장) 여기서는 계좌 금액 대신 계획의 목표·손절 비율(1주 기준, 비용 전 —
//   '세 가지 경우'의 1주 기준 칸과 같은 말)을 보인다.
// - 상태 (PlanCardState, 계산은 lib/autotrade.ts planCardState): 리포트가 아직 완성 전 · 지켜보기(hold) · 부정적(avoid) ·
//   계획 준비 중(buy인데 추천이 아직 없음, 완성 직후 10분) · 계획 없음(buy인데 가격 조건이 맞지 않아 추천이 없음) · 기한 지남 ·
//   실행 가능("실행 준비" → /recommendations/{id}) · 실행 불가(RiskPreview.reasonCodes → lib/plainText.ts reasonSentences).
//   실행 불가가 손익비·기대값만이면 사유 아래에 시연용 수동매매 → /recommendations/{id}?manual=1 (DECISIONS 31장 — 경고색 상자, "시연용"을 밝힌다).
//   "AI 의견: 긍정적"인데 실행할 수 없는 경우를 숨기지 않는다 — 안전장치가 다른 말을 하면 그 이유를 쉬운 말로 보인다.
// - variant "mini": 리포트 상세 위쪽 "계획 미니" — 손절 시 손실·목표 이익·"실행 준비" 한 줄. "full": 쉬운 보기의 매매 계획 카드.
// - view "expert": 같은 상태에 원래 용어(진입·목표·손절·손익비)와 사유 원문을 보인다.
// - 지켜보기는 막다른 길이 되지 않게 다음 행동을 준다 (UX-8): 다른 종목으로 리포트 만들기(/search) ·
//   시작할 수 있는 계획 제안 보기(/recommendations, 시작할 수 있는 제안 수 — Recommendation.blockedBy와 내 진행 중 계획으로 센다, 0개면 숨김) · 며칠 뒤 다시 만들기.
//   "실행할 계획이 없어요"는 쉬운 보기에서 이 카드 한 곳만 말한다 (머리 안내·결론 카드의 계획 미니는 이 상태에서 비킨다 — lib/reports.ts planGuide·showPlanMini).
// - 불러온 뒤에는 한 번 페이드로 나타난다 (캐시로 바로 그리면 움직이지 않는다). 스켈레톤은 실제 카드와 비슷한 높이.
import { Link, useNavigate } from "react-router";
import { isPlanLive, useRecommendations } from "../../api/queries";
import { usePlanCardData } from "../../api/reports";
import type { Recommendation, ReportSummary, RiskPreview } from "../../api/types";
import { useRevealAfterLoading } from "../../hooks/useMotionState";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { canStartManually, isRecBlocked, kstDayOf, manualStartPath } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatDayLabel, formatPrice, formatRate } from "../../lib/format";
import { prefersReducedMotion } from "../../lib/motion";
import { MANUAL_START_TEXT, priceExpiredText, reasonSentences } from "../../lib/plainText";
import { Icon } from "../Icon";
import { LiveDot, Skeleton, Spinner } from "../ui";

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
  /** full 카드의 id (같은 화면의 계획 미니 '자세히'가 이 카드로 내려온다). */
  id?: string;
  className?: string;
}

/** 같은 화면의 매매 계획 카드 id (계획 미니의 '자세히'가 여기로 스크롤한다). */
export const PLAN_CARD_ID = "plan";

// watch·negative·no_plan과 Ready의 쉬운 가격 줄(사는 가격 … 손실이 더 클 수도 있어요)은
// 쉬운 PDF(backend/reports/output/easy_text.py PLAN_TEXT)도 같은 문장을 쓴다 — 바꾸면 둘 다 고친다
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

/** 끝난 계획 제안의 문장: 가격이 이미 손절가·목표가를 지나 끝났으면 그 까닭(DECISIONS 25장), 아니면 기한. */
function expiredText(rec: Recommendation, easy: boolean): string {
  const price = priceExpiredText(rec.expiredReason, easy);
  if (price) return easy ? `${price}. 가격이 바뀌었으니 새로 만들어 보세요.` : `${price}.`;
  return `이 계획은 ${formatDayLabel(kstDayOf(rec.validUntil))}에 기한이 끝났어요. 가격이 바뀌었을 수 있으니 새로 만들어 보세요.`;
}

// 누름 피드백(press)과 44px 높이. 보조 버튼은 fill 바탕
const linkBtn = "press inline-flex h-11 items-center justify-center gap-1 rounded-xl px-4 text-[15px] font-semibold";

export function PlanCard({ report, variant = "full", view = "easy", id, className }: PlanCardProps) {
  const easy = view === "easy";
  const completed = report.status === "completed";
  const { state, rec, preview, recsQ, previewQ } = usePlanCardData(report);
  // 기다린 끝에 내용이 왔을 때만 페이드 (early return보다 앞에서 부른다)
  const reveal = useRevealAfterLoading(state === "loading");
  const fade = reveal ? "reveal-fade" : undefined;

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
      <section id={id} aria-label="매매 계획" data-state="error" className={cn("rounded-2xl bg-card p-5", className)}>
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
      <section id={id} aria-label="매매 계획" className={cn("rounded-2xl bg-card p-5", className)}>
        <p className="text-[15px] text-sub">{msg}</p>
        <Link to={`/recommendations/${rec.id}`} className={cn(linkBtn, "mt-3 bg-fill text-ink hover:bg-line")}>
          계획 자세히 보기
        </Link>
      </section>
    );
  }
  if (state === "loading") {
    // 실제 모양과 높이에 가깝게 (내용이 오면 결론 카드가 늦게 늘어나지 않게)
    return variant === "mini" ? (
      <Skeleton className={cn("h-16 w-full rounded-xl", className)} />
    ) : (
      <div id={id} className={cn("space-y-3 rounded-2xl bg-card p-5", className)} aria-busy="true" aria-label="매매 계획 불러오는 중">
        <Skeleton className="h-5 w-1/3" />
        <Skeleton className="h-5 w-2/3" />
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
        <Skeleton className="h-12 w-full rounded-xl" />
      </div>
    );
  }
  if (variant === "mini") return <Mini state={state} rec={rec} preview={preview} easy={easy} className={cn(fade, className)} />;

  return (
    // tabIndex -1: 계획 미니의 '자세히'가 이 카드로 포커스를 옮긴다 (키보드로 왔을 때만 테두리가 보인다)
    <section id={id} aria-label="매매 계획" data-state={state} className={cn("scroll-mt-20 rounded-2xl bg-card p-5", fade, className)} tabIndex={-1}>
      <h2 className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="flow" className="size-5 text-brand" />
        매매 계획
        <span className="text-[13px] font-medium text-mute">내 모의 계좌 기준</span>
      </h2>
      <div className="mt-3">
        {state === "ready" && rec && preview ? (
          <Ready rec={rec} easy={easy} />
        ) : state === "blocked" && rec && preview ? (
          <Blocked rec={rec} preview={preview} easy={easy} />
        ) : state === "expired" && rec ? (
          <>
            <p className="text-[15px] leading-relaxed">{expiredText(rec, easy)}</p>
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
            <WatchActions symbol={report.symbol} />
          </>
        ) : state === "preparing" ? (
          // 완성 뒤 최대 10분 이어지는 '준비 중'이라 도는 아이콘 대신 살아 있음 점.
          // role=status는 두지 않는다 — 앱의 status 영역은 토스트 하나다 (계획이 생기면 카드가 바뀌어 보인다)
          <p className="flex items-center gap-2 text-[15px] leading-relaxed">
            <LiveDot />
            {STATE_TEXT.preparing}
          </p>
        ) : (
          <p className="text-[15px] leading-relaxed">{STATE_TEXT[state as keyof typeof STATE_TEXT]}</p>
        )}
      </div>
    </section>
  );
}

/**
 * 지켜보기 리포트의 다음 행동 (UX-8). 시작할 수 있는 계획 제안 수: 열린 추천 중 계좌와 무관한 막힘(blockedBy)이 없고
 * 내가 진행 중인 계획이 없는 것 (최종 판단은 제안 화면의 리스크 미리 보기). 모를 때(받는 중·오류)는 수 없이, 0개면 버튼을 숨긴다.
 * 목록 키는 계획 제안 화면·모의투자 탭과 같다 (캐시를 같이 쓴다).
 */
function WatchActions({ symbol }: { symbol: string }) {
  const open = useRecommendations({ status: "open" });
  const startable = open.data ? open.data.results.filter((r) => !isRecBlocked(r) && !(r.myPlan && isPlanLive(r.myPlan.status))).length : null;
  return (
    <div className="mt-3 flex flex-wrap gap-2">
      <Link to="/search" className={cn(linkBtn, "bg-brand-soft text-brand-ink hover:bg-line")}>
        다른 종목으로 리포트 만들기
      </Link>
      {startable !== 0 && (
        <Link to="/recommendations" className={cn(linkBtn, "bg-fill text-ink hover:bg-line")}>
          {startable === null ? "시작할 수 있는 계획 제안 보기" : `시작할 수 있는 계획 제안 ${startable}개 보기`}
        </Link>
      )}
      <Link to={`/stocks/${encodeURIComponent(symbol)}`} className={cn(linkBtn, "bg-fill text-ink hover:bg-line")}>
        며칠 뒤 다시 만들기
      </Link>
    </div>
  );
}

/** 계획의 목표·손절 비율 (1주 기준, 비용 전 — lib/reports.ts scenarioOf의 1주 기준 칸과 같은 계산). 넣을 돈은 실행 확인에서 정한다. */
function rates(rec: Recommendation) {
  return { gain: formatRate(rec.targetReturn), loss: formatRate(rec.stopLossRate) };
}

function Ready({ rec, easy }: { rec: Recommendation; easy: boolean }) {
  const a = rates(rec);
  return (
    <>
      <p className="text-[16px] font-semibold">{easy ? "넣을 돈은 실행 확인에서 정해요" : "투자 금액은 활성화 화면에서 정합니다"}</p>
      <p className="mt-0.5 text-[13px] text-sub">1주 기준 비율 · 수수료·세금 빼기 전</p>
      {/* 이익·손실 상자는 세 가지 경우(ScenarioBoxes)와 같은 바탕 */}
      <dl className="mt-2 grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-up-soft p-3">
          <dt className="text-[12px] text-sub">{easy ? "목표에 팔면" : "목표 도달 시 이익"}</dt>
          <dd className="text-[17px] font-bold text-up tabular-nums">{a.gain}</dd>
        </div>
        <div className="rounded-xl bg-down-soft p-3">
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
            손익비 {rec.rewardRisk.toFixed(2)}
          </>
        )}
      </p>
      <Link
        to={`/recommendations/${rec.id}`}
        className="press mt-3 flex h-12 w-full items-center justify-center gap-1.5 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark"
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
  const manual = canStartManually(preview); // 손익비·기대값으로만 막혔을 때만 (다른 사유가 섞이면 숨긴다)
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
          <Link to={`/plans/${planLink}`} className={cn(linkBtn, "bg-brand-soft text-brand-ink hover:bg-line")}>
            진행 중인 계획 보기
          </Link>
        )}
        <Link to={`/recommendations/${rec.id}`} className={cn(linkBtn, "bg-fill text-ink hover:bg-line")}>
          계획 자세히 보기
        </Link>
      </div>
      {manual && <ManualStartOffer recId={rec.id} easy={easy} />}
    </>
  );
}

/** 시연용 수동 시작 (DECISIONS 31장): 손익비·기대값으로만 막힌 계획을 실행 확인(?manual=1)에서 직접 시작하는 길. */
function ManualStartOffer({ recId, easy }: { recId: number; easy: boolean }) {
  return (
    <div className="mt-3 rounded-xl bg-warn-soft p-3">
      <p className="flex items-start gap-1.5 text-[13px] leading-snug text-warn-ink">
        <Icon name="alert" className="mt-px size-4 shrink-0" />
        {easy ? MANUAL_START_TEXT.cardNote.easy : MANUAL_START_TEXT.cardNote.expert}
      </p>
      <Link to={manualStartPath(recId)} className={cn(linkBtn, "mt-2 w-full bg-card text-warn-ink ring-1 ring-warn/40 hover:bg-fill")}>
        <Icon name="play" className="size-4" />
        {MANUAL_START_TEXT.button}
      </Link>
    </div>
  );
}

/**
 * 계획 미니의 '자세히': 같은 화면 아래의 매매 계획 카드로 내려간다 (읽던 흐름을 끊지 않게 — 다른 화면으로 나가지 않는다).
 * 카드가 없는 화면이면 계획 화면으로 간다. 움직임 줄이기면 바로 옮긴다. 키보드 사용자를 위해 카드에 포커스를 준다.
 */
function useGoToPlan(recId: number) {
  const navigate = useNavigate();
  return () => {
    const card = document.getElementById(PLAN_CARD_ID);
    if (!card) {
      navigate(`/recommendations/${recId}`);
      return;
    }
    if (typeof card.scrollIntoView === "function") card.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    card.focus({ preventScroll: true });
  };
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
  const goToPlan = useGoToPlan(rec?.id ?? 0);
  if (state === "not_completed") return null;
  const box = cn("flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl bg-fill px-3.5 py-2.5 text-[14px]", className);
  if (state === "ready" && rec && preview) {
    const a = rates(rec);
    return (
      <div aria-label="계획 미니" data-state={state} className={box}>
        <span className="tabular-nums">
          {easy ? "손절 시" : "손절 시 손실"} <b className="text-down">{a.loss}</b>
        </span>
        <span className="tabular-nums">
          {easy ? "목표 시" : "목표 시 이익"} <b className="text-up">{a.gain}</b>
        </span>
        {/* 첫 화면의 유일한 실행 버튼 — 엄지로 누르기 좋게 44px */}
        <Link
          to={`/recommendations/${rec.id}`}
          className="press ml-auto flex h-11 items-center rounded-xl bg-brand px-4 text-[15px] font-bold text-white hover:bg-brand-dark"
        >
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
        <button
          type="button"
          onClick={goToPlan}
          className="press -mr-1.5 flex h-11 shrink-0 items-center gap-0.5 rounded-lg px-1.5 text-[14px] font-semibold text-brand-ink hover:bg-line"
        >
          자세히
          <Icon name="chevron-down" className="size-4" />
        </button>
      </div>
    );
  }
  return (
    <div aria-label="계획 미니" data-state={state} className={box}>
      {state === "preparing" && <LiveDot />}
      <span>{(state === "expired" && rec ? priceExpiredText(rec.expiredReason, easy) : null) ?? MINI_TEXT[state as keyof typeof MINI_TEXT]}</span>
    </div>
  );
}
