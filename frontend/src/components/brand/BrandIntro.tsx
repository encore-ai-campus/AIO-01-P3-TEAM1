// 브랜드 인트로 ("이름의 세 ㅁ이 차트가 된다"): 워드마크 → 글자 획이 옅어지고 세 ㅁ만 남음 → 계단으로 모임 → 파란 타일 위 흰 ㅁ(아이콘).
// lockup이면 끝에 아이콘이 왼쪽으로 밀리고 이름이 옆에 나온다. 움직임은 index.css의 .intro-* (한 타임라인을 --intro-dur로 늘이고 줄인다).
// 앱 첫 방문과 발표 영상이 같은 5초 버전을 쓴다. 앱은 overlay (components/brand/IntroGate.tsx가 한 번만 띄운다): 화면 전체를 덮고, 끝나고 잠깐 머문 뒤 사라지며 onDone. 눌러도 끝난다.
// 도형은 lib/brandShapes.ts, 색은 토큰 유틸만 (고정 색 없음). 장식이라 화면 읽기에서는 숨긴다.
import type { AnimationEvent, CSSProperties } from "react";
import { cn } from "../../lib/cn";
import { MU_PATH, WORDMARK_MU } from "../../lib/brandShapes";
import { WordmarkLetters, WordmarkMarks } from "./BrandMark";

interface BrandIntroProps {
  /** 처음부터 끝까지 길이(ms). 앱 첫 방문·발표용 모두 5000. */
  durationMs?: number;
  /** 끝에 아이콘 + 이름 가로 잠금까지 보인다. */
  lockup?: boolean;
  /** 화면 전체를 덮고 끝나면 사라진다 (앱 첫 방문). */
  overlay?: boolean;
  onDone?: () => void;
  className?: string;
}

/** 세 ㅁ이 계단 자리로 가는 움직임 (index.css의 intro-b1~3) — 순서는 WORDMARK_MU와 같다. */
const BLOCK_CLASS = ["intro-b1", "intro-b2", "intro-b3"] as const;

export function BrandIntro({ durationMs = 5000, lockup = false, overlay = false, onDone, className }: BrandIntroProps) {
  const style = { "--intro-dur": `${durationMs}ms` } as CSSProperties;
  // 자식(SVG)의 animationend도 올라오므로 바깥 덮개 자신의 끝만 본다
  const end = (e: AnimationEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onDone?.();
  };

  const art = (
    <svg viewBox="-70 0 780 180" aria-hidden="true" className={cn("mx-auto h-auto text-ink forced-color-adjust-none", overlay ? (lockup ? "w-[min(92vw,640px)]" : "w-[min(80vw,440px)]") : "w-full")}>
      <g className="intro-letters">
        <WordmarkLetters />
      </g>
      <g className={cn(lockup && "intro-shifts")}>
        <rect className="intro-tile fill-brand" x="230" y="0" width="180" height="180" rx="45" />
        {WORDMARK_MU.map(({ x, y }, i) => (
          <g key={x} className={cn(BLOCK_CLASS[i], "fill-brand")} fillRule="evenodd">
            <path transform={`translate(${x} ${y})`} d={MU_PATH} />
          </g>
        ))}
      </g>
      {lockup && (
        <g className="intro-name">
          <g transform="translate(208.5 28.75) scale(0.7)">
            <WordmarkLetters />
            <WordmarkMarks />
          </g>
        </g>
      )}
    </svg>
  );

  if (overlay) {
    return (
      <div role="presentation" aria-hidden="true" className="intro-overlay fixed inset-0 z-[100] grid place-items-center bg-card" style={style} onAnimationEnd={end} onClick={onDone}>
        {art}
      </div>
    );
  }
  return (
    <div aria-hidden="true" className={cn("w-full", className)} style={style}>
      {art}
    </div>
  );
}
