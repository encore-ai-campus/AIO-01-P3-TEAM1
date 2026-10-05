// 단타 복기 한 계획 (DayReviewItem — DB 사실 그대로): 결과(손익·청산 사유) → 계획 vs 실제(지정가·목표·손절 ↔ 진입·청산·비용) → 그 세션 분봉 → 사건 기록.
// 복기의 첫 질문은 '어떻게 끝났나', 그다음이 '계획과 무엇이 달랐나'라서 그 순서로 둔다.
// 체결가·청산가는 일어난 사실이라 그대로 보인다. 분봉은 완성된 세션만 (chartReady가 false면 안내만).
import type { ReactNode } from "react";
import { Link } from "react-router";
import type { DayReviewItem } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatKrw, formatQty, formatSignedKrw, trendClass } from "../../lib/format";
import { exitReasonText, planEventSentence } from "../../lib/plainText";
import { PlanStatusChip } from "../autotrade/Badges";
import { Icon } from "../Icon";
import { Card, Notice } from "../ui";
import { hm } from "./dayUtil";
import type { MinuteChartLine, MinuteChartMarker } from "./MinuteChart";
import { MinuteChartPanel } from "./MinuteChartPanel";

/** 이름 위 · 값 아래 한 칸 (좁은 두 열에서도 이름과 값이 멀어지지 않게). dt·dd 순서는 그대로다. */
function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] leading-tight text-mute">{label}</dt>
      <dd className="mt-0.5 text-[15px] font-medium tabular-nums text-ink">{children}</dd>
    </div>
  );
}

export function DayReviewItemCard({ item, date, chartReady, easy }: { item: DayReviewItem; date: string; chartReady: boolean; easy: boolean }) {
  const p = item.plan;
  const lines: MinuteChartLine[] = [
    { price: p.entryPrice, kind: "entry" },
    { price: p.targetPrice, kind: "target" },
    { price: p.stopPrice, kind: "stop" },
  ];
  const markers: MinuteChartMarker[] = [];
  if (item.entryAt && item.entryPrice !== null) markers.push({ time: item.entryAt, price: item.entryPrice, kind: "entry" });
  if (item.exitAt && item.exitPrice !== null) markers.push({ time: item.exitAt, price: item.exitPrice, kind: "exit" });

  return (
    <Card as="article" aria-label={`${p.name} 복기`}>
      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate text-[17px] font-bold">{p.name}</span>
          <span className="text-[13px] text-mute">{p.symbol}</span>
          <PlanStatusChip status={p.status} easy={easy} />
        </p>
        <Link
          to={`/plans/${p.id}`}
          className="-mt-2 -mr-2 inline-flex min-h-11 shrink-0 items-center rounded-xl px-2 text-[14px] font-semibold text-brand-ink transition-colors hover:bg-brand-soft active:bg-brand-soft"
        >
          계획 #{p.id}
          <Icon name="chevron" className="size-4" />
        </Link>
      </div>

      {/* 결과 한 줄: 손익(비용 포함)과 청산 사유 */}
      <div className="mt-2">
        <p className="text-[12px] text-mute">실현 손익 (비용 포함)</p>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className={cn("text-[22px] font-bold tabular-nums", trendClass(item.pnlKrw))}>
            {item.pnlKrw !== null ? formatSignedKrw(item.pnlKrw) : item.entryAt ? "청산 전" : "체결 전"}
          </span>
          {item.exitReason && <span className="text-[14px] font-semibold text-sub">{exitReasonText(item.exitReason, easy)}</span>}
        </p>
      </div>

      {/* 계획 vs 실제: 같은 높이의 두 열로 나란히 (무엇이 계획과 달랐나) */}
      <div className="mt-3 grid grid-cols-2 gap-x-4 rounded-xl bg-fill p-3.5">
        <div className="min-w-0">
          <p className="text-[12px] font-bold text-sub">계획</p>
          <dl className="mt-1.5 space-y-2">
            <Fact label="사는 가격 (지정가)">{formatKrw(p.entryPrice)}</Fact>
            <Fact label="목표 가격">{formatKrw(p.targetPrice)}</Fact>
            <Fact label="손절 가격">{formatKrw(p.stopPrice)}</Fact>
            <Fact label="수량">{formatQty(p.quantity)}</Fact>
          </dl>
        </div>
        <div className="min-w-0">
          <p className="text-[12px] font-bold text-sub">실제</p>
          <dl className="mt-1.5 space-y-2">
            <Fact label="진입 체결">{item.entryAt ? `${hm(item.entryAt)} · ${formatKrw(item.entryPrice)}` : "체결 안 됨"}</Fact>
            <Fact label="청산">{item.exitAt ? `${hm(item.exitAt)} · ${formatKrw(item.exitPrice)}` : "-"}</Fact>
            <Fact label="비용 (수수료·거래세)">{formatKrw(item.costsKrw)}</Fact>
          </dl>
        </div>
      </div>

      <div className="mt-4">
        {chartReady ? (
          <MinuteChartPanel symbol={p.symbol} name={p.name} date={date} title="그 세션 분봉" lines={lines} markers={markers} />
        ) : (
          <Notice>아직 끝나지 않은 세션이에요. 분봉은 장 마감 뒤(15:40)부터 볼 수 있어요.</Notice>
        )}
      </div>

      {item.events.length > 0 && (
        <details className="group mt-3 rounded-xl bg-fill">
          <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3.5 text-[14px] font-semibold text-sub transition-colors active:bg-line/60 [&::-webkit-details-marker]:hidden">
            사건 기록 {item.events.length}개
            <Icon name="chevron-down" className="size-4 shrink-0 text-mute-weak transition-transform duration-fast group-open:rotate-180" />
          </summary>
          <ol className="space-y-1.5 px-3.5 pb-3 text-[13px] leading-snug">
            {item.events.map((e) => (
              <li key={e.step} className="flex gap-2">
                <span className="shrink-0 text-mute tabular-nums">{hm(e.at)}</span>
                <span>{easy ? planEventSentence(e, p.currency) : e.message}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </Card>
  );
}
