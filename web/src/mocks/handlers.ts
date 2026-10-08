// API.md의 모든 경로를 흉내 내는 MSW 핸들러. 로그인은 admin / admin1234만 성공한다.
import { http, HttpResponse } from "msw";
import { alerts, costs, dayWindow, deploys, engine, matchesKind, mcp, overview, recovery, reportRows, service, trace } from "./data";

const SESSION_KEY = "paper-admin-mock-session";

// 세션은 브라우저(개발 서버)에서는 sessionStorage에 두어 새로 고침해도 유지하고, 저장소가 없으면 메모리에 둔다.
let memorySession = false;
export function isLoggedIn(): boolean {
  try {
    return sessionStorage.getItem(SESSION_KEY) === "1";
  } catch {
    return memorySession;
  }
}
export function setLoggedIn(on: boolean) {
  memorySession = on;
  try {
    if (on) sessionStorage.setItem(SESSION_KEY, "1");
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* 메모리 값만 쓴다 */
  }
}

const err = (status: number, detail: string) => HttpResponse.json({ detail }, { status });
const unauthorized = () => err(401, "로그인이 필요합니다.");

/** 쿼리 숫자 값을 [min, max] 안의 정수로 읽는다. 없으면 기본값, 틀리면 null. */
function intParam(url: URL, name: string, def: number, min: number, max: number): number | null {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return def;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return n >= min && n <= max ? n : null;
}

const bad = (name: string, min: number, max: number) => err(400, `${name}은(는) ${min}~${max} 사이여야 합니다.`);

/** 로그인해야 부를 수 있는 GET 하나를 만든다. */
function guarded(path: string, make: (url: URL, params: Record<string, string | readonly string[]>) => Response) {
  return http.get(path, ({ request, params }) => {
    if (!isLoggedIn()) return unauthorized();
    return make(new URL(request.url), params as Record<string, string>);
  });
}

export const handlers = [
  http.post("/api/admin/login", async ({ request }) => {
    const body = (await request.json().catch(() => ({}))) as { username?: string; password?: string };
    if (!body.username || !body.password) return err(400, "아이디와 비밀번호를 입력하세요.");
    if (body.username === "admin" && body.password === "admin1234") {
      setLoggedIn(true);
      return HttpResponse.json({ username: "admin", via: "session" });
    }
    return err(401, "아이디 또는 비밀번호가 맞지 않거나 관리자 계정이 아닙니다.");
  }),
  http.post("/api/admin/logout", () => {
    setLoggedIn(false);
    return new HttpResponse(null, { status: 204 });
  }),
  http.get("/api/admin/me", () => (isLoggedIn() ? HttpResponse.json({ username: "admin", via: "session" }) : unauthorized())),
  http.get("/api/admin/health", () => HttpResponse.json({ ok: true })),

  guarded("/api/admin/overview", () => HttpResponse.json(overview())),
  guarded("/api/admin/service", () => HttpResponse.json(service())),
  guarded("/api/admin/engine", () => HttpResponse.json(engine())),
  guarded("/api/admin/deploys", (url) => {
    const limit = intParam(url, "limit", 50, 1, 200);
    return limit === null ? bad("limit", 1, 200) : HttpResponse.json(deploys(limit));
  }),
  guarded("/api/admin/reports", (url) => {
    const days = intParam(url, "days", 7, 1, 90);
    if (days === null) return bad("days", 1, 90);
    const limit = intParam(url, "limit", 100, 1, 500);
    if (limit === null) return bad("limit", 1, 500);
    const kind = url.searchParams.get("kind") || "all";
    if (!["all", "failed", "recovered", "chaos"].includes(kind)) return err(400, "kind는 all · failed · recovered · chaos 중 하나여야 합니다.");
    const team = url.searchParams.get("team") || "";
    if (!["", "stock_report", "stock_selection"].includes(team)) return err(400, "team은 stock_report · stock_selection 또는 빈 값이어야 합니다.");
    const win = dayWindow(days);
    const matched = reportRows()
      .filter((r) => Date.parse(r.createdAt) >= win.since && matchesKind(r, kind) && (!team || r.team === team))
      .sort((a, b) => b.id - a.id);
    return HttpResponse.json({ from: win.from, to: win.to, days, kind, count: matched.length, results: matched.slice(0, limit) });
  }),
  guarded("/api/admin/reports/:id/trace", (_url, params) => {
    const id = Number(params.id);
    const t = Number.isInteger(id) ? trace(id) : null;
    return t ? HttpResponse.json(t) : err(404, "리포트를 찾을 수 없습니다.");
  }),
  guarded("/api/admin/recovery", (url) => {
    const days = intParam(url, "days", 7, 1, 90);
    return days === null ? bad("days", 1, 90) : HttpResponse.json(recovery(days));
  }),
  guarded("/api/admin/costs", (url) => {
    const days = intParam(url, "days", 14, 1, 90);
    return days === null ? bad("days", 1, 90) : HttpResponse.json(costs(days));
  }),
  guarded("/api/admin/alerts", (url) => {
    const hours = intParam(url, "hours", 24, 1, 168);
    return hours === null ? bad("hours", 1, 168) : HttpResponse.json(alerts(hours));
  }),
  guarded("/api/admin/mcp", (url) => {
    const hours = intParam(url, "hours", 24, 1, 168);
    if (hours === null) return bad("hours", 1, 168);
    const limit = intParam(url, "limit", 200, 1, 500);
    return limit === null ? bad("limit", 1, 500) : HttpResponse.json(mcp(hours, limit));
  }),
];
