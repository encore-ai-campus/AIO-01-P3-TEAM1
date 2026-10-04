// 랭킹: 내 정보 공개를 켠 팀원의 수익률 순위. 수익률은 직전 장마감 종가로 평가한다 (Ranking.pricesAsOf).
// 하단 탭에서 빠져서 홈·마이의 랭킹 카드로 들어온다.
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useRanking } from "../api/queries";
import type { RankingEntry } from "../api/types";
import { PricesAsOfLine } from "../components/AssetCard";
import { Card, EmptyState, ErrorState, Flash, PageHeader, RateText, SkeletonCard } from "../components/ui";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";

const MEDAL = ["bg-[#FFC342] text-white", "bg-[#B0B8C1] text-white", "bg-[#D9A47A] text-white"];

function Entry({ e }: { e: RankingEntry }) {
  const top = e.rank <= 3;
  return (
    <li
      aria-current={e.isMe ? "true" : undefined}
      className={cn("flex items-center gap-3 px-5", top ? "py-4" : "py-3", e.isMe && "bg-brand-soft")}
    >
      <span
        className={cn(
          "grid shrink-0 place-items-center rounded-full font-bold tabular-nums",
          top ? cn("size-9 text-[16px]", MEDAL[e.rank - 1]) : "size-8 text-[15px] text-sub",
        )}
      >
        {e.rank}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", top ? "text-[17px] font-bold" : "text-[16px] font-medium")}>
        {e.nickname}
        {e.isMe && <span className="ml-1.5 rounded-md bg-brand px-1.5 py-0.5 align-middle text-[11px] font-bold text-white">나</span>}
      </span>
      <Flash value={e.profitRate}>
        <RateText rate={e.profitRate} className={cn("font-bold", top ? "text-[17px]" : "text-[15px]")} />
      </Flash>
    </li>
  );
}

export function RankingPage() {
  const { data, isPending, isError, error, refetch } = useRanking();
  return (
    <>
      <PageHeader title="랭킹" back />
      <div className="space-y-3 lg:max-w-[640px]">
        {isPending ? (
          <SkeletonCard lines={6} />
        ) : isError ? (
          <Card>
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </Card>
        ) : (
          <>
            <Card aria-label="내 순위">
              {data.me.isPublic ? (
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-[14px] text-sub">내 순위</p>
                    <p className="text-[26px] font-bold tabular-nums">{data.me.rank != null ? `${data.me.rank}위` : "-"}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[14px] text-sub">수익률</p>
                    <RateText rate={data.me.profitRate} className="text-[20px] font-bold" />
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-[16px] font-semibold">마이에서 공개를 켜면 랭킹에 나옵니다</p>
                  <p className="mt-1 text-[14px] text-sub">
                    지금 내 수익률은 <RateText rate={data.me.profitRate} className="font-semibold" />이고, 다른 팀원에게는 보이지 않습니다.
                  </p>
                  <Link to="/my" className="mt-3 inline-flex h-11 items-center rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark">
                    마이로 가기
                  </Link>
                </div>
              )}
            </Card>

            <section aria-labelledby="rank-title" className="overflow-hidden rounded-2xl bg-card">
              <div className="px-5 pt-5 pb-2">
                <div className="flex items-baseline justify-between gap-3">
                  <h2 id="rank-title" className="text-[17px] font-bold">
                    수익률 순위
                  </h2>
                  <span className="text-[12px] text-mute">{formatDateTime(data.asOf)} 계산</span>
                </div>
                <PricesAsOfLine pricesAsOf={data.pricesAsOf} className="mt-0.5" />
              </div>
              {data.results.length === 0 ? (
                <EmptyState>아직 수익률을 공개한 팀원이 없습니다.</EmptyState>
              ) : (
                <ol className="pb-2" aria-label="랭킹 목록">
                  {data.results.map((e) => (
                    <Entry key={`${e.rank}-${e.nickname}`} e={e} />
                  ))}
                </ol>
              )}
            </section>
            <p className="px-1 text-[13px] text-mute">수익률 = 총자산 ÷ 초기 자금 − 1 (보유 종목은 직전 장마감 종가로 평가). 내 정보 공개를 켠 팀원만 나옵니다.</p>
          </>
        )}
      </div>
    </>
  );
}
