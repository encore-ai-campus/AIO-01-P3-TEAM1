// 추천 출처·리스크 단계·계획 상태·보유 방식 배지. 상태는 색 + 아이콘 + 글자로 같이 보인다.
// easy면 쉬운 보기 문구(docs/컨셉변경계획.md 4-4, lib/plainText.ts), 아니면 전문가 보기 문구.
import type { HoldingStyle, RecommendationSource, RiskLevel } from "../../api/types";
import { cn } from "../../lib/cn";
import { RISK_LEVEL, SOURCE, STYLE_BADGE, planStatusOf } from "../../lib/autotrade";
import { HOLDING_STYLE_TEXT, planStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";

const chip = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-bold whitespace-nowrap";

/** 출처 배지: "AI 리포트" / "AI 교차검증 분석" / "연습용 예시 · AI 아님" / "단타 연습 · AI 아님". */
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

/** 계획 상태. easy면 "사는 가격을 기다리는 중"처럼 쉬운 말. */
export function PlanStatusChip({ status, easy, className }: { status: string; easy?: boolean; className?: string }) {
  const s = planStatusOf(status);
  return (
    <span className={cn(chip, s.chip, className)}>
      <Icon name={s.icon} className={cn("size-3.5", status === "entry_pending" && "animate-pulse")} />
      {easy ? planStatusText(status, true) : s.label}
    </span>
  );
}

/** 추천이 열려 있는지 (유효 기한 전/후). */
export function RecStatusChip({ open, easy, className }: { open: boolean; easy?: boolean; className?: string }) {
  return (
    <span className={cn(chip, open ? "bg-ok-soft text-ok" : "bg-fill text-mute", className)}>
      <Icon name={open ? "check" : "clock"} className="size-3.5" />
      {open ? (easy ? "시작할 수 있음" : "활성화 가능") : easy ? "기한 지남" : "만료"}
    </span>
  );
}

/** 보유 방식 배지: 스윙 · 장기 · 단타 (풀이는 title). */
export function StyleBadge({ style, className }: { style: HoldingStyle; className?: string }) {
  const s = STYLE_BADGE[style] ?? { label: style, chip: "bg-fill text-sub" };
  return (
    <span className={cn(chip, s.chip, className)} title={HOLDING_STYLE_TEXT[style]?.hint}>
      {s.label}
    </span>
  );
}
