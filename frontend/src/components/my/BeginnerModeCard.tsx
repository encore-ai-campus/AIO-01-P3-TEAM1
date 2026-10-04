// 마이 맨 위: 주린이모드 스위치 (계정에 저장 — 기기를 바꿔도 같고 웹 알림 문장도 이 모드를 따른다).
// 켜기는 바로, 끄기는 한 줄 확인("어려운 용어·숫자가 그대로 나와요") 뒤에 한다.
import { useState } from "react";
import { useBeginnerMode } from "../../hooks/useBeginnerMode";
import { Card } from "../ui";
import { ConfirmOff } from "./ConfirmOff";
import { useApplyBeginnerMode } from "./useApplyBeginnerMode";

export function BeginnerModeCard() {
  const { beginnerMode } = useBeginnerMode();
  const { apply, isPending } = useApplyBeginnerMode();
  const [confirming, setConfirming] = useState(false);
  return (
    <Card aria-labelledby="beginner-title" className="space-y-3">
      <label className="flex min-h-11 cursor-pointer items-center justify-between gap-3">
        <span className="min-w-0">
          <span id="beginner-title" className="block text-[17px] font-bold">
            주린이모드
          </span>
          <span className="mt-0.5 block text-[13px] leading-snug text-mute">
            {beginnerMode ? "켬 · 쉬운 말과 꼭 필요한 숫자만 보여요" : "끔 · 원래 용어와 숫자를 그대로 보여요"}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          checked={beginnerMode}
          disabled={isPending}
          onChange={(e) => {
            if (e.target.checked) {
              setConfirming(false);
              apply(true);
            } else {
              setConfirming(true);
            }
          }}
          className="size-6 shrink-0 cursor-pointer accent-brand"
        />
      </label>
      {confirming && beginnerMode && (
        <ConfirmOff
          busy={isPending}
          onConfirm={() => {
            setConfirming(false);
            apply(false);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
      <p className="text-[13px] leading-relaxed text-sub">
        켜면 리포트·모의투자·알림을 쉬운 말로 보여요. 리포트 화면의 &lsquo;이 화면만 자세히 보기&rsquo;는 이 설정을 바꾸지 않아요.
      </p>
    </Card>
  );
}
