// 단타 복기 한 계획 (DayReviewItem — DB 사실 그대로): 지정가·체결(진입·청산)·사유·손익·비용 + 그 세션 분봉(진입·청산 표시) + 사건 기록.
// 체결가·청산가는 일어난 사실이라 그대로 보인다. 분봉은 완성된 세션만 (chartReady가 false면 안내만).
import { Link } from "react-router";
import type { DayReviewItem } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatKrw, formatQty, formatSignedKrw, trendClass } from "../../lib/format";
import { exitReasonText, planEventSentence, planStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Card, Notice, Row } from "../ui";
import { hm } from "./dayUtil";
import type { MinuteChartLine, MinuteChartMarker } from "./MinuteChart";
import { MinuteChartPanel } from "./MinuteChartPanel";

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
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-[17px] font-bold">{p.name}</span>
            <span className="text-[13px] text-mute">{p.symbol}</span>
          </p>
          <span className="mt-1 inline-flex h-6 items-center rounded-md bg-fill px-2 text-[12px] font-bold text-sub">{planStatusText(p.status, easy)}</span>
        </div>
        <Link to={`/plans/${p.id}`} className="flex shrink-0 items-center text-[14px] font-semibold text-brand">
          계획 #{p.id}
          <Icon name="chevron" className="size-4" />
        </Link>
      </div>

      <dl className="mt-3 grid gap-x-6 sm:grid-cols-2">
        <Row label="사는 가격 (지정가)">{formatKrw(p.entryPrice)}</Row>
        <Row label="수량">{formatQty(p.quantity)}</Row>
        <Row label="목표 · 손절">
          {formatKrw(p.targetPrice)} · {formatKrw(p.stopPrice)}
        </Row>
        <Row label="진입 체결">{item.entryAt ? `${hm(item.entryAt)} · ${formatKrw(item.entryPrice)}` : "체결 안 됨"}</Row>
        <Row label="청산">{item.exitAt ? `${hm(item.exitAt)} · ${formatKrw(item.exitPrice)}` : "-"}</Row>
        <Row label="청산 사유">{item.exitReason ? exitReasonText(item.exitReason, easy) : "-"}</Row>
        <Row label="실현 손익 (비용 포함)">
          <span className={cn(trendClass(item.pnlKrw))}>{item.pnlKrw === null ? "-" : formatSignedKrw(item.pnlKrw)}</span>
        </Row>
        <Row label="비용 (수수료·거래세)">{formatKrw(item.costsKrw)}</Row>
      </dl>

      <div className="mt-4">
        {chartReady ? (
          <MinuteChartPanel symbol={p.symbol} name={p.name} date={date} title="그 세션 분봉" lines={lines} markers={markers} />
        ) : (
          <Notice>아직 끝나지 않은 세션이에요. 분봉은 장 마감 뒤(15:40)부터 볼 수 있어요.</Notice>
        )}
      </div>

      {item.events.length > 0 && (
        <details className="mt-3 rounded-xl bg-fill px-3.5 py-2.5">
          <summary className="cursor-pointer text-[14px] font-semibold text-sub">사건 기록 {item.events.length}개</summary>
          <ol className="mt-2 space-y-1.5 text-[13px] leading-snug">
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
