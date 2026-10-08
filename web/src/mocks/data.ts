// 가짜 자료: 정상과 문제 상태가 섞인 현실적인 값 (API.md 2장 형식).
// 시각은 모두 "지금"에서 거꾸로 센다. 그래서 몇 초 전·몇 분 전 표시가 늘 그럴듯하다.
import type {
  Alerts,
  CostDay,
  Costs,
  DeployRecord,
  Deploys,
  EngineStatus,
  HealthCheck,
  Overview,
  RecoveryStats,
  ReportRow,
  ReportTrace,
  ServiceStatus,
  TraceItem,
  TraceKind,
} from "../api";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const KST_OFFSET = 9 * HOUR;

/** 오늘(KST)을 포함한 최근 days일: 첫날 0시(KST)의 ms와 첫날·오늘 날짜 (서버 day_window와 같다) */
export function dayWindow(days: number, now = Date.now()): { since: number; from: string; to: string } {
  const todayStart = Math.floor((now + KST_OFFSET) / DAY) * DAY - KST_OFFSET;
  const since = todayStart - (days - 1) * DAY;
  const date = (ms: number) => new Date(ms + KST_OFFSET).toISOString().slice(0, 10);
  return { since, from: date(since), to: date(todayStart) };
}

export const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

/** KST 날짜(YYYY-MM-DD) */
export function kstDate(t: number): string {
  return new Date(t + 9 * HOUR).toISOString().slice(0, 10);
}

// --- 서비스 ---------------------------------------------------------------

export function service(): ServiceStatus {
  const recent: HealthCheck[] = Array.from({ length: 60 }, (_, i) => {
    const failing = i === 17 || i === 18; // 9분쯤 전 두 번 실패
    return {
      at: ago((i + 1) * 30_000),
      api: failing
        ? { ok: false, status: null, ms: null, error: "timeout" }
        : { ok: true, status: 200, ms: 90 + ((i * 37) % 160), error: null },
      page: failing
        ? { ok: false, status: 502, ms: 410, error: "HTTP 502" }
        : { ok: true, status: 200, ms: 40 + ((i * 53) % 90), error: null },
    };
  });
  return {
    url: "https://moemaemae.example.com",
    intervalSec: 30,
    level: "warn",
    latest: recent[0],
    downSince: null,
    uptimePct24h: 99.8,
    avgMs24h: 142,
    recent,
  };
}

// --- 엔진 -----------------------------------------------------------------

export function engine(): EngineStatus {
  return {
    level: "warn",
    found: true,
    version: "500d087a4c1f9e2b7d3a68f01c5e9b2d4a7f3c80",
    host: "a3f9c1d27b45",
    startedAt: ago(2 * DAY + 3 * HOUR),
    beatAt: ago(12_000),
    ageSec: 12,
    stale: false,
    staleAfterSec: 120,
    halted: false,
    brokerReady: true,
    lastTickMs: 1840,
    errors: [{ at: ago(8 * MIN), step: "news_collect", error: "TimeoutError: 뉴스 수집 응답 없음 (https://news.example.com/…)" }],
    limits: { aiDailyBudgetUsd: 5, analysesPerUser: 3, analysesTotal: 20, reportsPerUser: 5 },
  };
}

// --- 배포 -----------------------------------------------------------------

const TAGS = {
  a: "500d087a4c1f9e2b7d3a68f01c5e9b2d4a7f3c80",
  b: "75d4b7e91a02c3d4e5f60718293a4b5c6d7e8f90",
  c: "076b490d3e1f2a3b4c5d6e7f8091a2b3c4d5e6f7",
  d: "9b5f2fb0a1b2c3d4e5f60718293a4b5c6d7e8f01",
};

export function deployRecords(): DeployRecord[] {
  const run = (n: number) => `https://github.com/example/team-trading/actions/runs/${n}`;
  return [
    { at: ago(3 * HOUR), server: "app", tag: TAGS.a, previous: TAGS.b, result: "success", actor: "Hwanseok", commit: "PDF 버튼: 실제 서버 406 · 탭 두 개 · 팝업 차단 고침", runUrl: run(1004) },
    { at: ago(9 * HOUR), server: "app", tag: TAGS.c, previous: TAGS.b, result: "rolled_back", actor: "yubeen", commit: "프론트 오류·복구 및 Agent Workflow 시연 화면 추가", runUrl: run(1003) },
    { at: ago(11 * HOUR), server: "app", tag: TAGS.b, previous: TAGS.d, result: "success", actor: "Hwanseok", commit: "예시 ③ 모델명 맞춤: failover 사건·테스트 기대값을 YAML 모델로", runUrl: run(1002) },
    { at: ago(1 * DAY + 2 * HOUR), server: "app", tag: TAGS.d, previous: null, result: "blocked", actor: "ju", commit: "Registry: YAML fallbacks를 실제 대체 모델 하나로 맞춤", runUrl: run(1001) },
    { at: ago(2 * DAY), server: "app", tag: TAGS.d, previous: null, result: "success", actor: "ju", commit: "첫 배포", runUrl: null },
  ];
}

export function deploys(limit: number): Deploys {
  const all = deployRecords();
  return {
    servers: [{ server: "app", current: TAGS.a, currentAt: all[0].at, last: all[0] }],
    records: all.slice(0, limit),
    total: all.length,
  };
}

// --- 리포트와 복구 사건 -----------------------------------------------------
// 사건(events)에서 리포트의 장애·복구 수를 계산해 두 화면의 숫자가 어긋나지 않게 한다.

interface FailEvent {
  reportId: number;
  worker: string;
  errorType: string;
  injected: boolean;
  recovered: boolean;
  recoveryMs: number | null;
  at: number; // 첫 실패 시각 (epoch ms)
}

function events(): FailEvent[] {
  const n = Date.now();
  return [
    { reportId: 108, worker: "news", errorType: "timeout", injected: true, recovered: true, recoveryMs: 4200, at: n - 20 * MIN },
    { reportId: 108, worker: "valuation", errorType: "server_error", injected: true, recovered: true, recoveryMs: 1800, at: n - 19 * MIN },
    { reportId: 107, worker: "technical", errorType: "server_error", injected: false, recovered: false, recoveryMs: null, at: n - 2 * HOUR },
    { reportId: 105, worker: "news", errorType: "timeout", injected: false, recovered: true, recoveryMs: 3100, at: n - 5 * HOUR },
    { reportId: 102, worker: "report", errorType: "bad_output", injected: true, recovered: false, recoveryMs: null, at: n - 3 * DAY },
    { reportId: 103, worker: "valuation", errorType: "timeout", injected: false, recovered: true, recoveryMs: 2600, at: n - 4 * DAY },
  ];
}

interface Base {
  id: number;
  team: ReportRow["team"];
  symbol: string;
  name: string;
  source: ReportRow["source"];
  status: ReportRow["status"];
  chaos: boolean;
  failReason: string | null;
  costUsd: number | null;
  createdAgo: number;
  durationMs: number | null;
}

const BASES: Base[] = [
  { id: 108, team: "stock_report", symbol: "005930", name: "삼성전자", source: "user", status: "completed", chaos: true, failReason: null, costUsd: 0.412, createdAgo: 22 * MIN, durationMs: 96_000 },
  { id: 107, team: "stock_report", symbol: "000660", name: "SK하이닉스", source: "auto", status: "failed", chaos: false, failReason: "agent_failed", costUsd: 0.187, createdAgo: 2 * HOUR + 5 * MIN, durationMs: 71_500 },
  { id: 106, team: "stock_selection", symbol: "KR", name: "선정 KR", source: "auto", status: "completed", chaos: false, failReason: null, costUsd: 0.093, createdAgo: 3 * HOUR, durationMs: 38_200 },
  { id: 105, team: "stock_report", symbol: "035420", name: "NAVER", source: "user", status: "completed", chaos: false, failReason: null, costUsd: 0.356, createdAgo: 5 * HOUR + 2 * MIN, durationMs: 88_400 },
  { id: 104, team: "stock_report", symbol: "051910", name: "LG화학", source: "user", status: "running", chaos: false, failReason: null, costUsd: null, createdAgo: 4 * MIN, durationMs: null },
  { id: 103, team: "stock_report", symbol: "373220", name: "LG에너지솔루션", source: "user", status: "completed", chaos: false, failReason: null, costUsd: 0.401, createdAgo: 4 * DAY, durationMs: 104_000 },
  { id: 102, team: "stock_report", symbol: "207940", name: "삼성바이오로직스", source: "user", status: "failed", chaos: true, failReason: "review_failed", costUsd: 0.221, createdAgo: 3 * DAY, durationMs: 60_300 },
  { id: 101, team: "stock_report", symbol: "005380", name: "현대차", source: "auto", status: "completed", chaos: false, failReason: null, costUsd: 0.298, createdAgo: 12 * DAY, durationMs: 79_000 },
];

export function reportRows(): ReportRow[] {
  const ev = events();
  return BASES.map((b) => {
    const mine = ev.filter((e) => e.reportId === b.id);
    const created = Date.now() - b.createdAgo;
    return {
      id: b.id,
      team: b.team,
      symbol: b.symbol,
      name: b.name,
      source: b.source,
      status: b.status,
      chaos: b.chaos,
      failReason: b.failReason,
      failures: mine.length,
      recovered: mine.filter((e) => e.recovered).length,
      unrecovered: mine.filter((e) => !e.recovered).length,
      injected: mine.filter((e) => e.injected).length,
      costUsd: b.costUsd,
      createdAt: new Date(created).toISOString(),
      startedAt: new Date(created + 2000).toISOString(),
      finishedAt: b.durationMs == null ? null : new Date(created + 2000 + b.durationMs).toISOString(),
      durationMs: b.durationMs,
    };
  });
}

/** F6 목록의 종류 필터 (API.md 2장) */
export function matchesKind(r: ReportRow, kind: string): boolean {
  if (kind === "failed") return r.status === "failed";
  if (kind === "recovered") return r.recovered > 0;
  if (kind === "chaos") return r.chaos;
  return r.status === "failed" || r.recovered > 0 || r.chaos;
}

// --- 실행 기록 ------------------------------------------------------------

function kindOf(action: string, details: Record<string, unknown>): TraceKind {
  if (action === "agent_retry") return "retry";
  if (action === "agent_failover") return "failover";
  if (action === "agent_failed") return details.final === true ? "give_up" : "failure";
  if (action === "agent_completed" && details.recovered === true) return "recovered";
  if (action === "agent_skipped") return "skipped";
  if (action.startsWith("join_") || action.startsWith("handoff_") || action === "review_retry") return "guard";
  if (action.startsWith("workflow_")) return "workflow";
  return "other";
}

type Seed = [
  actor: string,
  action: string,
  status: string,
  details?: Record<string, unknown>,
  extra?: { provider?: string; model?: string; latencyMs?: number },
];

function buildEvents(startAt: number, seeds: Seed[]): TraceItem[] {
  return seeds.map(([actor, action, status, details = {}, extra = {}], i) => ({
    step: i + 1,
    at: new Date(startAt + i * 4300).toISOString(),
    actor,
    action,
    status,
    provider: extra.provider ?? null,
    model: extra.model ?? null,
    latencyMs: extra.latencyMs ?? null,
    details,
    kind: kindOf(action, details),
  }));
}

const TRACES: Record<number, Seed[]> = {
  108: [
    ["orchestrator", "workflow_started", "started", { team: "stock_report" }],
    ["news", "agent_started", "started"],
    ["news", "agent_failed", "failed", { final: false, errorType: "timeout", injected: true, attempt: 1 }, { provider: "google", model: "gemini-3.8-flash", latencyMs: 30000 }],
    ["news", "agent_failover", "started", { from: "gemini-3.8-flash", to: "gpt-5.6-luna", reason: "timeout", attempt: 2 }],
    ["news", "agent_completed", "completed", { recovered: true, attempts: 2 }, { provider: "openai", model: "gpt-5.6-luna", latencyMs: 6100 }],
    ["valuation", "agent_started", "started"],
    ["valuation", "agent_failed", "failed", { final: false, errorType: "server_error", injected: true, attempt: 1, httpStatus: 503 }, { provider: "google", model: "gemini-3.8-flash", latencyMs: 820 }],
    ["valuation", "agent_retry", "started", { attempt: 2, reason: "server_error", waitMs: 800 }],
    ["valuation", "agent_completed", "completed", { recovered: true, attempts: 2 }, { provider: "google", model: "gemini-3.8-flash", latencyMs: 5200 }],
    ["join_guard", "join_completed", "completed", { step: "analysis" }],
    ["report", "agent_started", "started"],
    ["report", "agent_completed", "completed", {}, { provider: "google", model: "gemini-3.8-pro", latencyMs: 21800 }],
    ["orchestrator", "workflow_completed", "completed", { costUsd: 0.412 }],
  ],
  107: [
    ["orchestrator", "workflow_started", "started", { team: "stock_report" }],
    ["technical", "agent_started", "started"],
    ["technical", "agent_failed", "failed", { final: false, errorType: "server_error", injected: false, attempt: 1, httpStatus: 500 }, { provider: "google", model: "gemini-3.8-flash", latencyMs: 640 }],
    ["technical", "agent_retry", "started", { attempt: 2, reason: "server_error" }],
    ["technical", "agent_failed", "failed", { final: false, errorType: "server_error", injected: false, attempt: 2 }, { provider: "google", model: "gemini-3.8-flash", latencyMs: 710 }],
    ["technical", "agent_failover", "started", { from: "gemini-3.8-flash", to: "gpt-5.6-luna", reason: "server_error", attempt: 3 }],
    ["technical", "agent_failed", "failed", { final: true, errorType: "server_error", injected: false, attempt: 4, reason: "retries_exhausted" }, { provider: "openai", model: "gpt-5.6-luna", latencyMs: 530 }],
    ["join_guard", "join_blocked", "blocked", { step: "analysis" }],
    ["report", "agent_skipped", "skipped", { reason: "join_blocked" }],
    ["orchestrator", "workflow_failed", "failed", { reason: "agent_failed" }],
  ],
};

export function trace(id: number): ReportTrace | null {
  const row = reportRows().find((r) => r.id === id);
  if (!row) return null;
  const startAt = Date.parse(row.startedAt ?? row.createdAt);
  const failed = row.status === "failed";
  const generic: Seed[] = [
    ["orchestrator", "workflow_started", "started", { team: row.team }],
    ["report", "agent_started", "started"],
    ["report", "agent_completed", "completed", {}, { provider: "google", model: "gemini-3.8-pro", latencyMs: 20000 }],
    ["orchestrator", failed ? "workflow_failed" : "workflow_completed", failed ? "failed" : "completed", row.failReason ? { reason: row.failReason } : {}],
  ];
  const mine = events().filter((e) => e.reportId === id);
  const recovered = mine.filter((e) => e.recovered);
  return {
    report: row,
    recovery: {
      failures: mine.length,
      recovered: recovered.length,
      unrecovered: mine.length - recovered.length,
      injected: mine.filter((e) => e.injected).length,
      recoveryMs: recovered.length ? recovered.reduce((a, e) => a + (e.recoveryMs ?? 0), 0) : null,
    },
    events: buildEvents(startAt, TRACES[id] ?? generic),
  };
}

// --- 복구 지표 --------------------------------------------------------------

export function recovery(days: number): RecoveryStats {
  const win = dayWindow(days);
  const rows = reportRows().filter((r) => Date.parse(r.createdAt) >= win.since);
  const ids = new Set(rows.map((r) => r.id));
  const ev = events().filter((e) => ids.has(e.reportId));
  const rec = ev.filter((e) => e.recovered);
  const group = (key: "errorType" | "worker") => {
    const m = new Map<string, { failures: number; recovered: number }>();
    for (const e of ev) {
      const g = m.get(e[key]) ?? { failures: 0, recovered: 0 };
      g.failures += 1;
      if (e.recovered) g.recovered += 1;
      m.set(e[key], g);
    }
    return [...m.entries()].sort((a, b) => b[1].failures - a[1].failures);
  };
  const symbolOf = (id: number) => BASES.find((b) => b.id === id)?.symbol ?? "";
  return {
    from: win.from,
    to: win.to,
    days,
    reports: rows.length,
    reportsWithFailures: new Set(ev.map((e) => e.reportId)).size,
    failures: ev.length,
    recovered: rec.length,
    unrecovered: ev.length - rec.length,
    injected: ev.filter((e) => e.injected).length,
    autoRecoveryRate: ev.length ? Math.round((rec.length / ev.length) * 1000) / 10 : null,
    meanRecoveryMs: rec.length ? Math.round(rec.reduce((a, e) => a + (e.recoveryMs ?? 0), 0) / rec.length) : null,
    byErrorType: group("errorType").map(([errorType, g]) => ({ errorType, ...g })),
    byWorker: group("worker").map(([worker, g]) => ({ worker, ...g })),
    recent: [...ev]
      .sort((a, b) => b.at - a.at)
      .slice(0, 20)
      .map((e) => ({
        reportId: e.reportId,
        symbol: symbolOf(e.reportId),
        worker: e.worker,
        errorType: e.errorType,
        injected: e.injected,
        recovered: e.recovered,
        recoveryMs: e.recoveryMs,
        at: new Date(e.at).toISOString(),
      })),
  };
}

// --- 비용 -----------------------------------------------------------------

const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function costs(days: number): Costs {
  const n = Date.now();
  const daily: CostDay[] = Array.from({ length: days }, (_, i) => {
    const back = days - 1 - i; // 오래된 날 → 오늘
    const reportsUsd = r3(back === 0 ? 1.842 : 0.35 + ((back * 0.37) % 1.4));
    const analysisUsd = r3(back === 0 ? 2.213 : 0.6 + ((back * 0.53) % 1.8));
    const longtermUsd = r3(back === 0 ? 0.201 : 0.05 + ((back * 0.11) % 0.2));
    return {
      date: kstDate(n - back * DAY),
      reportsUsd,
      analysisUsd,
      longtermUsd,
      totalUsd: r3(reportsUsd + analysisUsd + longtermUsd),
      reports: back === 0 ? 5 : 1 + (back % 4),
      analyses: back === 0 ? 7 : 2 + (back % 5),
    };
  });
  const sum = (f: (d: CostDay) => number) => r3(daily.reduce((a, d) => a + f(d), 0));
  const today = daily[daily.length - 1];
  const budgetUsd = 5;
  return {
    from: new Date(n - days * DAY).toISOString(),
    to: new Date(n).toISOString(),
    days,
    daily,
    totals: {
      reportsUsd: sum((d) => d.reportsUsd),
      analysisUsd: sum((d) => d.analysisUsd),
      longtermUsd: sum((d) => d.longtermUsd),
      totalUsd: sum((d) => d.totalUsd),
    },
    today: {
      date: today.date,
      totalUsd: today.totalUsd,
      budgetUsd,
      budgetUsedUsd: today.totalUsd,
      budgetPct: Math.round((today.totalUsd / budgetUsd) * 1000) / 10,
      analyses: { used: today.analyses, limit: 20 },
      reportsPerUser: { maxUsed: 4, limit: 5, unlimited: false },
    },
  };
}

// --- 알림 -----------------------------------------------------------------

export function alerts(hours: number): Alerts {
  const old = Math.min(hours, 20);
  return {
    hours,
    level: "warn",
    discord: {
      failed: 2,
      pendingOld: 1,
      sendingStuck: 0,
      rows: [
        { id: 4412, kind: "report_failed", status: "failed", attempts: 3, lastError: "HTTPError: 429 Too Many Requests (https://discord.com/…)", createdAt: ago(40 * MIN), claimedAt: ago(38 * MIN), ageSec: 2400 },
        { id: 4398, kind: "report_completed", status: "pending", attempts: 0, lastError: null, createdAt: ago(25 * MIN), claimedAt: null, ageSec: 1500 },
        { id: 4377, kind: "order_filled", status: "failed", attempts: 5, lastError: "ConnectionError: 연결이 끊김", createdAt: ago(old * HOUR), claimedAt: null, ageSec: old * 3600 },
      ],
    },
    stuck: [{ kind: "analysis", id: 231, status: "RUNNING", label: "분석 005930", since: ago(26 * MIN), ageSec: 1560 }],
  };
}

// --- 개요 (다른 화면의 자료를 요약. 나쁜 것부터) -------------------------------------

export function overview(): Overview {
  const eng = engine();
  const svc = service();
  const cst = costs(1);
  const rec = recovery(7);
  const al = alerts(24);
  const pct = cst.today.budgetPct ?? 0;
  const items: Overview["items"] = [
    { key: "service", title: "서비스 상태", level: "ok", summary: `api ${svc.latest?.api.status} · 24시간 가동률 ${svc.uptimePct24h}%` },
    { key: "engine", title: "엔진 상태", level: eng.level, summary: `마지막 동작 ${eng.ageSec}초 전 · 버전 ${eng.version?.slice(0, 7)} · 단계 오류 ${eng.errors.length}건` },
    { key: "deploys", title: "배포 기록", level: "warn", summary: "최신 기록 성공 · 9시간 전 되돌림 1건" },
    { key: "reports", title: "리포트 장애", level: "ok", summary: "최근 24시간 실패 리포트 없음" },
    { key: "recovery", title: "복구 지표", level: "warn", summary: `7일 장애 ${rec.failures}건 중 ${rec.recovered}건 복구 (미복구 ${rec.unrecovered})` },
    { key: "costs", title: "AI 비용", level: pct >= 100 ? "down" : pct >= 80 ? "warn" : "ok", summary: `오늘 $${cst.today.totalUsd.toFixed(3)} / $${cst.today.budgetUsd} (${pct}%)` },
    { key: "alerts", title: "알림·작업 실패", level: al.level, summary: `Discord 실패 ${al.discord.failed} · 오래된 대기 ${al.discord.pendingOld} · 멈춘 작업 ${al.stuck.length}` },
  ];
  const order = { down: 0, warn: 1, unknown: 2, ok: 3 } as const;
  const keyOrder = items.map((i) => i.key);
  items.sort((a, b) => order[a.level] - order[b.level] || keyOrder.indexOf(a.key) - keyOrder.indexOf(b.key));
  return { at: new Date().toISOString(), level: items[0].level, items };
}
