// 만드는 중인 리포트의 쉬운 진행 표시 (docs/컨셉변경계획.md 4-2): "시세를 보는 중 → 재무제표를 읽는 중 → 뉴스를 읽는 중 → 리포트를 쓰는 중 → 검토하는 중".
// 자동 복구는 숨기지 않고 쉬운 문장으로 ("뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요"). 예상 시간은 최근 완성 리포트의 중앙값(3건 미만이면 숨김).
// AI 담당자(팀 워크플로우)가 아직 연결되지 않았으면 예시 재생으로 진행 모습을 보인다 — 화면 안에서만 바뀌고 서버에는 아무것도 보내지 않는다.
import { useReports } from "../../../api/queries";
import type { ReportDetail } from "../../../api/types";
import { cn } from "../../../lib/cn";
import { REPORT_KEEPS_RUNNING } from "../../../lib/plainText";
import { useReplay, type ScenarioId } from "../../../lib/reportExamples";
import { PROGRESS_STATE_TEXT, type ProgressState, durationSentence, progressOf, recoverySentences, typicalDurationMs } from "../../../lib/reports";
import { Icon, type IconName } from "../../Icon";
import { Card, Notice } from "../../ui";
import { ExampleBanner } from "../ReplayControls";

const LOOK: Record<ProgressState, { icon: IconName; dot: string; chip: string }> = {
  waiting: { icon: "circle", dot: "bg-fill text-mute", chip: "text-mute" },
  active: { icon: "play", dot: "bg-brand text-white", chip: "text-brand-dark" },
  done: { icon: "check", dot: "bg-ok text-white", chip: "text-ok" },
  failed: { icon: "close", dot: "bg-up text-white", chip: "text-up" },
  skipped: { icon: "skip", dot: "bg-fill text-sub", chip: "text-sub" },
};

const EXAMPLES: { id: ScenarioId; label: string }[] = [
  { id: "normal", label: "예시로 보기: 보통 흐름" },
  { id: "recovery", label: "예시로 보기: AI가 늦어지는 경우" },
];

function Btn({ label, onClick, disabled, primary }: { label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "h-10 rounded-xl px-3 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-40",
        primary ? "bg-ink text-white hover:bg-sub" : "bg-fill text-ink hover:bg-line",
      )}
    >
      {label}
    </button>
  );
}

export function EasyProgress({ r }: { r: ReportDetail }) {
  const replay = useReplay(r.state.taskId || `report-${r.id}`);
  const team = useReports({});
  const ex = replay.active;
  const trace = ex ? replay.trace : r.trace;
  const steps = progressOf(trace);
  const recovery = recoverySentences(trace);
  const typical = typicalDurationMs(team.data?.results ?? []);
  const waiting = !r.plan.implemented && r.status === "requested";
  const exStatus = replay.state.status;
  const title = ex
    ? exStatus === "completed"
      ? "예시 리포트가 완성됐어요"
      : exStatus === "failed"
        ? "예시 리포트를 만들지 못했어요"
        : "예시 리포트를 만드는 중이에요"
    : r.status === "requested"
      ? "만들 차례를 기다리는 중이에요"
      : "리포트를 만드는 중이에요";

  return (
    <Card aria-labelledby="progress-title" className="space-y-3">
      {ex && <ExampleBanner />}
      <h2 id="progress-title" className="text-[18px] font-bold">
        {title}
      </h2>
      <ol aria-label="진행 단계" className="space-y-2">
        {steps.map((s) => {
          const look = LOOK[s.state];
          return (
            <li
              key={s.actor}
              aria-current={s.state === "active" ? "step" : undefined}
              className={cn("flex items-center gap-3 rounded-xl px-3 py-2.5", s.state === "active" ? "bg-brand-soft" : "bg-fill")}
            >
              <span className={cn("grid size-7 shrink-0 place-items-center rounded-full", look.dot)}>
                <Icon name={look.icon} className={cn("size-4", s.state === "active" && "animate-pulse")} />
              </span>
              <span className="min-w-0 flex-1 text-[15px] font-semibold">{s.label}</span>
              <span className={cn("shrink-0 text-[13px] font-semibold", look.chip)}>{PROGRESS_STATE_TEXT[s.state]}</span>
            </li>
          );
        })}
      </ol>
      {recovery.length > 0 && (
        <ul aria-label="자동 복구" className="space-y-1">
          {recovery.map((line) => (
            <li key={line} className="flex items-start gap-1.5 text-[14px] leading-snug text-sub">
              <Icon name="shield" className="mt-0.5 size-4 shrink-0 text-ok" />
              {line}
            </li>
          ))}
        </ul>
      )}
      {!ex && (
        <>
          <p className="text-[14px] leading-snug text-sub">{REPORT_KEEPS_RUNNING}</p>
          {typical !== null && <p className="text-[13px] text-mute">{durationSentence(typical)}</p>}
        </>
      )}

      {ex ? (
        <div className="flex flex-wrap items-center gap-2">
          {replay.playing ? (
            <Btn label="멈춤" onClick={replay.pause} primary />
          ) : (
            <Btn label="계속" onClick={replay.resume} disabled={replay.done} primary />
          )}
          <Btn label="다음 단계" onClick={replay.step} disabled={replay.done} />
          <Btn label="예시 끄기" onClick={replay.stop} />
        </div>
      ) : (
        waiting && (
          <Notice tone="info">
            <p>AI 담당자가 아직 연결되지 않아 이 리포트는 대기 중으로 남아 있어요. 만드는 모습은 예시로 볼 수 있어요.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {EXAMPLES.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  onClick={() => replay.start(e.id)}
                  className="h-10 rounded-xl bg-card px-3 text-[14px] font-semibold text-brand-dark hover:bg-line"
                >
                  {e.label}
                </button>
              ))}
            </div>
          </Notice>
        )
      )}
    </Card>
  );
}
