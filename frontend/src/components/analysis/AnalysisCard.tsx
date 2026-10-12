import { Link } from "react-router";
import type { AnalysisSummary, Quote } from "../../api/types";
import { type ViewMode, useViewMode } from "../../hooks/useBeginnerMode";
import { countWord } from "../../lib/autotrade";
import { formatDateTime, formatPercent, formatPrice, formatRate, formatRequester, trendClass } from "../../lib/format";
import { ANALYSIS_PRICE_LABEL, quotePriceName } from "../../lib/plainText";
import { VerdictText } from "../reports/VerdictText";
import { AsOf, Flash, Skeleton } from "../ui";

/**
 * AI 교차검증 분석 카드 (홈 대시보드·리포트 탭의 "교차검증 분석" 묶음).
 * 가격은 quote(실시간 현재가 + 받은 시각, 못 받은 종목은 장마감 기준 종가 + 기준 시각)를 보이고, 없으면 분석 시각 가격을 그렇게 적어 보인다.
 * 전문가 보기: 누르면 종목 상세로 (분석의 목표·손절을 주문 패널에 채워 준다), 점수·확률을 보인다.
 * 쉬운 보기: 누르면 분석 상세로 (여러 AI가 검증한 과정), 점수·확률 없이 통과 여부만. view를 주지 않으면 화면의 보기를 따른다.
 * 판정은 전문가 보기도 한국어로 (BUY 매수 · PASS 지켜보기 — reports/VerdictText, UX-5). 계획이 없으면 판정과 부딪히지 않게 "제안된 계획이 없어요"만.
 * 가격은 줄바꿈하지 않는다 ('182,20 / 0원'처럼 쪼개지면 다른 값으로 읽힌다). 카드 안쪽 폭이 272px보다 좁으면
 * 진입·목표·손절 세 칸을 '이름 · 값' 세 줄로 바꾼다 — 일곱 자리 가격(1,234,000원 약 77px) 세 칸 + 칸 사이 16 + 안쪽 여백 24 = 271px.
 * 그보다 좁은 세 칸이면 가격이 칸을 넘어 이웃 가격과 붙어 하나의 숫자로 읽힌다 (PC 1280px 홈 2단 카드의 안쪽이 243~250px).
 */
export function AnalysisCard({ a, quote, view }: { a: AnalysisSummary; quote?: Quote; view?: ViewMode }) {
  const screen = useViewMode();
  const easy = (view ?? screen.view) === "easy";
  const price = quote?.price ?? null;
  const best = a.best;
  const to = easy ? `/analyses/${a.id}` : `/stocks/${encodeURIComponent(a.symbol)}?analysis=${a.id}`;
  const cell = "@max-[272px]:flex @max-[272px]:items-baseline @max-[272px]:justify-between";
  return (
    <Link to={to} className="press-row block rounded-2xl bg-card p-5 @container hover:bg-fill/50">
      <article aria-label={`${a.name} AI 분석`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[17px] font-bold">{a.name}</h3>
            <p className="text-[13px] text-mute">
              {a.symbol} · {a.market === "KR" ? "국내" : "미국"}
            </p>
          </div>
          {easy ? (
            <span
              className={`inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[12px] font-bold ${a.verdict === "BUY" ? "bg-brand-soft text-brand-ink" : "bg-fill text-mute"}`}
            >
              {a.verdict === "BUY" ? "통과한 계획 있음" : "통과한 계획 없음"}
            </span>
          ) : (
            <VerdictText verdict={a.verdict} className="shrink-0" />
          )}
        </div>

        {price !== null ? (
          <>
            <p className="mt-3 flex flex-wrap items-baseline gap-x-2 tabular-nums">
              <span className="text-[13px] font-medium text-mute">{quotePriceName(quote?.basis, easy)}</span>
              <span className="text-[20px] font-bold">
                <Flash value={price}>{formatPrice(price, a.currency)}</Flash>
              </span>
              <span className={`text-[14px] font-semibold ${trendClass(quote?.changeRate)}`}>{formatRate(quote?.changeRate)}</span>
            </p>
            <AsOf at={quote?.asOf} market={a.market} basis={quote?.basis} className="block" />
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
                <span aria-hidden="true" className="mx-1.5 text-mute-weak">
                  |
                </span>
                확률 <b className="font-semibold text-ink tabular-nums">{formatPercent(best.probability)}</b>
                <span aria-hidden="true" className="mx-1.5 text-mute-weak">
                  |
                </span>
                시나리오 {a.scenarioCount}개
              </p>
            )}
            <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-fill p-3 text-center @max-[272px]:grid-cols-1 @max-[272px]:gap-1 @max-[272px]:text-left">
              <div className={cell}>
                <dt className="text-[12px] text-mute">{easy ? "사는 가격" : "진입"}</dt>
                <dd className="text-[13px] font-semibold whitespace-nowrap tabular-nums">{formatPrice(best.entryPrice, a.currency)}</dd>
              </div>
              <div className={cell}>
                <dt className="text-[12px] text-mute">{easy ? "목표 가격" : "목표"}</dt>
                <dd className="text-[13px] font-semibold whitespace-nowrap tabular-nums text-up">{formatPrice(best.targetPrice, a.currency)}</dd>
              </div>
              <div className={cell}>
                <dt className="text-[12px] text-mute">{easy ? "손절 가격" : "손절"}</dt>
                <dd className="text-[13px] font-semibold whitespace-nowrap tabular-nums text-down">{formatPrice(best.stopPrice, a.currency)}</dd>
              </div>
            </dl>
          </>
        ) : (
          // 목록 요약에는 오류가 없어 까닭(조건 불충족인지 AI가 응답하지 못했는지)을 모른다 → 사실만 말하고, 까닭은 분석 상세의 과정 카드가 말한다
          <p className="mt-3 rounded-xl bg-fill p-3 text-[13px] text-mute">{easy ? "AI가 낸 계획이 없어요." : "제안된 계획이 없어요."}</p>
        )}

        <p className="mt-3 text-[12px] text-mute">
          {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)} 요청
        </p>
      </article>
    </Link>
  );
}

/**
 * 분석 카드와 같은 모양의 자리 (이름 · 코드 · 현재가 · 기준 시각 · 점수 줄 · 세 칸 · 요청 줄) — 받는 동안 높이가 출렁이지 않게.
 * 줄 상자는 실제 줄과 같은 글자 크기의 한 줄 높이(h-lh). 세 칸 자리도 카드처럼 안쪽 272px보다 좁으면 세 줄 높이가 된다
 * (세 칸: 안쪽 여백 24 + 이름 18 + 값 19.5 · 세 줄: 24 + 19.5 × 3 + 간격 4 × 2).
 */
export function AnalysisCardSkeleton() {
  return (
    <div aria-hidden="true" className="rounded-2xl bg-card p-5 @container">
      <div className="flex h-lh items-center text-[17px]">
        <Skeleton className="h-5 w-24" />
      </div>
      <div className="flex h-lh items-center text-[13px]">
        <Skeleton className="h-3.5 w-20" />
      </div>
      <div className="mt-3 flex h-lh items-center text-[20px]">
        <Skeleton className="h-6 w-36" />
      </div>
      <div className="flex h-lh items-center text-[12px]">
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="mt-2 flex h-lh items-center text-[13px]">
        <Skeleton className="h-3.5 w-48" />
      </div>
      <Skeleton className="mt-3 h-[61.5px] w-full rounded-xl @max-[272px]:h-[90.5px]" />
      <div className="mt-3 flex h-lh items-center text-[12px]">
        <Skeleton className="h-3 w-32" />
      </div>
    </div>
  );
}
