// 교차검증 분석 판정의 전문가 배지 (BUY 매수 · PASS 지켜보기 — 리포트 의견 '지켜보기'와 같은 말, UX-5).
// 공용 VerdictBadge(components/ui.tsx)는 판정 코드를 그대로 보이므로 분석 카드·목록·상세는 이 배지를 쓴다. 모양은 VerdictBadge와 같다.
import type { Verdict } from "../../api/types";
import { cn } from "../../lib/cn";
import { VERDICT_TEXT } from "../../lib/reports";

export function VerdictText({ verdict, className }: { verdict: Verdict; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-[12px] font-bold whitespace-nowrap",
        verdict === "BUY" ? "bg-brand-soft text-brand-ink" : "bg-fill text-sub",
        className,
      )}
    >
      {VERDICT_TEXT[verdict]}
    </span>
  );
}
