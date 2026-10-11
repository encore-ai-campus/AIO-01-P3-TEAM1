// 리포트 상세의 쉬운 보기 (주린이모드 켬의 기본, docs/plans/컨셉변경계획.md 4-2 "리포트 상세 (쉬운 보기)").
// 머리(종목 + 단계 막대 + "이 화면만 자세히 보기" + 다음 행동 한 줄) →
//   만드는 중: 쉬운 진행 표시 / 만들지 못함: 사유 문장 + 다시 만들기 /
//   완성: AI 의견 배지 + 의견의 뜻 한 줄(지켜보기·부정적) + 한 줄 요약 + 신뢰 패널 + 계획 미니 → 쉬운 요약 3줄 → 매매 계획 카드 → 근거·위험·틀리는 경우 → 시나리오 세 칸 → 차트 → 조사 자료 요약
// → PDF · 면책 문장. 리포트와 매매 계획(추천)은 추천 API로 맞춘다 (api/reports.ts usePlanCardData — PlanCard와 같은 훅·같은 상태).
//
// 위치: 모바일은 위 순서 그대로 한 열 (결론 먼저 — 360×740 첫 화면에 배지·한 줄 요약·신뢰 첫 줄·계획 미니).
// PC(lg)는 같은 DOM 순서로 두 열: 왼쪽은 ② 검토(읽기), 오른쪽 340px는 ③ 실행(매매 계획 카드, 스크롤해도 따라온다).
// 오른쪽에 카드가 늘 보이므로 PC에서는 결론 카드의 계획 미니를 숨긴다. 만드는 중·실패 화면은 PC에서 720px로 줄인다 (버튼이 화면 끝까지 늘지 않게).
// 완성되는 순간(이 화면에서 상태가 바뀐 경우만): 결론 카드가 올라오며 나타나고, 아래로 내려가 있던 사람에게는 토스트로 알린다 (스크롤은 옮기지 않는다).
// 실행할 계획이 없으면(지켜보기·부정적·계획 없음) "실행할 계획이 없어요"는 매매 계획 카드 한 곳만 말한다 — 머리 안내 문장·결론 카드의 계획 미니는 비킨다 (UX-8).
// AI가 쓴 글(한 줄 요약·쉬운 요약·근거·위험·틀리는 경우·조사 요약)은 전문 용어마다 처음 나온 한 번에 용어 풀이를 붙인다 (UX-4, AiTermsProvider — 화면 순서대로).
// 완성 화면의 고정 문장(결론·쉬운 요약 빈 값·차트 범례)은 쉬운 PDF(backend/reports/output/pdf.py 쉬운 판)도 같은 문장을 쓴다 — 바꾸면 둘 다 고친다
import { Suspense, lazy, useEffect, useMemo, type CSSProperties } from "react";
import { useStock } from "../../../api/queries";
import { usePlanCardData } from "../../../api/reports";
import type { Currency, Market, ReportDetail, ReportOpinion } from "../../../api/types";
import type { ViewModeState } from "../../../hooks/useBeginnerMode";
import { useChanged } from "../../../hooks/useMotionState";
import { cn } from "../../../lib/cn";
import { formatDateTime, formatPrice } from "../../../lib/format";
import { scrollToTop } from "../../../lib/motion";
import { DISCLAIMER, opinionText } from "../../../lib/plainText";
import { stockAsOfBasis } from "../../../lib/quote";
import {
  OPINION_MEANING,
  type ReportTargets,
  draftOf,
  floorTargets,
  oneLinerOf,
  opinionOf,
  planGuide,
  reasonsRisksView,
  researchOf,
  scenarioOf,
  showPlanMini,
  stepsOf,
  trustOf,
  validTargets,
} from "../../../lib/reports";
import { Icon } from "../../Icon";
import { Collapse } from "../../motion/Collapse";
import { PLAN_CARD_ID, PlanCard } from "../../plan/PlanCard";
import { Term } from "../../Term";
import { useToast } from "../../toast";
import { AsOf, Card, ErrorState, Skeleton } from "../../ui";
import { OpinionBadge } from "../OpinionBadge";
import { PdfOpenButton } from "../PdfOpenButton";
import { ViewToggle } from "../ViewToggle";
import { AiTermsProvider, AiText } from "./AiText";
import { EasyFailure } from "./EasyFailure";
import { EasyProgress } from "./EasyProgress";
import { ReasonsRisks } from "./ReasonsRisks";
import type { PriceLine, PriceLineKind } from "./ReportChart";
import { ResearchCards } from "./ResearchCards";
import { ScenarioBoxes } from "./ScenarioBoxes";
import { StepBar } from "./StepBar";
import { TrustPanel } from "./TrustPanel";

const ReportChart = lazy(() => import("./ReportChart").then((m) => ({ default: m.ReportChart })));

// 범례 견본 색 (차트의 선 색과 같은 토큰: 목표 = 상승, 사는 가격 = 보조 글자, 손절 = 하락)
const SWATCH: Record<PriceLineKind, string> = { target: "border-up", entry: "border-sub", stop: "border-down" };

/**
 * 종가 선(오늘 정규장이 열렸으면 진행 중인 봉의 지금 가격까지 — 실시간 시세 기준, 종목 상세 쉬운 보기와 같은 선) + AI가 제안한 가격 선과 그 값을 적은 범례.
 * 완성된 리포트에서만 불러온다. 캔들은 전문가 보기에만 (UX-17).
 */
function ChartSection({ symbol, market, currency, targets }: { symbol: string; market: Market; currency: Currency; targets: ReportTargets | null }) {
  const { data: stock, isError, refetch, isFetching } = useStock(symbol);
  const ok = targets !== null && validTargets(targets);
  const entry = ok ? targets.entry : null;
  const target = ok ? targets.target : null;
  const stop = ok ? targets.stop : null;
  const lines = useMemo<PriceLine[]>(
    () =>
      entry !== null && target !== null && stop !== null
        ? [
            { price: target, title: "목표 가격", kind: "target" },
            { price: entry, title: "사는 가격", kind: "entry" },
            { price: stop, title: "손절 가격", kind: "stop" },
          ]
        : [],
    [entry, target, stop],
  );
  return (
    <Card aria-labelledby="chart-title">
      <h2 id="chart-title" className="text-[17px] font-bold">
        가격 흐름
      </h2>
      <div className="mt-2">
        {stock ? (
          stock.candles.length ? (
            <Suspense fallback={<Skeleton className="h-[260px] w-full lg:h-[340px]" />}>
              <ReportChart candles={stock.candles} currency={stock.currency} lines={lines} />
            </Suspense>
          ) : (
            <p className="py-6 text-center text-[14px] text-mute">가격 자료가 없어요.</p>
          )
        ) : isError ? (
          <div className="flex h-[260px] items-center lg:h-[340px]">
            <div className="w-full">
              <ErrorState message="차트를 불러오지 못했어요." onRetry={() => void refetch()} retrying={isFetching} compact />
            </div>
          </div>
        ) : (
          <Skeleton className="h-[260px] w-full lg:h-[340px]" />
        )}
      </div>
      {lines.length > 0 && (
        // 가로선의 이름과 값 (좁은 화면에서는 차트 안 이름을 빼므로 여기서 읽는다 — 화면 읽기 프로그램에도 값이 전해진다)
        <ul aria-label="차트의 가로선" className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-sub">
          {lines.map((l) => (
            <li key={l.kind} className="flex items-center gap-1.5 tabular-nums">
              <span aria-hidden="true" className={cn("w-4 border-t-2 border-dashed", SWATCH[l.kind])} />
              {l.title} <b className="font-semibold text-ink">{formatPrice(l.price, currency)}</b>
            </li>
          ))}
        </ul>
      )}
      {stock && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-snug text-sub">
          {stockAsOfBasis(stock) === "live" ? "종가 선 (마지막은 오늘 진행 중)" : "종가"} · 최근 {stock.candles.length}일 ·
          {stock.asOf ? (
            stockAsOfBasis(stock) === "live" ? (
              // 마지막 봉이 오늘 진행 중이다 — 기준 표시는 시세를 받은 시각
              <AsOf at={stock.asOf} market={market} basis="live" />
            ) : (
              <Term k="장마감 기준">
                <AsOf at={stock.asOf} market={market} />
              </Term>
            )
          ) : (
            <Term k="장마감 기준" />
          )}
          {lines.length > 0 && <span className="basis-full">가로선은 AI가 제안한 사는 가격·목표 가격·손절 가격이에요.</span>}
        </p>
      )}
    </Card>
  );
}

function Conclusion({
  r,
  opinion,
  oneLiner,
  mini,
  className,
}: {
  r: ReportDetail;
  opinion: ReportOpinion | null;
  oneLiner: string | null;
  mini: boolean;
  className?: string;
}) {
  const t = opinionText(opinion);
  const meaning = opinion ? OPINION_MEANING[opinion] : undefined;
  return (
    <Card aria-labelledby="opinion-title" className={cn("space-y-3", className)}>
      <h2 id="opinion-title" className="sr-only">
        AI 의견
      </h2>
      {t ? (
        <div className="space-y-1">
          <OpinionBadge opinion={opinion} large />
          <p className="text-[14px] text-sub">{t.line}</p>
          {/* 지켜보기·부정적의 뜻: 이미 가진 사람에게 팔라는 말로 읽히지 않게 (UX-8) */}
          {meaning && (
            <p className="flex items-start gap-1.5 pt-0.5 text-[14px] leading-snug text-ink">
              <Icon name="info" className="mt-0.5 size-4 shrink-0 text-mute-weak" />
              {meaning}
            </p>
          )}
        </div>
      ) : (
        <p className="text-[15px] text-mute">AI 의견을 읽지 못했어요.</p>
      )}
      {oneLiner && (
        <p className="text-[18px] leading-snug font-bold tracking-tight">
          <AiText text={oneLiner} />
        </p>
      )}
      <TrustPanel trust={trustOf(r.state, r.trace)} />
      {/* PC는 오른쪽 열에 매매 계획 카드가 늘 보이므로 미니를 숨긴다 (같은 카드를 두 번 그리지 않고 CSS로만).
          실행할 계획이 없으면 미니를 두지 않는다 — 그 말은 매매 계획 카드가 한 번만 한다 */}
      {mini && <PlanCard report={{ ...r, opinion }} variant="mini" view="easy" className="lg:hidden" />}
    </Card>
  );
}

function PlainSummary({ lines, className }: { lines: string[]; className?: string }) {
  return (
    <Card aria-labelledby="plain-title" className={className}>
      <h2 id="plain-title" className="text-[17px] font-bold">
        쉬운 요약
      </h2>
      {lines.length ? (
        <ol aria-label="쉬운 요약 세 줄" className="mt-2 space-y-2">
          {lines.map((line, i) => (
            <li key={line} className="flex gap-2.5 text-[16px] leading-snug">
              {/* 반전 번호 원: 다크에서는 밝은 원 + 어두운 숫자 */}
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-bold text-on-ink">{i + 1}</span>
              <span className="min-w-0">
                <AiText text={line} />
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="mt-1 text-[14px] text-mute">쉬운 요약이 아직 없어요.</p>
      )}
    </Card>
  );
}

export function EasyReport({ r, view }: { r: ReportDetail; view: ViewModeState }) {
  const completed = r.status === "completed";
  const opinion = opinionOf(r);
  const oneLiner = oneLinerOf(r);
  const draft = completed ? draftOf(r.state) : null;
  // 매매 계획 카드와 같은 훅 — 단계 막대·안내 문장·세 가지 경우가 카드와 같은 추천·같은 상태를 말한다
  const plan = usePlanCardData({ ...r, opinion });
  const rec = plan.rec;
  const executed = Boolean(rec?.myPlan);
  const planState = completed ? plan.state : null;
  const currency: Currency = rec?.currency ?? (r.market === "US" ? "USD" : "KRW");
  // 추천이 있으면 그 가격(리스크 미리 보기와 같은 값), 없으면 리포트가 제안한 가격을 추천처럼 호가 단위로 내린 값 (쉬운 PDF와 같은 숫자).
  // 세 가지 경우·차트·'이 의견이 틀리는 경우'의 손절 문장이 모두 이 값 하나를 쓴다
  const targets: ReportTargets | null = rec
    ? { entry: rec.entryPrice, target: rec.targetPrice, stop: rec.stopPrice, holdingDays: rec.holdingDays, probability: rec.probability }
    : draft
      ? floorTargets(draft.targets, currency)
      : null;
  const scenario = opinion === "buy" && targets ? scenarioOf(targets, rec ? plan.preview : null, targets.holdingDays, planState) : null;
  const researchAll = completed ? researchOf(r.state) : null;
  const research = researchAll && (researchAll.market || researchAll.fundamental || researchAll.news) ? researchAll : null;
  const guide = completed && !executed ? planGuide(planState, rec?.expiredReason) : null;
  // 계획 미니는 긍정적 의견에서만 (지켜보기·부정적·계획 없음은 매매 계획 카드가 한 번만 말한다). 지켜보기·부정적은 추천을 받기 전에도 알 수 있어 자리가 생겼다 사라지지 않는다
  const mini = opinion === "buy" && showPlanMini(planState);
  // AI 글을 화면 순서대로: 용어 풀이는 용어마다 처음 나온 한 번만 (UX-4)
  const why = draft ? reasonsRisksView(draft, opinion, currency, targets ?? undefined) : null;
  const aiTexts = [
    oneLiner,
    ...(draft?.plainSummary ?? []),
    ...(why ? [...why.reasons.map((x) => x.text), ...why.risks.map((x) => x.text), why.wrong] : []),
    research?.market?.summary,
    research?.fundamental?.summary,
    research?.news?.summary,
  ];

  // 이 화면에서 완성된 순간 (처음부터 완성이면 false)
  const justCompleted = useChanged(r.status) && completed;
  const toast = useToast();
  useEffect(() => {
    if (!justCompleted) return;
    // 진행 표시를 보다 아래로 내려가 있던 사람에게만 알린다 (스크롤은 옮기지 않는다 — 읽던 자리를 코드가 바꾸지 않게)
    if (typeof window !== "undefined" && window.scrollY > 240) {
      toast("리포트가 완성됐어요", "success", { action: { label: "결론 보기", onClick: () => scrollToTop() } });
    }
  }, [justCompleted, toast]);

  // PC 두 열: 왼쪽 칸 수만큼 오른쪽 매매 계획 카드가 행을 걸친다 (고정 수를 쓰면 빈 줄·간격이 생긴다)
  const leftCount = 2 + (draft ? 1 : 0) + (scenario ? 1 : 0) + 1 + (research ? 1 : 0);
  const planSpan: CSSProperties = { gridRow: `1 / span ${leftCount}` };
  const left = "lg:col-start-1";

  return (
    <div className={cn("space-y-3 lg:space-y-4", !completed && "lg:max-w-[720px]")}>
      <Card aria-label="리포트 머리" className="py-4">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 pt-1.5 text-[13px] text-mute">
            {r.symbol} · {r.market === "KR" ? "국내" : "미국"} · {r.requestedBy} 님이 만듦 · {formatDateTime(r.createdAt)}
          </p>
          <ViewToggle view={view} />
        </div>
        <StepBar steps={stepsOf(r.status, executed, planState)} className="mt-3" />
        {/* 계획 상태를 받은 뒤에 나타나므로 툭 끼어들지 않게 펼친다 (캐시로 바로 그리면 처음부터 열려 있다) */}
        <Collapse open={guide !== null}>
          <p className="mt-2 flex items-start gap-1.5 text-[13px] leading-snug text-sub">
            <Icon name="info" className="mt-px size-4 shrink-0 text-mute-weak" />
            {guide}
          </p>
        </Collapse>
      </Card>

      {r.status === "failed" ? (
        <EasyFailure r={r} />
      ) : !completed ? (
        <EasyProgress r={r} />
      ) : (
        <AiTermsProvider texts={aiTexts}>
          <div className={cn("space-y-3 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-4 lg:space-y-0", justCompleted && "reveal-fade")}>
            <Conclusion r={r} opinion={opinion} oneLiner={oneLiner} mini={mini} className={cn(left, justCompleted && "animate-rise-in")} />
            <PlainSummary lines={draft?.plainSummary ?? []} className={left} />
            {/* ③ 실행: 모바일은 쉬운 요약 바로 아래(문서 순서), PC는 오른쪽 열에 붙어 따라온다 */}
            <div className="lg:sticky lg:top-8 lg:col-start-2 lg:self-start" style={planSpan}>
              <PlanCard report={{ ...r, opinion }} variant="full" view="easy" id={PLAN_CARD_ID} />
            </div>
            {draft && (
              <div className={left}>
                <ReasonsRisks draft={draft} opinion={opinion} currency={currency} targets={targets ?? undefined} />
              </div>
            )}
            {scenario && (
              <div className={left}>
                <ScenarioBoxes scenario={scenario} market={r.market} />
              </div>
            )}
            <div className={left}>
              <ChartSection symbol={r.symbol} market={r.market} currency={currency} targets={opinion === "buy" ? targets : null} />
            </div>
            {research && (
              <div className={left}>
                <ResearchCards {...research} marketCode={r.market} currency={currency} />
              </div>
            )}
          </div>
        </AiTermsProvider>
      )}

      <Card as="div" className="space-y-2">
        {/* 쉬운 판 PDF (?view=easy) — 준비 중·실패·재시도도 이 화면에서 보여 준다. */}
        {completed && <PdfOpenButton reportId={r.id} view="easy" />}
        {/* 면책 문장은 꼭 읽어야 하는 문장이라 보조 글자색 (흐린 글자보다 진하게) */}
        <p className="text-[12px] leading-snug text-sub">{DISCLAIMER}</p>
      </Card>
    </div>
  );
}
