// 추천 출처·리스크 단계·계획 상태 배지. 상태는 색 + 아이콘 + 글자로 같이 보인다.
import type { RecommendationSource, RiskLevel } from "../../api/types";
import { cn } from "../../lib/cn";
import { RISK_LEVEL, SOURCE, planStatusOf } from "../../lib/autotrade";
import { Icon } from "../Icon";

const chip = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-bold whitespace-nowrap";

/** 출처 배지: "AI 리포트" / "AI 분석" / "시연용 · AI 아님". */
export function SourceBadge({ source, className }: { source: RecommendationSource; className?: string }) {
  const s = SOURCE[source] ?? { label: source, chip: "bg-fill text-sub", icon: "circle" as const, hint: "" };
  return (
    <span className={cn(chip, s.chip, className)} title={s.hint}>
      <Icon name={s.icon} className="size-3.5" />
      {s.label}
    </span>
  );
}

export function RiskLevelBadge({ level, className }: { level: RiskLevel | null; className?: string }) {
  if (!level) return null;
  const r = RISK_LEVEL[level];
  return (
    <span className={cn(chip, r.chip, className)}>
      <Icon name="shield" className="size-3.5" />
      {r.label}
    </span>
  );
}

export function PlanStatusChip({ status, className }: { status: string; className?: string }) {
  const s = planStatusOf(status);
  return (
    <span className={cn(chip, s.chip, className)}>
      <Icon name={s.icon} className={cn("size-3.5", status === "entry_pending" && "animate-pulse")} />
      {s.label}
    </span>
  );
}

/** 추천이 열려 있는지 (유효 기한 전/후). */
export function RecStatusChip({ open, className }: { open: boolean; className?: string }) {
  return (
    <span className={cn(chip, open ? "bg-ok-soft text-ok" : "bg-fill text-mute", className)}>
      <Icon name={open ? "check" : "clock"} className="size-3.5" />
      {open ? "활성화 가능" : "만료"}
    </span>
  );
}
