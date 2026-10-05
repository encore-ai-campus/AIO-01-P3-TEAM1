// 접힘 영역: 버튼 아래로 펼쳐지고(240ms) 위로 접힌다(160ms). 닫히면 언마운트한다 (숨은 입력이 남지 않게, ByLabelText 테스트 계약).
// 트리거 버튼: <button aria-expanded={open} aria-controls={open ? id : undefined}> … chevron(transition-transform duration-fast 회전)
// CSS 클래스가 collapse가 아닌 이유: Tailwind 기본 유틸 collapse(visibility: collapse)와 이름이 겹쳐 내용이 사라진다.
import { type ReactNode, useRef } from "react";
import { usePresence } from "../../hooks/usePresence";
import { cn } from "../../lib/cn";

/**
 * className은 바깥 여백(mt-3 등)·자리(grid 열 등)에만 쓴다. 안쪽 여백은 children에 둔다 (접힌 높이가 0이 되게).
 * 바깥 위·아래 여백(부모 space-y가 준 것 포함)은 높이와 함께 접히고 펼쳐진다 (index.css .collapsible) — 닫힌 뒤 여백만큼 툭 튀지 않는다.
 */
export function Collapse({ open, id, className, children }: { open: boolean; id?: string; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const { present, state, appear } = usePresence(open, ref);
  if (!present) return null;
  return (
    <div ref={ref} id={id} data-state={state} data-appear={appear || undefined} inert={state === "closing"} className={cn("collapsible", className)}>
      <div className="collapsible-body">{children}</div>
    </div>
  );
}
