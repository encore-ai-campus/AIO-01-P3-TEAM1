import { Link } from "react-router";
import type { AnalysisSummary, Quote } from "../api/types";
import { formatDateTime, formatPercent, formatPrice, formatRate, formatRequester, trendClass } from "../lib/format";
import { Flash, VerdictBadge } from "./ui";

/** AI 분석 종목 대시보드의 카드. 누르면 종목 상세로 (분석의 목표·손절을 주문 패널에 채워 준다). */
export function AnalysisCard({ a, quote }: { a: AnalysisSummary; quote?: Quote }) {
  const price = quote?.price ?? null;
  const best = a.best;
  return (
    <Link
      to={`/stocks/${encodeURIComponent(a.symbol)}?analysis=${a.id}`}
      className="block rounded-2xl bg-card p-5 transition-colors hover:bg-[#fafbfc] active:bg-fill"
    >
      <article aria-label={`${a.name} AI 분석`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-[17px] font-bold">{a.name}</h3>
            <p className="text-[13px] text-mute">
              {a.symbol} · {a.market === "KR" ? "국내" : "미국"}
            </p>
          </div>
          <VerdictBadge verdict={a.verdict} />
        </div>

        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 tabular-nums">
          <span className="text-[20px] font-bold">
            <Flash value={price}>{formatPrice(price ?? a.priceAtAnalysis, a.currency)}</Flash>
          </span>
          <span className={`text-[14px] font-semibold ${trendClass(quote?.changeRate)}`}>{formatRate(quote?.changeRate)}</span>
        </p>

        {best ? (
          <>
            <p className="mt-2 text-[13px] text-sub">
              점수 <b className="font-semibold text-ink tabular-nums">{best.score ?? "-"}</b>
              <span className="mx-1.5 text-line">|</span>
              확률 <b className="font-semibold text-ink tabular-nums">{formatPercent(best.probability)}</b>
              <span className="mx-1.5 text-line">|</span>
              시나리오 {a.scenarioCount}개
            </p>
            <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-fill p-3 text-center">
              <div>
                <dt className="text-[12px] text-mute">진입</dt>
                <dd className="text-[13px] font-semibold tabular-nums">{formatPrice(best.entryPrice, a.currency)}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-mute">목표</dt>
                <dd className="text-[13px] font-semibold tabular-nums text-up">{formatPrice(best.targetPrice, a.currency)}</dd>
              </div>
              <div>
                <dt className="text-[12px] text-mute">손절</dt>
                <dd className="text-[13px] font-semibold tabular-nums text-down">{formatPrice(best.stopPrice, a.currency)}</dd>
              </div>
            </dl>
          </>
        ) : (
          <p className="mt-3 rounded-xl bg-fill p-3 text-[13px] text-mute">조건에 맞는 시나리오가 없었습니다.</p>
        )}

        <p className="mt-3 text-[12px] text-mute">
          {formatDateTime(a.analyzedAt)} · {formatRequester(a.requestedBy)} 요청
        </p>
      </article>
    </Link>
  );
}
