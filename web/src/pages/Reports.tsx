import { Link, useNavigate, useSearchParams } from "react-router";
import type { ReportList } from "../api";
import { queryString } from "../api";
import { Empty, Loaded, PageHeader, Select } from "../components/ui";
import { DASH, REPORT_STATUS_LABEL, SOURCE_LABEL, TEAM_LABEL, fmtMs, fmtTime, fmtUsd } from "../format";
import { POLL_SLOW, useApi } from "../hooks";

const DAYS = [1, 7, 30, 90];
const KINDS = [
  { value: "all", label: "전체 (장애·실패·주입)" },
  { value: "failed", label: "실패" },
  { value: "recovered", label: "복구됨" },
  { value: "chaos", label: "장애 주입" },
];
const TEAMS = [
  { value: "", label: "전체" },
  { value: "stock_report", label: TEAM_LABEL.stock_report },
  { value: "stock_selection", label: TEAM_LABEL.stock_selection },
];

export default function Reports() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const rawDays = Number(params.get("days"));
  const days = DAYS.includes(rawDays) ? rawDays : 7;
  const rawKind = params.get("kind") ?? "all";
  const kind = KINDS.some((k) => k.value === rawKind) ? rawKind : "all";
  const rawTeam = params.get("team") ?? "";
  const team = TEAMS.some((t) => t.value === rawTeam) ? rawTeam : "";

  const q = useApi<ReportList>(`/api/admin/reports${queryString({ days, kind, team, limit: 100 })}`, POLL_SLOW);

  function set(key: "days" | "kind" | "team", value: string) {
    const next = new URLSearchParams(params);
    if (value === "") next.delete(key);
    else next.set(key, value);
    setParams(next);
  }

  return (
    <>
      <PageHeader title="리포트 장애">
        <Select label="기간" value={days} options={DAYS.map((d) => ({ value: d, label: `${d}일` }))} onChange={(v) => set("days", v)} />
        <Select label="종류" value={kind} options={KINDS} onChange={(v) => set("kind", v)} />
        <Select label="팀" value={team} options={TEAMS} onChange={(v) => set("team", v)} />
      </PageHeader>
      <Loaded q={q}>
        {(d) =>
          d.results.length === 0 ? (
            <Empty>조건에 맞는 리포트가 없습니다.</Empty>
          ) : (
            <>
              <p className="muted">{d.count}건 · 기간 {d.from} ~ {d.to} (KST)</p>
              <table className="clickable">
                <thead>
                  <tr>
                    <th>번호</th>
                    <th>시각</th>
                    <th>종목</th>
                    <th>팀</th>
                    <th>출처</th>
                    <th>상태</th>
                    <th>장애 주입</th>
                    <th>실패 사유</th>
                    <th title="장애 / 복구 / 미복구">장애/복구/미복구</th>
                    <th>비용</th>
                    <th>걸린 시간</th>
                  </tr>
                </thead>
                <tbody>
                  {d.results.map((r) => (
                    <tr key={r.id} onClick={() => navigate(`/reports/${r.id}`)}>
                      <td>
                        <Link to={`/reports/${r.id}`} onClick={(e) => e.stopPropagation()}>
                          #{r.id}
                        </Link>
                      </td>
                      <td>{fmtTime(r.createdAt)}</td>
                      <td>
                        {r.name} <span className="muted">{r.symbol}</span>
                      </td>
                      <td>{TEAM_LABEL[r.team]}</td>
                      <td>{SOURCE_LABEL[r.source]}</td>
                      <td>
                        <span className={r.status === "failed" ? "down-text" : undefined}>{REPORT_STATUS_LABEL[r.status]}</span>
                      </td>
                      <td>{r.chaos ? `예 (${r.injected}건)` : DASH}</td>
                      <td>{r.failReason ? <code>{r.failReason}</code> : DASH}</td>
                      <td className="num">
                        {r.failures} / {r.recovered} / <span className={r.unrecovered > 0 ? "down-text" : undefined}>{r.unrecovered}</span>
                      </td>
                      <td className="num">{fmtUsd(r.costUsd)}</td>
                      <td className="num">{fmtMs(r.durationMs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        }
      </Loaded>
    </>
  );
}
