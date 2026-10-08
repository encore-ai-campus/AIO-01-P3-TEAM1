// 손절–진입–목표를 한 막대에 위치·퍼센트로 보이고 지금 가격(시세)을 표시한다 (CSS만).
// 산 뒤(fill)에는 가운데 기준점이 '산 가격'(전문가 보기 '체결가')이고 손절·목표 %도 산 가격 기준이다 — 사는 가격 기준 %는 실제 손절 거리를 숨긴다 (UX-3).
// 시세는 실시간이라 basis "live"면 표시는 "현재가"(easy는 "지금 가격"), 아니면 "종가"다 (기준 시각은 화면이 <AsOf>로 옆에 붙인다). easy면 쉬운 이름(사는 가격·목표 가격·손절 가격).
// 막대 위 표시와 아래 이름표를 같은 모양으로 잇는다: 손절 ●(파랑) · 사는 가격 ○(속 빈 원) · 목표 ●(빨강).
// 종가는 진한 세로선 + 말풍선이라, 속 빈 사는 가격 점과 섞이지 않는다 (trade-14).
import type { CSSProperties } from "react";
import type { Currency, QuoteBasis } from "../../api/types";
import { useChanged } from "../../hooks/useMotionState";
import { priceLadder } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatPrice, formatRate } from "../../lib/format";
import { quotePriceName } from "../../lib/plainText";

/**
 * 가격 글자: 원화는 숫자와 '원' 사이에서만 줄을 바꿀 수 있게 한다 (좁은 칸에서 7자리 가격이 옆 칸과 붙지 않게 — UX-16. 자릿수 중간은 갈라지지 않는다).
 */
export function WrapPrice({ value, currency }: { value: number | null | undefined; currency: Currency }) {
  const s = formatPrice(value ?? null, currency);
  if (!s.endsWith("원") || s.length < 2) return <>{s}</>;
  return (
    <>
      {s.slice(0, -1)}
      <wbr />원
    </>
  );
}

/**
 * 종가 말풍선을 자기 너비의 몇 %만큼 왼쪽으로 옮길지 (trade-r4). 막대 가운데 절반에서는 표시선 가운데(-50%),
 * 양 끝으로 갈수록 끝 정렬(0%·-100%)로 이어서 바꾼다 — 종가가 손절 아래·목표 위면 막대 끝(0%·100%)에 붙어,
 * 가운데 정렬로는 말풍선 절반이 카드·화면 밖으로 나간다 (360px에서 가로 스크롤). 말풍선이 막대 폭의 절반 이하면 어디서든 막대 안이다.
 * 세로 표시선은 실제 위치 그대로다.
 */
function bubbleShift(pos: number): number {
  if (pos < 25) return -2 * pos;
  if (pos > 75) return -50 - 2 * (pos - 75);
  return -50;
}

export function PriceLadder({
  stop,
  entry,
  target,
  fill = null,
  last,
  basis,
  currency,
  easy = false,
  reveal = false,
}: {
  stop: number;
  entry: number;
  target: number;
  /** 산 가격 (체결 뒤에만). 있으면 기준점과 손절·목표 %가 이 가격 기준이다. */
  fill?: number | null;
  /** 시세의 가격 (실시간 현재가, 못 받은 종목은 직전 장마감 종가. 없으면 표시하지 않는다). */
  last: number | null;
  /** last의 기준 (Quote.basis) — 이름("현재가"·"종가")을 고른다. 없으면 종가. */
  basis?: QuoteBasis;
  currency: Currency;
  easy?: boolean;
  /** 기다린 끝에 처음 그릴 때만 true: 두 구간이 사는 가격 점에서 양쪽으로 펴지고 종가 표시가 조금 늦게 나타난다 (캐시로 바로 그리면 움직이지 않는다). */
  reveal?: boolean;
}) {
  const bought = fill != null && fill > 0;
  const base = bought ? fill : entry;
  const l = priceLadder(stop, base, target, last);
  // 종가가 화면을 연 뒤에 도착하면(시세를 따로 받는 계획 상세) 그때도 살짝 나타난다
  const lateLast = useChanged(l.last !== null);
  const fadeLast = reveal || lateLast;
  const marks = [
    { key: "stop", label: easy ? "손절 가격" : "손절", price: stop, pos: l.stop, cls: "text-down", dot: "border-card bg-down", legend: "bg-down" },
    { key: "entry", label: bought ? (easy ? "산 가격" : "체결가") : easy ? "사는 가격" : "진입", price: base, pos: l.entry, cls: "text-ink", dot: "border-ink bg-card", legend: "border-[1.5px] border-ink bg-card" },
    { key: "target", label: easy ? "목표 가격" : "목표", price: target, pos: l.target, cls: "text-up", dot: "border-card bg-up", legend: "bg-up" },
  ];
  // 가격이 바뀌면(실시간 시세는 5초마다, 종가는 장마감 뒤 다음 날) 말풍선·세로선이 새 자리로 미끄러진다 (말풍선은 정렬도 함께)
  const lastMove = cn("transition-[left,translate,opacity] duration-base ease-standard", fadeLast && "starting:opacity-0 delay-150");
  // 두 구간은 사는 가격 점에서 바깥으로 펴진다 (손실 구간은 오른쪽 끝, 이익 구간은 왼쪽 끝이 축)
  const zone = cn("absolute inset-y-0 scale-x-100", reveal && "transition-[scale] duration-slow ease-enter starting:scale-x-0");
  return (
    <figure aria-label="가격 사다리" className="select-none">
      {/* 막대와 같은 좌우 여백(mx-1): 말풍선의 0%·100%가 표시선의 0%·100%와 같은 자리다 */}
      <div className="relative mx-1 h-8">
        {l.last !== null && last !== null && (
          <div
            className={cn("absolute top-0 translate-x-(--bubble-shift) text-center", lastMove)}
            style={{ left: `${l.last}%`, "--bubble-shift": `${bubbleShift(l.last)}%` } as CSSProperties}
          >
            <span className="block rounded-md bg-ink px-1.5 py-0.5 text-[11px] font-bold whitespace-nowrap text-on-ink tabular-nums">
              {quotePriceName(basis, easy)} {formatPrice(last, currency)}
            </span>
          </div>
        )}
      </div>
      <div className="relative mx-1 h-3 rounded-full bg-fill" aria-hidden="true">
        <div className={cn(zone, "origin-right rounded-l-full bg-down/25")} style={{ left: `${l.stop}%`, width: `${Math.max(0, l.entry - l.stop)}%` }} />
        <div className={cn(zone, "origin-left rounded-r-full bg-up/25")} style={{ left: `${l.entry}%`, width: `${Math.max(0, l.target - l.entry)}%` }} />
        {marks.map((m) => (
          <span key={m.key} className={cn("absolute top-1/2 size-3.5 -translate-1/2 rounded-full border-2", m.dot)} style={{ left: `${m.pos}%` }} />
        ))}
        {l.last !== null && <span className={cn("absolute -top-1 h-5 w-0.5 -translate-x-1/2 rounded bg-ink", lastMove)} style={{ left: `${l.last}%` }} />}
      </div>
      <ol className="mt-2 grid grid-cols-3 gap-1 text-[12px]">
        {marks.map((m, i) => (
          <li key={m.key} className={cn("min-w-0", i === 0 ? "text-left" : i === 1 ? "text-center" : "text-right")}>
            <span className="inline-flex items-center gap-1 text-mute">
              <span aria-hidden="true" className={cn("inline-block size-2 shrink-0 rounded-full", m.legend)} />
              {m.label}
            </span>
            <span className={cn("block text-[14px] font-semibold tabular-nums", m.cls)}>
              <WrapPrice value={m.price} currency={currency} />
            </span>
            {m.key !== "entry" && <span className={cn("block tabular-nums", m.cls)}>{formatRate(m.price / base - 1, 1)}</span>}
          </li>
        ))}
      </ol>
      {l.outside && (
        <figcaption className="mt-1 text-[12px] text-mute">
          {basis === "live" ? (easy ? "지금 가격이" : "현재가가") : "직전 종가가"}{" "}
          {l.outside === "below" ? (easy ? "손절 가격보다 낮아요" : "손절가보다 낮습니다") : easy ? "목표 가격보다 높아요" : "목표가보다 높습니다"}.
        </figcaption>
      )}
    </figure>
  );
}
