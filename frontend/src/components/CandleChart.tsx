import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineStyle,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle, Currency } from "../api/types";

const UP = "#F04452";
const DOWN = "#3182F6";

/** 차트 위 가격 선 (예: 사는 가격·목표 가격·손절 가격). title은 쉬운 이름으로. */
export interface ChartLine {
  price: number;
  title: string;
  tone: "entry" | "target" | "stop";
}

const LINE_COLOR: Record<ChartLine["tone"], string> = { entry: "#191F28", target: UP, stop: DOWN };
// LineStyle.Dashed (값만 쓴다 — 테스트의 차트 가짜 모듈에는 enum이 없다)
const DASHED = 2 as LineStyle;

interface Handles {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  key: string;
  lines: IPriceLine[];
}

const toBar = (k: Candle) => ({ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close });
const toVol = (k: Candle) => ({
  time: k.date,
  value: k.volume,
  color: k.close >= k.open ? "rgba(240,68,82,0.28)" : "rgba(49,130,246,0.28)",
});

/**
 * 일봉 캔들 + 거래량. 일봉은 장마감 기준 완성 봉만 온다 (StockDetail.candles — 오늘 미완성 봉 없음).
 * 같은 기간이면 마지막 봉만 갱신해 확대·이동 상태를 지킨다. lines를 주면 가격 선을 긋는다.
 */
export function CandleChart({ candles, currency, lines = [] }: { candles: Candle[]; currency: Currency; lines?: ChartLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const handles = useRef<Handles | null>(null);

  useEffect(() => {
    if (!box.current) return;
    const usd = currency === "USD";
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
      timeScale: { borderVisible: false, rightOffset: 2 },
      localization: {
        locale: "ko-KR",
        priceFormatter: (p: number) => (usd ? `$${p.toFixed(2)}` : Math.round(p).toLocaleString("ko-KR")),
      },
    });
    const candle = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: usd ? { type: "price", precision: 2, minMove: 0.01 } : { type: "price", precision: 0, minMove: 1 },
    });
    candle.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    handles.current = { chart, candle, volume, key: "", lines: [] };
    return () => {
      chart.remove();
      handles.current = null;
    };
  }, [currency]);

  useEffect(() => {
    const h = handles.current;
    if (!h || candles.length === 0) return;
    const key = `${candles[0].date}:${candles.length}`;
    if (key === h.key) {
      const last = candles[candles.length - 1];
      h.candle.update(toBar(last));
      h.volume.update(toVol(last));
      return;
    }
    h.candle.setData(candles.map(toBar));
    h.volume.setData(candles.map(toVol));
    h.chart.timeScale().fitContent();
    h.key = key;
  }, [candles, currency]);

  // 가격 선은 값이 바뀔 때만 다시 긋는다 (배열이 매번 새로 만들어져도 같은 값이면 그대로)
  const linesKey = lines.map((l) => `${l.tone}:${l.price}:${l.title}`).join("|");
  useEffect(() => {
    const h = handles.current;
    if (!h) return;
    for (const l of h.lines) h.candle.removePriceLine(l);
    h.lines = linesKey
      ? linesKey.split("|").map((part) => {
          const [tone, price, ...title] = part.split(":");
          return h.candle.createPriceLine({
            price: Number(price),
            color: LINE_COLOR[tone as ChartLine["tone"]] ?? "#8B95A1",
            lineWidth: 1,
            lineStyle: DASHED,
            axisLabelVisible: true,
            title: title.join(":"),
          });
        })
      : [];
  }, [linesKey, currency]);

  const last = candles.at(-1);
  return (
    <div
      ref={box}
      className="h-[280px] w-full lg:h-[380px]"
      role="img"
      aria-label={last ? `일봉 차트 (완성된 봉만, 마지막 봉 ${last.date} 종가 기준)` : "일봉 차트"}
    />
  );
}
