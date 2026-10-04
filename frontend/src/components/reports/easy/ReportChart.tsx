// 쉬운 보기의 차트: 완성된 일봉(장마감 기준) + AI가 제안한 사는·목표·손절 가격 선 (선 이름은 쉬운 말).
// 차트 라이브러리를 쓰므로 리포트 상세에서 따로 불러온다 (lazy).
import { CandlestickSeries, createChart } from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Candle, Currency } from "../../../api/types";

const UP = "#F04452";
const DOWN = "#3182F6";

export interface PriceLine {
  price: number;
  title: string;
  color: string;
}

export function ReportChart({ candles, currency, lines }: { candles: Candle[]; currency: Currency; lines: PriceLine[] }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!box.current || candles.length === 0) return;
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
    const series = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderVisible: false,
      wickUpColor: UP,
      wickDownColor: DOWN,
      priceFormat: usd ? { type: "price", precision: 2, minMove: 0.01 } : { type: "price", precision: 0, minMove: 1 },
    });
    series.setData(candles.map((k) => ({ time: k.date, open: k.open, high: k.high, low: k.low, close: k.close })));
    for (const l of lines) series.createPriceLine({ price: l.price, title: l.title, color: l.color, lineWidth: 2, axisLabelVisible: true });
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [candles, currency, lines]);

  return <div ref={box} className="h-[260px] w-full lg:h-[340px]" role="img" aria-label="일봉 차트와 계획 가격 선" />;
}
