import { type ReactNode, useCallback, useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { ToastContext, type ToastTone } from "./toast";

interface Item {
  id: number;
  message: string;
  tone: ToastTone;
}

let seq = 0;

function ToastView({ item, onDone }: { item: Item; onDone: (id: number) => void }) {
  useEffect(() => {
    const t = setTimeout(() => onDone(item.id), 3500);
    return () => clearTimeout(t);
  }, [item.id, onDone]);
  return (
    <div
      className={cn(
        "pointer-events-auto max-w-[min(92vw,420px)] animate-toast-in rounded-2xl px-4 py-3 text-[15px] font-medium text-white shadow-lg",
        item.tone === "error" ? "bg-up" : "bg-ink/90",
      )}
    >
      {item.message}
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const show = useCallback((message: string, tone: ToastTone = "info") => {
    setItems((xs) => [...xs.slice(-2), { id: ++seq, message, tone }]);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-[60] flex flex-col items-center gap-2 px-4 lg:bottom-8"
      >
        {items.map((item) => (
          <ToastView key={item.id} item={item} onDone={remove} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}
