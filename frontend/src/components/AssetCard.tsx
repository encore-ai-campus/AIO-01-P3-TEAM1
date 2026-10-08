import { useAccount } from "../api/queries";
import type { Market, PricesAsOf } from "../api/types";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatKrw, formatRate, formatSignedKrw, trendClass } from "../lib/format";
import { todayFillNote } from "../lib/orderText";
import { CardHeader, STRETCH_CARD } from "./home/CardHeader";
import { useShownCount } from "./home/homeHooks";
import { SectionError } from "./home/HomeStates";
import { AsOf, Card, Flash, Row, Skeleton } from "./ui";

const MARKETS: Market[] = ["KR", "US"];

/** 기준 시각을 보일 시장 (보유가 있는 시장만, 국내 → 미국). */
const asOfMarkets = (pricesAsOf: PricesAsOf | undefined) => MARKETS.filter((m) => pricesAsOf?.[m]);

/** 평가에 쓴 종가의 기준 시각 (보유가 있는 시장만, 국내 → 미국, 한 줄에 하나). 보유가 없으면 아무것도 그리지 않는다. */
export function PricesAsOfLine({ pricesAsOf, className }: { pricesAsOf: PricesAsOf | undefined; className?: string }) {
  const markets = asOfMarkets(pricesAsOf);
  if (markets.length === 0) return null;
  return (
    <p className={className}>
      {markets.map((m) => (
        <span key={m} className="block">
          {markets.length > 1 && <span className="text-[12px] text-mute">{m === "KR" ? "국내 " : "미국 "}</span>}
          <AsOf at={pricesAsOf?.[m]} market={m} />
        </span>
      ))}
    </p>
  );
}

/**
 * 실제 카드와 같은 모양 (제목 · 이름 · 큰 숫자 · 손익 · 기준 시각 · 구분선 · 행) — 받은 뒤 아래 내용이 밀리지 않게.
 * 줄 상자는 실제 줄과 같은 글자 크기의 한 줄 높이(h-lh)다. asOfLines: 기준 시각 줄 수 (지난번에 본 보유 시장 수 — 0이면 줄이 없다).
 */
function AssetSkeleton({ easy, asOfLines }: { easy: boolean; asOfLines: number }) {
  // 머리 28 · 이름 4+19.5 · 큰 숫자 35 · 손익 4+22.5 · 기준 시각 4+24씩 · 구분선 · 행 34.5씩
  return (
    <div role="group" aria-busy="true" aria-label="내 자산 불러오는 중" className="rounded-2xl bg-card p-5">
      <div className="flex h-7 items-center">
        <Skeleton className="h-4 w-16" />
      </div>
      <div className="mt-1 flex h-lh items-center text-[13px]">
        <Skeleton className="h-3.5 w-20" />
      </div>
      <div className="flex h-lh items-center text-[28px] leading-tight">
        <Skeleton className="h-8 w-44" />
      </div>
      <div className="mt-1 flex h-lh items-center text-[15px]">
        <Skeleton className="h-4 w-40" />
      </div>
      {asOfLines > 0 && (
        // 실제 줄(PricesAsOfLine)은 12px 글자를 기본 줄 높이(24px) 상자에 한 줄씩 둔다
        <div className="mt-1">
          {Array.from({ length: asOfLines }, (_, i) => (
            <div key={i} className="flex h-lh items-center">
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </div>
      )}
      <div className="mt-4 border-t border-line pt-3">
        {Array.from({ length: easy ? 3 : 4 }, (_, i) => (
          <div key={i} className="flex h-[34.5px] items-center justify-between gap-3">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 w-28" />
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * 홈의 내 자산 카드: 총자산, 손익·수익률, 투자금액·현금 (보유는 직전 장마감 종가로 평가 — 오늘 산 보유는 체결가, 기준 시각 아래 한 줄로 알린다).
 * easy(주린이모드)는 처음 자금 대비 손익과 현금·주식 평가액만 쉬운 이름으로 보인다.
 * 카드 전체가 모의투자 탭 링크다 (큰 숫자를 눌러 자세히 보려 한다). 기준 시각은 숫자 바로 아래 그대로 (장중 실시간으로 오해하지 않게).
 */
export function AssetCard({ easy = false }: { easy?: boolean }) {
  const { data: acc, isPending, isFetching, refetch } = useAccount();
  const reveal = useRevealAfterLoading(isPending);
  // 받기 전 기준 시각 자리: 지난번에 본 줄 수 (기억이 없으면 처음 쓰는 사람처럼 보유 없음 — 줄 없음)
  const asOfLines = useShownCount("asof", acc ? asOfMarkets(acc.pricesAsOf).length : undefined, 0);
  if (isPending) return <AssetSkeleton easy={easy} asOfLines={asOfLines} />;
  const todayNote = acc ? todayFillNote(acc.positions, easy) : null;
  if (!acc) {
    return (
      <Card aria-labelledby="asset-title">
        <CardHeader id="asset-title" title="내 자산" to="/portfolio" quiet />
        <SectionError bare className="mt-3" onRetry={() => void refetch()} retrying={isFetching} />
      </Card>
    );
  }
  return (
    <Card aria-labelledby="asset-title" className={cn(STRETCH_CARD, reveal && "reveal-fade")}>
      <CardHeader id="asset-title" title="내 자산" to="/portfolio" quiet stretch />
      <p className="mt-1 text-[13px] text-mute">{easy ? "모의 계좌 총자산" : "총자산"}</p>
      <p className="text-[28px] leading-tight font-bold tracking-tight tabular-nums">
        <Flash value={acc.equityKrw}>{formatKrw(acc.equityKrw)}</Flash>
      </p>
      <p className={`mt-1 text-[15px] font-semibold tabular-nums ${trendClass(acc.profitKrw)}`}>
        <Flash value={acc.profitRate}>
          {easy && <span className="font-medium text-sub">처음 자금보다 </span>}
          {formatSignedKrw(acc.profitKrw)} ({formatRate(acc.profitRate)})
        </Flash>
      </p>
      <PricesAsOfLine pricesAsOf={acc.pricesAsOf} className="mt-1" />
      {todayNote && <p className="mt-0.5 text-[12px] leading-snug text-mute">{todayNote}</p>}
      {easy ? (
        <dl className="mt-4 border-t border-line pt-3">
          <Row label="처음 자금">{formatKrw(acc.initialCapitalKrw)}</Row>
          <Row label="현금">{formatKrw(acc.cashKrw)}</Row>
          <Row label="주식 평가액">{formatKrw(acc.holdingsValueKrw)}</Row>
        </dl>
      ) : (
        <dl className="mt-4 border-t border-line pt-3">
          <Row label="투자금액">{formatKrw(acc.investedKrw)}</Row>
          <Row label="보유 평가액">{formatKrw(acc.holdingsValueKrw)}</Row>
          <Row label="현금">{formatKrw(acc.cashKrw)}</Row>
          {acc.buyingPowerKrw !== null && <Row label="매수 가능액">{formatKrw(acc.buyingPowerKrw)}</Row>}
        </dl>
      )}
      {acc.notes.length > 0 && (
        <ul className="mt-2 space-y-1 text-[13px] text-mute">
          {acc.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}
