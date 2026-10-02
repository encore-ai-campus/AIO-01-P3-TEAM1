import { useId } from "react";
import { formatDate, formatKrw } from "../lib/format";

/** 일별 자산 추이 선 그래프 (SVG). 마지막 값이 처음보다 높으면 빨강, 낮으면 파랑. */
export function LineChart({ points, label }: { points: { day: string; value: number }[]; label: string }) {
  const gid = useId();
  if (points.length < 2) return <p className="py-8 text-center text-[14px] text-mute">기록이 아직 없습니다.</p>;

  const W = 600;
  const H = 160;
  const values = points.map((p) => p.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * W, H - 8 - ((p.value - min) / span) * (H - 16)] as const);
  const line = xy.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${W},${H} L0,${H} Z`;
  const up = values[values.length - 1] >= values[0];
  const color = up ? "#F04452" : "#3182F6";

  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-40 w-full" role="img" aria-label={label}>
        <defs>
          <linearGradient id={gid} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.18" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gid})`} />
        <path d={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
      </svg>
      <figcaption className="mt-2 flex justify-between text-[12px] tabular-nums text-mute">
        <span>{formatDate(points[0].day)}</span>
        <span className="hidden sm:inline">
          최고 {formatKrw(max)} · 최저 {formatKrw(min)}
        </span>
        <span>{formatDate(points[points.length - 1].day)}</span>
      </figcaption>
    </figure>
  );
}
