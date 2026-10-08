import type { EngineStatus } from "../api";
import { Empty, LevelBadge, Loaded, PageHeader, Stat } from "../components/ui";
import { DASH, fmtAge, fmtMs, fmtNum, fmtTime } from "../format";
import { POLL_FAST, useApi } from "../hooks";

const onOff = (v: boolean | null) => (v == null ? DASH : v ? "켜짐" : "꺼짐");

export default function Engine() {
  const q = useApi<EngineStatus>("/api/admin/engine", POLL_FAST);
  return (
    <>
      <PageHeader title="엔진 상태" />
      <Loaded q={q}>
        {(d) => (
          <>
            {!d.found ? (
              <div className="notice error">엔진이 남긴 상태가 없습니다 (한 번도 기록하지 않았거나 엔진이 멈춤).</div>
            ) : (
              <div className={`engine-hero lv-border-${d.level}`}>
                <div className={d.stale ? "hero-state down-text" : "hero-state ok-text"}>{d.stale ? "멈춤" : "동작 중"}</div>
                <div>
                  마지막 동작 {fmtTime(d.beatAt)} · <strong>{fmtAge(d.ageSec)} 전</strong>
                  <div className="muted">{d.staleAfterSec}초 넘게 동작이 없으면 멈춤으로 봅니다.</div>
                </div>
                <LevelBadge level={d.level} />
              </div>
            )}
            <div className="stats">
              <Stat label="버전" value={<code>{d.version ?? DASH}</code>} />
              <Stat label="호스트" value={d.host ?? DASH} />
              <Stat label="시작 시각" value={fmtTime(d.startedAt)} />
              <Stat label="새 모의 매수 중단 스위치" value={onOff(d.halted)} level={d.halted ? "warn" : undefined} />
              <Stat label="증권사 조회 키" value={d.brokerReady == null ? DASH : d.brokerReady ? "있음" : "없음"} />
              <Stat label="마지막 한 바퀴" value={fmtMs(d.lastTickMs)} />
            </div>
            <h2>한도</h2>
            {Object.keys(d.limits).length === 0 ? (
              <Empty>엔진이 알려 준 한도가 없습니다.</Empty>
            ) : (
              <table className="narrow">
                <thead>
                  <tr>
                    <th>항목</th>
                    <th>값</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(d.limits).map(([k, v]) => (
                    <tr key={k}>
                      <td>
                        <code>{k}</code>
                      </td>
                      <td className="num">{fmtNum(v)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <h2>최근 단계 오류</h2>
            {d.errors.length === 0 ? (
              <Empty>최근 단계 오류가 없습니다.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>시각</th>
                    <th>단계</th>
                    <th>오류</th>
                  </tr>
                </thead>
                <tbody>
                  {d.errors.map((e, i) => (
                    <tr key={`${e.at}-${i}`}>
                      <td>{fmtTime(e.at)}</td>
                      <td>
                        <code>{e.step}</code>
                      </td>
                      <td className="wrap">{e.error}</td>
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
