// 화면 모드(라이트·다크). 계정이 아니라 이 브라우저에 저장한다 (첫 페인트 전에, 로그인 화면에서도 알아야 하므로).
// 기본은 '기기 설정'(system). 첫 페인트는 index.html의 인라인 스크립트가 같은 키·같은 규칙으로 정하고, 여기서 이어받는다.
// 컴포넌트를 두지 않는다 (Fast Refresh 규칙). React에서는 hooks/useTheme.ts로 읽는다.
import { flushSync } from "react-dom";
import { EASE, prefersReducedMotion } from "./motion";

export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";
export const THEME_KEY = "paper-theme";
/** 브라우저 상단 막대 색(meta theme-color) = 화면 바탕 토큰 --color-bg. index.html 인라인 스크립트와 같은 값이다. */
export const THEME_COLOR: Record<Theme, string> = { light: "#F2F4F6", dark: "#0F1115" };

type Snapshot = { pref: ThemePref; theme: Theme };
type Origin = { x: number; y: number };

const DARK_QUERY = "(prefers-color-scheme: dark)";
/** 누른 곳에서 퍼지는 원형 전환 길이(ms). 사용자가 직접 바꿀 때만 쓰는 드문 전환이라 조금 길게 둔다. */
const SWITCH_MS = 400;

let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();
let stopWatching: (() => void) | null = null;
let settleFrame = 0;
let transitionSeq = 0;
// 원형 전환을 시작했지만 아직 칠하지 않은 선택. 전환 콜백은 비동기(다음 프레임)라, 그사이 새 선택이 오면
// 새 선택을 기준으로 판단하고 늦게 도는 앞 콜백은 아무것도 하지 않는다 (빠르게 라이트→다크를 누르면 라이트로 끝나던 문제)
let pending: Snapshot | null = null;

/** 저장한 선택. 읽을 수 없거나 모르는 값이면 'system'. */
export function readPref(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" || v === "system" ? v : "system";
  } catch {
    return "system";
  }
}

function writePref(pref: ThemePref) {
  try {
    localStorage.setItem(THEME_KEY, pref);
  } catch {
    // 저장할 수 없으면(사생활 보호 모드 등) 이 탭에서만 바꾼다
  }
}

/** 선택 → 실제 테마. system이면 기기 설정(matchMedia가 있을 때만), 없으면 라이트. */
export function resolveTheme(pref: ThemePref): Theme {
  if (pref !== "system") return pref;
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** html에 칠한다: data-theme(토큰 덮어쓰기), color-scheme(기본 폼·스크롤바), meta theme-color. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
}

function current(): Snapshot {
  if (!snapshot) {
    const pref = readPref();
    snapshot = { pref, theme: resolveTheme(pref) };
  }
  return snapshot;
}

/** useSyncExternalStore용. 값이 그대로면 같은 객체를 돌려준다. */
export function getThemeSnapshot(): Snapshot {
  return current();
}

export function subscribeTheme(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** run = 칠하기 → 스냅샷 교체 → 구독자 알림. 바뀐 것이 없으면 알리지 않는다. */
function commit(next: Snapshot) {
  applyTheme(next.theme);
  if (snapshot && snapshot.pref === next.pref && snapshot.theme === next.theme) return;
  snapshot = next;
  for (const fn of [...listeners]) fn();
}

/** 색을 바꾸는 동안 모든 transition을 끈다 (transition-colors가 걸린 요소만 늦게 바뀌어 얼룩지지 않게). 두 프레임 뒤 되돌린다. */
function withoutTransitions(run: () => void) {
  const root = document.documentElement;
  root.setAttribute("data-theme-switching", "");
  run();
  if (typeof requestAnimationFrame !== "function") {
    root.removeAttribute("data-theme-switching");
    return;
  }
  cancelAnimationFrame(settleFrame);
  settleFrame = requestAnimationFrame(() => {
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0;
      root.removeAttribute("data-theme-switching");
    });
  });
}

/**
 * 처음 한 번(main.tsx에서 render 전에) 부른다: 저장값으로 칠하고, 기기 설정 변경(선택이 system일 때만)과
 * 다른 탭의 변경(storage)을 듣는다. 둘 다 애니메이션 없이 바로 바꾼다. 여러 번 불러도 듣기는 한 벌만 남는다.
 */
export function initTheme(): void {
  stopWatching?.();
  pending = null;
  const pref = readPref();
  commit({ pref, theme: resolveTheme(pref) });
  const offs: (() => void)[] = [];
  if (typeof window.matchMedia === "function") {
    const mq = window.matchMedia(DARK_QUERY);
    const onSystem = () => {
      if ((pending ?? current()).pref !== "system") return;
      pending = null;
      withoutTransitions(() => commit({ pref: "system", theme: resolveTheme("system") }));
    };
    if (typeof mq.addEventListener === "function") {
      mq.addEventListener("change", onSystem);
      offs.push(() => mq.removeEventListener("change", onSystem));
    }
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key !== null && e.key !== THEME_KEY) return; // key null: 다른 탭이 저장소를 비웠다
    const next = readPref();
    pending = null;
    withoutTransitions(() => commit({ pref: next, theme: resolveTheme(next) }));
  };
  window.addEventListener("storage", onStorage);
  offs.push(() => window.removeEventListener("storage", onStorage));
  stopWatching = () => {
    for (const off of offs) off();
    stopWatching = null;
  };
}

/**
 * 사용자가 화면 모드를 고른다. 저장 → 칠하기 → 알림.
 * origin(누른 곳의 화면 좌표)이 있고, 실제 테마가 바뀌고, View Transition이 있고, 동작 줄이기가 아니면
 * 누른 곳에서 원이 퍼지며 바뀐다 (400ms). 그 밖에는 바로 바뀐다.
 */
export function setThemePref(pref: ThemePref, origin?: Origin): void {
  const before = pending ?? current(); // 아직 칠하지 않은 앞 선택이 있으면 그것이 '지금'이다
  writePref(pref);
  const next: Snapshot = { pref, theme: resolveTheme(pref) };
  const run = () => withoutTransitions(() => commit(next));
  if (!origin || next.theme === before.theme || typeof document.startViewTransition !== "function" || prefersReducedMotion()) {
    pending = null; // 앞 전환의 콜백이 늦게 돌아도 이 선택을 덮지 않게
    run();
    return;
  }
  const root = document.documentElement;
  const seq = ++transitionSeq;
  root.setAttribute("data-theme-anim", "");
  pending = next;
  let vt: ViewTransition;
  try {
    // 새 화면 사진에 토글·차트 색 같은 React 상태가 같이 찍히도록 flushSync로 바로 그린다.
    // 그사이 다른 선택이 왔으면(pending이 바뀜) 그쪽이 칠하므로 아무것도 하지 않는다
    vt = document.startViewTransition(() =>
      flushSync(() => {
        if (pending !== next) return;
        pending = null;
        run();
      }),
    );
  } catch {
    root.removeAttribute("data-theme-anim");
    pending = null;
    run();
    return;
  }
  const { x, y } = origin;
  const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  vt.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        { duration: SWITCH_MS, easing: EASE.standard, pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {}); // 빠르게 다시 누르면 앞 전환이 건너뛰어져 AbortError로 끝난다
  vt.finished
    .catch(() => {})
    .finally(() => {
      if (seq === transitionSeq) root.removeAttribute("data-theme-anim"); // 뒤 전환이 진행 중이면 그쪽이 뗀다
    });
}

/**
 * 원형 전환의 시작점: 마우스·손가락이면 누른 곳, 키보드(detail 0)면 누른 요소의 가운데.
 * 예: <Segmented onChange={(v, e) => setPref(v, e && themeOrigin(e))} />
 */
export function themeOrigin(e: { clientX: number; clientY: number; detail: number; currentTarget: EventTarget | null }): Origin | undefined {
  if (e.detail > 0 && (e.clientX !== 0 || e.clientY !== 0)) return { x: e.clientX, y: e.clientY };
  const el = e.currentTarget;
  if (!(el instanceof Element)) return undefined;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

/** 테스트 전용: 저장값·스냅샷·구독·듣기·전환 표시를 처음 상태로 (setupTests.ts의 afterEach). */
export function resetThemeForTests(): void {
  stopWatching?.();
  listeners.clear();
  snapshot = null;
  pending = null;
  transitionSeq += 1;
  if (settleFrame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(settleFrame);
  settleFrame = 0;
  try {
    localStorage.removeItem(THEME_KEY);
  } catch {
    // 저장소를 쓸 수 없는 환경이면 지울 것도 없다
  }
  document.documentElement.removeAttribute("data-theme-switching");
  document.documentElement.removeAttribute("data-theme-anim");
}
