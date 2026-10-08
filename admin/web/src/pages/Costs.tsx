import { useState } from "react";
import type { Costs as CostsData } from "../api";
import { Loaded, PageHeader, Select, Stat } from "../components/ui";
import { DASH, fmtPct, fmtUsd } from "../format";
import { POLL_SLOW, useApi } from "../hooks";

const DAYS = [7, 14, 30, 90].map((d) => ({ value: d, label: `${d}일` }));
const limitText = (v: number | null) => (v == null ? "모름" : String(v));

export default function Costs() {
  const [days, setDays] = useState(14);
  const q = useApi<CostsData>(`/api/admin/costs?days=${days}`, POLL_SLOW);
  return (
    <>
      <PageHeader title="AI 비용">
        <Select label="기간" value={days} options={DAYS} onChange={(v) => setDays(Number(v))} />
      </PageHeader>
      <Loaded q={q}>
        {(d) => {
          const t = d.today;
          const pct = t.budgetPct;
          const level = pct == null ? "unknown" : pct >= 100 ? "down" : pct >= 80 ? "warn" : "ok";
          const maxDay = Math.max(0, ...d.daily.map((x) => x.totalUsd));
          return (
            <>
              <h2>오늘 사용량 <span className="muted">({t.date})</span></h2>
              <div className="stats">
                <Stat
                  label="예산 사용 / 하루 예산"
                  value={`${fmtUsd(t.budgetUsedUsd)} / ${t.budgetUsd == null ? "모름" : fmtUsd(t.budgetUsd)}`}
                  sub={pct == null ? "예산을 몰라 비율을 낼 수 없음" : `예산의 ${fmtPct(pct)} · 닿으면 서비스가 새 리포트를 막음`}
                  level={level}
                />
                <Stat label="오늘 실제 비용" value={fmtUsd(t.totalUsd)} sub="리포트 · 분석 · 장기투자" />
                <Stat label="분석 요청" value={`${t.analyses.used} / ${limitText(t.analyses.limit)}`} sub="오늘 · 서비스 전체 한도" />
                <Stat
                  label="리포트 (한 사람 최대)"
                  value={`${t.reportsPerUser.maxUsed} / ${t.reportsPerUser.unlimited ? "무제한" : limitText(t.reportsPerUser.limit)}`}
                  sub="오늘 가장 많이 쓴 사람"
                />
              </div>
              <h2>일별 비용</h2>
              <table>
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th>리포트</th>
                    <th>분석</th>
                    <th>장기투자</th>
                    <th>합계</th>
                    <th className="bar-col">일 합계 막대 · % = 기간 합계 대비</th>
                    <th>리포트 수</th>
                    <th>분석 수</th>
                  </tr>
                </thead>
                <tbody>
                  {[...d.daily].reverse().map((x) => (
                    <tr key={x.date}>
                      <td>{x.date}</td>
                      <td className="num">{fmtUsd(x.reportsUsd)}</td>
                      <td className="num">{fmtUsd(x.analysisUsd)}</td>
                      <td className="num">{fmtUsd(x.longtermUsd)}</td>
                      <td className="num">
                        <strong>{fmtUsd(x.totalUsd)}</strong>
                      </td>
                      <td className="bar-col">
                        <div className="bar-track" title={d.totals.totalUsd ? `${((x.totalUsd / d.totals.totalUsd) * 100).toFixed(1)}%` : DASH}>
                          <div className="bar" style={{ width: maxDay ? `${(x.totalUsd / maxDay) * 100}%` : "0%" }} />
                        </div>
                        <span className="muted bar-pct">{d.totals.totalUsd ? `${((x.totalUsd / d.totals.totalUsd) * 100).toFixed(1)}%` : DASH}</span>
                      </td>
                      <td className="num">{x.reports}</td>
                      <td className="num">{x.analyses}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th>기간 합계</th>
                    <td className="num">{fmtUsd(d.totals.reportsUsd)}</td>
                    <td className="num">{fmtUsd(d.totals.analysisUsd)}</td>
                    <td className="num">{fmtUsd(d.totals.longtermUsd)}</td>
                    <td className="num">
                      <strong>{fmtUsd(d.totals.totalUsd)}</strong>
                    </td>
                    <td />
                    <td className="num">{d.daily.reduce((a, x) => a + x.reports, 0)}</td>
                    <td className="num">{d.daily.reduce((a, x) => a + x.analyses, 0)}</td>
                  </tr>
                </tfoot>
              </table>
            </>
          );
        }}
      </Loaded>
    </>
  );
}
