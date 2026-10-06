// 차트 색 (lib/chartTheme.ts): 토큰을 읽고, 읽지 못하면 대체값. 테스트는 css:false라 기본은 대체값 경로다.
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { chartColors, useChartColors } from "./chartTheme";
import { setThemePref } from "./theme";

const LIGHT = {
  up: "#F04452",
  down: "#3182F6",
  text: "#8B95A1",
  grid: "#F2F4F6",
  crosshair: "#8B95A1",
  entryLine: "#4E5968",
  targetLine: "#F04452",
  stopLine: "#3182F6",
  accentLine: "#FF9F00", // 20일 이동평균 선은 경고 주황 그대로
  volUp: "rgba(240,68,82,0.28)",
  volDown: "rgba(49,130,246,0.28)",
};

let style: HTMLStyleElement | null = null;
/** index.css 대신 토큰 몇 개만 넣는다 (빌드는 값을 줄여 쓴다: #fff, #0006, #f044522e). */
function tokens(css: string) {
  style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
}
afterEach(() => {
  style?.remove();
  style = null;
});

describe("차트 색", () => {
  it("토큰이 없으면(라이트) 지금까지 쓰던 상수 그대로 — 대문자, 거래량은 28% 반투명", () => {
    expect(chartColors("light")).toEqual(LIGHT);
  });

  it("다크 대체값: 축 글자는 보조 글자색, 사는 가격 선도 같은 색, 거래량은 32%", () => {
    expect(chartColors("dark")).toEqual({
      up: "#F25C68",
      down: "#458EF7",
      text: "#B0B8C1",
      grid: "#23272F",
      crosshair: "#6B7684",
      entryLine: "#B0B8C1",
      targetLine: "#F25C68",
      stopLine: "#458EF7",
      accentLine: "#FF9F00",
      volUp: "rgba(242,92,104,0.32)",
      volDown: "rgba(69,142,247,0.32)",
    });
  });

  it("칠한 테마의 토큰을 읽는다 (짧은 hex·rgb() 모두) — 라이브러리에 var() 문자열을 넘기지 않는다", () => {
    tokens(
      ':root{--color-up:#fee;--color-down:rgb(1 2 3 / 0.5);--color-fill:#f2f4f6;--color-mute-weak:#8b95a1}' +
        ':root[data-theme="dark"]{--color-up:#f25c6847;--color-down:#458ef7;--color-sub:#b0b8c1;--color-warn:#ffb547}',
    );
    const light = chartColors("light");
    expect(light.up).toBe("#fee");
    expect(light.volUp).toBe("rgba(255,238,238,0.28)");
    expect(light.down.replace(/\s/g, "")).toBe("rgb(123/0.5)"); // 공백은 브라우저마다 다르게 정리된다
    expect(light.volDown).toBe("rgba(1,2,3,0.28)");
    expect(light.grid).toBe("#f2f4f6");
    expect(light.accentLine).toBe("#FF9F00"); // 토큰이 없는 것은 대체값

    document.documentElement.setAttribute("data-theme", "dark");
    const dark = chartColors("dark");
    expect(dark.up).toBe("#f25c6847");
    expect(dark.volUp).toBe("rgba(242,92,104,0.32)"); // 8자리 hex의 알파는 버리고 거래량 알파를 쓴다
    expect(dark.text).toBe("#b0b8c1");
    expect(dark.accentLine).toBe("#ffb547"); // 이동평균 선은 경고 토큰(warn)을 읽는다
    expect(Object.values(dark).some((v) => v.includes("var("))).toBe(false);
  });

  it("칠한 테마와 다른 테마를 물으면 그 테마의 대체값 (다크 토큰을 라이트 차트에 쓰지 않는다)", () => {
    tokens(':root[data-theme="dark"]{--color-up:#f25c68}');
    document.documentElement.setAttribute("data-theme", "dark");
    expect(chartColors("light")).toEqual(LIGHT);
  });

  it("읽을 수 없는 색이면 거래량 막대는 대체값의 반투명", () => {
    tokens(":root{--color-up:color(display-p3 1 0 0)}");
    const c = chartColors("light");
    expect(c.up).toBe("color(display-p3 1 0 0)");
    expect(c.volUp).toBe("rgba(240,68,82,0.28)");
  });

  it("useChartColors: 테마가 바뀌면 새 색 (차트는 applyOptions로 색만 바꾼다)", () => {
    const { result } = renderHook(() => useChartColors());
    const first = result.current;
    expect(first).toEqual(LIGHT);
    act(() => setThemePref("dark"));
    expect(result.current).not.toBe(first);
    expect(result.current.up).toBe("#F25C68");
    act(() => setThemePref("dark")); // 같은 값이면 같은 객체
    expect(result.current.up).toBe("#F25C68");
  });
});
