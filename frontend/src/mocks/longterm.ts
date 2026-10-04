// 가짜 API의 장기투자 자료: 펀더멘털 지표와 판정(docs/API.md "지표와 판정" 표), 오늘의 내 종목 뉴스.
// 판정 규칙은 서버 엔진 judge/fundamentals_check.py와 같게 둔다 (bad > warn > ok, 기준선이 없으면 절대 기준만).
import type {
  Candle,
  CheckStatus,
  DailyMove,
  DailyMoveEvidence,
  FundamentalKey,
  FundamentalsOverall,
  FundamentalsRow,
  ThesisAxis,
} from "../api/types";
import { sessionEndIso } from "./clock";
import { type MockStock, seededRandom } from "./seed";

export const FUNDAMENTALS_SOURCE = "금융감독원 OpenDART";
export const FUNDAMENTALS_CAPTION = "공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다";

/** 지표 정의 (표 순서). */
export const FUNDAMENTAL_DEFS: { key: FundamentalKey; label: string; axis: ThesisAxis; unit: FundamentalsRow["unit"] }[] = [
  { key: "revenueGrowth", label: "매출 성장", axis: "growth", unit: "ratio" },
  { key: "operatingIncomeGrowth", label: "영업이익 성장", axis: "growth", unit: "ratio" },
  { key: "operatingMargin", label: "영업이익률(TTM)", axis: "profitability", unit: "ratio" },
  { key: "roe", label: "ROE(TTM)", axis: "profitability", unit: "ratio" },
  { key: "debtRatio", label: "부채비율", axis: "balance_sheet", unit: "ratio" },
  { key: "currentRatio", label: "유동비율", axis: "balance_sheet", unit: "ratio" },
  { key: "interestCoverage", label: "이자보상배율(근사)", axis: "balance_sheet", unit: "times" },
  { key: "operatingCashFlow", label: "영업현금흐름", axis: "profitability", unit: "krw" },
  { key: "earningsQuality", label: "이익의 질", axis: "profitability", unit: "times" },
];

/** 한 보고서의 값 (FundamentalsRow.value와 같은 unit) + 판정에만 쓰는 값. */
export interface Metrics {
  period: string;
  receivedAt: string;
  values: Record<FundamentalKey, number | null>;
  netIncomeSamePeriod: number; // 영업현금흐름 판정용 (같은 누적 기간 순이익)
  nonOperatingShare: number | null; // 이익의 질 판정용 (영업외 손익 ÷ 세전이익)
  deficitTurn: boolean; // 영업이익 적자 전환
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;

/** 종목의 최근 보고서 지표 (같은 종목이면 늘 같은 값). 펀더멘털 점검을 적용하지 않는 종목이면 null. */
export function metricsOf(stock: MockStock): Metrics | null {
  if (stock.fundamentalsNa) return null;
  const r = seededRandom(`${stock.symbol}-fundamentals`);
  const between = (lo: number, hi: number) => lo + (hi - lo) * r();
  const netIncome = Math.round(between(2e11, 6e12) / 1e8) * 1e8;
  const values: Record<FundamentalKey, number | null> = {
    revenueGrowth: round(between(-0.06, 0.22)),
    operatingIncomeGrowth: round(between(-0.15, 0.35)),
    operatingMargin: round(between(0.04, 0.22)),
    roe: round(between(0.03, 0.17)),
    debtRatio: round(between(0.25, 1.2)),
    currentRatio: round(between(0.9, 2.6), 2),
    interestCoverage: round(between(2.2, 28), 1),
    operatingCashFlow: Math.round((netIncome * between(0.7, 1.6)) / 1e8) * 1e8,
    earningsQuality: round(between(0.65, 1.15), 2),
  };
  const m: Metrics = {
    period: "2026 반기보고서",
    receivedAt: "2026-08-14",
    values,
    netIncomeSamePeriod: netIncome,
    nonOperatingShare: round(between(-0.2, 0.4), 2),
    deficitTurn: false,
  };
  // 판정이 골고루 보이게 몇 종목은 정해 둔다
  if (stock.symbol === "086520") {
    // 에코프로: 영업 적자 → 영업이익률 음수(확인 필요), 적자 전환
    Object.assign(values, { operatingMargin: -0.042, operatingIncomeGrowth: null, roe: -0.018, interestCoverage: 0.6 });
    m.deficitTurn = true;
  }
  if (stock.symbol === "247540") {
    // 에코프로비엠: 매출 감소(주의·확인 필요), 영업외 손익 비중이 큼
    Object.assign(values, { revenueGrowth: -0.142, operatingIncomeGrowth: -0.12, currentRatio: 0.92 });
    m.nonOperatingShare = 0.62;
  }
  return m;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pp = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)}%p`;

/** 한 행 판정. baseline이 없으면 절대 기준 부분만 본다. */
function judgeRow(key: FundamentalKey, m: Metrics, baseline: number | null): Pick<FundamentalsRow, "status" | "note" | "change"> {
  const v = m.values[key];
  const change = v !== null && baseline !== null ? round(v - baseline) : null;
  const need = { status: "na" as CheckStatus, note: "기준선이 있어야 판정해요", change };
  switch (key) {
    case "revenueGrowth":
      if (v === null) return { status: "na", note: "자료 없음", change };
      return { status: v < -0.1 ? "bad" : v < 0 ? "warn" : "ok", note: null, change };
    case "operatingIncomeGrowth":
      if (m.deficitTurn) return { status: "bad", note: "적자 전환", change };
      if (v === null) return { status: "na", note: "자료 없음", change };
      return { status: v < -0.2 ? "bad" : v < 0 ? "warn" : "ok", note: null, change };
    case "operatingMargin":
      if (v === null) return { status: "na", note: "자료 없음", change };
      if (v < 0) return { status: "bad", note: "영업이익률이 음수", change };
      if (change === null) return need;
      return { status: change < -0.03 ? "bad" : change < -0.01 ? "warn" : "ok", note: `기준선 대비 ${pp(change)}`, change };
    case "roe":
      if (v === null) return { status: "na", note: "자료 없음", change };
      if (v <= 0) return { status: "bad", note: "ROE가 0 이하 (근사: 순이익(TTM) ÷ 기말 자본)", change };
      if (change === null) return need;
      return { status: change < -0.02 ? "warn" : "ok", note: `기준선 대비 ${pp(change)} (근사: 기말 자본)`, change };
    case "debtRatio":
      if (v === null) return { status: "na", note: "자료 없음", change };
      if (change === null) return need;
      return { status: change > 0.5 ? "bad" : change > 0.2 ? "warn" : "ok", note: `기준선 대비 ${pp(change)}`, change };
    case "currentRatio":
      if (v === null) return { status: "na", note: "자료 없음", change };
      return { status: v < 0.8 ? "bad" : v < 1 ? "warn" : "ok", note: null, change };
    case "interestCoverage":
      if (v === null) return { status: "na", note: "금융비용이 없어 계산하지 않아요", change };
      return { status: v < 1 ? "bad" : v < 3 ? "warn" : "ok", note: "근사: 영업이익 ÷ 금융비용 (같은 누적 기간)", change };
    case "operatingCashFlow": {
      if (v === null) return { status: "na", note: "자료 없음", change };
      const profit = m.netIncomeSamePeriod > 0;
      const cash = v > 0;
      if (profit && cash) return { status: "ok", note: null, change };
      if (!profit && !cash) return { status: "bad", note: "순이익 적자이고 영업현금흐름도 마이너스", change };
      return { status: "warn", note: profit ? "순이익은 흑자인데 영업현금흐름이 마이너스" : "순이익은 적자인데 영업현금흐름은 플러스", change };
    }
    case "earningsQuality": {
      const share = m.nonOperatingShare;
      if (share === null) return { status: "na", note: "자료 없음", change };
      return { status: Math.abs(share) >= 0.5 ? "warn" : "ok", note: `판정: 영업외 손익이 세전이익의 ${pct(share)}`, change };
    }
  }
}

/** 9개 행. baseline이 null이면 FundamentalsView처럼 baseline·change를 늘 null로 둔다.
 * 기준선을 쓰는 지표(operatingMargin·roe·debtRatio)만 baseline·change를 채운다 (나머지 여섯은 산 이유가 있어도 null, docs/API.md FundamentalsRow). */
export function judgeRows(m: Metrics, baseline: Partial<Record<FundamentalKey, number | null>> | null): FundamentalsRow[] {
  return FUNDAMENTAL_DEFS.map((d) => {
    const base = baseline?.[d.key] ?? null;
    const usesBaseline = d.key === "operatingMargin" || d.key === "roe" || d.key === "debtRatio";
    const j = judgeRow(d.key, m, usesBaseline ? base : null);
    return {
      key: d.key,
      label: d.label,
      axis: d.axis,
      value: m.values[d.key],
      unit: d.unit,
      baseline: baseline && usesBaseline ? base : null,
      change: baseline && usesBaseline ? j.change : null,
      status: j.status,
      note: j.note,
    };
  });
}

/** 종합: bad 하나라도 → review, warn 둘 이상 → caution, 나머지 solid. 판정한 행이 없으면 na. */
export function overallOf(rows: FundamentalsRow[]): FundamentalsOverall {
  const judged = rows.filter((r) => r.status !== "na");
  if (!judged.length) return "na";
  if (judged.some((r) => r.status === "bad")) return "review";
  if (judged.filter((r) => r.status === "warn").length >= 2) return "caution";
  return "solid";
}

// ---------------------------------------------------------------- 오늘의 내 종목 뉴스

const PROXY = {
  KOSPI: { symbol: "069500", name: "KODEX 200" },
  KOSDAQ: { symbol: "229200", name: "KODEX 코스닥150" },
} as const;

function stdev(xs: number[]): number | null {
  if (xs.length < 2) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1));
}

/** DailyMove.flows 키와 화면 이름 (서버 daily_move.INVESTORS 순서). */
const FLOW_LABELS = [
  ["foreign", "외국인"],
  ["institution", "기관"],
  ["individual", "개인"],
] as const;

const signedPct = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n * 100).toFixed(1)}%`;

/**
 * 종목 하나의 하루 기록 (결정론). bars는 그 날짜까지의 완성 일봉 (과거 → 최신, 마지막이 그 날짜).
 * 문장은 원인을 단정하지 않는다 — 금지 표현(때문에·덕분에·영향으로·오를 것 등)을 쓰지 않는다.
 */
export function dailyMoveOf(stock: MockStock, bars: Candle[], quoteProvider: string): DailyMove | null {
  if (stock.market !== "KR" || bars.length < 2) return null;
  const today = bars[bars.length - 1];
  const prev = bars[bars.length - 2];
  const day = today.date;
  const r = seededRandom(`${stock.symbol}-${day}-move`);
  const changeRate = today.close / prev.close - 1;
  const proxy = PROXY[stock.exchange === "KOSDAQ" ? "KOSDAQ" : "KOSPI"];
  const marketRate = round((r() - 0.45) * 0.02);
  const excess = round(changeRate - marketRate);
  const rets = bars.slice(-21).map((b, i, a) => (i === 0 ? null : b.close / a[i - 1].close - 1)).filter((x): x is number => x !== null);
  const volatility20 = rets.length >= 20 ? round(stdev(rets) ?? 0) : null;
  const flows = { foreign: round((r() - 0.45) * 0.08), institution: round((r() - 0.5) * 0.06), individual: 0 };
  flows.individual = round(-(flows.foreign + flows.institution));

  const evidence: DailyMoveEvidence[] = [];
  const add = (e: Omit<DailyMoveEvidence, "id">) => evidence.push({ id: `E${evidence.length + 1}`, ...e });
  const hasDisclosure = r() < 0.35;
  if (hasDisclosure) {
    add({
      kind: "disclosure",
      text: `${stock.name} 단일판매·공급계약 체결`,
      source: FUNDAMENTALS_SOURCE,
      at: null,
      url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${day.replaceAll("-", "")}000${Math.floor(r() * 900 + 100)}`,
      reliability: "high",
    });
  }
  // 수급 근거는 서버(paper_engine.longterm.daily_move.build_evidence)처럼 외국인 → 기관 → 개인 셋 (공시 다음, 헤드라인 앞)
  for (const [key, label] of FLOW_LABELS) {
    const value = flows[key];
    add({
      kind: "flow",
      text: `${label} 순${value >= 0 ? "매수" : "매도"} = 거래량의 ${(Math.abs(value) * 100).toFixed(1)}%`,
      source: quoteProvider,
      at: null,
      url: null,
      reliability: "high",
    });
  }
  const hasBroker = r() < 0.4;
  if (hasBroker) {
    add({
      kind: "broker",
      text: `"${stock.name} 목표주가 상향" 증권사 리포트`,
      source: "한국경제",
      at: `${day}T08:10:00+09:00`,
      url: null,
      reliability: "medium",
    });
  }
  add({
    kind: "news",
    text: `${stock.name}, 업황 지표 발표 앞두고 거래 늘어`,
    source: "연합뉴스",
    at: `${day}T11:42:00+09:00`,
    url: null,
    reliability: "low",
  });

  // LLM 생략 규칙 (서버 should_skip과 같다): 20일 변동성을 구하지 못했으면 판단할 수 없으므로 생략하지 않는다
  const quiet = volatility20 !== null && Math.abs(excess) < 0.01 && Math.abs(excess) < volatility20 && !hasDisclosure && !hasBroker;
  const flowId = evidence.find((e) => e.kind === "flow")!.id; // 외국인
  const strong = evidence.filter((e) => e.kind === "disclosure" || e.kind === "broker");
  const base = {
    symbol: stock.symbol,
    name: stock.name,
    market: "KR" as const,
    date: day,
    asOf: sessionEndIso("KR", day),
    close: today.close,
    prevClose: prev.close,
    changeRate: round(changeRate),
    marketProxy: { ...proxy, changeRate: marketRate },
    excessChangeRate: excess,
    sectorChangeRate: null,
    volatility20,
    flows,
    evidence,
    missing: ["업종: 업종 자료 없음"],
    createdAt: `${day}T16:3${Math.floor(r() * 10)}:00+09:00`,
  };
  if (quiet) {
    return {
      ...base,
      headline: "오늘은 시장과 비슷하게 움직였어요",
      summary: [`${stock.name} ${signedPct(changeRate)}, ${proxy.name} ${signedPct(marketRate)}로 차이가 1%p 안쪽이었어요.`],
      drivers: [],
      uncertain: false,
      method: "template",
    };
  }
  const summary = [
    `${proxy.name}가 ${signedPct(marketRate)} 움직인 날, ${stock.name}은 ${signedPct(changeRate)}였어요 (시장 대비 ${signedPct(excess).replace("%", "%p")}).`,
    `같은 날 외국인은 거래량의 ${(Math.abs(flows.foreign) * 100).toFixed(1)}%만큼 순${flows.foreign >= 0 ? "매수" : "매도"}했어요.`,
  ];
  if (strong.length) summary.push(`같은 날 ${strong.map((e) => (e.kind === "disclosure" ? "공시" : "증권사 목표가 헤드라인")).join("와 ")}가 있었어요.`);
  return {
    ...base,
    headline: `${stock.name} ${signedPct(changeRate)} · 시장 대비 ${signedPct(excess).replace("%", "%p")}`,
    summary,
    drivers: [flowId, ...strong.map((e) => e.id)],
    uncertain: strong.length === 0,
    method: "llm",
  };
}
