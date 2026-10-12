import type { HealthProbe, ServiceStatus } from "../api";
import { Empty, LevelBadge, Loaded, PageHeader, Stat } from "../components/ui";
import { DASH, fmtMs, fmtPct, fmtTime } from "../format";
import { POLL_FAST, useApi } from "../hooks";

function probeCells(p: HealthProbe) {
  return (
    <>
      <td>
        <span className={p.ok ? "ok-text" : "down-text"}>{p.ok ? "성공" : "실패"}</span>
      </td>
      <td className="num">{p.status ?? DASH}</td>
      <td className="num">{fmtMs(p.ms)}</td>
    </>
  );
}

export default function Service() {
  const q = useApi<ServiceStatus>("/api/admin/service", POLL_FAST);
  return (
    <>
      <PageHeader title="서비스 상태" />
      <Loaded q={q}>
        {(d) => (
          <>
            <div className="stats">
              <Stat label="지금 상태" value={<LevelBadge level={d.level} />} level={d.level} sub={d.url} />
              <Stat label="실패 시작" value={d.downSince ? fmtTime(d.downSince) : "실패 중 아님"} />
              <Stat label="24시간 가동률" value={fmtPct(d.uptimePct24h)} sub="api·page 모두 성공한 비율" />
              <Stat label="24시간 평균 응답" value={fmtMs(d.avgMs24h)} sub={`확인 간격 ${d.intervalSec}초`} />
            </div>
            <h2>최근 확인</h2>
            {d.recent.length === 0 ? (
              <Empty>아직 확인한 기록이 없습니다.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th rowSpan={2}>시각</th>
                    <th colSpan={3}>api</th>
                    <th colSpan={3}>page</th>
                    <th rowSpan={2}>오류</th>
                  </tr>
                  <tr>
                    <th>결과</th>
                    <th>코드</th>
                    <th>응답</th>
                    <th>결과</th>
                    <th>코드</th>
                    <th>응답</th>
                  </tr>
                </thead>
                <tbody>
                  {d.recent.map((c) => (
                    <tr key={c.at}>
                      <td>{fmtTime(c.at)}</td>
                      {probeCells(c.api)}
                      {probeCells(c.page)}
                      <td>{[c.api.error && `api: ${c.api.error}`, c.page.error && `page: ${c.page.error}`].filter(Boolean).join(" · ") || DASH}</td>
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
