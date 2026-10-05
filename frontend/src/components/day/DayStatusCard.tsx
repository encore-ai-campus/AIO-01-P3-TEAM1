// 단타 연습장 상태 카드: 세션(날짜·15:15 진입 마감·정규장) · 한도(리스크 엔진 DAY, 접힘) · 오늘 쓴 양 (docs/API.md DayStatus).
// 배지는 '지금 이 사람이 만들 수 있는가'를 말한다: 잠겨 있으면 세션이 열려 있어도 '잠겨 있어요'.
// 한도 표는 바뀌지 않는 숫자라 접어 둔다 (자주 보는 마감·쓴 양이 위에 남게). 접혀도 DOM에는 있다(details).
import type { DayStatus } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatDayLabel, formatKrw, formatPercent } from "../../lib/format";
import { DAY_EOD_NOTE } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Term } from "../Term";
import { Card, Row } from "../ui";
import { USAGE_TEXT, hm, kstToday, usageLevel } from "./dayUtil";

export function DayStatusCard({ status, className }: { status: DayStatus; className?: string }) {
  const { session, limits, today } = status;
  const locked = !status.unlocked;
  const sessionLabel = formatDayLabel(session.date);
  const todayKst = kstToday();
  // 15:15 이후·주말이면 카드는 다음 세션인데 쓴 양과 '지금 열림'은 오늘 것이다 → 오늘 것임을 밝힌다
  const otherDay = session.date !== todayKst;
  const when = session.acceptingPlans ? `오늘 ${hm(session.entryCutoffAt)} 전까지` : `${sessionLabel} 0시부터`;
  const badge = locked
    ? { text: "잠겨 있어요", cls: "bg-fill text-mute" }
    : session.acceptingPlans
      ? { text: "계획을 만들 수 있어요", cls: "bg-ok-soft text-ok-ink" }
      : { text: "지금은 만들 수 없어요", cls: "bg-fill text-mute" };
  const orders = usageLevel(today.orders, limits.maxDailyTrades);
  const loss = usageLevel(today.lossKrw, today.lossLimitKrw);

  return (
    <Card aria-labelledby="day-status-title" className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="day-status-title" className="text-[17px] font-bold">
          {sessionLabel} 세션
        </h2>
        <span className={cn("inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] font-bold", badge.cls)}>
          {locked && <Icon name="lock" className="size-3.5" />}
          {badge.text}
        </span>
      </div>
      <p className="mt-1 text-[14px] text-sub">{locked ? `잠금을 풀면 ${when} 만들 수 있어요` : `${when} 만들 수 있어요`}</p>

      <dl className="mt-3">
        <Row label="단타 진입 마감">{hm(session.entryCutoffAt)}</Row>
        <Row label="정규장">
          {hm(session.opensAt)}~{hm(session.closeAt)}
          {!otherDay && (session.isOpen ? " · 지금 열림" : " · 지금 닫힘")}
        </Row>
      </dl>
      <p className="mt-1 text-[13px] leading-snug text-mute">{DAY_EOD_NOTE}</p>

      <h3 className="mt-4 text-[14px] font-semibold text-sub">{otherDay ? `${formatDayLabel(todayKst)} 쓴 양` : "오늘 쓴 양"}</h3>
      <dl className="mt-1">
        <Row label="단타 주문">
          <span className={USAGE_TEXT[orders]}>
            {today.orders} / {limits.maxDailyTrades}건
          </span>
        </Row>
        <Row label="확정 손실">
          <span className={USAGE_TEXT[loss]}>
            {formatKrw(today.lossKrw)} / {formatKrw(today.lossLimitKrw)}
          </span>
        </Row>
      </dl>

      <details className="group mt-3 rounded-xl bg-fill">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-3.5 text-[14px] font-semibold text-sub transition-colors active:bg-line/60 [&::-webkit-details-marker]:hidden">
          안전장치 한도
          <Icon name="chevron-down" className="size-4 shrink-0 text-mute-weak transition-transform duration-fast group-open:rotate-180" />
        </summary>
        <div className="px-3.5 pb-2.5">
          <dl>
            <Row label="한 번에 걸 수 있는 위험">총자산의 {formatPercent(limits.riskPerTrade, 1)}</Row>
            <Row label="하루 최대 손실">총자산의 {formatPercent(limits.maxDailyLoss, 0)}</Row>
            <Row label="하루 최대 단타 주문">{limits.maxDailyTrades}건</Row>
            <Row label={<Term k="손익비">최소 손익비</Term>}>{limits.minRewardRisk.toFixed(1)}</Row>
          </dl>
          <p className="mt-1 text-[12px] leading-snug text-mute">손실 한도 금액은 총자산(장마감 기준) × {formatPercent(limits.maxDailyLoss, 0)}예요.</p>
        </div>
      </details>
    </Card>
  );
}
