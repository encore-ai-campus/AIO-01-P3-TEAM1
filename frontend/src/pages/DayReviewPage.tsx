// 단타 복기 /day/review?date= (docs/API.md "단타 연습" DayReview).
//
// 날짜 고르기(?date=, 없으면 서버가 KR 기준일) · 합계(totals: filled·wins·losses·pnlKrw·costsKrw) · 계획별 진입·청산·사유(EOD 포함)·손익·비용과
// 그 세션 분봉(MinuteChartPanel + 진입·청산 표시 — 완성된 세션만) · "AI 복기 — 준비 중"(DAY_AI_REVIEW_PENDING. AI 복기는 팀의 day_review 몫).
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { useDayReview } from "../api/day";
import { useMarket } from "../api/queries";
import { kstToday } from "../components/day/dayUtil";
import { DayReviewItemCard } from "../components/day/DayReviewItemCard";
import { Icon } from "../components/Icon";
import { Card, EmptyState, ErrorState, PageHeader, Row, SkeletonCard } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { cn } from "../lib/cn";
import { formatDayLabel, formatKrw, formatSignedKrw, trendClass } from "../lib/format";
import { DAY_AI_REVIEW_PENDING, DAY_COST_NOTE } from "../lib/plainText";

export function DayReviewPage() {
  const [params, setParams] = useSearchParams();
  const dateParam = params.get("date");
  const review = useDayReview(dateParam);
  const market = useMarket();
  const { easy } = useViewMode();
  const date = review.data?.date ?? dateParam;
  // 분봉은 완성된 세션(KR 기준일 이하)만. 기준일을 모르면 일단 불러 본다
  const basis = market.data?.markets.find((m) => m.market === "KR")?.closeDate ?? null;
  const chartReady = !date || !basis || date <= basis;

  return (
    <>
      <PageHeader
        title="단타 복기"
        back
        right={
          <Link to="/day" className="hidden h-10 items-center rounded-xl px-3 text-[14px] font-semibold text-brand hover:bg-brand-soft sm:flex">
            연습장
          </Link>
        }
      />
      <div className="space-y-3">
        <Card>
          <label htmlFor="review-date" className="block text-[15px] font-semibold">
            세션 날짜
          </label>
          <div className="mt-1.5 flex flex-wrap items-center gap-3">
            <input
              id="review-date"
              type="date"
              value={date ?? ""}
              max={kstToday()}
              onChange={(e) => {
                const v = e.target.value;
                setParams(
                  (prev) => {
                    const sp = new URLSearchParams(prev);
                    if (v) sp.set("date", v);
                    else sp.delete("date");
                    return sp;
                  },
                  { replace: true },
                );
              }}
              className="h-12 rounded-xl bg-fill px-3.5 text-[16px] tabular-nums outline-none focus:ring-2 focus:ring-brand"
            />
            {date && <span className="text-[15px] text-sub">{formatDayLabel(date)}</span>}
          </div>
          <p className="mt-2 text-[13px] text-mute">체결·청산 기록 그대로 만든 복기예요. 체결가·청산가는 일어난 사실이라 그대로 보여요.</p>
        </Card>

        {review.isPending ? (
          <SkeletonCard lines={5} />
        ) : review.isError ? (
          <Card>
            <ErrorState message={errorMessage(review.error)} onRetry={() => void review.refetch()} />
          </Card>
        ) : (
          <>
            <Card aria-labelledby="review-totals-title">
              <h2 id="review-totals-title" className="text-[17px] font-bold">
                {formatDayLabel(review.data.date)} 합계
              </h2>
              <dl className="mt-2 grid gap-x-6 sm:grid-cols-2">
                <Row label="진입 체결">{review.data.totals.filled}건</Row>
                <Row label="이익 · 손실">
                  {review.data.totals.wins}건 · {review.data.totals.losses}건
                </Row>
                <Row label="실현 손익 (비용 포함)">
                  <span className={cn(trendClass(review.data.totals.pnlKrw))}>{formatSignedKrw(review.data.totals.pnlKrw)}</span>
                </Row>
                <Row label="비용 합계">{formatKrw(review.data.totals.costsKrw)}</Row>
              </dl>
              <p className="mt-2 text-[13px] text-mute">{DAY_COST_NOTE}.</p>
            </Card>

            <Card aria-label="AI 복기">
              <p className="flex items-center gap-1.5 text-[15px] font-semibold text-sub">
                <Icon name="sparkle" className="size-5 text-mute" />
                {DAY_AI_REVIEW_PENDING}
              </p>
              <p className="mt-1 text-[13px] text-mute">지금은 체결·청산 기록으로 만든 복기만 보여요.</p>
            </Card>

            {review.data.plans.length === 0 ? (
              <Card>
                <EmptyState>
                  이 날짜에 만든 단타 계획이 없어요.{" "}
                  <Link to="/day" className="font-semibold text-brand underline">
                    단타 연습장
                  </Link>
                </EmptyState>
              </Card>
            ) : (
              review.data.plans.map((item) => (
                <DayReviewItemCard key={item.plan.id} item={item} date={review.data.date} chartReady={chartReady} easy={easy} />
              ))
            )}
          </>
        )}
      </div>
    </>
  );
}
