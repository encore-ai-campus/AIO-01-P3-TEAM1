import { Link, useParams } from "react-router";
import type { ReportTrace, TraceItem } from "../api";
import { LevelBadge, Loaded, PageHeader, Stat } from "../components/ui";
import {
  DASH,
  REPORT_STATUS_LABEL,
  SOURCE_LABEL,
  TEAM_LABEL,
  TRACE_KIND_LABEL,
  TRACE_KIND_LEVEL,
  fmtMs,
  fmtTime,
  fmtUsd,
} from "../format";
import { POLL_SLOW, useApi } from "../hooks";

const str = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** details에서 errorType · from→to · reason · attempt를 한 줄로 만들고, 나머지는 따로 돌려준다. */
export function summarizeDetails(details: Record<string, unknown>): { line: string; rest: Record<string, unknown> } {
  const rest = { ...details };
  const parts: string[] = [];
  if ("errorType" in rest) {
    parts.push(`errorType ${str(rest.errorType)}`);
    delete rest.errorType;
  }
  if ("from" in rest || "to" in rest) {
    parts.push(`${rest.from == null ? DASH : str(rest.from)} → ${rest.to == null ? DASH : str(rest.to)}`);
    delete rest.from;
    delete rest.to;
  }
  if ("reason" in rest) {
    parts.push(`reason ${str(rest.reason)}`);
    delete rest.reason;
  }
  if ("attempt" in rest) {
    parts.push(`attempt ${str(rest.attempt)}`);
    delete rest.attempt;
  }
  return { line: parts.join(" · "), rest };
}

function Row({ e }: { e: TraceItem }) {
  const { line, rest } = summarizeDetails(e.details);
  const hasRest = Object.keys(rest).length > 0;
  return (
    <tr>
      <td className="num">{e.step}</td>
      <td>{fmtTime(e.at)}</td>
      <td>
        <code>{e.actor}</code>
      </td>
      <td>
        <code>{e.action}</code>
      </td>
      <td>
        <LevelBadge level={TRACE_KIND_LEVEL[e.kind]} label={TRACE_KIND_LABEL[e.kind]} />
      </td>
      <td>{e.model ? `${e.provider ? `${e.provider}/` : ""}${e.model}` : DASH}</td>
      <td className="num">{fmtMs(e.latencyMs)}</td>
      <td className="wrap">
        {line || (hasRest ? "" : DASH)}
        {hasRest && (
          <details>
            <summary>자세히</summary>
            <pre>{JSON.stringify(rest, null, 2)}</pre>
          </details>
        )}
      </td>
    </tr>
  );
}

export default function ReportDetail() {
  const { id } = useParams();
  const q = useApi<ReportTrace>(`/api/admin/reports/${encodeURIComponent(id ?? "")}/trace`, POLL_SLOW);
  return (
    <>
      <PageHeader title={`리포트 #${id}`}>
        <Link to="/reports">← 목록</Link>
      </PageHeader>
      <Loaded q={q}>
        {({ report: r, recovery: rc, events }) => (
          <>
            <div className="stats">
              <Stat label="종목" value={`${r.name} ${r.symbol}`} sub={`${TEAM_LABEL[r.team]} · ${SOURCE_LABEL[r.source]}`} />
              <Stat label="상태" value={REPORT_STATUS_LABEL[r.status]} level={r.status === "failed" ? "down" : undefined} sub={r.failReason ?? undefined} />
              <Stat label="장애 주입" value={r.chaos ? "켜짐" : DASH} />
              <Stat label="비용" value={fmtUsd(r.costUsd)} sub={`걸린 시간 ${fmtMs(r.durationMs)}`} />
              <Stat label="만든 시각" value={fmtTime(r.createdAt)} sub={`끝 ${fmtTime(r.finishedAt)}`} />
            </div>
            <h2>복구 요약</h2>
            <div className="stats">
              <Stat label="장애" value={rc.failures} />
              <Stat label="복구" value={rc.recovered} />
              <Stat label="미복구" value={rc.unrecovered} level={rc.unrecovered > 0 ? "down" : undefined} />
              <Stat label="주입" value={rc.injected} />
              <Stat label="복구 시간 합" value={fmtMs(rc.recoveryMs)} />
            </div>
            <h2>실행 기록 (시간순)</h2>
            <table>
              <thead>
                <tr>
                  <th>step</th>
                  <th>시각</th>
                  <th>actor</th>
                  <th>action</th>
                  <th>종류</th>
                  <th>모델</th>
                  <th>latency</th>
                  <th>상세</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <Row key={e.step} e={e} />
                ))}
              </tbody>
            </table>
          </>
        )}
      </Loaded>
    </>
  );
}
