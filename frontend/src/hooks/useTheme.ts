// 화면 모드를 React에서 읽고 바꾼다 (저장·전환은 lib/theme.ts).
import { useSyncExternalStore } from "react";
import { getThemeSnapshot, setThemePref, subscribeTheme, type Theme, type ThemePref } from "../lib/theme";

/** pref: 고른 값(기기 설정·라이트·다크), theme: 실제로 칠한 테마. setPref(pref, origin?)의 origin은 원형 전환의 시작점(themeOrigin). */
export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (pref: ThemePref, origin?: { x: number; y: number }) => void } {
  const { pref, theme } = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot);
  return { pref, theme, setPref: setThemePref };
}

const resolved = () => getThemeSnapshot().theme;
const serverTheme = (): Theme => "light";

/** 실제 테마만 (차트 색처럼 라이트·다크만 알면 되는 곳). */
export function useResolvedTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, resolved, serverTheme);
}
