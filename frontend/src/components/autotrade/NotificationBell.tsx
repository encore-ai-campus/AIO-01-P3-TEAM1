// 종 아이콘 + 안 읽은 알림 수 배지 (15초 폴링). 모바일은 화면 위쪽 오른쪽, PC는 왼쪽 메뉴.
import { NavLink } from "react-router";
import { useNotifications } from "../../api/queries";
import { cn } from "../../lib/cn";
import { Icon } from "../Icon";

function useUnread(): number {
  const { data } = useNotifications(true);
  return data?.unreadCount ?? 0;
}

const badgeText = (n: number) => (n > 99 ? "99+" : String(n));

/** 화면 머리의 종 버튼 (모바일). */
export function NotificationBell({ className }: { className?: string }) {
  const unread = useUnread();
  return (
    <NavLink
      to="/notifications"
      aria-label={unread > 0 ? `알림 (안 읽은 알림 ${unread}개)` : "알림"}
      className={cn("relative grid size-11 shrink-0 place-items-center rounded-full text-ink hover:bg-line/60", className)}
    >
      <Icon name="bell" />
      {unread > 0 && (
        <span className="absolute top-1.5 right-1 min-w-[18px] rounded-full bg-up px-1 text-center text-[11px] leading-[18px] font-bold text-white tabular-nums">
          {badgeText(unread)}
        </span>
      )}
    </NavLink>
  );
}

/** 왼쪽 메뉴의 알림 줄 (PC). */
export function NotificationMenuItem() {
  const unread = useUnread();
  return (
    <NavLink
      to="/notifications"
      aria-label={unread > 0 ? `알림 (안 읽은 알림 ${unread}개)` : "알림"}
      className={({ isActive }) =>
        cn(
          "flex h-12 items-center gap-3 rounded-xl px-3 text-[16px] font-semibold transition-colors",
          isActive ? "bg-fill text-ink" : "text-mute hover:bg-fill/60 hover:text-sub",
        )
      }
    >
      <Icon name="bell" className="size-5" />
      알림
      {unread > 0 && (
        <span className="ml-auto min-w-[22px] rounded-full bg-up px-1.5 text-center text-[12px] leading-[22px] font-bold text-white tabular-nums">
          {badgeText(unread)}
        </span>
      )}
    </NavLink>
  );
}
