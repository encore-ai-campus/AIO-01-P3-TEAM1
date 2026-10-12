// 예시 Trace 재생: 시나리오 고르기(ScenarioPicker)와 재생 띠(ReplayBar), 띠가 화면 밖일 때의 재생 미니 줄(ReplayMini).
// 정해 둔 사건 목록을 차례로 보여 줄 뿐 서버에는 아무것도 보내지 않는다.
// 진행 막대는 재생 중에는 사건 간격(800ms)과 같은 길이로 일정하게 차고, '다음 사건'으로 넘길 때는 짧게 찬다 (계단처럼 툭툭 움직이지 않게).
// PC(lg): 재생 띠는 한 줄로 줄이고 위 바 아래에 붙는다(화면이 붙인다 — sticky) — 그래프를 따라 내려가도 멈춤·다음 사건을 누를 수 있게 (발표 화면 1440×900).
// 붙은 띠의 높이는 useHeight(./useHeight)로 재서 화면이 --replay-h로 넘긴다 (오른쪽 Trace 카드·단계로 옮길 때의 여백이 띠 밑에 숨지 않게).
import type { Ref } from "react";
import { useIsPc } from "../../hooks/useIsPc";
import { cn } from "../../lib/cn";
import { SCENARIOS, type Replay } from "../../lib/reportExamples";
import { Icon, type IconName } from "../Icon";
import { Progress } from "../ui";

function Btn({ icon, label, onClick, disabled, primary }: { icon: IconName; label: string; onClick: () => void; disabled?: boolean; primary?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "press flex h-11 items-center gap-1.5 rounded-xl px-3 text-[14px] font-semibold disabled:cursor-not-allowed disabled:opacity-40",
        // 반전 버튼: 다크에서는 밝은 바탕 + 어두운 글자 (text-on-ink)
        primary ? "bg-ink text-on-ink hover:bg-sub" : "bg-fill text-ink hover:bg-line",
      )}
    >
      <Icon name={icon} className="size-4" />
      {label}
    </button>
  );
}

/** 재생 진행 막대: 재생 중이면 사건 간격(REPLAY_MS 800ms)과 같은 길이로 일정하게(linear), 아니면 기본 240ms. */
function ReplayProgress({ replay, className }: { replay: Replay; className?: string }) {
  return (
    <Progress
      value={replay.index}
      max={replay.total || 1}
      tone="warn"
      // 안쪽 막대의 전이만 바꾼다 (공용 Progress는 그대로)
      className={cn(replay.playing && "[&>div]:duration-[800ms] [&>div]:ease-linear", className)}
    />
  );
}

/** 재생 중·재생 결과에 붙이는 눈에 띄는 띠. 주황 바탕 위 어두운 글자 (흰 글자는 2.06:1이라 읽히지 않는다). */
export function ExampleBanner({ className }: { className?: string }) {
  return (
    <p className={cn("flex items-center gap-2 rounded-xl bg-warn px-3.5 py-2.5 text-[15px] font-bold text-on-warn", className)}>
      <Icon name="alert" className="size-5 shrink-0" />
      예시 데이터 — 실제 실행이 아닙니다
    </p>
  );
}

/** 시나리오 설명에서 과제 코드(DR-LLM-02 등)와 끝 결과(마지막 → 뒤)를 나눈다 — 카드에는 제목과 결과 한 줄만 크게 보인다. */
function splitScenario(description: string): { code: string | null; chain: string; outcome: string } {
  const m = /^(DR-[A-Z]+-\d+)\s*·\s*/.exec(description);
  const chain = m ? description.slice(m[0].length) : description;
  const parts = chain.split("→");
  return { code: m ? m[1] : null, chain, outcome: parts[parts.length - 1].trim() };
}

/**
 * 예시 시나리오 고르기. 고르면 재생이 시작된다 (화면이 "진행 기록" 탭으로 옮긴다).
 * PC(lg)는 카드에 제목 + 결과 한 줄만 크게, 전체 흐름은 아래에 접어 둔다 (발표 화면에서 읽히게). 모바일은 전과 같이 카드에 전체 흐름 (리뷰 49).
 */
export function ScenarioPicker({ replay, onStart }: { replay: Replay; onStart?: () => void }) {
  const isPc = useIsPc();
  return (
    <div>
      <h2 className="text-[17px] font-bold">예시 Trace 재생</h2>
      <p className="mt-0.5 text-[13px] leading-snug text-mute">
        미리 적어 둔 예시 사건을 차례로 흘려 그래프·타임라인·요약이 바뀌는 모습을 보여 줍니다. 서버에는 아무것도 보내지 않습니다.
      </p>
      <div role="group" aria-label="예시 시나리오" className="mt-3 grid gap-2 sm:grid-cols-3">
        {SCENARIOS.map((s) => {
          const on = replay.scenario?.id === s.id;
          const { code, outcome } = splitScenario(s.description);
          return (
            <button
              key={s.id}
              type="button"
              aria-pressed={on}
              onClick={() => {
                replay.start(s.id);
                onStart?.();
              }}
              className={cn("press rounded-xl border-2 p-3 text-left lg:px-4 lg:py-3.5", on ? "border-warn bg-warn-soft" : "border-line bg-card hover:bg-fill")}
            >
              <span className="flex items-center gap-1.5 text-[15px] font-bold lg:text-[16px]">
                <Icon name="play" className="size-4 shrink-0" />
                {s.title}
              </span>
              {isPc ? (
                <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[14px] leading-snug text-sub">
                  <span className="font-semibold text-ink">→ {outcome}</span>
                  {code && <span className="font-mono text-[11px] text-mute">{code}</span>}
                </span>
              ) : (
                <span className="mt-1 block text-[12px] leading-snug text-sub">{s.description}</span>
              )}
            </button>
          );
        })}
      </div>
      {isPc && (
        <details className="group/flow mt-2 text-[13px]">
          {/* 보이는 높이는 36px, 누르는 곳은 위아래 4px씩 넓혀 44px */}
          <summary className="relative -ml-1 inline-flex min-h-9 cursor-pointer list-none items-center gap-0.5 rounded-md px-1 font-semibold text-brand-ink select-none before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-fill">
            시나리오별 전체 흐름
            <Icon name="chevron-down" className="size-4 transition-transform duration-fast group-open/flow:rotate-180" />
          </summary>
          <ol aria-label="시나리오별 전체 흐름" className="mt-1.5 space-y-1.5">
            {SCENARIOS.map((s) => (
              <li key={s.id} className="leading-snug text-sub">
                <b className="font-semibold text-ink">{s.title}</b> · {s.description}
              </li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * 재생 중에 "진행 기록" 탭 위에 붙는 띠: 예시 표시 + 재생 버튼. ref는 띠가 화면에 보이는지 지켜보는 데 쓴다.
 * PC(lg)는 [예시 표시 · 시나리오 이름 · 버튼 · 사건 수] 한 줄 + 진행 막대 (붙어 있어도 그래프를 덜 가리게). 모바일은 그대로 세 줄.
 */
export function ReplayBar({ replay, ref }: { replay: Replay; ref?: Ref<HTMLDivElement> }) {
  return (
    <div
      ref={ref}
      className="scroll-mt-36 space-y-2 rounded-2xl bg-card p-3 lg:flex lg:scroll-mt-(--rail-top) lg:flex-wrap lg:items-center lg:gap-x-3 lg:gap-y-2 lg:space-y-0 lg:py-2.5 lg:ring-1 lg:ring-line"
    >
      <ExampleBanner className="lg:shrink-0 lg:py-2 lg:text-[14px]" />
      <p className="px-0.5 text-[13px] font-semibold text-sub lg:min-w-0 lg:flex-1 lg:truncate">{replay.scenario?.title}</p>
      <div className="flex flex-wrap items-center gap-2 lg:max-w-full lg:shrink-0">
        {replay.playing ? (
          <Btn icon="pause" label="멈춤" onClick={replay.pause} primary />
        ) : (
          <Btn icon="play" label="계속" onClick={replay.resume} disabled={replay.done} primary />
        )}
        <Btn icon="next" label="다음 사건" onClick={replay.step} disabled={replay.done} />
        <Btn icon="restart" label="처음으로" onClick={replay.restart} />
        <Btn icon="close" label="예시 끄기" onClick={replay.stop} />
        <span className="ml-auto text-[13px] font-semibold text-sub tabular-nums lg:whitespace-nowrap">
          사건 {replay.index} / {replay.total}
          {replay.done && " · 재생 끝"}
        </span>
      </div>
      <ReplayProgress replay={replay} className="lg:basis-full" />
    </div>
  );
}

/**
 * 재생 미니 줄: 재생 띠가 화면 밖일 때 고정된 탭 줄 안에 붙는다 (높이 40px 이하 — 화면을 많이 덮지 않게).
 * 그래프·타임라인을 스크롤하며 보는 동안에도 멈추고 넘길 수 있다. 버튼 이름은 띠의 버튼과 겹치지 않게 따로 둔다.
 */
export function ReplayMini({ replay }: { replay: Replay }) {
  // 누르는 칸은 줄 높이(40px)만큼 — 붙어 있는 줄에서 엄지로 누르는 버튼이라 최소 40px
  const icon = "grid size-10 shrink-0 place-items-center rounded-lg press disabled:opacity-40";
  return (
    // PC는 탭 줄이 제자리라(붙지 않음) 미니 줄이 보일 일이 없다 — 위쪽 높이가 바뀌어 내용이 밀리지 않게 그리지 않는다
    <div className="mt-2 flex h-10 animate-fade-in items-center gap-1.5 rounded-xl bg-warn-soft px-1.5 lg:hidden">
      <span className="shrink-0 rounded-md bg-warn px-1.5 py-0.5 text-[12px] font-bold text-on-warn">예시</span>
      {replay.playing ? (
        <button type="button" aria-label="예시 재생 멈춤" onClick={replay.pause} className={cn(icon, "text-warn-ink hover:bg-warn/20")}>
          <Icon name="pause" className="size-4" />
        </button>
      ) : (
        <button type="button" aria-label="예시 재생 계속" onClick={replay.resume} disabled={replay.done} className={cn(icon, "text-warn-ink hover:bg-warn/20")}>
          <Icon name="play" className="size-4" />
        </button>
      )}
      <button type="button" aria-label="예시 다음 사건" onClick={replay.step} disabled={replay.done} className={cn(icon, "text-warn-ink hover:bg-warn/20")}>
        <Icon name="next" className="size-4" />
      </button>
      <span className="shrink-0 text-[12px] font-semibold text-warn-ink tabular-nums">
        {replay.index}/{replay.total}
      </span>
      <ReplayProgress replay={replay} className="min-w-0 flex-1" />
    </div>
  );
}
