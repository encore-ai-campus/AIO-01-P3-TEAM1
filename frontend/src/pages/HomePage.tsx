// 홈. 주린이모드(쉬운 보기)와 전문가 보기가 다르다 (docs/컨셉변경계획.md 4-2, docs/투자서비스확장계획.md 2-3).
// - 쉬운 보기: 3단계 안내(처음 방문·내 리포트 0개) · 최근 AI 리포트 · 만드는 중인 리포트 · 진행 중인 모의 자동매매 ·
//   오늘의 내 종목 뉴스(쉬운 요약) · 자산 요약(장마감 기준) · 최근 알림 · 랭킹.
// - 전문가 보기: 자산·시장 칩·계획·새 계획 제안·교차검증 분석 대시보드 + 오늘의 내 종목 뉴스(수치형) · 최근 리포트 · 랭킹.
// "이 화면만 자세히 보기"(?view=expert)는 이 화면에만 쓰고 저장하지 않는다 (hooks/useBeginnerMode.ts).
import { useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useAnalyses, useMarket, useMe, useQuotes, useReports } from "../api/queries";
import type { MarketStatus } from "../api/types";
import { AnalysisCard } from "../components/AnalysisCard";
import { AssetCard } from "../components/AssetCard";
import { HomePlans, HomeRecommendations } from "../components/autotrade/HomeSummaries";
import { GuideCard } from "../components/home/GuideCard";
import { LivePlans } from "../components/home/LivePlans";
import { RankingCard } from "../components/home/RankingCard";
import { RecentNotifications } from "../components/home/RecentNotifications";
import { RecentReports } from "../components/home/RecentReports";
import { ReportsInProgress } from "../components/home/ReportsInProgress";
import { Icon } from "../components/Icon";
import { DailyMoveCard } from "../components/longterm/DailyMoveCard";
import { EmptyState, ErrorState, PageHeader, Segmented, SkeletonCard } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
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
          AI 교차검증 분석
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
          <EmptyState>{filter === "BUY" ? "BUY 판정을 받은 종목이 아직 없습니다." : "아직 분석한 종목이 없습니다. 종목 상세의 'AI 교차검증 분석'으로 요청합니다."}</EmptyState>
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

/** 이 화면만 보기 바꾸기 (저장하지 않음). */
function ViewSwitch({ expert, onChange }: { expert: boolean; onChange: (expert: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!expert)}
      className="mx-auto flex h-10 items-center gap-1 rounded-xl px-3 text-[14px] font-semibold text-mute hover:bg-line/60 hover:text-sub"
    >
      <Icon name="swap" className="size-4" />
      {expert ? "이 화면만 쉬운 보기로" : "이 화면만 자세히 보기"}
    </button>
  );
}

function EasyHome({ userId }: { userId: number }) {
  // 내 리포트: 3단계 안내(0개면 늘 보임)와 만드는 중인 리포트에 같이 쓴다
  const mine = useReports({ mine: true });
  const myReports = mine.data?.results ?? [];
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
      <div className="min-w-0 space-y-6">
        {!mine.isPending && <GuideCard userId={userId} hasReports={myReports.length > 0} />}
        <RecentReports view="easy" />
        <ReportsInProgress mine={myReports} view="easy" />
        <LivePlans />
        <DailyMoveCard view="easy" limit={3} />
      </div>
      <div className="space-y-6">
        <AssetCard easy />
        <RecentNotifications />
        <RankingCard />
      </div>
    </div>
  );
}

function ExpertHome() {
  const { data: market } = useMarket();
  const mine = useReports({ mine: true });
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)] lg:items-start lg:gap-6">
      <div className="space-y-3 lg:sticky lg:top-8">
        <AssetCard />
        <Link to="/search" className="flex h-12 items-center gap-2 rounded-2xl bg-card px-4 text-[15px] text-mute hover:text-sub">
          <Icon name="search" className="size-5" />
          종목명이나 종목코드로 검색
        </Link>
        <MarketChips market={market} />
        <RankingCard />
      </div>
      <div className="min-w-0 space-y-6">
        <ReportsInProgress mine={mine.data?.results ?? []} view="expert" />
        <HomePlans />
        <HomeRecommendations />
        <RecentReports view="expert" />
        <DailyMoveCard view="expert" limit={3} />
        <Dashboard />
      </div>
    </div>
  );
}

export function HomePage() {
  const { data: me } = useMe();
  const { easy, expert, override, setView } = useViewMode();
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
      {easy && me ? <EasyHome userId={me.id} /> : <ExpertHome />}
      {/* 주린이모드 켬이면 "자세히 보기", ?view=expert로 바꾼 뒤에는 되돌리기. 주린이모드 끔(전문가)은 마이에서 바꾼다 */}
      {(easy || override === "expert") && (
        <div className="mt-6">
          <ViewSwitch expert={expert} onChange={(e) => setView(e ? "expert" : "easy")} />
        </div>
      )}
    </>
  );
}
