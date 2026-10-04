// 분봉 차트 (단타 연습장·복기, docs/API.md "단타 연습" MinuteCandles). 국내 종목만이라 가격은 원화다.
//
// - lightweight-charts로 분봉(+거래량)을 그린다. 시각은 KST로 보인다 (MinuteCandle.time은 +09:00 ISO — chartMarks.ts chartTime).
// - lines: 사는·목표·손절 가격 선 (계획용), markers: 진입·청산 체결 표시 (복기용 — 체결가는 일어난 사실이라 그대로). 체결 표시는 그 시각이 들어가는 봉에 붙인다.
// - 완성된 세션만 받는다 (데이터는 부모가 useMinuteCandles로 받아 넘긴다 — MinuteChartPanel). partial·빈 목록 안내도 부모가 MINUTE_PARTIAL·MINUTE_UNAVAILABLE로.
// - 차트 아래 범례에 가격 선과 체결 표시를 글로도 적는다 (화면 낭독기·캔버스가 없는 환경에서도 읽히게).
import {
  type AutoscaleInfo,
  CandlestickSeries,
  HistogramSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineStyle,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { MinuteCandle } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatKrw, formatTime } from "../../lib/format";
import { LINE_STYLE, MARKER_STYLE, buildMarkers, chartTime, includePrices, krwAxis } from "./chartMarks";

export interface MinuteChartLine {
  price: number;
  kind: "entry" | "target" | "stop";
  /** 선 이름 (없으면 쉬운 이름: 사는 가격·목표 가격·손절 가격). */
  label?: string;
}

export interface MinuteChartMarker {
  /** 체결 시각 ISO. 가장 가까운 봉에 붙인다. */
  time: string;
  price: number;
  kind: "entry" | "exit";
  label?: string;
}

export interface MinuteChartProps {
  candles: MinuteCandle[];
  lines?: MinuteChartLine[];
  markers?: MinuteChartMarker[];
  /** 픽셀 높이 (기본 260). */
  height?: number;
  /** figure의 이름 (기본 "분봉 차트"). */
  label?: string;
  className?: string;
}

const UP = "#F04452";
const DOWN = "#3182F6";
const DASHED = 2 as LineStyle; // LineStyle.Dashed (테스트의 차트 가짜에는 열거형이 없어 값으로 쓴다)

interface Handles {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  markers: ISeriesMarkersPluginApi<Time>;
  lines: IPriceLine[];
}

function toBars(candles: readonly MinuteCandle[]) {
  const bars = [];
  const vols = [];
  for (const k of candles) {
    const time = chartTime(k.time);
    if (time === null) continue;
    bars.push({ time, open: k.open, high: k.high, low: k.low, close: k.close });
    vols.push({ time, value: k.volume, color: k.close >= k.open ? "rgba(240,68,82,0.28)" : "rgba(49,130,246,0.28)" });
  }
  return { bars, vols };
}

/** 분봉 캔들 + 거래량 + 가격 선 + 체결 표시. */
export function MinuteChart({ candles, lines, markers, height = 260, label = "분봉 차트", className }: MinuteChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);
  // 부모가 그릴 때마다 새 배열을 넘겨도 값이 같으면 다시 그리지 않게 문자열로 비교한다
  const linesKey = JSON.stringify(lines ?? []);
  const markersKey = JSON.stringify(markers ?? []);

  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: "#8B95A1",
        fontFamily: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
        fontSize: 11,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "#F2F4F6" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: 2, timeVisible: true, secondsVisible: false },
      localization: { locale: "ko-KR", priceFormatter: krwAxis },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
      priceLineVisible: false, // 마지막 가격 점선은 끈다 (목표·손절 선과 헷갈리지 않게)
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    handles.current = { chart, candle, volume, markers: createSeriesMarkers(candle, []), lines: [] };
    return () => {
      chart.remove();
      handles.current = null;
    };
  }, []);

  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    const { bars, vols } = toBars(candles);
    h.candle.setData(bars);
    h.volume.setData(vols);
    h.chart.timeScale().fitContent();
  }, [candles]);

  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    for (const line of h.lines) h.candle.removePriceLine(line);
    const parsed = JSON.parse(linesKey) as MinuteChartLine[];
    const prices = parsed.map((l) => l.price);
    h.candle.applyOptions({ autoscaleInfoProvider: (base: () => AutoscaleInfo | null) => includePrices(base(), prices) });
    h.lines = parsed.map((l) =>
      h.candle.createPriceLine({
        price: l.price,
        color: LINE_STYLE[l.kind].color,
        lineWidth: 1,
        lineStyle: DASHED,
        axisLabelVisible: true,
        title: l.label ?? LINE_STYLE[l.kind].label,
      }),
    );
  }, [linesKey]);

  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    h.markers.setMarkers(buildMarkers(candles, JSON.parse(markersKey) as MinuteChartMarker[]));
  }, [candles, markersKey]);

  const legend = [
    ...(lines ?? []).map((l, i) => ({
      key: `l${i}`,
      color: LINE_STYLE[l.kind].color,
      text: `${l.label ?? LINE_STYLE[l.kind].label} ${formatKrw(l.price)}`,
      dashed: true,
    })),
    ...(markers ?? []).map((m, i) => ({
      key: `m${i}`,
      color: MARKER_STYLE[m.kind].color,
      text: `${m.label ?? MARKER_STYLE[m.kind].label} ${formatTime(m.time).slice(0, 5)} ${formatKrw(m.price)}`,
      dashed: false,
    })),
  ];

  return (
    <figure className={cn("w-full", className)}>
      <div ref={box} style={{ height }} className="w-full" role="img" aria-label={label} />
      {legend.length > 0 && (
        <ul aria-label="차트 표시" className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-sub">
          {legend.map((x) => (
            <li key={x.key} className="flex items-center gap-1.5 tabular-nums">
              <span
                aria-hidden="true"
                className={cn("inline-block w-3", x.dashed ? "border-t-2 border-dashed" : "size-2 rounded-full")}
                style={x.dashed ? { borderColor: x.color } : { backgroundColor: x.color }}
              />
              {x.text}
            </li>
          ))}
        </ul>
      )}
    </figure>
  );
}
