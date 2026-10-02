import { createContext, useContext } from "react";

export type ToastTone = "info" | "error";
export type ShowToast = (message: string, tone?: ToastTone) => void;

export const ToastContext = createContext<ShowToast>(() => {});

/** 화면 아래에 잠깐 뜨는 한 줄 알림. */
export function useToast(): ShowToast {
  return useContext(ToastContext);
}
