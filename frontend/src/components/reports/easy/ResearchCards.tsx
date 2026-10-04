// 조사 자료 요약 (시세 · 재무·공시 · 뉴스): 조사 AI 세 곳의 결과를 쉬운 말로. 지표는 눌러서 풀이(용어 사전).
// 시세 가격은 장마감 기준(MarketResult.asOf)일 때만 보인다 (asOf가 없거나 읽을 수 없으면 가격 없이 "자료 없음" — PDF와 같다). 뉴스는 제목·매체·날짜만 (링크 없음, docs/DECISIONS.md 13-3 약관 대응).
import type { ReactNode } from "react";
import type { Currency, Market } from "../../../api/types";
import { formatNumber, formatPrice } from "../../../lib/format";
import type { FundamentalView, MarketView, NewsView } from "../../../lib/reports";
import { Term } from "../../Term";
import { AsOf, Card } from "../../ui";

const num = (v: number | null, unit = "", digits = 1) => (v === null ? "-" : `${formatNumber(v, digits)}${unit}`);
/** MarketResult.asOf가 있고 날짜로 읽히는지 (선택 키라 validate가 null로 채울 수 있다). */
const validAsOf = (asOf: string | null): asOf is string => asOf !== null && !Number.isNaN(new Date(asOf).getTime());

function Metric({ label, value }: { label: ReactNode; value: string }) {
  return (
    <div className="rounded-xl bg-fill px-3 py-2">
      <dt className="text-[12px] text-mute">{label}</dt>
      <dd className="text-[16px] font-bold tabular-nums">{value}</dd>
    </div>
  );
}

export function ResearchCards({
  market,
  fundamental,
  news,
  marketCode,
  currency,
}: {
  market: MarketView | null;
  fundamental: FundamentalView | null;
  news: NewsView | null;
  marketCode: Market;
  currency: Currency;
}) {
  if (!market && !fundamental && !news) return null;
  return (
    <Card aria-labelledby="research-title" className="space-y-4">
      <h2 id="research-title" className="text-[17px] font-bold">
        조사 자료 요약
      </h2>
      {market && (
        <section aria-label="시세">
          <h3 className="text-[14px] font-bold text-sub">시세</h3>
          {validAsOf(market.asOf) ? (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 tabular-nums">
              {market.price !== null && market.price > 0 && (
                <>
                  <span className="text-[13px] text-sub">
                    <Term k="종가" />
                  </span>
                  <span className="text-[18px] font-bold">{formatPrice(market.price, currency)}</span>
                </>
              )}
              <AsOf at={market.asOf} market={marketCode} />
            </p>
          ) : (
            // 기준 시각을 모르면 그 가격이 종가인지 장중 가격인지 알 수 없어 가격을 보이지 않는다 (PDF _market_basis와 같다)
            <p className="mt-1 text-[12px] font-medium text-mute">시세 기준 시각: 자료 없음</p>
          )}
          {market.summary && <p className="mt-1 text-[15px] leading-snug">{market.summary}</p>}
          <dl className="mt-2 grid grid-cols-2 gap-2">
            <Metric label={<Term k="RSI" />} value={num(market.rsi)} />
            <Metric label={<Term k="변동성">하루 변동성</Term>} value={num(market.volatilityPct, "%")} />
          </dl>
        </section>
      )}
      {fundamental && (
        <section aria-label="재무·공시">
          <h3 className="text-[14px] font-bold text-sub">재무·공시</h3>
          {fundamental.summary && <p className="mt-1 text-[15px] leading-snug">{fundamental.summary}</p>}
          <dl className="mt-2 grid grid-cols-3 gap-2">
            <Metric label={<Term k="PER" />} value={num(fundamental.per, "배")} />
            <Metric label={<Term k="PBR" />} value={num(fundamental.pbr, "배")} />
            <Metric label={<Term k="ROE" />} value={num(fundamental.roe, "%")} />
          </dl>
          {fundamental.filings.length > 0 && (
            <>
              <p className="mt-2 text-[13px] font-semibold text-sub">
                최근 <Term k="공시" />
              </p>
              <ul aria-label="최근 공시" className="mt-1 space-y-1 text-[14px]">
                {fundamental.filings.map((f) => (
                  <li key={`${f.date}-${f.title}`} className="text-sub">
                    {f.title}
                    {f.date && <span className="text-mute"> · {f.date}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
      {news && (
        <section aria-label="뉴스">
          <h3 className="text-[14px] font-bold text-sub">뉴스</h3>
          {news.summary && <p className="mt-1 text-[15px] leading-snug">{news.summary}</p>}
          {news.headlines.length > 0 && (
            <ul aria-label="뉴스 제목" className="mt-2 space-y-1 text-[14px]">
              {news.headlines.map((h) => (
                <li key={`${h.date}-${h.title}`}>
                  {h.title}
                  <span className="text-mute">
                    {h.source && ` — ${h.source}`}
                    {h.date && ` · ${h.date}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[12px] text-mute">뉴스 제목: Google 뉴스 검색 결과(각 언론사)</p>
        </section>
      )}
    </Card>
  );
}
