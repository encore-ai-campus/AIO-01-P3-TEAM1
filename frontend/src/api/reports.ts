// AI 리포트: 신청과 상세의 실시간 전달 (docs/API.md "AI 리포트" 절).
// 먼저 Snapshot(GET /api/reports/{id})을 받고 SSE(GET /api/reports/{id}/events)로 이어 받는다.
// SSE가 끊기거나 안 되면 Snapshot을 3초 간격으로 다시 받는다. SSE는 상태의 저장소가 아니다 (DB가 원본).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiError, api } from "./client";
import { keys, POLL } from "./queries";
import { sampleRecoveryStats, sampleScreening } from "../lib/reportSamples";
import type {
  ChaosRequest,
  RecoveryStats,
  ReportDetail,
  ReportQuota,
  ReportStatus,
  ScreeningResult,
  SharedState,
  TraceEvent,
} from "./types";

/** 화면에 보이는 전달 방식: 실시간 SSE / Snapshot(폴링·완료된 기록) / 대기(실행 전이라 연결하지 않음). */
export type Delivery = "sse" | "snapshot" | "idle";

export const isFinished = (status: ReportStatus) => status === "completed" || status === "failed";

/** SSE를 열지. 끝났으면 Snapshot에 다 있고, Agent 구현 전에 신청만 된 리포트는 바뀔 것이 없다. */
export function wantsStream(r: ReportDetail): boolean {
  if (isFinished(r.status)) return false;
  return r.plan.implemented || r.status !== "requested";
}

/** Trace를 step 기준으로 합친다 (같은 step은 한 번만, 먼저 있던 것을 둔다. step 오름차순). */
export function mergeTrace(base: TraceEvent[], extra: TraceEvent[]): TraceEvent[] {
  const byStep = new Map<number, TraceEvent>();
  for (const e of [...base, ...extra]) if (!byStep.has(e.step)) byStep.set(e.step, e);
  return [...byStep.values()].sort((a, b) => a.step - b.step);
}

const lastStep = (trace: TraceEvent[]) => trace.reduce((m, e) => Math.max(m, e.step), 0);

function parse<T>(ev: Event): T | null {
  try {
    return JSON.parse((ev as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

/** 리포트 상세: Snapshot + SSE 합치기. 전달 방식(delivery)도 돌려준다. */
export function useReportLive(id: number) {
  const qc = useQueryClient();
  // 지금 열려 있는 SSE 연결 상태 (리포트 번호별). open이면 폴링을 멈춘다.
  const [conn, setConn] = useState<{ id: number; open: boolean } | null>(null);

  const query = useQuery({
    queryKey: keys.report(id),
    queryFn: async () => {
      const fresh = await api.get<ReportDetail>(`/api/reports/${id}`);
      // 요청 중에 SSE로 먼저 받은 사건이 덮어써져 사라지지 않게 합친다
      const cur = qc.getQueryData<ReportDetail>(keys.report(id));
      return cur ? { ...fresh, trace: mergeTrace(fresh.trace, cur.trace) } : fresh;
    },
    enabled: Number.isFinite(id),
    refetchInterval: (q) => {
      const r = q.state.data;
      const sseOpen = conn?.id === id && conn.open;
      return r && wantsStream(r) && !sseOpen ? POLL.report : false;
    },
    refetchIntervalInBackground: false,
  });

  const report = query.data;
  const stream = report ? wantsStream(report) : false;

  useEffect(() => {
    if (!stream || typeof EventSource === "undefined") return;
    const key = keys.report(id);
    const after = lastStep(qc.getQueryData<ReportDetail>(key)?.trace ?? []);
    const es = new EventSource(`/api/reports/${id}/events?after=${after}`);
    const update = (fn: (r: ReportDetail) => ReportDetail) =>
      qc.setQueryData<ReportDetail>(key, (r) => (r ? fn(r) : r));

    es.addEventListener("open", () => setConn({ id, open: true }));
    // 끊기면 브라우저가 Last-Event-ID로 다시 붙는다. 그동안은 Snapshot 폴링으로 메운다.
    es.addEventListener("error", () => setConn({ id, open: false }));
    es.addEventListener("trace", (ev) => {
      const e = parse<TraceEvent>(ev);
      if (e) update((r) => ({ ...r, trace: mergeTrace(r.trace, [e]) }));
    });
    es.addEventListener("state", (ev) => {
      const s = parse<SharedState>(ev);
      if (!s) return;
      // 서버는 종료 상태를 남은 trace·end보다 먼저 보낸다. 여기서 종료를 반영하면 stream이 꺼져 연결이 닫히고
      // 마지막 사건과 본문을 받지 못한다. 종료 상태는 end에서 반영한다.
      const status = isFinished(s.status) ? null : s.status;
      update((r) => ({
        ...r,
        state: { ...s, status: status ?? r.state.status },
        status: status ?? r.status,
        currentStep: s.currentStep,
      }));
    });
    es.addEventListener("end", (ev) => {
      es.close();
      const d = parse<{ status: ReportStatus }>(ev);
      if (d) update((r) => ({ ...r, status: d.status, state: { ...r.state, status: d.status } }));
      // 본문·종료 시각은 Snapshot으로 한 번 더 받는다
      void qc.invalidateQueries({ queryKey: key });
    });
    return () => es.close();
  }, [id, stream, qc]);

  let delivery: Delivery = "snapshot";
  if (report && !stream && !isFinished(report.status)) delivery = "idle";
  else if (stream && conn?.id === id && conn.open) delivery = "sse";

  return { ...query, delivery };
}

/**
 * 리포트 신청. 같은 사람이 같은 종목으로 신청해 아직 끝나지 않은 리포트가 있으면 서버가 그것을 돌려준다.
 * 하루 한도를 넘으면 429 — ApiError.num("limit")·num("used")로 읽는다 (그때 한도도 다시 받는다).
 */
export function useRequestReport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, chaos }: { symbol: string; chaos?: ChaosRequest | null }) =>
      api.post<ReportDetail>("/api/reports", chaos?.enabled ? { symbol, chaos } : { symbol }),
    onSuccess: (r) => {
      qc.setQueryData(keys.report(r.id), r);
      void qc.invalidateQueries({ queryKey: ["reports"] }); // 목록과 한도(keys.reportQuota)
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 429) void qc.invalidateQueries({ queryKey: keys.reportQuota });
    },
  });
}

/** 오늘 내 리포트 한도 ("오늘 ○번 더 만들 수 있어요"). 신청하면 useRequestReport가 다시 받게 한다. */
export function useReportQuota(enabled = true) {
  return useQuery({
    queryKey: keys.reportQuota,
    queryFn: () => api.get<ReportQuota>("/api/reports/quota"),
    enabled,
    staleTime: 30_000,
  });
}

/** 서버에 그 API가 아직 없으면(404) 예시 데이터를 돌려준다. example이면 화면이 "예시" 표시를 붙인다. */
async function orSample<T>(path: string, sample: () => T): Promise<{ data: T; example: boolean }> {
  try {
    return { data: await api.get<T>(path), example: false };
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return { data: sample(), example: true };
    throw e;
  }
}

/** 복구 지표 (GET /api/reports/recovery-stats). */
export function useRecoveryStats(days: number) {
  return useQuery({
    queryKey: ["reports", "recovery-stats", days],
    queryFn: () => orSample<RecoveryStats>(`/api/reports/recovery-stats?days=${days}`, () => sampleRecoveryStats(days)),
  });
}

/** 오늘의 선별 결과 (GET /api/reports/screening). */
export function useScreening() {
  return useQuery({
    queryKey: ["reports", "screening"],
    queryFn: () => orSample<ScreeningResult>("/api/reports/screening?market=KR", sampleScreening),
  });
}
