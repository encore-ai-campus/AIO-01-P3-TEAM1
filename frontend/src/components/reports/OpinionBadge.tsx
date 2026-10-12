// AI 의견 배지 (docs/plans/컨셉변경계획.md 4-4): 쉬운 보기 "긍정적 · 지켜보기 · 부정적", 전문가 보기 "매수 · 보유 · 회피".
// 색은 시장의 오름(빨강)·내림(파랑)과 섞이지 않게 고른다. 글자로도 구분된다. 홈·리포트 목록·상세가 모두 이 배지를 쓴다 (화면마다 색이 다르지 않게).
import type { ReportOpinion } from "../../api/types";
import { cn } from "../../lib/cn";
import { opinionText } from "../../lib/plainText";

// 글자색은 연한 바탕 위 글자용 *-ink 토큰 (다크에서도 4.5:1 이상)
const TONE = {
  positive: "bg-brand-soft text-brand-ink",
  neutral: "bg-fill text-sub",
  negative: "bg-warn-soft text-warn-ink",
} as const;

export function OpinionBadge({
  opinion,
  expert = false,
  large = false,
  labeled = false,
  className,
}: {
  opinion: ReportOpinion | null | undefined;
  expert?: boolean; // 전문가 보기 용어 (매수·보유·회피)
  large?: boolean; // 상세 머리: "AI 의견: 긍정적"
  labeled?: boolean; // 작은 크기로 "AI 의견: 긍정적" (홈의 최근 리포트처럼 리포트 밖에서 보일 때)
  className?: string;
}) {
  const t = opinionText(opinion);
  if (!t) return null;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-md font-bold whitespace-nowrap",
        large ? "h-8 px-2.5 text-[15px]" : "h-6 px-1.5 text-[12px]",
        TONE[t.tone],
        className,
      )}
    >
      {expert ? `AI 의견 ${t.expert}` : large || labeled ? t.label : t.badge}
    </span>
  );
}
