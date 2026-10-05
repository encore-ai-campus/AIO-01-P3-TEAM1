// 토스트: 방금 한 동작의 결과를 잠깐 알린다. 어떤 층(시트·대화상자)보다 위에 뜬다 (z --z-toast).
// - body 포털 + data-inert-exempt: 대화상자가 바깥을 inert로 잠가도 화면 읽기 프로그램이 결과를 읽는다. role=status는 이 상자 하나다 (테스트가 하나만 찾는다).
// - 자리는 index.css .toast-region: 모바일은 하단 탭·주문 바 바로 위(html[data-shell] — Layout이 단다), PC는 본문 열 가운데, 시트가 열려 있으면 화면 위쪽.
// - 모양: 불투명 반전 표면(bg-ink + text-on-ink — 다크에서는 밝은 표면 + 어두운 글자). 톤은 아이콘으로 나눈다 (오류도 같은 표면이라 글자 대비가 AA를 넘는다).
// - 들어올 때 올라오고(toast-in) 나갈 때 내려가며 사라진다(toast-out). 애니메이션을 못 하는 환경(jsdom)·움직임 줄이기면 바로 지운다.
import { type ReactNode, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CAN_ANIMATE, prefersReducedMotion } from "../lib/motion";
import { Icon } from "./Icon";
import { TOAST_MAX, ToastContext, type ShowToast, type ToastAction, type ToastTone, toastDuration } from "./toast";

interface Item {
  id: number;
  message: string;
  tone: ToastTone;
  action?: ToastAction;
  /** 나가는 애니메이션 중 (끝나면 지운다) */
  leaving?: boolean;
}

let seq = 0;
/** 나가는 애니메이션(160ms)의 끝(animationend)이 오지 않아도 이 시간 뒤에는 지운다. */
const LEAVE_SAFETY_MS = 400;

// 다른 탭을 보는 동안은 시간을 세지 않는다 (돌아왔을 때 결과를 못 보고 지나치지 않게)
function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}
const pageHidden = () => document.visibilityState === "hidden";
const serverHidden = () => false;

const canAnimate = () => CAN_ANIMATE && !prefersReducedMotion();

function ToastView({
  item,
  hidden,
  onDismiss,
  onGone,
}: {
  item: Item;
  hidden: boolean;
  onDismiss: (id: number) => void;
  onGone: (id: number) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const remaining = useRef(toastDuration(item.message, Boolean(item.action)));
  const paused = hovered || focused || hidden;

  // 남은 시간만큼 기다렸다 닫는다. 멈추면(마우스·포커스·다른 탭) 남은 시간을 줄여 두고, 다시 시작하면 그만큼만 기다린다
  useEffect(() => {
    if (paused || item.leaving) return;
    const budget = remaining.current;
    const started = performance.now();
    const timer = window.setTimeout(() => onDismiss(item.id), budget);
    return () => {
      window.clearTimeout(timer);
      remaining.current = Math.max(0, budget - (performance.now() - started));
    };
  }, [paused, item.leaving, item.id, onDismiss]);

  // 나가는 중: animationend가 오지 않아도(탭 숨김 등) 지운다
  useEffect(() => {
    if (!item.leaving) return;
    const timer = window.setTimeout(() => onGone(item.id), LEAVE_SAFETY_MS);
    return () => window.clearTimeout(timer);
  }, [item.leaving, item.id, onGone]);

  return (
    <div
      data-leaving={item.leaving || undefined}
      onAnimationEnd={(e) => {
        if (item.leaving && e.target === e.currentTarget) onGone(item.id);
      }}
      // 눌러서 닫기 (동작 없는 알림이라 버튼이 아니다. 키보드·화면 읽기는 시간이 지나면 저절로 닫힌다)
      onClick={() => onDismiss(item.id)}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      className="toast pointer-events-auto flex max-w-[min(92vw,420px)] items-center gap-2.5 rounded-2xl bg-ink px-4 py-3 text-[15px] leading-snug font-medium text-on-ink shadow-lg"
    >
      {item.tone === "success" && <Icon name="check-circle" className="size-5 shrink-0 text-ok-inverse" />}
      {item.tone === "error" && <Icon name="alert-circle" className="size-5 shrink-0 text-up-inverse" />}
      <span className="min-w-0">{item.message}</span>
      {item.action && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            item.action?.onClick();
            onDismiss(item.id);
          }}
          className="press -my-1.5 -mr-1.5 ml-1 h-9 shrink-0 rounded-lg px-2.5 text-[14px] font-bold text-on-ink underline underline-offset-4 hover:bg-on-ink/10"
        >
          {item.action.label}
        </button>
      )}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const hidden = useSyncExternalStore(subscribeVisibility, pageHidden, serverHidden);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const dismiss = useCallback(
    (id: number) => {
      if (!canAnimate()) return remove(id);
      setItems((xs) => xs.map((x) => (x.id === id && !x.leaving ? { ...x, leaving: true } : x)));
    },
    [remove],
  );
  const show = useCallback<ShowToast>((message, tone = "info", opts) => {
    const item: Item = { id: ++seq, message, tone, action: opts?.action };
    const animate = canAnimate();
    setItems((xs) => {
      // 최대 개수를 넘으면 가장 오래된 것부터 내보낸다 (나가는 중인 것은 세지 않는다)
      const staying = xs.filter((x) => !x.leaving);
      const drop = new Set(staying.slice(0, Math.max(0, staying.length - (TOAST_MAX - 1))).map((x) => x.id));
      const kept = xs.flatMap((x) => (!drop.has(x.id) ? [x] : animate ? [{ ...x, leaving: true }] : []));
      return [...kept, item];
    });
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {createPortal(
        <div role="status" aria-live="polite" data-inert-exempt="" className="toast-region">
          {items.map((item) => (
            <ToastView key={item.id} item={item} hidden={hidden} onDismiss={dismiss} onGone={remove} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
