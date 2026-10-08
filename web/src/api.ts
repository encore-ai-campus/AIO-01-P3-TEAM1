// 관리자 API(`API.md`)의 형식과 fetch 래퍼. 서비스 API는 부르지 않는다.

export type Level = "ok" | "warn" | "down" | "unknown";

export interface Me {
  username: string;
  via: "session" | "token";
}

export interface OverviewItem {
  key: "service" | "engine" | "deploys" | "reports" | "recovery" | "costs" | "alerts";
  title: string;
  level: Level;
  summary: string;
}
export interface Overview {
  at: string;
  level: Level;
  items: OverviewItem[];
}

export interface HealthProbe {
  ok: boolean;
  status: number | null;
  ms: number | null;
  error: string | null;
}
export interface HealthCheck {
  at: string;
  api: HealthProbe;
  page: HealthProbe;
}
export interface ServiceStatus {
  url: string;
  intervalSec: number;
  level: Level;
  latest: HealthCheck | null;
  downSince: string | null;
  uptimePct24h: number | null;
  avgMs24h: number | null;
  recent: HealthCheck[];
}

export interface EngineStatus {
  level: Level;
  found: boolean;
  version: string | null;
  host: string | null;
  startedAt: string | null;
  beatAt: string | null;
  ageSec: number | null;
  stale: boolean;
  staleAfterSec: number;
  halted: boolean | null;
  brokerReady: boolean | null;
  lastTickMs: number | null;
  errors: { at: string; step: string; error: string }[];
  limits: Record<string, number | string | null>;
}

export type DeployResult = "success" | "rolled_back" | "rollback_failed" | "failed" | "blocked";
export interface DeployRecord {
  at: string;
  server: string;
  tag: string;
  previous: string | null;
  result: DeployResult;
  actor: string | null;
  commit: string | null;
  runUrl: string | null;
}
export interface DeployServer {
  server: string;
  current: string | null;
  currentAt: string | null;
  last: DeployRecord;
}
export interface Deploys {
  servers: DeployServer[];
  records: DeployRecord[];
  total: number;
}

export type ReportTeam = "stock_report" | "stock_selection";
export interface ReportRow {
  id: number;
  team: ReportTeam;
  symbol: string;
  name: string;
  source: "user" | "auto";
  status: "requested" | "running" | "completed" | "failed";
  chaos: boolean;
  failReason: string | null;
  failures: number;
  recovered: number;
  unrecovered: number;
  injected: number;
  costUsd: number | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}
export interface ReportList {
  from: string;
  to: string;
  days: number;
  kind: string;
  count: number;
  results: ReportRow[];
}

export type TraceKind = "retry" | "failover" | "failure" | "give_up" | "recovered" | "skipped" | "guard" | "workflow" | "other";
export interface TraceItem {
  step: number;
  at: string;
  actor: string;
  action: string;
  status: string;
  provider: string | null;
  model: string | null;
  latencyMs: number | null;
  details: Record<string, unknown>;
  kind: TraceKind;
}
export interface RecoverySummary {
  failures: number;
  recovered: number;
  unrecovered: number;
  injected: number;
  recoveryMs: number | null;
}
export interface ReportTrace {
  report: ReportRow;
  recovery: RecoverySummary;
  events: TraceItem[];
}

export interface RecoveryStats {
  from: string;
  to: string;
  days: number;
  reports: number;
  reportsWithFailures: number;
  failures: number;
  recovered: number;
  unrecovered: number;
  injected: number;
  autoRecoveryRate: number | null;
  meanRecoveryMs: number | null;
  byErrorType: { errorType: string; failures: number; recovered: number }[];
  byWorker: { worker: string; failures: number; recovered: number }[];
  recent: {
    reportId: number;
    symbol: string;
    worker: string;
    errorType: string;
    injected: boolean;
    recovered: boolean;
    recoveryMs: number | null;
    at: string;
  }[];
}

export interface CostDay {
  date: string;
  reportsUsd: number;
  analysisUsd: number;
  longtermUsd: number;
  totalUsd: number;
  reports: number;
  analyses: number;
}
export interface Costs {
  from: string;
  to: string;
  days: number;
  daily: CostDay[];
  totals: { reportsUsd: number; analysisUsd: number; longtermUsd: number; totalUsd: number };
  today: {
    date: string;
    totalUsd: number;
    budgetUsd: number | null;
    budgetUsedUsd: number; // 서비스 예산 셈: 분석 요청 수 × 건당 예상 비용 + 리포트 실제 비용
    budgetPct: number | null;
    analyses: { used: number; limit: number | null };
    reportsPerUser: { maxUsed: number; limit: number | null; unlimited: boolean };
  };
}

export interface OutboxRow {
  id: number;
  kind: string;
  status: "failed" | "pending" | "sending";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  claimedAt: string | null;
  ageSec: number;
}
export interface StuckJob {
  kind: "analysis" | "report";
  id: number;
  status: string;
  label: string;
  since: string;
  ageSec: number;
}
export interface Alerts {
  hours: number;
  level: Level;
  discord: { failed: number; pendingOld: number; sendingStuck: number; rows: OutboxRow[] };
  stuck: StuckJob[];
}

// F10 MCP 도구·호출 기록 — GET /api/admin/mcp?hours=&limit= (API.md 6장)
export interface McpTool {
  name: string;
  description: string;
  path: string;
  params: string[];
}
export interface McpToken {
  name: string;
  createdAt: string | null;
  lastUsedAt: string | null;
  calls: number;
  errors: number;
}
export interface McpCall {
  at: string;
  who: string | null;
  tool: string | null;
  path: string;
  status: number;
  ok: boolean;
}
export interface McpStatus {
  endpoint: string;
  hours: number;
  tools: McpTool[];
  tokens: McpToken[];
  summary: { calls: number; errors: number; invalid: number; byTool: { tool: string; calls: number; errors: number }[] };
  calls: McpCall[];
}

// ---------------------------------------------------------------------------

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

/** 401(로그인 필요)과 503(서비스 DB 연결 실패)을 화면 전체에 알리는 작은 구독 장치. */
type Listener = () => void;
const listeners = new Set<Listener>();
let authLost = false;
let dbDown = false;

function emit() {
  listeners.forEach((l) => l());
}
export function subscribeApiState(l: Listener) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}
export const apiState = {
  /** 마지막으로 401을 받은 뒤 로그인하지 않았으면 true */
  authLost: () => authLost,
  dbDown: () => dbDown,
  clearAuthLost() {
    if (authLost) {
      authLost = false;
      emit();
    }
  },
};

async function detailOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    if (typeof body.detail === "string" && body.detail) return body.detail;
  } catch {
    /* 본문이 JSON이 아니면 아래 기본 문장 */
  }
  return `요청에 실패했습니다 (HTTP ${res.status})`;
}

// 서비스 DB를 읽지 않는 경로(서비스 상태·배포 기록·로그인 확인)와, DB가 끊겨도 항목별로 200을 내는 개요는
// 성공해도 "DB 연결 안 됨" 띠를 끄지 않는다 (DB를 쓰는 경로가 성공해야 끈다).
const DB_FREE = ["/api/admin/service", "/api/admin/deploys", "/api/admin/me", "/api/admin/overview", "/api/admin/login", "/api/admin/logout"];

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: "same-origin", ...init });
  } catch {
    throw new ApiError(0, "관리자 서버에 연결할 수 없습니다");
  }
  if (res.status === 503) {
    if (!dbDown) {
      dbDown = true;
      emit();
    }
  } else if (dbDown && res.ok && !DB_FREE.some((p) => path.startsWith(p))) {
    dbDown = false;
    emit();
  }
  if (!res.ok) {
    const err = new ApiError(res.status, await detailOf(res));
    // 로그인 시도 자체의 401·429는 화면이 문구를 그대로 보여 준다.
    if (res.status === 401 && path !== "/api/admin/login") {
      authLost = true;
      emit();
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** 테스트가 다음 테스트로 상태를 넘기지 않게 한다. */
export function resetApiStateForTests() {
  authLost = false;
  dbDown = false;
  emit();
}

export const getJson = <T>(path: string) => request<T>(path);

export const login = (username: string, password: string) =>
  request<Me>("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });

export const logout = () => request<void>("/api/admin/logout", { method: "POST" });

export const fetchMe = () => request<Me>("/api/admin/me");

export function queryString(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
