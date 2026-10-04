// 주린이모드를 끄기 전 한 줄 확인 (docs/투자서비스확장계획.md 2-2: 끌 때 "어려운 용어·숫자가 그대로 나와요").
import { Spinner } from "../ui";

export const CONFIRM_OFF_TEXT = "어려운 용어·숫자가 그대로 나와요";

export function ConfirmOff({ onConfirm, onCancel, busy = false }: { onConfirm: () => void; onCancel: () => void; busy?: boolean }) {
  return (
    <div role="group" aria-label="주린이모드 끄기 확인" className="rounded-xl bg-warn-soft px-3.5 py-3">
      <p className="text-[14px] font-semibold text-[#9a5b00]">{CONFIRM_OFF_TEXT}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="flex h-10 items-center gap-1.5 rounded-xl bg-ink px-4 text-[14px] font-semibold text-white hover:bg-sub disabled:opacity-40"
        >
          {busy && <Spinner />}
          주린이모드 끄기
        </button>
        <button type="button" onClick={onCancel} className="h-10 rounded-xl bg-card px-4 text-[14px] font-semibold text-sub hover:bg-line">
          취소
        </button>
      </div>
    </div>
  );
}
