// 마이의 주린이모드 바꾸기: 스위치와 진단 결과의 "추천대로"가 같이 쓴다. 결과를 토스트로 알리고, 실패하면 되돌린다(api/profile.ts).
import { useCallback } from "react";
import { errorMessage } from "../../api/client";
import { useSetBeginnerMode } from "../../api/profile";
import { useToast } from "../toast";

export function useApplyBeginnerMode() {
  const toast = useToast();
  const set = useSetBeginnerMode();
  const { mutate } = set;
  const apply = useCallback(
    (on: boolean) =>
      mutate(on, {
        onSuccess: (p) =>
          toast(p.beginnerMode ? "주린이모드를 켰어요. 쉬운 말로 보여요." : "주린이모드를 껐어요. 원래 용어와 숫자로 보여요.", "success"),
        onError: (err) => toast(errorMessage(err), "error"),
      }),
    [mutate, toast],
  );
  return { apply, isPending: set.isPending };
}
