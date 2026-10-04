// 단타 연습 화면의 작은 계산: 오늘(KST) 날짜, 가격 입력 읽기, 시각 "HH:MM".
// (Fast Refresh 규칙 때문에 컴포넌트 파일 밖에 둔다.)

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

/** ISO 시각 → KST "HH:MM". */
export function hm(iso: string | null | undefined): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
}
