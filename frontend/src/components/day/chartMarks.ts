// 분봉 차트(MinuteChart)의 계산 조각: 시각 변환, 체결 표시를 붙일 봉, 가격 선·표시의 이름과 색 이름. 차트 손동작은 세 차트 공용(lib/chartOptions.ts).
// 컴포넌트 파일과 나눈 것은 Fast Refresh 규칙(컴포넌트 파일은 컴포넌트만 내보낸다) 때문이다.
// 색은 값이 아니라 테마 색 이름(lib/chartTheme.ts ChartColors)으로 둔다 — 캔버스는 CSS 변수를 모르므로 차트가 그때의 테마 색으로 바꿔 넘긴다.
import type { AutoscaleInfo, SeriesMarker, Time, UTCTimestamp } from "lightweight-charts";
import type { MinuteCandle } from "../../api/types";
import { type ChartColors, chartColors } from "../../lib/chartTheme";

/** 차트는 시각을 UTC로 그린다. 9시간을 더해 KST 벽시계(09:00~15:30)로 보이게 한다. */
const KST_OFFSET_SEC = 9 * 3600;

export type MinuteLineKind = "entry" | "target" | "stop";
export type MinuteMarkerKind = "entry" | "exit";

/**
 * 가격 선의 쉬운 이름과 색 (목표 빨강 · 손절 파랑 · 사는 가격 회색 — 화면의 오름·내림 색과 같게).
 * color는 캔버스용 테마 색 이름, legend는 범례 견본의 토큰 클래스(같은 색 — CSS가 테마를 따른다).
 */
export const LINE_STYLE: Record<MinuteLineKind, { label: string; color: keyof ChartColors; legend: string }> = {
  entry: { label: "사는 가격", color: "entryLine", legend: "border-sub" },
  target: { label: "목표 가격", color: "targetLine", legend: "border-up" },
  stop: { label: "손절 가격", color: "stopLine", legend: "border-down" },
};

/** 체결 표시의 이름과 모양 (진입은 봉 아래 위쪽 화살표, 청산은 봉 위 아래쪽 화살표). 색 이름은 LINE_STYLE과 같은 규칙. */
export const MARKER_STYLE: Record<
  MinuteMarkerKind,
  { label: string; color: keyof ChartColors; legend: string; position: "belowBar" | "aboveBar"; shape: "arrowUp" | "arrowDown" }
> = {
  entry: { label: "진입", color: "entryMark", legend: "bg-ink", position: "belowBar", shape: "arrowUp" },
  exit: { label: "청산", color: "exitMark", legend: "bg-warn-ink", position: "aboveBar", shape: "arrowDown" },
};

/** ISO 시각 → 차트 시각(초, KST 벽시계). 읽을 수 없으면 null. */
export function chartTime(iso: string): UTCTimestamp | null {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ((Math.floor(ms / 1000) + KST_OFFSET_SEC) as UTCTimestamp) : null;
}

/** 차트 시각 → "HH:MM" (한 세션만 그리는 차트라 날짜는 뺀다 — 십자선·시간 축 글자). */
export function clockLabel(time: Time): string {
  if (typeof time !== "number") return String(time);
  const d = new Date(time * 1000); // KST 벽시계를 UTC로 넣어 두었으므로 UTC로 읽는다
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * 체결 시각이 들어가는 봉의 차트 시각: 시작 시각이 체결 시각 이하인 마지막 봉 (09:12:40 체결은 09:12 봉).
 * 첫 봉보다 앞이면 첫 봉, 마지막 봉보다 뒤면 마지막 봉. 봉이 없거나 시각을 읽을 수 없으면 null.
 */
export function barTimeFor(candles: readonly MinuteCandle[], iso: string): UTCTimestamp | null {
  const t = Date.parse(iso);
  if (!candles.length || !Number.isFinite(t)) return null;
  let found = candles[0];
  for (const c of candles) {
    const start = Date.parse(c.time);
    if (!Number.isFinite(start) || start > t) break;
    found = c;
  }
  return chartTime(found.time);
}

export interface MarkerInput {
  time: string;
  price: number;
  kind: MinuteMarkerKind;
  label?: string;
}

/**
 * 체결 표시 → 차트 표시 (시각 오름차순 — 라이브러리 규칙). 붙일 봉이 없으면 뺀다.
 * colors는 지금 테마의 차트 색 (차트는 useChartColors를 넘긴다). 주지 않으면 라이트 색이다.
 */
export function buildMarkers(
  candles: readonly MinuteCandle[],
  markers: readonly MarkerInput[],
  colors: ChartColors = chartColors("light"),
): SeriesMarker<Time>[] {
  const out: { at: number; marker: SeriesMarker<Time> }[] = [];
  for (const m of markers) {
    const time = barTimeFor(candles, m.time);
    if (time === null) continue;
    const s = MARKER_STYLE[m.kind];
    out.push({
      at: Date.parse(m.time),
      marker: { time, position: s.position, shape: s.shape, color: colors[s.color], text: m.label ?? s.label },
    });
  }
  return out.sort((a, b) => a.at - b.at).map((x) => x.marker);
}

/** 원화 가격 축 표시 (분봉은 국내 종목만이다). */
export const krwAxis = (p: number) => Math.round(p).toLocaleString("ko-KR");

/** 가격 축 범위에 가격 선(사는·목표·손절)을 넣는다 — 목표가가 그날 고가보다 높아도 선이 보이게. */
export function includePrices(info: AutoscaleInfo | null, prices: readonly number[]): AutoscaleInfo | null {
  if (!info?.priceRange || !prices.length) return info;
  return {
    ...info,
    priceRange: { minValue: Math.min(info.priceRange.minValue, ...prices), maxValue: Math.max(info.priceRange.maxValue, ...prices) },
  };
}
