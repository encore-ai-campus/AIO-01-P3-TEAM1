// 랭킹 카드 (홈·마이). 랭킹이 하단 탭에서 빠져서 이 카드가 /ranking의 입구다.
// 수익률은 장마감 기준 평가 (Ranking.pricesAsOf).
import { Link } from "react-router";
import { useRanking } from "../../api/queries";
import { cn } from "../../lib/cn";
import { PricesAsOfLine } from "../AssetCard";
import { Icon } from "../Icon";
import { Card, RateText, SkeletonCard } from "../ui";

const MEDAL = ["bg-[#FFC342] text-white", "bg-[#B0B8C1] text-white", "bg-[#D9A47A] text-white"];

export function RankingCard({ className }: { className?: string }) {
  const { data, isPending, isError } = useRanking();
  if (isPending) return <SkeletonCard lines={3} className={className} />;
  if (isError) return null; // 랭킹 화면에서 다시 시도할 수 있다
  const top = data.results.slice(0, 3);
  return (
    <Card aria-labelledby="ranking-card-title" className={className}>
      <Link to="/ranking" className="-m-2 flex items-center justify-between rounded-xl p-2 hover:bg-fill/60">
        <h2 id="ranking-card-title" className="flex items-center gap-1.5 text-[17px] font-bold">
          <Icon name="trophy" className="size-5" />
          랭킹
        </h2>
        <span className="flex items-center gap-0.5 text-[14px] font-semibold text-mute">
          전체 순위
          <Icon name="chevron" className="size-4" />
        </span>
      </Link>
      <p className="mt-2 text-[15px]">
        {data.me.isPublic ? (
          <>
            내 순위 <b className="tabular-nums">{data.me.rank != null ? `${data.me.rank}위` : "-"}</b>
            <span className="text-mute"> · </span>
            <RateText rate={data.me.profitRate} className="font-semibold" />
          </>
        ) : (
          <span className="text-sub">마이에서 &lsquo;내 정보 공개&rsquo;를 켜면 랭킹에 나와요.</span>
        )}
      </p>
      {top.length > 0 && (
        <ol aria-label="랭킹 상위 3명" className="mt-3 space-y-1.5">
          {top.map((e) => (
            <li key={`${e.rank}-${e.nickname}`} className={cn("flex items-center gap-2.5 rounded-lg px-1 py-0.5", e.isMe && "bg-brand-soft")}>
              <span className={cn("grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-bold tabular-nums", MEDAL[e.rank - 1])}>
                {e.rank}
              </span>
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
