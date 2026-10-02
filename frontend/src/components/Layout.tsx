import { NavLink, Outlet, useMatch } from "react-router";
import { useMe } from "../api/queries";
import { cn } from "../lib/cn";
import { Icon, type IconName } from "./Icon";

const TABS: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: "/", label: "홈", icon: "home", end: true },
  { to: "/portfolio", label: "내 주식", icon: "pie" },
  { to: "/reports", label: "리포트", icon: "doc" },
  { to: "/ranking", label: "랭킹", icon: "trophy" },
  { to: "/my", label: "마이", icon: "user" },
];

const SIDE: typeof TABS = [TABS[0], { to: "/search", label: "종목 검색", icon: "search" }, ...TABS.slice(1)];

/** 모바일: 한 열 + 하단 탭. PC(lg 이상): 왼쪽 메뉴 + 넓은 본문. */
export function Layout() {
  const { data: me } = useMe();
  // 종목 상세는 하단에 주문 버튼이 붙으므로 모바일 하단 탭을 숨긴다
  const onStock = useMatch("/stocks/:symbol");

  return (
    <div className="min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-card px-4 py-6 lg:flex">
        <NavLink to="/" className="mb-8 flex items-center gap-2 px-3 text-[20px] font-extrabold tracking-tight text-ink">
          <span className="grid size-8 place-items-center rounded-xl bg-brand text-[15px] text-white">모</span>
          모의매매
        </NavLink>
        <nav aria-label="주 메뉴" className="flex flex-col gap-1">
          {SIDE.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                cn(
                  "flex h-12 items-center gap-3 rounded-xl px-3 text-[16px] font-semibold transition-colors",
                  isActive ? "bg-fill text-ink" : "text-mute hover:bg-fill/60 hover:text-sub",
                )
              }
            >
              <Icon name={t.icon} className="size-5" />
              {t.label}
            </NavLink>
          ))}
        </nav>
        {me && (
          <NavLink to="/my" className="mt-auto rounded-xl px-3 py-3 hover:bg-fill">
            <p className="text-[15px] font-bold text-ink">{me.nickname}</p>
            <p className="text-[13px] text-mute">@{me.username}</p>
          </NavLink>
        )}
      </aside>

      <main className={cn("min-w-0 lg:pl-60", onStock ? "pb-28 lg:pb-10" : "pb-24 lg:pb-10")}>
        <div className="mx-auto w-full max-w-[1120px] px-4 lg:px-8 lg:pt-8">
          <Outlet />
        </div>
      </main>

      {!onStock && (
        <nav
          aria-label="하단 탭"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        >
          <ul className="mx-auto grid max-w-[640px] grid-cols-5">
            {TABS.map((t) => (
              <li key={t.to}>
                <NavLink
                  to={t.to}
                  end={t.end}
                  className={({ isActive }) =>
                    cn(
                      "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold",
                      isActive ? "text-ink" : "text-mute",
                    )
                  }
                >
                  <Icon name={t.icon} className="size-6" />
                  {t.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}
