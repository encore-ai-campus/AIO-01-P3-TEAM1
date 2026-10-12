// 금액·수익률·시각 표시 형식은 모두 여기서 만든다.
import type { Currency, Market, QuoteBasis } from "../api/types";

const KST = "Asia/Seoul";
const MARKET_TZ: Record<Market, string> = { KR: KST, US: "America/New_York" };
const intKo = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 });
const usd = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/** 1234567 → "1,234,567원" (원 단위 반올림). */
export function formatKrw(n: number | null | undefined): string {
  if (!isNum(n)) return "-";
  return `${intKo.format(Math.round(n))}원`;
}

/** 부호를 붙인 원화: "+12,345원", "-12,345원", "0원". */
export function formatSignedKrw(n: number | null | undefined): string {
  if (!isNum(n)) return "-";
  const r = Math.round(n);
  if (r === 0) return "0원";
  return `${r > 0 ? "+" : "-"}${intKo.format(Math.abs(r))}원`;
}

/** 종목 통화로 가격 표시: 원화 "71,000원", 달러 "$123.45". */
export function formatPrice(n: number | null | undefined, currency: Currency = "KRW"): string {
  if (!isNum(n)) return "-";
  if (currency === "USD") return `${n < 0 ? "-" : ""}$${usd.format(Math.abs(n))}`;
  return formatKrw(n);
}

/** 부호를 붙인 가격 변화: "+1,000원", "-$1.23". */
export function formatSignedPrice(n: number | null | undefined, currency: Currency = "KRW"): string {
  if (!isNum(n)) return "-";
  if (currency === "KRW") return formatSignedKrw(n);
  const rounded = Math.round(n * 100) / 100;
  if (rounded === 0) return "$0.00";
  return `${rounded > 0 ? "+" : "-"}$${usd.format(Math.abs(rounded))}`;
}

/** 소수 비율 → 부호가 붙은 백분율: 0.0123 → "+1.23%", -0.005 → "-0.50%". */
export function formatRate(r: number | null | undefined, digits = 2): string {
  if (!isNum(r)) return "-";
  const pct = r * 100;
  const fixed = Math.abs(pct).toFixed(digits);
  if (Number(fixed) === 0) return `${(0).toFixed(digits)}%`;
  return `${pct > 0 ? "+" : "-"}${fixed}%`;
}

/** 확률·비중 (부호 없음): 0.62 → "62%". */
export function formatPercent(r: number | null | undefined, digits = 0): string {
  if (!isNum(r)) return "-";
  return `${(r * 100).toFixed(digits)}%`;
}

/** 수량: 국내는 정수 "10주", 소수 주는 최대 6자리. */
export function formatQty(n: number | null | undefined): string {
  if (!isNum(n)) return "-";
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 }).format(n)}주`;
}

/** 천 단위 쉼표만 (입력 보조용). */
export function formatNumber(n: number | null | undefined, digits = 0): string {
  if (!isNum(n)) return "-";
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: digits }).format(n);
}

export function formatUsd(n: number | null | undefined): string {
  return formatPrice(n, "USD");
}

export type Trend = "up" | "down" | "flat";

export function trendOf(n: number | null | undefined): Trend {
  if (!isNum(n) || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

/** 상승 빨강, 하락 파랑, 보합 회색. */
export function trendClass(n: number | null | undefined): string {
  const t = trendOf(n);
  return t === "up" ? "text-up" : t === "down" ? "text-down" : "text-sub";
}

function parts(iso: string, opts: Intl.DateTimeFormatOptions, timeZone: string = KST): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("ko-KR", { timeZone, hourCycle: "h23", ...opts }).formatToParts(new Date(iso))) {
    out[p.type] = p.value;
  }
  return out;
}

/**
 * 장마감 기준 표기 (docs/API.md 공통 규칙 "장마감 기준"). 시각은 그 시장의 현지 시각으로 보인다.
 * KR "10월 2일(금) 15:30 장마감 기준", US "10월 2일(금) 16:00(뉴욕) 장마감 기준". 값이 없으면 "-".
 */
export function formatAsOf(iso: string | null | undefined, market: Market = "KR"): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return "-";
  const p = parts(iso, { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }, MARKET_TZ[market]);
  return `${p.month}월 ${p.day}일(${p.weekday}) ${p.hour}:${p.minute}${market === "US" ? "(뉴욕)" : ""} 장마감 기준`;
}

/** 실시간 표기: "실시간 · 15:20:31" (현재가를 받은 시각, 한국 시간, 초까지 — docs/API.md 공통 규칙 "실시간 시세"). 값이 없으면 "-". */
export function formatLiveAsOf(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return "-";
  const p = parts(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `실시간 · ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * 장 중에 만든 리포트의 가격 시각 (docs/API.md 공통 규칙 "리포트 시세"): "10월 8일(목) 15:23 기준" (그 시장 현지 시각, 미국은 "15:23(뉴욕)").
 * 리포트는 나중에도 읽으므로 "실시간 · 시각"이 아니라 날짜를 넣는다. 쉬운 PDF(backend/reports/output/pdf.py _live_at)와 같은 글자. 값이 없으면 "-".
 */
export function formatIntradayAsOf(iso: string | null | undefined, market: Market = "KR"): string {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return "-";
  const p = parts(iso, { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" }, MARKET_TZ[market]);
  return `${p.month}월 ${p.day}일(${p.weekday}) ${p.hour}:${p.minute}${market === "US" ? "(뉴욕)" : ""} 기준`;
}

/** 시세의 기준 표기: live는 "실시간 · 15:20:31", close(기본)는 formatAsOf("… 장마감 기준"). */
export function formatQuoteAsOf(iso: string | null | undefined, market: Market = "KR", basis: QuoteBasis = "close"): string {
  return basis === "live" ? formatLiveAsOf(iso) : formatAsOf(iso, market);
}

/** 날짜 "YYYY-MM-DD" → "10월 6일(화)" (세션·기준일 표시). 형식이 틀리면 그대로. */
export function formatDayLabel(day: string | null | undefined): string {
  if (!day) return "-";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return day;
  // 날짜만 있는 값이라 UTC 정오로 읽어 요일을 구한다 (시간대와 무관)
  const weekday = new Intl.DateTimeFormat("ko-KR", { timeZone: "UTC", weekday: "short" }).format(
    new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)),
  );
  return `${Number(m[2])}월 ${Number(m[3])}일(${weekday})`;
}

/** ISO 시각 → 한국 시간 "10.02 09:05". 올해가 아니면 "2025.10.02 09:05". */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  const p = parts(iso, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const nowYear = parts(new Date().toISOString(), { year: "numeric" }).year;
  const date = p.year === nowYear ? `${p.month}.${p.day}` : `${p.year}.${p.month}.${p.day}`;
  return `${date} ${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DD" → "2026.10.02". */
export function formatDate(day: string | null | undefined): string {
  if (!day) return "-";
  const [y, m, d] = day.slice(0, 10).split("-");
  if (!y || !m || !d) return day;
  return `${y}.${m}.${d}`;
}

/** 지금부터 얼마 전인지: "방금", "5분 전", "3시간 전", 하루 넘으면 날짜. */
export function formatRelative(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return "-";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "-";
  const sec = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (sec < 60) return "방금";
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  return formatDateTime(iso);
}

/** 분석 요청자 표시: "strategy:3" → "전략 3", "cli" → "엔진 CLI". */
export function formatRequester(by: string | null | undefined): string {
  if (!by) return "-";
  if (by.startsWith("strategy:")) return `전략 ${by.slice("strategy:".length)}`;
  if (by === "cli") return "엔진 CLI";
  return by;
}

/** ISO 시각 → 한국 시간 "09:05:12" (Trace 사건 시각). */
export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "-";
  if (Number.isNaN(new Date(iso).getTime())) return "-";
  const p = parts(iso, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return `${p.hour}:${p.minute}:${p.second}`;
}

/** 걸린 시간: 850 → "850ms", 2140 → "2.14초". */
export function formatLatency(ms: number | null | undefined): string {
  if (!isNum(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}초`;
}
