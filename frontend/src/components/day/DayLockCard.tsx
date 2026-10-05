// 단타 연습장 잠금 안내: 잠금 사유(DayStatus.lockReasons) → DAY_LOCK_TEXT, 마이의 주린이모드 스위치 입구(/my)와 퀴즈 입구(/day/quiz).
// 서버도 막는다 (미리 보기·계획 400 day_trading_locked). 잠겨도 상태·분봉·계획 목록·복기는 볼 수 있다.
// 버튼은 사유 목록과 같은 순서(서버 순서: 주린이모드 → 퀴즈)이고, 남은 단계 중 첫 번째만 주 버튼이다 — 같은 길을 한 가지로 안내한다.
// 끄기는 마이에서만 한다 (docs/컨셉변경계획.md 4-3 — 스위치는 마이에 둔다).
import { Link } from "react-router";
import type { DayLockReason } from "../../api/types";
import { cn } from "../../lib/cn";
import { DAY_LOCK_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Card } from "../ui";

const STEPS: { reason: DayLockReason; to: string; label: string }[] = [
  { reason: "beginner_mode", to: "/my", label: "마이에서 주린이모드 끄기" },
  { reason: "quiz_not_passed", to: "/day/quiz", label: "단타 연습 퀴즈 풀기" },
];

export function DayLockCard({ reasons, className }: { reasons: DayLockReason[]; className?: string }) {
  const steps = STEPS.filter((s) => reasons.includes(s.reason));
  const onlyBeginner = reasons.length === 1 && reasons[0] === "beginner_mode";
  return (
    <Card aria-labelledby="day-lock-title" className={className}>
      <h2 id="day-lock-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        {/* 잠김은 자물쇠 (모의투자 탭의 잠긴 단타 카드와 같은 모양 — 방패는 앱에서 '안전장치·위험도'를 뜻한다) */}
        <Icon name="lock" className="size-5 text-mute-weak" />
        단타 연습장이 잠겨 있어요
      </h2>
      <p className="mt-1 text-[14px] leading-snug text-sub">
        {onlyBeginner
          ? "퀴즈는 통과했어요. 마이에서 주린이모드를 끄면 열려요."
          : "단타는 하루 안에 사고팔아 손익이 크게 흔들리는 방식이에요. 주린이모드를 끄고 단타 연습 퀴즈 5문항을 모두 맞히면 열려요."}
      </p>
      <ul aria-label="잠금 사유" className="mt-3 space-y-1.5">
        {reasons.map((r) => (
          <li key={r} className="flex items-start gap-2 rounded-xl bg-fill px-3.5 py-2.5 text-[14px]">
            <Icon name="ban" className="mt-0.5 size-4 shrink-0 text-mute-weak" />
            {DAY_LOCK_TEXT[r] ?? r}
          </li>
        ))}
      </ul>
      {steps.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {steps.map((s, i) => (
            <Link
              key={s.reason}
              to={s.to}
              className={cn(
                "press flex h-12 items-center justify-center gap-1 rounded-xl text-[15px]",
                i === 0 ? "bg-brand font-bold text-white hover:bg-brand-dark" : "bg-fill font-semibold text-sub hover:bg-line",
              )}
            >
              {s.label}
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
