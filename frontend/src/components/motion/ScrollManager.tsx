// 화면을 옮길 때의 스크롤 (react-router 선언형에는 ScrollRestoration이 없어서 직접 한다). App.tsx의 Routes 옆에 하나 둔다.
// - PUSH·REPLACE: 주소(pathname)나 보기(?view)가 바뀌면 맨 위에서 연다. 다른 쿼리(?tab=, ?q= 등)만 바뀌면 그대로 둔다.
//   state { scroll: "top" }을 주면 쿼리만 바뀌어도 맨 위로 (탭·메뉴 이동). 옮긴 뒤의 자리는 바로 기록한다
//   (쿼리만 바꾼 REPLACE도 새 기록 항목이다 — 스크롤 없이 다른 화면에 갔다가 돌아와도 그 자리로).
// - POP(뒤로·앞으로·새로고침): 그 기록 항목에서 보던 자리로. 자리와 함께 그때의 문서 높이를 기록해 두고, 돌아와서 문서가 그 높이가 될
//   때까지(최대 1.5초) 프레임마다 그 자리에 다시 맞춘다 — 위쪽 내용이 늦게 자라도 밀리지 않게 (그동안 스크롤 앵커링을 끈다).
//   사용자가 스크롤·입력하면 그만둔다.
// - 해시(#id)가 있으면 그 요소로 (대상이 늦게 생기면 1.5초까지 기다린다). 새 화면이면 먼저 맨 위에서 연다 — 대상이 늦게 와도 앞 화면의 자리에 남지 않게.
import { useEffect, useLayoutEffect, useRef } from "react";
import { useLocation, useNavigationType } from "react-router";

const STORE = "paper-scroll";
const LIMIT = 50;
const RETRY_MS = 1500;
/** 기록한 높이를 모를 때(옛 기록): 복원한 자리에서 문서 높이가 이만큼 연속 프레임 그대로면 다 그려졌다고 본다 (약 80ms). */
const SETTLE_FRAMES = 5;
/** 사용자가 직접 움직이는 입력. 하나라도 오면 맞추기를 그만둔다 (pointerdown: 스크롤바 끌기·화면 누르기). */
const USER_INPUT = ["wheel", "touchstart", "keydown", "pointerdown"] as const;

/** 한 기록 항목에서 보던 자리: y = scrollY, h = 그때의 문서 높이(scrollHeight, 0이면 모름). */
type Spot = { y: number; h: number };

// 기록 항목별 스크롤 위치. 키 = 항목 키|주소. 첫 항목은 키가 늘 'default'라서 주소를 붙여 다른 문서의 첫 화면과 섞이지 않게 한다.
let memory: Map<string, Spot> | null = null;

/** 새로고침·뒤로 가기로 다시 연 문서인지. 새로 연 문서(주소 입력·외부 링크)는 이 탭의 이전 기록을 쓰지 않는다. */
function reopenedDocument(): boolean {
  try {
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    return nav?.type === "reload" || nav?.type === "back_forward";
  } catch {
    return false;
  }
}

function positions(): Map<string, Spot> {
  if (memory) return memory;
  const saved: [string, Spot][] = [];
  if (reopenedDocument()) {
    try {
      // 저장 모양: [키, y, 높이] (높이가 없는 옛 기록 [키, y]도 읽는다)
      const raw: unknown = JSON.parse(sessionStorage.getItem(STORE) ?? "[]");
      if (Array.isArray(raw)) {
        for (const e of raw) {
          if (Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "number") {
            saved.push([e[0], { y: e[1], h: typeof e[2] === "number" ? e[2] : 0 }]);
          }
        }
      }
    } catch {
      // 읽지 못하면 빈 기록으로 시작한다
    }
  }
  memory = new Map(saved);
  return memory;
}

const docHeight = () => document.documentElement.scrollHeight;

function remember(entry: string, y: number, h = docHeight()) {
  const m = positions();
  m.delete(entry); // 최근 것을 뒤로 (오래된 것부터 버린다)
  m.set(entry, { y, h });
  if (m.size > LIMIT) {
    const oldest = m.keys().next().value;
    if (oldest !== undefined) m.delete(oldest);
  }
}

/** 스크롤 없이 문서 높이만 바뀐 경우(아래쪽 내용이 늦게 옴): 자리는 그대로 두고 높이만 새로 적는다. */
function rememberHeight(entry: string, h: number) {
  const spot = positions().get(entry);
  if (spot) spot.h = h;
}

function persist() {
  try {
    sessionStorage.setItem(STORE, JSON.stringify([...positions()].map(([key, s]) => [key, s.y, s.h])));
  } catch {
    // 저장하지 못하면 이 문서 안에서만 쓴다
  }
}

function scrollToY(y: number) {
  if (typeof window.scrollTo === "function") window.scrollTo(0, Math.max(0, y));
}

/**
 * step이 true를 돌려줄 때까지 프레임마다 다시 한다 (처음 한 번은 바로). 시간이 다 되면 onTimeout. 사용자가 직접 스크롤·입력하면 그만둔다.
 * 어느 쪽으로든 끝나면 onEnd. 그만두는 함수를 돌려준다 (effect 정리 — 다른 화면으로 옮기면 그만둔다).
 */
function retry(step: () => boolean, { onTimeout, onEnd }: { onTimeout?: () => void; onEnd?: () => void } = {}): () => void {
  if (step() || typeof requestAnimationFrame !== "function") {
    onEnd?.();
    return () => {};
  }
  let frame = 0;
  let stopped = false;
  const until = performance.now() + RETRY_MS;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const type of USER_INPUT) window.removeEventListener(type, stop);
    onEnd?.();
  };
  for (const type of USER_INPUT) window.addEventListener(type, stop, { passive: true });
  const tick = () => {
    if (stopped) return;
    if (step()) return stop();
    if (performance.now() > until) {
      onTimeout?.();
      return stop();
    }
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return stop;
}

/**
 * POP: 그 항목에서 보던 자리(y)로. 내용이 덜 자랐으면 자랄 때까지 기다리고, 닿은 뒤에도 문서가 기록할 때의 높이(h)가 되어
 * 잠깐 그대로일 때까지 프레임마다 y에 다시 맞춘다 — 첫 프레임에 맞춘 뒤 위쪽 내용(늦게 온 목록·펼쳐지는 접힘)이 자라면 그만큼 아래가 보이게
 * 된다. 높이를 모르면(옛 기록) 높이가 SETTLE_FRAMES 동안 그대로일 때까지. 다른 높이로 끝나면(그사이 내용이 바뀜) 시간 끝까지.
 * 그동안 html의 스크롤 앵커링을 끈다: 켜 두면 위쪽이 자란 만큼 브라우저가 scrollY를 더해 매 프레임 맞춘 자리와 다툰다.
 * 끝나면(다 그려짐·시간 끝·사용자 입력·화면 옮김) 원래대로 돌린다 — 그 뒤의 변화는 브라우저 앵커링이 맡는다.
 */
function restoreTo({ y, h }: Spot): () => void {
  if (y <= 0) {
    scrollToY(0);
    return () => {};
  }
  const html = document.documentElement;
  const room = () => html.scrollHeight - window.innerHeight;
  const anchor = html.style.overflowAnchor;
  html.style.overflowAnchor = "none";
  let last = -1;
  let still = 0;
  return retry(
    () => {
      if (room() < y) return false; // 내용이 아직 덜 자랐다
      scrollToY(y); // 이미 그 자리면 브라우저는 아무것도 하지 않는다 (스크롤 이벤트도 없다)
      const now = html.scrollHeight;
      still = now === last ? still + 1 : 0;
      last = now;
      return h > 0 ? Math.abs(now - h) <= 1 && still >= 2 : still >= SETTLE_FRAMES;
    },
    {
      onTimeout: () => scrollToY(Math.min(y, Math.max(0, room()))),
      onEnd: () => {
        html.style.overflowAnchor = anchor;
      },
    },
  );
}

function scrollToHash(hash: string) {
  let id = hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // 잘못된 인코딩이면 그대로 찾는다
  }
  return retry(() => {
    const el = document.getElementById(id);
    if (!el) return false;
    if (typeof el.scrollIntoView === "function") el.scrollIntoView();
    return true;
  });
}

export function ScrollManager() {
  const location = useLocation();
  const navType = useNavigationType();
  const { pathname, search, hash, state } = location;
  const entry = `${location.key}|${pathname}${search}`;
  const current = useRef(entry); // 스크롤을 기록할 항목 (effect·이벤트에서만 읽고 쓴다)
  const last = useRef<{ pathname: string; view: string | null } | null>(null);

  useEffect(() => {
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
    // 스크롤 이벤트는 브라우저가 이미 프레임마다 묶어 보낸다. 바로 기록해야 화면을 옮기기 직전 위치를 놓치지 않는다
    const onScroll = () => remember(current.current, window.scrollY);
    // 스크롤 없이 문서 높이만 바뀌어도(아래쪽 내용이 늦게 옴) 높이를 새로 적는다 — 돌아왔을 때 '다 그려졌는지'를 이 높이로 판단한다
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(() => rememberHeight(current.current, docHeight())) : null;
    const onHide = () => {
      remember(current.current, window.scrollY); // 새로고침 직전의 자리·높이
      persist();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    resize?.observe(document.documentElement);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
      resize?.disconnect();
    };
  }, []);

  useLayoutEffect(() => {
    current.current = entry;
    const view = new URLSearchParams(search).get("view");
    const prev = last.current;
    last.current = { pathname, view };
    if (navType === "POP") {
      const saved = positions().get(entry);
      if (saved === undefined && hash) return scrollToHash(hash); // 해시 주소를 처음 연 경우 (공유 링크 등)
      return restoreTo(saved ?? { y: 0, h: 0 });
    }
    const newScreen = !prev || prev.pathname !== pathname || prev.view !== view;
    const wantsTop = (state as { scroll?: unknown } | null)?.scroll === "top";
    // 새 화면은 맨 위에서 (즉시). 해시가 있어도 먼저 한다 — 대상이 늦게 생기면(데이터를 기다림) 그동안 앞 화면의 자리에 남고,
    // 1.5초를 넘기면 끝내 그 자리에 머문다. 같은 화면 안의 해시 이동은 맨 위로 튀지 않는다
    if (newScreen || wantsTop) scrollToY(0);
    // 이 항목의 자리를 바로 적는다: 쿼리만 바꾼 REPLACE(탭·필터)도 새 항목(key)이라, 스크롤하지 않고 떠나면 기록이 없어 돌아올 때 맨 위로 간다
    remember(entry, window.scrollY);
    if (hash) return scrollToHash(hash);
  }, [entry, pathname, search, hash, state, navType]);

  return null;
}
