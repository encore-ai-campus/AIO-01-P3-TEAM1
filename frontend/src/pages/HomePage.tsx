import { useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useAnalyses, useMarket, useQuotes } from "../api/queries";
import type { MarketStatus } from "../api/types";
import { AnalysisCard } from "../components/AnalysisCard";
import { AssetCard } from "../components/AssetCard";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, PageHeader, Segmented, SkeletonCard } from "../components/ui";
import { cn } from "../lib/cn";
import { dashboardOrder } from "../lib/dashboard";
import { formatDateTime } from "../lib/format";

type Filter = "ALL" | "BUY";

function MarketChips({ market }: { market: MarketStatus | undefined }) {
  if (!market) return null;
  return (
    <ul className="flex flex-wrap gap-2" aria-label="정규장 상태">
      {market.markets.map((m) => (
        <li
          key={m.market}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium",
            m.isOpen ? "bg-up-soft text-up" : "bg-card text-sub",
          )}
        >
          <span className={cn("size-1.5 rounded-full", m.isOpen ? "bg-up" : "bg-mute")} aria-hidden="true" />
          {m.market === "KR" ? "국내" : "미국"} {m.isOpen ? "장 열림" : "장 닫힘"}
          <span className="text-mute">
            {m.isOpen ? (m.closesAt ? `· ${formatDateTime(m.closesAt).split(" ")[1]} 마감` : "") : m.opensAt ? `· ${formatDateTime(m.opensAt)} 시작` : ""}
          </span>
        </li>
      ))}
      {market.halted && <li className="inline-flex h-8 items-center rounded-full bg-warn-soft px-3 text-[13px] font-medium text-[#9a5b00]">새 매수 중단</li>}
    </ul>
  );
}

function Dashboard() {
  const [filter, setFilter] = useState<Filter>("ALL");
  const { data, isPending, isError, error, refetch } = useAnalyses(filter === "BUY" ? { verdict: "BUY" } : {});
  const list = dashboardOrder(data?.results ?? []);
  const { data: quotes } = useQuotes(list.map((a) => a.symbol));

  return (
    <section aria-labelledby="dash-title" className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 id="dash-title" className="text-[19px] font-bold">
          AI 분석 종목
        </h2>
        <Segmented
          label="분석 필터"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "ALL", label: "전체" },
            { value: "BUY", label: "BUY" },
          ]}
        />
      </div>
      {isPending ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={4} />
        </div>
      ) : isError ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : list.length === 0 ? (
        <div className="rounded-2xl bg-card">
          <EmptyState>{filter === "BUY" ? "BUY 판정을 받은 종목이 아직 없습니다." : "아직 분석한 종목이 없습니다. 종목 상세에서 AI 분석을 요청해 보세요."}</EmptyState>
        </div>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {list.map((a) => (
            <li key={a.id}>
              <AnalysisCard a={a} quote={quotes?.get(a.symbol)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function HomePage() {
  const { data: market } = useMarket();
  return (
    <>
      <PageHeader
        title="홈"
        right={
          <Link to="/search" aria-label="종목 검색" className="grid size-11 place-items-center rounded-full hover:bg-line/60 lg:hidden">
            <Icon name="search" />
          </Link>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start lg:gap-6">
        <div className="space-y-3 lg:sticky lg:top-8">
          <AssetCard />
          <Link
            to="/search"
            className="flex h-12 items-center gap-2 rounded-2xl bg-card px-4 text-[15px] text-mute hover:text-sub"
          >
            <Icon name="search" className="size-5" />
            종목명이나 종목코드로 검색
          </Link>
          <MarketChips market={market} />
        </div>
        <Dashboard />
      </div>
    </>
  );
}
