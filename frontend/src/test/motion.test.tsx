// 움직임 기반: lib/motion.ts, hooks(usePresence·useModal·useMotionState·useSlidingIndicator), components/motion/*.
// jsdom(css:false)에는 getAnimations가 없어 CAN_ANIMATE=false → 닫힘·퇴장은 같은 렌더에서 끝난다. 그 계약(동기 단언)을 지키는지 본다.
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { type AnimationEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { MemoryRouter, type NavigateFunction, type NavigateOptions, useNavigate } from "react-router";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { Collapse } from "../components/motion/Collapse";
import { RouteErrorBoundary } from "../components/motion/RouteErrorBoundary";
import { RouteTransition } from "../components/motion/RouteTransition";
import { ScrollManager } from "../components/motion/ScrollManager";
import { Sheet } from "../components/motion/Sheet";
import { useModal } from "../hooks/useModal";
import { markShown, revealList, useChanged, useNewKeys, useRevealAfterLoading } from "../hooks/useMotionState";
import { usePresence } from "../hooks/usePresence";
import { useSlidingIndicator } from "../hooks/useSlidingIndicator";
import { CAN_ANIMATE, finiteAnimations, prefersReducedMotion, scrollToTop } from "../lib/motion";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 테스트에서 화면을 옮기는 손잡이 (렌더 중에 바깥 변수를 바꾸지 않게 effect에서 넘긴다) */
function Nav({ onReady }: { onReady: (nav: NavigateFunction) => void }) {
  const navigate = useNavigate();
  useEffect(() => {
    onReady(navigate);
  }, [navigate, onReady]);
  return null;
}

function renderRouter(path: string, children?: ReactNode) {
  let nav: NavigateFunction | null = null;
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <ScrollManager />
      <Nav onReady={(n) => (nav = n)} />
      {children}
    </MemoryRouter>,
  );
  const go = (to: string | number, opts?: NavigateOptions) =>
    act(() => {
      if (typeof to === "number") void nav?.(to);
      else void nav?.(to, opts);
    });
  return { ...utils, go };
}

describe("lib/motion", () => {
  it("jsdom은 애니메이션을 기다리지 않는다 (CAN_ANIMATE false, 끝이 있는 애니메이션 없음, 동작 줄이기 모름)", () => {
    expect(CAN_ANIMATE).toBe(false);
    expect(finiteAnimations(document.body, true)).toEqual([]);
    expect(prefersReducedMotion()).toBe(false);
  });

  it("scrollToTop: 기본은 부드럽게, 동작 줄이기·smooth=false면 바로", () => {
    const spy = vi.spyOn(window, "scrollTo");
    scrollToTop();
    expect(spy).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "smooth" });
    scrollToTop(false);
    expect(spy).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "auto" });
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), addEventListener() {}, removeEventListener() {} }));
    expect(prefersReducedMotion()).toBe(true);
    scrollToTop();
    expect(spy).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "auto" });
  });
});

describe("usePresence · Collapse", () => {
  function Box({ open }: { open: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    const { present, state, appear } = usePresence(open, ref);
    return present ? <div ref={ref} data-testid="box" data-state={state} data-appear={appear ? "" : undefined} /> : null;
  }

  it("열면 같은 렌더에 나타나고 닫으면 같은 렌더에 사라진다. appear는 마운트 뒤에 사용자가 연 때만", () => {
    const { rerender } = render(<Box open={false} />);
    expect(screen.queryByTestId("box")).toBeNull();
    rerender(<Box open />);
    expect(screen.getByTestId("box").getAttribute("data-state")).toBe("open");
    expect(screen.getByTestId("box").hasAttribute("data-appear")).toBe(true);
    rerender(<Box open={false} />);
    expect(screen.queryByTestId("box")).toBeNull();
  });

  it("처음부터 열려 있던 내용은 움직이지 않는다 (appear false)", () => {
    render(<Box open />);
    expect(screen.getByTestId("box").hasAttribute("data-appear")).toBe(false);
  });

  it("Collapse: 닫혀 있으면 언마운트(숨은 입력이 없다), 열면 같은 렌더에 있다. 클래스는 Tailwind collapse 유틸과 겹치지 않는다", () => {
    function Demo() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" aria-expanded={open} aria-controls={open ? "more" : undefined} onClick={() => setOpen((o) => !o)}>
            더 보기
          </button>
          <Collapse open={open} id="more" className="mt-3">
            <label>
              수량
              <input />
            </label>
          </Collapse>
        </>
      );
    }
    render(<Demo />);
    const trigger = screen.getByRole("button", { name: "더 보기" });
    expect(screen.queryByLabelText("수량")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByLabelText("수량")).toBeTruthy();
    expect(trigger.getAttribute("aria-controls")).toBe("more");
    const region = document.getElementById("more")!;
    expect(region.className.split(" ")).toEqual(["collapsible", "mt-3"]);
    expect(region.hasAttribute("inert")).toBe(false);
    expect(region.getAttribute("data-state")).toBe("open");
    fireEvent.click(trigger);
    expect(screen.queryByLabelText("수량")).toBeNull();
    expect(document.getElementById("more")).toBeNull();
  });
});

describe("Sheet · useModal", () => {
  function SheetDemo({ onClose, safeFirst }: { onClose?: () => void; safeFirst?: boolean }) {
    const [open, setOpen] = useState(false);
    const safe = useRef<HTMLButtonElement>(null);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          열기
        </button>
        <Sheet
          open={open}
          onClose={() => {
            onClose?.();
            setOpen(false);
          }}
          labelledBy="sheet-title"
          initialFocus={safeFirst ? safe : undefined}
        >
          <h2 id="sheet-title">주문 확인</h2>
          <button type="button">사기</button>
          <button ref={safe} type="button" onClick={() => setOpen(false)}>
            닫기
          </button>
        </Sheet>
      </>
    );
  }

  it("열면 body 포털의 role=dialog(이름 = 제목)·aria-modal, 첫 버튼에 포커스, 배경 inert·스크롤 잠금. Esc로 닫으면 연 버튼으로", () => {
    const { container } = render(<SheetDemo />);
    const opener = screen.getByRole("button", { name: "열기" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog", { name: "주문 확인" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(container.contains(dialog)).toBe(false); // body 포털
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "사기" }));
    expect(container.hasAttribute("inert")).toBe(true);
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);
    // 스크림은 버튼이 아니다 (화면 읽기에 '닫기'가 두 번 나오지 않게)
    expect(screen.getAllByRole("button", { name: "닫기" })).toHaveLength(1);
    expect(document.querySelector(".sheet-scrim")?.getAttribute("aria-hidden")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); // jsdom: 같은 렌더에 닫힌다
    expect(document.activeElement).toBe(opener);
    expect(container.hasAttribute("inert")).toBe(false);
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
  });

  it("스크림을 누르면 닫히고, initialFocus를 주면 그 버튼(안전한 쪽)에서 시작한다", () => {
    const onClose = vi.fn();
    render(<SheetDemo onClose={onClose} safeFirst />);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "닫기" }));
    fireEvent.click(document.querySelector(".sheet-scrim")!);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("이미 처리된 Esc(용어 풀이가 capture 단계에서 먼저 닫음)는 무시한다", () => {
    render(<SheetDemo />);
    fireEvent.click(screen.getByRole("button", { name: "열기" }));
    const tooltipFirst = (e: KeyboardEvent) => e.preventDefault();
    document.addEventListener("keydown", tooltipFirst, true);
    fireEvent.keyDown(document, { key: "Escape" });
    document.removeEventListener("keydown", tooltipFirst, true);
    expect(screen.getByRole("dialog", { name: "주문 확인" })).toBeTruthy();
  });

  it("겹친 모달: Esc는 맨 위만 닫고, 아래 모달이 먼저 닫혀도 배경 잠금은 맨 위 기준으로 남는다", () => {
    function Stacked() {
      const [lower, setLower] = useState(false);
      const [upper, setUpper] = useState(false);
      return (
        <>
          <p>배경</p>
          <button type="button" onClick={() => setLower(true)}>
            주문 열기
          </button>
          <Sheet open={lower} onClose={() => setLower(false)} labelledBy="lower-title">
            <h2 id="lower-title">주문</h2>
            <button type="button" onClick={() => setUpper(true)}>
              이유 적기
            </button>
            <button type="button" onClick={() => setLower(false)}>
              주문 닫기
            </button>
          </Sheet>
          <Sheet open={upper} onClose={() => setUpper(false)} labelledBy="upper-title">
            <h2 id="upper-title">왜 샀나요?</h2>
            <button type="button" onClick={() => setLower(false)}>
              아래 닫기
            </button>
          </Sheet>
        </>
      );
    }
    render(<Stacked />);
    fireEvent.click(screen.getByRole("button", { name: "주문 열기" }));
    fireEvent.click(screen.getByRole("button", { name: "이유 적기" }));
    const lowerRoot = screen.getByRole("dialog", { name: "주문" }).parentElement!;
    expect(lowerRoot.hasAttribute("inert")).toBe(true); // 위 모달이 열린 동안 아래 모달은 잠긴다
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "아래 닫기" }));

    // 위 모달이 열린 채 아래 모달이 먼저 닫혀도 배경은 계속 잠기고, 포커스를 빼앗지 않는다
    fireEvent.click(screen.getByRole("button", { name: "아래 닫기" }));
    expect(screen.queryByRole("dialog", { name: "주문" })).toBeNull();
    expect(screen.getByText("배경").parentElement!.hasAttribute("inert")).toBe(true);
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "아래 닫기" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("배경").parentElement!.hasAttribute("inert")).toBe(false);
    expect(document.documentElement.hasAttribute("data-scroll-lock")).toBe(false);
  });

  it("Esc는 맨 위 모달만 닫는다", () => {
    function Two() {
      const [a, setA] = useState(true);
      const [b, setB] = useState(true);
      return (
        <>
          <Sheet open={a} onClose={() => setA(false)} labelledBy="a-title">
            <h2 id="a-title">아래</h2>
          </Sheet>
          <Sheet open={b} onClose={() => setB(false)} labelledBy="b-title">
            <h2 id="b-title">위</h2>
          </Sheet>
        </>
      );
    }
    render(<Two />);
    expect(screen.getAllByRole("dialog")).toHaveLength(2);
    expect(screen.getByRole("dialog", { name: "위" }).parentElement!.hasAttribute("inert")).toBe(false); // 같은 커밋에 열려도 맨 위는 쓸 수 있다
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "위" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "아래" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("useModal만 쓰는 늘 있는 패널(주문 독): active인 동안만 잠그고, 닫히면 returnFocus로 돌려준다", () => {
    function Dock() {
      const [open, setOpen] = useState(false);
      const panel = useRef<HTMLElement>(null);
      const opener = useRef<HTMLButtonElement>(null);
      useModal(panel, { active: open, onClose: () => setOpen(false), initialFocus: panel, returnFocus: opener });
      return (
        <div>
          <button ref={opener} type="button" onClick={() => setOpen(true)}>
            구매하기
          </button>
          <p>배경</p>
          <section ref={panel} tabIndex={-1} aria-label="주문">
            <button type="button">매수하기</button>
          </section>
        </div>
      );
    }
    render(<Dock />);
    const region = screen.getByRole("region", { name: "주문" });
    const buy = screen.getByRole("button", { name: "구매하기" });
    expect(document.activeElement).not.toBe(region);
    fireEvent.click(buy); // fireEvent는 버튼에 포커스를 주지 않는다 (iOS Safari와 같다) → returnFocus로 돌아온다
    expect(document.activeElement).toBe(region);
    expect(screen.getByText("배경").hasAttribute("inert")).toBe(true);
    expect(buy.hasAttribute("inert")).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(document.activeElement).toBe(buy);
    expect(screen.getByText("배경").hasAttribute("inert")).toBe(false);
  });
});

describe("ScrollManager", () => {
  let scrollTo: MockInstance;
  const scrollYDesc = Object.getOwnPropertyDescriptor(window, "scrollY");
  const setScrollY = (y: number) => Object.defineProperty(window, "scrollY", { value: y, configurable: true, writable: true });
  const setScrollHeight = (h: number) => Object.defineProperty(document.documentElement, "scrollHeight", { value: h, configurable: true });
  const scrolled = (y: number) => {
    setScrollY(y);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
  };

  beforeEach(() => {
    scrollTo = vi.spyOn(window, "scrollTo");
  });
  afterEach(() => {
    if (scrollYDesc) Object.defineProperty(window, "scrollY", scrollYDesc);
    Reflect.deleteProperty(document.documentElement, "scrollHeight");
  });

  it("새 화면(주소나 ?view가 바뀜)은 맨 위에서. 다른 쿼리만 바뀌면 그대로, state.scroll='top'이면 맨 위", () => {
    const { go } = renderRouter("/sm/a");
    scrollTo.mockClear();
    go("/sm/b");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    scrollTo.mockClear();
    go("/sm/b?tab=orders");
    expect(scrollTo).not.toHaveBeenCalled();
    go("/sm/b?tab=orders&view=easy");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    scrollTo.mockClear();
    go("/sm/b?tab=fills&view=easy");
    expect(scrollTo).not.toHaveBeenCalled();
    go("/sm/b?tab=plans&view=easy", { state: { scroll: "top" } });
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
  });

  it("뒤로 가기(POP)는 그 기록에서 보던 자리로 돌아간다", () => {
    setScrollHeight(5000);
    const { go } = renderRouter("/sm/list");
    scrolled(600);
    go("/sm/detail");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    setScrollY(0);
    go(-1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 600);
  });

  it("내용이 늦게 자라면 자랄 때까지 기다렸다가 돌아가고, 기다리는 동안 사용자가 스크롤하면 그만둔다", async () => {
    setScrollHeight(800); // 화면 768px → 내려갈 수 있는 거리 32px
    const { go } = renderRouter("/sm/late");
    scrolled(900);
    go("/sm/late-detail");
    go(-1);
    expect(scrollTo).not.toHaveBeenCalledWith(0, 900);
    setScrollHeight(3000);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 900));

    scrollTo.mockClear();
    setScrollHeight(800);
    go("/sm/late-detail2");
    go(-1);
    window.dispatchEvent(new Event("wheel"));
    setScrollHeight(3000);
    await new Promise((r) => setTimeout(r, 80));
    expect(scrollTo).not.toHaveBeenCalledWith(0, 900);
  });

  it("쿼리만 바꾼 REPLACE(탭·필터)는 새 기록 항목이 되므로 그 자리를 바로 적는다 — 스크롤 없이 다른 화면에 갔다가 돌아와도 그 자리로", () => {
    setScrollHeight(5000);
    scrollTo.mockImplementation((_x: number, y: number) => setScrollY(y)); // 브라우저처럼 scrollY가 바뀐다
    const { go } = renderRouter("/sm/report");
    scrolled(600);
    scrollTo.mockClear();
    go("/sm/report?tab=run", { replace: true });
    expect(scrollTo).not.toHaveBeenCalled(); // 쿼리만 바뀌면 그대로
    go("/sm/notifications");
    expect(scrollTo).toHaveBeenLastCalledWith(0, 0);
    go(-1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 600);
  });

  it("복원한 뒤 위쪽 내용이 늦게 자라 자리가 밀려도, 문서가 기록할 때의 높이가 될 때까지 다시 맞춘다. 그동안은 스크롤 앵커링을 끄고 끝나면 돌려준다", async () => {
    setScrollHeight(3400); // 다 그려진 화면에서 900까지 내려 봤다 (자리와 높이를 같이 기록)
    scrollTo.mockImplementation((_x: number, y: number) => setScrollY(y));
    const html = document.documentElement;
    const { go } = renderRouter("/sm/list2");
    scrolled(900);
    go("/sm/detail2");
    setScrollHeight(3000); // 돌아온 첫 프레임: 위쪽 내용이 아직 덜 자랐다
    go(-1);
    expect(scrollTo).toHaveBeenLastCalledWith(0, 900);
    expect(html.style.overflowAnchor).toBe("none");
    // 높이가 몇 프레임 그대로여도 기록한 높이(3400)가 아니면 아직 끝내지 않는다 (다음 목록이 늦게 올 수 있다)
    await new Promise((r) => setTimeout(r, 150));
    expect(html.style.overflowAnchor).toBe("none");
    // 위쪽(만드는 중 띠 등)이 펼쳐지며 브라우저가 앵커링으로 자리를 민 상황
    scrollTo.mockClear();
    setScrollHeight(3400);
    setScrollY(1097);
    await waitFor(() => expect(scrollTo).toHaveBeenCalledWith(0, 900));
    await waitFor(() => expect(html.style.overflowAnchor).toBe("")); // 기록한 높이에 닿아 그대로면 끝
    expect(window.scrollY).toBe(900);
  });

  it("복원하는 동안 스크롤바를 누르면(pointerdown) 그만두고 앵커링을 돌려준다", () => {
    setScrollHeight(3000);
    scrollTo.mockImplementation((_x: number, y: number) => setScrollY(y));
    const { go } = renderRouter("/sm/list3");
    scrolled(700);
    go("/sm/detail3");
    go(-1);
    expect(document.documentElement.style.overflowAnchor).toBe("none");
    window.dispatchEvent(new Event("pointerdown"));
    expect(document.documentElement.style.overflowAnchor).toBe("");
  });

  it("다른 화면의 해시 주소로 가면 먼저 맨 위에서 연다 — 대상이 늦게 생겨도 앞 화면 자리에 남지 않고, 생기면 그 요소로. 같은 화면 안의 해시는 맨 위로 튀지 않는다", async () => {
    const into = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: into, configurable: true, writable: true });
    const targets = ["notification-settings", "public"].map((id) => Object.assign(document.createElement("div"), { id }));
    try {
      const { go } = renderRouter("/sm/notices");
      scrolled(2000);
      scrollTo.mockClear();
      go("/sm/my#notification-settings");
      expect(scrollTo).toHaveBeenLastCalledWith(0, 0); // 대상(마이 카드)이 아직 없다
      expect(into).not.toHaveBeenCalled();
      document.body.append(targets[0]); // 데이터가 와서 카드가 생겼다
      await waitFor(() => expect(into).toHaveBeenCalledTimes(1));
      expect(into.mock.contexts[0]).toBe(targets[0]);

      document.body.append(targets[1]);
      scrollTo.mockClear();
      go("/sm/my#public");
      expect(scrollTo).not.toHaveBeenCalled();
      expect(into).toHaveBeenCalledTimes(2);
      expect(into.mock.contexts[1]).toBe(targets[1]);
    } finally {
      for (const t of targets) t.remove();
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });

  it("해시(#id)가 있으면 그 요소로 간다", () => {
    const into = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", { value: into, configurable: true, writable: true });
    try {
      const { go, unmount } = renderRouter("/sm/h", <div id="plan-3" />);
      go("/sm/h2#plan-3");
      expect(into).toHaveBeenCalledTimes(1);
      expect((into.mock.contexts[0] as Element).id).toBe("plan-3");
      unmount();
      // 해시 주소를 처음 연 경우(공유 링크, 저장한 위치 없음)도 그 요소로
      renderRouter("/sm/h3#plan-9", <div id="plan-9" />);
      expect(into).toHaveBeenCalledTimes(2);
      expect((into.mock.contexts[1] as Element).id).toBe("plan-9");
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

describe("RouteTransition · RouteErrorBoundary", () => {
  it("첫 화면·뒤로 가기는 바로, 새 화면(PUSH)만 opacity 페이드. 쿼리만 바뀌면 다시 그리지 않고 ?view가 바뀌면 새로", () => {
    const { go } = renderRouter(
      "/rt/a",
      <RouteTransition>
        <p>내용</p>
      </RouteTransition>,
    );
    const page = () => screen.getByText("내용").parentElement!;
    expect(page().className).toBe("");
    go("/rt/b");
    const pushed = page();
    expect(pushed.className).toBe("animate-page-in");
    go("/rt/b?tab=x");
    expect(page()).toBe(pushed);
    go("/rt/b?tab=x&view=easy");
    expect(page()).not.toBe(pushed);
    expect(page().className).toBe("animate-page-in");
    go(-1);
    expect(page().className).toBe("");
  });

  const boom = { on: false };
  function Fragile() {
    if (boom.on) throw new Error("화면 오류");
    return <p>정상 화면</p>;
  }

  it("렌더 오류는 그 화면 자리에만 안내 카드를 보이고, 다시 시도·다른 화면으로 가면 새로 시작한다", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    boom.on = true;
    const { go } = renderRouter(
      "/eb/a",
      <RouteErrorBoundary>
        <Fragile />
      </RouteErrorBoundary>,
    );
    const alert = screen.getByRole("alert");
    expect(within(alert).getByRole("heading", { name: "화면을 그리다 문제가 생겼어요" })).toBeTruthy();
    expect(within(alert).getByRole("link", { name: "홈으로" }).getAttribute("href")).toBe("/");
    boom.on = false;
    fireEvent.click(within(alert).getByRole("button", { name: "다시 시도" }));
    expect(screen.getByText("정상 화면")).toBeTruthy();

    boom.on = true;
    go("/eb/b");
    expect(screen.getByRole("alert")).toBeTruthy();
    boom.on = false;
    go("/eb/c");
    expect(screen.getByText("정상 화면")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("나타나기 판단 (useMotionState)", () => {
  it("useRevealAfterLoading: 불러오는 중에서 시작해 다 왔을 때만 true, 캐시로 바로 그리면 false", () => {
    const { result, rerender } = renderHook(({ pending }) => useRevealAfterLoading(pending), { initialProps: { pending: true } });
    expect(result.current).toBe(false);
    rerender({ pending: false });
    expect(result.current).toBe(true);
    expect(renderHook(() => useRevealAfterLoading(false)).result.current).toBe(false);
  });

  it("useChanged: 첫 값에서는 false, 한 번 바뀌면 그 뒤로 true (A→B→A)", () => {
    const { result, rerender } = renderHook(({ v }) => useChanged(v), { initialProps: { v: "buy" } });
    expect(result.current).toBe(false);
    rerender({ v: "holding" });
    expect(result.current).toBe(true);
    rerender({ v: "buy" });
    expect(result.current).toBe(true);
  });

  it("useNewKeys: 기준(처음 준비된 목록) 뒤에 생긴 것만 — 불러오는 동안의 빈 목록은 기준이 아니다", () => {
    const { result, rerender } = renderHook(({ keys, ready }) => useNewKeys(keys, ready), {
      initialProps: { keys: [] as number[], ready: false },
    });
    expect([...result.current]).toEqual([]);
    rerender({ keys: [1, 2], ready: true });
    expect([...result.current]).toEqual([]);
    rerender({ keys: [3, 1, 2], ready: true });
    expect([...result.current]).toEqual([3]);
  });

  // jsdom에는 AnimationEvent가 없어 React가 접두사 붙은 이름(webkitAnimationEnd)을 듣는다 → 처리 함수를 직접 부른다
  const animationEvent = (target: Element, currentTarget: Element) => ({ target, currentTarget }) as unknown as AnimationEvent<HTMLElement>;

  it("revealList: 꺼지면 {}, 기본은 목록 전체 페이드, rise는 마지막 항목이 끝나면 data-revealed로 멈춘다", () => {
    expect(revealList(false)).toEqual({});
    expect(revealList(true)).toEqual({ "data-reveal": "fade" });
    const props = revealList(true, "rise");
    render(
      <ul data-testid="list" {...props}>
        <li>첫째</li>
        <li>둘째</li>
      </ul>,
    );
    const list = screen.getByTestId("list");
    expect(list.getAttribute("data-reveal")).toBe("rise");
    props.onAnimationEnd?.(animationEvent(screen.getByText("첫째"), list));
    expect(list.hasAttribute("data-revealed")).toBe(false);
    props.onAnimationEnd?.(animationEvent(screen.getByText("둘째"), list));
    expect(list.hasAttribute("data-revealed")).toBe(true);
  });

  it("revealList rise: 마지막 항목의 끝을 받지 못해도(폴링으로 바뀜) 첫 항목이 움직이기 시작하고 600ms 뒤 멈춘다", () => {
    vi.useFakeTimers();
    const props = revealList(true, "rise");
    render(
      <ul data-testid="list" {...props}>
        <li>가</li>
        <li>나</li>
      </ul>,
    );
    const list = screen.getByTestId("list");
    props.onAnimationStart?.(animationEvent(list, list)); // 목록 자신의 애니메이션은 세지 않는다
    expect(list.hasAttribute("data-reveal-timer")).toBe(false);
    props.onAnimationStart?.(animationEvent(screen.getByText("가"), list));
    props.onAnimationStart?.(animationEvent(screen.getByText("나"), list)); // 타이머는 하나만
    vi.advanceTimersByTime(599);
    expect(list.hasAttribute("data-revealed")).toBe(false);
    vi.advanceTimersByTime(1);
    expect(list.hasAttribute("data-revealed")).toBe(true);
  });

  it("markShown: 새 항목(.is-new)의 등장이 끝나면 data-shown을 DOM에 단다 — 순서가 바뀌어 줄이 옮겨져도 다시 돌지 않게 (안쪽 요소의 애니메이션은 세지 않는다)", () => {
    render(
      <ul>
        <li data-testid="row" className="is-new">
          <span>값</span>
        </li>
      </ul>,
    );
    const row = screen.getByTestId("row");
    markShown(animationEvent(screen.getByText("값"), row));
    expect(row.hasAttribute("data-shown")).toBe(false);
    markShown(animationEvent(row, row));
    expect(row.hasAttribute("data-shown")).toBe(true);
  });
});

describe("useSlidingIndicator", () => {
  function Seg({ value }: { value: string }) {
    const ref = useRef<HTMLDivElement>(null);
    useSlidingIndicator(ref, '[aria-pressed="true"]', value);
    return (
      <div ref={ref} data-testid="seg" className="seg">
        <span aria-hidden="true" className="seg-indicator" />
        {["전체", "BUY"].map((v) => (
          <button key={v} type="button" aria-pressed={v === value}>
            {v}
          </button>
        ))}
      </div>
    );
  }

  it("잴 수 없으면(jsdom·숨김, 폭 0) 표시를 쓰지 않는다 — 선택된 버튼이 직접 배경을 그린다", () => {
    render(<Seg value="전체" />);
    expect(screen.getByTestId("seg").hasAttribute("data-indicator")).toBe(false);
  });

  it("재면 자리·폭을 CSS 변수로 넘기고, 첫 자리는 바로·다음 프레임부터 미끄러진다", async () => {
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(80);
    vi.spyOn(HTMLElement.prototype, "offsetLeft", "get").mockImplementation(function (this: HTMLElement) {
      return this.textContent === "BUY" ? 84 : 4;
    });
    const { rerender } = render(<Seg value="전체" />);
    const seg = screen.getByTestId("seg");
    expect(seg.hasAttribute("data-indicator")).toBe(true);
    expect(seg.hasAttribute("data-indicator-ready")).toBe(false);
    expect(seg.style.getPropertyValue("--ind-x")).toBe("4px");
    expect(seg.style.getPropertyValue("--ind-w")).toBe("80px");
    await waitFor(() => expect(seg.hasAttribute("data-indicator-ready")).toBe(true));
    rerender(<Seg value="BUY" />);
    expect(seg.style.getPropertyValue("--ind-x")).toBe("84px");
  });
});
