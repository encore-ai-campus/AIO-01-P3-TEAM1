// 주린이모드를 끄기 전 한 줄 확인 (docs/plans/투자서비스확장계획.md 2-2: 끌 때 "어려운 용어·숫자가 그대로 나와요").
// 확인 버튼은 주 색(brand)이 아니라 반전 쌍(bg-ink + text-on-ink)이다: 보호 모드를 끄는 동작을 화면에서 가장 권하는 버튼처럼 보이지 않게.
// 열리면 '주린이모드 끄기'로 포커스를 옮기고(누른 스위치·버튼이 사라지거나 그대로여도 다음 할 일이 여기라서), Esc는 취소다.
import { type KeyboardEvent, useEffect, useRef } from "react";
import { Spinner } from "../ui";

export const CONFIRM_OFF_TEXT = "어려운 용어·숫자가 그대로 나와요";

export function ConfirmOff({ onConfirm, onCancel, busy = false }: { onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirm.current?.focus({ preventScroll: true }); // 바로 위에서 연 상자라 화면을 옮기지 않는다
  }, []);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    e.preventDefault();
    onCancel();
  };
  return (
    <div role="group" aria-label="주린이모드 끄기 확인" onKeyDown={onKeyDown} className="rounded-xl bg-warn-soft px-3.5 py-3">
      <p className="text-[14px] font-semibold text-warn-ink">{CONFIRM_OFF_TEXT}</p>
      <div className="mt-2.5 flex gap-2">
        <button
          ref={confirm}
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="press flex h-11 items-center gap-1.5 rounded-xl bg-ink px-4 text-[14px] font-semibold text-on-ink hover:bg-sub disabled:opacity-40"
        >
          {busy && <Spinner />}
          주린이모드 끄기
        </button>
        <button type="button" onClick={onCancel} className="press h-11 rounded-xl bg-card px-4 text-[14px] font-semibold text-sub hover:bg-line">
          취소
        </button>
      </div>
    </div>
  );
}
