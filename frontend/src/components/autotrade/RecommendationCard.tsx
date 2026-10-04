// 추천 카드: 종목·출처·리스크 단계·진입/목표/손절·손익비·기대수익률·보유 기간·유효 기한·내 계획·팀 활성화 수. 누르면 상세.
import { Link } from "react-router";
import type { Recommendation } from "../../api/types";
import { timeLeft } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatPercent, formatPrice, formatRate } from "../../lib/format";
import { Icon } from "../Icon";
import { PlanStatusChip, RecStatusChip, RiskLevelBadge, SourceBadge } from "./Badges";

export function RecommendationCard({ r, compact }: { r: Recommendation; compact?: boolean }) {
  const open = r.status === "open";
  return (
    <Link
      to={`/recommendations/${r.id}`}
      aria-label={`${r.name} 추천 보기`}
      className={cn("block rounded-2xl bg-card p-5 transition-colors hover:bg-[#fafbfc] active:bg-fill", !open && "opacity-80")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-[17px] font-bold">{r.name}</h3>
          <p className="text-[13px] text-mute">
            {r.symbol} · {r.market === "KR" ? "국내" : "미국"}
            {r.requestedBy && ` · ${r.requestedBy}`}
          </p>
        </div>
        <RecStatusChip open={open} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <SourceBadge source={r.source} />
        <RiskLevelBadge level={r.riskLevel} />
        {r.myPlan && <PlanStatusChip status={r.myPlan.status} />}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-fill p-3 text-center">
        <div>
          <dt className="text-[12px] text-mute">진입</dt>
          <dd className="text-[14px] font-semibold tabular-nums">{formatPrice(r.entryPrice, r.currency)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">목표</dt>
          <dd className="text-[14px] font-semibold tabular-nums text-up">{formatPrice(r.targetPrice, r.currency)}</dd>
          <dd className="text-[11px] text-up tabular-nums">{formatRate(r.targetReturn, 1)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">손절</dt>
          <dd className="text-[14px] font-semibold tabular-nums text-down">{formatPrice(r.stopPrice, r.currency)}</dd>
          <dd className="text-[11px] text-down tabular-nums">{formatRate(r.stopLossRate, 1)}</dd>
        </div>
      </dl>

      {!compact && (
        <p className="mt-2 text-[13px] leading-relaxed text-sub">
          손익비 <b className="font-semibold text-ink tabular-nums">{r.rewardRisk.toFixed(2)}</b>
          <span className="mx-1.5 text-line">|</span>
          기대수익률 <b className="font-semibold text-ink tabular-nums">{formatRate(r.expectedReturn)}</b>
          <span className="mx-1.5 text-line">|</span>
          확률 <b className="font-semibold text-ink tabular-nums">{formatPercent(r.probability)}</b>
          {r.probabilityAssumed && <span className="ml-1 text-mute">(가정)</span>}
          <span className="mx-1.5 text-line">|</span>
          보유 {r.holdingDays}거래일
        </p>
      )}
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-mute">
        <span className="inline-flex items-center gap-1">
          <Icon name="clock" className="size-3.5" />
          {open ? timeLeft(r.validUntil) : "유효 기한 지남"}
        </span>
        <span>팀 활성화 {r.planCount}건</span>
      </p>
    </Link>
  );
}
