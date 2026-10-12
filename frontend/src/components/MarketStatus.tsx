// 장 상태 알약: 국내·미국이 지금 열렸나 + 마감·시작 시각 ('미국 닫힘 · 22:30 시작'처럼 짧게 — 두 칩이 한 줄에 들어가게).
// 홈(전문가 보기)과 PC 위 바(Layout)가 같이 쓴다. 평가 기준 시각과는 다른 정보라 자산 카드의 기준 시각 줄에 섞지 않는다.
// 받기 전에도 같은 폭의 자리를 둔다 (늦게 끼어들며 옆 요소를 밀지 않게).
import type { MarketStatus as MarketStatusData } from "../api/types";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { kstDay } from "./home/homeData";
import { LiveDot, Skeleton } from "./ui";

/** 장이 열리는 때: 오늘이면 시각만, 아니면 날짜까지. */
function opensText(iso: string) {
  const at = formatDateTime(iso);
  return kstDay(iso) === kstDay() ? at.split(" ")[1] : at;
}

/**
 * label: 목록 이름 — 한 화면에 둘이 함께 있을 수 있어(홈 + PC 위 바) 서로 다르게 준다.
 * surface: 칩 바탕 — 화면 바탕(bg) 위면 card, 카드 위면 fill.
 * nowrap: 한 줄로만 (높이가 정해진 위 바).
 */
export function MarketStatus({
  market,
  label = "정규장 상태",
  surface = "card",
  nowrap = false,
  className,
}: {
  market: MarketStatusData | undefined;
  label?: string;
  surface?: "card" | "fill";
  nowrap?: boolean;
  className?: string;
}) {
  const chip = surface === "card" ? "bg-card" : "bg-fill";
  if (!market) {
    return (
      <div aria-hidden="true" className={cn("flex gap-2", className)}>
        {/* 알약 모양: 모서리를 주면 Skeleton이 기본 rounded-lg를 뺀다 */}
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="h-8 w-40 rounded-full" />
      </div>
    );
  }
  return (
    <ul className={cn("flex gap-2", nowrap ? "flex-nowrap" : "flex-wrap", className)} aria-label={label}>
      {market.markets.map((m) => (
        <li
          key={m.market}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium whitespace-nowrap", chip, m.isOpen ? "text-ink" : "text-sub")}
        >
          {/* 열린 장은 몇 시간 이어지는 '진행 중'이라 퍼지는 점(LiveDot), 닫힌 장은 회색 점 */}
          {m.isOpen ? <LiveDot /> : <span aria-hidden="true" className="size-2 rounded-full bg-mute-weak" />}
          {m.market === "KR" ? "국내" : "미국"} {m.isOpen ? "열림" : "닫힘"}
          <span className="text-mute">
            {m.isOpen ? (m.closesAt ? `· ${formatDateTime(m.closesAt).split(" ")[1]} 마감` : "") : m.opensAt ? `· ${opensText(m.opensAt)} 시작` : ""}
          </span>
        </li>
      ))}
      {market.halted && <li className="inline-flex h-8 items-center rounded-full bg-warn-soft px-3 text-[13px] font-semibold whitespace-nowrap text-warn-ink">새 매수 중단</li>}
    </ul>
  );
}
