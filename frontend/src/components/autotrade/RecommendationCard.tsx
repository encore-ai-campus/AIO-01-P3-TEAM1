// 추천(새 계획 제안) 카드: 종목·출처·리스크 단계·진입/목표/손절·손익비·기대수익률·보유 기간·유효 기한·내 계획·팀 활성화 수. 누르면 상세.
// easy면 쉬운 보기: 사는·목표·손절 가격과 보유 기간만 (기대수익률·확률은 성공 확률로 오해할 수 있어 숨긴다 — docs/컨셉변경계획.md 4-4).
import { Link } from "react-router";
import type { Recommendation } from "../../api/types";
import { timeLeft } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatPercent, formatPrice, formatRate } from "../../lib/format";
import { Icon } from "../Icon";
import { PlanStatusChip, RecStatusChip, RiskLevelBadge, SourceBadge } from "./Badges";

export function RecommendationCard({ r, compact, easy = false }: { r: Recommendation; compact?: boolean; easy?: boolean }) {
  const open = r.status === "open";
  return (
    <Link
      to={`/recommendations/${r.id}`}
      aria-label={easy ? `${r.name} 계획 제안 보기` : `${r.name} 추천 보기`}
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
        <RecStatusChip open={open} easy={easy} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <SourceBadge source={r.source} />
        {!easy && <RiskLevelBadge level={r.riskLevel} />}
        {r.myPlan && <PlanStatusChip status={r.myPlan.status} easy={easy} />}
      </div>

      <dl className="mt-3 grid grid-cols-3 gap-2 rounded-xl bg-fill p-3 text-center">
        <div>
          <dt className="text-[12px] text-mute">{easy ? "사는 가격" : "진입"}</dt>
          <dd className="text-[14px] font-semibold tabular-nums">{formatPrice(r.entryPrice, r.currency)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">{easy ? "목표 가격" : "목표"}</dt>
          <dd className="text-[14px] font-semibold tabular-nums text-up">{formatPrice(r.targetPrice, r.currency)}</dd>
          <dd className="text-[11px] text-up tabular-nums">{formatRate(r.targetReturn, 1)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">{easy ? "손절 가격" : "손절"}</dt>
          <dd className="text-[14px] font-semibold tabular-nums text-down">{formatPrice(r.stopPrice, r.currency)}</dd>
          <dd className="text-[11px] text-down tabular-nums">{formatRate(r.stopLossRate, 1)}</dd>
        </div>
      </dl>

      {!compact &&
        (easy ? (
          <p className="mt-2 text-[13px] leading-relaxed text-sub">
            산 뒤 최대 {r.holdingDays}거래일 보유해요 · 목표에 팔면 버는 돈이 손절에 팔면 잃는 돈의 {r.rewardRisk.toFixed(1)}배예요
          </p>
        ) : (
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
        ))}
      <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-mute">
        <span className="inline-flex items-center gap-1">
          <Icon name="clock" className="size-3.5" />
          {open ? timeLeft(r.validUntil) : easy ? "기한이 지났어요" : "유효 기한 지남"}
        </span>
        <span>
          {easy ? "팀에서 시작" : "팀 활성화"} {r.planCount}건
        </span>
      </p>
    </Link>
  );
}
