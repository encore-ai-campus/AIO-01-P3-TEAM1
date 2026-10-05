// 종 아이콘 + 안 읽은 알림 수 배지 (15초 폴링). 모바일은 화면 위쪽 오른쪽, PC는 왼쪽 메뉴.
// 배지는 수가 늘었을 때만 한 번 튄다(pop-in). 처음 불러온 수·줄어든 수·화면 이동으로 다시 그린 종은 움직이지 않는다.
import { useState } from "react";
import { NavLink } from "react-router";
import { useNotifications } from "../../api/queries";
import { cn } from "../../lib/cn";
import { Icon } from "../Icon";

function useUnread(): { unread: number; ready: boolean } {
  const { data } = useNotifications(true);
  return { unread: data?.unreadCount ?? 0, ready: data !== undefined };
}

/** 수가 늘어난 횟수 (배지 key로 써서 늘 때마다 pop-in을 다시 튼다). 처음 받은 수가 기준이다. */
function useBumps(count: number, ready: boolean): number {
  const [seen, setSeen] = useState<{ count: number | null; bumps: number }>({ count: ready ? count : null, bumps: 0 });
  if (ready && seen.count !== count) {
    // 렌더 중 조건부 파생 상태 (ui.tsx Flash와 같은 패턴)
    setSeen({ count, bumps: seen.count !== null && count > seen.count ? seen.bumps + 1 : seen.bumps });
  }
  return seen.bumps;
}

const badgeText = (n: number) => (n > 99 ? "99+" : String(n));
const label = (n: number) => (n > 0 ? `알림 (안 읽은 알림 ${n}개)` : "알림");

/** 화면 머리의 종 버튼 (모바일). 알림 화면에 있으면 눌린 모양으로 '지금 여기'를 보인다. */
export function NotificationBell({ className }: { className?: string }) {
  const { unread, ready } = useUnread();
  const bumps = useBumps(unread, ready);
  return (
    <NavLink
      to="/notifications"
      aria-label={label(unread)}
      className={({ isActive }) =>
        cn(
          "relative grid size-11 shrink-0 place-items-center rounded-full transition-colors active:bg-line/60",
          isActive ? "bg-card text-brand" : "text-ink hover:bg-line/60",
          className,
        )
      }
    >
      <Icon name="bell" />
      {unread > 0 && (
        <span
          key={bumps}
          className={cn(
            "absolute top-1.5 right-1 min-w-[18px] rounded-full bg-up px-1 text-center text-[11px] leading-[18px] font-bold text-white tabular-nums",
            bumps > 0 && "animate-pop-in",
          )}
        >
          {badgeText(unread)}
        </span>
      )}
    </NavLink>
  );
}

/** 왼쪽 메뉴의 알림 줄 (PC). */
export function NotificationMenuItem() {
  const { unread, ready } = useUnread();
  const bumps = useBumps(unread, ready);
  return (
    <NavLink
      to="/notifications"
      aria-label={label(unread)}
      className={({ isActive }) =>
        cn(
          "flex h-12 items-center gap-3 rounded-xl px-3 text-[16px] font-semibold transition-colors active:bg-fill",
          isActive ? "bg-fill text-ink" : "text-mute hover:bg-fill/60 hover:text-sub",
        )
      }
    >
      <Icon name="bell" className="size-5" />
      알림
      {unread > 0 && (
        <span
          key={bumps}
          className={cn(
            "ml-auto min-w-[22px] rounded-full bg-up px-1.5 text-center text-[12px] leading-[22px] font-bold text-white tabular-nums",
            bumps > 0 && "animate-pop-in",
          )}
        >
          {badgeText(unread)}
        </span>
      )}
    </NavLink>
  );
}
