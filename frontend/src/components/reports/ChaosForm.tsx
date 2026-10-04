// 장애 주입 폼: 토글 → 프리셋 2개 → (접힘) 직접 설정. 값은 POST /api/reports의 chaos (docs/API.md). 꺼져 있으면 null.
import type { ChaosRequest, ErrorType, Worker } from "../../api/types";
import { cn } from "../../lib/cn";
import { ERROR_LABEL } from "../../lib/reports";
import { Icon } from "../Icon";
import { Segmented } from "../ui";

type Preset = "recovery" | "policy";

const PRESETS: { id: Preset; title: string; hint: string; value: ChaosRequest }[] = [
  { id: "recovery", title: "복구 시연", hint: "주 모델만 실패 (확률 80%) → 대체 모델로 복구", value: { enabled: true, scope: "primary", probability: 0.8 } },
  { id: "policy", title: "정책 시연", hint: "대체 모델까지 실패 → 필수·선택 정책", value: { enabled: true, scope: "all" } },
];

const INJECTABLE: ErrorType[] = ["timeout", "server_error", "bad_output"];
const DEFAULT_PROBABILITY = 0.5; // 서버 기본값 (docs/tasks/00-공통.md 5절)

/** 지금 값이 어느 프리셋과 같은지 (직접 설정으로 바꿨으면 null). */
function presetOf(v: ChaosRequest): Preset | null {
  if (v.errorTypes || v.workers || v.seed !== undefined) return null;
  return PRESETS.find((p) => p.value.scope === v.scope && p.value.probability === v.probability)?.id ?? null;
}

export function ChaosForm({ value, onChange, workers = [] }: { value: ChaosRequest | null; onChange: (v: ChaosRequest | null) => void; workers?: Worker[] }) {
  const on = value !== null;
  const preset = value ? presetOf(value) : null;
  const set = (patch: Partial<ChaosRequest>) => value && onChange({ ...value, ...patch });
  const errorTypes = value?.errorTypes ?? INJECTABLE;
  const targets = value?.workers ?? [];

  return (
    <div className="rounded-2xl border border-line p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p id="chaos-label" className="flex items-center gap-1.5 text-[15px] font-bold">
            <Icon name="bolt" className="size-4 text-warn" />
            장애 주입 (랜덤 실패)
          </p>
          <p className="mt-0.5 text-[12px] leading-snug text-mute">리포트 실행에만 적용 · 모의 주문과 무관 · 대체 모델 비용은 한도에 포함</p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="chaos-label"
          onClick={() => onChange(on ? null : PRESETS[0].value)}
          className={cn("relative h-7 w-12 shrink-0 rounded-full transition-colors", on ? "bg-warn" : "bg-line")}
        >
          <span className={cn("absolute top-0.5 left-0.5 size-6 rounded-full bg-white shadow transition-transform", on && "translate-x-5")} />
        </button>
      </div>

      {value && (
        <div className="mt-3 space-y-3">
          <div role="group" aria-label="장애 주입 프리셋" className="grid grid-cols-2 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={preset === p.id}
                onClick={() => onChange(p.value)}
                className={cn("rounded-xl border-2 p-2.5 text-left", preset === p.id ? "border-warn bg-warn-soft" : "border-line hover:bg-fill")}
              >
                <span className="block text-[14px] font-bold">{p.title}</span>
                <span className="mt-0.5 block text-[12px] leading-snug text-sub">{p.hint}</span>
              </button>
            ))}
          </div>

          <details className="group" open={preset === null}>
            <summary className="inline-flex min-h-9 cursor-pointer items-center gap-1 text-[13px] font-semibold text-brand select-none">
              직접 설정
              {preset === null && <span className="text-mute">(적용 중)</span>}
            </summary>
            <div className="mt-2 space-y-3 text-[13px]">
              <label className="block">
                <span className="flex justify-between font-semibold text-sub">
                  실패 확률 <span className="tabular-nums">{Math.round((value.probability ?? DEFAULT_PROBABILITY) * 100)}%</span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={value.probability ?? DEFAULT_PROBABILITY}
                  onChange={(e) => set({ probability: Number(e.target.value) })}
                  className="mt-1 w-full accent-warn"
                />
              </label>

              <fieldset>
                <legend className="font-semibold text-sub">실패 종류</legend>
                <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                  {INJECTABLE.map((t) => (
                    <label key={t} className="flex min-h-8 items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={errorTypes.includes(t)}
                        onChange={(e) => {
                          const next = INJECTABLE.filter((x) => (x === t ? e.target.checked : errorTypes.includes(x)));
                          if (next.length > 0) set({ errorTypes: next });
                        }}
                        className="size-4 accent-warn"
                      />
                      {ERROR_LABEL[t]}
                    </label>
                  ))}
                </div>
              </fieldset>

              {workers.length > 0 && (
                <fieldset>
                  <legend className="font-semibold text-sub">대상 Worker (비우면 전부)</legend>
                  <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
                    {workers.map((w) => (
                      <label key={w.id} className="flex min-h-8 items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={targets.includes(w.id)}
                          onChange={(e) => {
                            const next = e.target.checked ? [...targets, w.id] : targets.filter((x) => x !== w.id);
                            set({ workers: next.length > 0 ? next : null });
                          }}
                          className="size-4 accent-warn"
                        />
                        {w.title}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-sub">범위</span>
                <Segmented
                  label="장애 주입 범위"
                  value={value.scope ?? "primary"}
                  onChange={(scope) => set({ scope })}
                  options={[
                    { value: "primary", label: "주 모델만" },
                    { value: "all", label: "대체 모델까지" },
                  ]}
                />
              </div>

              <label className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sub">seed (비우면 서버가 정함)</span>
                <input
                  type="number"
                  inputMode="numeric"
                  value={value.seed ?? ""}
                  onChange={(e) => {
                    const next = { ...value };
                    if (e.target.value === "") delete next.seed;
                    else next.seed = Number(e.target.value);
                    onChange(next);
                  }}
                  className="h-9 w-32 rounded-lg bg-fill px-2 text-right tabular-nums outline-none focus:ring-2 focus:ring-brand"
                />
              </label>
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
