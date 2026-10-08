// /analyses/:id AI 교차검증 분석 상세 (docs/DECISIONS.md 13-1 D-1): 여러 AI가 각자 계획을 내고 서로 검증해 최종 승인하는 과정을 두 모드 모두에서 보인다.
// 쉬운 보기: "AI 세 곳이 각자 계획을 내고 서로 검증했어요 · 통과 n · 최종 승인 ○○" + 제안 AI별 카드(사는·목표·손절 가격, 통과/탈락) — 점수·확률 없이.
//   지표는 엔진 스냅샷의 키(sma20·rsi14·change5d…)를 한국어 이름·용어 풀이·가격/% 모양으로(모르는 키는 숨김), 제안 AI 이름은 Claude·GPT·Gemini로,
//   분석 중 오류는 빨간 '오류' 대신 중립 '참고'에 쉬운 문장으로 (숨기지 않는다 — 엔진은 빈 결과에 오류를 남기지 않으므로 오류는 곧 장애다).
//   다만 계획이 0개라는 뜻일 뿐인 줄(가짜 데이터의 '…시나리오를 내지 않았습니다')은 과정 카드 문장과 같은 말이라 쉬운 보기에서 뺀다.
// 전문가 보기: 시나리오 카드에 점수·확률·탈락 사유, 원래 지표 키와 오류 원문 (진단에 필요하다).
// 가격: 위쪽은 직전 장마감 종가(AsOf), 분석의 가격은 "분석 시각 가격"(장중이었으면 "장중 가격"이라고 밝힌다 — 일부러 둔 예외).
// 뉴스는 제목·매체·게시 시각과 출처 표기(newsProvider), 지표·일봉 자료의 기준일(dataAsOf).
//
// 위치: 모바일은 머리(가격·판정·다음 행동) → 교차검증 과정(결과) → 이 분석의 계획 제안(행동) → AI별 계획(세부) → 뉴스·웹 조사·지표(근거).
// '결론 먼저': 과정 카드가 이미 결과(통과 수·최종 승인)를 말하므로 행동이 세부보다 앞이다. PC는 [왼쪽: 머리·과정·제안·계획 | 오른쪽 320px: 근거 자료].
// AI가 낸 계획이 없으면 과정 카드가 그 한 문장('AI가 낸 계획이 없어요 (조건에 맞는 계획이 없었어요)')을 말하고, 'AI별 계획 0개' 묶음은 두지 않는다 (같은 말 두 번).
// 제안 AI가 응답하지 못해 계획이 없으면(엔진 '… 시나리오 제안 실패') 조건 탓으로 말하지 않고 '(AI ○ 곳이 응답하지 못했어요)'라고 한다.
import { Link, useParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useAnalysis, useQuotes } from "../api/queries";
import type { AnalysisDetail, Currency, NewsItem, Scenario } from "../api/types";
import { SourceRecommendations } from "../components/autotrade/SourceRecommendations";
import { Term } from "../components/Term";
import { VerdictText } from "../components/reports/VerdictText";
import { AsOf, Card, EmptyState, ErrorState, Flash, PageHeader, PriceChange, Skeleton, SkeletonCard } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { crossCheckSummary, duringSession } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDate, formatDateTime, formatDayLabel, formatPercent, formatPrice, formatRate, formatRequester, formatUsd } from "../lib/format";
import { ANALYSIS_PRICE_LABEL, quotePriceName } from "../lib/plainText";
import { INDICATOR_EASY, analysisErrorEasy, indicatorValue, noPlanSentence, providerName } from "../lib/reports";

const DIRECTION: Record<string, { label: string; cls: string }> = {
  positive: { label: "긍정", cls: "bg-up-soft text-up-ink" },
  bullish: { label: "긍정", cls: "bg-up-soft text-up-ink" },
  up: { label: "긍정", cls: "bg-up-soft text-up-ink" },
  negative: { label: "부정", cls: "bg-down-soft text-down-ink" },
  bearish: { label: "부정", cls: "bg-down-soft text-down-ink" },
  down: { label: "부정", cls: "bg-down-soft text-down-ink" },
};

/** 쉬운 보기의 제안 AI 이름 (claude → Claude). 전문가 보기는 원래 값. */
const nameOf = (p: string, easy: boolean) => (easy ? providerName(p) : p);

function PassChip({ s }: { s: Scenario }) {
  return (
    <span
      className={cn(
        "rounded-md px-1.5 py-0.5 text-[12px] font-bold",
        s.passed === true && "bg-brand-soft text-brand-ink",
        s.passed !== true && "bg-fill text-mute",
      )}
    >
      {s.passed === true ? "통과" : s.passed === false ? "탈락" : "판정 없음"}
    </span>
  );
}

function ScenarioCard({ s, currency, easy }: { s: Scenario; currency: Currency; easy: boolean }) {
  const pct = (p: number) => formatRate(p / s.entryPrice - 1, 1);
  const name = nameOf(s.proposer, easy);
  return (
    <Card as="article" aria-label={`${name} 계획`} className={cn(s.selected && "ring-2 ring-brand")}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-[16px] font-bold">{name}</h3>
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
        <div className="mt-3 rounded-xl bg-up-soft p-3">
          <h4 className="text-[13px] font-semibold text-up-ink">{easy ? "떨어진 이유" : "탈락 사유"}</h4>
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
function Process({ a, easy }: { a: AnalysisDetail; easy: boolean }) {
  // 쉬운 보기는 문장 속 AI 이름도 카드와 같은 표기로 (lib/autotrade 문장 규칙은 그대로)
  const c = crossCheckSummary(easy ? a.scenarios.map((s) => ({ ...s, proposer: providerName(s.proposer) })) : a.scenarios);
  // 계획이 없는 까닭이 장애(제안 AI 응답 실패)면 '조건에 맞는 계획이 없었어요'라고 말하지 않는다
  const sentence = (a.scenarios.length === 0 && noPlanSentence(a.errors)) || c.sentence;
  return (
    <Card aria-labelledby="process-title">
      <h2 id="process-title" className="text-[17px] font-bold">
        교차검증 과정
      </h2>
      <p className="mt-1 text-[15px] leading-relaxed">{sentence}</p>
      {/* 계획이 없으면 위 한 문장으로 끝난다 (제안 AI 줄도, 참고할 AI 계획 안내도 없다) */}
      {a.scenarios.length > 0 && (
        <>
          <ol aria-label="제안 AI" className="mt-3 flex flex-wrap gap-2">
            {a.scenarios.map((s, i) => (
              <li key={`${s.proposer}-${i}`} className="flex items-center gap-1.5 rounded-xl bg-fill px-3 py-2 text-[14px]">
                <b>{nameOf(s.proposer, easy)}</b>
                <span aria-hidden="true" className="text-mute-weak">
                  →
                </span>
                <span className={s.passed === true ? "text-brand-ink" : "text-mute"}>{s.passed === true ? "통과" : s.passed === false ? "탈락" : "판정 없음"}</span>
                {s.selected && <span className="rounded-md bg-brand px-1.5 py-0.5 text-[12px] font-bold text-white">최종 승인</span>}
              </li>
            ))}
          </ol>
          <p className="mt-2 text-[13px] text-sub">AI 계획은 참고 자료예요. 수량과 실행 여부는 안전장치가 정하고, 매매는 모의 계좌에서만 해요.</p>
        </>
      )}
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

/**
 * 지표: 전문가 보기는 원래 키와 숫자 그대로, 쉬운 보기는 한국어 이름(눌러서 풀이)과 가격·% 모양이고 표에 없는 키는 숨긴다.
 * 키는 엔진 스냅샷 그대로다 (sma20·rsi14·volatility20·change5d·periodHigh … — lib/reports INDICATOR_EASY).
 */
function Indicators({ a, easy }: { a: AnalysisDetail; easy: boolean }) {
  // 쉬운 보기는 표의 순서(평균 가격 → RSI → 변동폭·변동성 → 등락률 → 기간 고저)로, 전문가 보기는 받은 순서 그대로
  const rows: [string, number | string | null][] = easy
    ? Object.keys(INDICATOR_EASY)
        .filter((k) => Object.hasOwn(a.indicators, k))
        .map((k) => [k, a.indicators[k]])
    : Object.entries(a.indicators);
  if (rows.length === 0) return null;
  return (
    <Card aria-labelledby="ind-title">
      <h2 id="ind-title" className="text-[17px] font-bold">
        지표
      </h2>
      {a.dataAsOf && <p className="text-[12px] text-mute">{formatDayLabel(a.dataAsOf)} 일봉까지의 자료</p>}
      <dl className={cn("mt-2 grid gap-x-4 gap-y-1.5 text-[14px]", easy ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-1" : "grid-cols-2")}>
        {rows.map(([k, v]) => {
          const easyName = easy && Object.hasOwn(INDICATOR_EASY, k) ? INDICATOR_EASY[k] : undefined;
          return (
            <div key={k} className="flex justify-between gap-2">
              <dt className="truncate text-mute">
                {easyName ? easyName.term ? <Term k={easyName.term}>{easyName.label}</Term> : easyName.label : k}
              </dt>
              <dd className="font-medium tabular-nums">
                {easyName
                  ? indicatorValue(v, easyName.format, a.currency)
                  : v === null
                    ? "-"
                    : typeof v === "number"
                      ? v.toLocaleString("ko-KR")
                      : v}
              </dd>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

/**
 * 계획이 0개라는 뜻일 뿐인 줄 (장애가 아니다 — 예: 가짜 데이터의 '제안 모델이 조건에 맞는 시나리오를 내지 않았습니다.').
 * 엔진의 장애 문구('… 시나리오 제안 실패: …', '… 검증 실패·누락', '시간 초과', '모델 응답 에러')는 걸리지 않는다 — 장애는 숨기지 않는다 (reports-r3).
 */
const isNoScenarioNote = (e: string) => /시나리오를 내지 않았|시나리오가 없/.test(e) && !/실패|오류|에러|초과|누락/.test(e);

/**
 * 분석 중 오류: 전문가 보기는 원문(진단용), 쉬운 보기는 엔진 문구를 쉬운 문장으로 바꿔 중립 '참고'로 (빨간 '오류'는 서비스 고장으로 읽힌다).
 * 쉬운 보기에서도 숨기지 않는다 — 엔진은 계획이 없을 뿐인 결과에 오류를 남기지 않으므로, 여기 있는 것은 AI가 응답하지 못한 일이다.
 * 계획이 0개라는 뜻일 뿐인 줄만 쉬운 보기에서 뺀다: 과정 카드의 'AI가 낸 계획이 없어요 (…)'가 이미 말한다 (같은 말 두 번).
 */
function Errors({ a, easy }: { a: AnalysisDetail; easy: boolean }) {
  const list = easy ? a.errors.filter((e) => !(a.scenarios.length === 0 && isNoScenarioNote(e))).map(analysisErrorEasy) : a.errors;
  if (list.length === 0) return null;
  return (
    <Card aria-label={easy ? "참고" : "오류"}>
      <h2 className={cn("text-[15px] font-semibold", easy ? "text-sub" : "text-up-ink")}>{easy ? "참고" : "분석 중 오류"}</h2>
      <ul className="mt-1 list-disc pl-5 text-[14px] text-sub">
        {list.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </Card>
  );
}

export function AnalysisPage() {
  const { id } = useParams();
  const aid = Number(id);
  const { easy } = useViewMode();
  const { data: a, isPending, isError, error, refetch, isFetching } = useAnalysis(aid);
  const { data: quotes, isPending: quotePending } = useQuotes(a ? [a.symbol] : []);
  const quote = a ? quotes?.get(a.symbol) : undefined;
  // 기다린 끝에 내용이 왔을 때만 한 번 페이드 (early return보다 앞에서 부른다)
  const reveal = useRevealAfterLoading(isPending);
  // 링크로 바로 들어와 앱 안에 이전 화면이 없으면 '뒤로'는 교차검증 분석 목록으로
  const backTo = "/reports?list=analyses";

  // 숫자가 아닌 주소는 요청하지 않으므로 끝없이 기다리지 않고 바로 '찾을 수 없음'
  if (!Number.isFinite(aid) || (isError && error instanceof ApiError && error.status === 404)) {
    return (
      <>
        <PageHeader title="AI 교차검증 분석" back={backTo} />
        <Card>
          <EmptyState icon="sparkle" title={easy ? "분석을 찾을 수 없어요" : "분석을 찾을 수 없습니다."} action={{ label: "교차검증 분석 목록으로", to: backTo }}>
            {easy ? "지워졌거나 주소가 틀렸을 수 있어요." : "지워졌거나 주소가 틀렸을 수 있습니다."}
          </EmptyState>
        </Card>
      </>
    );
  }
  if (isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-40" />} docTitle="AI 교차검증 분석" back={backTo} />
        <div className="space-y-3">
          <SkeletonCard lines={6} />
          <SkeletonCard lines={3} />
        </div>
      </>
    );
  }
  if (isError) {
    return (
      <>
        <PageHeader title="AI 교차검증 분석" back={backTo} />
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
        </Card>
      </>
    );
  }

  const scenarios = [...a.scenarios].sort((x, y) => Number(y.selected) - Number(x.selected) || (y.score ?? 0) - (x.score ?? 0));
  const intraday = duringSession(a.analyzedAt, a.market);

  return (
    <>
      <PageHeader title={`${a.name} AI 교차검증 분석`} back={backTo} />
      {/* grid-cols-1(= minmax(0,1fr)): 긴 내용이 열을 밀어 모바일 화면이 가로로 넘치지 않게 */}
      <div className={cn("grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px] lg:items-start lg:gap-6", reveal && "reveal-fade")}>
        <div className="min-w-0 space-y-3">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[14px] text-mute">
                  {a.symbol} · {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)} 요청
                </p>
                {quote?.price != null ? (
                  <>
                    <p className="mt-1 flex items-baseline gap-2">
                      <span className="text-[14px] font-semibold text-sub">{quotePriceName(quote.basis, easy)}</span>
                      <span className="text-[26px] font-bold tabular-nums">
                        <Flash value={quote.price}>{formatPrice(quote.price, a.currency)}</Flash>
                      </span>
                    </p>
                    <PriceChange change={quote.change} rate={quote.changeRate} currency={a.currency} className="text-[14px] font-semibold" />
                    <AsOf at={quote.asOf} market={a.market} basis={quote.basis} className="block" />
                  </>
                ) : quotePending ? (
                  <Skeleton className="mt-2 h-8 w-40" />
                ) : (
                  // 시세를 받지 못했을 때: 분석 시각 가격임을 밝힌다 (현재가·장마감 종가로 읽히지 않게)
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
                    a.verdict === "BUY" ? "bg-brand-soft text-brand-ink" : "bg-fill text-sub",
                  )}
                >
                  {a.verdict === "BUY" ? "통과한 계획 있음" : "통과한 계획 없음"}
                </span>
              ) : (
                <VerdictText verdict={a.verdict} className="h-8 px-3 text-[15px]" />
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
                className="press mt-4 flex h-12 items-center justify-center rounded-xl bg-fill text-[16px] font-bold text-ink hover:bg-line"
              >
                종목 화면으로
              </Link>
            ) : (
              <Link
                to={`/stocks/${encodeURIComponent(a.symbol)}?analysis=${a.id}`}
                className="press mt-4 flex h-12 items-center justify-center rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark"
              >
                이 종목 주문하기
              </Link>
            )}
          </Card>

          <Process a={a} easy={easy} />

          <SourceRecommendations source="analysis" sourceId={a.id} />

          {/* 계획이 없으면 위 과정 카드가 이미 말했다 — 같은 말을 묶음 하나로 되풀이하지 않는다 */}
          {scenarios.length > 0 && (
            <>
              <h2 className="px-1 pt-2 text-[17px] font-bold">{easy ? `AI별 계획 ${a.scenarioCount}개` : `시나리오 ${a.scenarioCount}개`}</h2>
              {scenarios.map((s, i) => (
                <ScenarioCard key={`${s.proposer}-${i}`} s={s} currency={a.currency} easy={easy} />
              ))}
            </>
          )}

          <Errors a={a} easy={easy} />
        </div>

        <div className="min-w-0 space-y-3">
          <News a={a} />

          <Card aria-labelledby="research-title">
            <h2 id="research-title" className="text-[17px] font-bold">
              웹 조사
            </h2>
            {a.research.length === 0 && <p className="mt-2 text-[14px] text-mute">조사 결과가 없습니다.</p>}
            {a.research.map((r, i) => (
              <div key={`${r.researcher}-${i}`} className="mt-3">
                <h3 className="text-[14px] font-semibold text-sub">{nameOf(r.researcher, easy)}</h3>
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

          <Indicators a={a} easy={easy} />
        </div>
      </div>
    </>
  );
}
