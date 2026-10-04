// 단타 계획 목록 (그 세션의 내 계획, GET /api/day/plans). 한 줄 = 종목 · 상태 · 사는·목표·손절 가격 · 수량 (+ 끝났으면 사유·손익).
import { Link } from "react-router";
import type { TradePlan } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatKrw, formatQty, formatSignedKrw, trendClass } from "../../lib/format";
import { PLAN_STATUS_TEXT, exitReasonText, planStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";

export function DayPlanList({ plans, easy = false, className }: { plans: TradePlan[]; easy?: boolean; className?: string }) {
  return (
    <ul className={cn("divide-y divide-line", className)}>
      {plans.map((p) => (
        <li key={p.id}>
          <Link to={`/plans/${p.id}`} className="flex min-h-16 items-center gap-3 py-3 hover:bg-fill/60">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="truncate text-[16px] font-semibold">{p.name}</span>
                <span className="text-[13px] text-mute">{p.symbol}</span>
                <span className="inline-flex h-6 items-center rounded-md bg-fill px-2 text-[12px] font-bold text-sub">
                  {planStatusText(p.status, easy)}
                </span>
              </p>
              <p className="mt-0.5 text-[13px] text-sub tabular-nums">
                사는 {formatKrw(p.entryPrice)} · 목표 {formatKrw(p.targetPrice)} · 손절 {formatKrw(p.stopPrice)} · {formatQty(p.quantity)}
              </p>
              {p.exitReason && (
                <p className="mt-0.5 text-[13px] text-sub">
                  {exitReasonText(p.exitReason, easy)}
                  {p.pnlKrw !== null && <span className={cn("ml-1.5 font-semibold tabular-nums", trendClass(p.pnlKrw))}>{formatSignedKrw(p.pnlKrw)}</span>}
                </p>
              )}
              {p.status === "failed" && (
                <p className="mt-0.5 text-[13px] text-up">{easy || !p.failureReason ? PLAN_STATUS_TEXT.failed.line : p.failureReason}</p>
              )}
            </div>
            <Icon name="chevron" className="size-4 shrink-0 text-mute" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
