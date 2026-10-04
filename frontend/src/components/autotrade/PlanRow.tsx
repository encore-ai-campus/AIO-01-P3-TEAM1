// 계획 한 줄: 종목·상태·수량·진입/체결·목표/손절·손익·출처. 누르면 /plans/:id.
import { Link } from "react-router";
import type { TradePlan } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatDateTime, formatPrice, formatQty, formatSignedKrw, trendClass } from "../../lib/format";
import { PlanStatusChip, SourceBadge } from "./Badges";

export function PlanRow({ p }: { p: TradePlan }) {
  return (
    <Link to={`/plans/${p.id}`} aria-label={`${p.name} 계획 보기`} className="block px-5 py-4 hover:bg-fill/60">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-[16px] font-semibold">{p.name}</p>
          <p className="text-[13px] text-mute tabular-nums">
            {formatQty(p.quantity)} · 진입 {formatPrice(p.entryPrice, p.currency)}
            {p.fillPrice != null && ` · 체결 ${formatPrice(p.fillPrice, p.currency)}`}
          </p>
        </div>
        <PlanStatusChip status={p.status} />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
        <SourceBadge source={p.source} />
        <span className="text-up tabular-nums">목표 {formatPrice(p.targetPrice, p.currency)}</span>
        <span className="text-down tabular-nums">손절 {formatPrice(p.stopPrice, p.currency)}</span>
        {p.pnlKrw != null && <span className={cn("font-semibold tabular-nums", trendClass(p.pnlKrw))}>손익 {formatSignedKrw(p.pnlKrw)}</span>}
        <span className="ml-auto text-mute">{formatDateTime(p.activatedAt)}</span>
      </div>
    </Link>
  );
}
