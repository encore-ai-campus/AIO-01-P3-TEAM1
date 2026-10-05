// 분봉 차트 (단타 연습장·복기, docs/API.md "단타 연습" MinuteCandles). 국내 종목만이라 가격은 원화다.
//
// - lightweight-charts로 분봉(+거래량)을 그린다. 시각은 KST로 보인다 (MinuteCandle.time은 +09:00 ISO — chartMarks.ts chartTime).
// - lines: 사는·목표·손절 가격 선 (계획용), markers: 진입·청산 체결 표시 (복기용 — 체결가는 일어난 사실이라 그대로). 체결 표시는 그 시각이 들어가는 봉에 붙인다.
// - 완성된 세션만 받는다 (데이터는 부모가 useMinuteCandles로 받아 넘긴다 — MinuteChartPanel). partial·빈 목록 안내도 부모가 MINUTE_PARTIAL·MINUTE_UNAVAILABLE로.
// - 차트 아래 범례에 가격 선과 체결 표시를 글로도 적는다 (화면 낭독기·캔버스가 없는 환경에서도 읽히게).
//   좁은 화면(480px 미만)에서는 가격 선 이름을 빼고 축 라벨만 둔다 — 이름 상자가 오른쪽 끝의 최근 봉과 청산 표시를 가리지 않게 (리포트 차트와 같은 규칙).
// - 색은 테마 토큰(useChartColors). 테마가 바뀌면 차트를 다시 만들지 않고 색만 바꾼다 — 확대·이동한 상태가 남는다.
// - 차트 안 TradingView 로고(링크)는 끈다: role="img" 상자 안의 Tab 정지점이 되어 화면 읽기에는 그림 이름만 다시 읽혔다.
//   라이선스 고지는 그림 밖, 범례 줄 오른쪽의 글자 링크로 둔다 (종목 상세 일봉 차트와 같은 방식).
// - 휠·세로로 쓸어 넘기기는 페이지 스크롤에 양보한다. Ctrl/⌘ + 휠·두 손가락 벌리기로 확대 (세 차트 공용 lib/chartOptions.ts).
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
  type Time,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import type { MinuteCandle } from "../../api/types";
import { CHART_INTERACTION, DASHED, lineTitle, zoomWheelWithModifier } from "../../lib/chartOptions";
import { type ChartColors, useChartColors } from "../../lib/chartTheme";
import { cn } from "../../lib/cn";
import { formatKrw, formatTime } from "../../lib/format";
import { LINE_STYLE, MARKER_STYLE, buildMarkers, chartTime, clockLabel, includePrices, krwAxis } from "./chartMarks";

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
  /** 픽셀 높이. 없으면 모바일 260 · PC(lg) 320 — PC는 가격 선 사이가 넓어야 읽힌다. */
  height?: number;
  /** figure의 이름 (기본 "분봉 차트"). */
  label?: string;
  className?: string;
}

interface Handles {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  markers: ISeriesMarkersPluginApi<Time>;
  lines: IPriceLine[];
}

function toBars(candles: readonly MinuteCandle[]) {
  const bars = [];
  for (const k of candles) {
    const time = chartTime(k.time);
    if (time !== null) bars.push({ time, open: k.open, high: k.high, low: k.low, close: k.close });
  }
  return bars;
}

/** 거래량 막대. 봉마다 색이 달라서(오르면 빨강·내리면 파랑, 반투명) 테마가 바뀌면 다시 넣는다. */
function toVolumes(candles: readonly MinuteCandle[], colors: ChartColors) {
  const vols = [];
  for (const k of candles) {
    const time = chartTime(k.time);
    if (time !== null) vols.push({ time, value: k.volume, color: k.close >= k.open ? colors.volUp : colors.volDown });
  }
  return vols;
}

/** 분봉 캔들 + 거래량 + 가격 선 + 체결 표시. */
export function MinuteChart({ candles, lines, markers, height, label = "분봉 차트", className }: MinuteChartProps) {
  const box = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);
  const colors = useChartColors();
  // 처음 만들 때의 색 — 만들 때부터 테마 색으로 그린다 (그 뒤 테마가 바뀌면 아래 effect가 색만 바꾼다)
  const [initial] = useState(colors);
  // 부모가 그릴 때마다 새 배열을 넘겨도 값이 같으면 다시 그리지 않게 문자열로 비교한다
  const linesKey = JSON.stringify(lines ?? []);
  const markersKey = JSON.stringify(markers ?? []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: initial.text,
        fontFamily: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false, // 고지는 아래 글자 링크 (role=img 안에 링크를 두지 않는다)
      },
      grid: { vertLines: { visible: false }, horzLines: { color: initial.grid } },
      crosshair: { vertLine: { color: initial.crosshair }, horzLine: { color: initial.crosshair } },
      rightPriceScale: { borderVisible: false },
      // 첫 시각 글자가 왼쪽 끝에서 잘리지 않게 고정, 한 세션만 그리므로 시각은 HH:MM만
      timeScale: { borderVisible: false, rightOffset: 2, timeVisible: true, secondsVisible: false, fixLeftEdge: true, tickMarkFormatter: clockLabel },
      localization: { locale: "ko-KR", priceFormatter: krwAxis, timeFormatter: clockLabel },
      ...CHART_INTERACTION,
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: initial.up,
      downColor: initial.down,
      borderVisible: false,
      wickUpColor: initial.up,
      wickDownColor: initial.down,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
      priceLineVisible: false, // 마지막 가격 점선은 끈다 (목표·손절 선과 헷갈리지 않게)
      lastValueVisible: false, // 축의 빨간 마지막 값 글자도 끈다 (목표 가격 글자와 같은 색이라 헷갈린다)
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    handles.current = { chart, candle, volume, markers: createSeriesMarkers(candle, []), lines: [] };
    const unwheel = zoomWheelWithModifier(el, chart);
    return () => {
      unwheel();
      chart.remove();
      handles.current = null;
    };
  }, [initial]);

  // 테마가 바뀌면 색만 바꾼다 (다시 만들면 확대·이동 상태가 사라진다)
  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    h.chart.applyOptions({
      layout: { textColor: colors.text },
      grid: { horzLines: { color: colors.grid } },
      crosshair: { vertLine: { color: colors.crosshair }, horzLine: { color: colors.crosshair } },
    });
    h.candle.applyOptions({ upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down });
  }, [colors]);

  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    h.candle.setData(toBars(candles));
    h.chart.timeScale().fitContent();
  }, [candles]);

  // 거래량은 봉마다 색이 있어 테마가 바뀌어도 다시 넣는다 (fitContent는 하지 않는다 — 보던 구간 그대로)
  useEffect(() => {
    handles.current?.volume.setData(toVolumes(candles, colors));
  }, [candles, colors]);

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
        color: colors[LINE_STYLE[l.kind].color],
        lineWidth: 1,
        lineStyle: DASHED,
        axisLabelVisible: true,
        title: lineTitle(box.current, l.label ?? LINE_STYLE[l.kind].label),
      }),
    );
  }, [linesKey, colors]);

  useEffect(() => {
    handles.current?.markers.setMarkers(buildMarkers(candles, JSON.parse(markersKey) as MinuteChartMarker[], colors));
  }, [candles, markersKey, colors]);

  const legend = [
    ...(lines ?? []).map((l, i) => ({
      key: `l${i}`,
      swatch: cn("w-3 border-t-2 border-dashed", LINE_STYLE[l.kind].legend),
      text: `${l.label ?? LINE_STYLE[l.kind].label} ${formatKrw(l.price)}`,
    })),
    ...(markers ?? []).map((m, i) => ({
      key: `m${i}`,
      swatch: cn("size-2 rounded-full", MARKER_STYLE[m.kind].legend),
      text: `${m.label ?? MARKER_STYLE[m.kind].label} ${formatTime(m.time).slice(0, 5)} ${formatKrw(m.price)}`,
    })),
  ];

  return (
    <figure className={cn("w-full", className)}>
      <div
        ref={box}
        style={height ? { height } : undefined}
        className={cn("w-full", !height && "h-[260px] lg:h-[320px]")}
        role="img"
        aria-label={label}
      />
      {/* 범례가 한 줄에 들어가면 고지는 같은 줄 오른쪽, 넘치면 범례는 폭을 다 쓰고 고지는 다음 줄 오른쪽 (범례가 좁은 칸으로 밀려 한 줄에 하나씩 쌓이지 않게) */}
      <div className="mt-2 flex flex-wrap items-start gap-x-3 gap-y-1">
        {legend.length > 0 && (
          <ul aria-label="차트 표시" className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-sub">
            {legend.map((x) => (
              <li key={x.key} className="flex items-center gap-1.5 tabular-nums">
                <span aria-hidden="true" className={cn("inline-block shrink-0", x.swatch)} />
                {x.text}
              </li>
            ))}
          </ul>
        )}
        {/* 차트 라이브러리 고지 (lightweight-charts — 차트 안 로고 대신). 글자 링크라 text-mute (mute-weak는 글자로는 대비가 모자란다) */}
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          title="Charting by TradingView"
          className="ml-auto shrink-0 rounded-sm text-[12px] text-mute transition-colors hover:text-sub hover:underline"
        >
          TradingView
        </a>
      </div>
    </figure>
  );
}
