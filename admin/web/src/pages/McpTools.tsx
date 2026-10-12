import { useState } from "react";
import type { McpCall, McpStatus } from "../api";
import { Empty, LevelBadge, Loaded, PageHeader, Select, Stat } from "../components/ui";
import { DASH, fmtTime } from "../format";
import { POLL_FAST, useApi } from "../hooks";

const HOURS = [24, 72, 168].map((h) => ({ value: h, label: h === 168 ? "7일 (168시간)" : `${h}시간` }));
const OUTSIDE = "__outside__";

/** 도구 이름. 도구 밖 요청은 MCP 서버의 토큰 확인(/api/admin/me)인지 그 밖인지 적는다. */
function ToolName({ c }: { c: McpCall }) {
  if (c.tool) return <code>{c.tool}</code>;
  return <span className="muted">{c.path === "/api/admin/me" ? "토큰 확인" : "도구 밖 요청"}</span>;
}

function Status({ c }: { c: McpCall }) {
  return <LevelBadge level={c.ok ? "ok" : c.status === 401 ? "down" : "warn"} label={String(c.status)} />;
}

export default function McpTools() {
  const [hours, setHours] = useState(24);
  const [tool, setTool] = useState("");
  const q = useApi<McpStatus>(`/api/admin/mcp?hours=${hours}&limit=500`, POLL_FAST);
  return (
    <>
      <PageHeader title="MCP 도구·호출">
        <Select label="기간" value={hours} options={HOURS} onChange={(v) => setHours(Number(v))} />
      </PageHeader>
      <Loaded q={q}>
        {(d) => {
          const url = `${window.location.origin}${d.endpoint}`;
          const perTool = new Map(d.summary.byTool.map((b) => [b.tool, b]));
          const toolOptions = [
            { value: "", label: "전체" },
            ...d.tools.map((t) => ({ value: t.name, label: t.name })),
            { value: OUTSIDE, label: "도구 밖 요청 (토큰 확인 등)" },
          ];
          const calls = d.calls.filter((c) => !tool || (tool === OUTSIDE ? c.tool === null : c.tool === tool));
          return (
            <>
              <h2>연결</h2>
              <p>
                주소 <code>{url}</code> · 사람마다 따로 만든 토큰을 <code>Authorization: Bearer</code> 헤더로 보낸다. 모든 도구는 조회만 한다.
              </p>
              <pre className="wrap">
                <code>{`claude mcp add --transport http paper-admin ${url} --header "Authorization: Bearer <토큰>"`}</code>
              </pre>
              <p className="muted">
                토큰 만들기·지우기는 관리 서버에서: <code>python -m paper_admin.tokens add|list|revoke &lt;이름&gt;</code> (README 3장, 원문은 만들 때 한 번만 보인다)
              </p>

              <div className="stats">
                <Stat label="도구 호출" value={d.summary.calls} sub={`최근 ${d.hours}시간`} />
                <Stat label="실패 응답" value={d.summary.errors} sub="400 이상" level={d.summary.errors ? "warn" : "ok"} />
                <Stat label="틀린 토큰" value={d.summary.invalid} sub="401 (누구인지 모름)" level={d.summary.invalid ? "warn" : "ok"} />
              </div>

              <h2>
                도구 목록 <span className="muted">({d.tools.length}개)</span>
              </h2>
              <table>
                <thead>
                  <tr>
                    <th>도구</th>
                    <th>설명</th>
                    <th>부르는 관리자 API</th>
                    <th>인자</th>
                    <th className="num">호출 (실패)</th>
                  </tr>
                </thead>
                <tbody>
                  {d.tools.map((t) => {
                    const b = perTool.get(t.name);
                    return (
                      <tr key={t.name}>
                        <td>
                          <code>{t.name}</code>
                        </td>
                        <td className="wrap">{t.description}</td>
                        <td>
                          <code>{t.path}</code>
                        </td>
                        <td>{t.params.length ? t.params.join(", ") : DASH}</td>
                        <td className="num">{b ? `${b.calls} (${b.errors})` : "0"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              <h2>
                토큰 <span className="muted">({d.tokens.length}개)</span>
              </h2>
              {d.tokens.length === 0 ? (
                <Empty>만든 토큰이 없습니다. 관리 서버에서 python -m paper_admin.tokens add &lt;이름&gt;으로 만든다.</Empty>
              ) : (
                <table className="narrow">
                  <thead>
                    <tr>
                      <th>이름</th>
                      <th>만든 시각</th>
                      <th>마지막 사용</th>
                      <th className="num">호출</th>
                      <th className="num">실패</th>
                    </tr>
                  </thead>
                  <tbody>
                    {d.tokens.map((t) => (
                      <tr key={t.name}>
                        <td>{t.name}</td>
                        <td>{fmtTime(t.createdAt)}</td>
                        <td>{t.lastUsedAt ? fmtTime(t.lastUsedAt) : "쓴 적 없음"}</td>
                        <td className="num">{t.calls}</td>
                        <td className="num">{t.errors}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <h2>
                호출 기록 <span className="muted">(최근 {d.hours}시간, {calls.length}건)</span>
              </h2>
              <div className="page-tools">
                <Select label="도구" value={tool} options={toolOptions} onChange={(v) => setTool(String(v))} />
              </div>
              {calls.length === 0 ? (
                <Empty>기간 안에 토큰으로 들어온 요청이 없습니다.</Empty>
              ) : (
                <table>
                  <thead>
                    <tr>
                      <th>시각</th>
                      <th>누가</th>
                      <th>도구</th>
                      <th>경로</th>
                      <th>응답</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calls.map((c, i) => (
                      <tr key={`${c.at}-${i}`}>
                        <td>{fmtTime(c.at)}</td>
                        <td>{c.who ?? <span className="down-text">틀린 토큰</span>}</td>
                        <td>
                          <ToolName c={c} />
                        </td>
                        <td>
                          <code>{c.path}</code>
                        </td>
                        <td>
                          <Status c={c} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          );
        }}
      </Loaded>
    </>
  );
}
