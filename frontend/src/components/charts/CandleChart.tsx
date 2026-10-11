import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type MouseEventParams,
} from "lightweight-charts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Candle, Currency } from "../../api/types";
import { CHART_INTERACTION, DASHED, zoomWheelWithModifier } from "../../lib/chartOptions";
import { type ChartColors, useChartColors } from "../../lib/chartTheme";
import { monthStartTickFormatter } from "../../lib/chartTicks";
import { cn } from "../../lib/cn";
import { formatDayLabel, formatPrice, formatRate, trendClass } from "../../lib/format";

/** 차트 위 가격 선 (예: 사는 가격·목표 가격·손절 가격). title은 쉬운 이름으로. */
export interface ChartLine {
  price: number;
  title: string;
  tone: "entry" | "target" | "stop";
}

/** candle: 일봉 캔들 + 이동평균(20·60일) + 거래량 (전문가 보기). line: 종가 선 (쉬운 보기 — 시세 카드의 가격과 같은 숫자, 오늘 진행 중인 봉이면 지금 가격). */
export type ChartVariant = "candle" | "line";

const MA_DAYS = [20, 60] as const;

const lineColorOf = (c: ChartColors, tone: ChartLine["tone"]) => (tone === "entry" ? c.entryLine : tone === "target" ? c.targetLine : c.stopLine);
/** 이동평균 선 색: 20일은 경고 주황(보조 선), 60일은 축 글자색 — 캔들의 빨강·파랑과 겹치지 않게. */
const maColorOf = (c: ChartColors, i: number) => (i === 0 ? c.accentLine : c.text);
/** 종가 선 색: 기간 전체로 올랐으면 빨강, 내렸으면 파랑 (한국 관례). */
const closeLineColor = (candles: Candle[], c: ChartColors) =>
  candles.length > 1 && candles[candles.length - 1].close < candles[0].close ? c.down : c.up;

/** 축·격자·십자선 색 (테마가 바뀌면 이것만 다시 넣는다). 십자선 이름표 글자색은 라이브러리가 바탕 밝기로 고른다. */
const themeOptions = (c: ChartColors) => ({
  layout: { textColor: c.text },
  grid: { horzLines: { color: c.grid } },
  crosshair: {
    vertLine: { color: c.crosshair, labelBackgroundColor: c.entryLine },
    horzLine: { color: c.crosshair, labelBackgroundColor: c.entryLine },
  },
});

interface Handles {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick"> | null;
  line: ISeriesApi<"Line"> | null;
  volume: ISeriesApi<"Histogram"> | null;
  ma: ISeriesApi<"Line">[];
  key: string;
  lines: { line: IPriceLine; tone: ChartLine["tone"] }[];
  candles: Candle[];
  colors: ChartColors; // 지금 칠한 색
}

const toBar = (k: Candle) => ({ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close });
const toClose = (k: Candle) => ({ time: k.date, value: k.close });
const toVol = (k: Candle, c: ChartColors) => ({ time: k.date, value: k.volume, color: k.close >= k.open ? c.volUp : c.volDown });

/** n일 단순 이동평균 (종가). 앞쪽 n-1일은 값이 없다. */
function movingAverage(candles: Candle[], n: number): { time: string; value: number }[] {
  const out: { time: string; value: number }[] = [];
  let sum = 0;
  candles.forEach((k, i) => {
    sum += k.close;
    if (i >= n) sum -= candles[i - n].close;
    if (i >= n - 1) out.push({ time: k.date, value: sum / n });
  });
  return out;
}

/** 축 숫자 형식 (원화는 정수, 달러는 소수 둘째 자리). 범례도 같은 형식. */
const axisPrice = (usd: boolean) => (p: number) => (usd ? `$${p.toFixed(2)}` : Math.round(p).toLocaleString("ko-KR"));

/**
 * 범례 한 줄 (캔버스 밖, 높이 고정): 평소에는 마지막 봉, 십자선이 움직이면 그 봉. 화면 읽기에는 차트 이름(role=img)이 요약을 준다.
 * 쉬운 보기는 날짜·종가·전날 대비, 전문가 보기는 시가·고가·저가·종가와 이동평균 색 표시.
 */
function Legend({ candles, index, variant, currency, colors }: { candles: Candle[]; index: number | null; variant: ChartVariant; currency: Currency; colors: ChartColors }) {
  const i = index ?? candles.length - 1;
  const k = candles[i];
  if (!k) return <p aria-hidden="true" className="h-5" />;
  const prev = candles[i - 1];
  const rate = prev ? k.close / prev.close - 1 : null;
  const fmt = axisPrice(currency === "USD");
  return (
    <div aria-hidden="true" className="flex min-h-5 flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-[12px] leading-5 tabular-nums">
      {variant === "line" ? (
        <p className="min-w-0 truncate text-sub">
          {formatDayLabel(k.date)} 종가 {formatPrice(k.close, currency)} {rate !== null && <span className={trendClass(rate)}>{formatRate(rate)}</span>}
        </p>
      ) : (
        // 좁은 화면은 날짜·종가·등락만 (시가·고가·저가는 십자선 축 값으로도 보인다) — 한 줄을 지켜 손가락을 움직여도 차트가 밀리지 않게
        <p className="min-w-0 text-sub">
          {formatDayLabel(k.date)}
          <span className="max-sm:hidden">
            {" "}
            · 시 {fmt(k.open)} · 고 {fmt(k.high)} · 저 {fmt(k.low)}
          </span>{" "}
          · 종 {fmt(k.close)} {rate !== null && <span className={trendClass(rate)}>{formatRate(rate)}</span>}
        </p>
      )}
      {variant === "candle" && (
        <p className="flex shrink-0 gap-2 text-mute">
          {MA_DAYS.map((d, n) => (
            <span key={d} className="flex items-center gap-1">
              <span className="h-0.5 w-3 rounded-full" style={{ backgroundColor: maColorOf(colors, n) }} />
              {d}일
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/**
 * 일봉 차트. 마지막 봉은 오늘 진행 중인 봉일 수 있다 (StockDetail.candles — 오늘 정규장이 열렸으면 실시간 시세로 5초마다 갱신되는 봉, docs/API.md "실시간 시세").
 * 같은 기간이면 마지막 봉만 갱신해 확대·이동 상태를 지킨다 (진행 중인 봉이 바뀔 때도 마찬가지). 테마가 바뀌면 다시 만들지 않고 색만 바꾼다(applyOptions — 확대 유지).
 * lines를 주면 가격 선을 긋는다. className은 차트 상자 높이 (기본 h-[280px] lg:h-[380px]).
 * TradingView 로고는 끈다 (거래량·선을 가리고, 테마를 바꿔도 색이 따라오지 않는다) — 화면이 가까이에 TradingView 링크를 둔다 (라이선스 고지).
 */
export function CandleChart({
  candles,
  currency,
  lines = [],
  variant = "candle",
  className,
}: {
  candles: Candle[];
  currency: Currency;
  lines?: ChartLine[];
  variant?: ChartVariant;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);
  const colors = useChartColors();
  const colorsRef = useRef(colors); // 만들 때·데이터를 넣을 때 쓰는 지금 색 (색이 바뀌어도 차트를 다시 만들지 않게 의존성에서 뺀다)
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    colorsRef.current = colors;
  }, [colors]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const c = colorsRef.current;
    const usd = currency === "USD";
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: c.text,
        fontFamily: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      crosshair: themeOptions(c).crosshair,
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: 2 },
      localization: { locale: "ko-KR", priceFormatter: axisPrice(usd) },
      // 휠·세로 스와이프는 페이지 스크롤에 양보하고, 가로 끌기·두 손가락 벌리기·시간 축 끌기·Ctrl/⌘ + 휠로만 움직인다 (세 차트 공용)
      ...CHART_INTERACTION,
    });
    const unwheel = zoomWheelWithModifier(el, chart);
    const priceFormat = usd ? { type: "price" as const, precision: 2, minMove: 0.01 } : { type: "price" as const, precision: 0, minMove: 1 };
    let candle: ISeriesApi<"Candlestick"> | null = null;
    let line: ISeriesApi<"Line"> | null = null;
    let volume: ISeriesApi<"Histogram"> | null = null;
    const ma: ISeriesApi<"Line">[] = [];
    if (variant === "line") {
      line = chart.addSeries(LineSeries, { color: c.up, lineWidth: 2, priceFormat, crosshairMarkerRadius: 4 });
      // 맨 위 눈금이 잘리지 않게 위아래 여유
      line.priceScale().applyOptions({ scaleMargins: { top: 0.14, bottom: 0.1 } });
    } else {
      candle = chart.addSeries(CandlestickSeries, {
        upColor: c.up,
        downColor: c.down,
        borderVisible: false,
        wickUpColor: c.up,
        wickDownColor: c.down,
        priceFormat,
      });
      candle.priceScale().applyOptions({ scaleMargins: { top: 0.12, bottom: 0.25 } });
      MA_DAYS.forEach((_, i) =>
        ma.push(
          chart.addSeries(LineSeries, {
            color: maColorOf(c, i),
            lineWidth: 1,
            priceFormat,
            lastValueVisible: false,
            priceLineVisible: false,
            crosshairMarkerVisible: false,
          }),
        ),
      );
      volume = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    }
    // 범례: 십자선이 가리키는 봉 (논리 위치 = 일봉 순서. 차트 밖으로 나가면 마지막 봉)
    const onMove = (p: MouseEventParams) => {
      const at = p.point && p.logical !== undefined ? Math.round(p.logical) : null;
      setHover(at);
    };
    chart.subscribeCrosshairMove(onMove);
    handles.current = { chart, candle, line, volume, ma, key: "", lines: [], candles: [], colors: c };
    return () => {
      unwheel();
      chart.unsubscribeCrosshairMove(onMove);
      chart.remove();
      handles.current = null;
    };
  }, [currency, variant]);

  useEffect(() => {
    const h = handles.current;
    if (!h || candles.length === 0) return;
    const c = h.colors;
    const key = `${candles[0].date}:${candles.length}`;
    h.candles = candles;
    if (key === h.key) {
      const last = candles[candles.length - 1];
      h.candle?.update(toBar(last));
      h.line?.update(toClose(last));
      h.volume?.update(toVol(last, c));
      // 진행 중인 봉의 종가가 바뀌면 이동평균의 마지막 점도 같이 바뀐다
      h.ma.forEach((s, i) => {
        const v = movingAverage(candles, MA_DAYS[i]).at(-1);
        if (v) s.update(v);
      });
      return;
    }
    h.candle?.setData(candles.map(toBar));
    h.line?.setData(candles.map(toClose));
    h.line?.applyOptions({ color: closeLineColor(candles, c) });
    h.volume?.setData(candles.map((k) => toVol(k, c)));
    h.ma.forEach((s, i) => s.setData(movingAverage(candles, MA_DAYS[i])));
    // x축: 그 달의 첫 거래일은 날("2일") 대신 달("6월") (lib/chartTicks.ts — 기간이 바뀌면 첫 거래일도 바뀐다)
    h.chart.applyOptions({ timeScale: { tickMarkFormatter: monthStartTickFormatter(candles.map((k) => k.date)) } });
    h.chart.timeScale().fitContent();
    h.key = key;
  }, [candles, currency, variant]);

  // 가격 선은 값이 바뀔 때만 다시 긋는다 (배열이 매번 새로 만들어져도 같은 값이면 그대로)
  const linesKey = lines.map((l) => `${l.tone}:${l.price}:${l.title}`).join("|");
  useEffect(() => {
    const h = handles.current;
    const series = h?.candle ?? h?.line;
    if (!h || !series) return;
    for (const l of h.lines) series.removePriceLine(l.line);
    h.lines = linesKey
      ? linesKey.split("|").map((part) => {
          const [tone, price, ...title] = part.split(":");
          const t = tone as ChartLine["tone"];
          const line = series.createPriceLine({
            price: Number(price),
            color: lineColorOf(h.colors, t),
            lineWidth: 1,
            lineStyle: DASHED,
            axisLabelVisible: true,
            title: title.join(":"),
          });
          return { line, tone: t };
        })
      : [];
  }, [linesKey, currency, variant]);

  // 테마가 바뀌면 색만 다시 넣는다 (차트를 다시 만들지 않아 확대·이동 상태가 남는다)
  useEffect(() => {
    const h = handles.current;
    if (!h || h.colors === colors) return;
    h.colors = colors;
    h.chart.applyOptions(themeOptions(colors));
    h.candle?.applyOptions({ upColor: colors.up, downColor: colors.down, wickUpColor: colors.up, wickDownColor: colors.down });
    h.line?.applyOptions({ color: closeLineColor(h.candles, colors) });
    h.ma.forEach((s, i) => s.applyOptions({ color: maColorOf(colors, i) }));
    if (h.volume && h.candles.length) h.volume.setData(h.candles.map((k) => toVol(k, colors)));
    for (const l of h.lines) l.line.applyOptions({ color: lineColorOf(colors, l.tone) });
  }, [colors]);

  const last = candles.at(-1);
  const index = hover !== null && hover >= 0 && hover < candles.length ? hover : null;
  return (
    <div>
      <Legend candles={candles} index={index} variant={variant} currency={currency} colors={colors} />
      <div
        ref={box}
        className={cn("mt-1 w-full", className ?? "h-[280px] lg:h-[380px]")}
        role="img"
        aria-label={
          last
            ? variant === "line"
              ? `종가 선 차트 (최근 ${candles.length}일, 마지막 ${formatDayLabel(last.date)} 종가 ${formatPrice(last.close, currency)})`
              : `일봉 차트 (마지막 봉 ${last.date}, 오늘 봉은 진행 중일 수 있음)`
            : "일봉 차트"
        }
      />
    </div>
  );
}
