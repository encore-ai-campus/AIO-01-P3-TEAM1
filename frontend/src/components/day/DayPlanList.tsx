// 단타 계획 목록 (그 세션의 내 계획, GET /api/day/plans). 한 줄 = 종목 · 수량 · 상태 / 사는·목표·손절 가격 (+ 끝났으면 사유·손익).
// 상태 칩은 모의투자 탭의 다른 계획 목록과 같은 PlanStatusChip (색 + 아이콘 + 글자)이라 진행 중·끝남·실패를 한눈에 가른다.
// 방금 만든 계획 줄은 .is-new로 한 번 올라오며 나타난다 (부모가 useNewKeys로 고른다 — 폴링으로 상태만 바뀐 줄은 움직이지 않는다).
import { Link } from "react-router";
import type { TradePlan } from "../../api/types";
import type { RevealProps } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatNumber, formatQty, formatSignedKrw, trendClass } from "../../lib/format";
import { PLAN_STATUS_TEXT, exitReasonText } from "../../lib/plainText";
import { PlanStatusChip } from "../autotrade/Badges";
import { Icon } from "../Icon";

export function DayPlanList({
  plans,
  easy = false,
  fresh,
  reveal,
  className,
}: {
  plans: TradePlan[];
  easy?: boolean;
  /** 방금 새로 붙은 계획 id (한 번 강조). */
  fresh?: ReadonlySet<number>;
  /** 처음 나타날 때의 props (revealList). */
  reveal?: RevealProps;
  className?: string;
}) {
  return (
    <ul {...reveal} className={cn("divide-y divide-line", className)}>
      {plans.map((p) => (
        <li key={p.id} className={cn(fresh?.has(p.id) && "is-new")}>
          <Link to={`/plans/${p.id}`} className="press-row -mx-2 flex min-h-16 items-center gap-3 rounded-xl px-2 py-3">
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="truncate text-[16px] font-semibold">{p.name}</span>
                <span className="text-[13px] text-mute tabular-nums">{formatQty(p.quantity)}</span>
                <PlanStatusChip status={p.status} easy={easy} />
              </p>
              {/* 원은 빼고 숫자만 — 한 줄에 셋이 들어가게 (구분점으로 시작하는 줄이 생기지 않게) */}
              <p className="mt-0.5 text-[13px] text-sub tabular-nums">
                사는 {formatNumber(p.entryPrice)} · 목표 {formatNumber(p.targetPrice)} · 손절 {formatNumber(p.stopPrice)}
              </p>
              {p.exitReason && (
                <p className="mt-0.5 text-[13px] text-sub">
                  {exitReasonText(p.exitReason, easy)}
                  {p.pnlKrw !== null && <span className={cn("ml-1.5 font-semibold tabular-nums", trendClass(p.pnlKrw))}>{formatSignedKrw(p.pnlKrw)}</span>}
                </p>
              )}
              {p.status === "failed" && (
                <p className="mt-0.5 text-[13px] text-up-ink">{easy || !p.failureReason ? PLAN_STATUS_TEXT.failed.line : p.failureReason}</p>
              )}
            </div>
            <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
          </Link>
        </li>
      ))}
    </ul>
  );
}
