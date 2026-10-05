// 장애 주입 폼: 토글 → 프리셋 2개 → (접힘) 직접 설정. 값은 POST /api/reports의 chaos (docs/API.md). 꺼져 있으면 null.
// 켜면 프리셋이 펼쳐진다 (Collapse — 아래 내용이 툭 밀리지 않게).
import { useState } from "react";
import type { ChaosRequest, ErrorType, Worker } from "../../api/types";
import { cn } from "../../lib/cn";
import { ERROR_LABEL } from "../../lib/reports";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
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
  // 끄면 접히는 동안에도 마지막 설정을 그대로 보인다 (내용이 먼저 사라져 툭 닫히지 않게 — 접히는 동안은 누를 수 없다)
  const [kept, setKept] = useState(value);
  if (value !== null && value !== kept) setKept(value); // 렌더 중 조건부 파생 상태
  const shown = value ?? kept;
  const preset = shown ? presetOf(shown) : null;
  const set = (patch: Partial<ChaosRequest>) => value && onChange({ ...value, ...patch });
  const errorTypes = shown?.errorTypes ?? INJECTABLE;
  const targets = shown?.workers ?? [];

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
        {/* 켜면 주황(장애 = 주의). 꺼짐 트랙은 mute-weak (bg-line은 카드와 1.2:1이라 꺼진 스위치가 보이지 않는다), 손잡이는 두 테마 모두 흰색(knob) */}
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="chaos-label"
          onClick={() => onChange(on ? null : PRESETS[0].value)}
          className={cn(
            "relative h-7 w-12 shrink-0 rounded-full transition-colors duration-200 ease-standard before:absolute before:-inset-2",
            on ? "bg-warn" : "bg-mute-weak",
          )}
        >
          <span
            className={cn(
              "absolute top-0.5 left-0.5 size-6 rounded-full bg-knob shadow-sm transition-[translate] duration-200 ease-standard",
              on && "translate-x-5",
            )}
          />
        </button>
      </div>

      <Collapse open={on}>
        {shown && (
          <div className="space-y-3 pt-3">
            <div role="group" aria-label="장애 주입 프리셋" className="grid grid-cols-2 gap-2">
              {PRESETS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  aria-pressed={preset === p.id}
                  onClick={() => onChange(p.value)}
                  className={cn("press rounded-xl border-2 p-2.5 text-left", preset === p.id ? "border-warn bg-warn-soft" : "border-line hover:bg-fill")}
                >
                  <span className="block text-[14px] font-bold">{p.title}</span>
                  <span className="mt-0.5 block text-[12px] leading-snug text-sub">{p.hint}</span>
                </button>
              ))}
            </div>

            <details className="group/chaos" open={preset === null}>
              <summary className="-ml-1 inline-flex min-h-10 cursor-pointer list-none items-center gap-1 rounded-md px-1 text-[13px] font-semibold text-brand-ink select-none hover:bg-fill">
                직접 설정
                {preset === null && <span className="text-mute">(적용 중)</span>}
                <Icon name="chevron-down" className="size-4 transition-transform duration-fast group-open/chaos:rotate-180" />
              </summary>
              <div className="mt-2 space-y-3 text-[13px]">
                <label className="block">
                  <span className="flex justify-between font-semibold text-sub">
                    실패 확률 <span className="tabular-nums">{Math.round((shown.probability ?? DEFAULT_PROBABILITY) * 100)}%</span>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={shown.probability ?? DEFAULT_PROBABILITY}
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
                    value={shown.scope ?? "primary"}
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
                    value={shown.seed ?? ""}
                    onChange={(e) => {
                      if (!value) return;
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
      </Collapse>
    </div>
  );
}
