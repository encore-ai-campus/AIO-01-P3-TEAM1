import { Link } from "react-router";
import type { AnalysisSummary, Quote } from "../api/types";
import { type ViewMode, useViewMode } from "../hooks/useBeginnerMode";
import { countWord } from "../lib/autotrade";
import { formatDateTime, formatPercent, formatPrice, formatRate, formatRequester, trendClass } from "../lib/format";
import { ANALYSIS_PRICE_LABEL } from "../lib/plainText";
import { AsOf, Flash, VerdictBadge } from "./ui";

/**
 * AI 교차검증 분석 카드 (홈 대시보드·리포트 탭의 "교차검증 분석" 묶음).
 * 가격은 quote(장마감 기준 종가 + 기준 시각)를 보이고, 없으면 분석 시각 가격을 그렇게 적어 보인다.
 * 전문가 보기: 누르면 종목 상세로 (분석의 목표·손절을 주문 패널에 채워 준다), 점수·확률을 보인다.
 * 쉬운 보기: 누르면 분석 상세로 (여러 AI가 검증한 과정), 점수·확률 없이 통과 여부만. view를 주지 않으면 화면의 보기를 따른다.
 */
export function AnalysisCard({ a, quote, view }: { a: AnalysisSummary; quote?: Quote; view?: ViewMode }) {
  const screen = useViewMode();
  const easy = (view ?? screen.view) === "easy";
  const price = quote?.price ?? null;
  const best = a.best;
  const to = easy ? `/analyses/${a.id}` : `/stocks/${encodeURIComponent(a.symbol)}?analysis=${a.id}`;
  return (
    <Link to={to} className="block rounded-2xl bg-card p-5 transition-colors hover:bg-[#fafbfc] active:bg-fill">
      <article aria-label={`${a.name} AI 분석`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[17px] font-bold">{a.name}</h3>
            <p className="text-[13px] text-mute">
              {a.symbol} · {a.market === "KR" ? "국내" : "미국"}
            </p>
          </div>
          {easy ? (
            <span className={`inline-flex h-6 items-center rounded-md px-2 text-[12px] font-bold ${a.verdict === "BUY" ? "bg-brand-soft text-brand-dark" : "bg-fill text-mute"}`}>
              {a.verdict === "BUY" ? "통과한 계획 있음" : "통과한 계획 없음"}
            </span>
          ) : (
            <VerdictBadge verdict={a.verdict} />
          )}
        </div>

        {price !== null ? (
          <>
            <p className="mt-3 flex flex-wrap items-baseline gap-x-2 tabular-nums">
              <span className="text-[13px] font-medium text-mute">종가</span>
              <span className="text-[20px] font-bold">
                <Flash value={price}>{formatPrice(price, a.currency)}</Flash>
              </span>
              <span className={`text-[14px] font-semibold ${trendClass(quote?.changeRate)}`}>{formatRate(quote?.changeRate)}</span>
            </p>
            <AsOf at={quote?.asOf} market={a.market} className="block" />
          </>
        ) : (
          <p className="mt-3 flex flex-wrap items-baseline gap-x-2 tabular-nums">
            <span className="text-[13px] font-medium text-mute">{ANALYSIS_PRICE_LABEL}</span>
            <span className="text-[20px] font-bold">{formatPrice(a.priceAtAnalysis, a.currency)}</span>
          </p>
        )}

        {best ? (
          <>
            {easy ? (
              <p className="mt-2 text-[13px] text-sub">AI {countWord(a.scenarioCount)} 곳이 각자 계획을 내고 서로 검증했어요</p>
            ) : (
              <p className="mt-2 text-[13px] text-sub">
                점수 <b className="font-semibold text-ink tabular-nums">{best.score ?? "-"}</b>
                <span className="mx-1.5 text-line">|</span>
                확률 <b className="font-semibold text-ink tabular-nums">{formatPercent(best.probability)}</b>
                <span className="mx-1.5 text-line">|</span>
                시나리오 {a.scenarioCount}개
              </p>
            )}
            <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-fill p-3 text-center">
              <div>
                <dt className="text-[12px] text-mute">{easy ? "사는 가격" : "진입"}</dt>
                <dd className="text-[13px] font-semibold tabular-nums">{formatPrice(best.entryPrice, a.currency)}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-mute">{easy ? "목표 가격" : "목표"}</dt>
                <dd className="text-[13px] font-semibold tabular-nums text-up">{formatPrice(best.targetPrice, a.currency)}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-mute">{easy ? "손절 가격" : "손절"}</dt>
                <dd className="text-[13px] font-semibold tabular-nums text-down">{formatPrice(best.stopPrice, a.currency)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="mt-3 rounded-xl bg-fill p-3 text-[13px] text-mute">{easy ? "조건에 맞는 계획이 없었어요." : "조건에 맞는 시나리오가 없었습니다."}</p>
        )}

        <p className="mt-3 text-[12px] text-mute">
          {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)} 요청
        </p>
      </article>
    </Link>
  );
}
