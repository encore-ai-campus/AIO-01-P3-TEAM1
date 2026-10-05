// 단타 복기 /day/review?date= (docs/API.md "단타 연습" DayReview).
//
// 합계(날짜 넘기기 ‹ 날짜 › 포함 · 실현 손익 큰 숫자 · 진입 체결·이익/손실·비용) → 계획별 카드(결과 → 계획 vs 실제 → 그 세션 분봉 → 사건 기록)
// → "AI 복기 — 준비 중"(DAY_AI_REVIEW_PENDING, 맨 아래 한 줄 — 아직 없는 기능의 안내가 실제 기록보다 위에 있을 이유가 없다. AI 복기는 팀의 day_review 몫).
// 계획이 없는 날은 합계 자리에 빈 안내와 '단타 연습장으로'만 (0으로 채운 표는 정보가 아니라 잡음이다).
// PC(lg): 왼쪽 칸에 날짜·합계(붙어 다닌다 — 날짜를 연달아 넘기며 보는 일이 많다), 오른쪽에 계획 카드.
// 날짜를 바꾸는 동안 보던 복기를 흐리게 남긴다 (화면이 스켈레톤 하나로 접혔다 펴지지 않게 — useDayReview keepPreviousData).
import { useLayoutEffect, useRef } from "react";
import { Link, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useDayReview } from "../api/day";
import { useMarket } from "../api/queries";
import { kstToday, shiftSession } from "../components/day/dayUtil";
import { DayReviewItemCard } from "../components/day/DayReviewItemCard";
import { Icon } from "../components/Icon";
import { Card, EmptyState, ErrorState, PageHeader, Row, Skeleton, SkeletonCard } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { revealList, useChanged, useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatDayLabel, formatKrw, formatSignedKrw, trendClass } from "../lib/format";
import { DAY_AI_REVIEW_PENDING, DAY_COST_NOTE } from "../lib/plainText";

const pagerBtn =
  "press grid size-11 shrink-0 place-items-center rounded-xl bg-fill text-sub hover:bg-line disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40";

export function DayReviewPage() {
  const [params, setParams] = useSearchParams();
  const dateParam = params.get("date");
  const review = useDayReview(dateParam);
  const market = useMarket();
  const { easy } = useViewMode();
  const reveal = useRevealAfterLoading(review.isPending);
  // 날짜를 사용자가 바꾼 뒤의 교체만 페이드한다 (처음 불러온 목록은 위로 올라오며 나타난다)
  const dateChanged = useChanged(dateParam);
  const data = review.data;
  const stale = review.isPlaceholderData;
  const today = kstToday();
  const basis = market.data?.markets.find((m) => m.market === "KR")?.closeDate ?? null;
  // 불러오는 동안(이전 날짜를 흐리게 보이는 동안)에도 날짜 칸·제목은 고른 날짜를 따른다 — 옛 날짜로 되돌아갔다 바뀌지 않게.
  // 날짜를 고르지 않았으면 서버 기본값(KR 기준일)이고, 새 응답이 오기 전에는 시장 상태의 기준일로 미리 보인다
  const date = dateParam ?? (data && !stale ? data.date : (basis ?? data?.date ?? null));
  // 분봉은 완성된 세션(KR 기준일 이하)만. 보이는 기록의 날짜로 판단하고, 기준일을 모르면 일단 불러 본다
  const chartReady = !data || !basis || data.date <= basis;
  const prev = date ? shiftSession(date, -1) : null;
  const next = date ? shiftSession(date, 1) : null;
  const atEnd = !next || next > today; // 오늘 뒤 세션은 없다
  const badge = date === today ? "오늘" : date && date === basis ? "최근 세션" : null;

  const setDate = (v: string | null) =>
    setParams(
      (cur) => {
        const sp = new URLSearchParams(cur);
        if (v) sp.set("date", v);
        else sp.delete("date");
        return sp;
      },
      { replace: true },
    );

  // '최근 세션으로'는 누르면 사라진다 — 포커스가 body로 빠지지 않게 날짜 칸으로 옮긴다.
  // 새 날짜가 칸에 들어간 렌더에서 옮긴다 (화면 읽기 프로그램이 바뀐 날짜를 읽게)
  const dateInput = useRef<HTMLInputElement>(null);
  const refocusDate = useRef(false);
  useLayoutEffect(() => {
    if (!refocusDate.current) return;
    refocusDate.current = false;
    dateInput.current?.focus({ preventScroll: true });
  }, [dateParam]);

  const plans = data?.plans ?? [];
  const totals = data?.totals;

  return (
    <>
      <PageHeader
        title="단타 복기"
        back
        right={
          <Link
            to="/day"
            className="hidden h-11 items-center gap-0.5 rounded-xl px-3 text-[14px] font-semibold text-brand-ink transition-colors hover:bg-brand-soft active:bg-brand-soft sm:flex"
          >
            연습장
            <Icon name="chevron" className="size-4" />
          </Link>
        }
      />
      <div className="grid gap-3 lg:grid-cols-[360px_minmax(0,1fr)] lg:items-start lg:gap-6">
        <Card aria-labelledby="review-totals-title" className="lg:sticky lg:top-8">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <h2 id="review-totals-title" className="text-[17px] font-bold">
                {date ? `${formatDayLabel(date)} 합계` : "합계"}
              </h2>
              {badge && <span className="inline-flex h-6 items-center rounded-md bg-fill px-2 text-[12px] font-bold text-sub">{badge}</span>}
            </div>
            {/* 기준일로 돌아가기: 머리 줄 오른쪽(배지 자리)이라 나타나도 아래 내용이 밀리지 않는다. 보이는 높이 32px, 누르는 자리는 44px */}
            {dateParam && dateParam !== basis && (
              <button
                type="button"
                onClick={() => {
                  refocusDate.current = true;
                  setDate(null);
                }}
                className="relative -mr-2 inline-flex h-8 shrink-0 items-center gap-0.5 rounded-lg px-2 text-[13px] font-semibold text-brand-ink transition-colors before:absolute before:inset-x-0 before:-inset-y-1.5 hover:bg-brand-soft active:bg-brand-soft"
              >
                최근 세션으로
                <Icon name="chevron" className="size-3.5" />
              </button>
            )}
          </div>
          {/* 날짜 넘기기: 하루씩(주말은 건너뛴다) — 어제 → 그제처럼 연달아 넘겨 본다 */}
          <div className="mt-3 flex items-center gap-2">
            <button type="button" aria-label="이전 세션" disabled={!prev} onClick={() => setDate(prev)} className={pagerBtn}>
              <Icon name="back" className="size-5" />
            </button>
            <label htmlFor="review-date" className="sr-only">
              세션 날짜
            </label>
            <input
              ref={dateInput}
              id="review-date"
              type="date"
              value={date ?? ""}
              max={today}
              onChange={(e) => setDate(e.target.value || null)}
              className="h-11 min-w-0 flex-1 rounded-xl bg-fill px-3 text-center text-[16px] tabular-nums outline-none focus:ring-2 focus:ring-brand"
            />
            {/* 오늘에 닿으면 disabled 대신 aria-disabled: 누른 버튼에 포커스가 남는다 (막으면 포커스가 body로 빠져 화면 읽기 프로그램이 위치를 잃는다) */}
            <button
              type="button"
              aria-label="다음 세션"
              aria-disabled={atEnd || undefined}
              onClick={() => {
                if (!atEnd) setDate(next);
              }}
              className={pagerBtn}
            >
              <Icon name="chevron" className="size-5" />
            </button>
          </div>

          <div aria-busy={stale || undefined} className={cn("transition-opacity duration-fast", stale && "opacity-60")}>
            {review.isPending ? (
              <div className="mt-4 space-y-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-8 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-full" />
              </div>
            ) : review.isError ? (
              <div className="mt-4">
                {/* 날짜 형식·오늘 뒤 날짜(400)는 다시 해도 같으므로 다시 시도를 두지 않는다 */}
                <ErrorState
                  compact
                  message={errorMessage(review.error)}
                  onRetry={review.error instanceof ApiError && review.error.status === 400 ? undefined : () => void review.refetch()}
                  retrying={review.isFetching}
                />
              </div>
            ) : !totals || plans.length === 0 ? (
              <EmptyState compact icon="chart" action={{ label: "단타 연습장으로", to: "/day" }}>
                이 날짜에 만든 단타 계획이 없어요.
              </EmptyState>
            ) : (
              <>
                <p className="mt-4 text-[13px] text-sub">실현 손익 (비용 포함)</p>
                <p className={cn("text-[26px] font-bold tabular-nums", trendClass(totals.pnlKrw))}>{formatSignedKrw(totals.pnlKrw)}</p>
                <dl className="mt-2">
                  <Row label="진입 체결">{totals.filled}건</Row>
                  <Row label="이익 · 손실">
                    {totals.wins}건 · {totals.losses}건
                  </Row>
                  <Row label="비용 합계">{formatKrw(totals.costsKrw)}</Row>
                </dl>
                <p className="mt-2 text-[13px] text-mute">{DAY_COST_NOTE}.</p>
              </>
            )}
          </div>
        </Card>

        <div className="min-w-0 space-y-3">
          {review.isPending ? (
            <SkeletonCard lines={6} />
          ) : (
            data &&
            plans.length > 0 && (
              <>
                <div
                  key={data.date}
                  {...revealList(reveal && !dateChanged, plans.length <= 5 ? "rise" : "fade")}
                  aria-busy={stale || undefined}
                  className={cn("space-y-3 transition-opacity duration-fast", dateChanged && !stale && "reveal-fade", stale && "opacity-60")}
                >
                  {plans.map((item) => (
                    <DayReviewItemCard key={item.plan.id} item={item} date={data.date} chartReady={chartReady} easy={easy} />
                  ))}
                </div>
                <section aria-label="AI 복기" className="rounded-2xl px-5 py-4 ring-1 ring-line ring-inset">
                  <p className="flex items-center gap-1.5 text-[15px] font-semibold text-sub">
                    <Icon name="sparkle" className="size-5 text-mute-weak" />
                    {DAY_AI_REVIEW_PENDING}
                  </p>
                  <p className="mt-1 text-[13px] leading-snug text-mute">
                    지금은 체결·청산 기록 그대로 만든 복기만 보여요. 체결가·청산가는 일어난 사실이라 그대로 보여요.
                  </p>
                </section>
              </>
            )
          )}
        </div>
      </div>
    </>
  );
}
