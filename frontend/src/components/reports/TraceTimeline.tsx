// Trace 타임라인: 사건을 사람이 읽는 문장으로 (src/lib/reports.ts의 eventText). 새 사건은 아래에 붙는다.
// "주요 사건"(기본)은 실패·재시도·전환·완료·포기·검토 반복·막힘·시작과 끝만, "전체"는 모든 사건과 원본 action·details.
// 새 사건: 이 화면을 보는 동안 붙은 사건만 올라오며 나타난다 (.is-new). 처음부터 있던 사건과 보기를 바꿔 새로 보이는 사건은 움직이지 않는다.
// 끝이 화면 밖에 있으면 아래에 '새 사건 n건 ↓' 알약을 띄워 바로 내려갈 수 있게 한다 (IntersectionObserver가 없으면 알약도 없다).
import { type RefObject, useEffect, useRef, useState } from "react";
import type { ExecutionPlan, TraceEvent } from "../../api/types";
import { cn } from "../../lib/cn";
import { formatLatency, formatTime } from "../../lib/format";
import { prefersReducedMotion } from "../../lib/motion";
import { actorLabel, eventText, isKeyEvent, type EventTone } from "../../lib/reports";
import { Icon } from "../Icon";
import { Segmented } from "../ui";
import { InjectedBadge, NodeStatusChip, RecoveredBadge } from "./StatusChip";

/** 펼치면 JSON을 보여 준다. */
export function JsonDetails({ summary, value }: { summary: string; value: unknown }) {
  return (
    <details className="group/json mt-1.5 text-[12px]">
      {/* 보이는 높이는 32px, 누르는 곳은 위아래 6px씩 넓혀 44px */}
      <summary className="relative -ml-1 inline-flex min-h-8 cursor-pointer list-none items-center gap-0.5 rounded-md px-1 font-semibold text-brand-ink select-none before:absolute before:inset-x-0 before:-inset-y-1.5 hover:bg-fill">
        {summary}
        <Icon name="chevron-down" className="size-3.5 transition-transform duration-fast group-open/json:rotate-180" />
      </summary>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-fill p-2.5 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-sub">
        {JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

// 점 색: 주황(복구) 위 글자는 어두운 on-warn (흰 글자는 2.06:1이라 읽히지 않는다)
const TONE: Record<EventTone, { dot: string; box: string }> = {
  fail: { dot: "bg-up text-white", box: "border-up/40 bg-up-soft/50" },
  recover: { dot: "bg-warn text-on-warn", box: "border-warn/50 bg-warn-soft/60" },
  ok: { dot: "bg-ok text-white", box: "border-line" },
  info: { dot: "bg-fill text-sub", box: "border-line" },
};

function Tag({ tag }: { tag: string }) {
  if (tag === "주입") return <InjectedBadge />;
  if (tag === "자동 복구") return <RecoveredBadge />;
  return <span className="inline-flex h-6 items-center rounded-md bg-up px-1.5 text-[12px] font-bold text-white">{tag}</span>;
}

type Mode = "key" | "all";

const maxStep = (trace: TraceEvent[]) => trace.reduce((m, e) => Math.max(m, e.step), 0);

/**
 * 새 사건으로 볼 step의 기준선. 처음 그릴 때의 마지막 step, 그리고 보기를 바꾼 순간의 마지막 step — 그보다 큰 step만 새 사건이다.
 * 사건이 줄면(예시 재생을 처음으로) 기준선도 내려 다시 붙는 사건이 새 사건으로 보이게 한다.
 */
function useFreshBaseline(mode: Mode, latest: number): number {
  const [base, setBase] = useState({ mode, max: latest });
  if (base.mode !== mode || latest < base.max) setBase({ mode, max: latest }); // 렌더 중 조건부 파생 상태
  return base.mode === mode && latest >= base.max ? base.max : latest;
}

/** 목록 끝이 화면에 보이는지 (IntersectionObserver가 없으면 null — 알약을 그리지 않는다). */
function useEndVisible(end: RefObject<HTMLElement | null>, active: boolean): boolean | null {
  const [visible, setVisible] = useState<boolean | null>(null);
  useEffect(() => {
    const el = end.current;
    if (!active || !el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: "0px 0px -80px 0px" });
    io.observe(el);
    return () => io.disconnect();
  }, [end, active]);
  return visible;
}

export function TraceTimeline({ trace, plan }: { trace: TraceEvent[]; plan: ExecutionPlan }) {
  const [mode, setMode] = useState<Mode>("key");
  const latest = maxStep(trace);
  const baseline = useFreshBaseline(mode, latest);
  const end = useRef<HTMLDivElement>(null);
  const endVisible = useEndVisible(end, trace.length > 0);
  // 끝이 화면 밖일 때 붙은 사건 수 (끝이 보이면 0으로 되돌린다)
  const [seenAt, setSeenAt] = useState(latest);
  if (endVisible !== false && seenAt !== latest) setSeenAt(latest);
  const shown = mode === "key" ? trace.filter(isKeyEvent) : trace;
  const unseen = endVisible === false ? shown.filter((e) => e.step > seenAt).length : 0;

  if (trace.length === 0) {
    return <p className="py-8 text-center text-[15px] text-mute">아직 실행 사건이 없습니다.</p>;
  }
  const goEnd = () => {
    const el = end.current;
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "end" });
  };
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <Segmented
          label="타임라인 보기"
          value={mode}
          onChange={setMode}
          options={[
            { value: "key", label: "주요 사건" },
            { value: "all", label: "전체" },
          ]}
        />
        <span className="text-[12px] text-mute tabular-nums">
          {shown.length} / {trace.length}건
        </span>
      </div>
      <ol aria-label="Trace 사건" className="space-y-2">
        {shown.map((e) => {
          const t = eventText(e, plan);
          const tone = TONE[t?.tone ?? "info"];
          const run = [e.provider, e.model].filter(Boolean).join(" · ");
          const instructions = e.action === "review_retry" && typeof e.details.instructions === "string" ? e.details.instructions : "";
          const issues = e.action === "review_retry" && Array.isArray(e.details.issues) ? e.details.issues.map(String) : [];
          return (
            <li key={e.step} className={cn("rounded-xl border p-3", tone.box, e.step > baseline && "is-new")}>
              <div className="flex items-start gap-2.5">
                <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded-full", tone.dot, e.step > baseline && "animate-pop-in")}>
                  <Icon name={t?.icon ?? "circle"} className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-[14px] font-bold">{actorLabel(plan, e.actor)}</span>
                    {t?.tags.map((tag) => <Tag key={tag} tag={tag} />)}
                    <time dateTime={e.at} className="ml-auto text-[12px] text-mute tabular-nums">
                      {formatTime(e.at)}
                    </time>
                  </div>
                  <p className="mt-0.5 text-[14px] leading-snug text-sub">{t?.text ?? e.action}</p>
                  {mode === "key" && instructions && (
                    <details className="group/fix mt-1 text-[13px]">
                      <summary className="relative -ml-1 inline-flex min-h-9 cursor-pointer list-none items-center gap-0.5 rounded-md px-1 font-semibold text-brand-ink select-none before:absolute before:inset-x-0 before:-inset-y-1 hover:bg-fill">
                        수정 지시 보기
                        <Icon name="chevron-down" className="size-4 transition-transform duration-fast group-open/fix:rotate-180" />
                      </summary>
                      {issues.length > 0 && <p className="text-sub">지적: {issues.join(" · ")}</p>}
                      <p className="mt-0.5 leading-snug text-sub">{instructions}</p>
                    </details>
                  )}
                  {mode === "all" && (
                    <>
                      <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-mute">
                        <span className="tabular-nums">
                          <span className="sr-only">step </span>#{e.step}
                        </span>
                        <code className="rounded bg-fill px-1 font-mono text-sub">{e.action}</code>
                        <NodeStatusChip status={e.status} live={false} />
                        {run && <span className="font-mono">{run}</span>}
                        {e.latencyMs !== null && <span className="tabular-nums">{formatLatency(e.latencyMs)}</span>}
                      </p>
                      {Object.keys(e.details).length > 0 && <JsonDetails summary="details" value={e.details} />}
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
      {/* 목록 끝 표시 (보이는지 지켜본다) */}
      <div ref={end} aria-hidden="true" className="h-px" />
      {unseen > 0 && (
        // 끝이 화면 밖일 때 새로 붙은 사건 수. 하단 탭 위에 붙고(카드 안에서만 따라온다), 누르면 끝으로 내려간다
        <div className="pointer-events-none sticky bottom-[calc(80px+env(safe-area-inset-bottom))] z-10 flex justify-center pt-2 lg:bottom-6">
          <button
            type="button"
            onClick={goEnd}
            className="press pointer-events-auto flex h-10 animate-rise-in items-center gap-1 rounded-full bg-ink px-4 text-[14px] font-semibold text-on-ink shadow-lg"
          >
            새 사건 {unseen}건
            <Icon name="chevron-down" className="size-4" />
          </button>
        </div>
      )}
    </div>
  );
}
