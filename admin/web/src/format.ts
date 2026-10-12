import type { DeployResult, Level, TraceKind } from "./api";

export const DASH = "–";

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, "0");

/** ISO 시각 → KST `MM-DD HH:mm:ss` */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return DASH;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return DASH;
  const d = new Date(t + KST_OFFSET_MS);
  return `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

/** 현재 시각(Date) → KST `HH:mm:ss` */
export function fmtClock(d: Date): string {
  const k = new Date(d.getTime() + KST_OFFSET_MS);
  return `${pad(k.getUTCHours())}:${pad(k.getUTCMinutes())}:${pad(k.getUTCSeconds())}`;
}

export function fmtUsd(v: number | null | undefined): string {
  return v == null ? DASH : `$${v.toFixed(3)}`;
}

/** ms → 1초 이상이면 `2.3초`, 아니면 `850ms` */
export function fmtMs(v: number | null | undefined): string {
  if (v == null) return DASH;
  if (v >= 1000) return `${(v / 1000).toFixed(1)}초`;
  return `${Math.round(v)}ms`;
}

export function fmtPct(v: number | null | undefined): string {
  return v == null ? DASH : `${v}%`;
}

export function fmtNum(v: number | string | null | undefined): string {
  return v == null || v === "" ? DASH : String(v);
}

/** 초 → `45초` · `3분 20초` · `2시간 5분` */
export function fmtAge(sec: number | null | undefined): string {
  if (sec == null) return DASH;
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}초`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m}분 ${r}초` : `${m}분`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h}시간 ${m}분` : `${h}시간`;
}

export const shortTag = (tag: string | null | undefined) => (tag ? tag.slice(0, 7) : DASH);

export const LEVEL_LABEL: Record<Level, string> = { down: "멈춤", warn: "주의", unknown: "모름", ok: "정상" };

export const DEPLOY_RESULT_LABEL: Record<DeployResult, string> = {
  success: "성공",
  rolled_back: "되돌림",
  rollback_failed: "되돌리기 실패",
  failed: "실패",
  blocked: "차단",
};
export const DEPLOY_RESULT_LEVEL: Record<DeployResult, Level> = {
  success: "ok",
  rolled_back: "warn",
  rollback_failed: "down",
  failed: "down",
  blocked: "warn",
};

export const TRACE_KIND_LABEL: Record<TraceKind, string> = {
  retry: "재시도",
  failover: "대체 모델 전환",
  failure: "실패",
  give_up: "포기",
  recovered: "복구",
  skipped: "건너뜀",
  guard: "Guard",
  workflow: "워크플로우",
  other: "기타",
};
export const TRACE_KIND_LEVEL: Record<TraceKind, Level> = {
  retry: "warn",
  failover: "warn",
  failure: "warn",
  give_up: "down",
  recovered: "ok",
  skipped: "unknown",
  guard: "unknown",
  workflow: "unknown",
  other: "unknown",
};

export const REPORT_STATUS_LABEL = {
  requested: "대기",
  running: "실행 중",
  completed: "완료",
  failed: "실패",
} as const;
export const TEAM_LABEL = { stock_report: "종목 리포트", stock_selection: "종목 선정" } as const;
export const SOURCE_LABEL = { user: "사용자", auto: "자동" } as const;
