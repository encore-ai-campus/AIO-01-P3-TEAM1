import { ApiError } from "../../api/client";

export type ErrorKind = "network" | "validation" | "rate_limit" | "unavailable" | "workflow" | "pdf" | "unknown";

export function errorKindOf(error: unknown): ErrorKind {
  if (!(error instanceof ApiError)) return "unknown";
  if (error.status === 0) return "network";
  if (error.status === 400) return "validation";
  if (error.status === 429) return "rate_limit";
  if (error.status === 503) return "unavailable";
  return "unknown";
}
