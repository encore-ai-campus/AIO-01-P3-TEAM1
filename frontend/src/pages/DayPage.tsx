// 단타 연습장 /day (docs/API.md "단타 연습", 설계 4장).
//
// 잠금 화면(DayStatus.lockReasons → DAY_LOCK_TEXT, 퀴즈 입구 /day/quiz, 마이의 주린이모드 스위치) · 상태 카드(세션·15:15 진입 마감·한도·오늘 쓴 양) ·
// 계획 만들기(종목·사는·목표·손절 가격·예산 → useDayPreview → 비용 합계 costsAtTarget·costsAtStop) → 체크리스트(손절 시 손실·15:15 강제 정리·비용) →
// 시작(useCreateDayPlan, acknowledged: true) · 오늘 계획 목록(useDayPlans) · 복기 입구 /day/review.
// 늘 보이는 문구: DAY_LAG_NOTE, DAY_COST_NOTE(+ 미리 보기의 비용 합계). 분봉은 완성된 세션만 (MinuteChartPanel). ?symbol=로 종목을 미리 고를 수 있다.
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { useDayPlans, useDayStatus } from "../api/day";
import { DayLockCard } from "../components/day/DayLockCard";
import { DayPlanForm } from "../components/day/DayPlanForm";
import { DayPlanList } from "../components/day/DayPlanList";
import { DayStatusCard } from "../components/day/DayStatusCard";
import { Icon } from "../components/Icon";
import { Card, EmptyState, ErrorState, Notice, PageHeader, Skeleton, SkeletonCard } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { formatDayLabel } from "../lib/format";
import { DAY_COST_NOTE, DAY_LAG_NOTE } from "../lib/plainText";

function TodayPlans({ easy }: { easy: boolean }) {
  const q = useDayPlans(null);
  return (
    <Card aria-labelledby="day-plans-title">
      <div className="flex items-center justify-between gap-2">
        <h2 id="day-plans-title" className="text-[17px] font-bold">
          오늘 단타 계획{q.data && <span className="ml-1.5 text-[14px] font-semibold text-mute">{formatDayLabel(q.data.date)}</span>}
        </h2>
        <Link to="/day/review" className="flex items-center text-[14px] font-semibold text-brand">
          복기
          <Icon name="chevron" className="size-4" />
        </Link>
      </div>
      {q.isPending ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : q.isError ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : q.data.results.length === 0 ? (
        <EmptyState>오늘 만든 단타 계획이 없어요.</EmptyState>
      ) : (
        <DayPlanList plans={q.data.results} easy={easy} className="mt-1" />
      )}
    </Card>
  );
}

export function DayPage() {
  const status = useDayStatus();
  const { easy } = useViewMode();
  const [params] = useSearchParams();
  const initialSymbol = params.get("symbol");

  return (
    <>
      <PageHeader
        title="단타 연습장"
        back
        right={
          <Link to="/day/review" className="hidden h-10 items-center rounded-xl px-3 text-[14px] font-semibold text-brand hover:bg-brand-soft sm:flex">
            복기 보기
          </Link>
        }
      />
      <Notice tone="warn" className="mb-3">
        <p>{DAY_LAG_NOTE}</p>
        <p className="mt-1 font-semibold">{DAY_COST_NOTE}. 미리 보기에서 비용 합계를 꼭 확인해요.</p>
      </Notice>

      {status.isPending ? (
        <div className="space-y-3">
          <SkeletonCard lines={4} />
          <SkeletonCard lines={6} />
        </div>
      ) : status.isError ? (
        <Card>
          <ErrorState message={errorMessage(status.error)} onRetry={() => void status.refetch()} />
        </Card>
      ) : (
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-6">
          <div className="min-w-0 space-y-3">
            {status.data.unlocked ? (
              <DayPlanForm session={status.data.session} easy={easy} initialSymbol={initialSymbol} />
            ) : (
              <DayLockCard reasons={status.data.lockReasons} />
            )}
            <TodayPlans easy={easy} />
          </div>
          <div className="space-y-3 lg:sticky lg:top-8">
            <DayStatusCard status={status.data} />
            <p className="px-1 text-[12px] leading-snug text-mute">단타 연습 계획은 AI가 아니라 내가 정한 가격으로 만들어요. 모든 매매는 모의 계좌에서만 이뤄져요.</p>
          </div>
        </div>
      )}
    </>
  );
}
