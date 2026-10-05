// 단타 연습장 /day (docs/API.md "단타 연습", 설계 4장).
//
// 잠금 화면(DayStatus.lockReasons → DAY_LOCK_TEXT, 마이의 주린이모드 스위치, 퀴즈 입구 /day/quiz) · 상태 카드(세션·15:15 진입 마감·오늘 쓴 양·한도) ·
// 계획 만들기(종목·사는·목표·손절 가격·예산 → useDayPreview → 비용 합계 costsAtTarget·costsAtStop) → 체크리스트(손절 시 손실·15:15 강제 정리·비용) →
// 시작(useCreateDayPlan, acknowledged: true) · 오늘 계획 목록(useDayPlans) · 복기 입구 /day/review.
// 늘 보이는 문구: DAY_LAG_NOTE, DAY_COST_NOTE(+ 미리 보기의 비용 합계). 분봉은 완성된 세션만 (MinuteChartPanel). ?symbol=로 종목을 미리 고를 수 있다.
//
// 배치 (위에서 아래 · PC는 왼쪽 열 | 오른쪽 열):
// - 잠김: 잠금 카드(이 사람이 지금 할 수 있는 일) → 경고 띠 → 오늘 계획(있을 때만) | 상태 카드('잠겨 있어요').
// - 열림: 경고 띠 → [오늘 단타가 끝났어요 — 15:15 이후 오늘 계획이 있을 때] → 계획 만들기(모바일은 제목 아래 마감·한도 한 줄) → 오늘 계획(+ 복기 입구)
//   | 상태 카드 → 미리 보기(PC, 입력을 따라 붙어 다닌다). 하루 흐름(장 전 계획 → 장중 → 장 후 복기)에 따라 그 시각의 주된 일이 위에 온다.
import type { UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { useDayPlans, useDayStatus } from "../api/day";
import { useMarket } from "../api/queries";
import type { DayPlanList, TradePlan } from "../api/types";
import { DayLockCard } from "../components/day/DayLockCard";
import { DayPlanForm } from "../components/day/DayPlanForm";
import { DayPlanList as PlanRows } from "../components/day/DayPlanList";
import { DayStatusCard } from "../components/day/DayStatusCard";
import { DAY_CAREFUL_PROFILES, reviewEntry } from "../components/day/dayUtil";
import { useWide } from "../components/day/useWide";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { Card, EmptyState, ErrorState, Notice, PageHeader, Skeleton, SkeletonCard } from "../components/ui";
import { useBeginnerMode, useViewMode } from "../hooks/useBeginnerMode";
import { revealList, useNewKeys, useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatDayLabel, formatSignedKrw, trendClass } from "../lib/format";
import { DAY_COST_NOTE, DAY_LAG_NOTE, RISK_PROFILE_TEXT } from "../lib/plainText";

type ReviewEntry = ReturnType<typeof reviewEntry>;

/** 오늘 단타 계획 + 복기 입구(카드 아래 전체 폭 줄 — 엄지로 누르기 쉽게, 글자와 날짜가 맞게). */
function TodayPlans({ q, easy, accepting, entry }: { q: UseQueryResult<DayPlanList>; easy: boolean; accepting: boolean; entry: ReviewEntry }) {
  const reveal = useRevealAfterLoading(q.isPending);
  // 방금 만든 계획 줄만 한 번 강조한다 (처음 받은 목록이 기준 — 폴링으로 상태만 바뀐 줄은 움직이지 않는다)
  const fresh = useNewKeys(q.data?.results.map((p) => p.id) ?? [], !q.isPending);
  return (
    <Card aria-labelledby="day-plans-title">
      <h2 id="day-plans-title" className="text-[17px] font-bold">
        오늘 단타 계획{q.data && <span className="ml-1.5 text-[14px] font-semibold text-mute">{formatDayLabel(q.data.date)}</span>}
      </h2>
      {q.isPending ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : q.isError ? (
        <div className="mt-2">
          <ErrorState compact message={errorMessage(q.error)} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        </div>
      ) : q.data && q.data.results.length > 0 ? (
        <PlanRows plans={q.data.results} easy={easy} fresh={fresh} reveal={revealList(reveal)} className="mt-1" />
      ) : (
        <EmptyState compact>
          오늘 만든 단타 계획이 없어요.
          {accepting && (
            <>
              <br />
              위에서 종목을 골라 첫 계획을 만들어 보세요.
            </>
          )}
        </EmptyState>
      )}
      <div className="mt-2 border-t border-line pt-1">
        <Link to={entry.to} className="press-row -mx-2 flex h-12 items-center justify-between gap-2 rounded-xl px-2 text-[15px] font-semibold text-brand-ink">
          {entry.label}
          <Icon name="chevron" className="size-4 shrink-0" />
        </Link>
      </div>
    </Card>
  );
}

/** 15:15 이후 오늘 계획이 있으면: 장이 끝난 뒤의 주된 일은 복기다. 분봉은 기준일이 오늘이 된 뒤(15:40)부터. */
const LIVE_STATUS = new Set(["active", "entry_pending", "holding"]);

function DayDoneCard({ plans, chartLater, entry }: { plans: TradePlan[]; chartLater: boolean; entry: ReviewEntry }) {
  const settled = plans.filter((p) => p.pnlKrw !== null);
  const pnl = settled.reduce((n, p) => n + (p.pnlKrw ?? 0), 0);
  // 15:15 직후 몇 초는 엔진이 아직 정리 중일 수 있다. 체결 없이 끝난(기한 만료 등) 계획은 손익이 없다
  const settling = plans.filter((p) => LIVE_STATUS.has(p.status)).length;
  const note = settling ? ` · 정리 중 ${settling}개` : settled.length === 0 ? " · 체결 없이 끝났어요" : "";
  return (
    <Card aria-labelledby="day-done-title">
      <h2 id="day-done-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="check-circle" className="size-5 text-ok" />
        오늘 단타가 끝났어요
      </h2>
      <p className="mt-2 text-[13px] text-sub">
        실현 손익 (비용 포함) · 계획 {plans.length}개{note}
      </p>
      <p className={cn("text-[24px] font-bold tabular-nums", trendClass(pnl))}>{formatSignedKrw(pnl)}</p>
      {chartLater && <p className="mt-1 text-[13px] text-mute">그날 분봉은 장 마감 뒤(15:40)부터 복기에서 볼 수 있어요.</p>}
      <Link
        to={entry.to}
        className="press mt-4 flex h-12 items-center justify-center gap-1 rounded-xl bg-brand text-[15px] font-bold text-white hover:bg-brand-dark"
      >
        {entry.label} 보기
      </Link>
    </Card>
  );
}

export function DayPage() {
  const status = useDayStatus();
  const plans = useDayPlans(null);
  const market = useMarket();
  const { easy } = useViewMode();
  const { profile } = useBeginnerMode();
  const [params] = useSearchParams();
  const initialSymbol = params.get("symbol");
  const wide = useWide();
  const revealed = useRevealAfterLoading(status.isPending);
  // PC 오른쪽 칸의 미리 보기 자리 (DayPlanForm이 포털로 그린다)
  const [previewSlot, setPreviewSlot] = useState<HTMLDivElement | null>(null);
  const [formOpened, setFormOpened] = useState(false);

  const s = status.data;
  const todayPlans = plans.data?.results ?? [];
  const basis = market.data?.markets.find((m) => m.market === "KR")?.closeDate ?? null;
  const accepting = s?.session.acceptingPlans ?? true;
  const entry = reviewEntry({ todayDate: plans.data?.date ?? null, hasTodayPlans: todayPlans.length > 0, accepting, basis });
  const done = s && plans.data ? !accepting && todayPlans.length > 0 : null;
  // 처음 다 받았을 때 이미 오늘 단타가 끝났으면 폼을 접어 둔다. 보는 중에 15:15가 지나도 쓰던 폼은 접지 않는다
  const [startedDone, setStartedDone] = useState<boolean | null>(null);
  if (startedDone === null && done !== null) setStartedDone(done);
  const formFolded = startedDone === true && done === true;
  const careful = profile?.riskProfile && DAY_CAREFUL_PROFILES.includes(profile.riskProfile) ? profile.riskProfile : null;
  const locked = s ? !s.unlocked : false;

  const notice = (
    <Notice tone="warn">
      <p>{DAY_LAG_NOTE}</p>
      <p className="mt-1 font-semibold">
        {DAY_COST_NOTE}.{!locked && " 미리 보기에서 비용 합계를 꼭 확인해요."}
      </p>
      {careful && <p className="mt-1">하루 안에 사고파는 연습은 손실 변동이 커요. 성향 진단: {RISK_PROFILE_TEXT[careful]}</p>}
    </Notice>
  );

  const form = s && (
    <DayPlanForm status={s} easy={easy} initialSymbol={initialSymbol} previewSlot={wide && !locked ? previewSlot : null} />
  );

  return (
    <>
      <PageHeader
        title="단타 연습장"
        back
        right={
          <Link
            to={entry.to}
            className="hidden h-11 items-center gap-0.5 rounded-xl px-3 text-[14px] font-semibold text-brand-ink transition-colors hover:bg-brand-soft active:bg-brand-soft sm:flex"
          >
            {entry.short}
            <Icon name="chevron" className="size-4" />
          </Link>
        }
      />

      {status.isPending ? (
        // 실제 배치(PC 2단)와 같은 자리 — 내용이 오면 자리가 뒤바뀌지 않게
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
          <SkeletonCard lines={7} />
          <SkeletonCard lines={5} />
        </div>
      ) : status.isError || !s ? (
        <Card>
          <ErrorState message={errorMessage(status.error)} onRetry={() => void status.refetch()} retrying={status.isFetching} />
        </Card>
      ) : (
        <div className={cn("grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-6", revealed && "reveal-fade")}>
          <div className="min-w-0 space-y-3">
            {locked ? (
              <>
                <DayLockCard reasons={s.lockReasons} />
                {notice}
                {/* 잠겨도 진행 중인 계획은 그날 15:15까지 이어지므로 있으면 보인다. 없으면 쓸 수 없는 기능의 빈 카드라 숨긴다 */}
                {todayPlans.length > 0 && <TodayPlans q={plans} easy={easy} accepting={false} entry={entry} />}
              </>
            ) : (
              <>
                {notice}
                {done && <DayDoneCard plans={todayPlans} chartLater={basis !== plans.data?.date} entry={entry} />}
                {formFolded ? (
                  <div className="rounded-2xl bg-card">
                    <button
                      type="button"
                      aria-expanded={formOpened}
                      aria-controls={formOpened ? "day-practice" : undefined}
                      onClick={() => setFormOpened((v) => !v)}
                      className="press-row flex min-h-16 w-full items-center justify-between gap-3 rounded-2xl px-5 py-3.5 text-left"
                    >
                      <span className="min-w-0">
                        <span className="block text-[16px] font-bold">다음 세션 숫자 연습</span>
                        <span className="mt-0.5 block text-[13px] leading-snug text-mute">
                          수량·비용을 미리 계산해 봐요 · 시작은 {formatDayLabel(s.session.date)}부터
                        </span>
                      </span>
                      <Icon
                        name="chevron-down"
                        className={cn("size-5 shrink-0 text-mute-weak transition-transform duration-fast", formOpened && "rotate-180")}
                      />
                    </button>
                    <Collapse open={formOpened} id="day-practice">
                      {form}
                    </Collapse>
                  </div>
                ) : (
                  form
                )}
                <TodayPlans q={plans} easy={easy} accepting={accepting} entry={entry} />
              </>
            )}
          </div>
          <div className="min-w-0 space-y-3">
            <DayStatusCard status={s} />
            <p className="px-1 text-[12px] leading-snug text-mute">
              단타 연습 계획은 AI가 아니라 내가 정한 가격으로 만들어요. 모든 매매는 모의 계좌에서만 이뤄져요.
            </p>
            {/* PC: 입력에 반응하는 숫자(미리 보기)는 오른쪽 칸 맨 아래에 붙어 다닌다 — 가격을 고치는 동안 늘 보이게.
                높이는 화면 안으로 제한하고 넘치면 칸 안에서 스크롤한다 (노트북 높이 690px에서는 붙어 있는 동안 사유 끝이 화면 밖에서 잘렸다 —
                리포트 목록의 오른쪽 칸과 같은 규칙). -m-1 p-1은 안쪽 링크의 포커스 테두리가 잘리지 않을 여유 */}
            {wide && !locked && (
              <div
                ref={setPreviewSlot}
                className="sticky top-8 -m-1 max-h-[calc(100dvh-4rem)] overflow-y-auto overscroll-contain rounded-[1.25rem] p-1"
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
