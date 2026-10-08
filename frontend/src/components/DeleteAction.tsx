// 리포트·계획 제안 지우기 (2026-10-08, DECISIONS 25장): 화면 맨 아래의 눈에 덜 띄는 버튼 → 확인 시트 → 지우기.
// 확인은 계획 멈추기(PlanPage StopSheet)와 같은 Sheet 대화상자다: 처음 포커스는 안전한 '취소', 닫히면 연 버튼으로 돌아간다.
// 실패하면 서버의 detail 문장을 시트 안에 그대로 보인다 (진행 중인 계획이 있어 지울 수 없음 등). 성공 뒤 이동·토스트는 화면이 정한다.
import { useId, useRef, useState } from "react";
import { errorMessage } from "../api/client";
import { Icon } from "./Icon";
import { Sheet } from "./motion/Sheet";
import { Notice, Spinner } from "./ui";
import { cn } from "../lib/cn";

export function DeleteAction({
  label,
  title,
  description,
  pending,
  error,
  onConfirm,
  onOpen,
  className,
}: {
  /** 화면의 버튼 이름 ("리포트 지우기" 등) */
  label: string;
  /** 확인 시트 제목 ("이 리포트를 지울까요?") */
  title: string;
  /** 무엇이 사라지는지 한두 문장 */
  description: string;
  pending: boolean;
  /** 마지막 지우기 요청의 오류 (없으면 null) */
  error: unknown;
  /** '지우기'를 눌렀을 때. 성공하면 화면이 다른 곳으로 옮기므로 시트를 닫지 않는다 */
  onConfirm: () => void;
  /** 시트를 열 때 (지난번 실패 안내를 지우려고 mutation.reset을 준다) */
  onOpen?: () => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const openRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const descId = useId();
  const close = () => {
    if (!pending) setOpen(false);
  };
  return (
    <div className={cn("flex justify-center", className)}>
      <button
        ref={openRef}
        type="button"
        onClick={() => {
          onOpen?.();
          setOpen(true);
        }}
        className="press inline-flex h-11 items-center gap-1.5 rounded-xl px-3.5 text-[14px] font-semibold text-mute hover:bg-up-soft hover:text-up-ink"
      >
        <Icon name="trash" className="size-4" />
        {label}
      </button>
      <Sheet open={open} onClose={close} labelledBy={titleId} describedBy={descId} initialFocus={cancelRef} returnFocus={openRef}>
        <h2 id={titleId} className="text-[18px] font-bold">
          {title}
        </h2>
        <p id={descId} className="mt-2 text-[15px] leading-relaxed text-sub">
          {description}
        </p>
        {error != null && (
          <div role="alert" className="mt-3">
            <Notice tone="error">{errorMessage(error)}</Notice>
          </div>
        )}
        <div className="mt-5 grid grid-cols-2 gap-2">
          <button ref={cancelRef} type="button" onClick={close} className="press h-12 rounded-xl bg-fill text-[16px] font-semibold text-sub hover:bg-line">
            취소
          </button>
          <button
            type="button"
            aria-disabled={pending || undefined}
            aria-busy={pending || undefined}
            onClick={() => {
              if (!pending) onConfirm();
            }}
            className="press flex h-12 items-center justify-center gap-1.5 rounded-xl bg-up text-[16px] font-semibold text-white hover:bg-up-dark aria-disabled:opacity-60 aria-disabled:hover:bg-up"
          >
            {pending && <Spinner />}
            지우기
          </button>
        </div>
      </Sheet>
    </div>
  );
}
