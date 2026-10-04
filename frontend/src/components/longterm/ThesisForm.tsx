// 산 이유 입력 ("왜 샀나요?", docs/API.md "장기투자" PUT /api/longterm/theses/{symbol}).
//
// - 이유 1~3개 (각 1~100자, 앞뒤 공백을 지운 뒤): 예시(THESIS_PRESETS)를 눌러 넣거나 직접 적는다.
// - 점검할 축(성장·수익성·재무 안정)은 고르지 않아도 된다 (고르지 않으면 셋 다). 축은 판정을 바꾸지 않고 보이는 순서만 바꾼다.
// - 저장은 useSaveThesis(symbol) (PUT). 400이면 서버 detail을 보인다. 저장되면 onSaved(thesis).
// - 장기 보유 주문(OrderPanel의 "장기 보유")과 종목 상세의 펀더멘털 패널에서 연다.
import { useId, useState } from "react";
import { errorMessage } from "../../api/client";
import { useSaveThesis } from "../../api/longterm";
import type { Thesis, ThesisAxis } from "../../api/types";
import { cn } from "../../lib/cn";
import { THESIS_AXIS_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Notice, Spinner } from "../ui";
import { THESIS_AXES, THESIS_MAX_LEN, THESIS_MAX_REASONS, THESIS_PRESETS } from "./longtermText";

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
  className?: string;
}

export function ThesisForm({ symbol, name, initial = null, onSaved, onCancel, intro = true, className }: ThesisFormProps) {
  const [reasons, setReasons] = useState<string[]>(initial?.reasons ?? []);
  const [axes, setAxes] = useState<ThesisAxis[]>(initial?.axes ?? []);
  const [draft, setDraft] = useState("");
  const [hint, setHint] = useState<string | null>(null);
  const save = useSaveThesis(symbol);
  const ids = useId();
  const full = reasons.length >= THESIS_MAX_REASONS;

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
      aria-label={`${name} 산 이유`}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={cn("space-y-4", className)}
    >
      {intro && (
        <div>
          <h3 className="text-[16px] font-bold">왜 샀나요?</h3>
          <p className="mt-0.5 text-[13px] leading-snug text-mute">
            {name}을(를) 산 이유를 1~{THESIS_MAX_REASONS}개 남겨 두면, 정기공시가 나올 때 그 이유와 관련된 숫자를 같이 점검해요. 매도를 권하거나 자동으로 팔지 않아요.
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
              <li key={r} className="flex items-center gap-2 rounded-xl bg-fill px-3.5 py-2.5 text-[14px]">
                <span className="min-w-0 flex-1 break-words">{r}</span>
                <button
                  type="button"
                  onClick={() => remove(r)}
                  aria-label={`"${r}" 지우기`}
                  className="grid size-8 shrink-0 place-items-center rounded-full text-mute hover:bg-line"
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
                "min-h-9 rounded-full px-3 py-1.5 text-left text-[13px] font-medium disabled:opacity-40",
                on ? "bg-brand-soft text-brand-dark" : "bg-fill text-sub hover:bg-line",
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
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                addDraft();
              }
            }}
            placeholder={full ? `이유는 ${THESIS_MAX_REASONS}개까지예요` : "예: 새 공장이 내년에 가동된다고 공시해서"}
            disabled={full}
            className="h-12 min-w-0 flex-1 rounded-xl bg-fill px-3.5 text-[15px] outline-none focus:ring-2 focus:ring-brand disabled:opacity-50"
          />
          <button
            type="button"
            onClick={addDraft}
            disabled={full || !draft.trim()}
            className="h-12 shrink-0 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line disabled:opacity-40"
          >
            추가
          </button>
        </div>
        <p className="mt-1 text-right text-[12px] text-mute tabular-nums">
          {draft.trim().length}/{THESIS_MAX_LEN}자
        </p>
      </div>

      <fieldset>
        <legend className="text-[14px] font-semibold">점검할 축 (선택)</legend>
        <p className="text-[12px] text-mute">고르지 않으면 셋 다 점검해요. 고른 축의 지표를 먼저 보여 줘요.</p>
        <div className="mt-1.5 flex flex-wrap gap-2">
          {THESIS_AXES.map((a) => (
            <label key={a} className="flex h-10 cursor-pointer items-center gap-2 rounded-xl bg-fill px-3 text-[14px]">
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
        <p role="alert" className="text-[13px] text-up">
          {hint}
        </p>
      )}
      {save.isError && <Notice tone="error">{errorMessage(save.error)}</Notice>}

      <div className="flex gap-2">
        {onCancel && (
          <button type="button" onClick={onCancel} className="h-12 flex-1 rounded-xl bg-fill text-[15px] font-semibold text-sub hover:bg-line">
            취소
          </button>
        )}
        <button
          type="submit"
          disabled={save.isPending || (reasons.length === 0 && !draft.trim())}
          className="flex h-12 flex-[2] items-center justify-center gap-2 rounded-xl bg-brand text-[15px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
        >
          {save.isPending && <Spinner />}
          산 이유 저장
        </button>
      </div>
    </form>
  );
}
