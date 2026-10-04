// 분봉 묶음: 세션 날짜 · 장마감 기준 표시 · 봉 간격 · 일부 구간·받을 수 없음 안내 + MinuteChart.
// 완성된 정규장 세션만 보인다 (docs/API.md "단타 연습"): date가 없으면 KR 기준일 — 장 전·장중은 직전 세션(계획용), 마감 뒤(15:40)는 그날(복기용).
import { useState } from "react";
import { ApiError, errorMessage } from "../../api/client";
import { useMinuteCandles } from "../../api/day";
import { MINUTE_PARTIAL, MINUTE_UNAVAILABLE } from "../../lib/plainText";
import { cn } from "../../lib/cn";
import { formatDayLabel } from "../../lib/format";
import { AsOf, ErrorState, Notice, Segmented, Skeleton } from "../ui";
import { MinuteChart, type MinuteChartLine, type MinuteChartMarker } from "./MinuteChart";

const STEPS = [
  { value: "1", label: "1분" },
  { value: "5", label: "5분" },
  { value: "15", label: "15분" },
] as const;
type Step = (typeof STEPS)[number]["value"];

export interface MinuteChartPanelProps {
  symbol: string;
  /** 종목 이름 (차트 이름에 쓴다). */
  name?: string;
  /** 세션 날짜 YYYY-MM-DD. 없으면 KR 기준일 (완성된 마지막 세션). */
  date?: string | null;
  lines?: MinuteChartLine[];
  markers?: MinuteChartMarker[];
  /** 제목 (기본 "분봉"). */
  title?: string;
  height?: number;
  className?: string;
}

export function MinuteChartPanel({ symbol, name, date = null, lines, markers, title = "분봉", height, className }: MinuteChartPanelProps) {
  const [step, setStep] = useState<Step>("1");
  const q = useMinuteCandles(symbol, { date, minutes: Number(step) });
  const data = q.data;
  const day = data?.date ?? date;
  const notYet = q.error instanceof ApiError && q.error.status === 400;

  return (
    <section aria-label={`${name ?? symbol} 분봉`} className={cn("min-w-0", className)}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-[15px] font-bold">
            {title}
            {day && <span className="ml-1.5 font-semibold text-sub">{formatDayLabel(day)} 정규장</span>}
          </h3>
          {data?.asOf ? <AsOf at={data.asOf} /> : <p className="text-[12px] font-medium text-mute">장마감 기준 · 완성된 세션만</p>}
        </div>
        <Segmented label="봉 간격" value={step} options={[...STEPS]} onChange={setStep} className="shrink-0" />
      </div>

      <div className="mt-2">
        {q.isPending ? (
          <Skeleton className="h-[260px] w-full" />
        ) : q.isError ? (
          notYet ? (
            <Notice>아직 끝나지 않은 세션이에요. 분봉은 장 마감 뒤(15:40)부터 볼 수 있어요.</Notice>
          ) : (
            <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
          )
        ) : !data || data.candles.length === 0 ? (
          <Notice tone="warn">{MINUTE_UNAVAILABLE}</Notice>
        ) : (
          <>
            {data.partial && (
              <Notice tone="warn" className="mb-2">
                {MINUTE_PARTIAL}
              </Notice>
            )}
            <MinuteChart
              candles={data.candles}
              lines={lines}
              markers={markers}
              height={height}
              label={`${name ?? symbol} ${formatDayLabel(data.date)} ${data.minutes}분봉 차트 (장마감 기준)`}
            />
          </>
        )}
      </div>
    </section>
  );
}
