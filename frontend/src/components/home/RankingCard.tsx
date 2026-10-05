// 랭킹 카드 (홈 — 쉬운 보기 오른쪽 열·전문가 보기 맨 아래. 마이는 내 성적 카드 안의 자체 랭킹 구역을 쓴다).
// 랭킹이 하단 탭에서 빠져서 이 카드가 /ranking의 입구다 — 오류가 나도 카드와 입구는 남긴다. 수익률은 장마감 기준 평가 (Ranking.pricesAsOf).
// 공개한 사람: 카드 전체가 /ranking 링크다. 비공개: '내 정보 공개' 안내 줄이 마이의 그 스위치(/my#public — 마이가 스크롤·강조)로 가는
// 링크라서, 카드 전체를 덮는 링크를 두지 않고 머리의 '전체 보기'만 /ranking으로 간다 (링크 안에 링크를 겹치지 않게).
import { Link } from "react-router";
import { useRanking } from "../../api/queries";
import { useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { PricesAsOfLine } from "../AssetCard";
import { Icon } from "../Icon";
import { Card, Medal, RateText, Skeleton } from "../ui";
import { CardHeader, STRETCH_CARD } from "./CardHeader";
import { SectionError } from "./HomeStates";

/** 실제 카드와 같은 모양 (머리 · 내 순위 · 상위 3명 · 기준 시각) — 받는 동안 높이가 출렁이지 않게. */
function RankingSkeleton({ className }: { className?: string }) {
  return (
    <div role="group" aria-busy="true" aria-label="불러오는 중" className={cn("rounded-2xl bg-card p-5", className)}>
      <Skeleton className="h-6 w-20" />
      <Skeleton className="mt-3 h-5 w-36" />
      <div className="mt-3 space-y-2.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-2.5 px-1">
            <Skeleton className="size-6 shrink-0 rounded-full" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="h-4 w-14" />
          </div>
        ))}
      </div>
      <Skeleton className="mt-3 h-3.5 w-48" />
    </div>
  );
}

export function RankingCard({ className }: { className?: string }) {
  const { data, isPending, isFetching, refetch } = useRanking();
  const reveal = useRevealAfterLoading(isPending);
  if (isPending) return <RankingSkeleton className={className} />;
  if (!data) {
    // 처음부터 받지 못했다: 카드와 /ranking 입구는 남기고 한 줄 오류
    return (
      <Card aria-labelledby="ranking-card-title" className={className}>
        <CardHeader id="ranking-card-title" icon="trophy" title="랭킹" to="/ranking" />
        <SectionError bare className="mt-3" onRetry={() => void refetch()} retrying={isFetching} />
      </Card>
    );
  }
  const top = data.results.slice(0, 3);
  const isPublic = data.me.isPublic;
  return (
    <Card aria-labelledby="ranking-card-title" className={cn(isPublic && STRETCH_CARD, reveal && "reveal-fade", className)}>
      <CardHeader id="ranking-card-title" icon="trophy" title="랭킹" to="/ranking" stretch={isPublic} />
      {isPublic ? (
        <p className="mt-2 text-[15px]">
          내 순위 <b className="tabular-nums">{data.me.rank != null ? `${data.me.rank}위` : "-"}</b>
          <span aria-hidden="true" className="text-mute-weak">
            {" · "}
          </span>
          <RateText rate={data.me.profitRate} className="font-semibold" />
        </p>
      ) : (
        // 누르는 자리는 44px. 글자 줄은 공개한 사람의 '내 순위' 줄과 같은 자리에 오게 위아래 여백을 줄인다
        <Link
          to="/my#public"
          className="press-row -mx-2 mt-1 -mb-2 flex min-h-11 items-center gap-0.5 rounded-xl px-2 text-[15px] text-sub hover:bg-fill/60"
        >
          마이에서 &lsquo;내 정보 공개&rsquo;를 켜면 랭킹에 나와요
          <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
        </Link>
      )}
      {top.length > 0 && (
        <ol aria-label="랭킹 상위 3명" className="mt-3 space-y-1.5">
          {top.map((e) => (
            <li key={`${e.rank}-${e.nickname}`} className={cn("flex items-center gap-2.5 rounded-lg px-1 py-0.5", e.isMe && "bg-brand-soft")}>
              <Medal rank={e.rank} size="sm" />
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{e.nickname}</span>
              <RateText rate={e.profitRate} className="text-[14px] font-semibold" />
            </li>
          ))}
        </ol>
      )}
      <PricesAsOfLine pricesAsOf={data.pricesAsOf} className="mt-2" />
    </Card>
  );
}
