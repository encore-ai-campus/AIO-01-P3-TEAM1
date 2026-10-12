import type { ReactNode } from "react";
import { useAccount, usePlans } from "../api/queries";
import type { Market, PricesAsOf } from "../api/types";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatKrw, formatRate, formatSignedKrw, trendClass } from "../lib/format";
import { todayFillNote } from "../lib/orderText";
import { CardHeader, STRETCH_CARD } from "./home/CardHeader";
import { useShownCount } from "./home/homeHooks";
import { SectionError } from "./home/HomeStates";
import { AsOf, Card, Flash, Skeleton } from "./ui";

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

// PC(lg+): 카드 하나가 홈 맨 위 가로 요약이 된다 — 왼쪽 총자산·손익·기준 시각, 오른쪽 숫자 칸(StatGrid와 같은 모양: 13px 이름 위, 굵은 숫자 아래).
// 카드 안쪽이 1000px 이상(PC 1440px 이상의 홈)이면 한 줄, 그보다 좁으면(1024~1439px) 총자산 아래 숫자 칸 한 줄. 모바일은 이름 · 값 행 그대로.
// 같은 숫자를 PC용으로 한 벌 더 그리지 않는다 (한 DOM을 CSS로만 바꾼다 — 화면 읽기·테스트가 같은 것을 읽는다).
/** 총자산 덩어리와 숫자 칸을 가로로 놓는 감싸개 (카드 @container 기준). */
const ASSET_BODY = "@min-[1000px]:grid @min-[1000px]:grid-cols-[minmax(0,auto)_minmax(0,1fr)] @min-[1000px]:items-center @min-[1000px]:gap-x-10";
/** 숫자 칸 목록: 모바일은 구분선 아래 행, PC는 칸, 넓으면 총자산 오른쪽 세로 구분선 뒤. */
const ASSET_STATS =
  "mt-4 border-t border-line pt-3 lg:grid lg:grid-cols-[repeat(auto-fit,minmax(132px,1fr))] lg:gap-x-6 lg:gap-y-4 lg:pt-4 @min-[1000px]:mt-0 @min-[1000px]:border-t-0 @min-[1000px]:border-l @min-[1000px]:py-2 @min-[1000px]:pl-10";
/** 한 칸: 모바일은 ui Row와 같은 '이름 · 값' 한 줄, PC는 이름 위·숫자 아래. */
const ASSET_ITEM = "items-center justify-between gap-3 py-1.5 text-[15px] lg:block lg:py-0";

function AssetItem({ label, children, pcOnly = false }: { label: string; children: ReactNode; pcOnly?: boolean }) {
  return (
    <div className={cn(ASSET_ITEM, pcOnly ? "hidden" : "flex")}>
      <dt className="shrink-0 text-sub lg:text-[13px] lg:font-medium lg:text-mute">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink tabular-nums lg:mt-1 lg:truncate lg:text-left lg:text-[20px] lg:leading-tight lg:font-bold">
        {children}
      </dd>
    </div>
  );
}

/**
 * 실제 카드와 같은 모양 (제목 · 이름 · 큰 숫자 · 손익 · 기준 시각 · 구분선 · 행) — 받은 뒤 아래 내용이 밀리지 않게.
 * 줄 상자는 실제 줄과 같은 글자 크기의 한 줄 높이(h-lh)다. asOfLines: 기준 시각 줄 수 (지난번에 본 보유 시장 수 — 0이면 줄이 없다).
 * PC는 실제 카드와 같은 가로 배치 (같은 감싸개 클래스).
 */
function AssetSkeleton({ easy, asOfLines }: { easy: boolean; asOfLines: number }) {
  // 머리 28 · 이름 4+19.5 · 큰 숫자 35 · 손익 4+22.5 · 기준 시각 4+24씩 · 구분선 · 행 34.5씩
  return (
    <div role="group" aria-busy="true" aria-label="내 자산 불러오는 중" className="rounded-2xl bg-card p-5 @container">
      <div className="flex h-7 items-center">
        <Skeleton className="h-4 w-16" />
      </div>
      <div className={ASSET_BODY}>
        <div>
          <div className="mt-1 flex h-lh items-center text-[13px]">
            <Skeleton className="h-3.5 w-20" />
          </div>
          <div className="flex h-lh items-center text-[28px] leading-tight lg:text-[32px]">
            <Skeleton className="h-8 w-44 lg:w-56" />
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
        </div>
        <div className={ASSET_STATS}>
          {/* 마지막 칸은 PC에만 있는 '자동매매 진행 중' */}
          {Array.from({ length: (easy ? 3 : 4) + 1 }, (_, i) => (
            <div key={i} className={cn("h-[34.5px] items-center justify-between gap-3 lg:block lg:h-auto", i === (easy ? 3 : 4) ? "hidden" : "flex")}>
              <Skeleton className="h-4 w-16 lg:h-3.5" />
              <Skeleton className="h-4 w-28 lg:mt-1.5 lg:h-6" />
            </div>
          ))}
        </div>
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
  const activePlans = usePlans("active");
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
  // PC 요약 칸의 '자동매매 진행 중' 개수 (홈의 진행 중 섹션과 같은 요청·캐시). 모바일은 바로 아래 섹션이 보여 칸을 두지 않는다
  const running = activePlans.data ? `${activePlans.data.results.length}건` : "-";
  return (
    <Card aria-labelledby="asset-title" className={cn(STRETCH_CARD, "@container", reveal && "reveal-fade")}>
      <CardHeader id="asset-title" title="내 자산" to="/portfolio" quiet stretch />
      <div className={ASSET_BODY}>
        <div className="min-w-0">
          <p className="mt-1 text-[13px] text-mute">{easy ? "모의 계좌 총자산" : "총자산"}</p>
          <p className="text-[28px] leading-tight font-bold tracking-tight tabular-nums lg:text-[32px]">
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
        </div>
        {easy ? (
          <dl className={ASSET_STATS}>
            <AssetItem label="처음 자금">{formatKrw(acc.initialCapitalKrw)}</AssetItem>
            <AssetItem label="현금">{formatKrw(acc.cashKrw)}</AssetItem>
            <AssetItem label="주식 평가액">{formatKrw(acc.holdingsValueKrw)}</AssetItem>
            <AssetItem label="자동매매 진행 중" pcOnly>
              {running}
            </AssetItem>
          </dl>
        ) : (
          <dl className={ASSET_STATS}>
            <AssetItem label="투자금액">{formatKrw(acc.investedKrw)}</AssetItem>
            <AssetItem label="보유 평가액">{formatKrw(acc.holdingsValueKrw)}</AssetItem>
            <AssetItem label="현금">{formatKrw(acc.cashKrw)}</AssetItem>
            {acc.buyingPowerKrw !== null && <AssetItem label="매수 가능액">{formatKrw(acc.buyingPowerKrw)}</AssetItem>}
            <AssetItem label="자동매매 진행 중" pcOnly>
              {running}
            </AssetItem>
          </dl>
        )}
      </div>
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
