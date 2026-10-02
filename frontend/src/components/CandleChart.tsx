import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle, Currency } from "../api/types";

const UP = "#F04452";
const DOWN = "#3182F6";

interface Handles {
  chart: IChartApi;
  candle: ISeriesApi<"Candlestick">;
  volume: ISeriesApi<"Histogram">;
  key: string;
}

const toBar = (k: Candle) => ({ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close });
const toVol = (k: Candle) => ({
  time: k.date,
  value: k.volume,
  color: k.close >= k.open ? "rgba(240,68,82,0.28)" : "rgba(49,130,246,0.28)",
});

/** 일봉 캔들 + 거래량. 같은 기간이면 마지막 봉만 갱신해 확대·이동 상태를 지킨다. */
export function CandleChart({ candles, currency }: { candles: Candle[]; currency: Currency }) {
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
    handles.current = { chart, candle, volume, key: "" };
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

  return <div ref={box} className="h-[280px] w-full lg:h-[380px]" role="img" aria-label="일봉 차트" />;
}
