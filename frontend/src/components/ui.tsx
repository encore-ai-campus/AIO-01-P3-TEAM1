// 여러 화면이 같이 쓰는 작은 조각들.
import { type ReactNode, useState } from "react";
import { useNavigate } from "react-router";
import type { Currency, Verdict } from "../api/types";
import { cn } from "../lib/cn";
import { formatPrice, formatRate, formatSignedPrice, trendClass } from "../lib/format";
import { Icon } from "./Icon";

export function Card({ children, className, as: Tag = "section", ...rest }: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
  "aria-label"?: string;
  "aria-labelledby"?: string;
}) {
  return (
    <Tag className={cn("rounded-2xl bg-card p-5", className)} {...rest}>
      {children}
    </Tag>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={cn("animate-pulse rounded-lg bg-line/70", className)} />;
}

/** 카드 모양 스켈레톤 몇 줄. */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("space-y-3 rounded-2xl bg-card p-5", className)} aria-busy="true" aria-label="불러오는 중">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-2/3" />
      {Array.from({ length: Math.max(0, lines - 2) }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

/** 값이 바뀌면 잠깐 배경이 깜빡인다 (오르면 빨강, 내리면 파랑). */
export function Flash({ value, children, className }: { value: number | null | undefined; children: ReactNode; className?: string }) {
  const [seen, setSeen] = useState<{ value: number | null | undefined; dir: "up" | "down" | null; n: number }>({
    value,
    dir: null,
    n: 0,
  });
  if (value !== seen.value) {
    const dir = value != null && seen.value != null ? (value > seen.value ? "up" : "down") : null;
    setSeen({ value, dir, n: seen.n + 1 });
  }
  return (
    <span
      key={seen.n}
      className={cn(
        "-mx-1 rounded-md px-1",
        seen.dir === "up" && "animate-flash-up",
        seen.dir === "down" && "animate-flash-down",
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 현재가 + 등락 (부호·색). */
export function PriceChange({
  change,
  rate,
  currency,
  className,
}: {
  change?: number | null;
  rate: number | null | undefined;
  currency?: Currency;
  className?: string;
}) {
  return (
    <span className={cn("tabular-nums", trendClass(rate ?? change), className)}>
      {change !== undefined && change !== null ? `${formatSignedPrice(change, currency)} ` : ""}({formatRate(rate)})
    </span>
  );
}

export function RateText({ rate, className }: { rate: number | null | undefined; className?: string }) {
  return <span className={cn("tabular-nums", trendClass(rate), className)}>{formatRate(rate)}</span>;
}

export function Price({ value, currency, className }: { value: number | null | undefined; currency: Currency; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{formatPrice(value, currency)}</span>;
}

export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-[12px] font-bold",
        verdict === "BUY" ? "bg-up-soft text-up" : "bg-fill text-mute",
        className,
      )}
    >
      {verdict}
    </span>
  );
}

export function Notice({ tone = "info", children, className }: { tone?: "info" | "warn" | "error"; children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl px-3.5 py-3 text-[14px] leading-snug",
        tone === "info" && "bg-brand-soft text-brand-dark",
        tone === "warn" && "bg-warn-soft text-[#9a5b00]",
        tone === "error" && "bg-up-soft text-up",
        className,
      )}
    >
      {tone !== "info" && <Icon name="alert" className="mt-0.5 size-4 shrink-0" />}
      <div>{children}</div>
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="py-10 text-center text-[15px] text-mute">{children}</p>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="text-[15px] text-sub">{message}</p>
      {onRetry && (
        <button type="button" onClick={onRetry} className="h-11 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line">
          다시 시도
        </button>
      )}
    </div>
  );
}

/** 화면 제목. 모바일은 상단에 붙고, back이면 뒤로 가기 버튼을 둔다. */
export function PageHeader({ title, back, right }: { title: ReactNode; back?: boolean; right?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="sticky top-0 z-30 -mx-4 mb-2 flex h-14 items-center gap-1 bg-bg/90 px-2 backdrop-blur lg:static lg:mx-0 lg:mb-4 lg:h-auto lg:bg-transparent lg:px-0 lg:backdrop-blur-none">
      {back && (
        <button
          type="button"
          aria-label="뒤로 가기"
          onClick={() => (window.history.length > 1 ? navigate(-1) : navigate("/"))}
          className="grid size-11 place-items-center rounded-full text-ink hover:bg-line/60"
        >
          <Icon name="back" />
        </button>
      )}
      <h1 className={cn("min-w-0 flex-1 truncate text-[20px] font-bold lg:text-[26px]", !back && "px-2 lg:px-0")}>{title}</h1>
      {right}
    </header>
  );
}

/** 이름 · 값 한 줄. */
export function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex items-center justify-between gap-3 py-1.5 text-[15px]", className)}>
      <dt className="shrink-0 text-sub">{label}</dt>
      <dd className="min-w-0 text-right font-medium tabular-nums text-ink">{children}</dd>
    </div>
  );
}

/** 탭·필터용 버튼 묶음. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex rounded-xl bg-fill p-1", className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "h-9 min-w-[64px] flex-1 rounded-lg px-3 text-[14px] font-semibold transition-colors",
            value === o.value ? "bg-card text-ink shadow-sm" : "text-mute hover:text-sub",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent", className)}
    />
  );
}
