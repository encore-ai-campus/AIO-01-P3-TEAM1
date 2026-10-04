// 리포트 상세의 쉬운 보기 (주린이모드 켬의 기본, docs/컨셉변경계획.md 4-2 "리포트 상세 (쉬운 보기)").
// 머리(종목 + 단계 막대 + "이 화면만 자세히 보기") →
//   만드는 중: 쉬운 진행 표시 / 만들지 못함: 사유 문장 + 다시 만들기 /
//   완성: AI 의견 배지 + 한 줄 요약 + 신뢰 패널 + 계획 미니 → 쉬운 요약 3줄 → 매매 계획 카드 → 근거·위험·틀리는 경우 → 시나리오 세 칸 → 차트 → 조사 자료 요약
// → PDF · 면책 문장. 리포트와 매매 계획(추천)은 추천 API로 맞춘다 (GET /api/recommendations?source=report&sourceId=&status=all — PlanCard와 같은 조회).
import { Suspense, lazy, useMemo } from "react";
import { useRecommendations, useRiskPreview, useStock } from "../../../api/queries";
import type { Currency, Market, ReportDetail, ReportOpinion } from "../../../api/types";
import type { ViewModeState } from "../../../hooks/useBeginnerMode";
import { formatDateTime } from "../../../lib/format";
import { DISCLAIMER, opinionText } from "../../../lib/plainText";
import {
  type ReportTargets,
  draftOf,
  oneLinerOf,
  opinionOf,
  pickRecommendation,
  researchOf,
  scenarioOf,
  stepsOf,
  trustOf,
  validTargets,
} from "../../../lib/reports";
import { Icon } from "../../Icon";
import { PlanCard } from "../../plan/PlanCard";
import { Term } from "../../Term";
import { AsOf, Card, Skeleton } from "../../ui";
import { OpinionBadge } from "../OpinionBadge";
import { ViewToggle } from "../ViewToggle";
import { EasyFailure } from "./EasyFailure";
import { EasyProgress } from "./EasyProgress";
import { ReasonsRisks } from "./ReasonsRisks";
import { ResearchCards } from "./ResearchCards";
import { ScenarioBoxes } from "./ScenarioBoxes";
import { StepBar } from "./StepBar";
import { TrustPanel } from "./TrustPanel";

const ReportChart = lazy(() => import("./ReportChart").then((m) => ({ default: m.ReportChart })));

const LINE = { entry: "#4E5968", target: "#F04452", stop: "#3182F6" };

/** 일봉(완성 봉, 장마감 기준) + AI가 제안한 가격 선. 완성된 리포트에서만 불러온다. */
function ChartSection({ symbol, market, targets }: { symbol: string; market: Market; targets: ReportTargets | null }) {
  const { data: stock, isError } = useStock(symbol);
  const ok = targets !== null && validTargets(targets);
  const entry = ok ? targets.entry : null;
  const target = ok ? targets.target : null;
  const stop = ok ? targets.stop : null;
  const lines = useMemo(
    () =>
      entry !== null && target !== null && stop !== null
        ? [
            { price: target, title: "목표 가격", color: LINE.target },
            { price: entry, title: "사는 가격", color: LINE.entry },
            { price: stop, title: "손절 가격", color: LINE.stop },
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
            <p className="py-6 text-center text-[14px] text-mute">일봉 자료가 없어요.</p>
          )
        ) : isError ? (
          <p className="py-6 text-center text-[14px] text-mute">차트를 불러오지 못했어요.</p>
        ) : (
          <Skeleton className="h-[260px] w-full lg:h-[340px]" />
        )}
      </div>
      {stock && (
        <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 text-[12px] leading-snug text-mute">
          일봉 · 최근 {stock.candles.length}일 ·
          {stock.asOf ? (
            <Term k="장마감 기준">
              <AsOf at={stock.asOf} market={market} />
            </Term>
          ) : (
            <Term k="장마감 기준" />
          )}
          {lines.length > 0 && <span className="basis-full">가로선은 AI가 제안한 사는 가격·목표 가격·손절 가격이에요.</span>}
        </p>
      )}
    </Card>
  );
}

function Conclusion({ r, opinion, oneLiner }: { r: ReportDetail; opinion: ReportOpinion | null; oneLiner: string | null }) {
  const t = opinionText(opinion);
  return (
    <Card aria-labelledby="opinion-title" className="space-y-3">
      <h2 id="opinion-title" className="sr-only">
        AI 의견
      </h2>
      {t ? (
        <div className="space-y-1">
          <OpinionBadge opinion={opinion} large />
          <p className="text-[14px] text-sub">{t.line}</p>
        </div>
      ) : (
        <p className="text-[15px] text-mute">AI 의견을 읽지 못했어요.</p>
      )}
      {oneLiner && <p className="text-[18px] leading-snug font-bold tracking-tight">{oneLiner}</p>}
      <TrustPanel trust={trustOf(r.state, r.trace)} />
      <PlanCard report={{ ...r, opinion }} variant="mini" view="easy" />
    </Card>
  );
}

function PlainSummary({ lines }: { lines: string[] }) {
  return (
    <Card aria-labelledby="plain-title">
      <h2 id="plain-title" className="text-[17px] font-bold">
        쉬운 요약
      </h2>
      {lines.length ? (
        <ol aria-label="쉬운 요약 세 줄" className="mt-2 space-y-2">
          {lines.map((line, i) => (
            <li key={line} className="flex gap-2.5 text-[16px] leading-snug">
              <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-bold text-white">{i + 1}</span>
              {line}
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
  const recs = useRecommendations({ source: "report", sourceId: r.id, status: "all" }, completed);
  const rec = pickRecommendation(recs.data?.results);
  const preview = useRiskPreview(rec?.id ?? Number.NaN, null, rec !== null && opinion === "buy");
  const executed = Boolean(rec?.myPlan);
  const currency: Currency = rec?.currency ?? (r.market === "US" ? "USD" : "KRW");
  // 추천이 있으면 그 가격(리스크 미리 보기와 같은 값), 없으면 리포트가 제안한 가격
  const targets: ReportTargets | null = rec
    ? { entry: rec.entryPrice, target: rec.targetPrice, stop: rec.stopPrice, holdingDays: rec.holdingDays, probability: rec.probability }
    : (draft?.targets ?? null);
  const scenario = opinion === "buy" && targets ? scenarioOf(targets, rec ? preview.data : null, targets.holdingDays) : null;
  const research = completed ? researchOf(r.state) : null;

  return (
    <div className="space-y-3 lg:space-y-4">
      <Card aria-label="리포트 머리" className="py-4">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 pt-1.5 text-[13px] text-mute">
            {r.symbol} · {r.market === "KR" ? "국내" : "미국"} · {r.requestedBy} 님이 만듦 · {formatDateTime(r.createdAt)}
          </p>
          <ViewToggle view={view} />
        </div>
        <StepBar steps={stepsOf(r.status, executed)} className="mt-3" />
        {completed && !executed && <p className="mt-2 text-[13px] text-sub">결론과 손실 금액을 확인했으면 아래 매매 계획에서 실행 준비로 넘어가요.</p>}
      </Card>

      {r.status === "failed" ? (
        <EasyFailure r={r} />
      ) : !completed ? (
        <EasyProgress r={r} />
      ) : (
        <>
          <Conclusion r={r} opinion={opinion} oneLiner={oneLiner} />
          <PlainSummary lines={draft?.plainSummary ?? []} />
          <PlanCard report={{ ...r, opinion }} variant="full" view="easy" />
          {draft && <ReasonsRisks draft={draft} opinion={opinion} currency={currency} />}
          {scenario && <ScenarioBoxes scenario={scenario} market={r.market} />}
          <ChartSection symbol={r.symbol} market={r.market} targets={opinion === "buy" ? targets : null} />
          {research && <ResearchCards {...research} marketCode={r.market} currency={currency} />}
        </>
      )}

      <Card as="div" className="space-y-2">
        {completed && (
          <a
            href={`/api/reports/${r.id}/pdf`}
            target="_blank"
            rel="noreferrer"
            className="flex h-11 items-center justify-center gap-1.5 rounded-xl bg-fill text-[15px] font-semibold text-ink hover:bg-line"
          >
            <Icon name="download" className="size-4" />
            PDF로 보기
          </a>
        )}
        <p className="text-[12px] leading-snug text-mute">{DISCLAIMER}</p>
      </Card>
    </div>
  );
}
