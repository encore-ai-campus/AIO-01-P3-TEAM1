// 탭 묶음: 하단 탭·왼쪽 메뉴(components/Layout.tsx)와 화면 안 '뒤로 가기'의 대체 경로(ui.tsx PageHeader)가 같이 쓴다.
// 알림이 갈 곳(notificationHref)도 여기 둔다: 알림 화면·홈 최근 알림이 같은 규칙으로 이동한다.
import type { Notification } from "../api/types";
import type { IconName } from "../components/Icon";

/** match: 이 탭이 켜지는 주소 (탭 안에서 들어가는 화면 포함 — 주소는 바꾸지 않고 탭만 묶는다). */
export type Tab = { to: string; label: string; icon: IconName; match: (path: string) => boolean };

const under =
  (...roots: string[]) =>
  (path: string) =>
    roots.some((r) => path === r || path.startsWith(`${r}/`));

export const HOME: Tab = { to: "/", label: "홈", icon: "home", match: (p) => p === "/" };
export const STOCKS: Tab = { to: "/search", label: "종목", icon: "search", match: under("/search", "/stocks") };
export const REPORTS: Tab = { to: "/reports", label: "리포트", icon: "doc", match: under("/reports", "/analyses") };
// 모의투자 = 진행 중 모의 자동매매 + 보유·주문 + 새 계획 제안 (docs/plans/컨셉변경계획.md 4-1)
export const TRADE: Tab = {
  to: "/portfolio",
  label: "모의투자",
  icon: "pie",
  match: under("/portfolio", "/plans", "/recommendations"),
};
export const MY: Tab = { to: "/my", label: "마이", icon: "user", match: under("/my", "/ranking") };

// 하단 탭 5개 (360px에서 칸마다 72px). 랭킹은 마이·홈 카드로, 알림은 화면 위 종(PC는 왼쪽 메뉴)으로 간다.
export const TABS: Tab[] = [HOME, STOCKS, REPORTS, TRADE, MY];

/** 이 주소가 속한 탭 (없으면 null — 알림·관리자·없는 주소). */
export function tabOf(pathname: string): Tab | null {
  return TABS.find((t) => t.match(pathname)) ?? null;
}

/**
 * 앱 안에 돌아갈 이전 화면이 없을 때(알림·Discord 링크로 바로 연 경우) '뒤로 가기'가 갈 곳:
 * 그 탭 묶음의 첫 화면 (/reports/12 → /reports, /plans/3 → /portfolio, /ranking → /my). 탭 첫 화면이거나 묶음 밖이면 홈.
 */
export function parentPath(pathname: string): string {
  const tab = tabOf(pathname);
  return tab && tab.to !== pathname ? tab.to : "/";
}

// ---------------------------------------------------------------- 알림이 갈 곳

/** 홈의 '오늘의 내 종목 뉴스' 카드 자리 (그 알림의 착지점 — HomePage가 이 id로 카드를 내려 보여 강조한다). */
export const DAILY_MOVE_ANCHOR = "daily-move";

/**
 * 알림을 누르면 갈 곳 (알림 화면 · 홈 최근 알림이 같이 쓴다). 서버 link는 그대로 두고(API 계약), 오늘의 내 종목 뉴스(link "/")만
 * 홈의 그 카드로 내려 준다 — 홈에서 눌러도 같은 주소라 아무 일도 없어 보이지 않게(카드로 스크롤하고 강조한다). link가 없으면 알림 화면.
 */
export function notificationHref(n: Pick<Notification, "kind" | "link">): string {
  if (n.kind === "daily_move" && (n.link === "/" || n.link === null)) return `/#${DAILY_MOVE_ANCHOR}`;
  return n.link ?? "/notifications";
}
