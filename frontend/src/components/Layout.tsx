import type { MouseEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from "react-router";
import { useMarket, useMe, useReports } from "../api/queries";
import { useViewMode } from "../hooks/useBeginnerMode";
import { cn } from "../lib/cn";
import { SERVICE_NAME, sourceLine } from "../lib/plainText";
import { ADMIN_PATH, useSecretTaps } from "../lib/secretTaps";
import { NotificationMenuItem } from "./autotrade/NotificationBell";
import { inProgressReports } from "./home/homeData";
import { Icon, type IconName } from "./Icon";

/** match: 이 탭이 켜지는 주소 (탭 안에서 들어가는 화면 포함 — 주소는 바꾸지 않고 탭만 묶는다). */
type Tab = { to: string; label: string; icon: IconName; match: (path: string) => boolean };

const under =
  (...roots: string[]) =>
  (path: string) =>
    roots.some((r) => path === r || path.startsWith(`${r}/`));

const HOME: Tab = { to: "/", label: "홈", icon: "home", match: (p) => p === "/" };
const STOCKS: Tab = { to: "/search", label: "종목", icon: "search", match: under("/search", "/stocks") };
const REPORTS: Tab = { to: "/reports", label: "리포트", icon: "doc", match: under("/reports", "/analyses") };
// 모의투자 = 진행 중 모의 자동매매 + 보유·주문 + 새 계획 제안 + 단타 연습장 (docs/컨셉변경계획.md 4-1)
const TRADE: Tab = { to: "/portfolio", label: "모의투자", icon: "pie", match: under("/portfolio", "/plans", "/recommendations", "/day") };
const MY: Tab = { to: "/my", label: "마이", icon: "user", match: under("/my", "/ranking") };

// 하단 탭 5개 (360px에서 칸마다 72px). 랭킹은 마이·홈 카드로, 알림은 화면 위 종(PC는 왼쪽 메뉴)으로 간다.
const TABS: Tab[] = [HOME, STOCKS, REPORTS, TRADE, MY];

/** 만드는 중인 내 리포트가 있을 때 "리포트" 탭에 붙는 점의 설명 (docs/컨셉변경계획.md 4-6). */
const MAKING_ID = "reports-tab-making";
const MAKING_TEXT = "만드는 중인 내 리포트가 있어요";

/** "리포트" 탭의 점 (●). 화면 읽기 프로그램에는 링크 설명(aria-describedby)으로 알린다. */
function MakingDot({ className }: { className?: string }) {
  return <span aria-hidden="true" data-making-dot="" className={cn("size-2 rounded-full bg-brand", className)} />;
}

const sideClass = (active: boolean) =>
  cn(
    "flex h-12 items-center gap-3 rounded-xl px-3 text-[16px] font-semibold transition-colors",
    active ? "bg-fill text-ink" : "text-mute hover:bg-fill/60 hover:text-sub",
  );

/** 모바일: 한 열 + 하단 탭. PC(lg 이상): 왼쪽 메뉴(하단 탭과 같은 순서) + 넓은 본문. 본문 아래에 출처 줄. */
export function Layout() {
  const { data: me } = useMe();
  const { data: market } = useMarket();
  // 홈의 "만드는 중인 리포트"·리포트 목록(내 리포트)과 같은 캐시
  const { data: mineReports } = useReports({ mine: true });
  const making = inProgressReports(mineReports?.results ?? []).length > 0;
  const { pathname } = useLocation();
  // 종목 상세의 전문가 보기는 하단에 주문 버튼(바텀시트)이 붙으므로 모바일 하단 탭을 숨긴다.
  // 쉬운 보기는 하단 버튼 없이 본문 안에 주문(AdvancedOrder)을 두므로 탭을 그대로 보인다 (StockPage와 같은 판단).
  const onStock = useMatch("/stocks/:symbol");
  const { expert } = useViewMode();
  const hideTabs = Boolean(onStock) && expert;
  // 숨은 관리자 입구: "리포트" 메뉴를 8번 연속 누르면 관리자 화면 (src/lib/secretTaps.ts)
  const navigate = useNavigate();
  const tapReports = useSecretTaps();
  const onTabClick = (t: Tab) => (e: MouseEvent) => {
    if (t.to !== REPORTS.to || !tapReports()) return;
    e.preventDefault();
    navigate(ADMIN_PATH);
  };

  const dotOn = (t: Tab) => making && t === REPORTS;

  const sideLink = (t: Tab) => {
    const active = t.match(pathname);
    return (
      <Link
        key={t.to}
        to={t.to}
        aria-current={active ? "page" : undefined}
        aria-describedby={dotOn(t) ? MAKING_ID : undefined}
        onClick={onTabClick(t)}
        className={sideClass(active)}
      >
        <Icon name={t.icon} className="size-5" />
        {t.label}
        {dotOn(t) && <MakingDot className="ml-auto" />}
      </Link>
    );
  };

  return (
    <div className="min-h-dvh">
      <span id={MAKING_ID} hidden>
        {MAKING_TEXT}
      </span>
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-line bg-card px-4 py-6 lg:flex">
        <NavLink to="/" className="mb-8 flex items-center gap-2 px-3 text-[19px] font-extrabold tracking-tight text-ink">
          <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-xl bg-brand text-[13px] text-white">
            AI
          </span>
          {SERVICE_NAME}
        </NavLink>
        <nav aria-label="주 메뉴" className="flex flex-col gap-1">
          {[HOME, STOCKS, REPORTS, TRADE].map(sideLink)}
          <NotificationMenuItem />
          {sideLink(MY)}
        </nav>
        {me && (
          <NavLink to="/my" className="mt-auto rounded-xl px-3 py-3 hover:bg-fill">
            <p className="text-[15px] font-bold text-ink">{me.nickname}</p>
            <p className="text-[13px] text-mute">@{me.username}</p>
          </NavLink>
        )}
      </aside>

      <main className={cn("min-w-0 lg:pl-60", hideTabs ? "pb-28 lg:pb-10" : "pb-24 lg:pb-10")}>
        <div className="mx-auto w-full max-w-[1120px] px-4 lg:px-8 lg:pt-8">
          <Outlet />
          <footer aria-label="자료 출처" className="mt-10 border-t border-line pt-4 pb-2 text-[11px] leading-relaxed text-mute">
            {sourceLine(market?.quoteProvider ?? "증권사")}
          </footer>
        </div>
      </main>

      {!hideTabs && (
        <nav
          aria-label="하단 탭"
          className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
        >
          <ul className="mx-auto grid max-w-[640px] grid-cols-5">
            {TABS.map((t) => {
              const active = t.match(pathname);
              return (
                <li key={t.to}>
                  <Link
                    to={t.to}
                    aria-current={active ? "page" : undefined}
                    aria-describedby={dotOn(t) ? MAKING_ID : undefined}
                    onClick={onTabClick(t)}
                    className={cn(
                      "flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold whitespace-nowrap",
                      active ? "text-ink" : "text-mute",
                    )}
                  >
                    <span className="relative">
                      <Icon name={t.icon} className="size-6" />
                      {dotOn(t) && <MakingDot className="absolute -top-0.5 -right-1 ring-2 ring-card" />}
                    </span>
                    {t.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      )}
    </div>
  );
}
