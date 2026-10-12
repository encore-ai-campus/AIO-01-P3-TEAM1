// 화면 모드 (lib/theme.ts · hooks/useTheme.ts · index.html 첫 페인트 스크립트).
// jsdom에는 matchMedia·startViewTransition이 없어 기본은 즉시 바꾸는 경로다. 필요한 곳만 가짜로 끼운다.
import { fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../index.html?raw";
import { useResolvedTheme, useTheme } from "../hooks/useTheme";
import {
  THEME_COLOR,
  THEME_KEY,
  type ThemePref,
  applyTheme,
  getThemeSnapshot,
  initTheme,
  readPref,
  resolveTheme,
  setThemePref,
  subscribeTheme,
  themeOrigin,
} from "../lib/theme";
import { renderApp } from "./render";

// Node의 localStorage는 쓸 수 없을 수 있다 (home.test.tsx와 같은 메모리 저장소)
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

/** 기기 설정 가짜: dark·reduced를 바꾸면 change 리스너를 부른다. */
function fakeMedia(init: { dark?: boolean; reduced?: boolean } = {}) {
  const state = { dark: false, reduced: false, ...init };
  const listeners = new Set<() => void>();
  vi.stubGlobal("matchMedia", (query: string) => ({
    media: query,
    get matches() {
      return query.includes("prefers-color-scheme: dark") ? state.dark : query.includes("prefers-reduced-motion: reduce") ? state.reduced : false;
    },
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  }));
  return {
    setDark(dark: boolean) {
      state.dark = dark;
      for (const fn of [...listeners]) fn();
    },
    listeners,
  };
}

const root = () => document.documentElement;
const meta = () => document.querySelector('meta[name="theme-color"]')?.getAttribute("content");

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  const m = document.createElement("meta");
  m.name = "theme-color";
  m.content = THEME_COLOR.light;
  document.head.appendChild(m);
});
afterEach(() => {
  vi.unstubAllGlobals();
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
});

describe("화면 모드 저장·적용", () => {
  it("저장값이 없으면 기기 설정(system)을 따르고, 기기 설정을 모르면(matchMedia 없음) 라이트", () => {
    expect(readPref()).toBe("system");
    initTheme();
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(root().style.colorScheme).toBe("light");
    expect(meta()).toBe("#F2F4F6");
    expect(getThemeSnapshot()).toEqual({ pref: "system", theme: "light" });
  });

  it("모르는 저장값은 system으로 읽는다", () => {
    localStorage.setItem(THEME_KEY, "purple");
    expect(readPref()).toBe("system");
    localStorage.setItem(THEME_KEY, "dark");
    expect(readPref()).toBe("dark");
  });

  it("기기가 다크면 system은 다크. 기기 설정이 바뀌면 바로 따라가고(선택이 system일 때만), 다른 선택이면 그대로", () => {
    const media = fakeMedia({ dark: true });
    initTheme();
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(meta()).toBe("#0F1115");
    expect(resolveTheme("system")).toBe("dark");

    media.setDark(false);
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(getThemeSnapshot()).toEqual({ pref: "system", theme: "light" });

    setThemePref("dark");
    media.setDark(false);
    expect(root().getAttribute("data-theme")).toBe("dark");
    initTheme(); // 다시 불러도 듣기는 한 벌만
    expect(media.listeners.size).toBe(1);
  });

  it("고르면 저장하고 바로 칠한 뒤 구독자에게 알린다. 같은 값이면 알리지 않고 같은 객체", () => {
    const fn = vi.fn();
    const off = subscribeTheme(fn);
    const before = getThemeSnapshot();
    setThemePref("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(root().style.colorScheme).toBe("dark");
    expect(meta()).toBe("#0F1115");
    expect(fn).toHaveBeenCalledTimes(1);
    const after = getThemeSnapshot();
    expect(after).not.toBe(before);
    expect(after).toEqual({ pref: "dark", theme: "dark" });

    setThemePref("dark");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(getThemeSnapshot()).toBe(after);

    setThemePref("system"); // 기기 설정(라이트)으로 돌아가기
    expect(localStorage.getItem(THEME_KEY)).toBe("system");
    expect(root().getAttribute("data-theme")).toBe("light");
    off();
  });

  it("바꾸는 순간에만 transition을 끄고(data-theme-switching) 두 프레임 뒤 되돌린다", async () => {
    setThemePref("dark");
    expect(root().hasAttribute("data-theme-switching")).toBe(true);
    await waitFor(() => expect(root().hasAttribute("data-theme-switching")).toBe(false));
  });

  it("저장소를 쓸 수 없어도(사생활 보호 모드 등) 깨지지 않고 이 탭에서는 바뀐다", () => {
    const broken = () => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("localStorage", { getItem: broken, setItem: broken, removeItem: broken });
    expect(readPref()).toBe("system");
    expect(() => initTheme()).not.toThrow();
    expect(() => setThemePref("dark")).not.toThrow();
    expect(root().getAttribute("data-theme")).toBe("dark");
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("dark");
  });

  it("다른 탭에서 바꾸면(storage 이벤트) 바로 따라온다. 다른 키는 무시", () => {
    initTheme();
    localStorage.setItem(THEME_KEY, "dark");
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "x" }));
    expect(root().getAttribute("data-theme")).toBe("light");
    window.dispatchEvent(new StorageEvent("storage", { key: THEME_KEY, newValue: "dark" }));
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(getThemeSnapshot().pref).toBe("dark");
  });

  it("applyTheme는 meta가 없어도 깨지지 않는다", () => {
    document.querySelectorAll('meta[name="theme-color"]').forEach((m) => m.remove());
    expect(() => applyTheme("dark")).not.toThrow();
    expect(root().getAttribute("data-theme")).toBe("dark");
  });
});

describe("useTheme · useResolvedTheme", () => {
  function Picker() {
    const { pref, theme, setPref } = useTheme();
    const resolved = useResolvedTheme();
    const label: Record<ThemePref, string> = { system: "기기 설정", light: "라이트", dark: "다크" };
    return (
      <div>
        <div role="group" aria-label="화면 모드">
          {(["system", "light", "dark"] as const).map((p) => (
            <button key={p} type="button" aria-pressed={pref === p} onClick={(e) => setPref(p, themeOrigin(e))}>
              {label[p]}
            </button>
          ))}
        </div>
        <p data-testid="now">{`${theme}/${resolved}`}</p>
      </div>
    );
  }

  it("고른 값(aria-pressed)과 실제 테마를 같이 보이고, 누르면 저장·적용된다", () => {
    render(<Picker />);
    expect(screen.getByRole("button", { name: "기기 설정" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("now").textContent).toBe("light/light");

    fireEvent.click(screen.getByRole("button", { name: "다크" }));
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(screen.getByRole("button", { name: "다크" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("now").textContent).toBe("dark/dark");

    fireEvent.click(screen.getByRole("button", { name: "라이트" }));
    expect(screen.getByTestId("now").textContent).toBe("light/light");
  });

  it("themeOrigin: 마우스·손가락은 누른 곳, 키보드(detail 0)는 요소 가운데", () => {
    const el = document.createElement("button");
    el.getBoundingClientRect = () => ({ left: 100, top: 40, width: 60, height: 20, right: 160, bottom: 60, x: 100, y: 40, toJSON: () => ({}) });
    expect(themeOrigin({ clientX: 12, clientY: 34, detail: 1, currentTarget: el })).toEqual({ x: 12, y: 34 });
    expect(themeOrigin({ clientX: 0, clientY: 0, detail: 0, currentTarget: el })).toEqual({ x: 130, y: 50 });
    expect(themeOrigin({ clientX: 0, clientY: 0, detail: 0, currentTarget: null })).toBeUndefined();
  });
});

describe("원형 전환 (View Transition)", () => {
  type FakeVT = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void>; skipTransition: () => void };
  let animate: ReturnType<typeof vi.fn>;

  function fakeStartViewTransition(ready: Promise<void> = Promise.resolve()) {
    const start = vi.fn((cb: () => void): FakeVT => {
      cb(); // 브라우저는 옛 화면을 찍은 뒤 부른다
      return { ready, finished: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: () => {} };
    });
    Object.defineProperty(document, "startViewTransition", { value: start, configurable: true, writable: true });
    return start;
  }

  beforeEach(() => {
    animate = vi.fn();
    Object.defineProperty(root(), "animate", { value: animate, configurable: true, writable: true });
  });
  afterEach(() => {
    Reflect.deleteProperty(document, "startViewTransition");
    Reflect.deleteProperty(root(), "animate");
  });

  it("누른 곳 좌표가 있고 실제 테마가 바뀌면 원이 퍼진다 (400ms, 새 화면 의사 요소)", async () => {
    const start = fakeStartViewTransition();
    setThemePref("dark", { x: 10, y: 20 });
    expect(start).toHaveBeenCalledTimes(1);
    expect(root().getAttribute("data-theme")).toBe("dark"); // 콜백 안에서 바로 칠했다
    expect(root().hasAttribute("data-theme-anim")).toBe(true);
    await waitFor(() => expect(animate).toHaveBeenCalledTimes(1));
    const [keyframes, options] = animate.mock.calls[0] as [{ clipPath: string[] }, KeyframeAnimationOptions];
    expect(keyframes.clipPath[0]).toBe("circle(0px at 10px 20px)");
    expect(keyframes.clipPath[1]).toMatch(/^circle\([\d.]+px at 10px 20px\)$/);
    expect(options).toMatchObject({ duration: 400, pseudoElement: "::view-transition-new(root)" });
    await waitFor(() => expect(root().hasAttribute("data-theme-anim")).toBe(false));
  });

  it("좌표가 없거나·실제 테마가 그대로거나·동작 줄이기면 바로 바뀐다", () => {
    const start = fakeStartViewTransition();
    setThemePref("dark"); // 좌표 없음 (기기 설정·다른 탭과 같은 경로)
    setThemePref("dark", { x: 1, y: 1 }); // 이미 다크
    fakeMedia({ reduced: true });
    setThemePref("light", { x: 1, y: 1 });
    expect(start).not.toHaveBeenCalled();
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("앞 전환의 콜백이 돌기 전에 다시 고르면 마지막 선택으로 끝난다 (늦게 도는 앞 콜백이 덮지 않는다)", () => {
    // 브라우저처럼 콜백을 나중에(다음 프레임) 부른다. 새 전환이 시작되면 앞 콜백부터 순서대로 돈다
    const queue: (() => void)[] = [];
    const start = vi.fn((cb: () => void): FakeVT => {
      queue.push(cb);
      return { ready: Promise.resolve(), finished: Promise.resolve(), updateCallbackDone: Promise.resolve(), skipTransition: () => {} };
    });
    Object.defineProperty(document, "startViewTransition", { value: start, configurable: true, writable: true });
    const flush = () => {
      for (const cb of queue.splice(0)) cb();
    };

    setThemePref("dark"); // 다크에서 시작
    setThemePref("light", { x: 1, y: 1 }); // 다크 → 라이트 (콜백 대기)
    setThemePref("dark", { x: 1, y: 1 }); // 아직 라이트로 칠하기 전에 다시 다크: 대기 중인 라이트와 비교해야 한다
    flush();
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(getThemeSnapshot()).toEqual({ pref: "dark", theme: "dark" });
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");

    setThemePref("light", { x: 1, y: 1 }); // 다시 전환 대기 중에
    setThemePref("system"); // 좌표 없는 선택(기기 설정 = 라이트)은 바로 칠하고
    expect(root().getAttribute("data-theme")).toBe("light");
    setThemePref("dark"); // 바로 다크
    flush(); // 늦게 도는 라이트 콜백은 아무것도 하지 않는다
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(getThemeSnapshot()).toEqual({ pref: "dark", theme: "dark" });
  });

  it("빠르게 다시 눌러 앞 전환이 건너뛰어져도(AbortError) 오류 없이 끝난다", async () => {
    const aborted = Promise.reject(new DOMException("skipped", "AbortError"));
    fakeStartViewTransition(aborted);
    setThemePref("dark", { x: 5, y: 5 });
    expect(root().getAttribute("data-theme")).toBe("dark");
    await waitFor(() => expect(root().hasAttribute("data-theme-anim")).toBe(false));
    expect(animate).not.toHaveBeenCalled();
  });
});

describe("index.html 첫 페인트 스크립트", () => {
  const script = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)?.[1] ?? "";

  /** 인라인 스크립트를 가짜 저장소·기기 설정으로 돌린다. */
  function runFirstPaint(saved: string | null | "throw", osDark: boolean) {
    const storage = {
      getItem: () => {
        if (saved === "throw") throw new Error("SecurityError");
        return saved;
      },
    };
    const media = (q: string) => ({ matches: q.includes("dark") && osDark });
    new Function("localStorage", "window", "document", script)(storage, { matchMedia: media }, document);
    return { theme: root().getAttribute("data-theme"), scheme: root().style.colorScheme, meta: meta() };
  }

  it("lib/theme.ts와 같은 키·색을 쓰고, CSS가 오기 전 다크 바탕을 칠한다", () => {
    expect(script).toContain(`"${THEME_KEY}"`);
    expect(script).toContain(THEME_COLOR.dark);
    expect(indexHtml).toContain(`<style>html[data-theme=dark]{background:${THEME_COLOR.dark.toLowerCase()};color-scheme:dark}</style>`);
    expect(indexHtml).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
  });

  it("저장값 dark → 다크, light → 라이트(기기가 다크여도), 없음·system·읽기 실패 → 기기 설정", () => {
    expect(runFirstPaint("dark", false)).toEqual({ theme: "dark", scheme: "dark", meta: "#0F1115" });
    expect(runFirstPaint("light", true)).toMatchObject({ theme: "light", scheme: "light" });
    expect(runFirstPaint(null, true).theme).toBe("dark");
    expect(runFirstPaint("system", false).theme).toBe("light");
    expect(runFirstPaint("throw", true).theme).toBe("dark");
  });

  it("첫 페인트가 칠한 테마를 initTheme가 그대로 이어받는다 (깜빡임 없음)", () => {
    localStorage.setItem(THEME_KEY, "dark");
    runFirstPaint("dark", false);
    const observer = new MutationObserver(() => {});
    observer.observe(root(), { attributes: true, attributeFilter: ["data-theme"], attributeOldValue: true });
    initTheme();
    const records = observer.takeRecords();
    observer.disconnect();
    expect(records.length).toBeGreaterThan(0); // 다시 칠하기는 했다
    expect(records.map((r) => r.oldValue)).toEqual(records.map(() => "dark")); // 중간에 라이트로 바뀐 적이 없다
    expect(root().getAttribute("data-theme")).toBe("dark");
  });
});

describe("마이의 화면 모드 카드", () => {
  const card = () => screen.findByRole("region", { name: "화면 모드" });

  it("'어둡게'를 누르면 바로 다크로 칠하고 이 기기에 저장한다. '기기 설정'으로 돌아가면 기기 설정(라이트)을 따른다", async () => {
    renderApp("/my", "bob");
    const group = within(await card()).getByRole("group", { name: "화면 모드" });
    const button = (name: string) => within(group).getByRole("button", { name });
    expect(button("기기 설정").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(button("어둡게"));
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(root().style.colorScheme).toBe("dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
    expect(button("어둡게").getAttribute("aria-pressed")).toBe("true");
    expect(button("기기 설정").getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(button("기기 설정"));
    expect(localStorage.getItem(THEME_KEY)).toBe("system");
    expect(root().getAttribute("data-theme")).toBe("light"); // jsdom의 기기 설정은 라이트
    expect(button("기기 설정").getAttribute("aria-pressed")).toBe("true");
    expect(within(await card()).getByText(/지금은 밝게/)).toBeTruthy();
  });

  it("'밝게'는 기기가 다크여도 라이트로 고정하고, 기기 설정이면 지금 적용된 모드를 알려 준다", async () => {
    fakeMedia({ dark: true });
    initTheme();
    renderApp("/my", "alice");
    expect(within(await card()).getByText("기기 설정은 휴대폰·PC의 화면 설정을 따라가요 (지금은 어둡게). 이 기기에만 저장돼요.")).toBeTruthy();
    fireEvent.click(within(await card()).getByRole("button", { name: "밝게" }));
    expect(root().getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");
    expect(within(await card()).getByText("기기 설정은 휴대폰·PC의 화면 설정을 따라가요. 이 기기에만 저장돼요.")).toBeTruthy();
  });

  it("자리: 알림 설정 다음, 계정 앞 (같은 '설정' 묶음이되 이 기기에만 저장돼 계정 카드와 나눈다)", async () => {
    renderApp("/my", "bob");
    const theme = await card();
    const settings = await screen.findByRole("region", { name: "알림 설정" });
    const account = screen.getByRole("region", { name: "계정" });
    expect(settings.compareDocumentPosition(theme) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(theme.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
