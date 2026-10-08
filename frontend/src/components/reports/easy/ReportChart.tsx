// 쉬운 보기의 차트: 종가 선(오늘 정규장이 열렸으면 진행 중인 봉의 지금 가격까지 — 실시간 시세 기준) + AI가 제안한 사는·목표·손절 가격 선 (선 이름은 쉬운 말).
// 종목 상세 쉬운 보기(CandleChart variant "line")와 같은 선이다 — 기간 전체로 올랐으면 빨강, 내렸으면 파랑, 같은 굵기·위아래 여유 (UX-17: 캔들은 전문가 보기에만).
// x축은 그 달의 첫 거래일을 날("2일") 대신 달("6월")로 쓴다 (lib/chartTicks.ts).
// 차트 라이브러리를 쓰므로 리포트 상세에서 따로 불러온다 (lazy).
// 색은 테마 토큰(lib/chartTheme.ts). 테마가 바뀌면 차트를 다시 만들지 않고 applyOptions로 색만 바꾼다 (확대 상태가 그대로 남게).
// 좁은 화면(480px 미만)에서는 가격 선 이름을 빼고 축 라벨만 둔다 — 이름이 최근 봉과 눈금을 가리지 않게. 값과 이름은 차트 아래 범례가 보인다.
// 휠·세로로 쓸어 넘기기는 페이지 스크롤에 양보한다 (리포트는 긴 세로 화면이라 차트가 스크롤을 먹으면 안 된다). 확대는 두 손가락 벌리기·Ctrl/⌘ + 휠 (세 차트 공용 lib/chartOptions.ts).
import { type IChartApi, type IPriceLine, type ISeriesApi, LineSeries, createChart } from "lightweight-charts";
import { useEffect, useLayoutEffect, useRef } from "react";
import type { Candle, Currency } from "../../../api/types";
import { CHART_INTERACTION, lineTitle, zoomWheelWithModifier } from "../../../lib/chartOptions";
import { type ChartColors, useChartColors } from "../../../lib/chartTheme";
import { monthStartTickFormatter } from "../../../lib/chartTicks";

/** 가격 선의 뜻 (색은 테마에서 고른다: 목표 = 상승색, 사는 가격 = 보조 글자색, 손절 = 하락색). */
export type PriceLineKind = "target" | "entry" | "stop";

export interface PriceLine {
  price: number;
  title: string;
  kind: PriceLineKind;
}

const lineColor = (c: ChartColors, kind: PriceLineKind) => (kind === "target" ? c.targetLine : kind === "entry" ? c.entryLine : c.stopLine);
/** 종가 선 색: 기간 전체로 올랐으면 빨강, 내렸으면 파랑 (한국 관례 — 종목 상세 쉬운 보기와 같다). */
const closeColor = (candles: Candle[], c: ChartColors) => (candles.length > 1 && candles[candles.length - 1].close < candles[0].close ? c.down : c.up);

export function ReportChart({ candles, currency, lines }: { candles: Candle[]; currency: Currency; lines: PriceLine[] }) {
  const box = useRef<HTMLDivElement>(null);
  const colors = useChartColors();
  // 차트를 만들 때 쓸 지금 색 (만드는 effect의 의존성에 넣지 않으려고 ref로 넘긴다 — 테마 변경은 아래 effect가 applyOptions로)
  const colorsRef = useRef(colors);
  const chartRef = useRef<{ chart: IChartApi; series: ISeriesApi<"Line">; lines: { line: IPriceLine; kind: PriceLineKind }[]; candles: Candle[] } | null>(null);

  useLayoutEffect(() => {
    colorsRef.current = colors;
  }, [colors]);

  useEffect(() => {
    const el = box.current;
    if (!el || candles.length === 0) return;
    const c = colorsRef.current;
    const usd = currency === "USD";
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { color: "transparent" },
        textColor: c.text,
        fontFamily: "'Pretendard Variable', Pretendard, system-ui, sans-serif",
        fontSize: 11,
        attributionLogo: false, // 고지는 아래 글자 링크 (role=img 안에 링크를 두지 않는다)
      },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: 2, tickMarkFormatter: monthStartTickFormatter(candles.map((k) => k.date)) },
      localization: {
        locale: "ko-KR",
        priceFormatter: (p: number) => (usd ? `$${p.toFixed(2)}` : Math.round(p).toLocaleString("ko-KR")),
      },
      ...CHART_INTERACTION,
    });
    const unwheel = zoomWheelWithModifier(el, chart);
    const series = chart.addSeries(LineSeries, {
      color: closeColor(candles, c),
      lineWidth: 2,
      crosshairMarkerRadius: 4,
      priceFormat: usd ? { type: "price", precision: 2, minMove: 0.01 } : { type: "price", precision: 0, minMove: 1 },
    });
    // 맨 위 눈금·가격 선 이름이 잘리지 않게 위아래 여유 (종목 상세 쉬운 보기와 같다)
    series.priceScale().applyOptions({ scaleMargins: { top: 0.14, bottom: 0.1 } });
    series.setData(candles.map((k) => ({ time: k.date, value: k.close })));
    // 좁은 화면은 선 이름 없이 축 라벨만 (lib/chartOptions lineTitle)
    const made = lines.map((l) => ({
      kind: l.kind,
      line: series.createPriceLine({ price: l.price, title: lineTitle(el, l.title), color: lineColor(c, l.kind), lineWidth: 2, axisLabelVisible: true }),
    }));
    chart.timeScale().fitContent();
    chartRef.current = { chart, series, lines: made, candles };
    return () => {
      unwheel();
      chartRef.current = null;
      chart.remove();
    };
  }, [candles, currency, lines]);

  // 테마가 바뀌면 색만 바꾼다 (처음 만들 때 한 번 더 같은 색을 넣는 것은 해가 없다)
  useEffect(() => {
    const cur = chartRef.current;
    if (!cur) return;
    cur.chart.applyOptions({ layout: { textColor: colors.text }, grid: { horzLines: { color: colors.grid } } });
    cur.series.applyOptions({ color: closeColor(cur.candles, colors) });
    for (const l of cur.lines) l.line.applyOptions({ color: lineColor(colors, l.kind) });
  }, [colors]);

  // 차트 라이브러리 고지(lightweight-charts)는 차트 안 로고 대신 그림 밖 글자 링크로 둔다 — role="img" 안의 로고 링크는 이름 없는 Tab 정지점이 됐다.
  // 전체 높이는 불러오는 동안의 자리(260·340px) 그대로 두고 그 안에서 차트와 고지 줄을 나눈다 (불러온 뒤 아래 내용이 밀리지 않게)
  return (
    <div className="flex h-[260px] w-full flex-col lg:h-[340px]">
      <div ref={box} className="min-h-0 w-full flex-1" role="img" aria-label="종가 선 차트와 계획 가격 선" />
      <p className="mt-1 shrink-0 text-right text-[12px] leading-4">
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noopener noreferrer"
          title="Charting by TradingView"
          className="rounded-sm text-mute transition-colors hover:text-sub hover:underline"
        >
          TradingView
        </a>
      </p>
    </div>
  );
}
