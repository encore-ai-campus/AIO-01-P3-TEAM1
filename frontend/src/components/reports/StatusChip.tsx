// 리포트·노드·전달 방식 배지. 상태는 색 + 아이콘 + 글자로 같이 보인다.
// 색은 토큰만: 연한 바탕 위 글자는 *-ink, 반전 칩(bg-ink) 위는 text-on-ink, 주황(bg-warn) 위는 text-on-warn — 다크에서도 읽히게.
// '실행 중'은 도는 아이콘 대신 살아 있음 점(LiveDot — 움직임 줄이기에서는 멈춘 점). 범례처럼 장식 자리는 live={false}로 움직이지 않는다.
import type { Delivery } from "../../api/reports";
import type { ReportStatus } from "../../api/types";
import { cn } from "../../lib/cn";
import { NODE_STATUS, REPORT_STATUS, type NodeStatus } from "../../lib/reports";
import { Icon } from "../Icon";
import { LiveDot } from "../ui";

const chip = "inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-bold whitespace-nowrap";

export function NodeStatusChip({ status, live = true, className }: { status: NodeStatus; live?: boolean; className?: string }) {
  const s = NODE_STATUS[status];
  return (
    <span className={cn(chip, s.chip, className)}>
      {status === "started" && live ? <LiveDot className="mx-0.5" /> : <Icon name={s.icon} className="size-3.5" />}
      {s.label}
    </span>
  );
}

export function ReportStatusBadge({ status, className }: { status: ReportStatus; className?: string }) {
  const s = REPORT_STATUS[status];
  return (
    <span className={cn(chip, s.chip, className)}>
      <Icon name={s.icon} className="size-3.5" />
      {s.label}
    </span>
  );
}

const DELIVERY: Record<Delivery, { label: string; cls: string; hint: string }> = {
  sse: { label: "실시간 SSE", cls: "bg-brand text-white", hint: "실행 사건을 서버가 생기는 즉시 보내 줍니다." },
  snapshot: { label: "Snapshot", cls: "bg-fill text-sub", hint: "저장된 상태(Snapshot)를 받아 보여 줍니다. 실행 중이면 3초마다 다시 받습니다." },
  idle: { label: "대기", cls: "bg-fill text-mute", hint: "아직 실행 전이라 실시간 연결을 열지 않았습니다." },
};

/** 전달 방식 배지: 실시간 SSE / Snapshot / 대기. */
export function DeliveryBadge({ delivery }: { delivery: Delivery }) {
  const d = DELIVERY[delivery];
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] text-mute" title={d.hint}>
      전달 방식
      <span className={cn(chip, d.cls)}>
        <Icon name={delivery === "sse" ? "bolt" : delivery === "snapshot" ? "doc" : "clock"} className="size-3.5" />
        {d.label}
      </span>
    </span>
  );
}

/** 예시 재생 중임을 알리는 표시. 주황 바탕 위 어두운 글자 (흰 글자는 2.06:1이라 읽히지 않는다). */
export function ExampleTag({ className }: { className?: string }) {
  return <span className={cn(chip, "bg-warn text-on-warn", className)}>예시</span>;
}

/** 자동 리포트(거래대금 상위 선별) 표시. 반전 칩 — 다크에서는 밝은 칩 + 어두운 글자. */
export function AutoBadge({ className }: { className?: string }) {
  return <span className={cn(chip, "bg-ink text-on-ink", className)}>자동</span>;
}

/** 장애 주입 표시 (신청 때 켰거나, 그 실패가 주입된 것). */
export function InjectedBadge({ className }: { className?: string }) {
  return (
    <span className={cn(chip, "bg-warn-soft text-warn-ink", className)}>
      <Icon name="bolt" className="size-3.5" />
      주입
    </span>
  );
}

/** 실패가 있었지만 재시도·대체 모델로 끝까지 답함. 작은 글자 배지라 연초록 바탕 + 초록 글자(ok-ink, 4.5:1 이상) — 초록 위 흰 글자는 3.2:1이라 쓰지 않는다. */
export function RecoveredBadge({ className }: { className?: string }) {
  return (
    <span className={cn(chip, "bg-ok-soft text-ok-ink", className)}>
      <Icon name="shield" className="size-3.5" />
      자동 복구
    </span>
  );
}
