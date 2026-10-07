// 가짜 API의 초기 데이터: 종목, 팀원 계정, AI 분석 기록, AI 리포트 실행 계획.
import type { AnalysisDetail, Currency, ExecutionPlan, Market, Scenario, Verdict } from "../api/types";
import { basisDay, kstIso } from "./clock";

/**
 * 가짜 종목. 가격은 둘로 나눈다 (docs/API.md 공통 규칙 "실시간 시세"·"장마감 기준"):
 * close·prevClose는 계좌 평가·미리 보기 등 장마감 기준 화면의 직전 장마감 종가와 그 전 종가,
 * price는 실시간 시세(Quote·StockDetail)의 현재가이자 모의 체결·청산 판단에 쓰는 장중 가격.
 * 처음에는 price = close이고, setPrice(테스트)·지터(개발 화면)는 price만 움직인다.
 */
export interface MockStock {
  symbol: string;
  name: string;
  exchange: string;
  market: Market;
  currency: Currency;
  price: number;
  close: number;
  prevClose: number;
  warnings: string[];
  /** 금융업·ETF 등 일반 기업용 펀더멘털 점검을 적용하지 않는 종목의 이유 (없으면 적용). */
  fundamentalsNa?: string;
}

export interface MockUser {
  id: number;
  username: string;
  password: string;
  nickname: string;
  isPublic: boolean;
  isStaff: boolean;
}

const kr = (symbol: string, name: string, exchange: string, close: number, prevClose: number, warnings: string[] = []): MockStock => ({
  symbol,
  name,
  exchange,
  market: "KR",
  currency: "KRW",
  price: close,
  close,
  prevClose,
  warnings,
});
const us = (symbol: string, name: string, exchange: string, close: number, prevClose: number): MockStock => ({
  symbol,
  name,
  exchange,
  market: "US",
  currency: "USD",
  price: close,
  close,
  prevClose,
  warnings: [],
  fundamentalsNa: "미국 종목은 펀더멘털 점검을 적용하지 않아요",
});

export function seedStocks(): MockStock[] {
  return [
    kr("005930", "삼성전자", "KOSPI", 71_200, 70_500),
    kr("000660", "SK하이닉스", "KOSPI", 182_300, 178_000),
    kr("373220", "LG에너지솔루션", "KOSPI", 398_500, 402_000),
    kr("005380", "현대차", "KOSPI", 248_000, 245_500),
    kr("035420", "NAVER", "KOSPI", 191_200, 193_000),
    kr("035720", "카카오", "KOSPI", 45_150, 44_800),
    kr("068270", "셀트리온", "KOSPI", 186_400, 184_900),
    { ...kr("105560", "KB금융", "KOSPI", 84_300, 83_100), fundamentalsNa: "금융업은 일반 기업용 점검을 적용하지 않아요" },
    kr("247540", "에코프로비엠", "KOSDAQ", 201_500, 196_000),
    kr("086520", "에코프로", "KOSDAQ", 98_700, 101_200),
    kr("196170", "알테오젠", "KOSDAQ", 352_000, 340_500, ["투자주의 종목입니다 (소수 계좌 거래 집중)."]),
    us("AAPL", "Apple", "NASDAQ", 231.45, 229.8),
    us("NVDA", "NVIDIA", "NASDAQ", 121.37, 124.02),
    us("TSLA", "Tesla", "NASDAQ", 252.1, 247.65),
    us("MSFT", "Microsoft", "NASDAQ", 428.9, 426.1),
    us("KO", "Coca-Cola", "NYSE", 69.85, 70.1),
  ];
}

export function seedUsers(): MockUser[] {
  return [
    { id: 1, username: "alice", password: "alice1234", nickname: "앨리스", isPublic: true, isStaff: true },
    { id: 2, username: "bob", password: "bob1234", nickname: "밥", isPublic: true, isStaff: false },
    { id: 3, username: "carol", password: "carol1234", nickname: "캐롤", isPublic: false, isStaff: false },
    { id: 4, username: "dave", password: "dave1234", nickname: "데이브", isPublic: true, isStaff: false },
    { id: 5, username: "erin", password: "erin1234", nickname: "에린", isPublic: true, isStaff: false },
  ];
}

/** 다른 팀원의 수익률 (랭킹용, 보유 없이 현금으로만 흉내 낸다). */
export const OTHER_RATES: Record<number, number> = { 2: 0.0412, 3: 0.065, 4: -0.0235, 5: 0.0108 };

/** 호가 단위 (국내는 가격대별 단위, 미국은 센트). */
export function tickOf(price: number, currency: Currency): number {
  if (currency === "USD") return 0.01;
  return price < 2_000 ? 1 : price < 5_000 ? 5 : price < 20_000 ? 10 : price < 50_000 ? 50 : price < 200_000 ? 100 : price < 500_000 ? 500 : 1_000;
}

/** 호가 단위로 반올림. */
export function roundTick(price: number, currency: Currency): number {
  if (currency === "USD") return Math.round(price * 100) / 100;
  const tick = tickOf(price, currency);
  return Math.round(price / tick) * tick;
}

/** 호가 단위로 내림 (예시 리포트의 목표·손절 가격을 맞출 때). */
export function floorTick(price: number, currency: Currency): number {
  if (currency === "USD") return Math.floor(price * 100 + 1e-9) / 100;
  const tick = tickOf(price, currency);
  return Math.floor(price / tick + 1e-9) * tick;
}

/** 종목 코드로 정해지는 의사 난수 (같은 종목이면 같은 일봉). */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

const MODELS = ["claude", "gpt", "gemini"];

function scenario(stock: MockStock, price: number, i: number, ok: boolean, selected: boolean): Scenario {
  const r = seededRandom(`${stock.symbol}-${i}-${price}`);
  const up = 0.06 + r() * 0.06;
  const down = 0.03 + r() * 0.02;
  const entry = roundTick(price * (1 - r() * 0.01), stock.currency);
  const score = ok ? Math.round(68 + r() * 20) : Math.round(35 + r() * 20);
  return {
    proposer: MODELS[i % MODELS.length],
    selected,
    passed: ok,
    score,
    probability: Math.round((ok ? 0.52 + r() * 0.12 : 0.3 + r() * 0.12) * 100) / 100,
    entryPrice: entry,
    targetPrice: roundTick(entry * (1 + up), stock.currency),
    stopPrice: roundTick(entry * (1 - down), stock.currency),
    holdingDays: [5, 7, 10, 14][i % 4],
    rationale: ok
      ? [`20일 이동평균선 위에서 거래대금이 늘며 지지를 확인`, `${stock.name} 관련 업황 개선 기사가 이어짐`, "직전 고점까지 상승 여력이 남아 있음"]
      : ["단기 과열 구간이라 눌림을 기다리는 편이 낫다", "거래대금이 줄며 상승 탄력이 약해짐"],
    invalidation: `종가 기준 ${stock.currency === "USD" ? "$" : ""}${roundTick(entry * (1 - down), stock.currency)} 이탈`,
    rejectReasons: ok ? [] : ["교차검증 점수 미달 (기준 60점)", "손익비 부족"],
  };
}

/** 분석 기록 하나를 만든다. verdict가 BUY면 승인된 시나리오가 하나 있다. */
export function makeAnalysis(
  id: number,
  stock: MockStock,
  verdict: Verdict,
  analyzedAt: string,
  requestedBy: string | null,
  scenarioCount = 3,
): AnalysisDetail {
  const price = stock.price; // 분석 시각의 가격 (장마감 기준이 아니다)
  const news = [
    `${stock.name}, 외국인 5거래일 연속 순매수`,
    `증권가 "${stock.name} 목표주가 상향" 잇따라`,
    `${stock.exchange} 업종 전반 반등 기대감`,
  ];
  const sources = ["연합뉴스", "한국경제", "머니투데이"];
  const at = Date.parse(analyzedAt);
  const scenarios = Array.from({ length: scenarioCount }, (_, i) =>
    scenario(stock, price, i, verdict === "BUY" ? i !== 2 : false, verdict === "BUY" && i === 0),
  );
  const selected = scenarios.filter((s) => s.selected);
  const pool = selected.length ? selected : scenarios;
  const best = pool.length ? pool.reduce((a, b) => ((b.score ?? 0) > (a.score ?? 0) ? b : a)) : null;
  const r = seededRandom(`${stock.symbol}-ind-${id}`);
  return {
    id,
    symbol: stock.symbol,
    name: stock.name,
    market: stock.market,
    currency: stock.currency,
    analyzedAt,
    verdict,
    priceAtAnalysis: price,
    best,
    scenarioCount: scenarios.length,
    requestedBy,
    costUsd: scenarioCount ? 0.31 : 0.12,
    scenarios,
    news,
    newsItems: news.map((title, i) => ({
      title,
      source: sources[i],
      publishedAt: Number.isNaN(at) ? null : kstIso(new Date(at - (i + 1) * 5 * 3_600_000)),
    })),
    newsProvider: "Google 뉴스 검색 결과",
    dataAsOf: Number.isNaN(at) ? null : basisDay(stock.market, new Date(at)),
    research: [
      {
        researcher: "claude",
        findings: [
          {
            claim: `${stock.name}의 다음 분기 실적 전망치가 한 달 사이 4% 올랐다`,
            direction: "positive",
            date: analyzedAt.slice(0, 10),
            sourceTitle: "실적 컨센서스 동향",
          },
          { claim: "업종 재고 부담이 아직 남아 있다", direction: "negative", date: null, sourceTitle: "업종 리포트" },
        ],
      },
      {
        researcher: "gpt",
        findings: [{ claim: "최근 공시에 특이 사항 없음", direction: null, date: null, sourceTitle: "DART" }],
      },
    ],
    indicators: {
      rsi14: Math.round((40 + r() * 30) * 10) / 10,
      ma20: roundTick(price * (0.97 + r() * 0.04), stock.currency),
      ma60: roundTick(price * (0.92 + r() * 0.08), stock.currency),
      atr14: roundTick(price * (0.02 + r() * 0.01), stock.currency),
      volumeRatio: Math.round((0.8 + r() * 1.2) * 100) / 100,
      trend: verdict === "BUY" ? "상승" : "횡보",
      // 실제 엔진 스냅샷의 지표 키 (engine/paper_engine/data/snapshot.py — docs/API.md "엔진 스냅샷의 지표 그대로"). 쉬운 보기는 이 키를 읽는다.
      // 비율(변동성·등락률)은 소수다. 위의 키는 예전 가짜 데이터라 그대로 둔다 (테스트 기본값)
      sma20: roundTick(price * (0.97 + r() * 0.04), stock.currency),
      sma60: roundTick(price * (0.92 + r() * 0.08), stock.currency),
      sma120: roundTick(price * (0.88 + r() * 0.12), stock.currency),
      volatility20: Math.round((0.18 + r() * 0.25) * 10_000) / 10_000,
      change5d: Math.round((r() * 0.08 - 0.03) * 10_000) / 10_000,
      change20d: Math.round((r() * 0.16 - 0.06) * 10_000) / 10_000,
      change60d: Math.round((r() * 0.3 - 0.1) * 10_000) / 10_000,
      periodHigh: roundTick(price * (1.05 + r() * 0.15), stock.currency),
      periodLow: roundTick(price * (0.7 + r() * 0.15), stock.currency),
    },
    errors: scenarioCount ? [] : ["제안 모델이 조건에 맞는 시나리오를 내지 않았습니다."],
  };
}

const planWorker = (id: string, title: string, goal: string, outputContract: string) => ({
  id,
  title,
  goal,
  provider: null,
  model: null,
  fallbacks: [],
  outputContract,
});

/** AI 리포트 실행 계획. 서버의 YAML Registry(backend/reports/*_definitions.yaml)와 같은 내용으로 맞춰 둔다. */
export function reportPlan(): ExecutionPlan {
  const worker = planWorker;
  return {
    team: "stock_report",
    title: "종목 리포트",
    failurePolicy: "required_optional",
    steps: [
      {
        id: "parallel_research",
        title: "조사",
        mode: "parallel",
        workers: ["market_agent", "fundamental_agent", "news_agent"],
        required: ["market_agent", "fundamental_agent"],
        optional: ["news_agent"],
        dependsOn: [],
        join: false,
        timeoutSec: 60,
        retry: null,
      },
      {
        id: "compose",
        title: "리포트 작성",
        mode: "sequential",
        workers: ["report_agent"],
        required: ["report_agent"],
        optional: [],
        dependsOn: ["parallel_research"],
        join: true,
        timeoutSec: 90,
        retry: null,
      },
      {
        id: "review",
        title: "검토",
        mode: "sequential",
        workers: ["review_agent"],
        required: ["review_agent"],
        optional: [],
        dependsOn: ["compose"],
        join: false,
        timeoutSec: 60,
        retry: { target: "report_agent", maxRounds: 2 },
      },
    ],
    workers: [
      worker("market_agent", "시세·차트 Agent", "최근 시세와 일봉 차트로 추세·변동성·거래량을 정리한다", "MarketResult"),
      worker("fundamental_agent", "재무·공시 Agent", "재무제표와 최근 공시에서 실적과 주요 사건을 정리한다", "FundamentalResult"),
      worker("news_agent", "뉴스·심리 Agent", "최근 뉴스와 시장 분위기에서 호재·악재와 심리를 정리한다", "NewsResult"),
      worker("report_agent", "리포트 작성 Agent", "조사 결과를 모아 종목 리포트 초안을 Markdown으로 쓴다", "ReportDraft"),
      worker("review_agent", "검토 Agent", "리포트 초안이 조사 결과와 맞는지, 근거 없는 주장이 없는지 검토한다", "ReviewResult"),
      worker("risk_agent", "리스크 점검 Agent", "투자 유의 지정이나 고위험 신호를 점검해 리포트에 경고를 붙인다", "RiskResult"),
    ],
    handoffs: [
      {
        from: "review_agent",
        to: "risk_agent",
        responsibility: "투자 유의 종목이거나 고위험 신호가 있으면 리스크 점검 책임을 넘긴다",
        maxHops: 1,
      },
    ],
    implemented: false,
  };
}

/** 매매 종목 선정 팀 실행 계획 (YAML의 stock_selection). 하루 한 번 자동으로 돌고 Handoff는 없다. implemented는 reportPlan과 같게 둔다. */
export function selectionPlan(): ExecutionPlan {
  const worker = planWorker;
  return {
    team: "stock_selection",
    title: "매매 종목 선정",
    failurePolicy: "required_optional",
    steps: [
      {
        id: "candidate_research",
        title: "후보 조사",
        mode: "parallel",
        workers: ["news_screen_agent", "filing_screen_agent", "flow_agent"],
        required: ["news_screen_agent", "filing_screen_agent"],
        optional: ["flow_agent"],
        dependsOn: [],
        join: false,
        timeoutSec: 180,
        retry: null,
      },
      {
        id: "select",
        title: "종목 선정",
        mode: "sequential",
        workers: ["selector_agent"],
        required: ["selector_agent"],
        optional: [],
        dependsOn: ["candidate_research"],
        join: true,
        timeoutSec: 180,
        retry: null,
      },
      {
        id: "select_review",
        title: "선정 검토",
        mode: "sequential",
        workers: ["selection_review_agent"],
        required: ["selection_review_agent"],
        optional: [],
        dependsOn: ["select"],
        join: false,
        timeoutSec: 180,
        retry: { target: "selector_agent", maxRounds: 2 },
      },
    ],
    workers: [
      worker("news_screen_agent", "후보 뉴스 점검 Agent", "후보 종목마다 최근 뉴스에서 재료와 악재를 찾아 출처와 함께 정리하고 테마 이름을 붙인다", "CandidateNewsResult"),
      worker("filing_screen_agent", "후보 공시 점검 Agent", "후보 종목마다 최근 30일 공시에서 위험 신호를 찾아 위험 정도(none·low·high)를 매긴다", "FilingCheckResult"),
      worker("flow_agent", "수급 해석 Agent", "코드가 합한 외국인·기관 순매수로 후보마다 매집·이탈을 해석한다", "FlowResult"),
      worker("selector_agent", "종목 선정 Agent", "후보 표와 조사 결과를 보고 스윙 매매로 살펴볼 종목 5개의 순위와 근거를 낸다 (가격은 내지 않는다)", "SelectionDraft"),
      worker("selection_review_agent", "선정 검토 Agent", "선정안의 근거가 조사 결과와 맞는지, 후보 밖 종목이나 근거 없는 주장이 없는지 검토한다", "ReviewResult"),
    ],
    handoffs: [],
    implemented: false,
  };
}
