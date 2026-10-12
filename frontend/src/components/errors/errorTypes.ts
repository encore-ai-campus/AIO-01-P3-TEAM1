import { ApiError } from "../../api/client";

export type ErrorKind = "network" | "validation" | "rate_limit" | "budget" | "unavailable" | "workflow" | "pdf" | "unknown";

/** 리포트 신청 429가 내 하루 횟수 한도인가 (본문에 limit이 있다). 없으면 팀 전체 AI 비용 예산 (docs/API.md "하루 리포트 한도"). */
export function isCountLimit(error: ApiError): boolean {
  return error.status === 429 && error.num("limit") !== null;
}

export function errorKindOf(error: unknown): ErrorKind {
  if (!(error instanceof ApiError)) return "unknown";
  if (error.status === 0) return "network";
  if (error.status === 400) return "validation";
  if (error.status === 429) return isCountLimit(error) ? "rate_limit" : "budget";
  if (error.status === 503) return "unavailable";
  return "unknown";
}
