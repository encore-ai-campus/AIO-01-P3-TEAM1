// 가짜 API용 시각·정규장 계산 (공휴일은 무시하고 평일 정규장만 본다).
import type { Market } from "../api/types";

const TZ: Record<Market, string> = { KR: "Asia/Seoul", US: "America/New_York" };
const HOURS: Record<Market, { open: number; close: number }> = {
  KR: { open: 9 * 60, close: 15 * 60 + 30 },
  US: { open: 9 * 60 + 30, close: 16 * 60 },
};
const DAY = 86_400_000;

interface Zoned {
  y: string;
  m: string;
  d: string;
  minutes: number;
  weekend: boolean;
  offset: string;
}

function zoned(date: Date, tz: string): Zoned {
  const p: Record<string, string> = {};
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    weekday: "short",
    timeZoneName: "longOffset",
  });
  for (const x of fmt.formatToParts(date)) p[x.type] = x.value;
  const offset = p.timeZoneName === "GMT" ? "+00:00" : p.timeZoneName.replace("GMT", "");
  return {
    y: p.year,
    m: p.month,
    d: p.day,
    minutes: Number(p.hour) * 60 + Number(p.minute),
    weekend: p.weekday === "Sat" || p.weekday === "Sun",
    offset,
  };
}

const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

function isoAt(z: Zoned, min: number): string {
  return `${z.y}-${z.m}-${z.d}T${hhmm(min)}:00${z.offset}`;
}

/** 한국 시간 ISO (초 단위): "2026-10-02T09:05:12+09:00". */
export function kstIso(date: Date = new Date()): string {
  const shifted = new Date(date.getTime() + 9 * 3_600_000);
  return `${shifted.toISOString().slice(0, 19)}+09:00`;
}

export function kstDay(date: Date = new Date()): string {
  return kstIso(date).slice(0, 10);
}

export function addDays(day: string, n: number): string {
  const t = Date.parse(`${day}T00:00:00Z`) + n * DAY;
  return new Date(t).toISOString().slice(0, 10);
}

/** 오늘(KST)부터 거슬러 올라간 평일 n개 (과거 → 최신). */
export function businessDays(n: number, now: Date = new Date()): string[] {
  const out: string[] = [];
  let day = kstDay(now);
  while (out.length < n) {
    const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(day);
    day = addDays(day, -1);
  }
  return out.reverse();
}

export interface Session {
  isOpen: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

/** 지금 정규장인지와 다음(또는 오늘) 시작·오늘 종료 시각. override가 있으면 그 값을 따른다 (테스트용). */
export function session(market: Market, now: Date = new Date(), override?: boolean): Session {
  const tz = TZ[market];
  const { open, close } = HOURS[market];
  const today = zoned(now, tz);
  const realOpen = !today.weekend && today.minutes >= open && today.minutes < close;
  const isOpen = override ?? realOpen;
  if (isOpen) return { isOpen, opensAt: isoAt(today, open), closesAt: isoAt(today, close) };

  const beforeOpenToday = override === undefined && !today.weekend && today.minutes < open;
  if (beforeOpenToday) return { isOpen, opensAt: isoAt(today, open), closesAt: null };
  for (let k = 1; k <= 7; k++) {
    const z = zoned(new Date(now.getTime() + k * DAY), tz);
    if (!z.weekend) return { isOpen, opensAt: isoAt(z, open), closesAt: null };
  }
  return { isOpen, opensAt: null, closesAt: null };
}
