// 추천 출처·리스크 단계·계획 상태·보유 방식 배지. 상태는 색 + 아이콘 + 글자로 같이 보인다.
// easy면 쉬운 보기 문구(docs/plans/컨셉변경계획.md 4-4, lib/plainText.ts), 아니면 전문가 보기 문구.
// 칩은 움직이지 않는다: 며칠씩 이어지는 '체결 대기' 동안 깜빡이면 아무 일 없는 대기에 움직임이 가장 많아진다 (trade-09).
import type { HoldingStyle, Recommendation, RecommendationSource, RiskLevel } from "../../api/types";
import { cn } from "../../lib/cn";
import { RISK_LEVEL, SOURCE, STYLE_BADGE, blockedCodes, planStatusOf, timeLeftShort } from "../../lib/autotrade";
import { HOLDING_STYLE_TEXT, MANUAL_START_TEXT, blockedShort, planStatusText, priceExpiredText } from "../../lib/plainText";
import { Icon } from "../Icon";

const chip = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-bold whitespace-nowrap";

/**
 * 출처 배지: "AI 리포트" / "AI 교차검증 분석" / "연습용 예시 · AI 아님".
 * 줄어들지 않는다 — 'AI 아님'은 잘리면 안 되는 안내다 (docs/DECISIONS.md 13-1 D-4). 좁은 줄에서는 다른 것을 다음 줄로 보낸다.
 */
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
      <Icon name={s.icon} className="size-3.5" />
      {easy ? planStatusText(status, true) : s.label}
    </span>
  );
}

/**
 * 추천의 유효 기한 (시간 사실만). 시작할 수 있는지는 안전장치가 정하므로 이 칩은 말하지 않는다 —
 * 기한이 남은 계획도 손익비·진행 중 계획 때문에 막힐 수 있다 (trade-04). 하루 안 남았으면 주황.
 * 쉬운 보기 "기한 2일 남음"/"기한 지남", 전문가 보기 "유효 · 2일 남음"/"만료".
 * 가격이 이미 손절가·목표가를 지나 끝났으면(expiredReason, DECISIONS 25장) 쉬운 "손절 가격 아래로 내려감" · 전문가 "손절가 이탈로 만료" 등.
 */
export function RecStatusChip({
  open,
  validUntil,
  expiredReason,
  easy,
  className,
}: {
  open: boolean;
  validUntil?: string;
  expiredReason?: Recommendation["expiredReason"];
  easy?: boolean;
  className?: string;
}) {
  const left = open && validUntil ? timeLeftShort(validUntil) : null;
  const soon = left !== null && !left.includes("일");
  const text = open
    ? left
      ? easy
        ? `기한 ${left}`
        : `유효 · ${left}`
      : easy
        ? "기한 안"
        : "유효"
    : (priceExpiredText(expiredReason, Boolean(easy), "short") ?? (easy ? "기한 지남" : "만료"));
  return (
    <span className={cn(chip, !open ? "bg-fill text-mute" : soon ? "bg-warn-soft text-warn-ink" : "bg-fill text-sub", className)}>
      <Icon name="clock" className="size-3.5" />
      {text}
    </span>
  );
}

/** 실행 확인 머리의 칩: 안전장치(리스크 미리 보기)가 정한 결과. 아래 실행 확인 카드와 같은 말을 한다 (trade-04). */
export function ReadinessChip({ state, easy, className }: { state: "ready" | "blocked" | "live"; easy?: boolean; className?: string }) {
  const s = {
    ready: { cls: "bg-ok-soft text-ok-ink", icon: "check" as const, text: easy ? "시작할 수 있음" : "활성화 가능" },
    blocked: { cls: "bg-fill text-sub", icon: "ban" as const, text: easy ? "지금은 시작할 수 없음" : "활성화 불가" },
    live: { cls: "bg-brand-soft text-brand-ink", icon: "bolt" as const, text: easy ? "진행 중인 계획 있음" : "진행 중 계획 있음" },
  }[state];
  return (
    <span className={cn(chip, s.cls, className)}>
      <Icon name={s.icon} className="size-3.5" />
      {s.text}
    </span>
  );
}

type ReadinessInput = Pick<Recommendation, "status" | "myPlan"> & { blockedBy?: readonly string[]; expiredReason?: Recommendation["expiredReason"] };

const LIVE_PLAN = ["active", "entry_pending", "holding"];

/**
 * 계획 제안 목록 카드의 시작 가능 표시 (UX-2, DECISIONS 23장). 계좌와 무관한 사유(blockedBy)로만 말한다 — 비어 있어도 내 계좌 사정
 * (현금·한도·같은 종목)으로 막힐 수 있어 최종 판단은 상세의 안전장치다. 막혔으면 이유 한 마디를 이어 쓰고, 좁으면 줄을 바꾼다.
 * 진행 중인 내 계획이 있으면 그 상태 칩(PlanStatusChip)이 말하므로 그리지 않는다.
 */
export function ProposalReadiness({ r, easy, className }: { r: ReadinessInput; easy?: boolean; className?: string }) {
  if (r.myPlan && LIVE_PLAN.includes(r.myPlan.status)) return null;
  const codes = blockedCodes(r);
  if (codes.length === 0) return <ReadinessChip state="ready" easy={easy} className={className} />;
  // 가격이 이미 손절가·목표가를 지나 끝난 제안은 그 까닭을 먼저 (기한 사유 '기한이 끝났어요'로 말하지 않게 — DECISIONS 25장)
  const short = (r.status !== "open" ? priceExpiredText(r.expiredReason, Boolean(easy), "short") : null) ?? blockedShort(codes, easy);
  return (
    <span className={cn("inline-flex min-h-6 max-w-full items-start gap-1 rounded-md bg-fill px-1.5 py-0.5 text-[12px] leading-snug font-bold text-sub", className)}>
      <Icon name="ban" className="mt-px size-3.5 shrink-0" />
      <span>{`${easy ? "지금은 시작할 수 없음" : "활성화 불가"}${short ? ` · ${short}` : ""}`}</span>
    </span>
  );
}

/** 압축 행(모의투자 탭·홈)의 작은 표시: 지금은 시작할 수 없는 제안에만 (이유는 상세에서). */
export function BlockedMark({ r, easy, className }: { r: ReadinessInput; easy?: boolean; className?: string }) {
  if ((r.myPlan && LIVE_PLAN.includes(r.myPlan.status)) || blockedCodes(r).length === 0) return null;
  return (
    <span className={cn(chip, "bg-fill text-sub", className)}>
      <Icon name="ban" className="size-3.5" />
      {easy ? "시작할 수 없음" : "활성화 불가"}
    </span>
  );
}

/** 시연용 수동 시작 계획 표시 (TradePlan.manualStart, DECISIONS 31장). 줄어들지 않는다 (chip에 shrink-0). */
export function ManualStartBadge({ id, className }: { id?: string; className?: string }) {
  return (
    <span id={id} className={cn(chip, "bg-warn-soft text-warn-ink", className)} title={MANUAL_START_TEXT.planNote.expert}>
      <Icon name="alert" className="size-3.5" />
      {MANUAL_START_TEXT.badge}
    </span>
  );
}

/**
 * 내 주식의 주문·보유·예약 행이 진행 중 모의 자동매매에 묶여 있다는 표시 (trade-05). 일반 주문처럼 보여 바로 취소하면 계획까지 끝나므로
 * 행만 봐도 알게 한다. stopping: 계획의 모두 팔기 예약(멈추는 중). manual: 시연용 수동 시작 계획이면 끝에 " · 시연용" (DECISIONS 31장).
 */
export function AutoTradeBadge({
  planId,
  easy,
  stopping = false,
  manual = false,
  className,
}: {
  planId: number;
  easy?: boolean;
  stopping?: boolean;
  manual?: boolean;
  className?: string;
}) {
  const text =
    (stopping ? (easy ? "모의 자동매매 멈추는 중" : `자동매매 #${planId} 매도`) : easy ? "모의 자동매매" : `자동매매 #${planId}`) + (manual ? " · 시연용" : "");
  return (
    <span className={cn(chip, stopping ? "bg-warn-soft text-warn-ink" : "bg-brand-soft text-brand-ink", className)}>
      <Icon name="flow" className="size-3.5" />
      {text}
    </span>
  );
}

/** 보유 방식 배지: 스윙 · 장기 (풀이는 title). */
export function StyleBadge({ style, className }: { style: HoldingStyle; className?: string }) {
  const s = STYLE_BADGE[style] ?? { label: style, chip: "bg-fill text-sub" };
  return (
    <span className={cn(chip, s.chip, className)} title={HOLDING_STYLE_TEXT[style]?.hint}>
      {s.label}
    </span>
  );
}
