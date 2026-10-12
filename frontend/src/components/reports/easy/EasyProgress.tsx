// 만드는 중인 리포트의 쉬운 진행 표시 (docs/plans/컨셉변경계획.md 4-2): "시세를 보는 중 → 재무제표를 읽는 중 → 뉴스를 읽는 중 → 리포트를 쓰는 중 → 검토하는 중".
// 순서는 기다리는 사람이 묻는 순서다: 제목 → 닫아도 계속 만든다는 안내 → 보통 걸린 시간·기다린 시간 → 진행 막대(n/5) → 다섯 단계 → 자동 복구 → (대기 중일 때만) 예시 보기.
// 자동 복구는 숨기지 않고 쉬운 문장으로 ("뉴스를 읽는 AI가 늦어 다른 AI가 이어받았어요").
// 걸린 시간은 최근 완성 리포트의 범위("보통 1~3분 걸려요", 3건 미만이면 기본 문장), 기다린 시간은 늘 신청 시각 기준("신청한 지 2분") — 기준이 바뀌어 뒤로 가 보이지 않게 (UX-7).
// 검토 AI가 고쳐 쓰게 하면(RETRY) 쓰기 단계 아래에 "검토 AI가 고쳐 쓰라고 해서 다시 쓰는 중이에요"를 보이고, 검토 단계는 '끝났어요' 대신 '고친 글을 다시 봐요'다
// (끝난 단계가 아무 말 없이 '지금 하는 중'으로 돌아가 보이지 않게).
// 단계가 바뀌면 행 색이 240ms로 바뀌고 새 아이콘이 한 번 나타난다. '지금 하는 중'은 도는 아이콘 대신 살아 있음 점(LiveDot).
// 진행 막대는 끝난 단계 수의 최댓값이라 검토 뒤 다시 쓰기에서도 뒤로 가지 않고, 다 끝나기 전에는 4/5에서 기다린다. 화면 읽기 프로그램에는 지금 단계를 같은 숫자로 알린다.
// AI 담당자(팀 워크플로우)가 아직 연결되지 않았으면 예시 재생으로 진행 모습을 보인다 — 화면 안에서만 바뀌고 서버에는 아무것도 보내지 않는다.
import { useReports } from "../../../api/queries";
import { useNow } from "../../../api/reports";
import type { ReportDetail } from "../../../api/types";
import { useChanged, useNewKeys } from "../../../hooks/useMotionState";
import { cn } from "../../../lib/cn";
import { REPORT_KEEPS_RUNNING } from "../../../lib/plainText";
import { useReplay, type ScenarioId } from "../../../lib/reportExamples";
import {
  PROGRESS_STATE_TEXT,
  type ProgressState,
  type ProgressStep,
  durationSentence,
  progressAnnouncement,
  progressOf,
  progressPeak,
  recoverySentences,
  requestedAgoText,
  rewriteNoteOf,
  typicalDurationRange,
} from "../../../lib/reports";
import { Icon, type IconName } from "../../Icon";
import { Card, LiveDot, Notice, Progress } from "../../ui";
import { ExampleBanner } from "../ReplayControls";

// 상태는 색 + 아이콘 + 글자로. 글자색은 연한 행 바탕 위에서 4.5:1 이상인 것만 (초록 글자 대신 초록 체크가 '끝남'을 맡는다)
const LOOK: Record<ProgressState, { icon: IconName; dot: string; chip: string }> = {
  waiting: { icon: "circle", dot: "bg-fill text-mute", chip: "text-mute" },
  active: { icon: "play", dot: "bg-brand text-white", chip: "text-brand-ink" },
  done: { icon: "check", dot: "bg-ok text-white", chip: "text-sub" },
  failed: { icon: "close", dot: "bg-up text-white", chip: "text-up-ink" },
  skipped: { icon: "skip", dot: "bg-line text-sub", chip: "text-sub" },
  // 고친 글을 다시 볼 차례: 끝남(초록 체크)을 지우고, 기다리는 중과 다르게 '다시' 아이콘
  again: { icon: "restart", dot: "bg-brand-soft text-brand-ink", chip: "text-sub" },
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
        "press h-11 rounded-xl px-3.5 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-40",
        // 반전 버튼: 다크에서는 밝은 바탕 + 어두운 글자 (text-on-ink)
        primary ? "bg-ink text-on-ink hover:bg-sub" : "bg-fill text-ink hover:bg-line",
      )}
    >
      {label}
    </button>
  );
}

function StepRow({ s, note }: { s: ProgressStep; note: string }) {
  // 이 화면에서 상태가 바뀐 뒤에만 새 아이콘이 나타나는 움직임 (첫 렌더·캐시는 그대로)
  const changed = useChanged(s.state);
  const look = LOOK[s.state];
  return (
    <li
      aria-current={s.state === "active" ? "step" : undefined}
      className={cn("rounded-xl px-3 py-2.5 transition-colors duration-base ease-standard", s.state === "active" ? "bg-brand-soft" : "bg-fill")}
    >
      <div className="flex items-center gap-3">
        <span className={cn("grid size-7 shrink-0 place-items-center rounded-full transition-colors duration-base ease-standard", look.dot)}>
          <Icon key={s.state} name={look.icon} className={cn("size-4", changed && "animate-pop-in")} />
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-semibold">{s.label}</span>
        <span className={cn("flex shrink-0 items-center gap-1.5 text-[13px] font-semibold", look.chip)}>
          {s.state === "active" && <LiveDot />}
          {PROGRESS_STATE_TEXT[s.state]}
        </span>
      </div>
      {/* 검토 AI가 고쳐 쓰게 해 다시 하는 단계: 끝났던 단계가 왜 다시 '지금 하는 중'인지 */}
      {s.rewriting && (
        <p className="mt-1.5 flex items-start gap-1.5 pl-10 text-[13px] leading-snug text-sub">
          <Icon name="restart" className="mt-px size-3.5 shrink-0 text-brand-ink" />
          {note}
        </p>
      )}
    </li>
  );
}

export function EasyProgress({ r }: { r: ReportDetail }) {
  const replay = useReplay(r.state.taskId || `report-${r.id}`);
  const team = useReports({});
  const ex = replay.active;
  const now = useNow(!ex);
  const trace = ex ? replay.trace : r.trace;
  const steps = progressOf(trace, r.team);
  const peak = progressPeak(trace, r.team);
  const total = steps.length; // 종목 리포트는 다섯 단계
  const recovery = recoverySentences(trace);
  // 받기 전에는 문장을 비워 둔다 (기본 문장 → 범위로 바뀌어 보이지 않게)
  const typical = team.data ? durationSentence(typicalDurationRange(team.data.results)) : null;
  const waiting = !r.plan.implemented && r.status === "requested";
  const exStatus = replay.state.status;
  // 막대는 끝난 단계 수의 최댓값이라 검토 뒤 다시 쓰기에도 뒤로 가지 않는다. 다만 다 끝나기 전에는 4/5에서 기다린다 —
  // 다시 쓰는 동안 '5/5'(초록 = 끝남)를 보이면 '지금 하는 중'인 단계·"만드는 중이에요" 제목과 반대로 말한다
  const finished = ex && (exStatus === "completed" || exStatus === "failed");
  const shown = finished ? peak : Math.min(peak, total - 1);
  const tone = !finished ? "brand" : exStatus === "completed" ? "ok" : "up";
  const title = ex
    ? exStatus === "completed"
      ? "예시 리포트가 완성됐어요"
      : exStatus === "failed"
        ? "예시 리포트를 만들지 못했어요"
        : "예시 리포트를 만드는 중이에요"
    : r.status === "requested"
      ? "만들 차례를 기다리는 중이에요"
      : "리포트를 만드는 중이에요";
  // 제목이 바뀌는 순간(예시 완성 등)만 살짝 페이드
  const titleChanged = useChanged(title);
  // 보는 동안 새로 생긴 복구 문장만 올라오며 나타난다 (처음부터 있던 문장은 그대로)
  const freshRecovery = useNewKeys(recovery);
  const waited = ex ? null : requestedAgoText(r.createdAt, now);
  const note = rewriteNoteOf(r.team);

  return (
    <Card aria-labelledby="progress-title" className="space-y-3">
      {ex && <ExampleBanner />}
      <h2 key={title} id="progress-title" className={cn("text-[18px] font-bold", titleChanged && "reveal-fade")}>
        {title}
      </h2>
      {/* 기다리는 사람이 먼저 묻는 것: 나가도 되나, 얼마나 걸리나 */}
      {!ex && (
        <div className="space-y-1">
          <p className="text-[14px] leading-snug text-sub">{REPORT_KEEPS_RUNNING}</p>
          {(typical !== null || waited) && (
            <p className="text-[13px] text-sub tabular-nums">
              {typical !== null && <span>{typical}</span>}
              {typical !== null && waited && <span aria-hidden="true"> · </span>}
              {waited && <span>{waited}</span>}
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-3">
        <Progress value={shown} max={total} label="리포트 만들기 진행" tone={tone} className="flex-1" />
        <span aria-hidden="true" className="shrink-0 text-[13px] font-semibold text-sub tabular-nums">
          {shown}/{total}
        </span>
      </div>
      <ol aria-label="진행 단계" className="space-y-2">
        {steps.map((s) => (
          <StepRow key={s.actor} s={s} note={note} />
        ))}
      </ol>
      {/* 단계가 바뀔 때 화면 읽기 프로그램에 알린다 (보이는 글자와 겹치지 않는 문장) */}
      <p className="sr-only" aria-live="polite">
        {progressAnnouncement(steps, shown, note)}
      </p>
      {recovery.length > 0 && (
        <ul aria-label="자동 복구" className="space-y-1">
          {recovery.map((line) => (
            <li key={line} className={cn("flex items-start gap-1.5 text-[14px] leading-snug text-sub", freshRecovery.has(line) && "is-new")}>
              <Icon name="shield" className="mt-0.5 size-4 shrink-0 text-ok" />
              {line}
            </li>
          ))}
        </ul>
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
                  className="press h-11 rounded-xl bg-card px-3.5 text-[14px] font-semibold text-brand-ink hover:bg-line"
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
