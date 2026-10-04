import type { MouseEvent } from "react";
import { NavLink, Outlet, useMatch, useNavigate } from "react-router";
import { useMe } from "../api/queries";
import { cn } from "../lib/cn";
import { ADMIN_PATH, useSecretTaps } from "../lib/secretTaps";
import { NotificationMenuItem } from "./autotrade/NotificationBell";
import { Icon, type IconName } from "./Icon";

type Tab = { to: string; label: string; icon: IconName; end?: boolean };

const HOME: Tab = { to: "/", label: "홈", icon: "home", end: true };
const RECS: Tab = { to: "/recommendations", label: "추천", icon: "sparkle" };
const PORTFOLIO: Tab = { to: "/portfolio", label: "내 주식", icon: "pie" };
const REPORTS: Tab = { to: "/reports", label: "리포트", icon: "doc" };
const RANKING: Tab = { to: "/ranking", label: "랭킹", icon: "trophy" };
const MY: Tab = { to: "/my", label: "마이", icon: "user" };

// 하단 탭 6개 (360px에서 칸마다 60px). 내 자동매매·알림·종목 검색은 왼쪽 메뉴와 각 화면의 링크로 간다.
const TABS: Tab[] = [HOME, RECS, PORTFOLIO, REPORTS, RANKING, MY];

const SIDE_TOP: Tab[] = [
  HOME,
  { to: "/search", label: "종목 검색", icon: "search" },
  { ...RECS, label: "AI 추천" },
  PORTFOLIO,
  { to: "/plans", label: "내 자동매매", icon: "flow" },
  REPORTS,
  RANKING,
];

/** 모바일: 한 열 + 하단 탭. PC(lg 이상): 왼쪽 메뉴 + 넓은 본문. */
export function Layout() {
  const { data: me } = useMe();
  // 종목 상세는 하단에 주문 버튼이 붙으므로 모바일 하단 탭을 숨긴다
  const onStock = useMatch("/stocks/:symbol");
  // 숨은 관리자 입구: "리포트" 메뉴를 8번 연속 누르면 관리자 화면 (src/lib/secretTaps.ts)
  const navigate = useNavigate();
  const tapReports = useSecretTaps();
  const onTabClick = (t: Tab) => (e: MouseEvent) => {
    if (t.to !== REPORTS.to || !tapReports()) return;
    e.preventDefault();
    navigate(ADMIN_PATH);
  };

  return (
    <div className="min-h-dvh">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-card px-4 py-6 lg:flex">
        <NavLink to="/" className="mb-8 flex items-center gap-2 px-3 text-[20px] font-extrabold tracking-tight text-ink">
          <span className="grid size-8 place-items-center rounded-xl bg-brand text-[15px] text-white">모</span>
          모의매매
        </NavLink>
        <nav aria-label="주 메뉴" className="flex flex-col gap-1">
          {SIDE_TOP.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              onClick={onTabClick(t)}
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
          <NotificationMenuItem />
          <NavLink
            to={MY.to}
            className={({ isActive }) =>
              cn(
                "flex h-12 items-center gap-3 rounded-xl px-3 text-[16px] font-semibold transition-colors",
                isActive ? "bg-fill text-ink" : "text-mute hover:bg-fill/60 hover:text-sub",
              )
            }
          >
            <Icon name={MY.icon} className="size-5" />
            {MY.label}
          </NavLink>
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
          <ul className="mx-auto grid max-w-[640px] grid-cols-6">
            {TABS.map((t) => (
              <li key={t.to}>
                <NavLink
                  to={t.to}
                  end={t.end}
                  onClick={onTabClick(t)}
                  className={({ isActive }) =>
                    cn(
                      "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold whitespace-nowrap",
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
