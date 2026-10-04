// 예시 Trace 재생: 시나리오 고르기(ScenarioPicker)와 재생 띠(ReplayBar). 정해 둔 사건 목록을 차례로 보여 줄 뿐 서버에는 아무것도 보내지 않는다.
import { cn } from "../../lib/cn";
import { SCENARIOS, type Replay } from "../../lib/reportExamples";
import { Icon, type IconName } from "../Icon";

function Btn({ icon, label, onClick, disabled, primary }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex h-10 items-center gap-1.5 rounded-xl px-3 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-40",
        primary ? "bg-ink text-white hover:bg-sub" : "bg-fill text-ink hover:bg-line",
      )}
    >
      <Icon name={icon} className="size-4" />
      {label}
    </button>
  );
}

/** 재생 중·재생 결과에 붙이는 눈에 띄는 띠. */
export function ExampleBanner() {
  return (
    <p className="flex items-center gap-2 rounded-xl bg-warn px-3.5 py-2.5 text-[15px] font-bold text-white">
      <Icon name="alert" className="size-5 shrink-0" />
      예시 데이터 — 실제 실행이 아닙니다
    </p>
  );
}

/** 예시 시나리오 고르기. 고르면 재생이 시작된다 (화면이 "진행 기록" 탭으로 옮긴다). */
export function ScenarioPicker({ replay, onStart }: { replay: Replay; onStart?: () => void }) {
  return (
    <div>
      <h2 className="text-[17px] font-bold">예시 Trace 재생</h2>
      <p className="mt-0.5 text-[13px] leading-snug text-mute">
        미리 적어 둔 예시 사건을 차례로 흘려 그래프·타임라인·요약이 바뀌는 모습을 보여 줍니다. 서버에는 아무것도 보내지 않습니다.
      </p>
      <div role="group" aria-label="예시 시나리오" className="mt-3 grid gap-2 sm:grid-cols-3">
        {SCENARIOS.map((s) => {
          const on = replay.scenario?.id === s.id;
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                replay.start(s.id);
                onStart?.();
              }}
              className={cn("rounded-xl border-2 p-3 text-left transition-colors", on ? "border-warn bg-warn-soft" : "border-line bg-card hover:bg-fill")}
            >
              <span className="flex items-center gap-1.5 text-[15px] font-bold">
                <Icon name="play" className="size-4 shrink-0" />
                {s.title}
              </span>
              <span className="mt-1 block text-[12px] leading-snug text-sub">{s.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** 재생 중에 "진행 기록" 탭 위에 붙는 띠: 예시 표시 + 재생 버튼. */
export function ReplayBar({ replay }: { replay: Replay }) {
  return (
    <div className="space-y-2 rounded-2xl bg-card p-3">
      <ExampleBanner />
      <p className="px-0.5 text-[13px] font-semibold text-sub">{replay.scenario?.title}</p>
      <div className="flex flex-wrap items-center gap-2">
        {replay.playing ? (
          <Btn icon="pause" label="멈춤" onClick={replay.pause} primary />
        ) : (
          <Btn icon="play" label="계속" onClick={replay.resume} disabled={replay.done} primary />
        )}
        <Btn icon="next" label="다음 사건" onClick={replay.step} disabled={replay.done} />
        <Btn icon="restart" label="처음으로" onClick={replay.restart} />
        <Btn icon="close" label="예시 끄기" onClick={replay.stop} />
        <span className="ml-auto text-[13px] font-semibold text-sub tabular-nums">
          사건 {replay.index} / {replay.total}
          {replay.done && " · 재생 끝"}
        </span>
      </div>
      <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-fill">
        <div className="h-full bg-warn transition-[width]" style={{ width: `${replay.total ? (replay.index / replay.total) * 100 : 0}%` }} />
      </div>
    </div>
  );
}
