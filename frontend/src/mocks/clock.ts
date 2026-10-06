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

// ---------------------------------------------------------------- 장마감 기준 (docs/API.md 공통 규칙 "장마감 기준")

/** 일봉 종가가 굳기를 기다리는 여유 (정규장 종료 + 10분). */
export const CLOSE_SETTLE_MIN = 10;

/** 날짜 "YYYY-MM-DD"가 평일인지 (가짜 API는 공휴일을 모른다). */
export function isWeekday(day: string): boolean {
  const wd = new Date(`${day}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
}

export function prevWeekday(day: string): string {
  let d = addDays(day, -1);
  while (!isWeekday(d)) d = addDays(d, -1);
  return d;
}

/** 그 시장 현지 날짜 YYYY-MM-DD. */
export function marketDay(market: Market, now: Date = new Date()): string {
  const z = zoned(now, TZ[market]);
  return `${z.y}-${z.m}-${z.d}`;
}

/** 그 시장 현지 시각(분, 0~1439). */
export function marketMinutes(market: Market, now: Date = new Date()): number {
  return zoned(now, TZ[market]).minutes;
}

/** 기준일: 정규장 종료 + 10분이 now 이전인 가장 최근 영업일 (그 시장 현지 날짜). */
export function basisDay(market: Market, now: Date = new Date()): string {
  const z = zoned(now, TZ[market]);
  const today = `${z.y}-${z.m}-${z.d}`;
  if (isWeekday(today) && z.minutes >= HOURS[market].close + CLOSE_SETTLE_MIN) return today;
  return prevWeekday(today);
}

/** day(그 시장 현지 날짜)의 hh:mm을 오프셋이 붙은 ISO로. */
export function marketIso(market: Market, day: string, minutes: number): string {
  // 그 날짜 낮 시각으로 오프셋을 구한다 (서머타임은 새벽 2시에 바뀌므로 낮이면 그날 값)
  const probe = zoned(new Date(`${day}T17:00:00Z`), TZ[market]);
  return `${day}T${hhmm(minutes)}:00${probe.offset}`;
}

/** 그 날짜의 정규장 종료 시각 ISO (KR 15:30+09:00, US 뉴욕 16:00). */
export function sessionEndIso(market: Market, day: string): string {
  return marketIso(market, day, HOURS[market].close);
}

/** day로 끝나는(포함) 평일 n개 (과거 → 최신). */
export function weekdaysEnding(day: string, n: number): string[] {
  const out: string[] = [];
  let d = isWeekday(day) ? day : prevWeekday(day);
  while (out.length < n) {
    out.push(d);
    d = prevWeekday(d);
  }
  return out.reverse();
}

/** KST 그 날짜 00:00의 epoch ms. */
export function kstDayStartMs(day: string): number {
  return Date.parse(`${day}T00:00:00+09:00`);
}
