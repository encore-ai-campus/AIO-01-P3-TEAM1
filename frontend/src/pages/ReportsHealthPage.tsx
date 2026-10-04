// /reports/health: 복구 지표 (GET /api/reports/recovery-stats의 RecoveryStats를 그대로 그린다. 셈법은 docs/tasks/00-공통.md 9절).
import { useId, useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useReportPlan } from "../api/queries";
import { useRecoveryStats } from "../api/reports";
import type { RecoveryStats } from "../api/types";
import { ExampleTag, InjectedBadge } from "../components/reports/StatusChip";
import { Card, EmptyState, ErrorState, PageHeader, Segmented, SkeletonCard } from "../components/ui";
import { cn } from "../lib/cn";
import { formatDateTime, formatLatency } from "../lib/format";
import { ERROR_LABEL, actorLabel } from "../lib/reports";

const DAYS = ["7", "30", "90"] as const;
type Days = (typeof DAYS)[number];

const formatRate = (rate: number | null) => (rate === null ? "-" : `${rate.toFixed(1)}%`);

function Big({ label, value, sub, tone }: { label: string; value: string; sub: string; tone?: "ok" }) {
  return (
    <Card className="py-4">
      <p className="text-[13px] text-mute">{label}</p>
      <p className={cn("mt-0.5 text-[32px] leading-tight font-bold tracking-tight tabular-nums", tone === "ok" && "text-ok")}>{value}</p>
      <p className="mt-1 text-[13px] text-sub">{sub}</p>
    </Card>
  );
}

/** 누적 가로 막대: 복구(초록) + 미복구(빨강). 길이는 가장 많은 건수 기준. 수치를 글자로도 적는다. */
function Bars({ title, rows }: { title: string; rows: { label: string; failures: number; recovered: number }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.failures));
  const id = useId();
  return (
    <Card aria-labelledby={id}>
      <h2 id={id} className="text-[17px] font-bold">
        {title}
      </h2>
      <p className="mt-0.5 flex flex-wrap items-center gap-x-3 text-[12px] text-mute">
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm bg-ok" /> 복구
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block size-2.5 rounded-sm bg-up" /> 미복구
        </span>
      </p>
      <ul className="mt-3 space-y-3">
        {rows.map((r) => (
          <li key={r.label}>
            <div className="flex justify-between gap-2 text-[14px]">
              <span className="font-semibold">{r.label}</span>
              <span className="text-sub tabular-nums">
                복구 {r.recovered} · 미복구 {r.failures - r.recovered}
              </span>
            </div>
            <div aria-hidden="true" className="mt-1 flex h-3 overflow-hidden rounded-full bg-fill">
              <div className="bg-ok" style={{ width: `${(r.recovered / max) * 100}%` }} />
              <div className="bg-up" style={{ width: `${((r.failures - r.recovered) / max) * 100}%` }} />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Outcome({ recovered }: { recovered: boolean }) {
  return (
    <span className={cn("inline-flex h-6 items-center rounded-md px-1.5 text-[12px] font-bold", recovered ? "bg-ok-soft text-ok" : "bg-up-soft text-up")}>
      {recovered ? "복구" : "미복구"}
    </span>
  );
}

function Recent({ rows, worker }: { rows: RecoveryStats["recent"]; worker: (id: string) => string }) {
  return (
    <Card aria-labelledby="recent-title" className="px-0 pb-2">
      <h2 id="recent-title" className="px-5 text-[17px] font-bold">
        최근 사례
      </h2>
      {/* 모바일: 카드 목록 */}
      <ul aria-label="최근 장애 사례" className="mt-2 divide-y divide-line lg:hidden">
        {rows.map((x, i) => (
          <li key={i}>
            <Link to={`/reports/${x.reportId}?tab=run`} className="block px-5 py-3 hover:bg-fill/60">
              <span className="flex flex-wrap items-center gap-1.5 text-[15px] font-semibold">
                {worker(x.worker)}
                <Outcome recovered={x.recovered} />
                {x.injected && <InjectedBadge />}
              </span>
              <span className="mt-0.5 block text-[13px] text-mute">
                {x.symbol} · {ERROR_LABEL[x.errorType]}
                {x.recovered && ` · ${formatLatency(x.recoveryMs)} 만에 복구`} · {formatDateTime(x.at)}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {/* PC: 표 */}
      <div className="mt-2 hidden px-5 lg:block">
        <table className="w-full text-left text-[14px]">
          <thead className="text-[13px] text-mute">
            <tr className="border-b border-line">
              {["시각", "종목", "Worker", "유형", "결과", "복구 시간", ""].map((h) => (
                <th key={h} className="py-2 font-semibold">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((x, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="py-2 tabular-nums">{formatDateTime(x.at)}</td>
                <td>{x.symbol}</td>
                <td>{worker(x.worker)}</td>
                <td>
                  <span className="flex items-center gap-1">
                    {ERROR_LABEL[x.errorType]}
                    {x.injected && <InjectedBadge />}
                  </span>
                </td>
                <td>
                  <Outcome recovered={x.recovered} />
                </td>
                <td className="tabular-nums">{formatLatency(x.recoveryMs)}</td>
                <td className="text-right">
                  <Link to={`/reports/${x.reportId}?tab=run`} className="font-semibold text-brand">
                    리포트 #{x.reportId}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function ReportsHealthPage() {
  const [days, setDays] = useState<Days>("7");
  const { data, isPending, isError, error, refetch } = useRecoveryStats(Number(days));
  const { data: plan } = useReportPlan();
  const worker = (id: string) => actorLabel(plan, id);
  const s = data?.data;

  return (
    <>
      <PageHeader title="복구 지표" back />
      <div className="space-y-3 lg:space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented label="기간" value={days} onChange={setDays} options={DAYS.map((d) => ({ value: d, label: `${d}일` }))} />
          {data?.example && (
            <span className="flex items-center gap-1.5 text-[13px] text-mute">
              <ExampleTag /> 서버에 지표 API가 아직 없어 예시 수치를 보여 줍니다
            </span>
          )}
        </div>
        {isPending ? (
          <SkeletonCard lines={5} />
        ) : isError ? (
          <Card>
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          </Card>
        ) : !s || s.failures === 0 ? (
          <Card>
            <EmptyState>아직 장애가 없습니다.</EmptyState>
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:gap-4">
              <Big label="자동 복구율" value={formatRate(s.autoRecoveryRate)} sub={`장애 ${s.failures}건 중 ${s.recovered}건 복구 · 미복구 ${s.unrecovered}`} tone="ok" />
              <Big label="평균 복구시간" value={formatLatency(s.meanRecoveryMs)} sub={`리포트 ${s.reports}건 중 ${s.reportsWithFailures}건에 장애 · 주입 ${s.injected}건`} />
            </div>
            <div className="grid gap-3 lg:grid-cols-2 lg:gap-4">
              <Bars title="장애 유형별" rows={s.byErrorType.map((x) => ({ label: ERROR_LABEL[x.errorType], failures: x.failures, recovered: x.recovered }))} />
              <Bars title="Worker별" rows={s.byWorker.map((x) => ({ label: worker(x.worker), failures: x.failures, recovered: x.recovered }))} />
            </div>
            <Recent rows={s.recent} worker={worker} />
          </>
        )}
      </div>
    </>
  );
}
