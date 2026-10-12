// 조사 자료 요약 (시세 · 재무·공시 · 뉴스): 조사 AI 세 곳의 결과를 쉬운 말로. 지표는 눌러서 풀이(용어 사전).
// 지표 칸(RSI·하루 변동성·PER·PBR·ROE)은 처음 보는 사람에게 어려운 숫자라 맨 아래 "어려운 숫자 보기"로 접어 둔다 (UX-4). AI가 쓴 요약은 용어 풀이를 붙여 그린다(AiText).
// 시세 가격은 기준 시각(MarketResult.asOf)이 있을 때만 보인다 (asOf가 없거나 읽을 수 없으면 가격 없이 "자료 없음" — PDF와 같다).
// 리포트를 장 중에 만들었으면(basis live) "장중 가격 … · 10월 8일(목) 15:23 기준", 아니면 "종가 … · … 장마감 기준" (docs/API.md "리포트 시세").
// 뉴스는 제목·매체·날짜만 (링크 없음, docs/DECISIONS.md 13-3 약관 대응).
// 쉬운 PDF(backend/reports/output/pdf.py 쉬운 판)도 같은 칸·문장을 쓴다 — 바꾸면 둘 다 고친다
import { type ReactNode, useId, useState } from "react";
import type { Currency, Market } from "../../../api/types";
import { cn } from "../../../lib/cn";
import { formatIntradayAsOf, formatNumber, formatPrice } from "../../../lib/format";
import type { FundamentalView, MarketView, NewsView } from "../../../lib/reports";
import { Icon } from "../../Icon";
import { Collapse } from "../../motion/Collapse";
import { Term } from "../../Term";
import { AsOf, Card } from "../../ui";
import { AiText } from "./AiText";

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
                  {market.basis === "live" ? (
                    <span className="text-[13px] text-sub">장중 가격</span>
                  ) : (
                    <span className="text-[13px] text-sub">
                      <Term k="종가" />
                    </span>
                  )}
                  <span className="text-[18px] font-bold">{formatPrice(market.price, currency)}</span>
                </>
              )}
              {market.basis === "live" ? (
                <time dateTime={market.asOf} className="text-[12px] font-medium text-mute tabular-nums">
                  {formatIntradayAsOf(market.asOf, marketCode)}
                </time>
              ) : (
                <AsOf at={market.asOf} market={marketCode} />
              )}
            </p>
          ) : (
            // 기준 시각을 모르면 그 가격이 종가인지 장중 가격인지 알 수 없어 가격을 보이지 않는다 (PDF _market_basis와 같다)
            <p className="mt-1 text-[12px] font-medium text-mute">시세 기준 시각: 자료 없음</p>
          )}
          {market.summary && (
            <p className="mt-1 text-[15px] leading-snug">
              <AiText text={market.summary} />
            </p>
          )}
        </section>
      )}
      {fundamental && (
        <section aria-label="재무·공시">
          <h3 className="text-[14px] font-bold text-sub">재무·공시</h3>
          {fundamental.summary && (
            <p className="mt-1 text-[15px] leading-snug">
              <AiText text={fundamental.summary} />
            </p>
          )}
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
          {news.summary && (
            <p className="mt-1 text-[15px] leading-snug">
              <AiText text={news.summary} />
            </p>
          )}
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
      <HardNumbers market={market} fundamental={fundamental} />
    </Card>
  );
}

/** 지표 칸 (접힘): 시세 지표(RSI·하루 변동성)와 재무 지표(PER·PBR·ROE). 지표가 없으면 그리지 않는다. 이름은 눌러서 풀이. */
function HardNumbers({ market, fundamental }: { market: MarketView | null; fundamental: FundamentalView | null }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!market && !fundamental) return null;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="press -ml-1.5 inline-flex h-11 items-center gap-1 rounded-lg px-1.5 text-[14px] font-semibold text-brand-ink hover:bg-fill"
      >
        어려운 숫자 보기
        <Icon name="chevron-down" className={cn("size-4 transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id={id} className="mt-1">
        <div className="space-y-2">
          {market && (
            <dl aria-label="시세 지표" className="grid grid-cols-2 gap-2">
              <Metric label={<Term k="RSI" />} value={num(market.rsi)} />
              <Metric label={<Term k="변동성">하루 변동성</Term>} value={num(market.volatilityPct, "%")} />
            </dl>
          )}
          {fundamental && (
            <dl aria-label="재무 지표" className="grid grid-cols-3 gap-2">
              <Metric label={<Term k="PER" />} value={num(fundamental.per, "배")} />
              <Metric label={<Term k="PBR" />} value={num(fundamental.pbr, "배")} />
              <Metric label={<Term k="ROE" />} value={num(fundamental.roe, "%")} />
            </dl>
          )}
        </div>
      </Collapse>
    </div>
  );
}
