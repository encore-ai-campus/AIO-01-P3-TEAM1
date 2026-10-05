// 바텀시트(모바일) · 가운데 대화상자(PC, lg 이상). body 포털이라 페이지 래퍼의 opacity·쌓임과 무관하게 화면 위에 뜬다.
// 모바일은 아래(엄지 쪽)에서 올라와 아래로 내려가며 닫히고, PC는 살짝 커지며 나타난다. 움직임은 index.css의 .sheet-*.
// 스크림을 누르거나 Esc를 누르면 닫힌다. 끌어 닫기는 하지 않으므로 손잡이(grabber)는 그리지 않는다.
import { type ReactNode, type RefObject, useRef } from "react";
import { createPortal } from "react-dom";
import { useModal } from "../../hooks/useModal";
import { usePresence } from "../../hooks/usePresence";
import { cn } from "../../lib/cn";

export function Sheet({
  open,
  onClose,
  labelledBy,
  describedBy,
  children,
  initialFocus,
  returnFocus,
  className,
}: {
  open: boolean;
  onClose: () => void;
  /** 시트 안 제목 요소의 id (role=dialog의 이름) */
  labelledBy: string;
  /**
   * 시트 안 설명 요소의 id (aria-describedby). 열릴 때 화면 읽기가 이름 다음에 읽는다 — 방금 일어난 일(주문 결과 등)을
   * 알리려고 그 글에 포커스를 줄 필요가 없다 (처음 포커스는 조작할 수 있는 곳에 둔다)
   */
  describedBy?: string;
  children: ReactNode;
  /** 처음 포커스를 줄 요소 (기본: 시트 안 첫 버튼·입력). 되돌리기 어려운 동작이면 안전한 쪽('닫기' 등)을 준다 */
  initialFocus?: RefObject<HTMLElement | null>;
  /** 닫힌 뒤 포커스를 돌려줄 요소 (기본: 열기 전 포커스) */
  returnFocus?: RefObject<HTMLElement | null>;
  /** 패널에 더할 클래스 */
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { present, state } = usePresence(open, root, { subtree: true });
  useModal(panel, { active: open, onClose, initialFocus, returnFocus });
  if (!present) return null;
  return createPortal(
    <div
      ref={root}
      data-state={state}
      className="sheet-root fixed inset-0 z-(--z-sheet) flex items-end justify-center lg:items-center lg:p-6"
    >
      {/* 스크림은 버튼이 아니다 (화면 읽기에 '닫기'가 두 번 나오지 않게). 키보드로는 시트 안 닫기 버튼과 Esc로 닫는다.
          닫히는 동안에도 잠그지 않는다: 아직 보이는 시트를 다시 누른 클릭(더블클릭·연타)을 여기서 받아 onClose만 한 번 더 부른다.
          층 전체를 inert로 두면 클릭이 층을 지나 그 뒤 화면(배경 잠금은 이미 풀렸다)의 버튼을 누른다 */}
      <div aria-hidden="true" data-inert-exempt="" className="sheet-scrim absolute inset-0" onClick={onClose} />
      <div
        ref={panel}
        // 닫히는 동안 패널 안 버튼은 다시 눌리지 않게 잠근다 (패널 자리를 누른 클릭은 inert 패널을 지나 스크림이 받는다)
        inert={state === "closing"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={cn(
          "sheet-panel relative max-h-[88dvh] w-full overflow-y-auto overscroll-contain rounded-t-3xl bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] outline-none lg:max-w-md lg:rounded-3xl lg:pb-5",
          className,
        )}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
