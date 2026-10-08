import { useState } from "react";
import type { Alerts as AlertsData } from "../api";
import { Empty, LevelBadge, Loaded, PageHeader, Select, Stat } from "../components/ui";
import { DASH, fmtAge, fmtTime } from "../format";
import { POLL_SLOW, useApi } from "../hooks";

const HOURS = [24, 72, 168].map((h) => ({ value: h, label: h === 168 ? "7일 (168시간)" : `${h}시간` }));
const STATUS_LABEL = { failed: "실패", pending: "대기", sending: "발송 중" } as const;

export default function Alerts() {
  const [hours, setHours] = useState(24);
  const q = useApi<AlertsData>(`/api/admin/alerts?hours=${hours}`, POLL_SLOW);
  return (
    <>
      <PageHeader title="알림·작업 실패">
        <Select label="기간" value={hours} options={HOURS} onChange={(v) => setHours(Number(v))} />
      </PageHeader>
      <Loaded q={q}>
        {(d) => (
          <>
            <p>
              전체 <LevelBadge level={d.level} />
            </p>
            <h2>Discord 발송</h2>
            <div className="stats">
              <Stat label="발송 실패" value={d.discord.failed} level={d.discord.failed > 0 ? "warn" : undefined} sub={`최근 ${d.hours}시간`} />
              <Stat label="오래된 대기" value={d.discord.pendingOld} level={d.discord.pendingOld > 0 ? "warn" : undefined} sub="10분 넘게 pending" />
              <Stat label="멈춘 발송" value={d.discord.sendingStuck} level={d.discord.sendingStuck > 0 ? "warn" : undefined} sub="10분 넘게 sending" />
            </div>
            {d.discord.rows.length === 0 ? (
              <Empty>문제가 있는 발송이 없습니다.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>번호</th>
                    <th>종류</th>
                    <th>상태</th>
                    <th>시도</th>
                    <th>만든 시각</th>
                    <th>경과</th>
                    <th>마지막 오류</th>
                  </tr>
                </thead>
                <tbody>
                  {d.discord.rows.map((r) => (
                    <tr key={r.id}>
                      <td>#{r.id}</td>
                      <td>
                        <code>{r.kind}</code>
                      </td>
                      <td>
                        <LevelBadge level={r.status === "failed" ? "down" : "warn"} label={STATUS_LABEL[r.status]} />
                      </td>
                      <td className="num">{r.attempts}</td>
                      <td>{fmtTime(r.createdAt)}</td>
                      <td>{fmtAge(r.ageSec)}</td>
                      <td className="wrap">{r.lastError ?? DASH}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h2>멈춘 작업</h2>
            {d.stuck.length === 0 ? (
              <Empty>오래 멈춰 있는 작업이 없습니다.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>종류</th>
                    <th>번호</th>
                    <th>작업</th>
                    <th>상태</th>
                    <th>그 상태가 된 시각</th>
                    <th>경과</th>
                  </tr>
                </thead>
                <tbody>
                  {d.stuck.map((s) => (
                    <tr key={`${s.kind}-${s.id}`}>
                      <td>{s.kind === "analysis" ? "분석" : "리포트"}</td>
                      <td>#{s.id}</td>
                      <td>{s.label}</td>
                      <td>
                        <code>{s.status}</code>
                      </td>
                      <td>{fmtTime(s.since)}</td>
                      <td>{fmtAge(s.ageSec)}</td>
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
