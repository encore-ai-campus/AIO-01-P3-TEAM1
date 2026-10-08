import { useState } from "react";
import type { DeployRecord, Deploys as DeploysData } from "../api";
import { Empty, LevelBadge, Loaded, PageHeader, Select } from "../components/ui";
import { DASH, DEPLOY_RESULT_LABEL, DEPLOY_RESULT_LEVEL, fmtTime, shortTag } from "../format";
import { POLL_SLOW, useApi } from "../hooks";

const LIMITS = [20, 50, 100, 200].map((n) => ({ value: n, label: `${n}건` }));

function Tag({ tag }: { tag: string | null }) {
  return tag ? <code title={tag}>{shortTag(tag)}</code> : <>{DASH}</>;
}

const safeUrl = (u: string) => /^https?:\/\//i.test(u);

function Result({ r }: { r: DeployRecord["result"] }) {
  return <LevelBadge level={DEPLOY_RESULT_LEVEL[r]} label={DEPLOY_RESULT_LABEL[r]} />;
}

export default function Deploys() {
  const [limit, setLimit] = useState(50);
  const q = useApi<DeploysData>(`/api/admin/deploys?limit=${limit}`, POLL_SLOW);
  return (
    <>
      <PageHeader title="배포 기록">
        <Select label="표시 개수" value={limit} options={LIMITS} onChange={(v) => setLimit(Number(v))} />
      </PageHeader>
      <Loaded q={q}>
        {(d) => (
          <>
            <h2>서버별 지금 버전</h2>
            {d.servers.length === 0 ? (
              <Empty>배포 기록이 없습니다.</Empty>
            ) : (
              <table className="narrow">
                <thead>
                  <tr>
                    <th>서버</th>
                    <th>지금 버전</th>
                    <th>정한 시각</th>
                    <th>가장 최근 기록</th>
                  </tr>
                </thead>
                <tbody>
                  {d.servers.map((s) => (
                    <tr key={s.server}>
                      <td>{s.server}</td>
                      <td>
                        <Tag tag={s.current} />
                      </td>
                      <td>{fmtTime(s.currentAt)}</td>
                      <td>
                        <Result r={s.last.result} /> <span className="muted">{fmtTime(s.last.at)}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h2>
              배포 기록 <span className="muted">(전체 {d.total}건 중 {d.records.length}건)</span>
            </h2>
            {d.records.length === 0 ? (
              <Empty>배포 기록이 없습니다.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>시각</th>
                    <th>서버</th>
                    <th>결과</th>
                    <th>태그</th>
                    <th>직전</th>
                    <th>누가</th>
                    <th>커밋</th>
                    <th>실행</th>
                  </tr>
                </thead>
                <tbody>
                  {d.records.map((r, i) => (
                    <tr key={`${r.at}-${r.server}-${i}`}>
                      <td>{fmtTime(r.at)}</td>
                      <td>{r.server}</td>
                      <td>
                        <Result r={r.result} />
                      </td>
                      <td>
                        <Tag tag={r.tag} />
                      </td>
                      <td>
                        <Tag tag={r.previous} />
                      </td>
                      <td>{r.actor ?? DASH}</td>
                      <td className="wrap">{r.commit ?? DASH}</td>
                      <td>
                        {r.runUrl && safeUrl(r.runUrl) ? (
                          <a href={r.runUrl} target="_blank" rel="noreferrer noopener">
                            열기
                          </a>
                        ) : (
                          DASH
                        )}
                      </td>
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
