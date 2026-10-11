// 모매매 로고: brand 둥근 타일 + 흰 ㅁ 블록 셋(오르는 계단). 이름의 세 ㅁ(모·매·매)이 아이콘의 세 블록이 된다 (도형은 lib/brandShapes.ts 한 곳).
// 타일 viewBox 32, 모서리 rx 8 = 25%. 색은 토큰만: 타일 --color-brand(다크에서 저절로 밝은 파랑), 블록 --color-on-brand(두 테마 모두 흰색). fill-* 유틸로 칠한다.
// 크기 단계: 32px 이상은 속이 빈 ㅁ, 그보다 작으면 속이 찬 사각형 — 속 구멍이 1배율에서 뭉개지지 않게. 16px 파비콘은 public/favicon.svg(전용 모양).
// 하지 않는 것: 늘이기·돌리기·기울이기, 그림자·그라데이션, 블록 색 바꾸기(워드마크의 ㅁ만 brand 색으로 강조한다).
// loop: 세 블록이 계단을 차례로 한 칸씩 튀는 반복 (로그인 화면). 움직임은 index.css의 .brand-hop — 첫 방문 인트로가 도는 동안은 멈춰 있고, 마우스를 올리면 멈춘다.
import { cn } from "../../lib/cn";
import { SERVICE_NAME } from "../../lib/plainText";
import {
  HOLLOW_MIN_PX,
  ICON_BLOCKS,
  ICON_BLOCK_SCALE,
  MU_PATH,
  WORDMARK_MAE,
  WORDMARK_MAE_X,
  WORDMARK_MO,
  WORDMARK_MU,
  WORDMARK_VIEWBOX,
} from "../../lib/brandShapes";

/** 반복 모션에서 블록마다 늦춰 계단을 오르는 순서로 튀게 하는 클래스 (index.css). */
const HOP_CLASS = ["", "brand-hop-2", "brand-hop-3"] as const;

/**
 * 로고 마크. size는 px(기본 32 — 화면 안 최소 20). label을 주면 그림 하나로 읽히고(role=img), 없으면 옆 이름을 돕는 장식이라 숨는다.
 * 고대비(forced-colors)에서도 브랜드 색을 지킨다 — 시스템 색으로 덮으면 타일과 블록이 같은 색이 되어 사라진다.
 * loop이면 블록을 <g>로 감싸 하나씩 움직인다 (도형 자체의 transform은 건드리지 않는다).
 */
export function BrandMark({ size = 32, className, label, loop = false }: { size?: number; className?: string; label?: string; loop?: boolean }) {
  const hollow = size >= HOLLOW_MIN_PX;
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 forced-color-adjust-none", loop && "brand-loop", className)}
    >
      <rect width="32" height="32" rx="8" className="fill-brand" />
      {ICON_BLOCKS.map(({ x, y }, i) => {
        const block = hollow ? (
          <path key={x} transform={`translate(${x} ${y}) scale(${ICON_BLOCK_SCALE})`} d={MU_PATH} fillRule="evenodd" className="fill-on-brand" />
        ) : (
          <rect key={x} x={x} y={y} width="7" height="6.8" rx="1.3" className="fill-on-brand" />
        );
        return loop ? (
          <g key={x} className={cn("brand-hop", HOP_CLASS[i])}>
            {block}
          </g>
        ) : (
          block
        );
      })}
    </svg>
  );
}

/** 워드마크의 ㅁ을 뺀 획 (ㅗ, ㅐ). 글자색(둘러싼 text-* 색)으로 칠한다. 인트로가 ㅁ과 따로 움직이려고 나눠 둔다. */
export function WordmarkLetters() {
  return (
    <g className="fill-current">
      {WORDMARK_MO.map((d) => (
        <path key={d} d={d} />
      ))}
      {WORDMARK_MAE_X.map((x) => (
        <g key={x} transform={`translate(${x} 0)`}>
          {WORDMARK_MAE.map((d) => (
            <path key={d} d={d} />
          ))}
        </g>
      ))}
    </g>
  );
}

/** 워드마크의 세 ㅁ (brand 색). */
export function WordmarkMarks() {
  return (
    <g className="fill-brand" fillRule="evenodd">
      {WORDMARK_MU.map(({ x, y }) => (
        <path key={x} transform={`translate(${x} ${y})`} d={MU_PATH} />
      ))}
    </g>
  );
}

/**
 * 워드마크 "모매매": 굵은 직선 획 글자, 세 ㅁ만 brand 색(나머지는 글자색 = 둘러싼 text-* 색). height는 px, 폭은 비율대로.
 * 장식이다 — 이름은 옆의 숨김 글자(sr-only)나 제목이 읽어 준다.
 */
export function Wordmark({ height = 24, className }: { height?: number; className?: string }) {
  const { width, height: h } = WORDMARK_VIEWBOX;
  return (
    <svg
      viewBox={`0 0 ${width} ${h}`}
      width={Math.round(((height * width) / h) * 10) / 10}
      height={height}
      aria-hidden="true"
      className={cn("shrink-0 forced-color-adjust-none", className)}
    >
      <WordmarkLetters />
      <WordmarkMarks />
    </svg>
  );
}

/**
 * 마크 + 워드마크 가로 잠금 (PC 왼쪽 메뉴 32px · 모바일 홈 머리 28px · 부팅 뼈대). 사이는 마크의 1/4, 워드마크 높이는 마크의 0.7배.
 * 글자색·바깥 여백은 className으로 준다 (예: "text-ink"). 마크와 워드마크는 장식이라 화면 읽기에는 숨김 이름만 읽힌다.
 */
export function BrandLockup({ size, className }: { size: number; className?: string }) {
  return (
    <span className={cn("flex items-center", className)} style={{ gap: size / 4 }}>
      <BrandMark size={size} />
      <span className="sr-only">{SERVICE_NAME}</span>
      <Wordmark height={Math.round(size * 7) / 10} className="min-w-0" />
    </span>
  );
}
