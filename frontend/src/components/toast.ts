import { createContext, useContext } from "react";

/** info: 기본(아이콘 없음) · success: 저장·시작·취소 완료(초록 체크) · error: 실패(빨간 느낌표). 바탕은 셋 다 같은 반전 표면이다. */
export type ToastTone = "info" | "success" | "error";
/** 토스트 안의 동작 버튼 (예: 되돌리기). 누르면 동작하고 토스트를 닫는다. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}
export type ShowToast = (message: string, tone?: ToastTone, opts?: { action?: ToastAction }) => void;

export const ToastContext = createContext<ShowToast>(() => {});

/** 한 번에 보이는 최대 개수. 넘치면 가장 오래된 것부터 내보낸다. */
export const TOAST_MAX = 3;

/**
 * 보이는 시간(ms): 3초 + 글자당 50ms, 최대 6초 (긴 예약 안내도 다 읽을 수 있게). 동작 버튼이 있으면 6초.
 * 마우스를 올리거나 포커스가 안에 있거나 다른 탭을 보는 동안은 멈춘다 (ToastProvider).
 */
export function toastDuration(message: string, hasAction = false): number {
  if (hasAction) return 6000;
  return Math.min(6000, 3000 + 50 * [...message].length);
}

/** 화면 아래(시트가 열려 있으면 위)에 잠깐 뜨는 한 줄 알림. 호출: toast(message, tone?) */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}
