// 산 이유 입력 ("왜 샀나요?", docs/API.md "장기투자" PUT /api/longterm/theses/{symbol}).
//
// - 이유 1~3개 (각 1~100자, 앞뒤 공백을 지운 뒤): 예시(THESIS_PRESETS)를 눌러 넣거나 직접 적는다.
// - 점검할 축(성장·수익성·재무 안정)은 고르지 않아도 된다 (고르지 않으면 셋 다). 축은 판정을 바꾸지 않고 보이는 순서만 바꾼다.
// - 저장은 useSaveThesis(symbol) (PUT). 400이면 서버 detail을 보인다. 저장되면 onSaved(thesis).
// - 장기 보유 주문(OrderPanel의 "장기 보유")과 종목 상세의 펀더멘털 패널에서 연다.
// - stickyActions: 바텀시트 안에서는 [취소·산 이유 저장]을 시트 바닥에 붙인다 (내용이 길어도 버튼이 엄지 영역에 남게).
// - easy(쉬운 보기): "정기공시" → "실적 보고서(정기공시)", "점검할 축" → "먼저 볼 것" (전문가 보기는 그대로).
import { useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../../api/client";
import { useSaveThesis } from "../../api/longterm";
import type { Thesis, ThesisAxis } from "../../api/types";
import { useNewKeys } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { prefersReducedMotion } from "../../lib/motion";
import { THESIS_AXIS_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Notice, Spinner } from "../ui";
import { THESIS_AXES, THESIS_MAX_LEN, THESIS_MAX_REASONS, THESIS_PRESETS, josa } from "./longtermText";

export interface ThesisFormProps {
  symbol: string;
  name: string;
  /** 고칠 때의 지금 값. 없으면 새로 만든다. */
  initial?: Pick<Thesis, "reasons" | "axes"> | null;
  /** 저장(PUT)이 끝나면. */
  onSaved?: (thesis: Thesis) => void;
  /** 닫기 (바텀시트·대화상자 안에서 쓸 때). 없으면 취소 버튼을 그리지 않는다. */
  onCancel?: () => void;
  /** 위의 제목·설명("왜 샀나요?")을 그릴지. 같은 제목·설명을 가진 대화상자 안에서는 false. */
  intro?: boolean;
  /** 바텀시트(components/motion/Sheet, 패널 안쪽 여백 p-5) 안: 버튼 줄을 시트 바닥에 붙인다. */
  stickyActions?: boolean;
  /** 처음 그릴 때 폼으로 포커스를 옮긴다 (보기 → 고치기로 바뀐 직후 — 누른 버튼이 사라져 포커스를 잃지 않게). */
  focusOnMount?: boolean;
  /** 쉬운 보기 문구 (전문 용어를 푼다). */
  easy?: boolean;
  className?: string;
}

export function ThesisForm({
  symbol,
  name,
  initial = null,
  onSaved,
  onCancel,
  intro = true,
  stickyActions = false,
  focusOnMount = false,
  easy = false,
  className,
}: ThesisFormProps) {
  const [reasons, setReasons] = useState<string[]>(initial?.reasons ?? []);
  const [axes, setAxes] = useState<ThesisAxis[]>(initial?.axes ?? []);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const save = useSaveThesis(symbol);
  const ids = useId();
  const form = useRef<HTMLFormElement>(null);
  const full = reasons.length >= THESIS_MAX_REASONS;
  // 방금 더한 이유만 살짝 올라오며 나타난다 (처음부터 있던 이유는 그대로)
  const added = useNewKeys(reasons);

  useEffect(() => {
    const el = form.current;
    if (!focusOnMount || !el) return;
    el.focus({ preventScroll: true });
    if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [focusOnMount]);

  /** 이유 하나를 더한다. 더했으면 true. */
  const add = (raw: string): boolean => {
    const text = raw.trim();
    if (!text) {
      setHint("이유를 적어 주세요.");
      return false;
    }
    if (text.length > THESIS_MAX_LEN) {
      setHint(`이유 하나는 ${THESIS_MAX_LEN}자까지 적을 수 있어요 (지금 ${text.length}자).`);
      return false;
    }
    if (reasons.includes(text)) {
      setHint("이미 넣은 이유예요.");
      return false;
    }
    if (full) {
      setHint(`이유는 ${THESIS_MAX_REASONS}개까지 적을 수 있어요.`);
      return false;
    }
    setReasons((cur) => [...cur, text]);
    setHint(null);
    return true;
  };

  const remove = (text: string) => {
    setReasons((cur) => cur.filter((r) => r !== text));
    setHint(null);
  };

  const addDraft = () => {
    if (add(draft)) setDraft("");
  };

  const submit = () => {
    let list = reasons;
    // 적다 만 이유가 있으면 같이 저장한다 (자리가 있을 때)
    const pending = draft.trim();
    if (pending && !reasons.includes(pending)) {
      if (pending.length > THESIS_MAX_LEN || full) {
        add(draft);
        return;
      }
      list = [...reasons, pending];
      setReasons(list);
      setDraft("");
    }
    if (list.length === 0) {
      setHint("이유를 1개 이상 적어 주세요.");
      return;
    }
    setHint(null);
    save.mutate({ reasons: list, axes }, { onSuccess: (t) => onSaved?.(t) });
  };

  return (
    <form
      ref={form}
      tabIndex={focusOnMount ? -1 : undefined}
      aria-label={`${name} 산 이유`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn("space-y-4 outline-none", className)}
    >
      {intro && (
        <div>
          <h3 className="text-[16px] font-bold">왜 샀나요?</h3>
          <p className="mt-0.5 text-[13px] leading-snug text-mute">
            {name}
            {josa(name, "을/를")} 산 이유를 1~{THESIS_MAX_REASONS}개 남겨 두면, {easy ? "실적 보고서(정기공시)" : "정기공시"}가 나올 때 그 이유와 관련된 숫자를 같이
            점검해요. {easy ? "팔라고 하거나" : "매도를 권하거나"} 자동으로 팔지 않아요.
          </p>
        </div>
      )}

      <div>
        <p className="text-[14px] font-semibold">
          내 이유 ({reasons.length}/{THESIS_MAX_REASONS})
        </p>
        {reasons.length === 0 ? (
          <p className="mt-1 text-[13px] text-mute">아래 예시를 누르거나 직접 적어 주세요.</p>
        ) : (
          <ul aria-label="내 이유" className="mt-1.5 space-y-1.5">
            {reasons.map((r) => (
              <li key={r} className={cn("flex items-center gap-2 rounded-xl bg-fill py-2.5 pr-1 pl-3.5 text-[14px]", added.has(r) && "is-new")}>
                <span className="min-w-0 flex-1 break-words">{r}</span>
                <button
                  type="button"
                  onClick={() => remove(r)}
                  aria-label={`"${r}" 지우기`}
                  className="-my-2.5 grid size-11 shrink-0 place-items-center rounded-full text-mute-weak transition-colors hover:bg-line hover:text-sub active:bg-line/60"
                >
                  <Icon name="close" className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div role="group" aria-label="이유 예시" className="flex flex-wrap gap-1.5">
        {THESIS_PRESETS.map((p) => {
          const on = reasons.includes(p);
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              disabled={!on && full}
              onClick={() => (on ? remove(p) : add(p))}
              className={cn(
                "press min-h-11 rounded-full px-3.5 py-2 text-left text-[13px] font-medium disabled:opacity-40",
                on ? "bg-brand-soft text-brand-ink" : "bg-fill text-sub hover:bg-line",
              )}
            >
              {p}
            </button>
          );
        })}
      </div>

      <div>
        <label htmlFor={`${ids}-draft`} className="block text-[14px] font-semibold">
          직접 적기
        </label>
        <div className="mt-1.5 flex gap-2">
          <input
            id={`${ids}-draft`}
            value={draft}
            maxLength={THESIS_MAX_LEN + 20}
            aria-describedby={cn(`${ids}-count`, hint && `${ids}-hint`)}
            aria-invalid={draft.trim().length > THESIS_MAX_LEN || undefined}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                addDraft();
              }
            }}
            placeholder={full ? `이유는 ${THESIS_MAX_REASONS}개까지예요` : "예: 새 공장이 내년에 가동된다고 공시해서"}
            disabled={full}
            className="h-12 min-w-0 flex-1 rounded-xl bg-fill px-3.5 text-[15px] outline-none placeholder:text-mute-weak focus:ring-2 focus:ring-brand disabled:opacity-50"
          />
          <button
            type="button"
            onClick={addDraft}
            disabled={full || !draft.trim()}
            className="press h-12 shrink-0 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line disabled:opacity-40"
          >
            추가
          </button>
        </div>
        <p
          id={`${ids}-count`}
          className={cn("mt-1 text-right text-[12px] tabular-nums", draft.trim().length > THESIS_MAX_LEN ? "font-semibold text-up-ink" : "text-mute")}
        >
          {draft.trim().length}/{THESIS_MAX_LEN}자
        </p>
      </div>

      <fieldset>
        <legend className="text-[14px] font-semibold">{easy ? "먼저 볼 것 (선택)" : "점검할 축 (선택)"}</legend>
        <p className="text-[12px] text-mute">
          {easy ? "고르지 않으면 셋 다 봐요. 고른 것의 숫자를 먼저 보여 줘요." : "고르지 않으면 셋 다 점검해요. 고른 축의 지표를 먼저 보여 줘요."}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {THESIS_AXES.map((a) => (
            <label key={a} className="flex h-11 cursor-pointer items-center gap-2 rounded-xl bg-fill px-3.5 text-[14px] transition-colors hover:bg-line">
              <input
                type="checkbox"
                checked={axes.includes(a)}
                onChange={(e) => setAxes((cur) => (e.target.checked ? THESIS_AXES.filter((x) => x === a || cur.includes(x)) : cur.filter((x) => x !== a)))}
                className="size-4 accent-brand"
              />
              {THESIS_AXIS_TEXT[a]}
            </label>
          ))}
        </div>
      </fieldset>

      {hint && (
        <p id={`${ids}-hint`} role="alert" className="text-[13px] font-medium text-up-ink">
          {hint}
        </p>
      )}
      {save.isError && <Notice tone="error">{errorMessage(save.error)}</Notice>}

      <div
        className={cn(
          "flex gap-2",
          // 시트 바닥에 붙는다. sticky는 스크롤 상자의 안쪽 여백 안에서 멈추므로 아래 여백(p-5·안전 영역)만큼 내려 덮고, 끝까지 내려도 위치가 같게 같은 만큼 당긴다
          stickyActions &&
            "sticky -bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-10 -mx-5 -mb-[max(1.25rem,env(safe-area-inset-bottom))] border-t border-line bg-card px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:-bottom-5 lg:-mb-5 lg:pb-5",
        )}
      >
        {onCancel && (
          <button type="button" onClick={onCancel} className="press h-12 flex-1 rounded-xl bg-fill text-[15px] font-semibold text-sub hover:bg-line">
            취소
          </button>
        )}
        <button
          type="submit"
          disabled={save.isPending || (reasons.length === 0 && !draft.trim())}
          className="press flex h-12 flex-[2] items-center justify-center gap-2 rounded-xl bg-brand text-[15px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {save.isPending && <Spinner />}
          산 이유 저장
        </button>
      </div>
    </form>
  );
}
