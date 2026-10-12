// 홈. 주린이모드(쉬운 보기)와 전문가 보기가 다르다 (docs/plans/컨셉변경계획.md 4-2, docs/plans/투자서비스확장계획.md 2-3).
// 배치 원칙: 위에서 아래로 '지금 할 일 → 내가 시킨 일의 상태 → 참고 → 사회적 요소'. 늦게 오는 섹션이 위쪽에 끼어들지 않게
// 늘 같은 자리를 두고(비면 한 줄), 생겼다 없어지는 섹션은 높이가 펼쳐지고 접힌다.
// - 쉬운 보기: [3단계 안내 → 만드는 중인 리포트 → 진행 중인 모의 자동매매 → 최근 AI 리포트 → 오늘의 내 종목 뉴스] | [자산 → 최근 알림 → 랭킹]
// - 전문가 보기: [자산 → (PC) 검색 → 장 상태] | [만드는 중 → 진행 중 자동매매 → 새 계획 제안 → 최근 리포트 → 오늘의 내 종목 뉴스(요약형) → 교차검증 분석 → 랭킹]
// - 2단은 xl(1280px)부터: 그보다 좁으면 본문이 옆 열(360px)보다 좁아져 위계가 뒤집히고 가격 숫자가 쪼개진다 → 한 열(680px, 가운데).
// "이 화면만 자세히 보기"(?view=)는 맨 아래 — 이 화면에만 쓰고 저장하지 않는다 (hooks/useBeginnerMode.ts). 바꾼 뒤 맨 위로 가는 것은 ScrollManager.
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigationType } from "react-router";
import { useAnalyses, useMarket, useMe, useQuotes, useReports } from "../api/queries";
import type { MarketStatus } from "../api/types";
import { AnalysisCard, AnalysisCardSkeleton } from "../components/analysis/AnalysisCard";
import { AssetCard } from "../components/AssetCard";
import { HomePlans, HomeRecommendations } from "../components/autotrade/HomeSummaries";
import { GuideCard } from "../components/home/GuideCard";
import { DemoPreviewCard } from "../components/home/DemoPreviewCard";
import { DAILY_MOVE_ANCHOR, kstDay, readGuideClosed, writeGuideClosed } from "../components/home/homeData";
import { useFailedCount } from "../components/home/homeHooks";
import { EmptyRow, SectionError } from "../components/home/HomeStates";
import { LivePlans } from "../components/home/LivePlans";
import { RankingCard } from "../components/home/RankingCard";
import { RecentNotifications } from "../components/home/RecentNotifications";
import { RecentReports } from "../components/home/RecentReports";
import { ReportsInProgress } from "../components/home/ReportsInProgress";
import { Icon } from "../components/Icon";
import { DailyMoveCard } from "../components/longterm/DailyMoveCard";
import { Collapse } from "../components/motion/Collapse";
import { ViewToggle } from "../components/reports/ViewToggle";
import { LiveDot, PageHeader, Segmented, Skeleton } from "../components/ui";
import { type ViewModeState, useViewMode } from "../hooks/useBeginnerMode";
import { revealList, useChanged, useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { DASHBOARD_SHOWN, dashboardOrder } from "../lib/dashboard";
import { formatDateTime } from "../lib/format";
import { scrollToTop } from "../lib/motion";

type Filter = "ALL" | "BUY";

/** 장이 열리는 때: 오늘이면 시각만, 아니면 날짜까지 ('미국 닫힘 · 22:30 시작'처럼 짧게 — 두 칩이 한 줄에 들어가게). */
function opensText(iso: string) {
  const at = formatDateTime(iso);
  return kstDay(iso) === kstDay() ? at.split(" ")[1] : at;
}

/** 지금 장이 열렸나 (평가 기준 시각과는 다른 정보라 자산 카드의 기준 시각 줄에 섞지 않는다). 받기 전에도 자리를 둔다. */
function MarketChips({ market }: { market: MarketStatus | undefined }) {
  if (!market) {
    return (
      <div aria-hidden="true" className="flex gap-2">
        {/* 알약 모양: 모서리를 주면 Skeleton이 기본 rounded-lg를 뺀다 */}
        <Skeleton className="h-8 w-36 rounded-full" />
        <Skeleton className="h-8 w-40 rounded-full" />
      </div>
    );
  }
  return (
    <ul className="flex flex-wrap gap-2" aria-label="정규장 상태">
      {market.markets.map((m) => (
        <li
          key={m.market}
          className={cn("inline-flex h-8 items-center gap-1.5 rounded-full bg-card px-3 text-[13px] font-medium", m.isOpen ? "text-ink" : "text-sub")}
        >
          {/* 열린 장은 몇 시간 이어지는 '진행 중'이라 퍼지는 점(LiveDot), 닫힌 장은 회색 점 */}
          {m.isOpen ? <LiveDot /> : <span aria-hidden="true" className="size-2 rounded-full bg-mute-weak" />}
          {m.market === "KR" ? "국내" : "미국"} {m.isOpen ? "열림" : "닫힘"}
          <span className="text-mute">
            {m.isOpen ? (m.closesAt ? `· ${formatDateTime(m.closesAt).split(" ")[1]} 마감` : "") : m.opensAt ? `· ${opensText(m.opensAt)} 시작` : ""}
          </span>
        </li>
      ))}
      {market.halted && <li className="inline-flex h-8 items-center rounded-full bg-warn-soft px-3 text-[13px] font-semibold text-warn-ink">새 매수 중단</li>}
    </ul>
  );
}

function Dashboard() {
  const [filter, setFilter] = useState<Filter>("ALL");
  // 필터를 바꾸는 동안 이전 목록을 흐리게 남긴다 (스켈레톤으로 줄었다 늘며 화면이 튀지 않게)
  const { data, isPending, isFetching, isPlaceholderData, refetch } = useAnalyses(filter === "BUY" ? { verdict: "BUY" } : {}, { keepPrevious: true });
  const reveal = useRevealAfterLoading(isPending);
  const all = dashboardOrder(data?.results ?? []);
  const list = all.slice(0, DASHBOARD_SHOWN);
  const { data: quotes } = useQuotes(
    list.map((a) => a.symbol),
    { keepPrevious: true },
  );
  // 지금 보이는 목록이 어느 필터의 것인지 (새 목록이 도착한 순간에만 바뀐다) — 그때 한 번 페이드
  const [shownFor, setShownFor] = useState(filter);
  if (!isPlaceholderData && data && shownFor !== filter) setShownFor(filter);
  const swapped = useChanged(shownFor);

  return (
    <section aria-labelledby="dash-title" className="space-y-3 @container">
      <div className="flex items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 id="dash-title" tabIndex={-1} className="text-[19px] font-bold outline-none">
            AI 교차검증 분석
          </h2>
          {all.length > 0 && (
            <span className="inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-full bg-line/70 px-2 text-[13px] font-bold text-sub tabular-nums">
              {all.length}
              <span className="sr-only">개</span>
            </span>
          )}
        </div>
        <Segmented
          label="분석 필터"
          value={filter}
          onChange={setFilter}
          surface="page"
          options={[
            { value: "ALL", label: "전체" },
            { value: "BUY", label: "매수" },
          ]}
        />
      </div>
      {isPending ? (
        <div role="group" aria-busy="true" aria-label="불러오는 중" className="grid gap-3 @min-[560px]:grid-cols-2">
          {Array.from({ length: DASHBOARD_SHOWN }, (_, i) => (
            <AnalysisCardSkeleton key={i} />
          ))}
        </div>
      ) : !data ? (
        <SectionError onRetry={() => void refetch()} retrying={isFetching} />
      ) : list.length === 0 ? (
        <EmptyRow icon="chart" to={filter === "BUY" ? undefined : "/search"} className={reveal || swapped ? "reveal-fade" : undefined}>
          {filter === "BUY" ? "매수 판정을 받은 종목이 아직 없습니다." : "아직 분석한 종목이 없습니다. 종목 상세의 'AI 교차검증 분석'에서 요청할 수 있습니다."}
        </EmptyRow>
      ) : (
        <ul
          key={shownFor}
          aria-busy={isPlaceholderData || undefined}
          // 처음 받은 카드는 40ms 간격으로 올라오고(카드 4장), 필터를 바꾼 뒤에는 목록이 한 번 페이드된다
          {...revealList(reveal && !swapped, "rise")}
          className={cn("grid gap-3 transition-opacity duration-fast @min-[560px]:grid-cols-2", isPlaceholderData && "opacity-60", swapped && "reveal-fade")}
        >
          {list.map((a) => (
            <li key={a.id}>
              <AnalysisCard a={a} quote={quotes?.get(a.symbol)} />
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        // 필터의 '전체'와 나란히 두면 같은 말이 둘이라 헷갈린다 — 4장을 다 훑은 눈이 닿는 끝에 둔다
        <Link
          to="/reports?list=analyses"
          className="press-row flex h-12 items-center justify-center gap-1 rounded-2xl bg-card text-[15px] font-semibold text-sub hover:bg-fill/50"
        >
          교차검증 분석 전체 보기
          <Icon name="chevron" className="size-4 text-mute-weak" />
        </Link>
      )}
    </section>
  );
}

/**
 * 홈의 여러 섹션이 한꺼번에 처음부터 실패하면(서버가 내려감 등) 맨 위에 한 번만 알리고, 실패한 것을 한 번에 다시 받는다.
 * 섹션마다 경고(role=alert)를 두면 화면 읽기가 연달아 여러 번 읽는다 — 섹션 안 오류 줄에는 알림 역할이 없다.
 * 하나만 실패하면 보이는 띠는 두지 않고(그 섹션의 한 줄 오류·다시 시도로 충분하다) 화면 읽기에만 같은 문장을 한 번 알린다 —
 * 알리지 않으면 그 카드까지 가기 전에는 실패를 모른다. 둘째가 실패하면 같은 문장 그대로 띠가 보이고 '모두 다시 시도'만 더해진다
 * (문장을 다시 만들지 않아, 거의 함께 실패해도 화면 읽기가 같은 문장을 두 번 읽지 않는다).
 */
function FailedNotice() {
  const failed = useFailedCount();
  const client = useQueryClient();
  const band = failed >= 2;
  return (
    <div aria-live="polite">
      {failed > 0 && (
        <div className={band ? "reveal-fade mb-4 flex items-center justify-between gap-3 rounded-2xl bg-warn-soft py-2 pr-2 pl-4 text-warn-ink" : "sr-only"}>
          <p className="flex min-w-0 items-center gap-2 text-[14px] font-semibold">
            <Icon name="alert-circle" className="size-4 shrink-0" />
            일부 정보를 불러오지 못했어요
          </p>
          {band && (
            <button
              type="button"
              onClick={() => void client.refetchQueries({ type: "active", predicate: (q) => q.state.status === "error" })}
              className="press h-11 shrink-0 rounded-xl bg-card px-4 text-[14px] font-semibold text-ink hover:bg-fill"
            >
              모두 다시 시도
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** 맨 아래: 이 화면의 보기 바꾸기 + (닫았을 때) 3단계 안내 다시 보기. 둘 다 '이 화면을 어떻게 볼지'라 함께 둔다. */
function HomeFooter({ view, onRevive }: { view: ViewModeState; onRevive?: () => void }) {
  return (
    <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
      <ViewToggle view={view} placement="header" />
      {onRevive && (
        <button
          type="button"
          onClick={onRevive}
          className="press relative flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-card px-3 text-[13px] font-semibold whitespace-nowrap text-sub ring-1 ring-line before:absolute before:-inset-1 hover:bg-fill"
        >
          <Icon name="restart" className="size-4 shrink-0" />
          3단계 안내 다시 보기
        </button>
      )}
    </div>
  );
}

function EasyHome({ userId, view, focusKey }: { userId: number; view: ViewModeState; focusKey: string | null }) {
  // 내 리포트: 3단계 안내(0개면 늘 보임·지금 단계)와 만드는 중인 리포트에 같이 쓴다 (Layout과 같은 캐시)
  const mine = useReports({ mine: true });
  const myReports = mine.data?.results;
  // 닫았는지는 이 브라우저에 남긴 값 — 리포트 목록을 기다리지 않고 바로 안다. 닫은 적이 없으면 처음부터 그린다 (늦게 끼어들어 첫 화면이 밀리지 않게)
  const [closed, setClosed] = useState(() => readGuideClosed(userId));
  const show = !closed || (mine.isSuccess && (myReports?.length ?? 0) === 0);
  const guideSlot = useRef<HTMLDivElement>(null);
  const [revived, setRevived] = useState(0);

  useEffect(() => {
    if (revived > 0) document.getElementById("guide-title")?.focus({ preventScroll: true });
  }, [revived]);

  const closeGuide = () => {
    // 닫히는 카드 안의 포커스가 사라지기 전에 다음 섹션 제목으로 (키보드·화면 읽기가 자리를 잃지 않게)
    guideSlot.current?.nextElementSibling?.querySelector<HTMLElement>("h2[tabindex]")?.focus({ preventScroll: true });
    writeGuideClosed(userId, true);
    setClosed(true);
  };
  const reviveGuide = () => {
    writeGuideClosed(userId, false);
    setClosed(false);
    setRevived((n) => n + 1);
    scrollToTop();
  };

  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px] xl:items-start">
        <div className="min-w-0 space-y-6">
          {/* 간격(pb-6)을 접히는 안쪽에 둔다 — 닫을 때 아래 내용이 간격까지 부드럽게 올라온다 */}
          <div ref={guideSlot} className="mb-0">
            <Collapse open={show}>
              <div className="pb-6">
                <GuideCard userId={userId} mine={myReports} failed={mine.isError && !myReports} onClose={closeGuide} />
              </div>
            </Collapse>
          </div>
          <ReportsInProgress mine={myReports} view="easy" />
          <LivePlans />
          <RecentReports view="easy" />
          <DailyMoveCard view="easy" limit={3} emptyMode="compact" id={DAILY_MOVE_ANCHOR} focusKey={focusKey} />
        </div>
        <div className="min-w-0 space-y-6">
          <AssetCard easy />
          <RecentNotifications />
          <RankingCard />
        </div>
      </div>
      <HomeFooter view={view} onRevive={closed && !show ? reviveGuide : undefined} />
    </>
  );
}

function ExpertHome({ view, focusKey }: { view: ViewModeState; focusKey: string | null }) {
  const { data: market } = useMarket();
  const mine = useReports({ mine: true });
  return (
    <>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,360px)_minmax(0,1fr)] xl:items-start">
        {/* 왼쪽(PC sticky): 스크롤 내내 봐야 하는 것만 — 돈·검색·장 상태. 화면 높이 680px에도 들어간다 */}
        <div className="min-w-0 space-y-3 xl:sticky xl:top-8">
          <AssetCard />
          {/* 모바일·중간 폭은 머리 돋보기·'종목' 탭이 검색 입구 (같은 입구를 한 화면에 셋 두지 않는다) */}
          <Link
            to="/search"
            className="press-row hidden h-12 items-center gap-2 rounded-2xl bg-card px-4 text-[15px] text-mute hover:bg-fill/50 hover:text-sub xl:flex"
          >
            <Icon name="search" className="size-5" />
            종목명이나 종목코드로 검색
          </Link>
          <MarketChips market={market} />
        </div>
        {/* 오른쪽: 진행 중인 일 → 할 수 있는 일 → 참고 → 사회적 요소 */}
        <div className="min-w-0 space-y-6">
          <ReportsInProgress mine={mine.data?.results} view="expert" />
          <HomePlans />
          <HomeRecommendations />
          <RecentReports view="expert" />
          <DailyMoveCard view="expert" limit={3} density="summary" emptyMode="compact" id={DAILY_MOVE_ANCHOR} focusKey={focusKey} />
          <Dashboard />
          <RankingCard />
        </div>
      </div>
      <HomeFooter view={view} />
    </>
  );
}

export function HomePage() {
  const { data: me } = useMe();
  const view = useViewMode();
  // 알림(오늘의 내 종목 뉴스)에서 왔을 때: 기록 key가 바뀔 때마다 그 카드로 내려가 강조한다 (홈에서 홈으로 와도).
  // 뒤로·앞으로 가기와 새로고침(POP)은 보던 자리로 돌아가는 이동이라(ScrollManager) 다시 착지하지 않는다
  const { hash, key } = useLocation();
  const navType = useNavigationType();
  const focusKey = hash === `#${DAILY_MOVE_ANCHOR}` && navType !== "POP" ? key : null;
  return (
    // 1024~1279px는 한 열(680px)을 가운데에 — 제목도 같은 폭에 맞춘다
    <div className="lg:max-xl:mx-auto lg:max-xl:max-w-[680px]">
      <PageHeader
        title="홈"
        brand
        right={
          <Link
            to="/search"
            aria-label="종목 검색"
            className="grid size-11 shrink-0 place-items-center rounded-full transition-colors hover:bg-line/60 active:bg-line/60 lg:hidden"
          >
            <Icon name="search" />
          </Link>
        }
      />
      <FailedNotice />
      <DemoPreviewCard />
      {view.easy && me ? <EasyHome userId={me.id} view={view} focusKey={focusKey} /> : <ExpertHome view={view} focusKey={focusKey} />}
    </div>
  );
}
