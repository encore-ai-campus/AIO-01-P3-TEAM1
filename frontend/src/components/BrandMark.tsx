// 모매매 로고 (docs/DECISIONS.md 15-7 — 이름은 18장에서 바뀌고 모양은 그대로): brand 둥근 타일 + 흰 종이배 정면 실루엣. 원본은 브랜드 작업의 mark-tile-vars.svg (viewBox 32, 모서리 rx 8 = 25%).
// 색은 토큰만: 타일 --color-brand(다크에서 저절로 밝은 파랑), 배 --color-on-brand(두 테마 모두 흰색). fill-* 유틸로 칠한다.
// 크기 단계: 48px 이상에서만 돛에 접힌 선(종이를 접은 자국)을 그린다 — 더 작으면 1배율에서 얼룩이 된다. 16px 파비콘은 public/favicon.svg(전용 모양).
// 하지 않는 것: 늘이기·돌리기·기울이기, 그림자·그라데이션, 물결·화살표 덧그리기, 노란색 배.
import { cn } from "../lib/cn";
import { SERVICE_NAME } from "../lib/plainText";

/** 선체 + 돛 한 덩어리. 돛 꼭짓점은 둥글려 ▲(상승 기호)로 읽히지 않게 했다. 선체가 무거워 위로 0.7 올린 광학 보정이 들어 있다. */
const BOAT =
  "M4.8 17.29A0.8 0.8 0 0 1 5.43 16L9.31 16A0.5 0.5 0 0 0 9.74 15.75L14.71 7.3A1.5 1.5 0 0 1 17.29 7.3L22.26 15.75A0.5 0.5 0 0 0 22.69 16L26.57 16A0.8 0.8 0 0 1 27.2 17.29L22.45 23.42A1.5 1.5 0 0 1 21.26 24L10.74 24A1.5 1.5 0 0 1 9.55 23.42Z";
/** 돛의 접힌 선: 타일 색 쐐기 틈. */
const FOLD =
  "M16.11 7.79A0.04 0.04 0 0 1 16.19 7.77L19.53 15.47A0.45 0.45 0 0 1 19.11 16.1L17.98 16.1A0.45 0.45 0 0 1 17.53 15.73Z";
/** 접힌 선을 그리는 가장 작은 크기(px). */
const FOLD_MIN_PX = 48;

/**
 * 로고 마크. size는 px(기본 32 — 화면 안 최소 20). label을 주면 그림 하나로 읽히고(role=img), 없으면 옆 이름을 돕는 장식이라 숨는다.
 * 고대비(forced-colors)에서도 브랜드 색을 지킨다 — 시스템 색으로 덮으면 타일과 배가 같은 색이 되어 사라진다.
 */
export function BrandMark({ size = 32, className, label }: { size?: number; className?: string; label?: string }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 forced-color-adjust-none", className)}
    >
      <rect width="32" height="32" rx="8" className="fill-brand" />
      <path d={BOAT} className="fill-on-brand" />
      {size >= FOLD_MIN_PX && <path d={FOLD} className="fill-brand" />}
    </svg>
  );
}

/**
 * 마크 + 이름 가로 잠금 (PC 왼쪽 메뉴 32px · 모바일 홈 머리 28px · 부팅 뼈대). 사이는 마크의 1/4, 이름은 Pretendard 800 · 자간 -0.02em.
 * 글자 크기·색·바깥 여백은 className으로 준다 (예: "text-[19px] text-ink"). 마크는 장식이라 화면 읽기에는 이름만 읽힌다.
 */
export function BrandLockup({ size, className }: { size: number; className?: string }) {
  return (
    <span className={cn("flex items-center font-extrabold tracking-[-0.02em]", className)} style={{ gap: size / 4 }}>
      <BrandMark size={size} />
      <span className="min-w-0 truncate">{SERVICE_NAME}</span>
    </span>
  );
}
