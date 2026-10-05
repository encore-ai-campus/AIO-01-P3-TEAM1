// 장기투자 화면 조각이 같이 쓰는 표시 규칙: 펀더멘털 값·변화 표시, 축별 요약, 근거 종류 이름, 산 이유 예시.
// 문구는 원인을 단정하지 않고 권유하지 않는다 (docs/API.md "금지 표현"). (Fast Refresh 규칙 때문에 컴포넌트 파일 밖에 둔다.)
import type { CheckStatus, DailyMoveEvidence, FundamentalKey, FundamentalsOverall, FundamentalsRow, ThesisAxis } from "../../api/types";
import type { GlossaryKey } from "../../lib/glossary";
import { CHECK_STATUS_TEXT, THESIS_AXIS_TEXT } from "../../lib/plainText";

export const THESIS_AXES: ThesisAxis[] = ["growth", "profitability", "balance_sheet"];

/** 지표 → 용어 사전 (풀이가 있는 것만). */
export const FUNDAMENTAL_TERM: Partial<Record<FundamentalKey, GlossaryKey>> = {
  operatingMargin: "영업이익률",
  roe: "ROE",
  debtRatio: "부채비율",
  currentRatio: "유동비율",
  interestCoverage: "이자보상배율",
  operatingCashFlow: "영업현금흐름",
};

const isNum = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
const pct1 = (n: number) => `${(n * 100).toFixed(1)}%`;
const signed = (n: number, unit: string, digits = 1) => `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n).toFixed(digits)}${unit}`;

/** 큰 원화를 짧게: 1.2조 원 · 3,400억 원. */
export function formatKrwShort(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  if (a >= 1e12) return `${sign}${(a / 1e12).toFixed(1)}조 원`;
  if (a >= 1e8) return `${sign}${Math.round(a / 1e8).toLocaleString("ko-KR")}억 원`;
  return `${sign}${Math.round(a).toLocaleString("ko-KR")}원`;
}

/** 성장률처럼 부호가 뜻이 있는 지표 (나머지 비율은 부호 없이). */
const SIGNED_KEYS: FundamentalKey[] = ["revenueGrowth", "operatingIncomeGrowth"];

/** FundamentalsRow.value (unit 기준) → 화면 값. 없으면 "-". */
export function formatFundamentalValue(row: Pick<FundamentalsRow, "key" | "unit">, value: number | null | undefined): string {
  if (!isNum(value)) return "-";
  if (row.unit === "krw") return formatKrwShort(value);
  if (row.unit === "times") return `${value.toFixed(1)}배`;
  return SIGNED_KEYS.includes(row.key) ? signed(value * 100, "%") : pct1(value);
}

/** FundamentalsRow.change → 화면 값 (ratio는 %p, times는 배). 없으면 "-". */
export function formatFundamentalChange(row: Pick<FundamentalsRow, "unit" | "change">): string {
  if (!isNum(row.change)) return "-";
  if (row.unit === "ratio") return signed(row.change * 100, "%p");
  if (row.unit === "times") return signed(row.change, "배");
  return `${row.change > 0 ? "+" : ""}${formatKrwShort(row.change)}`;
}

/** 축의 지표가 먼저 오게 (판정·종합은 바꾸지 않는다 — 경고를 숨기지 않게 순서만). */
export function orderRows(rows: FundamentalsRow[], axes: readonly ThesisAxis[] | null | undefined): FundamentalsRow[] {
  if (!axes?.length) return rows;
  return [...rows.filter((r) => axes.includes(r.axis)), ...rows.filter((r) => !axes.includes(r.axis))];
}

/** 축별 한 줄: "성장: 기준 충족 1 · 주의 1". 판정한 지표가 없으면 "판정한 지표 없음". */
export function axisLine(rows: FundamentalsRow[], axis: ThesisAxis): string {
  const mine = rows.filter((r) => r.axis === axis);
  const order: CheckStatus[] = ["ok", "warn", "bad"];
  const parts = order.map((s) => [s, mine.filter((r) => r.status === s).length] as const).filter(([, n]) => n > 0);
  const body = parts.length ? parts.map(([s, n]) => `${CHECK_STATUS_TEXT[s].label} ${n}`).join(" · ") : "판정한 지표 없음";
  return `${THESIS_AXIS_TEXT[axis]}: ${body}`;
}

/** 종합 한 줄 (쉬운 보기, 중립 문장). */
export const OVERALL_LINE: Record<FundamentalsOverall, string> = {
  solid: "공시 숫자가 정해진 기준을 충족했어요",
  caution: "'주의'로 표시된 지표가 2개 이상이에요",
  review: "'확인 필요'로 표시된 지표가 있어요",
  na: "판정한 지표가 없어요",
};

/** 근거 종류 이름. */
export const EVIDENCE_KIND_TEXT: Record<DailyMoveEvidence["kind"], string> = {
  disclosure: "공시",
  flow: "수급",
  broker: "증권사 헤드라인",
  news: "뉴스 제목",
};

/** 근거 신뢰도 이름 (공시·수급은 사실 자료, 뉴스 제목은 신뢰 낮음). */
export const RELIABILITY_TEXT: Record<DailyMoveEvidence["reliability"], string> = {
  high: "사실 자료",
  medium: "참고",
  low: "신뢰 낮음",
};

/** "왜 샀나요?" 예시 (고르면 이유 칸에 들어간다. 사실을 적는 문장이고 권유가 아니다). */
export const THESIS_PRESETS: string[] = [
  "매출이 꾸준히 늘고 있어서",
  "본업에서 이익을 꾸준히 내고 있어서",
  "빚이 적고 재무가 안정적이어서",
  "회사의 제품·서비스를 잘 알아서",
  "배당을 꾸준히 주는 회사라서",
  "오래 두고 지켜보며 공부하고 싶어서",
];

export const THESIS_MAX_REASONS = 3;
export const THESIS_MAX_LEN = 100;

type JosaPair = "을/를" | "은/는" | "이/가" | "과/와";

/**
 * 받침에 맞는 조사 ("현대차" + 을/를 → "를", "셀트리온" → "을"). 마지막 글자가 한글이 아니면(AAPL·숫자) 두 형태를 다 적는다: "을(를)".
 * 기계적인 "현대차을(를)"이 화면에 보이지 않게 (주문 결과·산 이유 문장이 쓴다).
 */
export function josa(word: string, pair: JosaPair): string {
  const [withFinal, withoutFinal] = pair.split("/");
  const code = word.trim().charCodeAt(word.trim().length - 1);
  if (!(code >= 0xac00 && code <= 0xd7a3)) return `${withFinal}(${withoutFinal})`;
  return (code - 0xac00) % 28 === 0 ? withoutFinal : withFinal;
}
