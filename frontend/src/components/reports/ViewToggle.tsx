// 이 화면만 보기 바꾸기 (?view=, 저장하지 않음). 주린이모드는 마이에서 바꾼다 (hooks/useBeginnerMode.ts). 리포트·홈 등 여러 화면이 같이 쓴다.
// 라벨은 지금 상태에서 '누르면 어디로 가는지'를 말한다:
// - 이 화면만 바꾼 상태(덮어쓰기): '쉬운 보기로 돌아가기' / '전문가 보기로 돌아가기' (원래 보기로 돌아간다)
// - 원래 보기: '이 화면만 자세히 보기' / '이 화면만 쉽게 보기'
// - compact(화면 머리처럼 좁은 자리): '전문가 보기' / '쉬운 보기'
// 바꾼 뒤 맨 위로 가는 것과 새 보기의 페이드는 ScrollManager·RouteTransition이 한다 (?view가 바뀌면 새 화면으로 본다).
import type { ViewModeState } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";
import { Icon } from "../Icon";

export function ViewToggle({
  view,
  compact = false,
  placement,
  className,
}: {
  view: ViewModeState;
  compact?: boolean;
  /** header: 화면 머리(바탕 위 — 카드색 + 테두리), card: 카드 안(연한 회색). 정하지 않으면 compact는 header, 아니면 card */
  placement?: "header" | "card";
  className?: string;
}) {
  const where = placement ?? (compact ? "header" : "card");
  const ownView = view.beginnerMode ? "easy" : "expert";
  // 주소의 ?view가 원래 보기와 다를 때만 '이 화면만 바꾼 상태'다 (원래 보기와 같은 ?view=는 덮어쓰기가 아니다)
  const overridden = view.override !== null && view.override !== ownView;
  const toExpert = view.easy;
  const label = compact
    ? toExpert
      ? "전문가 보기"
      : "쉬운 보기"
    : overridden
      ? toExpert
        ? "전문가 보기로 돌아가기"
        : "쉬운 보기로 돌아가기"
      : toExpert
        ? "이 화면만 자세히 보기"
        : "이 화면만 쉽게 보기";
  const next = overridden ? null : toExpert ? "expert" : "easy";
  return (
    <button
      type="button"
      onClick={() => view.setView(next)}
      className={cn(
        // 보이는 높이 36px, 누름 영역은 위아래 4px 더 (44px)
        "press relative flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-semibold whitespace-nowrap text-sub before:absolute before:-inset-1",
        where === "header" ? "bg-card ring-1 ring-line hover:bg-fill" : "bg-fill hover:bg-line",
        className,
      )}
    >
      <Icon name="swap" className="size-4 shrink-0" />
      {label}
    </button>
  );
}
