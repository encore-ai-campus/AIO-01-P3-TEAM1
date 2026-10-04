// docs/API.md의 모든 엔드포인트를 흉내 내는 MSW 핸들러.
import { delay, http, HttpResponse, type DefaultBodyType, type StrictRequest } from "msw";
import type { ChaosRequest, OrderRequest } from "../api/types";
import * as db from "./db";
import { sampleRecoveryStats, sampleScreening } from "../lib/reportSamples";
import { reportPlan, type MockUser } from "./seed";

const CSRF = "mock-csrf-token";

function setCsrfCookie(value: string) {
  if (typeof document !== "undefined") document.cookie = `csrftoken=${value}; path=/`;
}

const detail = (status: number, message: string) => HttpResponse.json({ detail: message }, { status });

type Req = StrictRequest<DefaultBodyType>;
type Ctx = { request: Req; params: Record<string, string | readonly string[] | undefined> };

/** 로그인 확인 + 변경 요청이면 CSRF 헤더 확인 + 규칙 오류를 {"detail"} 응답으로. */
function route(fn: (user: MockUser, ctx: Ctx) => unknown | Promise<unknown>, opts: { auth?: boolean; status?: number } = {}) {
  return async (ctx: Ctx) => {
    await delay();
    const { request } = ctx;
    if (request.method !== "GET" && !request.headers.get("X-CSRFToken")) {
      return detail(403, "CSRF 검증에 실패했습니다.");
    }
    const user = db.sessionUser();
    if (opts.auth !== false && !user) return detail(401, "로그인이 필요합니다.");
    try {
      const body = await fn(user as MockUser, ctx);
      db.persist();
      if (body instanceof Response) return body;
      if (body === undefined) return new HttpResponse(null, { status: 204 });
      return HttpResponse.json(body as never, { status: opts.status ?? 200 });
    } catch (err) {
      if (err instanceof db.MockError) return detail(err.status, err.message);
      throw err;
    }
  };
}

const json = async <T>(request: Req) => ((await request.json().catch(() => ({}))) ?? {}) as T;
const num = (v: unknown) => Number(v);
const page = <T>(url: URL, rows: T[]) => {
  const limit = Math.max(1, Number(url.searchParams.get("limit") ?? 20));
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0));
  return { count: rows.length, results: rows.slice(offset, offset + limit) };
};
const urlOf = (ctx: Ctx) => new URL(ctx.request.url);

export const handlers = [
  // 계정
  http.get(
    "*/api/auth/csrf",
    route(
      () => {
        setCsrfCookie(CSRF);
        return { csrfToken: CSRF };
      },
      { auth: false },
    ),
  ),
  http.post(
    "*/api/auth/login",
    route(
      async (_u, { request }) => {
        const body = await json<{ username?: string; password?: string }>(request);
        const user = db.login(String(body.username ?? ""), String(body.password ?? ""));
        setCsrfCookie(`${CSRF}-${user.id}`); // 로그인하면 토큰이 바뀐다
        return db.toMe(user);
      },
      { auth: false },
    ),
  ),
  http.post(
    "*/api/auth/logout",
    route(
      () => {
        db.logout();
        return undefined;
      },
      { auth: false },
    ),
  ),
  http.get(
    "*/api/auth/me",
    route((u) => db.toMe(u)),
  ),
  http.patch(
    "*/api/me/profile",
    route(async (u, { request }) => db.updateProfile(u, await json(request))),
  ),

  // 모의 트레이딩
  http.get(
    "*/api/market",
    route(() => db.marketStatus()),
  ),
  http.get(
    "*/api/stocks/search",
    route((_u, ctx) => {
      const url = urlOf(ctx);
      return { results: db.search(url.searchParams.get("q") ?? "", Number(url.searchParams.get("limit") ?? 20)) };
    }),
  ),
  http.get(
    "*/api/stocks/:symbol",
    route((_u, { params }) => db.stockDetail(String(params.symbol))),
  ),
  http.get(
    "*/api/quotes",
    route((_u, ctx) => {
      const symbols = (urlOf(ctx).searchParams.get("symbols") ?? "").split(",").filter(Boolean);
      return { quotes: db.quotes(symbols), asOf: new Date().toISOString() };
    }),
  ),
  http.get(
    "*/api/account",
    route((u) => db.account(u.id)),
  ),
  http.get(
    "*/api/account/equity",
    route((u, ctx) => db.equityHistory(u.id, Number(urlOf(ctx).searchParams.get("days") ?? 30))),
  ),
  http.get(
    "*/api/orders",
    route((u, ctx) => {
      const url = urlOf(ctx);
      return page(url, db.listOrders(u.id, url.searchParams.get("status") ?? "active"));
    }),
  ),
  http.post(
    "*/api/orders",
    route(async (u, { request }) => db.placeOrder(u.id, await json<OrderRequest>(request)), { status: 201 }),
  ),
  http.patch(
    "*/api/orders/:id",
    route(async (u, { request, params }) => db.modifyOrder(u.id, num(params.id), await json(request))),
  ),
  http.post(
    "*/api/orders/:id/sell",
    route((u, { params }) => db.sellOrder(u.id, num(params.id))),
  ),
  http.post(
    "*/api/orders/:id/cancel",
    route((u, { params }) => db.cancelOrder(u.id, num(params.id))),
  ),
  http.get(
    "*/api/fills",
    route((u, ctx) => page(urlOf(ctx), db.listFills(u.id))),
  ),
  http.get(
    "*/api/reservations",
    route((u) => ({ results: db.listReservations(u.id) })),
  ),
  http.delete(
    "*/api/reservations/:id",
    route((u, { params }) => {
      db.deleteReservation(u.id, num(params.id));
      return undefined;
    }),
  ),
  http.get(
    "*/api/ranking",
    route((u) => db.ranking(u.id)),
  ),

  // AI 분석
  http.get(
    "*/api/analyses/quota",
    route((u) => db.quota(u.id)),
  ),
  http.get(
    "*/api/analyses",
    route((_u, ctx) => {
      const url = urlOf(ctx);
      return page(url, db.listAnalyses(url.searchParams.get("symbol"), url.searchParams.get("verdict")));
    }),
  ),
  http.get(
    "*/api/analyses/:id",
    route((_u, { params }) => db.getAnalysis(num(params.id))),
  ),
  http.post(
    "*/api/analyses",
    route(async (u, { request }) => db.requestAnalysis(u, String((await json<{ symbol?: string }>(request)).symbol ?? "")), {
      status: 202,
    }),
  ),
  http.get(
    "*/api/jobs/:id",
    route((u, { params }) => db.getJob(u, num(params.id))),
  ),

  // AI 리포트 (SSE는 흉내 내지 않는다: 가짜 리포트는 모두 실행 전이라 화면이 SSE를 열지 않는다)
  http.get(
    "*/api/reports/plan",
    route(() => reportPlan()),
  ),
  http.get(
    "*/api/reports/recovery-stats",
    route((_u, ctx) => sampleRecoveryStats(Number(urlOf(ctx).searchParams.get("days")) || 7)),
  ),
  http.get(
    "*/api/reports/screening",
    route(() => sampleScreening()),
  ),
  http.get(
    "*/api/reports",
    route((_u, ctx) => {
      const url = urlOf(ctx);
      return page(url, db.listReports(url.searchParams.get("symbol")));
    }),
  ),
  http.post(
    "*/api/reports",
    route(async (u, { request }) => {
      const body = await json<{ symbol?: string; chaos?: ChaosRequest }>(request);
      const { report, created } = db.requestReport(u, String(body.symbol ?? ""), body.chaos);
      return HttpResponse.json(report, { status: created ? 201 : 200 });
    }),
  ),
  http.get(
    "*/api/reports/:id",
    route((_u, { params }) => db.getReport(num(params.id))),
  ),
  http.get("*/api/health", () => HttpResponse.json({ status: "ok" })),
];
