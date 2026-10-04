// 단타 연습장 잠금 안내: 잠금 사유(DayStatus.lockReasons) → DAY_LOCK_TEXT, 퀴즈 입구(/day/quiz)와 마이의 주린이모드 스위치 입구(/my).
// 서버도 막는다 (미리 보기·계획 400 day_trading_locked). 잠겨도 상태·분봉·계획 목록·복기는 볼 수 있다.
import { Link } from "react-router";
import type { DayLockReason } from "../../api/types";
import { DAY_LOCK_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Card } from "../ui";

export function DayLockCard({ reasons, className }: { reasons: DayLockReason[]; className?: string }) {
  return (
    <Card aria-labelledby="day-lock-title" className={className}>
      <h2 id="day-lock-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="shield" className="size-5 text-mute" />
        단타 연습장이 잠겨 있어요
      </h2>
      <p className="mt-1 text-[14px] leading-snug text-sub">
        단타는 하루 안에 사고팔아 손익이 크게 흔들리는 방식이에요. 주린이모드를 끄고 단타 연습 퀴즈 5문항을 모두 맞히면 열려요.
      </p>
      <ul aria-label="잠금 사유" className="mt-3 space-y-1.5">
        {reasons.map((r) => (
          <li key={r} className="flex items-start gap-2 rounded-xl bg-fill px-3.5 py-2.5 text-[14px]">
            <Icon name="ban" className="mt-0.5 size-4 shrink-0 text-mute" />
            {DAY_LOCK_TEXT[r] ?? r}
          </li>
        ))}
      </ul>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        {reasons.includes("quiz_not_passed") && (
          <Link
            to="/day/quiz"
            className="flex h-12 items-center justify-center gap-1 rounded-xl bg-brand text-[15px] font-bold text-white hover:bg-brand-dark"
          >
            단타 연습 퀴즈 풀기
          </Link>
        )}
        {reasons.includes("beginner_mode") && (
          <Link to="/my" className="flex h-12 items-center justify-center gap-1 rounded-xl bg-fill text-[15px] font-semibold text-sub hover:bg-line">
            마이에서 주린이모드 끄기
          </Link>
        )}
      </div>
    </Card>
  );
}
