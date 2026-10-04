// 오늘의 내 종목 뉴스 카드 (docs/API.md "장기투자" DailyMove). 홈(F-shell)이 쓴다.
//
// - 스스로 받는다: useDailyMoves(date) — 내가 보유 중인 국내 종목의 그날 기록. 기록이 없으면 빈 안내.
// - 쉬운 보기: 종목마다 세 숫자(시장(대용 ETF 기준) · 업종(자료 없음) · 내 종목) + headline + 설명 문장(최대 3개),
//   uncertain이면 "뚜렷한 소식을 찾지 못했어요", 근거(evidence)는 출처·시각과 함께 접어서.
// - 전문가 보기: 수치형 — 종목 등락률 · 시장 대용 ETF 등락률 · 시장 대비 초과 등락 · 20일 변동성 · 수급 비율 + 근거 목록(출처·시각·공시 원문 링크).
// - 늘 보이는 것: 고정 문구 DAILY_MOVE_CAPTION, "국내 종목만", 업종 자료 없음, 종가의 장마감 기준(AsOf).
// 숫자 분해는 회계식(β=1)이지 원인이 아니다 — 화면도 "때문에" 같은 말을 쓰지 않는다.
import { useId, useState } from "react";
import { errorMessage } from "../../api/client";
import { useDailyMoves } from "../../api/longterm";
import type { DailyMove, DailyMoveEvidence } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";
import { formatDateTime, formatDayLabel, formatKrw, formatPercent, formatRate } from "../../lib/format";
import { DAILY_MOVE_CAPTION, DAILY_MOVE_KR_ONLY, DAILY_MOVE_UNCERTAIN, SECTOR_MISSING } from "../../lib/plainText";
import { Term } from "../Term";
import { AsOf, ErrorState, RateText, Row, Skeleton } from "../ui";
import { EVIDENCE_KIND_TEXT, RELIABILITY_TEXT } from "./longtermText";

export interface DailyMoveCardProps {
  /** 기록 날짜 YYYY-MM-DD. 없으면 가장 최근 기록일 (홈 카드). */
  date?: string | null;
  /** 쉬운 보기(문장) · 전문가 보기(수치형). */
  view: ViewMode;
  /** 처음에 보일 종목 수 (홈 카드는 3). 없으면 전부. 넘는 종목은 "외 N종목 더 보기"로 펼친다. */
  limit?: number;
  className?: string;
}

function Evidence({ items, day, detailed }: { items: DailyMoveEvidence[]; day: string; detailed: boolean }) {
  return (
    <ul aria-label="같은 날 나온 소식" className="mt-2 space-y-2">
      {items.map((e) => (
        <li key={e.id} className="rounded-lg bg-fill px-3 py-2 text-[13px] leading-snug">
          <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-mute">
            {detailed && <span className="font-mono">{e.id}</span>}
            <span className="font-semibold text-sub">{EVIDENCE_KIND_TEXT[e.kind]}</span>
            <span>· {RELIABILITY_TEXT[e.reliability]}</span>
          </p>
          <p className="mt-0.5 text-ink">{e.text}</p>
          <p className="mt-0.5 text-[12px] text-mute">
            출처: {e.source} · {e.at ? formatDateTime(e.at) : `${formatDayLabel(day)} (날짜만)`}
            {e.url && (
              <>
                {" · "}
                <a href={e.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand underline">
                  공시 원문
                </a>
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

function Number3({ label, value, rate }: { label: string; value?: string; rate?: number | null }) {
  return (
    <div className="rounded-xl bg-fill px-2.5 py-2">
      <dt className="text-[12px] leading-tight text-mute">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-bold tabular-nums">{value ?? <RateText rate={rate} />}</dd>
    </div>
  );
}

function EasyMove({ m }: { m: DailyMove }) {
  return (
    <>
      <dl aria-label={`${m.name} 세 숫자`} className="mt-2 grid grid-cols-3 gap-2 text-center">
        <Number3 label={`시장(${m.marketProxy.name} 기준)`} rate={m.marketProxy.changeRate} />
        <Number3 label="업종" value={SECTOR_MISSING.replace("업종 ", "")} />
        <Number3 label="내 종목" rate={m.changeRate} />
      </dl>
      <p className="mt-3 text-[15px] font-bold leading-snug">{m.headline}</p>
      <ul className="mt-1 space-y-1 text-[14px] leading-relaxed text-sub">
        {m.summary.slice(0, 3).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      {m.uncertain && <p className="mt-2 rounded-lg bg-fill px-3 py-2 text-[13px] text-sub">{DAILY_MOVE_UNCERTAIN}</p>}
      {m.evidence.length > 0 && (
        <details className="mt-2">
          <summary className="cursor-pointer text-[13px] font-semibold text-sub">같은 날 나온 소식 {m.evidence.length}개 (출처·시각)</summary>
          <Evidence items={m.evidence} day={m.date} detailed={false} />
        </details>
      )}
    </>
  );
}

function ExpertMove({ m }: { m: DailyMove }) {
  const flows = m.flows;
  const flow = (v: number | null | undefined) => formatRate(v ?? null, 1);
  return (
    <>
      <dl aria-label={`${m.name} 등락 분해`} className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <Row label="종목 등락률">
          <RateText rate={m.changeRate} />
        </Row>
        <Row label={`시장 (${m.marketProxy.name} 기준)`}>
          <RateText rate={m.marketProxy.changeRate} />
        </Row>
        <Row label={<Term k="초과 등락">시장 대비 초과 등락</Term>}>
          {m.excessChangeRate === null ? "-" : `${formatRate(m.excessChangeRate)}p`}
        </Row>
        <Row label="업종">{SECTOR_MISSING.replace("업종 ", "")}</Row>
        <Row label={<Term k="변동성">20일 변동성</Term>}>{formatPercent(m.volatility20, 2)}</Row>
        <Row label="종가 (전일)">
          {formatKrw(m.close)} ({formatKrw(m.prevClose)})
        </Row>
      </dl>
      <div className="mt-2">
        <p className="text-[13px] font-semibold text-sub">
          <Term k="수급" /> (순매수 ÷ 거래량)
        </p>
        {flows ? (
          <p className="mt-0.5 text-[14px] tabular-nums">
            외국인 {flow(flows.foreign)} · 기관 {flow(flows.institution)} · 개인 {flow(flows.individual)}
          </p>
        ) : (
          <p className="mt-0.5 text-[13px] text-mute">수급 자료 없음</p>
        )}
      </div>
      <p className="mt-3 text-[15px] font-bold leading-snug">{m.headline}</p>
      <ul className="mt-1 space-y-1 text-[14px] leading-relaxed text-sub">
        {m.summary.slice(0, 3).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <p className="mt-1 text-[12px] text-mute">
        {m.method === "llm" ? `AI 설명 (검사 통과) · 근거 ${m.drivers.join(", ") || "-"}` : "정해진 문장 (AI 설명 아님)"}
        {m.uncertain && ` · ${DAILY_MOVE_UNCERTAIN}`}
      </p>
      {m.evidence.length > 0 ? <Evidence items={m.evidence} day={m.date} detailed /> : <p className="mt-2 text-[13px] text-mute">근거 자료 없음</p>}
      {m.missing.length > 0 && (
        <ul aria-label="비운 칸" className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-mute">
          {m.missing.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
    </>
  );
}

export function DailyMoveCard({ date = null, view, limit, className }: DailyMoveCardProps) {
  const q = useDailyMoves(date);
  const expert = view === "expert";
  const [expanded, setExpanded] = useState(false);
  const all = q.data?.results ?? [];
  const shown = limit && !expanded ? all.slice(0, limit) : all;
  const day = q.data?.date ?? date;
  const titleId = useId();

  return (
    <section aria-labelledby={titleId} className={cn("rounded-2xl bg-card p-5", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={titleId} className="text-[17px] font-bold">
          오늘의 내 종목 뉴스
          {day && <span className="ml-1.5 text-[14px] font-semibold text-mute">{formatDayLabel(day)}</span>}
        </h2>
        <span className="inline-flex h-6 items-center rounded-md bg-fill px-2 text-[12px] font-bold text-sub">{DAILY_MOVE_KR_ONLY}</span>
      </div>

      {q.isPending ? (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="불러오는 중">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : all.length === 0 ? (
        <p className="py-6 text-center text-[14px] leading-relaxed text-mute">
          보유 중인 국내 종목의 기록이 아직 없어요.
          <br />
          국내 거래일 장 마감 뒤(16:30 이후)에 만들어져요.
        </p>
      ) : (
        <ul className="mt-2 divide-y divide-line">
          {shown.map((m) => (
            <li key={m.symbol} className="py-3">
              <article aria-label={`${m.name} 오늘의 뉴스`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className="text-[16px] font-bold">
                    {m.name} <span className="text-[13px] font-normal text-mute">{m.symbol}</span>
                  </p>
                  <p className="text-[14px] tabular-nums">
                    종가 {formatKrw(m.close)} <RateText rate={m.changeRate} className="text-[13px]" />
                  </p>
                </div>
                <AsOf at={m.asOf} />
                {expert ? <ExpertMove m={m} /> : <EasyMove m={m} />}
              </article>
            </li>
          ))}
        </ul>
      )}
      {shown.length < all.length && (
        // 알림(오늘의 내 종목 뉴스)은 홈으로 온다 — 나머지 종목도 여기서 펼쳐 볼 수 있게
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="h-10 w-full rounded-xl bg-fill text-[14px] font-semibold text-sub hover:bg-line"
        >
          외 {all.length - shown.length}종목 더 보기
        </button>
      )}
      <p className="mt-3 border-t border-line pt-3 text-[12px] leading-snug text-mute">{DAILY_MOVE_CAPTION}</p>
    </section>
  );
}
