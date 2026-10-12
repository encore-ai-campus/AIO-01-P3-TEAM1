import { useEffect, useId, useRef } from "react";
import { cn } from "../../lib/cn";
import { formatKrw, formatRate, trendClass } from "../../lib/format";
import { DURATION, EASE, prefersReducedMotion } from "../../lib/motion";

/** "2026-08-25" → "8월 25일" (요약 줄·화면 읽기용). */
function dayLabel(day: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(day);
  return m ? `${Number(m[1])}월 ${Number(m[2])}일` : day;
}

/**
 * 일별 자산 추이 선 그래프 (SVG). 마지막 값이 처음보다 높으면 빨강(상승), 낮으면 파랑.
 * 색은 토큰 클래스(text-up·text-down)를 currentColor로 받아 다크에서도 같은 뜻의 색이 된다.
 * 위에 기간·변화율 한 줄, 아래에 최고·최저 (모바일에서도 값을 읽을 수 있게). 화면 읽기에는 같은 값을 이름으로 준다.
 * animate: 기다린 끝에 처음 그릴 때만 선이 왼쪽부터 그려진다 (캐시로 바로 그린 화면·움직임 줄이기에서는 그대로).
 */
export function LineChart({ points, label, animate = false }: { points: { day: string; value: number }[]; label: string; animate?: boolean }) {
  const gid = useId();
  const svg = useRef<SVGSVGElement>(null);
  const fill = useRef<SVGPathElement>(null);
  const drawable = points.length >= 2;

  useEffect(() => {
    const el = svg.current;
    if (!animate || !el || typeof el.animate !== "function" || prefersReducedMotion()) return;
    el.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: DURATION.slow, easing: EASE.enter });
    // 면(그라데이션)은 선이 지나간 뒤 은은하게
    fill.current?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: DURATION.fast, delay: DURATION.fast, easing: EASE.standard, fill: "backwards" });
  }, [animate]);

  if (!drawable) return <p className="py-8 text-center text-[14px] text-mute">기록이 아직 없어요.</p>;

  const W = 600;
  const H = 160;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - 8 - ((p.value - min) / span) * (H - 16)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const first = points[0];
  const last = points[points.length - 1];
  const up = last.value >= first.value;
  const rate = first.value ? last.value / first.value - 1 : null;
  const period = `${dayLabel(first.day)}~${dayLabel(last.day)}`;
  const summary = `${label}: ${period} 거래일 ${points.length}일, ${formatKrw(first.value)}에서 ${formatKrw(last.value)} (${formatRate(rate)}), 최고 ${formatKrw(max)}, 최저 ${formatKrw(min)}`;

  return (
    <figure>
      <p className="flex items-baseline justify-between gap-3 text-[13px] text-sub tabular-nums">
        <span className="min-w-0">
          {period} · 거래일 {points.length}일
        </span>
        <span className={cn("shrink-0 font-semibold", trendClass(rate))}>{formatRate(rate)}</span>
      </p>
      <svg
        ref={svg}
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className={cn("mt-2 h-40 w-full", up ? "text-up" : "text-down")}
        role="img"
        aria-label={summary}
      >
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" style={{ stopColor: "currentColor" }} stopOpacity="0.18" />
            <stop offset="100%" style={{ stopColor: "currentColor" }} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path ref={fill} d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <figcaption className="mt-2 text-[12px] text-mute tabular-nums">
        최고 {formatKrw(max)} · 최저 {formatKrw(min)}
      </figcaption>
    </figure>
  );
}
