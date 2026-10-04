// 단타 연습장 상태 카드: 세션(날짜·15:15 진입 마감·정규장) · 한도(리스크 엔진 DAY) · 오늘 쓴 양 (docs/API.md DayStatus).
import type { DayStatus } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatDayLabel, formatKrw, formatPercent } from "../../lib/format";
import { DAY_EOD_NOTE } from "../../lib/plainText";
import { Term } from "../Term";
import { Card, Row } from "../ui";
import { hm } from "./dayUtil";

export function DayStatusCard({ status, className }: { status: DayStatus; className?: string }) {
  const { session, limits, today } = status;
  const ordersFull = today.orders >= limits.maxDailyTrades;
  const lossFull = today.lossLimitKrw > 0 && today.lossKrw >= today.lossLimitKrw;
  return (
    <Card aria-labelledby="day-status-title" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="day-status-title" className="text-[17px] font-bold">
          {formatDayLabel(session.date)} 세션
        </h2>
        <span
          className={cn(
            "inline-flex h-7 items-center rounded-md px-2 text-[13px] font-bold",
            session.acceptingPlans ? "bg-ok-soft text-ok" : "bg-fill text-mute",
          )}
        >
          {session.acceptingPlans ? "계획을 만들 수 있어요" : "지금은 만들 수 없어요"}
        </span>
      </div>
      <p className="mt-1 text-[14px] text-sub">
        {session.acceptingPlans
          ? `오늘 ${hm(session.entryCutoffAt)} 전까지 만들 수 있어요`
          : `${formatDayLabel(session.date)} 0시부터 만들 수 있어요`}
      </p>

      <dl className="mt-3">
        <Row label="단타 진입 마감">{hm(session.entryCutoffAt)}</Row>
        <Row label="정규장">
          {hm(session.opensAt)}~{hm(session.closeAt)} · {session.isOpen ? "지금 열림" : "지금 닫힘"}
        </Row>
      </dl>
      <p className="mt-1 text-[13px] leading-snug text-mute">{DAY_EOD_NOTE}</p>

      <h3 className="mt-4 text-[14px] font-semibold text-sub">안전장치 한도</h3>
      <dl className="mt-1">
        <Row label="한 번에 걸 수 있는 위험">총자산의 {formatPercent(limits.riskPerTrade, 1)}</Row>
        <Row label="하루 최대 손실">총자산의 {formatPercent(limits.maxDailyLoss, 0)}</Row>
        <Row label="하루 최대 단타 주문">{limits.maxDailyTrades}건</Row>
        <Row label={<Term k="손익비">최소 손익비</Term>}>{limits.minRewardRisk.toFixed(1)}</Row>
      </dl>

      <h3 className="mt-4 text-[14px] font-semibold text-sub">오늘 쓴 양</h3>
      <dl className="mt-1">
        <Row label="단타 주문">
          <span className={cn(ordersFull && "text-up")}>
            {today.orders} / {limits.maxDailyTrades}건
          </span>
        </Row>
        <Row label="확정 손실">
          <span className={cn(lossFull && "text-up")}>
            {formatKrw(today.lossKrw)} / {formatKrw(today.lossLimitKrw)}
          </span>
        </Row>
      </dl>
      <p className="mt-1 text-[12px] text-mute">손실 한도 금액은 총자산(장마감 기준) × {formatPercent(limits.maxDailyLoss, 0)}예요.</p>
    </Card>
  );
}
