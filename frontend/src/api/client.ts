// 같은 출처의 Django API를 부르는 fetch 래퍼 (세션 쿠키 + CSRF, docs/API.md 공통 규칙).

export class ApiError extends Error {
  readonly status: number;
  readonly detail: string;
  /** 오류 응답 본문 전체 (예: 429 리포트 한도의 {detail, limit, used}). JSON 객체가 아니면 null. */
  readonly body: Record<string, unknown> | null;
  /**
   * 400 본문의 실행 불가 사유 코드 (docs/API.md "실행 불가 사유 코드"). detail을 "; "로 나눈 사유와 같은 길이·같은 순서.
   * null이면 사유 코드가 없는 오류 (입력 오류 등) — 화면이 둘을 나눈다.
   */
  readonly reasonCodes: string[] | null;

  constructor(status: number, detail: string, body: Record<string, unknown> | null = null) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.body = body;
    const codes = body?.reasonCodes;
    this.reasonCodes = Array.isArray(codes) ? codes.filter((c): c is string => typeof c === "string") : null;
  }

  /** 본문의 숫자 필드 (429 리포트 한도의 limit·used 등). 없으면 null. */
  num(key: string): number | null {
    const v = this.body?.[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }
}

/** 실행 불가 사유 코드가 있는 400인지 (없으면 입력 오류). */
export function isBlocked(err: unknown): err is ApiError & { reasonCodes: string[] } {
  return err instanceof ApiError && err.status === 400 && err.reasonCodes !== null;
}

/** 오류에서 사람이 읽을 메시지를 꺼낸다. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.detail;
  if (err instanceof Error && err.message) return err.message;
  return "요청에 실패했습니다.";
}

type Handler = () => void;
let onUnauthorized: Handler | null = null;

/** 401을 받으면 부를 함수 (로그인 화면으로 보내기). App이 등록한다. */
export function setUnauthorizedHandler(fn: Handler | null) {
  onUnauthorized = fn;
}

export function readCookie(name: string): string | null {
  for (const part of document.cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// 쿠키를 못 읽는 환경을 위한 예비 값 (GET /api/auth/csrf 응답 본문)
let fallbackToken: string | null = null;

/** 변경 요청마다 csrftoken 쿠키를 새로 읽는다 (로그인하면 값이 바뀐다). 없으면 먼저 받아 온다. */
async function csrfToken(): Promise<string> {
  const cookie = readCookie("csrftoken");
  if (cookie) return cookie;
  const res = await send("GET", "/api/auth/csrf");
  const body = (await res.json().catch(() => null)) as { csrfToken?: string } | null;
  fallbackToken = body?.csrfToken ?? fallbackToken;
  return readCookie("csrftoken") ?? fallbackToken ?? "";
}

function send(method: string, path: string, init: RequestInit = {}): Promise<Response> {
  // 상대 경로를 현재 출처 기준 절대 주소로 바꾼다 (테스트 환경의 fetch도 같은 주소를 받게).
  const url = new URL(path, window.location.origin).toString();
  return fetch(url, { method, credentials: "same-origin", ...init }).catch(() => {
    throw new ApiError(0, "서버에 연결할 수 없습니다.");
  });
}

interface Options {
  /** 401을 오류 대신 null로 돌려준다 (로그인 확인용). */
  allow401?: boolean;
}

export async function request<T>(method: string, path: string, body?: unknown, opts: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET") headers["X-CSRFToken"] = await csrfToken();

  const res = await send(method, path, {
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401) {
    if (opts.allow401) return null as T;
    onUnauthorized?.();
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as unknown;
    const body = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    const detail = typeof body?.detail === "string" ? body.detail : `요청에 실패했습니다 (${res.status}).`;
    throw new ApiError(res.status, detail, body);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string, opts?: Options) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
  patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
  del: <T = void>(path: string) => request<T>("DELETE", path),
};

/** 쿼리 문자열을 만든다. null·undefined·빈 문자열은 뺀다. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== "") sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : "";
}
