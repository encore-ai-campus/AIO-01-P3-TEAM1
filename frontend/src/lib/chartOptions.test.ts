// 차트 손동작 (lib/chartOptions.ts): 휠·세로 스와이프는 페이지 스크롤에 양보하고, Ctrl/⌘ + 휠일 때만 차트가 확대한다.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHART_INTERACTION, NARROW_CHART_PX, lineTitle, zoomWheelWithModifier } from "./chartOptions";

const wheel = (init: WheelEventInit = {}) => new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120, ...init });

let cleanup: (() => void) | null = null;
afterEach(() => {
  cleanup?.();
  cleanup = null;
  document.body.innerHTML = "";
});

/** 차트 상자(box) 안에 차트 요소(inner)가 있는 모양. 차트는 휠을 inner에서 듣는다. */
function mount() {
  const box = document.createElement("div");
  const inner = document.createElement("div");
  box.appendChild(inner);
  document.body.appendChild(box);
  const chart = { applyOptions: vi.fn() };
  cleanup = zoomWheelWithModifier(box, chart);
  return { box, inner, chart };
}

describe("차트 손동작", () => {
  it("기본: 휠은 차트가 받지 않고, 세로로 쓸면 페이지 · 가로 끌기·두 손가락 벌리기·시간 축 끌기만 차트", () => {
    expect(CHART_INTERACTION.handleScroll).toEqual({ mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false });
    expect(CHART_INTERACTION.handleScale).toEqual({
      mouseWheel: false,
      pinch: true,
      axisPressedMouseMove: { time: true, price: false },
      axisDoubleClickReset: true,
    });
  });

  it("Ctrl/⌘ 휠일 때만 휠 확대를 켜고, 보통 휠이 오면 끈다 (바뀔 때만 옵션을 넣는다)", () => {
    const { inner, chart } = mount();
    inner.dispatchEvent(wheel());
    expect(chart.applyOptions).not.toHaveBeenCalled(); // 처음부터 꺼져 있다

    inner.dispatchEvent(wheel({ ctrlKey: true, deltaY: -40 }));
    expect(chart.applyOptions).toHaveBeenLastCalledWith({ handleScale: { mouseWheel: true } });
    inner.dispatchEvent(wheel({ metaKey: true, deltaY: -40 }));
    expect(chart.applyOptions).toHaveBeenCalledTimes(1);

    inner.dispatchEvent(wheel());
    expect(chart.applyOptions).toHaveBeenLastCalledWith({ handleScale: { mouseWheel: false } });
    expect(chart.applyOptions).toHaveBeenCalledTimes(2);
  });

  it("휠을 멈추지도 막지도 않는다 — 차트 안쪽과 페이지(window)의 휠 듣기가 그대로 받는다", () => {
    const { inner } = mount();
    const seen: string[] = [];
    inner.addEventListener("wheel", () => seen.push("chart"));
    const onWindow = () => seen.push("window");
    window.addEventListener("wheel", onWindow);
    const e = wheel();
    inner.dispatchEvent(e);
    window.removeEventListener("wheel", onWindow);
    expect(seen).toEqual(["chart", "window"]);
    expect(e.defaultPrevented).toBe(false);
  });

  it("가격 선 이름: 좁은 차트(모바일)는 빈 이름(범례가 이름·값을 보인다), 넓거나 폭을 모르면 그대로", () => {
    const box = (width: number) => {
      const el = document.createElement("div");
      Object.defineProperty(el, "clientWidth", { value: width });
      return el;
    };
    expect(lineTitle(box(358), "손절 가격")).toBe("");
    expect(lineTitle(box(NARROW_CHART_PX), "손절 가격")).toBe("손절 가격");
    expect(lineTitle(box(0), "손절 가격")).toBe("손절 가격"); // 테스트·숨김
    expect(lineTitle(null, "손절 가격")).toBe("손절 가격");
  });

  it("떼면 더는 옵션을 바꾸지 않는다", () => {
    const { inner, chart } = mount();
    cleanup?.();
    cleanup = null;
    inner.dispatchEvent(wheel({ ctrlKey: true }));
    expect(chart.applyOptions).not.toHaveBeenCalled();
  });
});
