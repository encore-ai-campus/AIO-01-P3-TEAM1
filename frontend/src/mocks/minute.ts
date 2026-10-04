// 가짜 분봉: 일봉 하나(시가·고가·저가·종가)를 09:00~15:30 1분봉 390개로 펼친다 (같은 종목·날짜면 늘 같은 봉).
import type { Candle, Currency, MinuteCandle } from "../api/types";
import { roundTick, seededRandom } from "./seed";

export const SESSION_MINUTES = 390; // 09:00~15:30

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

/** 그날 1분봉 (과거 → 최신). 시가에서 시작해 종가로 끝나고 고가·저가 안에 머문다. */
export function minuteBars(symbol: string, bar: Candle, currency: Currency): MinuteCandle[] {
  const r = seededRandom(`${symbol}-${bar.date}-minute`);
  const n = SESSION_MINUTES;
  // 시가 → 종가로 가는 다리(bridge) 위에 잡음을 얹는다
  const walk: number[] = [0];
  for (let i = 1; i <= n; i++) walk.push(walk[i - 1] + (r() - 0.5));
  const path = walk.map((w, i) => w - (walk[n] * i) / n); // 끝을 0으로
  const amp = Math.max(...path.map(Math.abs)) || 1;
  const span = Math.max(bar.high - bar.low, bar.close * 0.002);
  const clamp = (p: number) => Math.min(bar.high, Math.max(bar.low, p));
  const priceAt = (i: number) => clamp(bar.open + ((bar.close - bar.open) * i) / n + (path[i] / amp) * span * 0.45);
  const out: MinuteCandle[] = [];
  for (let i = 0; i < n; i++) {
    const open = roundTick(i === 0 ? bar.open : priceAt(i), currency);
    const close = roundTick(i === n - 1 ? bar.close : priceAt(i + 1), currency);
    const wiggle = span * 0.05 * r();
    out.push({
      time: `${bar.date}T${hhmm(9 * 60 + i)}:00+09:00`,
      open,
      high: roundTick(clamp(Math.max(open, close) + wiggle), currency),
      low: roundTick(clamp(Math.min(open, close) - wiggle), currency),
      close,
      volume: Math.round((bar.volume / n) * (0.4 + r() * 1.2)),
    });
  }
  return out;
}

/** 1분봉을 minutes분 간격으로 묶는다 (09:00 기준). */
export function aggregateBars(bars: MinuteCandle[], minutes: number): MinuteCandle[] {
  if (minutes <= 1) return bars;
  const out: MinuteCandle[] = [];
  for (let i = 0; i < bars.length; i += minutes) {
    const group = bars.slice(i, i + minutes);
    out.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map((b) => b.high)),
      low: Math.min(...group.map((b) => b.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((n, b) => n + b.volume, 0),
    });
  }
  return out;
}
