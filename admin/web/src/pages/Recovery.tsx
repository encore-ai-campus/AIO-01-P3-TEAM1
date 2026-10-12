import { useState } from "react";
import { Link } from "react-router";
import type { RecoveryStats } from "../api";
import { Empty, Loaded, PageHeader, Select, Stat } from "../components/ui";
import { DASH, fmtMs, fmtPct, fmtTime } from "../format";
import { POLL_SLOW, useApi } from "../hooks";

const DAYS = [1, 7, 30, 90].map((d) => ({ value: d, label: `${d}일` }));

function Breakdown({ title, nameHeader, rows }: { title: string; nameHeader: string; rows: { name: string; failures: number; recovered: number }[] }) {
  return (
    <div>
      <h2>{title}</h2>
      {rows.length === 0 ? (
        <Empty>장애가 없습니다.</Empty>
      ) : (
        <table className="narrow">
          <thead>
            <tr>
              <th>{nameHeader}</th>
              <th>장애</th>
              <th>복구</th>
              <th>복구율</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.name}>
                <td>
                  <code>{r.name}</code>
                </td>
                <td className="num">{r.failures}</td>
                <td className="num">{r.recovered}</td>
                <td className="num">{r.failures ? fmtPct(Math.round((r.recovered / r.failures) * 1000) / 10) : DASH}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function Recovery() {
  const [days, setDays] = useState(7);
  const q = useApi<RecoveryStats>(`/api/admin/recovery?days=${days}`, POLL_SLOW);
  return (
    <>
      <PageHeader title="복구 지표">
        <Select label="기간" value={days} options={DAYS} onChange={(v) => setDays(Number(v))} />
      </PageHeader>
      <Loaded q={q}>
        {(d) => (
          <>
            <div className="stats">
              <Stat
                label="호출 장애 자동 복구율"
                value={fmtPct(d.autoRecoveryRate)}
                sub={d.autoRecoveryRate == null ? "장애 없음" : "복구 ÷ 장애"}
                level={d.autoRecoveryRate == null ? undefined : d.unrecovered > 0 ? "warn" : "ok"}
              />
              <Stat label="평균 복구 시간" value={fmtMs(d.meanRecoveryMs)} />
              <Stat label="장애" value={d.failures} sub={`리포트 ${d.reports}건 중 ${d.reportsWithFailures}건`} />
              <Stat label="복구" value={d.recovered} />
              <Stat label="미복구" value={d.unrecovered} level={d.unrecovered > 0 ? "down" : undefined} />
              <Stat label="장애 주입" value={d.injected} />
            </div>
            <div className="two-col">
              <Breakdown
                title="errorType별"
                nameHeader="errorType"
                rows={d.byErrorType.map((r) => ({ name: r.errorType, failures: r.failures, recovered: r.recovered }))}
              />
              <Breakdown title="Worker별" nameHeader="Worker" rows={d.byWorker.map((r) => ({ name: r.worker, failures: r.failures, recovered: r.recovered }))} />
            </div>
            <h2>최근 장애 (최대 20건)</h2>
            {d.recent.length === 0 ? (
              <Empty>최근 장애가 없습니다.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>첫 실패 시각</th>
                    <th>리포트</th>
                    <th>종목</th>
                    <th>Worker</th>
                    <th>errorType</th>
                    <th>주입</th>
                    <th>복구</th>
                    <th>복구 시간</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recent.map((r, i) => (
                    <tr key={`${r.reportId}-${r.worker}-${i}`}>
                      <td>{fmtTime(r.at)}</td>
                      <td>
                        <Link to={`/reports/${r.reportId}`}>#{r.reportId}</Link>
                      </td>
                      <td>{r.symbol}</td>
                      <td>
                        <code>{r.worker}</code>
                      </td>
                      <td>
                        <code>{r.errorType}</code>
                      </td>
                      <td>{r.injected ? "예" : DASH}</td>
                      <td>
                        <span className={r.recovered ? "ok-text" : "down-text"}>{r.recovered ? "복구" : "미복구"}</span>
                      </td>
                      <td className="num">{fmtMs(r.recoveryMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </Loaded>
    </>
  );
}
