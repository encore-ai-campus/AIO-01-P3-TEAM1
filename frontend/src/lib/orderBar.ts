// 종목 상세(전문가 보기) 모바일 하단 구매 바가 지금 그려져 있는지. 바가 있는 동안 Layout이 하단 탭을 내려 숨기고
// 토스트·연결 띠 자리를 바 위로 옮긴다 (html[data-shell="order"]).
// 주소가 아니라 실제로 그린 바를 따른다: 없는 종목(404)·오류 화면처럼 바를 그리지 않으면 탭이 그대로 남는다
// (주소만 보고 숨기면 탭도 바도 없어 갈 곳이 머리의 '뒤로'뿐이었다).
import { useLayoutEffect, useSyncExternalStore } from "react";

let count = 0; // 그려진 바의 수 (화면이 바뀌는 커밋에서 옛 바가 빠지고 새 바가 들어와도 맞게 센다)
const listeners = new Set<() => void>();

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

const shown = () => count > 0;
const serverShown = () => false;

/** Layout: 하단 구매 바가 그려져 있는지 (있으면 하단 탭을 숨긴다). */
export function useOrderBarShown(): boolean {
  return useSyncExternalStore(subscribe, shown, serverShown);
}

/**
 * 하단 구매 바를 그리는 컴포넌트가 부른다: 마운트된 동안 '바 있음'.
 * 그리기(페인트) 전에 알려 탭과 바가 한 프레임이라도 겹쳐 보이지 않게 layout effect로 등록한다.
 */
export function useOrderBarPresence(): void {
  useLayoutEffect(() => {
    count += 1;
    emit();
    return () => {
      count -= 1;
      emit();
    };
  }, []);
}
