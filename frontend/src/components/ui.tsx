// 여러 화면이 같이 쓰는 작은 조각들. 영역 작업자는 고치지 않는다 (필요하면 기반에 요청).
// 움직임은 index.css 토큰(press·skeleton·seg·page-header)을 쓴다. 테스트(jsdom)에서는 움직임 없이 같은 렌더에서 끝난다.
import {
  type AnimationEvent,
  type ChangeEvent,
  isValidElement,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { Link, useLocation, useNavigate, useNavigationType } from "react-router";
import type { Currency, Market, QuoteBasis, Verdict } from "../api/types";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSlidingIndicator } from "../hooks/useSlidingIndicator";
import { cn } from "../lib/cn";
import { formatPrice, formatQuoteAsOf, formatRate, formatSignedPrice, trendClass } from "../lib/format";
import { parentPath } from "../lib/nav";
import { NotificationBell } from "./autotrade/NotificationBell";
import { BrandLockup } from "./brand/BrandMark";
import { Icon, type IconName } from "./Icon";

export function Card({
  children,
  className,
  as: Tag = "section",
  ...rest
}: {
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

/** className에 변형 없는 rounded 유틸(rounded-full, rounded-2xl, rounded-t-xl, rounded-full! …)이 있는가. lg:rounded-xl 같은 변형은 빼고 본다. */
const OWN_RADIUS = /(?:^|\s)!?rounded(?:[-!]|\s|$)/;

/**
 * 불러오는 동안의 자리. 120ms 늦게 보이고(빠른 응답에서 번쩍이지 않게) 은은하게 깜빡인다 (index.css .skeleton, 시머 없음).
 * 모서리 기본값은 rounded-lg. className이 모서리를 정하면 기본값을 뺀다 — cn은 병합하지 않고, Tailwind 순서상 rounded-lg가
 * rounded-full·rounded-2xl보다 뒤라 이겨서 원·알약 자리가 둥근 네모로 보였다. lg:rounded-xl 같은 변형은 기본값 위에 얹힌다.
 */
export function Skeleton({ className }: { className?: string }) {
  const ownRadius = className !== undefined && OWN_RADIUS.test(className);
  return <div aria-hidden="true" className={cn("skeleton bg-line/70", !ownRadius && "rounded-lg", className)} />;
}

/** 카드 모양 스켈레톤 몇 줄. role=status는 쓰지 않는다 (토스트가 쓴다 — 테스트가 하나만 찾는다). */
export function SkeletonCard({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div role="group" className={cn("space-y-3 rounded-2xl bg-card p-5", className)} aria-busy="true" aria-label="불러오는 중">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-8 w-2/3" />
      {Array.from({ length: Math.max(0, lines - 2) }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
    </div>
  );
}

/**
 * Flash의 색. trend: 오르면 빨강·내리면 파랑 (시세·평가처럼 방향이 뜻인 값) · ok: 초록 (좋은 일이 늘었을 때만 — 자동 복구 수.
 * 줄면 깜빡이지 않는다: 예시 재생을 끄고 실제 Trace로 돌아가 수가 줄 때 초록으로 알리면 복구가 일어난 것처럼 읽힌다) ·
 * neutral: 회색 (내 입력으로 바뀐 금액처럼 방향에 뜻이 없는 '바뀜' — 줄었다고 파랑으로 깜빡이면 가격 하락처럼 읽힌다).
 */
export type FlashTone = "trend" | "ok" | "neutral";

const FLASH = {
  up: "animate-flash-up",
  down: "animate-flash-down",
  ok: "animate-flash-ok",
  neutral: "animate-flash-neutral",
} as const;

/**
 * 값이 바뀌면 잠깐 배경이 깜빡인다 (0.8초에 걸쳐 사라짐). 색은 index.css 토큰(--color-flash-*), 고르는 법은 tone.
 * 처음 그릴 때와 값을 처음 받은 때(빈 값 → 값)는 깜빡이지 않는다 — 바뀐 것이 아니라 도착한 것이다.
 */
export function Flash({
  value,
  children,
  className,
  tone = "trend",
}: {
  value: number | null | undefined;
  children: ReactNode;
  className?: string;
  tone?: FlashTone;
}) {
  const [seen, setSeen] = useState<{ value: number | null | undefined; dir: "up" | "down" | null; n: number }>({
    value,
    dir: null,
    n: 0,
  });
  if (value !== seen.value) {
    const dir = value != null && seen.value != null ? (value > seen.value ? "up" : "down") : null;
    setSeen({ value, dir, n: seen.n + 1 });
  }
  const flash =
    seen.dir === null || (tone === "ok" && seen.dir === "down") ? undefined : FLASH[tone === "trend" ? seen.dir : tone];
  // 깜빡임이 끝나면 클래스를 지운다 (다시 마운트하지 않고). 남겨 두면 목록 순서가 바뀌어 줄이 옮겨질 때(insertBefore)
  // 애니메이션이 처음부터 다시 돌아, 바뀌지 않은 값이 또 깜빡인다 (랭킹 추월 등)
  const n = seen.n;
  const settle = (e: AnimationEvent<HTMLSpanElement>) => {
    if (e.target === e.currentTarget && e.animationName.startsWith("flash-")) setSeen((s) => (s.n === n && s.dir !== null ? { ...s, dir: null } : s));
  };
  return (
    <span key={n} className={cn("-mx-1 rounded-md px-1", flash, className)} onAnimationEnd={flash ? settle : undefined}>
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

/**
 * 가격 기준 표시. basis가 "live"(실시간 시세)면 "실시간 · 15:20:31"(받은 시각, 한국 시간),
 * 아니면(기본 "close") "10월 2일(금) 15:30 장마감 기준" (미국은 "16:00(뉴욕)"). 가격·평가 옆에 붙인다.
 * at은 Quote.asOf·StockDetail.asOf·AccountSummary.pricesAsOf[market] 같은 기준 시각. 없으면 아무것도 그리지 않는다.
 * Quote를 보이는 곳은 quote.basis를 넘긴다. 계좌 평가·랭킹·미리 보기처럼 장마감 기준인 곳은 basis를 넘기지 않는다.
 */
export function AsOf({
  at,
  market = "KR",
  basis = "close",
  className,
}: {
  at: string | null | undefined;
  market?: Market;
  basis?: QuoteBasis;
  className?: string;
}) {
  if (!at) return null;
  return (
    <time dateTime={at} className={cn("text-[12px] font-medium text-mute tabular-nums", className)}>
      {formatQuoteAsOf(at, market, basis)}
    </time>
  );
}

export function RateText({ rate, className }: { rate: number | null | undefined; className?: string }) {
  return <span className={cn("tabular-nums", trendClass(rate), className)}>{formatRate(rate)}</span>;
}

export function Price({ value, currency, className }: { value: number | null | undefined; currency: Currency; className?: string }) {
  return <span className={cn("tabular-nums", className)}>{formatPrice(value, currency)}</span>;
}

/**
 * AI 판정 배지 (BUY·PASS). AI 의견에는 시장 상승색(빨강)을 쓰지 않는다 — 빨강은 가격이 오른 사실의 색이다 (OpinionBadge와 같은 원칙).
 * BUY는 브랜드 연파랑, PASS는 회색. 뜻은 글자가 말한다.
 */
export function VerdictBadge({ verdict, className }: { verdict: Verdict; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center rounded-md px-2 text-[12px] font-bold",
        verdict === "BUY" ? "bg-brand-soft text-brand-ink" : "bg-fill text-sub",
        className,
      )}
    >
      {verdict}
    </span>
  );
}

export function Notice({
  tone = "info",
  children,
  className,
}: {
  tone?: "info" | "warn" | "error";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-xl px-3.5 py-3 text-[14px] leading-snug",
        tone === "info" && "bg-brand-soft text-brand-ink",
        tone === "warn" && "bg-warn-soft text-warn-ink",
        tone === "error" && "bg-up-soft text-up-ink",
        className,
      )}
    >
      {tone !== "info" && <Icon name="alert" className="mt-0.5 size-4 shrink-0" />}
      <div>{children}</div>
    </div>
  );
}

/** 빈 상태·404의 다음 행동: 주소로 가는 링크 또는 버튼. */
export type StateAction = { label: string; to: string } | { label: string; onClick: () => void };

function ActionButton({ action, primary, compact }: { action: StateAction; primary: boolean; compact: boolean }) {
  const className = cn(
    "press inline-flex items-center justify-center rounded-xl px-5 font-semibold",
    compact ? "h-11 text-[14px]" : "h-12 text-[15px]",
    primary ? "bg-brand text-white hover:bg-brand-dark" : "bg-fill text-sub hover:bg-line",
  );
  return "to" in action ? (
    <Link to={action.to} className={className}>
      {action.label}
    </Link>
  ) : (
    <button type="button" onClick={action.onClick} className={className}>
      {action.label}
    </button>
  );
}

/**
 * 빈 상태. children만 주면 지금처럼 가운데 한 줄 문장이다.
 * icon·title·action을 주면 [아이콘 원 → 제목 → 설명 → 다음 행동 버튼] 순서로, 빈 화면이 '다음에 할 일'을 바로 준다.
 * secondary는 보조 행동(예: 404의 '리포트 보기'). compact는 카드 안 좁은 자리용(여백·버튼을 줄인다).
 */
export function EmptyState({
  children,
  icon,
  title,
  action,
  secondary,
  compact = false,
  className,
}: {
  children?: ReactNode;
  icon?: IconName;
  title?: ReactNode;
  action?: StateAction;
  secondary?: StateAction;
  compact?: boolean;
  className?: string;
}) {
  if (!icon && !title && !action && !secondary) {
    return <p className={cn("text-center text-[15px] text-mute", compact ? "py-6" : "py-10", className)}>{children}</p>;
  }
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "py-6" : "py-10", className)}>
      {icon && (
        <span
          aria-hidden="true"
          className={cn("mb-4 grid place-items-center rounded-full bg-fill text-mute-weak", compact ? "size-10" : "size-12")}
        >
          <Icon name={icon} className={compact ? "size-5" : "size-6"} />
        </span>
      )}
      {title ? <p className={cn("font-bold text-ink", compact ? "text-[15px]" : "text-[17px]")}>{title}</p> : null}
      {children ? <div className={cn("text-[14px] leading-relaxed text-sub", title ? "mt-1.5" : undefined)}>{children}</div> : null}
      {(action || secondary) && (
        <div
          className={cn(
            "flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:justify-center",
            compact ? "mt-4" : "mt-6 max-w-[320px] sm:max-w-none",
          )}
        >
          {action && <ActionButton action={action} primary compact={compact} />}
          {secondary && <ActionButton action={secondary} primary={false} compact={compact} />}
        </div>
      )}
    </div>
  );
}

/**
 * 불러오기 오류 + '다시 시도'. role=alert와 버튼 이름 '다시 시도'는 그대로 둔다 (테스트 계약).
 * retrying(예: q.isFetching)이면 버튼에 스피너를 보이고 다시 누를 수 없다 (포커스는 버튼에 남는다 — disabled 대신 aria-disabled).
 * compact: 카드 안 한 줄 (문장 + 오른쪽 버튼).
 */
export function ErrorState({
  message,
  onRetry,
  retrying = false,
  compact = false,
}: {
  message: string;
  onRetry?: () => void;
  retrying?: boolean;
  compact?: boolean;
}) {
  const retry = onRetry && (
    <button
      type="button"
      onClick={() => {
        if (!retrying) onRetry();
      }}
      aria-disabled={retrying || undefined}
      aria-busy={retrying || undefined}
      className={cn(
        "press inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-fill px-4 text-[14px] font-semibold text-sub hover:bg-line",
        retrying && "cursor-progress",
      )}
    >
      {retrying && <Spinner />}
      다시 시도
    </button>
  );
  if (compact) {
    return (
      <div role="alert" className="flex items-center justify-between gap-3">
        <p className="flex min-w-0 items-start gap-2 text-[14px] leading-snug text-sub">
          <Icon name="alert" className="mt-0.5 size-4 shrink-0 text-warn" />
          {message}
        </p>
        {retry}
      </div>
    );
  }
  return (
    <div role="alert" className="flex flex-col items-center gap-3 py-10 text-center">
      <Icon name="alert" className="size-7 text-warn" />
      <p className="text-[15px] text-sub">{message}</p>
      {retry}
    </div>
  );
}

/**
 * 화면 제목. 모바일은 위에 붙고(불투명 바탕, 스크롤하면 아래 구분선 — index.css .page-header), PC는 본문 위 큰 제목.
 * - back: 앱 안의 이전 화면으로. 이전 화면이 없으면(링크로 바로 연 경우) 문자열이면 그 주소, true면 탭 묶음의 첫 화면(없으면 홈).
 * - 브라우저 탭 제목을 '<제목> · 모매매'(서비스 이름 SERVICE_NAME)로 (title이 글자가 아니면 docTitle).
 * - 화면을 옮긴 뒤(뒤로 가기 제외) 포커스가 갈 곳을 잃었으면(body·화면 밖 메뉴) 제목으로 옮긴다 — 화면 읽기 프로그램이 새 화면을 알린다.
 *   화면이 스스로 준 포커스(검색 칸 autoFocus 등)는 빼앗지 않는다.
 * - 뼈대 제목(title={<Skeleton …/>}, 데이터를 기다리는 동안): 화면 읽기에는 docTitle을 읽힌다(이름 없는 '제목 1'이 되지 않게).
 *   진짜 제목이 오면 h1을 새로 그린다 — 같은 h1의 글자만 바뀌면 포커스 이벤트가 없어 새 제목이 알려지지 않는다.
 *   포커스가 그 h1에 있었으면(옛 h1이 빠져 갈 곳을 잃음) 새 h1로 다시 준다.
 * - brand: 모바일에서 제목 대신 [로고 28px + 서비스 이름 18px]을 보인다 (홈 — 아래 탭이 이미 '홈'이라). h1은 화면 읽기용으로 남는다.
 * - 모바일은 오른쪽에 알림 종 (PC는 왼쪽 메뉴). bell={false}면 숨긴다.
 */
export function PageHeader({
  title,
  back,
  right,
  brand = false,
  docTitle,
  bell = true,
}: {
  title: ReactNode;
  back?: boolean | string;
  right?: ReactNode;
  brand?: boolean;
  docTitle?: string;
  bell?: boolean;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const navType = useNavigationType();
  const [arrivedBy] = useState(navType); // 이 화면에 어떻게 왔는지 (마운트할 때 한 번)
  const heading = useRef<HTMLHeadingElement>(null);
  useDocumentTitle(docTitle ?? (typeof title === "string" ? title : null));
  // 뼈대 제목: 상세 화면들은 뼈대와 본문의 머리를 같은 자리에 그려 React가 같은 PageHeader를 다시 쓴다 → h1의 key로 새로 그린다
  const placeholder = isValidElement(title) && title.type === Skeleton;

  // 처음 마운트될 때, 그리고 뼈대 ↔ 진짜 제목으로 h1이 새로 그려질 때 (포커스된 옛 h1이 빠지면 갈 곳을 잃는다)
  useEffect(() => {
    const h = heading.current;
    if (arrivedBy === "POP" || !h || document.documentElement.hasAttribute("data-scroll-lock")) return;
    const active = document.activeElement;
    const main = h.closest("main");
    // main 자체(tabIndex -1)의 포커스도 갈 곳을 잃은 것으로 본다: 빈 곳을 누르거나 Safari처럼 링크를 눌러도 포커스를 주지 않는 브라우저에서 main에 남는다
    const lost = !active || active === document.body || active === main || (main !== null && !main.contains(active));
    if (lost) h.focus({ preventScroll: true });
  }, [arrivedBy, placeholder]);

  const goBack = () => {
    // BrowserRouter는 history.state.idx(이 앱 안에서 몇 번째 기록인지)를 늘 채운다. replace 이동에도 그대로라 key보다 정확하다.
    // 테스트(MemoryRouter)는 window.history를 쓰지 않으므로 key로 판단한다 (처음 항목은 'default').
    const idx = (window.history.state as { idx?: unknown } | null)?.idx;
    const inApp = typeof idx === "number" ? idx > 0 : location.key !== "default";
    if (inApp) navigate(-1);
    else navigate(typeof back === "string" ? back : parentPath(location.pathname), { replace: true });
  };

  return (
    <header className="page-header sticky top-0 z-(--z-header) -mx-4 mb-2 flex h-14 items-center gap-1 bg-bg px-2 lg:static lg:mx-0 lg:mb-4 lg:h-auto lg:bg-transparent lg:px-0">
      {back && (
        <button
          type="button"
          aria-label="뒤로 가기"
          onClick={goBack}
          className="grid size-11 shrink-0 place-items-center rounded-full text-ink transition-colors hover:bg-line/60 active:bg-line/60"
        >
          <Icon name="back" />
        </button>
      )}
      {brand && <BrandLockup size={28} className="min-w-0 flex-1 px-2 text-[18px] text-ink lg:hidden" />}
      <h1
        key={placeholder ? "placeholder" : "title"}
        ref={heading}
        tabIndex={-1}
        className={cn(
          "min-w-0 flex-1 truncate text-[20px] font-bold outline-none lg:text-[26px]",
          !back && "px-2 lg:px-0",
          brand && "max-lg:sr-only",
        )}
      >
        {/* 뼈대(aria-hidden)뿐이면 이름이 비므로 화면 이름(docTitle)을 화면 읽기에만 */}
        {placeholder && docTitle ? <span className="sr-only">{docTitle}</span> : null}
        {title}
      </h1>
      {right}
      {bell && <NotificationBell className="lg:hidden" />}
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

/**
 * 탭·필터용 버튼 묶음. 같은 선택 표시가 옆으로 미끄러진다 (hooks/useSlidingIndicator, index.css .seg).
 * 측정할 수 없을 때(숨은 시트 안·jsdom)는 선택 버튼이 직접 배경을 그린다. aria-pressed가 선택 상태다.
 * onChange(v, e): e는 누른 버튼의 클릭 (화면 모드의 원형 전환 시작점 — lib/theme.ts themeOrigin).
 * size: md(h-10, 위아래 4px 누름 여유로 44px 이상) | lg(h-11). surface: 카드 안(card, 기본) | 화면 바탕 위(page — 트랙이 바탕과 같은 색이 되지 않게).
 * 고르지 않은 칸 글자: card 트랙(fill) 위는 mute, page 트랙(line/70)은 더 어두워 mute가 4.5:1에 못 미치므로 sub.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  size = "md",
  surface = "card",
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T, e?: MouseEvent<HTMLButtonElement>) => void;
  label: string;
  className?: string;
  size?: "md" | "lg";
  surface?: "card" | "page";
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSlidingIndicator(ref, '[aria-pressed="true"]', value);
  return (
    <div
      ref={ref}
      role="group"
      aria-label={label}
      className={cn("seg inline-flex rounded-xl p-1", surface === "page" ? "bg-line/70" : "bg-fill", className)}
    >
      {/* 표시는 버튼보다 앞(첫 자식)에 둔다. 배경·그림자는 CSS가 정한다 (bg-* 유틸을 붙이지 않는다) */}
      <span aria-hidden="true" className="seg-indicator" />
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={(e) => onChange(o.value, e)}
            className={cn(
              "press min-w-[64px] flex-1 rounded-lg px-3 font-semibold whitespace-nowrap",
              size === "lg" ? "h-11 text-[15px]" : "h-10 text-[14px] before:absolute before:inset-x-0 before:-inset-y-1",
              // 고대비(forced-colors)에서는 선택 표시(thumb 바탕·그림자)가 사라지므로 고른 칸을 시스템 선택색으로 칠한다.
              // forced-color-adjust: none — 그대로 두면 브라우저가 글자 뒤에 바탕색 판(backplate)을 깔아 HighlightText 글자가 사라진다
              on
                ? "seg-on text-ink forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:forced-color-adjust-none"
                : surface === "page"
                  ? "text-sub hover:text-ink"
                  : "text-mute hover:text-sub",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 알약 탭 (화면 안의 탭: 모의투자 보유·주문·체결, 리포트 본문·진행 기록 …). WAI-ARIA tabs:
 * role=tablist/tab, id `tab-값`, aria-controls `panel-값`(선택된 탭만 — 패널은 하나만 그리므로), aria-selected,
 * 선택된 탭만 Tab으로 들어오고(roving tabIndex) ←/→/Home/End로 옮기면 바로 고른다.
 * 패널 쪽은 각 화면이 <div role="tabpanel" id="panel-값" aria-labelledby="tab-값">.
 * stretch: 모바일에서 칸을 같은 폭으로 나눈다 (sm 이상은 글자 폭).
 */
export function PillTabs<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  stretch = false,
}: {
  value: T;
  options: { value: T; label: ReactNode }[];
  onChange: (v: T) => void;
  label: string;
  className?: string;
  stretch?: boolean;
}) {
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = options.findIndex((o) => o.value === value);
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = options.length;
    const moves: Partial<Record<string, number>> = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: n - 1 };
    const to = moves[e.key];
    if (to === undefined || n === 0) return;
    e.preventDefault();
    const next = (to + n) % n;
    onChange(options[next].value);
    tabs.current[next]?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      // 가로 스크롤 상자는 포커스 테두리를 자르므로 4px 여유를 둔다
      className={cn("-m-1 flex gap-1 p-1", !stretch && "overflow-x-auto", className)}
    >
      {options.map((o, i) => {
        const on = i === selected;
        return (
          <button
            key={o.value}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            role="tab"
            type="button"
            id={`tab-${o.value}`}
            aria-selected={on}
            aria-controls={on ? `panel-${o.value}` : undefined}
            tabIndex={on || (selected < 0 && i === 0) ? 0 : -1}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "press h-11 rounded-full text-[15px] font-semibold",
              stretch ? "min-w-0 flex-1 px-3 sm:flex-none sm:px-5" : "shrink-0 px-4",
              // 고대비(forced-colors)에서는 바탕색이 덮여 선택 칩이 사라지므로 시스템 선택색으로 (글자 판이 깔리지 않게 adjust none — Segmented와 같다)
              on
                ? "bg-ink text-on-ink forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:forced-color-adjust-none"
                : "bg-card text-sub hover:bg-line",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * 켬·끔 스위치: <input type="checkbox" role="switch"> (접근성 이름·상태는 그대로) + 트랙 48×28·손잡이.
 * 보이는 크기는 48×28 그대로이고, 누를 수 있는 영역(input)만 위아래로 8px씩 늘려 높이 44px다 (UX-18). 포커스 표시는 눈에 보이는 트랙에 건다.
 * 꺼짐 트랙은 mute-weak(두 테마 모두 3:1 이상), 켜짐은 brand. 손잡이는 200ms로 옮겨 간다.
 * label을 주면 줄 전체가 <label>이라 글자를 눌러도 바뀐다. 글자가 없으면 aria-label이나 바깥 <label htmlFor={id}>.
 * onChange(checked, e): e.currentTarget은 트랙을 덮는 input이다 (원형 전환 시작점 = 스위치 가운데).
 */
export function Switch({
  checked,
  onChange,
  label,
  "aria-label": ariaLabel,
  describedBy,
  disabled = false,
  busy = false,
  id,
  className,
}: {
  checked: boolean;
  onChange: (checked: boolean, e: ChangeEvent<HTMLInputElement>) => void;
  label?: ReactNode;
  "aria-label"?: string;
  describedBy?: string;
  disabled?: boolean;
  busy?: boolean;
  id?: string;
  className?: string;
}) {
  const control = (
    <span className="relative inline-flex h-7 w-12 shrink-0">
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        onChange={(e) => onChange(e.target.checked, e)}
        className="peer absolute -top-2 left-0 z-10 m-0 h-11 w-full cursor-pointer appearance-none focus-visible:outline-none disabled:cursor-not-allowed"
      />
      <span
        aria-hidden="true"
        // 고대비(forced-colors)는 작성자 색을 바탕색(Canvas)으로 덮어 트랙·손잡이가 사라진다 → 시스템 색(덮지 않음)으로 테두리·켬 바탕을 따로 칠한다
        className="pointer-events-none absolute inset-0 rounded-full bg-mute-weak transition-colors duration-200 ease-standard peer-checked:bg-brand peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-brand peer-disabled:opacity-50 forced-colors:border-2 forced-colors:border-[color:ButtonText] forced-colors:peer-checked:border-[color:Highlight] forced-colors:peer-checked:bg-[color:Highlight]"
      />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute top-0.5 left-0.5 grid size-6 place-items-center rounded-full bg-knob text-mute-weak shadow-sm transition-[translate] duration-200 ease-standard peer-checked:translate-x-5 peer-checked:text-brand forced-colors:bg-[color:ButtonText] forced-colors:peer-checked:bg-[color:HighlightText]"
      >
        {busy && <Spinner />}
      </span>
    </span>
  );
  if (!label) return <span className={cn("inline-flex", className)}>{control}</span>;
  return (
    <label className={cn("flex items-center justify-between gap-3", disabled ? "cursor-not-allowed" : "cursor-pointer", className)}>
      <span className="min-w-0">{label}</span>
      {control}
    </label>
  );
}

const PROGRESS_TONE = { brand: "bg-brand", ok: "bg-ok", warn: "bg-warn", up: "bg-up" } as const;

/**
 * 진행 막대 (0~max). label이 있으면 progressbar로 알리고, 없으면 장식(옆 글자가 같은 정보를 준다).
 * 안쪽 막대는 scale-x로 채운다 (둥글림은 바깥 상자가 자른다 — 안쪽을 둥글리면 줄어들 때 끝이 찌그러진다).
 */
export function Progress({
  value,
  max = 1,
  label,
  tone = "brand",
  className,
}: {
  value: number;
  max?: number;
  label?: string;
  tone?: keyof typeof PROGRESS_TONE;
  className?: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div
      role={label ? "progressbar" : undefined}
      aria-hidden={label ? undefined : true}
      aria-label={label}
      aria-valuemin={label ? 0 : undefined}
      aria-valuemax={label ? max : undefined}
      aria-valuenow={label ? value : undefined}
      className={cn("h-1.5 overflow-hidden rounded-full bg-fill", className)}
    >
      <div
        className={cn("h-full origin-left transition-[scale] duration-base ease-standard", PROGRESS_TONE[tone])}
        style={{ scale: `${ratio} 1` }}
      />
    </div>
  );
}

/** 오래 이어지는 '진행 중' 표시 (스피너 대신). 퍼지는 고리는 움직임을 허용할 때만 돈다 — 정보 표시라 무한 반복의 예외. */
export function LiveDot({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("relative inline-flex size-2 shrink-0", className)}>
      <span className="absolute inset-0 rounded-full bg-ok opacity-60 motion-safe:animate-live" />
      <span className="relative inline-flex size-2 rounded-full bg-ok" />
    </span>
  );
}

const MEDAL = ["bg-medal-gold", "bg-medal-silver", "bg-medal-bronze"];

/** 랭킹 순위: 1~3위는 메달 원(금·은·동, 테마와 무관한 고정 색 + 어두운 숫자), 4위부터는 숫자만. 숫자가 글자로 남는다. */
export function Medal({ rank, size = "md", className }: { rank: number; size?: "sm" | "md"; className?: string }) {
  const top = rank >= 1 && rank <= 3;
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center rounded-full font-bold tabular-nums",
        size === "sm" ? "size-6 text-[12px]" : cn("size-9", top ? "text-[16px]" : "text-[15px]"),
        top ? cn(MEDAL[rank - 1], "text-on-medal") : "text-sub",
        className,
      )}
    >
      {rank}
    </span>
  );
}

/** 기다리는 동안 버튼 안에서 도는 표시. 움직임 줄이기에서도 돈다 (진행 중이라는 정보 — index.css .motion-essential). */
export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "motion-essential inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}
