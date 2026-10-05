// 마이의 단타 연습 입구 (주린이모드 카드 안 맨 아래 — 주린이모드를 끄면 펼쳐진다). 연습 퀴즈 5문항을 모두 맞혀야 단타 연습장이 열린다.
// 여기서 보여 줄 것은 '스위치를 끄니 열렸다'는 인과와 상태 한 줄뿐이다. 설명·비용 안내가 있는 큰 입구는 모의투자 탭(실행 단계)에 있다.
import { Link } from "react-router";
import type { RiskProfile } from "../../api/types";
import { errorMessage } from "../../api/client";
import { useBeginnerMode } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { DAY_LOCK_TEXT, RISK_PROFILE_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { ErrorState, Notice, Skeleton } from "../ui";

// 성향과 맞지 않는 서비스를 고르면 한 줄 안내 (docs/투자서비스확장계획.md 2-3)
const CAREFUL: RiskProfile[] = ["stable", "stable_seeking"];

const linkClass = "press flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl text-[15px] font-semibold";

export function DayQuizEntry() {
  const { profile, profileError, refetchProfile } = useBeginnerMode();
  const passedAt = profile?.dayQuizPassedAt ?? null;
  const risk = profile?.riskProfile ?? null;
  return (
    <section aria-labelledby="day-entry-title" className="space-y-3 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <h3 id="day-entry-title" className="flex items-center gap-1.5 text-[16px] font-bold">
          <Icon name="bolt" className="size-5 text-mute-weak" />
          단타 연습장
        </h3>
        {passedAt && (
          // 초록 글자는 흰 카드 위 대비가 모자라(3.3:1) 체크만 초록으로, 글자는 sub로
          <p className="flex items-center gap-1 text-[13px] font-semibold text-sub">
            <Icon name="check" className="size-4 text-ok" />
            연습 퀴즈 통과 · {formatDateTime(passedAt)}
          </p>
        )}
      </div>
      {risk && CAREFUL.includes(risk) && (
        <Notice tone="warn">하루 안에 사고파는 연습은 손실 변동이 커요. 성향 진단: {RISK_PROFILE_TEXT[risk]}</Notice>
      )}
      {!profile ? (
        profileError ? (
          <ErrorState compact message={errorMessage(profileError)} onRetry={refetchProfile} />
        ) : (
          <Skeleton className="h-11 w-full rounded-xl" />
        )
      ) : passedAt ? (
        <div className="flex gap-2">
          {/* 모의투자 탭의 입구(PortfolioPage DayEntry)와 같은 이름 — 같은 곳으로 가는 링크를 두 이름으로 부르지 않는다 */}
          <Link to="/day" className={cn(linkClass, "bg-brand text-white hover:bg-brand-dark")}>
            단타 연습장 열기
          </Link>
          <Link to="/day/quiz" className={cn(linkClass, "bg-fill text-ink hover:bg-line")}>
            퀴즈 다시 풀기
          </Link>
        </div>
      ) : (
        <>
          <p className="text-[14px] text-sub">{DAY_LOCK_TEXT.quiz_not_passed}</p>
          <Link to="/day/quiz" className={cn(linkClass, "bg-brand text-white hover:bg-brand-dark")}>
            단타 연습 퀴즈 풀기
          </Link>
        </>
      )}
    </section>
  );
}
