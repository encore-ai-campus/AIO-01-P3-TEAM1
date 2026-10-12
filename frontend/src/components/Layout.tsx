import { onlineManager } from "@tanstack/react-query";
import { type MouseEvent, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useMarket, useMe, useReports } from "../api/queries";
import { useChanged } from "../hooks/useMotionState";
import { usePresence } from "../hooks/usePresence";
import { useTheme } from "../hooks/useTheme";
import { cn } from "../lib/cn";
import { scrollToTop } from "../lib/motion";
import { HOME, MY, REPORTS, STOCKS, TABS, TRADE, type Tab, tabOf } from "../lib/nav";
import { useOrderBarShown } from "../lib/orderBar";
import { sourceLine } from "../lib/plainText";
import { ADMIN_PATH, useSecretTaps } from "../lib/secretTaps";
import { NotificationMenuItem } from "./autotrade/NotificationBell";
import { BrandLockup } from "./brand/BrandMark";
import { inProgressReports } from "./home/homeData";
import { Icon } from "./Icon";
import { NicknamePrompt } from "./my/NicknamePrompt";
import { RouteErrorBoundary } from "./motion/RouteErrorBoundary";
import { RouteTransition } from "./motion/RouteTransition";
import { Switch } from "./ui";

/** 만드는 중인 내 리포트가 있을 때 "리포트" 탭에 붙는 표시의 설명 (docs/plans/컨셉변경계획.md 4-6). */
const MAKING_ID = "reports-tab-making";
const MAKING_TEXT = "만드는 중인 내 리포트가 있어요";

/**
 * "리포트" 탭의 표시. 깜빡이지 않고 나타날 때 한 번만 튄다. 화면 읽기 프로그램에는 링크 설명(aria-describedby)으로 알린다.
 * 하단 탭은 점(●), PC 왼쪽 메뉴는 자리가 있어 뜻이 보이는 '만드는 중' 칩 (글자는 CSS가 그려 링크 이름에 섞이지 않는다).
 */
function MakingDot({ className }: { className?: string }) {
  return <span aria-hidden="true" data-making-dot="" className={cn("size-2 animate-pop-in rounded-full bg-brand", className)} />;
}
function MakingChip() {
  return (
    <span
      aria-hidden="true"
      data-making-dot=""
      className="ml-auto animate-pop-in rounded-full bg-brand-soft px-2 py-1 text-[12px] leading-none font-bold text-brand-ink after:content-['만드는_중']"
    />
  );
}

const sideClass = (active: boolean) =>
  cn(
    "flex h-12 items-center gap-3 rounded-xl px-3 text-[16px] font-semibold transition-colors active:bg-fill",
    active ? "bg-fill text-ink" : "text-mute hover:bg-fill/60 hover:text-sub",
  );

/** 탭·메뉴 이동은 늘 새 화면의 맨 위에서 연다 (쿼리만 바뀌는 /portfolio?tab=… → /portfolio도 — components/motion/ScrollManager). */
const TOP = { scroll: "top" } as const;

/** 원형 테마 전환의 시작점: 스위치 가운데 (마우스·키보드 모두). */
function centerOf(el: Element) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// 연결 상태 (TanStack Query가 online·offline 이벤트로 아는 값)
const subscribeOnline = (fn: () => void) => onlineManager.subscribe(fn);
const isOnline = () => onlineManager.isOnline();
const serverOnline = () => true;
/** 다시 연결됐다는 안내를 보이는 시간(ms). */
const BACK_ONLINE_MS = 1500;

/**
 * 연결이 끊기면 '끊겼어요' 띠를 보이고, 다시 연결되면 '다시 연결됐어요'를 잠깐 보인 뒤 접는다.
 * 자리는 화면 아래 — 하단 탭·주문 바 바로 위 한 줄, PC는 본문 열 아래 (index.css .connection-region). 위쪽에 두면 화면 머리·검색칸처럼
 * 위에 붙는 요소를 덮는다. 보이는 동안 html[data-connection]과 띠 높이(--connection-h)를 달아 토스트는 띠 위로 올라가고(index.css),
 * 본문 바닥은 띠만큼 늘어 마지막 줄이 띠에 가리지 않는다 (Layout의 바닥 자리).
 * 끊긴 동안 조회는 멈춰 마지막 내용을 그대로 두고(거짓 '없어요'를 보이지 않게 각 화면이 판단), 연결되면 다시 불러온다.
 */
function ConnectionBanner() {
  const online = useSyncExternalStore(subscribeOnline, isOnline, serverOnline);
  const [shown, setShown] = useState<"offline" | "back" | null>(online ? null : "offline");
  if (!online && shown !== "offline") setShown("offline"); // 렌더 중 조건부 파생 상태
  if (online && shown === "offline") setShown("back");
  useEffect(() => {
    if (shown !== "back") return;
    const timer = window.setTimeout(() => setShown(null), BACK_ONLINE_MS);
    return () => window.clearTimeout(timer);
  }, [shown]);
  const ref = useRef<HTMLParagraphElement>(null);
  const { present, state } = usePresence(shown !== null, ref);
  const back = shown !== "offline";

  // 띠가 있는 동안(닫히는 움직임 포함) 높이를 알린다. 글이 바뀌어 줄 수가 달라지면 다시 잰다
  useLayoutEffect(() => {
    const el = ref.current;
    if (!present || !el) return;
    const root = document.documentElement;
    const measure = () => root.style.setProperty("--connection-h", `${el.offsetHeight}px`);
    measure();
    root.setAttribute("data-connection", "");
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.removeAttribute("data-connection");
      root.style.removeProperty("--connection-h");
    };
  }, [present]);

  // 알림 자리(aria-live)는 늘 두고 안의 띠만 넣고 뺀다 — 처음부터 있던 자리라야 화면 읽기 프로그램이 바뀐 내용을 읽는다
  return (
    <div aria-live="polite" className="connection-region">
      {present && (
        <p
          ref={ref}
          data-state={state}
          className={cn(
            // 띠 아래 내용을 눌러 버리지 않게 띠 자체는 누름을 받는다 (보이는 것을 누른다)
            "pointer-events-auto flex max-w-[min(92vw,420px)] items-center gap-2 rounded-2xl px-4 py-2.5 text-[14px] leading-snug font-semibold shadow-md ring-1",
            state === "closing" ? "animate-fade-out" : "animate-fade-in",
            back ? "bg-ok-soft text-ink ring-ok/25" : "bg-warn-soft text-warn-ink ring-warn/30",
          )}
        >
          <Icon name={back ? "check-circle" : "wifi-off"} className={cn("size-4 shrink-0", back && "text-ok")} />
          {back ? "다시 연결됐어요" : "인터넷 연결이 끊겼어요. 연결되면 다시 불러와요"}
        </p>
      )}
    </div>
  );
}

/**
 * 모바일: 한 열 + 하단 탭. PC(lg 이상): 왼쪽 메뉴(하단 탭과 같은 순서) + 넓은 본문. 본문 아래에 출처 줄.
 * - 본문(Outlet)은 화면 오류 경계 + 화면 전환 페이드(opacity만 — 이 감싸개 안에 fixed 구매 바·시트가 있다)로 감싼다. 출처 줄은 바깥.
 * - 스크롤은 App의 ScrollManager가 맡는다. 지금 탭을 다시 누르면 맨 위로 부드럽게 올라간다.
 * - html[data-shell]: 하단 바 종류 (하단 탭 / 종목 상세 구매 바). 토스트·연결 띠가 그 위에 쌓인다 (index.css .toast-region·.connection-region).
 */
export function Layout() {
  const { data: me } = useMe();
  const { data: market } = useMarket();
  // 홈의 "만드는 중인 리포트"·리포트 목록(내 리포트)과 같은 캐시
  const { data: mineReports } = useReports({ mine: true });
  const making = inProgressReports(mineReports?.results ?? []).length > 0;
  const { pathname, search } = useLocation();
  // 종목 상세의 전문가 보기는 하단에 구매 바(바텀시트 열기)가 붙으므로 그동안 모바일 하단 탭을 아래로 내려 숨긴다.
  // 주소가 아니라 화면이 실제로 그린 바를 따른다 (lib/orderBar): 쉬운 보기·없는 종목·오류 화면은 바가 없어 탭이 남는다.
  const hideTabs = useOrderBarShown();
  // 숨은 관리자 입구: "리포트" 메뉴를 8번 연속 누르면 관리자 화면 (src/lib/secretTaps.ts)
  const navigate = useNavigate();
  const tapReports = useSecretTaps();
  const { theme, setPref } = useTheme();
  const main = useRef<HTMLElement>(null);
  // 새로 켜진 탭 아이콘이 한 번 튀는 것(index.css nav[data-ready])은 처음 탭이 바뀐 뒤부터 — 첫 로드·로그인 직후에는 튀지 않는다
  const tabsReady = useChanged(tabOf(pathname)?.to ?? null);

  // 그리기 전에 단다: 구매 바가 생긴 그 화면부터 토스트·연결 띠가 바 위에 있게
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute("data-shell", hideTabs ? "order" : "tabs");
    return () => root.removeAttribute("data-shell");
  }, [hideTabs]);

  const onTabClick = (t: Tab) => (e: MouseEvent<HTMLAnchorElement>) => {
    // 관리자 입구 셈을 먼저 한다 (지금 탭 다시 누르기보다 앞)
    if (t === REPORTS && tapReports()) {
      e.preventDefault();
      navigate(ADMIN_PATH);
      return;
    }
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return; // 새 탭에서 열기 등은 브라우저에 맡긴다
    // 지금 탭(같은 주소)을 다시 누르면 맨 위로. 탭 안의 다른 화면(/reports/12)에서 누르면 그 탭 첫 화면으로 간다
    if (`${pathname}${search}` === t.to) {
      e.preventDefault();
      scrollToTop();
    }
  };

  const markOn = (t: Tab) => making && t === REPORTS;

  const sideLink = (t: Tab) => {
    const active = t.match(pathname);
    return (
      <Link
        key={t.to}
        to={t.to}
        state={TOP}
        aria-current={active ? "page" : undefined}
        aria-describedby={markOn(t) ? MAKING_ID : undefined}
        onClick={onTabClick(t)}
        className={sideClass(active)}
      >
        <Icon name={t.icon} className="size-5" />
        {t.label}
        {markOn(t) && <MakingChip />}
      </Link>
    );
  };

  // 본문 바로가기: 화면 제목(없으면 본문)으로 포커스를 옮긴다. 주소에 #main을 남기지 않는다
  const skipToMain = (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    const target = main.current?.querySelector<HTMLElement>("h1[tabindex]") ?? main.current;
    target?.focus();
  };

  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        onClick={skipToMain}
        className="fixed top-3 left-3 z-(--z-toast) -translate-y-24 rounded-xl bg-ink px-4 py-3 text-[15px] font-semibold text-on-ink opacity-0 focus:translate-y-0 focus:opacity-100"
      >
        본문 바로가기
      </a>
      <span id={MAKING_ID} hidden>
        {MAKING_TEXT}
      </span>
      <aside className="fixed inset-y-0 left-0 z-(--z-nav) hidden w-60 flex-col border-r border-line bg-card px-4 py-6 lg:flex">
        {/* 브랜드·프로필도 홈·마이 탭과 같다: 그 화면에서 다시 누르면 맨 위로 부드럽게. 로고 32px + 이름 19px (부팅 뼈대 RequireAuth와 같은 자리) */}
        <NavLink to="/" state={TOP} onClick={onTabClick(HOME)} className="mb-8 rounded-xl px-3">
          <BrandLockup size={32} className="text-[19px] text-ink" />
        </NavLink>
        <nav aria-label="주 메뉴" className="flex flex-col gap-1">
          {[HOME, STOCKS, REPORTS, TRADE].map(sideLink)}
          <NotificationMenuItem />
          {sideLink(MY)}
        </nav>
        {/* 화면 모드 빠른 스위치 (PC만 — '내 환경' 자리. 기기 설정으로 되돌리기는 마이에서). 누르면 지금 보이는 테마의 반대를 고른다 */}
        <Switch
          checked={theme === "dark"}
          onChange={(_, e) => setPref(theme === "dark" ? "light" : "dark", centerOf(e.currentTarget))}
          label={
            <span className="flex items-center gap-3 text-[16px] font-semibold">
              <Icon name="moon" className="size-5" />
              어두운 모드
            </span>
          }
          className="mt-auto mb-1 h-12 rounded-xl px-3 text-mute transition-colors hover:bg-fill/60 hover:text-sub"
        />
        {me && (
          <NavLink
            to="/my"
            state={TOP}
            onClick={onTabClick(MY)}
            className="rounded-xl px-3 py-3 transition-colors hover:bg-fill active:bg-fill"
          >
            <p className="text-[15px] font-bold text-ink">{me.nickname}</p>
            <p className="text-[13px] text-mute">@{me.username}</p>
          </NavLink>
        )}
      </aside>

      <main
        id="main"
        ref={main}
        tabIndex={-1}
        className={cn("flex min-h-dvh min-w-0 flex-col outline-none lg:pl-60", hideTabs ? "pb-28 lg:pb-10" : "pb-24 lg:pb-10")}
      >
        <ConnectionBanner />
        <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col px-4 lg:px-8 lg:pt-8">
          <div className="mb-10 min-w-0">
            {/* 닉네임이 아직 아이디 그대로면 홈에서만 한 번 묻는다 (다른 화면을 밀지 않는다. 저장하거나 '나중에'면 사라진다 — UX-13) */}
            {me && pathname === HOME.to && <NicknamePrompt me={me} />}
            <RouteErrorBoundary>
              <RouteTransition>
                <Outlet />
              </RouteTransition>
            </RouteErrorBoundary>
          </div>
          {/* 짧은 화면에서도 맨 아래(하단 탭 바로 위)에 붙는다 — 위계가 가장 낮은 정보 */}
          <footer aria-label="자료 출처" className="mt-auto border-t border-line pt-4 pb-2 text-[12px] leading-relaxed text-mute">
            {sourceLine(market?.quoteProvider ?? "증권사")}
          </footer>
        </div>
        {/* 연결 띠가 보이는 동안 그 높이만큼 바닥 자리 (끝까지 내려도 마지막 줄이 띠에 가리지 않게 — 평소에는 0) */}
        <div aria-hidden="true" className="h-(--lift-offline) shrink-0" />
      </main>

      {/* 숨길 때는 언마운트하지 않고 아래로 내린다 (종목 상세 주문 바가 그 자리에 드러난다). 숨은 동안 화면 읽기·Tab에서 빠진다 */}
      <nav
        aria-label="하단 탭"
        aria-hidden={hideTabs || undefined}
        inert={hideTabs}
        data-ready={tabsReady || undefined}
        className={cn(
          "fixed inset-x-0 bottom-0 z-(--z-nav) border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur transition-[translate] duration-base lg:hidden",
          hideTabs ? "translate-y-full ease-exit" : "translate-y-0 ease-enter",
        )}
      >
        <ul className="mx-auto grid max-w-[640px] grid-cols-5">
          {TABS.map((t) => {
            const active = t.match(pathname);
            return (
              <li key={t.to}>
                <Link
                  to={t.to}
                  state={TOP}
                  aria-current={active ? "page" : undefined}
                  aria-describedby={markOn(t) ? MAKING_ID : undefined}
                  onClick={onTabClick(t)}
                  className={cn(
                    "tab-link flex h-16 flex-col items-center justify-center gap-1 text-[11px] font-semibold whitespace-nowrap",
                    active ? "text-ink" : "text-mute",
                  )}
                >
                  <span className="relative">
                    <Icon name={t.icon} className="size-6" />
                    {markOn(t) && <MakingDot className="absolute -top-0.5 -right-1 ring-2 ring-card" />}
                  </span>
                  {t.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
