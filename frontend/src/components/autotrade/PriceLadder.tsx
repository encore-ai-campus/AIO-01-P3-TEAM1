// 손절–진입–목표를 한 막대에 위치·퍼센트로 보이고 직전 종가를 표시한다 (CSS만).
// 가격은 장마감 기준이라 표시는 "종가"다 (기준 시각은 화면이 <AsOf>로 옆에 붙인다). easy면 쉬운 이름(사는 가격·목표 가격·손절 가격).
import type { Currency } from "../../api/types";
import { priceLadder } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatPrice, formatRate } from "../../lib/format";

export function PriceLadder({
  stop,
  entry,
  target,
  last,
  currency,
  easy = false,
}: {
  stop: number;
  entry: number;
  target: number;
  /** 직전 장마감 종가 (없으면 표시하지 않는다). */
  last: number | null;
  currency: Currency;
  easy?: boolean;
}) {
  const l = priceLadder(stop, entry, target, last);
  const marks = [
    { key: "stop", label: easy ? "손절 가격" : "손절", price: stop, pos: l.stop, cls: "text-down", dot: "bg-down" },
    { key: "entry", label: easy ? "사는 가격" : "진입", price: entry, pos: l.entry, cls: "text-ink", dot: "bg-ink" },
    { key: "target", label: easy ? "목표 가격" : "목표", price: target, pos: l.target, cls: "text-up", dot: "bg-up" },
  ];
  return (
    <figure aria-label="가격 사다리" className="select-none">
      <div className="relative h-8">
        {l.last !== null && last !== null && (
          <div className="absolute top-0 -translate-x-1/2 text-center" style={{ left: `${l.last}%` }}>
            <span className="block rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap text-white tabular-nums">
              종가 {formatPrice(last, currency)}
            </span>
          </div>
        )}
      </div>
      <div className="relative mx-1 h-3 rounded-full bg-fill" aria-hidden="true">
        <div
          className="absolute inset-y-0 rounded-l-full bg-down/25"
          style={{ left: `${l.stop}%`, width: `${Math.max(0, l.entry - l.stop)}%` }}
        />
        <div
          className="absolute inset-y-0 rounded-r-full bg-up/25"
          style={{ left: `${l.entry}%`, width: `${Math.max(0, l.target - l.entry)}%` }}
        />
        {marks.map((m) => (
          <span key={m.key} className={cn("absolute top-1/2 size-3.5 -translate-1/2 rounded-full border-2 border-card", m.dot)} style={{ left: `${m.pos}%` }} />
        ))}
        {l.last !== null && (
          <span className="absolute -top-1 h-5 w-0.5 -translate-x-1/2 rounded bg-ink" style={{ left: `${l.last}%` }} />
        )}
      </div>
      <ol className="mt-2 grid grid-cols-3 gap-1 text-[12px]">
        {marks.map((m, i) => (
          <li key={m.key} className={cn(i === 0 ? "text-left" : i === 1 ? "text-center" : "text-right")}>
            <span className="text-mute">{m.label}</span>
            <span className={cn("block text-[14px] font-semibold tabular-nums", m.cls)}>{formatPrice(m.price, currency)}</span>
            {m.key !== "entry" && <span className={cn("block tabular-nums", m.cls)}>{formatRate(m.price / entry - 1, 1)}</span>}
          </li>
        ))}
      </ol>
      {l.outside && (
        <figcaption className="mt-1 text-[12px] text-mute">
          직전 종가가 {l.outside === "below" ? (easy ? "손절 가격보다 낮아요" : "손절가보다 낮습니다") : easy ? "목표 가격보다 높아요" : "목표가보다 높습니다"}.
        </figcaption>
      )}
    </figure>
  );
}
