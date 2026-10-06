// 차트(lightweight-charts) 색. 캔버스는 CSS 변수를 모르므로 html의 --color-* 토큰을 읽어 색 문자열로 넘긴다.
// 라이브러리는 색 문자열을 키로 캐시하므로 'var(--x)'를 넘기지 않는다. 테마가 바뀌면 차트를 다시 만들지 말고 applyOptions로 색만 바꾼다.
// 이 파일은 하드코딩 색 검사(colors.test.ts)의 예외다: 토큰을 읽지 못할 때 쓰는 대체값이 여기 있다.
// 차트 손동작(휠·세로 스와이프는 페이지에 양보)은 lib/chartOptions.ts.
import { useMemo } from "react";
import { useResolvedTheme } from "../hooks/useTheme";
import type { Theme } from "./theme";

export interface ChartColors {
  up: string; // 상승 봉·거래량
  down: string; // 하락 봉·거래량
  text: string; // 축 글자
  grid: string; // 가로 격자
  crosshair: string; // 십자선
  entryLine: string; // 사는 가격 선
  targetLine: string; // 목표 가격 선
  stopLine: string; // 손절 가격 선
  accentLine: string; // 보조 선 (일봉의 20일 이동평균 — 경고 주황, 캔들의 빨강·파랑과 겹치지 않게)
  volUp: string; // 상승 거래량 막대 (반투명)
  volDown: string; // 하락 거래량 막대 (반투명)
}

type Token = "up" | "down" | "sub" | "mute-weak" | "fill" | "warn";

// 토큰을 읽지 못할 때(테스트 css:false, CSS가 아직 오지 않음) 쓰는 값. 라이트는 지금까지 차트에 쓰던 상수 그대로다
// (대문자 유지). 다크는 index.css의 다크 토큰과 같다.
const FALLBACK: Record<Theme, Record<Token, string>> = {
  light: {
    up: "#F04452",
    down: "#3182F6",
    sub: "#4E5968",
    "mute-weak": "#8B95A1",
    fill: "#F2F4F6",
    warn: "#FF9F00",
  },
  dark: {
    up: "#F25C68",
    down: "#458EF7",
    sub: "#B0B8C1",
    "mute-weak": "#6B7684",
    fill: "#23272F",
    warn: "#FF9F00",
  },
};

// 거래량 막대 불투명도 (다크 바탕에서는 조금 진하게)
const VOLUME_ALPHA: Record<Theme, number> = { light: 0.28, dark: 0.32 };

/** 색 문자열 → [r, g, b]. #rgb·#rgba·#rrggbb·#rrggbbaa(빌드가 값을 줄여 쓴다)와 rgb()/rgba()를 읽는다. 모르면 null. */
function rgbOf(color: string): [number, number, number] | null {
  const c = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(c);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((d) => d + d).join("") : hex[1];
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  const fn = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c);
  if (fn) return [Math.round(Number(fn[1])), Math.round(Number(fn[2])), Math.round(Number(fn[3]))];
  return null;
}

/** 같은 색의 반투명 판 (지금까지 쓰던 'rgba(240,68,82,0.28)' 모양). */
function withAlpha(color: string, fallback: string, a: number): string {
  const [r, g, b] = rgbOf(color) ?? rgbOf(fallback) ?? [0, 0, 0];
  return `rgba(${r},${g},${b},${a})`;
}

/** 지금 html에 칠한 테마가 theme이면 계산된 스타일을 돌려준다. 다른 테마를 물으면 null(대체값을 쓴다). */
function paintedStyle(theme: Theme): CSSStyleDeclaration | null {
  if (typeof document === "undefined" || typeof getComputedStyle !== "function") return null;
  const root = document.documentElement;
  const painted = root.getAttribute("data-theme") === "dark" ? "dark" : "light"; // 속성이 없으면 CSS는 라이트 값이다
  return painted === theme ? getComputedStyle(root) : null;
}

/** 테마의 차트 색. html의 --color-* 토큰을 읽고, 비어 있으면 대체값. */
export function chartColors(theme: Theme): ChartColors {
  const style = paintedStyle(theme);
  const t = (name: Token) => style?.getPropertyValue(`--color-${name}`).trim() || FALLBACK[theme][name];
  const up = t("up");
  const down = t("down");
  return {
    up,
    down,
    text: theme === "dark" ? t("sub") : t("mute-weak"), // 축은 장식 수준: 라이트는 옛 흐림 값, 다크는 보조 글자색
    grid: t("fill"),
    crosshair: t("mute-weak"),
    entryLine: t("sub"),
    targetLine: up,
    stopLine: down,
    accentLine: t("warn"),
    volUp: withAlpha(up, FALLBACK[theme].up, VOLUME_ALPHA[theme]),
    volDown: withAlpha(down, FALLBACK[theme].down, VOLUME_ALPHA[theme]),
  };
}

/** 지금 테마의 차트 색. 테마가 바뀌면 새 객체 → 차트는 layout effect에서 applyOptions로 색만 바꾼다(확대 상태 유지). */
export function useChartColors(): ChartColors {
  const theme = useResolvedTheme();
  return useMemo(() => chartColors(theme), [theme]);
}
