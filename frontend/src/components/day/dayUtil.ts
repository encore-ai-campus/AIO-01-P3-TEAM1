// 단타 연습 화면의 작은 계산: 오늘(KST) 날짜, 가격 입력 읽기·쓰기, 시각 "HH:MM", 세션 넘기기, 복기 입구, 화면 안으로 옮기기.
// (Fast Refresh 규칙 때문에 컴포넌트 파일 밖에 둔다.)
import type { RiskProfile } from "../../api/types";
import { formatDayLabel } from "../../lib/format";
import { prefersReducedMotion } from "../../lib/motion";

/** 지금의 KST 날짜 YYYY-MM-DD. */
export function kstToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 원화 가격 입력 → 숫자 (쉼표·"원" 허용). 비었으면 null, 0 이하·숫자가 아니면 NaN. */
export function parsePrice(raw: string): number | null {
  const v = raw.replace(/[,\s원]/g, "");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Number.NaN;
}

/**
 * 칸을 떠날 때 천 단위 쉼표를 넣는다 ("191000" → "191,000"). 읽을 수 없는 값은 그대로 둔다 (오류 문장이 알려 준다).
 * 입력하는 동안에는 바꾸지 않는다 — 커서가 튀지 않게.
 */
export function formatPriceInput(raw: string): string {
  const n = parsePrice(raw);
  return n !== null && !Number.isNaN(n) ? n.toLocaleString("ko-KR", { maximumFractionDigits: 2 }) : raw;
}

/** 기준 가격 대비 몇 % (부호와 소수 한 자리): "+6.3%", "−1.0%". 하나라도 없으면 null. */
export function pctFrom(base: number | null | undefined, value: number | null | undefined): string | null {
  if (!base || !value || Number.isNaN(base) || Number.isNaN(value)) return null;
  const pct = ((value - base) / base) * 100;
  const fixed = Math.abs(pct).toFixed(1);
  if (Number(fixed) === 0) return "0.0%";
  return `${pct > 0 ? "+" : "−"}${fixed}%`;
}

/** ISO 시각 → KST "HH:MM". */
export function hm(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}

/**
 * 앞·뒤 세션 날짜 (YYYY-MM-DD, 주말은 건너뛴다). 휴장일은 화면이 모르므로 서버 응답(계획 없음)으로 알게 된다.
 * 형식이 틀리면 null.
 */
export function shiftSession(day: string, dir: -1 | 1): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  // 날짜만 있는 값이라 UTC 정오로 계산한다 (시간대와 무관)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  do {
    d.setUTCDate(d.getUTCDate() + dir);
  } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/**
 * 복기 입구의 글자와 주소. 복기 화면의 기본은 KR 기준일(15:40 전에는 직전 세션)이라,
 * 오늘 단타가 끝난 뒤(15:15 이후)에만 오늘 날짜를 넘긴다 — '오늘 단타 계획' 옆에서 눌렀는데 어제가 열리지 않게.
 */
export function reviewEntry({
  todayDate,
  hasTodayPlans,
  accepting,
  basis,
}: {
  todayDate: string | null;
  hasTodayPlans: boolean;
  accepting: boolean;
  basis: string | null;
}): { label: string; short: string; to: string } {
  if (todayDate && hasTodayPlans && !accepting) {
    return { label: "오늘 세션 복기", short: "오늘 세션 복기", to: `/day/review?date=${todayDate}` };
  }
  return { label: basis ? `최근 세션 복기 · ${formatDayLabel(basis)}` : "최근 세션 복기", short: "최근 세션 복기", to: "/day/review" };
}

/**
 * 요소를 화면 안으로 (이미 보이면 그대로 — block "nearest"). 움직임 줄이기면 바로 옮긴다.
 * smooth=false는 내용이 통째로 바뀌는 순간(그리기 전)에 쓴다 — 바뀐 화면에서 다시 미끄러지는 움직임은 오히려 어지럽다.
 * jsdom에는 scrollIntoView가 없어 건너뛴다. 모바일 위 머리에 가리지 않게 대상에 scroll-mt-*를 준다.
 */
export function revealIntoView(el: Element | null | undefined, block: ScrollLogicalPosition = "nearest", smooth = true) {
  if (!el || typeof el.scrollIntoView !== "function") return;
  el.scrollIntoView({ block, behavior: smooth && !prefersReducedMotion() ? "smooth" : "auto" });
}

/** 오늘 쓴 양의 단계: 다 씀(full) · 80% 이상(near) · 넉넉함(ok). 한도가 0 이하면 ok. */
export function usageLevel(used: number, limit: number): "full" | "near" | "ok" {
  if (!(limit > 0)) return "ok";
  if (used >= limit) return "full";
  return used >= limit * 0.8 ? "near" : "ok";
}

/** 쓴 양 글자색: 다 쓰면 실패 글자색, 거의 다 쓰면 경고 글자색 (가격의 오름 빨강과 섞이지 않게 *-ink 토큰). */
export const USAGE_TEXT = { full: "font-semibold text-up-ink", near: "font-semibold text-warn-ink", ok: "" } as const;

/** 하루 안에 사고파는 연습이 성향과 맞지 않는 진단 결과 (docs/투자서비스확장계획.md 2-3 — 마이 DayQuizEntry와 같은 목록). */
export const DAY_CAREFUL_PROFILES: readonly RiskProfile[] = ["stable", "stable_seeking"];
