// 기반 2 (셸·공용 UI): ui.tsx 새 부품(PillTabs·Segmented·Switch·Progress·Medal·EmptyState·ErrorState·PageHeader),
// 토스트(톤·보이는 시간·멈춤·눌러 닫기·최대 3개), Layout(지금 탭 다시 누르기·data-shell·어두운 모드 스위치·본문 바로가기·연결 띠),
// 알림 종 배지, 보기 전환 라벨, 로그인(아이디 칸·비밀번호 보기·오류 연결·세션 끝남 안내), 없는 주소, 용어 풀이 Esc.
// jsdom(css:false)에는 애니메이션이 없어 닫힘·퇴장은 같은 렌더에서 끝난다 (lib/motion.ts CAN_ANIMATE).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { onlineManager } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { type ReactNode, useState } from "react";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Providers } from "../App";
import { keys } from "../api/queries";
import type { NotificationPage } from "../api/types";
import { NotificationBell } from "../components/autotrade/NotificationBell";
import { Sheet } from "../components/motion/Sheet";
import { ViewToggle } from "../components/reports/ViewToggle";
import { Term } from "../components/Term";
import { TOAST_MAX, type ToastAction, type ToastTone, toastDuration, useToast } from "../components/toast";
import { ToastProvider } from "../components/ToastProvider";
import { EmptyState, ErrorState, Flash, Medal, PageHeader, PillTabs, Progress, Segmented, Skeleton, Switch, VerdictBadge } from "../components/ui";
import type { ViewMode, ViewModeState } from "../hooks/useBeginnerMode";
import { parentPath } from "../lib/nav";
import { createQueryClient } from "../lib/queryClient";
import * as db from "../mocks/db";
import { server } from "../mocks/server";
import { renderApp } from "./render";

// 화면 오류 경계가 뼈대 안에 있는지 보려고, 이 파일에서만 랭킹 화면이 그리다 실패하게 한다 (다른 테스트는 /ranking을 쓰지 않는다)
vi.mock("../pages/RankingPage", () => ({
  RankingPage: () => {
    throw new Error("그리기 실패 (테스트)");
  },
}));

// Node의 localStorage는 쓸 수 없을 수 있다 (home.test.tsx와 같은 메모리 저장소) — 화면 모드 저장을 확인한다
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

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("알약 탭 (PillTabs)", () => {
  function Demo() {
    const [tab, setTab] = useState<"a" | "b" | "c">("a");
    return (
      <>
        <PillTabs
          label="내 주식"
          value={tab}
          onChange={setTab}
          options={[
            { value: "a", label: "보유" },
            { value: "b", label: "주문" },
            { value: "c", label: "체결" },
          ]}
        />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
          {tab}
        </div>
      </>
    );
  }

  it("tablist/tab, 선택된 탭만 Tab 순서·aria-controls. ←/→/Home/End로 옮기면 바로 고르고 포커스도 옮긴다 (끝에서 처음으로 돈다)", () => {
    render(<Demo />);
    const tabs = within(screen.getByRole("tablist", { name: "내 주식" })).getAllByRole("tab");
    expect(tabs.map((t) => [t.id, t.getAttribute("aria-selected"), t.tabIndex])).toEqual([
      ["tab-a", "true", 0],
      ["tab-b", "false", -1],
      ["tab-c", "false", -1],
    ]);
    expect(tabs[0].getAttribute("aria-controls")).toBe("panel-a");
    expect(tabs[1].getAttribute("aria-controls")).toBeNull(); // 그리지 않은 패널을 가리키지 않는다
    expect(screen.getByRole("tabpanel", { name: "보유" }).textContent).toBe("a");

    const selected = () => screen.getAllByRole("tab").find((t) => t.getAttribute("aria-selected") === "true")?.textContent;
    tabs[0].focus();
    fireEvent.keyDown(tabs[0], { key: "ArrowRight" });
    expect(selected()).toBe("주문");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "주문" }));
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(selected()).toBe("체결");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(selected()).toBe("보유");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(selected()).toBe("체결");
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "체결" }));
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(selected()).toBe("보유");
    fireEvent.click(screen.getByRole("tab", { name: "주문" }));
    expect(screen.getByRole("tabpanel", { name: "주문" }).textContent).toBe("b");
  });
});

describe("Segmented · Switch · Progress · Medal", () => {
  it("Segmented: aria-pressed, onChange(값, 클릭 이벤트) — 미끄러지는 표시는 버튼이 아니다. size lg는 h-11", () => {
    const onChange = vi.fn();
    render(
      <Segmented
        label="보기"
        value="all"
        onChange={onChange}
        size="lg"
        options={[
          { value: "all", label: "전체" },
          { value: "buy", label: "BUY" },
        ]}
      />,
    );
    const group = screen.getByRole("group", { name: "보기" });
    expect(
      within(group)
        .getAllByRole("button")
        .map((b) => [b.textContent, b.getAttribute("aria-pressed")]),
    ).toEqual([
      ["전체", "true"],
      ["BUY", "false"],
    ]);
    expect(group.querySelector(".seg-indicator")?.getAttribute("aria-hidden")).toBe("true");
    fireEvent.click(within(group).getByRole("button", { name: "BUY" }), { clientX: 30, clientY: 40 });
    expect(onChange).toHaveBeenCalledWith("buy", expect.objectContaining({ clientX: 30, clientY: 40 }));
    expect(within(group).getByRole("button", { name: "BUY" }).className).toContain("h-11");
  });

  it("Switch: role=switch(이름 = 글자), 글자를 눌러도 바뀌고, 설명 연결·막힘", () => {
    function Demo() {
      const [on, setOn] = useState(false);
      return (
        <>
          <Switch checked={on} onChange={setOn} label="Discord로도 받기" describedBy="help" />
          <p id="help">웹 알림은 항상 남아요</p>
          <Switch checked aria-label="장애 주입" onChange={() => {}} disabled />
        </>
      );
    }
    render(<Demo />);
    const sw = screen.getByRole("switch", { name: "Discord로도 받기" }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    expect(sw.getAttribute("aria-describedby")).toBe("help");
    fireEvent.click(sw);
    expect(sw.checked).toBe(true);
    fireEvent.click(screen.getByText("Discord로도 받기"));
    expect(sw.checked).toBe(false);
    const locked = screen.getByRole("switch", { name: "장애 주입" }) as HTMLInputElement;
    expect([locked.checked, locked.disabled]).toEqual([true, true]);
  });

  it("Progress: 이름이 있으면 progressbar(값 포함), 없으면 장식. Medal: 숫자는 글자로 남고 1~3위만 메달 색", () => {
    const { container } = render(
      <>
        <Progress value={2} max={5} label="다섯 단계 중 2단계" />
        <Progress value={1} />
        <ol>
          <li>
            <Medal rank={1} />밥
          </li>
          <li>
            <Medal rank={4} size="sm" />
            캐롤
          </li>
        </ol>
      </>,
    );
    const bar = screen.getByRole("progressbar", { name: "다섯 단계 중 2단계" });
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemax")]).toEqual(["2", "5"]);
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
    expect(screen.getAllByRole("listitem").map((li) => li.textContent)).toEqual(["1밥", "4캐롤"]);
    expect(container.querySelector(".bg-medal-gold")?.textContent).toBe("1");
    expect(container.querySelectorAll("[class*='bg-medal-']")).toHaveLength(1);
  });
});

describe("Skeleton", () => {
  it("모서리를 주면 기본 rounded-lg를 뺀다 (cn은 병합하지 않고 rounded-lg가 rounded-full·2xl을 이겨 원이 둥근 네모가 됐다). 변형(lg:)은 기본 위에 얹힌다", () => {
    const { container } = render(
      <>
        <Skeleton className="h-4 w-20" />
        <Skeleton className="size-9 rounded-full" />
        <Skeleton className="h-14 w-full rounded-2xl" />
        <Skeleton className="size-6 rounded-full!" />
        <Skeleton className="h-6 rounded-t-xl" />
        <Skeleton className="h-6 lg:rounded-2xl" />
      </>,
    );
    const radii = [...container.children].map((el) => el.className.split(" ").filter((c) => c.includes("rounded")));
    expect(radii).toEqual([
      ["rounded-lg"],
      ["rounded-full"],
      ["rounded-2xl"],
      ["rounded-full!"],
      ["rounded-t-xl"],
      ["rounded-lg", "lg:rounded-2xl"],
    ]);
    expect([...container.children].every((el) => el.getAttribute("aria-hidden") === "true" && el.classList.contains("skeleton"))).toBe(true);
  });
});

describe("빈 상태 · 오류", () => {
  it("EmptyState: 글자만 주면 지금처럼 한 줄 문장, 아이콘·제목·행동을 주면 다음 할 일 버튼(링크·버튼)", () => {
    const onClick = vi.fn();
    render(
      <MemoryRouter>
        <EmptyState>아직 알림이 없습니다.</EmptyState>
        <EmptyState
          icon="bell"
          title="알림이 없어요"
          action={{ label: "알림 설정", to: "/my" }}
          secondary={{ label: "새로 고침", onClick }}
        >
          새 소식이 오면 여기에 모여요.
        </EmptyState>
      </MemoryRouter>,
    );
    expect(screen.getByText("아직 알림이 없습니다.").tagName).toBe("P");
    expect(screen.getByText("알림이 없어요")).toBeTruthy();
    expect(screen.getByRole("link", { name: "알림 설정" }).getAttribute("href")).toBe("/my");
    fireEvent.click(screen.getByRole("button", { name: "새로 고침" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("ErrorState: role=alert와 '다시 시도' 이름은 그대로. 다시 불러오는 중에는 눌러도 다시 부르지 않는다. compact도 같다", () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ErrorState message="불러오지 못했어요." onRetry={onRetry} />);
    expect(screen.getByRole("alert").textContent).toBe("불러오지 못했어요.다시 시도");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorState message="불러오지 못했어요." onRetry={onRetry} retrying />);
    expect(screen.getByRole("button", { name: "다시 시도" }).getAttribute("aria-busy")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    rerender(<ErrorState message="불러오지 못했어요." onRetry={onRetry} compact />);
    expect(screen.getByRole("alert").textContent).toBe("불러오지 못했어요.다시 시도");
  });
});

describe("Flash · VerdictBadge · Segmented 글자 · Sheet 설명", () => {
  it("Flash: 처음 그릴 때·값을 처음 받을 때는 그대로, 바뀌면 tone대로 — trend는 오름 빨강·내림 파랑, ok는 늘 때만 초록, neutral은 방향 없이 회색", () => {
    const cls = () => screen.getByText("값").className;
    const { rerender } = render(<Flash value={null}>값</Flash>);
    expect(cls()).not.toMatch(/animate-flash/);
    rerender(<Flash value={100}>값</Flash>);
    expect(cls()).not.toMatch(/animate-flash/); // 빈 값 → 값은 도착이지 바뀐 것이 아니다
    rerender(<Flash value={120}>값</Flash>);
    expect(cls()).toContain("animate-flash-up");
    rerender(<Flash value={90}>값</Flash>);
    expect(cls()).toContain("animate-flash-down");
    // neutral: 줄어도 같은 회색 (방향에 뜻이 없다 — 파랑이면 하락으로 읽힌다)
    const { rerender: again, unmount } = render(<Flash tone="neutral" value={5}>neutral</Flash>);
    expect(screen.getByText("neutral").className).not.toMatch(/animate-flash/);
    again(<Flash tone="neutral" value={3}>neutral</Flash>);
    expect(screen.getByText("neutral").className).toContain("animate-flash-neutral");
    expect(screen.getByText("neutral").className).not.toMatch(/animate-flash-(up|down)/);
    unmount();
    // ok: 늘 때만 초록. 줄면(예시 재생을 끄고 실제 Trace로 — 복구 수가 줄 때) 깜빡이지 않는다 — 초록은 복구가 일어난 것으로 읽힌다
    const ok = render(<Flash tone="ok" value={2}>ok</Flash>);
    ok.rerender(<Flash tone="ok" value={0}>ok</Flash>);
    expect(screen.getByText("ok").className).not.toMatch(/animate-flash/);
    ok.rerender(<Flash tone="ok" value={1}>ok</Flash>);
    expect(screen.getByText("ok").className).toContain("animate-flash-ok");
    expect(screen.getByText("ok").className).not.toMatch(/animate-flash-(up|down|neutral)/);
    ok.unmount();
  });

  it("Flash: 깜빡임이 끝나면 클래스를 지운다(다시 마운트하지 않고) — 목록 순서가 바뀌어 줄이 옮겨져도 바뀌지 않은 값이 또 깜빡이지 않게 (runtime-3)", () => {
    // jsdom에는 AnimationEvent가 없어 React가 접두사 이름(webkitAnimationEnd)을 듣는다 — 두 이름을 다 보낸다
    const animationEnd = (el: Element, animationName: string) => {
      for (const type of ["animationend", "webkitAnimationEnd"]) {
        const ev = new Event(type, { bubbles: true });
        Object.defineProperty(ev, "animationName", { value: animationName });
        fireEvent(el, ev);
      }
    };
    const { rerender } = render(
      <Flash value={1}>
        <b>값</b>
      </Flash>,
    );
    rerender(
      <Flash value={2}>
        <b>값</b>
      </Flash>,
    );
    const span = screen.getByText("값").parentElement!;
    expect(span.className).toContain("animate-flash-up");
    animationEnd(screen.getByText("값"), "flash-up"); // 안쪽 요소의 애니메이션은 세지 않는다
    expect(span.className).toContain("animate-flash-up");
    animationEnd(span, "flash-up");
    expect(screen.getByText("값").parentElement).toBe(span);
    expect(span.className).not.toMatch(/animate-flash/);
    rerender(
      <Flash value={1}>
        <b>값</b>
      </Flash>,
    );
    expect(screen.getByText("값").parentElement!.className).toContain("animate-flash-down"); // 다음 변화는 그대로 깜빡인다
  });

  it("VerdictBadge: AI 판정에는 시장 상승색(빨강)을 쓰지 않는다 — BUY 연파랑, PASS 회색 (뜻은 글자가 말한다)", () => {
    render(
      <>
        <VerdictBadge verdict="BUY" />
        <VerdictBadge verdict="PASS" />
      </>,
    );
    const classes = (v: string) => screen.getByText(v).className.split(" ");
    expect(classes("BUY")).toEqual(expect.arrayContaining(["bg-brand-soft", "text-brand-ink"]));
    expect(classes("PASS")).toEqual(expect.arrayContaining(["bg-fill", "text-sub"]));
    for (const v of ["BUY", "PASS"]) expect(classes(v).filter((c) => /^(bg|text)-up/.test(c))).toEqual([]);
  });

  it("Segmented: 화면 바탕(page) 위의 고르지 않은 칸 글자는 sub (트랙이 어두워 mute는 4.5:1에 못 미친다), 카드 안은 mute", () => {
    const options = [
      { value: "7", label: "7일" },
      { value: "30", label: "30일" },
    ];
    render(
      <>
        <Segmented label="카드 안" value="7" onChange={() => {}} options={options} />
        <Segmented label="바탕 위" surface="page" value="7" onChange={() => {}} options={options} />
      </>,
    );
    const off = (group: string) => within(screen.getByRole("group", { name: group })).getByRole("button", { name: "30일" }).className.split(" ");
    expect(off("카드 안")).toContain("text-mute");
    expect(off("바탕 위")).toContain("text-sub");
    expect(off("바탕 위")).not.toContain("text-mute");
  });

  it("Sheet: describedBy를 주면 대화상자의 설명(aria-describedby)으로 읽힌다 — 처음 포커스는 그대로 첫 버튼", () => {
    render(
      <Sheet open onClose={() => {}} labelledBy="sheet-title" describedBy="sheet-result">
        <h2 id="sheet-title">왜 샀나요?</h2>
        <button type="button">나중에 적기</button>
        <p id="sheet-result">모의 계좌에서 현대차 1주를 샀어요</p>
      </Sheet>,
    );
    const dialog = screen.getByRole("dialog", { name: "왜 샀나요?" });
    expect(dialog.getAttribute("aria-describedby")).toBe("sheet-result");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "나중에 적기" }));
  });
});

describe("토스트", () => {
  function Shower({ message, tone, action }: { message: string; tone?: ToastTone; action?: ToastAction }) {
    const toast = useToast();
    return (
      <button type="button" onClick={() => toast(message, tone, action ? { action } : undefined)}>
        보이기
      </button>
    );
  }
  const region = () => screen.getByRole("status");
  const show = () => fireEvent.click(screen.getByRole("button", { name: "보이기" }));

  it("body 포털의 role=status 하나(배경 잠금에서 빠짐). 톤은 아이콘으로 나누고 바탕은 같은 반전 표면 — 글자는 문장 그대로", () => {
    function Tones() {
      const toast = useToast();
      return (
        <>
          <button type="button" onClick={() => toast("저장했어요", "success")}>
            성공
          </button>
          <button type="button" onClick={() => toast("저장하지 못했어요", "error")}>
            실패
          </button>
          <button type="button" onClick={() => toast("알려 드려요")}>
            안내
          </button>
        </>
      );
    }
    const { container } = render(
      <ToastProvider>
        <Tones />
      </ToastProvider>,
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(container.contains(region())).toBe(false);
    expect(region().hasAttribute("data-inert-exempt")).toBe(true);
    for (const name of ["성공", "실패", "안내"]) fireEvent.click(screen.getByRole("button", { name }));
    const [ok, bad, info] = [...region().children] as HTMLElement[];
    expect([ok.textContent, bad.textContent, info.textContent]).toEqual(["저장했어요", "저장하지 못했어요", "알려 드려요"]);
    expect(ok.querySelector("svg")?.getAttribute("class")).toContain("text-ok");
    expect(bad.querySelector("svg")?.getAttribute("class")).toContain("text-up");
    expect(info.querySelector("svg")).toBeNull();
    // 오류도 같은 반전 표면 (흰 글자 on 빨강은 AA 미달이라 쓰지 않는다)
    expect(bad.className).toContain("bg-ink");
    expect(bad.className).not.toContain("bg-up");
  });

  it("보이는 시간: 3초 + 글자당 50ms, 최대 6초. 동작 버튼이 있으면 6초", () => {
    expect(toastDuration("주문을 취소했습니다.")).toBe(3000 + 50 * 11);
    const reserved = "장이 닫혀 있어 현대차 1주 시장가 매수를 다음 정규장 시작에 예약했습니다."; // 42자
    expect(toastDuration(reserved)).toBe(3000 + 50 * 42);
    expect(toastDuration(`${reserved} ${reserved}`)).toBe(6000);
    expect(toastDuration("안내를 닫았어요", true)).toBe(6000);
  });

  it("시간이 지나면 사라지고, 마우스를 올린 동안은 멈춘다(남은 시간부터 다시). 누르면 바로 닫힌다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const message = "주문을 취소했습니다.";
    const d = toastDuration(message);
    render(
      <ToastProvider>
        <Shower message={message} />
      </ToastProvider>,
    );
    show();
    expect(region().textContent).toBe(message);
    act(() => vi.advanceTimersByTime(d - 500));
    expect(region().textContent).toBe(message);
    act(() => vi.advanceTimersByTime(600));
    expect(region().textContent).toBe("");

    show();
    const item = region().firstElementChild!;
    fireEvent.mouseEnter(item);
    act(() => vi.advanceTimersByTime(20_000));
    expect(region().textContent).toBe(message);
    fireEvent.mouseLeave(item);
    act(() => vi.advanceTimersByTime(d - 500));
    expect(region().textContent).toBe(message);
    act(() => vi.advanceTimersByTime(600));
    expect(region().textContent).toBe("");

    show();
    fireEvent.click(region().firstElementChild!);
    expect(region().textContent).toBe("");
  });

  it("다른 탭을 보는 동안은 시간을 세지 않는다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    render(
      <ToastProvider>
        <Shower message="저장했어요" />
      </ToastProvider>,
    );
    show();
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(20_000));
    expect(region().textContent).toBe("저장했어요");
    visibility.mockReturnValue("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    act(() => vi.advanceTimersByTime(toastDuration("저장했어요") + 100));
    expect(region().textContent).toBe("");
  });

  it("동작 버튼(되돌리기): 포커스가 안에 있는 동안 멈추고, 누르면 동작하고 닫힌다", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const undo = vi.fn();
    render(
      <ToastProvider>
        <Shower message="안내를 닫았어요" action={{ label: "되돌리기", onClick: undo }} />
      </ToastProvider>,
    );
    show();
    const btn = within(region()).getByRole("button", { name: "되돌리기" });
    act(() => btn.focus());
    act(() => vi.advanceTimersByTime(20_000));
    expect(region().textContent).toContain("안내를 닫았어요");
    fireEvent.click(btn);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(region().textContent).toBe("");
  });

  it(`한 번에 최대 ${TOAST_MAX}개 — 넘치면 가장 오래된 것부터 뺀다`, () => {
    function Many() {
      const toast = useToast();
      return (
        <button type="button" onClick={() => ["하나", "둘", "셋", "넷"].forEach((m) => toast(m))}>
          여러 개
        </button>
      );
    }
    render(
      <ToastProvider>
        <Many />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "여러 개" }));
    expect([...region().children].map((c) => c.textContent)).toEqual(["둘", "셋", "넷"]);
  });
});

describe("PageHeader", () => {
  function Where() {
    const { pathname } = useLocation();
    return <p>도착 {pathname}</p>;
  }
  function renderAt(entries: string[], element: ReactNode) {
    db.setSession("alice");
    return render(
      <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
        <Providers client={createQueryClient({ retry: false })}>
          <Routes>
            <Route path="/reports/:id" element={element} />
            <Route path="/plans/:id" element={element} />
            <Route path="*" element={<Where />} />
          </Routes>
        </Providers>
      </MemoryRouter>,
    );
  }
  const back = () => fireEvent.click(screen.getByRole("button", { name: "뒤로 가기" }));

  it("링크로 바로 연 화면(앱 안에 이전 화면 없음)의 뒤로 가기: true면 탭 묶음의 첫 화면, 문자열이면 그 주소 — 앱 밖으로 나가지 않는다", () => {
    const first = renderAt(["/reports/5"], <PageHeader title="삼성전자 AI 리포트" back bell={false} />);
    back();
    expect(screen.getByText("도착 /reports")).toBeTruthy();
    first.unmount();
    renderAt(["/plans/3"], <PageHeader title="모의 자동매매" back="/recommendations" bell={false} />);
    back();
    expect(screen.getByText("도착 /recommendations")).toBeTruthy();
  });

  it("앱 안에서 온 화면은 이전 화면으로. 브라우저 기록 번호(history.state.idx)가 있으면 그것으로 판단한다 (replace 이동에도 맞다)", () => {
    const first = renderAt(["/search", "/reports/5"], <PageHeader title="리포트" back bell={false} />);
    back();
    expect(screen.getByText("도착 /search")).toBeTruthy();
    first.unmount();
    window.history.replaceState({ idx: 0 }, "");
    try {
      renderAt(["/search", "/reports/5"], <PageHeader title="리포트" back bell={false} />);
      back();
      expect(screen.getByText("도착 /reports")).toBeTruthy();
    } finally {
      window.history.replaceState(null, "");
    }
  });

  it("대체 경로 = 탭 묶음의 첫 화면 (탭 첫 화면·묶음 밖은 홈)", () => {
    const paths = [
      "/reports/12",
      "/analyses/3",
      "/plans/3",
      "/recommendations/2",
      "/stocks/005930",
      "/ranking",
      "/notifications",
      "/search",
      "/",
    ];
    expect(paths.map(parentPath)).toEqual([
      "/reports",
      "/reports",
      "/portfolio",
      "/portfolio",
      "/search",
      "/my",
      "/",
      "/",
      "/",
    ]);
  });

  it("브라우저 탭 제목 '<제목> · 모매매' (글자가 아닌 제목은 docTitle), 화면이 사라지면 서비스 이름", () => {
    const first = renderAt(["/reports/5"], <PageHeader title="랭킹" bell={false} />);
    expect(document.title).toBe("랭킹 · 모매매");
    first.unmount();
    expect(document.title).toBe("모매매");
    renderAt(["/reports/5"], <PageHeader title={<span>삼성전자</span>} docTitle="삼성전자 AI 리포트" bell={false} />);
    expect(document.title).toBe("삼성전자 AI 리포트 · 모매매");
  });

  it("brand: 모바일 머리에 로고 + 서비스 이름(링크·제목 아님), h1은 화면 읽기용으로 남는다", () => {
    renderAt(["/reports/5"], <PageHeader title="홈" brand bell={false} />);
    const h1 = screen.getByRole("heading", { level: 1, name: "홈" });
    expect(h1.className).toContain("max-lg:sr-only");
    const name = screen.getByText("모매매");
    expect(name.closest("a, h1, h2")).toBeNull();
    // 잠금: 로고 28px(32px보다 작아 속이 찬 사각형 셋, 장식) + 워드마크, PC에서는 숨는다 (PC는 왼쪽 메뉴에 브랜드가 있다)
    const lockup = name.parentElement!;
    const logo = lockup.querySelector("svg")!;
    expect([logo.getAttribute("width"), logo.getAttribute("aria-hidden"), logo.querySelectorAll("path").length, logo.querySelectorAll("rect").length]).toEqual(["28", "true", 0, 4]);
    expect(lockup.className.split(" ")).toEqual(expect.arrayContaining(["text-[18px]", "lg:hidden"]));
    expect(lockup.textContent).toBe("모매매"); // 옛 'AI' 글자 마크가 남지 않는다
  });

  it("화면을 옮기면(앞으로) 갈 곳을 잃은 포커스를 제목으로 — 첫 화면·화면이 준 포커스(autoFocus)는 건드리지 않는다", () => {
    function Page({ name, search = false }: { name: string; search?: boolean }) {
      return (
        <main>
          <PageHeader title={name} bell={false} />
          {/* 검색 화면처럼 스스로 포커스를 주는 화면 */}
          {search && <input aria-label="종목 검색" autoFocus />}
        </main>
      );
    }
    db.setSession("alice");
    render(
      <MemoryRouter initialEntries={["/a"]}>
        <Providers client={createQueryClient({ retry: false })}>
          <nav>
            <Link to="/b">B로</Link>
            <Link to="/c">C로</Link>
          </nav>
          <Routes>
            {/* 앱에서는 RouteTransition이 주소마다 화면을 새로 마운트한다 (여기서는 key로 같게) */}
            <Route path="/a" element={<Page key="a" name="A" />} />
            <Route path="/b" element={<Page key="b" name="B" />} />
            <Route path="/c" element={<Page key="c" name="C" search />} />
          </Routes>
        </Providers>
      </MemoryRouter>,
    );
    expect(document.activeElement).toBe(document.body);
    const toB = screen.getByRole("link", { name: "B로" });
    toB.focus();
    fireEvent.click(toB);
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "B" }));
    fireEvent.click(screen.getByRole("link", { name: "C로" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "종목 검색" }));
  });

  it("뼈대 제목(Skeleton)은 화면 읽기에 docTitle을 읽히고, 진짜 제목이 오면 h1을 새로 그려 다시 포커스한다 (글자만 바뀌면 알리지 않는다)", () => {
    function Detail() {
      const [ready, setReady] = useState(false);
      return (
        <main>
          {/* 상세 화면처럼 뼈대와 본문의 머리를 같은 자리(첫 자식)에 그린다 — React는 같은 PageHeader를 다시 쓴다 */}
          {ready ? (
            <PageHeader title="SK하이닉스 AI 리포트" back bell={false} />
          ) : (
            <PageHeader title={<Skeleton className="h-6 w-40" />} docTitle="AI 리포트" back bell={false} />
          )}
          <button type="button" onClick={() => setReady(true)}>
            도착
          </button>
        </main>
      );
    }
    db.setSession("alice");
    render(
      <MemoryRouter initialEntries={["/"]}>
        <Providers client={createQueryClient({ retry: false })}>
          <Link to="/reports/1">리포트로</Link>
          <Routes>
            <Route path="/" element={<p>홈</p>} />
            <Route path="/reports/:id" element={<Detail />} />
          </Routes>
        </Providers>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("link", { name: "리포트로" }));
    const loading = screen.getByRole("heading", { level: 1, name: "AI 리포트" }); // 이름 없는 '제목 1'이 아니다
    expect(document.activeElement).toBe(loading);
    fireEvent.click(screen.getByRole("button", { name: "도착" })); // 데이터가 왔다 (fireEvent는 포커스를 옮기지 않는다)
    const ready = screen.getByRole("heading", { level: 1, name: "SK하이닉스 AI 리포트" });
    expect(ready).not.toBe(loading); // 새 노드에 포커스가 가야 화면 읽기가 새 제목을 읽는다
    expect(document.activeElement).toBe(ready);
  });

  it("포커스가 본문(main) 자체에 남아 있어도(빈 곳을 누름·링크를 눌러도 포커스를 주지 않는 Safari) 이동 뒤 제목으로 옮긴다", () => {
    function Page({ name }: { name: string }) {
      return (
        <>
          <PageHeader title={name} bell={false} />
          <Link to="/b">B로</Link>
        </>
      );
    }
    db.setSession("alice");
    render(
      <MemoryRouter initialEntries={["/a"]}>
        <Providers client={createQueryClient({ retry: false })}>
          <main tabIndex={-1} aria-label="본문">
            <Routes>
              <Route path="/a" element={<Page key="a" name="A" />} />
              <Route path="/b" element={<Page key="b" name="B" />} />
            </Routes>
          </main>
        </Providers>
      </MemoryRouter>,
    );
    const main = screen.getByRole("main", { name: "본문" });
    act(() => main.focus());
    fireEvent.click(screen.getByRole("link", { name: "B로" })); // fireEvent는 링크에 포커스를 주지 않는다 (Safari와 같음)
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "B" }));
  });
});

describe("Layout (앱 뼈대)", () => {
  beforeEach(() => vi.stubGlobal("localStorage", memoryStorage()));

  it("지금 탭을 다시 누르면 맨 위로 부드럽게 (주소 그대로). 탭 안의 다른 화면에서 누르면 그 탭의 첫 화면으로", async () => {
    renderApp("/plans");
    const tabs = await screen.findByRole("navigation", { name: "하단 탭" });
    fireEvent.click(within(tabs).getByRole("link", { name: "모의투자" }));
    expect(await screen.findByRole("heading", { name: "모의투자" })).toBeTruthy();
    const scrollTo = vi.spyOn(window, "scrollTo");
    fireEvent.click(within(tabs).getByRole("link", { name: "모의투자" }));
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, left: 0, behavior: "smooth" });
    expect(screen.getByRole("heading", { name: "모의투자" })).toBeTruthy();
  });

  it("PC 왼쪽 메뉴의 브랜드(홈)·프로필(마이)도 그 화면에서 다시 누르면 맨 위로 부드럽게", async () => {
    renderApp("/my");
    const profile = await screen.findByRole("link", { name: /@alice/ });
    const scrollTo = vi.spyOn(window, "scrollTo");
    fireEvent.click(profile);
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "smooth" });
    fireEvent.click(screen.getByRole("link", { name: "모매매" })); // 다른 화면에서는 홈으로 간다
    expect(await screen.findByRole("heading", { name: "홈" })).toBeTruthy();
    scrollTo.mockClear();
    fireEvent.click(screen.getByRole("link", { name: "모매매" }));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 0, left: 0, behavior: "smooth" });
  });

  it("html[data-shell] (토스트 자리): 하단 탭 위 / 종목 상세 전문가 보기는 주문 바 위. 숨긴 하단 탭은 내려가며 화면 읽기·Tab에서 빠진다", async () => {
    const home = renderApp("/");
    await screen.findByRole("navigation", { name: "하단 탭" });
    expect(document.documentElement.getAttribute("data-shell")).toBe("tabs");
    home.unmount();
    expect(document.documentElement.hasAttribute("data-shell")).toBe(false);
    renderApp("/stocks/005380"); // 앨리스: 전문가 보기
    await screen.findByRole("region", { name: "주문" });
    await waitFor(() => expect(document.documentElement.getAttribute("data-shell")).toBe("order"));
    const nav = document.querySelector('nav[aria-label="하단 탭"]')!;
    expect(nav.getAttribute("aria-hidden")).toBe("true");
    expect(nav.hasAttribute("inert")).toBe(true);
  });

  it("PC 왼쪽 메뉴의 '어두운 모드' 스위치: 지금 테마의 반대를 명시 값으로 저장하고 바로 칠한다 (주 메뉴 밖)", async () => {
    renderApp("/");
    const sw = (await screen.findByRole("switch", { name: "어두운 모드" })) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("paper-theme")).toBe("dark");
    expect(sw.checked).toBe(true);
    fireEvent.click(sw);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem("paper-theme")).toBe("light");
    expect(within(screen.getByRole("navigation", { name: "주 메뉴" })).queryByRole("switch")).toBeNull();
  });

  it("본문 바로가기: 첫 링크이고, 누르면 화면 제목으로 포커스를 옮긴다", async () => {
    renderApp("/reports");
    const title = await screen.findByRole("heading", { name: "AI 리포트" });
    const skip = screen.getAllByRole("link")[0];
    expect(skip.textContent).toBe("본문 바로가기");
    fireEvent.click(skip);
    expect(document.activeElement).toBe(title);
  });

  it("연결이 끊기면 화면 아래(하단 바 위) 띠로 알리고, 다시 연결되면 '다시 연결됐어요'를 잠깐 보인 뒤 접는다 — 보이는 동안 토스트는 띠 위로", async () => {
    renderApp("/my");
    await screen.findByRole("navigation", { name: "하단 탭" });
    const root = document.documentElement;
    try {
      act(() => onlineManager.setOnline(false));
      const band = screen.getByText("인터넷 연결이 끊겼어요. 연결되면 다시 불러와요");
      // 위쪽(화면 머리·검색칸 자리)이 아니라 아래 칸 (index.css .connection-region). 보이는 동안 html[data-connection] — 토스트가 띠 위로 비킨다
      expect(band.closest(".connection-region")?.getAttribute("aria-live")).toBe("polite");
      expect(root.hasAttribute("data-connection")).toBe(true);
      act(() => onlineManager.setOnline(true));
      expect(screen.getByText("다시 연결됐어요")).toBeTruthy();
      expect(root.hasAttribute("data-connection")).toBe(true);
      await waitFor(() => expect(screen.queryByText("다시 연결됐어요")).toBeNull(), { timeout: 3000 });
      expect(root.hasAttribute("data-connection")).toBe(false);
    } finally {
      onlineManager.setOnline(true);
    }
  }, 10_000);
});

describe("부팅 · 화면 오류", () => {
  it("로그인 확인 중에는 앱 뼈대 자리를 보이되 300ms 늦게 나타난다 (빠르면 아무것도 보이지 않는다)", async () => {
    server.use(
      http.get("*/api/auth/me", async () => {
        await new Promise((r) => setTimeout(r, 150));
        return HttpResponse.json({ detail: "로그인이 필요합니다." }, { status: 401 });
      }),
    );
    renderApp("/", null);
    const boot = screen.getByLabelText("불러오는 중");
    expect(boot.getAttribute("aria-busy")).toBe("true");
    const shell = boot.firstElementChild as HTMLElement;
    expect(shell.className).toContain("animate-fade-in");
    expect(shell.style.animationDelay).toBe("300ms");
    // 왼쪽 메뉴 자리의 브랜드는 실제 메뉴(Layout)와 같은 로고 32px + 이름 — 뼈대가 화면으로 바뀔 때 움직이지 않게
    const brand = within(boot).getByText("모매매").parentElement!;
    expect(brand.querySelector("svg")?.getAttribute("width")).toBe("32");
    expect(brand.textContent).toBe("모매매");
    expect(await screen.findByRole("button", { name: "로그인" })).toBeTruthy();
  });

  it("한 화면이 그리다 실패해도 뼈대(하단 탭·메뉴·출처 줄)는 남고 다시 시도·홈으로 갈 수 있다", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {}); // React가 잡은 오류를 콘솔에 남긴다
    renderApp("/ranking");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("화면을 그리다 문제가 생겼어요");
    expect(within(alert).getByRole("link", { name: "홈으로" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("navigation", { name: "하단 탭" })).toBeTruthy();
    expect(screen.getByLabelText("자료 출처")).toBeTruthy();
    fireEvent.click(within(screen.getByRole("navigation", { name: "하단 탭" })).getByRole("link", { name: "홈" }));
    expect(await screen.findByRole("heading", { name: "홈" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("알림 종", () => {
  it("배지는 안 읽은 수가 늘 때만 튄다 (처음 받은 수·줄어든 수는 그대로)", async () => {
    db.setSession("alice");
    const client = createQueryClient({ retry: false });
    render(
      <MemoryRouter>
        <Providers client={client}>
          <NotificationBell />
        </Providers>
      </MemoryRouter>,
    );
    const bell = await screen.findByRole("link", { name: /안 읽은 알림/ });
    const badge = () => bell.querySelector("span")!;
    expect(badge().className).not.toContain("animate-pop-in");
    const page = client.getQueryData<NotificationPage>(keys.notifications(true))!;
    act(() => {
      client.setQueryData(keys.notifications(true), { ...page, unreadCount: page.unreadCount + 1 });
    });
    await waitFor(() => expect(bell.getAttribute("aria-label")).toBe(`알림 (안 읽은 알림 ${page.unreadCount + 1}개)`));
    const popped = badge();
    expect(popped.className).toContain("animate-pop-in");
    act(() => {
      client.setQueryData(keys.notifications(true), { ...page });
    });
    await waitFor(() => expect(bell.getAttribute("aria-label")).toBe(`알림 (안 읽은 알림 ${page.unreadCount}개)`));
    expect(badge()).toBe(popped); // 줄면 다시 튀지 않는다 (같은 요소)
  });

  it("알림 화면에서는 머리의 종이 '지금 여기'(aria-current)로 보인다", async () => {
    renderApp("/notifications");
    await screen.findByRole("list", { name: "알림 목록" });
    const bell = document.querySelector<HTMLAnchorElement>("header.page-header a[href='/notifications']")!;
    expect(bell.getAttribute("aria-current")).toBe("page");
  });
});

describe("보기 전환 (ViewToggle)", () => {
  const state = (p: Partial<ViewModeState>): ViewModeState => ({
    view: "easy",
    easy: true,
    expert: false,
    override: null,
    beginnerMode: true,
    setView: vi.fn(),
    ...p,
  });
  const bob = state({});
  const bobExpert = state({ view: "expert", easy: false, expert: true, override: "expert" });
  const alice = state({ view: "expert", easy: false, expert: true, beginnerMode: false });
  const aliceEasy = state({ override: "easy", beginnerMode: false });
  const bobSameAsOwn = state({ override: "easy" }); // ?view=easy가 원래 보기와 같으면 덮어쓰기가 아니다

  it("라벨은 '누르면 갈 곳': 원래 보기면 '이 화면만 …', 이 화면만 바꾼 상태면 '… 돌아가기', 좁은 자리는 보기 이름", () => {
    const cases: [ViewModeState, string, string, ViewMode | null][] = [
      [bob, "이 화면만 자세히 보기", "전문가 보기", "expert"],
      [bobExpert, "쉬운 보기로 돌아가기", "쉬운 보기", null],
      [alice, "이 화면만 쉽게 보기", "쉬운 보기", "easy"],
      [aliceEasy, "전문가 보기로 돌아가기", "전문가 보기", null],
      [bobSameAsOwn, "이 화면만 자세히 보기", "전문가 보기", "expert"],
    ];
    for (const [view, full, compact, next] of cases) {
      const a = render(<ViewToggle view={view} />);
      fireEvent.click(screen.getByRole("button", { name: full }));
      expect(view.setView).toHaveBeenLastCalledWith(next);
      a.unmount();
      const b = render(<ViewToggle view={view} compact />);
      expect(screen.getByRole("button", { name: compact })).toBeTruthy();
      b.unmount();
    }
  });

  it("자리: 좁은 칩은 화면 머리(바탕 위 — 카드색 + 테두리), 아니면 카드 안(연한 회색). placement로 정할 수 있다", () => {
    render(
      <>
        <ViewToggle view={bob} compact />
        <ViewToggle view={alice} />
        <ViewToggle view={bobExpert} compact placement="card" />
      </>,
    );
    const surface = (b: HTMLElement) => b.className.split(" ").filter((c) => c === "bg-card" || c === "bg-fill" || c === "ring-1");
    expect(screen.getAllByRole("button").map((b) => [b.textContent, surface(b)])).toEqual([
      ["전문가 보기", ["bg-card", "ring-1"]],
      ["이 화면만 쉽게 보기", ["bg-fill"]],
      ["쉬운 보기", ["bg-fill"]],
    ]);
  });
});

describe("로그인 화면", () => {
  it("아이디 칸은 자동 대문자·고침을 끄고, 비밀번호는 눌러서 볼 수 있다 (칸 이름은 그대로). 이용 순서 3단계·탭 제목", async () => {
    renderApp("/", null);
    const id = (await screen.findByLabelText("아이디")) as HTMLInputElement;
    expect(["autocapitalize", "autocorrect", "spellcheck", "enterkeyhint"].map((a) => id.getAttribute(a))).toEqual([
      "none",
      "off",
      "false",
      "next",
    ]);
    const pw = screen.getByLabelText("비밀번호") as HTMLInputElement;
    expect(pw.type).toBe("password");
    const eye = screen.getByRole("button", { name: "비밀번호 보기" });
    expect(eye.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(eye);
    expect(pw.type).toBe("text");
    expect(eye.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(screen.getByRole("list", { name: "이용 순서" }))
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["①리포트 만들기", "②검토", "③모의 자동매매"]);
    expect(document.title).toBe("로그인 · 모매매");
    expect(screen.queryByText(/로그인이 끝났어요/)).toBeNull();
  });

  it("틀리면 두 칸에 오류 표시(aria-invalid)와 오류 문장을 잇고, 고치기 시작하면 표시를 거둔다", async () => {
    renderApp("/", null);
    fireEvent.change(await screen.findByLabelText("아이디"), { target: { value: "alice" } });
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "로그인" }));
    const alert = await screen.findByRole("alert");
    // 오류 글자는 up-ink (흰 바탕 위 AA). text-up은 가격 상승 숫자색이라 작은 글자에서 4.5:1에 못 미친다
    expect(alert.className.split(" ")).toContain("text-up-ink");
    expect(alert.className.split(" ")).not.toContain("text-up");
    for (const label of ["아이디", "비밀번호"]) {
      const input = screen.getByLabelText(label);
      expect([input.getAttribute("aria-invalid"), input.getAttribute("aria-describedby")]).toEqual(["true", alert.id]);
    }
    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "alice123" } });
    expect(screen.getByLabelText("아이디").getAttribute("aria-invalid")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("로그인한 채 쓰다가 세션이 끝나면 로그인 화면에서 이유와 돌아갈 곳을 알린다", async () => {
    renderApp("/portfolio");
    await screen.findByRole("list", { name: "보유 종목" });
    db.setSession(null);
    server.use(http.get("*/api/account", () => HttpResponse.json({ detail: "로그인이 필요합니다." }, { status: 401 })));
    fireEvent.click(screen.getByRole("tab", { name: "체결 내역" }));
    fireEvent.click(screen.getByRole("tab", { name: "보유 종목" }));
    expect(await screen.findByText("로그인이 끝났어요. 다시 로그인하면 보던 화면으로 돌아가요.", {}, { timeout: 3000 })).toBeTruthy();
    expect(screen.getByRole("button", { name: "로그인" })).toBeTruthy();
  });
});

describe("없는 주소", () => {
  it("아이콘·제목·설명·요청 주소, 큰 '홈으로'와 보조 '리포트 보기'", async () => {
    renderApp("/zzz");
    expect(await screen.findByRole("heading", { name: "페이지 없음" })).toBeTruthy();
    expect(screen.getByText("찾는 화면이 없어요")).toBeTruthy();
    expect(screen.getByText("/zzz")).toBeTruthy();
    expect(screen.getByRole("link", { name: "홈으로" }).getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: "리포트 보기" }).getAttribute("href")).toBe("/reports");
    expect(document.title).toBe("페이지 없음 · 모매매");
  });
});

describe("용어 풀이 (Term)", () => {
  it("시트 안에서 Esc는 풀이만 닫는다 (먼저 받아 처리했다고 표시) — 다음 Esc가 시트를 닫는다. 꼬리 자리·방향을 단다", () => {
    function Demo() {
      const [open, setOpen] = useState(true);
      return (
        <Sheet open={open} onClose={() => setOpen(false)} labelledBy="sheet-title">
          <h2 id="sheet-title">주문 확인</h2>
          <p>
            <Term k="손절" />
          </p>
        </Sheet>
      );
    }
    render(<Demo />);
    fireEvent.click(screen.getByRole("button", { name: "손절" }));
    const tip = screen.getByRole("tooltip");
    expect(tip.getAttribute("data-side")).toBe("bottom");
    expect(tip.style.getPropertyValue("--tail-x")).toMatch(/^\d+px$/);
    expect(screen.getByRole("button", { name: "손절" }).getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.getByRole("dialog", { name: "주문 확인" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  function TermThenSheet() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <p>
          <Term k="손절" /> <Term k="손익비" />
        </p>
        <button type="button" onClick={() => setOpen(true)}>
          판매하기
        </button>
        <Sheet open={open} onClose={() => setOpen(false)} labelledBy="dock-title">
          <h2 id="dock-title">주문</h2>
          <button type="button">팔기</button>
        </Sheet>
      </>
    );
  }

  it("포커스가 용어를 떠나면(Tab) 풀이를 닫는다 — 다음 칸을 덮지 않게. 풀이 상자를 눌러도 포커스는 용어에 남아 열린 채다", () => {
    render(<TermThenSheet />);
    const term = screen.getByRole("button", { name: "손절" });
    term.focus();
    fireEvent.click(term);
    const tip = screen.getByRole("tooltip");
    // 풀이 상자를 누르면(mousedown) 포커스가 body로 빠지지 않게 막는다 → 열린 채
    expect(fireEvent.mouseDown(tip)).toBe(false);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    // 창 전환처럼 포커스가 그대로인 blur는 무시한다
    fireEvent.blur(term);
    expect(screen.getByRole("tooltip")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "손익비" }).focus()); // Tab으로 다음 용어로
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(term.getAttribute("aria-expanded")).toBe("false");
  });

  it("배경(시트 뒤, inert)에 남은 풀이는 Esc를 먹지 않는다 — 풀이를 닫고, 같은 Esc로 시트도 닫힌다", () => {
    render(<TermThenSheet />);
    fireEvent.click(screen.getByRole("button", { name: "손절" })); // 누르기만 (Safari처럼 포커스 없음)
    fireEvent.click(screen.getByRole("button", { name: "판매하기" })); // fireEvent는 mousedown이 없어 풀이가 남는다
    expect(screen.getByRole("tooltip")).toBeTruthy();
    expect(screen.getByRole("dialog", { name: "주문" })).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
