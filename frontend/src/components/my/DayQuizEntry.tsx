// 마이의 단타 연습 입구 (주린이모드 끔일 때만 보인다). 연습 퀴즈 5문항을 모두 맞혀야 단타 연습장이 열린다.
import { Link } from "react-router";
import type { RiskProfile } from "../../api/types";
import { errorMessage } from "../../api/client";
import { useBeginnerMode } from "../../hooks/useBeginnerMode";
import { formatDateTime } from "../../lib/format";
import { DAY_COST_NOTE, DAY_LOCK_TEXT, RISK_PROFILE_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Card, ErrorState, Notice, Skeleton } from "../ui";

// 성향과 맞지 않는 서비스를 고르면 한 줄 안내 (docs/투자서비스확장계획.md 2-3)
const CAREFUL: RiskProfile[] = ["stable", "stable_seeking"];

const linkClass = "flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl text-[15px] font-semibold";

export function DayQuizEntry() {
  const { profile, profileError, refetchProfile } = useBeginnerMode();
  const passedAt = profile?.dayQuizPassedAt ?? null;
  const risk = profile?.riskProfile ?? null;
  return (
    <Card aria-labelledby="day-entry-title" className="space-y-3">
      <h2 id="day-entry-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name="bolt" className="size-5" />
        단타 연습장
      </h2>
      <p className="text-[14px] leading-relaxed text-sub">
        국내 종목을 그날 안에 사고파는 모의 연습이에요. 15:15가 지나면 정리해요. {DAY_COST_NOTE}.
      </p>
      {risk && CAREFUL.includes(risk) && (
        <Notice tone="warn">하루 안에 사고파는 연습은 손실 변동이 커요. 성향 진단: {RISK_PROFILE_TEXT[risk]}</Notice>
      )}
      {!profile ? (
        profileError ? (
          <ErrorState message={errorMessage(profileError)} onRetry={refetchProfile} />
        ) : (
          <Skeleton className="h-11 w-full rounded-xl" />
        )
      ) : passedAt ? (
        <>
          <p className="flex items-center gap-1.5 text-[14px] font-semibold text-ok">
            <Icon name="check" className="size-4" />
            연습 퀴즈 통과 · {formatDateTime(passedAt)}
          </p>
          <div className="flex gap-2">
            <Link to="/day" className={`${linkClass} bg-brand text-white hover:bg-brand-dark`}>
              단타 연습장 가기
            </Link>
            <Link to="/day/quiz" className={`${linkClass} bg-fill text-ink hover:bg-line`}>
              퀴즈 다시 풀기
            </Link>
          </div>
        </>
      ) : (
        <>
          <p className="text-[14px] text-sub">{DAY_LOCK_TEXT.quiz_not_passed}</p>
          <Link to="/day/quiz" className={`${linkClass} bg-brand text-white hover:bg-brand-dark`}>
            단타 연습 퀴즈 풀기
          </Link>
        </>
      )}
    </Card>
  );
}
