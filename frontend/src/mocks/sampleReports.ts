// 가짜 API의 예시 리포트: 끝난 리포트(완성·실패)의 Shared State·Trace·본문. Agent가 아직 돌지 않아 쉬운 보기 화면을 확인할 자료다.
// options.sampleReports(브라우저 가짜 API 기본 켬) 또는 테스트의 db.addSampleReports()로만 들어간다 (기본 seed의 리포트 목록은 그대로).
// 문장은 출력 계약(docs/tasks/00-공통.md 10절)을 따른다: plainSummary는 숫자 없이 세 문장, 권유형 없이.
import type { ReportDetail, ReportOpinion, TraceEvent } from "../api/types";
import { sampleScreening } from "../lib/reportSamples";
import { basisDay, sessionEndIso } from "./clock";
import { floorTick, selectionPlan, type MockStock } from "./seed";

export type SampleKind = ReportOpinion | "failed";

export interface SampleTargets {
  entry: number;
  target: number;
  stop: number;
  holdingDays: number;
  probability: number;
}

const LLM: Record<string, [string, string]> = {
  market_agent: ["gemini", "gemini-3.5-flash"],
  fundamental_agent: ["openai", "gpt-4.1-mini"],
  news_agent: ["ollama", "llama3.2"],
  report_agent: ["anthropic", "claude-sonnet"],
  review_agent: ["openai", "gpt-4.1-mini"],
};

const plus = (iso: string, ms: number) => {
  const t = Date.parse(iso) + ms;
  return `${new Date(t + 9 * 3_600_000).toISOString().slice(0, 19)}+09:00`;
};

/**
 * 예시 리포트의 목표·손절 (buy만). 진입은 종가보다 1% 아래, 목표 +12%, 손절 −4% (호가 단위로 내림).
 * 목표 +12%는 비용·손절 미끄러짐을 넣은 손익비가 리스크 엔진 기준을 넘게 하려고다 (+10%면 NAVER가 약 1.86으로 늘 막혀,
 * 가짜 API로 '실행 준비' 정상 흐름을 볼 수 없었다). 막힌 경우는 테스트가 미리 보기를 바꿔 본다.
 */
export function sampleTargets(stock: MockStock): SampleTargets {
  const entry = floorTick(stock.close * 0.99, stock.currency);
  return {
    entry,
    target: floorTick(entry * 1.12, stock.currency),
    stop: floorTick(entry * 0.96, stock.currency),
    holdingDays: 10,
    probability: 0.56,
  };
}

/** requested 상태로 만든 리포트(r)를 끝난 예시로 바꾼다 (r을 고친다). */
export function finishSample(r: ReportDetail, stock: MockStock, kind: SampleKind): void {
  const start = r.createdAt;
  const trace: TraceEvent[] = [];
  const ev = (ms: number, actor: string, action: string, status: TraceEvent["status"], details: Record<string, unknown> = {}, latencyMs: number | null = null) => {
    const llm = actor in LLM && status !== "skipped" && action.startsWith("agent_") ? LLM[actor] : null;
    trace.push({
      step: trace.length + 1,
      actor,
      action,
      status,
      provider: llm?.[0] ?? null,
      model: llm?.[1] ?? null,
      latencyMs,
      details,
      at: plus(start, ms),
    });
  };
  const day = basisDay(stock.market);
  const changePct = Math.round((stock.close / stock.prevClose - 1) * 10_000) / 100;
  const market = {
    trend: changePct >= 0 ? "up" : "sideways",
    summary: `${stock.name}은 20일 이동평균선 위에서 거래대금이 늘고 있다 (장마감 기준).`,
    price: stock.close,
    changePct,
    asOf: sessionEndIso(stock.market, day),
    rsi: 58.4,
    volatilityPct: 2.1,
    volumeRank: 37,
    support: floorTick(stock.close * 0.95, stock.currency),
    resistance: floorTick(stock.close * 1.06, stock.currency),
    signals: ["20일선 위 유지", "거래대금 증가"],
    evidence: [`${day} 종가 ${stock.close}`, "20일 평균 거래대금 대비 1.4배"],
  };
  const fundamental = {
    summary: "최근 분기 매출과 영업이익이 함께 늘었고 특이 공시는 없다.",
    metrics: { per: 14.2, pbr: 1.3, roe: 9.8, revenueGrowthPct: 7.5, opMarginPct: 11.2 },
    recentFilings: [{ date: day, title: "분기보고서 (2026.06)", impact: "neutral" }],
    evidence: ["DART 반기보고서 매출 전년 대비 증가"],
  };
  const news = {
    sentiment: "neutral",
    score: 0.1,
    summary: "업황 관련 기사가 이어졌지만 방향이 엇갈린다.",
    headlines: [{ date: day, title: `${stock.name}, 신사업 투자 계획 발표`, source: "연합뉴스", impact: "neutral" }],
    evidence: ["뉴스 제목 3건"],
  };

  // 조사 (병렬) → Join → 작성 → 검토
  ev(0, "orchestrator", "workflow_started", "started");
  ev(200, "market_agent", "agent_started", "started");
  ev(210, "fundamental_agent", "agent_started", "started");
  ev(220, "news_agent", "agent_started", "started");
  ev(4200, "market_agent", "agent_completed", "completed", {}, 4000);
  ev(6100, "fundamental_agent", "agent_completed", "completed", {}, 5890);
  ev(7300, "news_agent", "agent_completed", "completed", {}, 7080);
  ev(7400, "join_guard", "join_completed", "completed", { step: "compose", required: ["market_agent", "fundamental_agent"], missing: [], inputs: ["market_agent", "fundamental_agent", "news_agent"] });
  ev(7500, "report_agent", "agent_started", "started");
  ev(19_500, "report_agent", "agent_completed", "completed", {}, 12_000);
  ev(19_600, "review_agent", "agent_started", "started");

  const research = { market_agent: market, fundamental_agent: fundamental, news_agent: news };
  r.state.completedAgents = ["market_agent", "fundamental_agent", "news_agent", "report_agent"];
  r.startedAt = plus(start, 0);
  r.costUsd = 0.21;

  if (kind === "failed") {
    ev(27_000, "review_agent", "agent_completed", "completed", { verdict: "FAIL" }, 7400);
    ev(27_100, "orchestrator", "workflow_failed", "failed", { reason: "review_failed", costUsd: 0.21, durationMs: 27_100 });
    Object.assign(r, { status: "failed", currentStep: "review", finishedAt: plus(start, 27_100), content: null });
    r.state = { ...r.state, status: "failed", currentStep: "review", results: research, completedAgents: [...r.state.completedAgents, "review_agent"] };
    r.trace = trace;
    return;
  }

  const t = kind === "buy" ? sampleTargets(stock) : null;
  const oneLiner =
    kind === "buy"
      ? `${stock.name}: 실적 개선과 수급이 이어져 오를 근거가 더 많다고 봤다.`
      : kind === "hold"
        ? `${stock.name}: 근거가 엇갈려 지금은 판단하기 이르다고 봤다.`
        : `${stock.name}: 실적 둔화와 업황 부담으로 위험이 더 크다고 봤다.`;
  const plainSummary =
    kind === "buy"
      ? ["최근 실적이 좋아지고 있어요.", "외국인과 기관이 꾸준히 사들이는 흐름이 보였어요.", "다만 업황이 바뀌면 가격이 크게 흔들릴 수 있어요."]
      : kind === "hold"
        ? ["좋은 소식과 걱정되는 소식이 함께 있어요.", "실적은 나쁘지 않지만 앞으로의 흐름이 아직 분명하지 않아요.", "조금 더 지켜본 뒤에 다시 판단하는 편이 낫다고 봤어요."]
        : ["실적이 줄어드는 흐름이 보였어요.", "업황에 대한 걱정이 아직 남아 있어요.", "가격이 더 내려갈 위험이 있다고 봤어요."];
  const reasons = ["반기 매출·영업이익이 전년보다 늘었다", "20일 이동평균선 위에서 거래대금이 늘었다", "외국인 순매수가 이어졌다"];
  // 마지막 위험은 프롬프트가 요구하는 "이 의견이 틀리는 경우" 한 줄 ("○○원 아래로 내려가거나 ○○이 나오면 의견을 다시 봐야 해요",
  // docs/tasks/02-worker.md T2-7). 긍정적은 손절 가격, 지켜보기는 지지선, 부정적은 저항선(오르면 틀린다) — 손절 가격은 긍정적에만 있다
  const won = (p: number) => (stock.currency === "USD" ? `$${p.toFixed(2)}` : `${p.toLocaleString("ko-KR")}원`);
  const whenWrong =
    kind === "buy" && t
      ? `${won(t.stop)} 아래로 내려가거나 다음 실적 발표가 기대보다 나쁘면 의견을 다시 봐야 해요`
      : kind === "hold"
        ? `${won(market.support)} 아래로 내려가거나 업황 지표가 바뀌면 의견을 다시 봐야 해요`
        : `${won(market.resistance)} 위로 올라가거나 실적이 다시 늘면 의견을 다시 봐야 해요`;
  const risks = ["업황 지표가 나빠지면 실적 기대가 줄 수 있다", "환율이 급하게 움직이면 수급이 바뀔 수 있다", whenWrong];
  const markdown = [
    `# ${stock.name} 종목 리포트`,
    "",
    `**AI 의견: ${kind === "buy" ? "긍정적" : kind === "hold" ? "지켜보기" : "부정적"}** — ${oneLiner}`,
    "",
    "## 가격 흐름 (장마감 기준)",
    market.summary,
    "",
    "## 재무·공시",
    fundamental.summary,
    "",
    "## 뉴스",
    news.summary,
    "",
    "## 근거",
    ...reasons.map((x) => `- ${x}`),
    "",
    "## 위험",
    ...risks.map((x) => `- ${x}`),
  ].join("\n");
  const draft = {
    title: `${stock.name} 종목 리포트`,
    verdict: kind,
    oneLiner,
    plainSummary,
    markdown,
    reasons,
    risks,
    targets: t
      ? { entry: t.entry, target: t.target, stop: t.stop, holdingDays: t.holdingDays, probability: t.probability }
      : { entry: null, target: null, stop: null, holdingDays: null, probability: null },
    confidence: kind === "buy" ? 68 : 55,
    citations: ["DART 반기보고서", "KRX 일봉", "연합뉴스"],
  };
  const review = { verdict: "PASS", score: 86, issues: [], instructions: null, handoff: null };
  ev(26_000, "review_agent", "agent_completed", "completed", { verdict: "PASS" }, 6400);
  ev(26_100, "orchestrator", "workflow_completed", "completed", { costUsd: 0.24, durationMs: 26_100 });
  Object.assign(r, {
    status: "completed",
    currentStep: null,
    finishedAt: plus(start, 26_100),
    content: markdown,
    costUsd: 0.24,
    hasPdf: true,
  });
  r.state = {
    ...r.state,
    status: "completed",
    currentStep: null,
    results: { ...research, report_agent: draft, review_agent: review },
    completedAgents: [...r.state.completedAgents, "review_agent"],
  };
  r.trace = trace;
}

const SELECTION_LLM: Record<string, [string, string]> = {
  news_screen_agent: ["devpass", "gemini-3.8-flash"],
  filing_screen_agent: ["devpass", "gemini-3.8-flash"],
  flow_agent: ["devpass", "gemini-3.8-flash"],
  selector_agent: ["devpass", "gpt-5.6-luna"],
  selection_review_agent: ["devpass", "claude-opus-5-5"],
};

/**
 * 끝난 예시 선정 실행 (team stock_selection, 자동): 후보 조사(뉴스·공시·수급) → Join → 종목 선정 → 선정 검토 PASS.
 * 결과는 오늘의 선별 예시(lib/reportSamples sampleScreening)와 같은 종목·순위다. 오늘의 선별의 'AI 선정 과정 보기'가 여기로 온다.
 */
export function selectionSample(id: number, createdAt: string): ReportDetail {
  const screening = sampleScreening();
  const candidates = screening.candidates ?? [];
  const aiPicks = screening.aiPicks ?? [];
  const nameOf = (symbol: string) => String(candidates.find((c) => c.symbol === symbol)?.name ?? symbol);
  const trace: TraceEvent[] = [];
  const ev = (ms: number, actor: string, action: string, status: TraceEvent["status"], details: Record<string, unknown> = {}, latencyMs: number | null = null) => {
    const llm = actor in SELECTION_LLM && action === "agent_completed" ? SELECTION_LLM[actor] : null;
    trace.push({ step: trace.length + 1, actor, action, status, provider: llm?.[0] ?? null, model: llm?.[1] ?? null, latencyMs, details, at: plus(createdAt, ms) });
  };
  const theme = (symbol: string) => (["005930", "000660", "042700"].includes(symbol) ? "반도체" : symbol === "005380" ? "자동차" : null);
  const news = {
    summary: "반도체 후보에 공급 확대 기사가 몰렸고, 2차전지 후보에는 엇갈린 기사가 있었다.",
    items: candidates.map((c) => ({
      symbol: c.symbol,
      sentiment: c.symbol === "086520" ? "negative" : "neutral",
      materials: [],
      concerns: [],
      theme: theme(String(c.symbol)),
      evidence: [],
    })),
  };
  const filing = {
    summary: "에코프로에 투자경고 관련 공시가 있었고 나머지 후보는 위험 신호가 없었다.",
    items: candidates.map((c) => ({ symbol: c.symbol, severity: c.symbol === "086520" ? "low" : "none", signals: [], evidence: [] })),
  };
  const flow = {
    summary: "외국인은 반도체 후보를, 기관은 자동차 후보를 순매수했다.",
    items: candidates.map((c) => ({ symbol: c.symbol, signal: c.symbol === "000660" ? "accumulating" : "mixed", note: null })),
  };
  const draft = { summary: "공급 확대 뉴스와 수급이 겹친 반도체·자동차 후보를 위에 두었다.", picks: aiPicks };
  const review = { verdict: "PASS", score: 82, issues: [], instructions: null, handoff: null };

  ev(0, "orchestrator", "workflow_started", "started", { chaos: false, source: "auto", team: "stock_selection" });
  for (const [i, actor] of ["news_screen_agent", "filing_screen_agent", "flow_agent"].entries()) ev(100 + i * 10, actor, "agent_started", "started", { attempt: 1, step: "candidate_research" });
  ev(9_200, "flow_agent", "agent_completed", "completed", { attempts: 1, recovered: false, costUsd: 0.004 }, 9_080);
  ev(14_300, "news_screen_agent", "agent_completed", "completed", { attempts: 1, recovered: false, costUsd: 0.011 }, 14_200);
  ev(16_900, "filing_screen_agent", "agent_completed", "completed", { attempts: 1, recovered: false, costUsd: 0.009 }, 16_780);
  ev(17_000, "join_guard", "join_completed", "completed", {
    step: "select",
    required: ["news_screen_agent", "filing_screen_agent"],
    missing: [],
    inputs: ["news_screen_agent", "filing_screen_agent", "flow_agent"],
  });
  ev(17_100, "selector_agent", "agent_started", "started", { attempt: 1, step: "select" });
  ev(29_400, "selector_agent", "agent_completed", "completed", { attempts: 1, recovered: false, costUsd: 0.031 }, 12_300);
  ev(29_500, "selection_review_agent", "agent_started", "started", { attempt: 1, step: "select_review" });
  ev(37_800, "selection_review_agent", "agent_completed", "completed", { attempts: 1, recovered: false, costUsd: 0.027, verdict: "PASS", score: 82 }, 8_300);
  ev(37_900, "orchestrator", "workflow_completed", "completed", { costUsd: 0.082, durationMs: 37_900 });

  const content = [
    "# 오늘의 매매 종목 선정",
    "",
    draft.summary,
    "",
    "| 순위 | 종목 | 고른 이유 |",
    "|---|---|---|",
    ...aiPicks.map((p) => `| ${p.rank} | ${nameOf(p.symbol)} (${p.symbol}) | ${p.reason} |`),
    "",
    "최종 종목은 안전장치(선정 Guard)를 거쳐 정해진다.",
  ].join("\n");
  const results = { news_screen_agent: news, filing_screen_agent: filing, flow_agent: flow, selector_agent: draft, selection_review_agent: review };
  return {
    id,
    team: "stock_selection",
    symbol: "KR",
    name: "오늘의 매매 종목 선정",
    market: "KR",
    status: "completed",
    currentStep: null,
    requestedBy: "자동",
    source: "auto",
    chaosEnabled: false,
    costUsd: 0.082,
    hasPdf: false,
    canDelete: false,
    opinion: null,
    oneLiner: null,
    createdAt,
    startedAt: createdAt,
    finishedAt: plus(createdAt, 37_900),
    content,
    chaos: null,
    recovery: { failures: 0, recovered: 0, unrecovered: 0, injected: 0, recoveryMs: null, models: {} },
    state: {
      taskId: `report-${id}`,
      status: "completed",
      currentStep: null,
      results,
      errors: {},
      completedAgents: Object.keys(results),
      failedAgents: [],
    },
    trace,
    plan: selectionPlan(),
  };
}
