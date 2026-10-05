// 마이의 화면 모드 카드: 기기 설정 · 밝게 · 어둡게. 계정이 아니라 이 기기(브라우저)에 저장한다 (lib/theme.ts).
// 자리: 알림 설정 다음, 계정 앞 — 드물게 바꾸는 표시 설정이라 다른 설정(알림 설정)과 이어 두되, 서버에 저장되는 계정 설정과는 카드를 나눈다.
// 고르면 저장 버튼 없이 바로 바뀐다 (누른 곳에서 원이 퍼지며 — 움직임 줄이기면 바로).
import { useTheme } from "../../hooks/useTheme";
import { type ThemePref, themeOrigin } from "../../lib/theme";
import { Icon } from "../Icon";
import { Card, Segmented } from "../ui";

const OPTIONS: { value: ThemePref; label: string }[] = [
  { value: "system", label: "기기 설정" },
  { value: "light", label: "밝게" },
  { value: "dark", label: "어둡게" },
];

export function ThemeCard() {
  const { pref, theme, setPref } = useTheme();
  return (
    <Card aria-labelledby="theme-title">
      <h2 id="theme-title" className="flex items-center gap-1.5 text-[17px] font-bold">
        <Icon name={theme === "dark" ? "moon" : "sun"} className="size-5 text-mute-weak" />
        화면 모드
      </h2>
      <Segmented
        label="화면 모드"
        size="lg"
        className="mt-3 flex w-full"
        value={pref}
        options={OPTIONS}
        onChange={(v, e) => setPref(v, e && themeOrigin(e))}
      />
      <p className="mt-2 text-[13px] leading-relaxed text-sub">
        기기 설정은 휴대폰·PC의 화면 설정을 따라가요{pref === "system" ? ` (지금은 ${theme === "dark" ? "어둡게" : "밝게"})` : ""}. 이 기기에만 저장돼요.
      </p>
    </Card>
  );
}
