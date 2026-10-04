// 숨은 관리자 입구: 같은 메뉴를 짧은 간격으로 여러 번 연속 누르면 관리자 화면(/ops)으로 간다 (Layout의 "리포트" 메뉴).
// 보안 장치가 아니다 (관리자 화면은 따로 isStaff를 확인한다). 사용자 메뉴에 운영용 화면을 드러내지 않으려는 입구일 뿐이다.
import { useCallback, useRef } from "react";

export const SECRET_TAPS = 8; // 연속으로 누를 횟수
export const SECRET_GAP_MS = 1000; // 누름 사이 최대 간격. 넘으면 처음부터 다시 센다
export const ADMIN_PATH = "/ops";

/** 지금까지의 누른 시각 taps에 now를 더한 결과. count번을 채우면 unlocked이고 기록을 비운다. */
export function nextTaps(taps: readonly number[], now: number, count = SECRET_TAPS, gapMs = SECRET_GAP_MS) {
  const last = taps[taps.length - 1];
  const kept = last !== undefined && now - last <= gapMs ? [...taps, now] : [now];
  return kept.length >= count ? { taps: [] as number[], unlocked: true } : { taps: kept, unlocked: false };
}

/** 누를 때마다 부르는 함수를 돌려준다. 이번 누름으로 count번 연속이 채워지면 true. */
export function useSecretTaps(count = SECRET_TAPS, gapMs = SECRET_GAP_MS) {
  const taps = useRef<number[]>([]);
  return useCallback(() => {
    const next = nextTaps(taps.current, Date.now(), count, gapMs);
    taps.current = next.taps;
    return next.unlocked;
  }, [count, gapMs]);
}
