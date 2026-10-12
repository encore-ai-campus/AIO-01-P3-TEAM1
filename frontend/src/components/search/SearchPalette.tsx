// PC 종목 검색 팔레트 (docs/DECISIONS.md 33장): 위 바(Layout)의 검색 칸을 누르거나 '/'·Ctrl+K(⌘K)로 연다. 고르면 그 종목 화면으로.
// 검색 화면(/search)과 같은 검색(useSearch)·시세(useQuotes)·최근 본 종목을 쓴다.
// 열렸을 때만 그린다 — 닫혀 있는 동안 화면에 검색 입력이 둘 생기지 않게 (화면 읽기·테스트가 /search의 검색칸 하나만 찾는다).
// 키보드: ↑↓로 고르고 Enter로 연다(결과가 없으면 검색 화면으로). Esc·바깥 누르기로 닫는다 (useModal).
import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router";
import { useAccount, useMe, useQuotes, useSearch } from "../../api/queries";
import { useRecentStocks } from "../../api/trading";
import type { Quote } from "../../api/types";
import { useDebounced } from "../../hooks/useDebounced";
import { useModal } from "../../hooks/useModal";
import { usePresence } from "../../hooks/usePresence";
import { cn } from "../../lib/cn";
import { formatPrice } from "../../lib/format";
import { quotePriceName } from "../../lib/plainText";
import { Icon } from "../Icon";
import { RateText, Skeleton } from "../ui";

/** 팔레트에 보이는 한 종목. tag: 검색어가 없을 때 어디서 온 종목인지. */
interface Item {
  symbol: string;
  name: string;
  exchange?: string;
  tag?: "최근 본" | "보유 중";
}

const stockPath = (symbol: string) => `/stocks/${encodeURIComponent(symbol)}`;

/** 글을 쓰는 중인 곳에서 누른 '/'는 글자다 (검색을 열지 않는다). */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

/** 위 바의 검색 입구(검색 칸 모양 버튼) + 팔레트. 단축키는 PC 폭에서만 연다 (입구가 보이는 곳). */
export function PcSearch({ className }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      const combo = (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
      const slash = e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey && !isTyping(e.target);
      if (!combo && !slash) return;
      // 다른 시트·대화상자가 열려 있으면 그 위에 겹쳐 열지 않는다
      if (document.documentElement.hasAttribute("data-scroll-lock")) return;
      if (!window.matchMedia?.("(min-width: 64rem)").matches) return;
      e.preventDefault();
      setOpen(true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-haspopup="dialog"
        aria-keyshortcuts="/ Control+K Meta+K"
        onClick={() => setOpen(true)}
        className={cn(
          "press flex h-11 min-w-0 items-center gap-2.5 rounded-xl bg-card px-4 text-[15px] text-mute ring-1 ring-line transition-colors hover:text-sub hover:ring-mute-weak",
          className,
        )}
      >
        <Icon name="search" className="size-5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">종목명이나 코드로 검색</span>
        <kbd aria-hidden="true" className="grid h-6 min-w-6 shrink-0 place-items-center rounded-md bg-fill px-1.5 font-sans text-[12px] font-semibold text-sub">
          /
        </kbd>
      </button>
      <SearchPalette open={open} onClose={() => setOpen(false)} returnFocus={trigger} />
    </>
  );
}

function SearchPalette({ open, onClose, returnFocus }: { open: boolean; onClose: () => void; returnFocus: RefObject<HTMLElement | null> }) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const { present, state } = usePresence(open, root, { subtree: true });
  useModal(panel, { active: open, onClose, initialFocus: input, returnFocus });
  if (!present) return null;
  return createPortal(
    // 시트·대화상자와 같은 층·움직임(index.css .sheet-*)을 쓰되, 검색 팔레트답게 화면 위쪽에 넓게 둔다
    <div ref={root} data-state={state} className="sheet-root fixed inset-0 z-(--z-sheet) flex items-start justify-center px-4 pt-[12dvh]">
      <div aria-hidden="true" data-inert-exempt="" className="sheet-scrim absolute inset-0" onClick={onClose} />
      <div
        ref={panel}
        inert={state === "closing"}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="sheet-panel relative flex max-h-[min(640px,76dvh)] w-full max-w-[640px] flex-col overflow-hidden rounded-3xl bg-card shadow-xl outline-none"
      >
        <h2 id={titleId} className="sr-only">
          종목 검색
        </h2>
        <PaletteBody inputRef={input} onClose={onClose} />
      </div>
    </div>,
    document.body,
  );
}

/** 열 때마다 새로 그린다 (검색어·고른 줄이 지난번 것으로 남지 않게). */
function PaletteBody({ inputRef, onClose }: { inputRef: RefObject<HTMLInputElement | null>; onClose: () => void }) {
  const navigate = useNavigate();
  const listId = useId();
  const { data: me } = useMe();
  const [text, setText] = useState("");
  const typed = useDebounced(text.trim(), 200);
  const search = useSearch(typed, { keepPrevious: true });
  const recent = useRecentStocks(me?.id ?? null);
  const positions = useAccount().data?.positions;

  const held = new Set((positions ?? []).map((p) => p.symbol));
  let items: Item[];
  if (typed) {
    items = (search.data?.results ?? []).slice(0, 8).map((r) => ({ symbol: r.symbol, name: r.name, exchange: r.exchange }));
  } else {
    // 검색어가 없으면 바로 갈 만한 곳: 최근 본 종목 → (최근에 없는) 내 보유 종목
    const seen = new Set<string>();
    items = [];
    for (const r of recent.slice(0, 5)) {
      seen.add(r.symbol);
      items.push({ symbol: r.symbol, name: r.name, tag: "최근 본" });
    }
    for (const p of positions ?? []) {
      if (seen.has(p.symbol) || items.length >= 8) continue;
      seen.add(p.symbol);
      items.push({ symbol: p.symbol, name: p.name, tag: "보유 중" });
    }
  }
  const quotes = useQuotes(
    items.map((i) => i.symbol),
    { keepPrevious: true },
  );

  // 고른 줄: 목록이 바뀌면 첫 줄로 (렌더 중 조건부 파생 상태)
  const listKey = items.map((i) => i.symbol).join(",");
  const [active, setActive] = useState({ key: listKey, index: 0 });
  if (active.key !== listKey) setActive({ key: listKey, index: 0 });
  const index = Math.min(active.index, Math.max(items.length - 1, 0));
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const go = (symbol: string) => {
    onClose();
    navigate(stockPath(symbol), { state: { scroll: "top" } });
  };
  const searchHref = typed ? `/search?q=${encodeURIComponent(typed)}` : "/search";

  const move = (to: number) => {
    if (items.length === 0) return;
    const next = (to + items.length) % items.length;
    setActive({ key: listKey, index: next });
    document.getElementById(optionId(next))?.scrollIntoView?.({ block: "nearest" });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return; // 한글 조합 중 Enter·화살표는 조합을 끝내는 키다
    if (e.key === "ArrowDown") {
      e.preventDefault();
      move(index + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      move(index - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const now = text.trim();
      // 보이는 목록이 지금 입력한 글자의 결과가 아니면(디바운스 전·새 검색을 받는 중 — 이전 결과가 남아 있다) 고르지 않고 검색 화면으로 간다
      const stale = now !== typed || search.isPlaceholderData || (typed !== "" && search.isPending);
      if (!stale && items[index]) go(items[index].symbol);
      else if (now) {
        onClose();
        navigate(`/search?q=${encodeURIComponent(now)}`);
      }
    }
  };

  const loading = typed !== "" && search.isPending;
  const empty = !loading && items.length === 0;
  const heading = typed ? "검색 결과" : items.length > 0 ? "최근 본 종목 · 내 보유 종목" : null;

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-5">
        <Icon name="search" className="size-5 shrink-0 text-mute" />
        <input
          ref={inputRef}
          role="combobox"
          aria-label="종목명이나 종목코드"
          aria-expanded={items.length > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={items.length > 0 ? optionId(index) : undefined}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="종목명이나 종목코드 (예: 삼성전자, 005930)"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          className="h-16 min-w-0 flex-1 bg-transparent text-[17px] outline-none placeholder:text-mute"
        />
        <button
          type="button"
          onClick={onClose}
          className="press h-8 shrink-0 rounded-lg bg-fill px-2.5 text-[12px] font-semibold text-sub hover:bg-line"
        >
          닫기
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
        {heading && <p className="px-3 pt-2 pb-1 text-[13px] font-semibold text-mute">{heading}</p>}
        {loading && items.length === 0 ? (
          <div aria-hidden="true" className="space-y-1 p-1">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 w-full rounded-xl" />
            ))}
          </div>
        ) : (
          <ul id={listId} role="listbox" aria-label={heading ?? "종목"} className={cn("space-y-0.5", search.isPlaceholderData && "opacity-60")}>
            {items.map((it, i) => (
              <li
                key={it.symbol}
                id={optionId(i)}
                role="option"
                aria-selected={i === index}
                onMouseMove={() => i !== index && setActive({ key: listKey, index: i })}
                onClick={() => go(it.symbol)}
                className={cn("flex min-h-14 cursor-pointer items-center gap-3 rounded-xl px-3 py-2", i === index ? "bg-fill" : "hover:bg-fill/60")}
              >
                <div className="min-w-0 flex-1">
                  <p className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-[16px] font-semibold">{it.name}</span>
                    {(it.tag === "보유 중" || (!it.tag && held.has(it.symbol))) && (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-brand-soft px-1.5 text-[11px] font-bold text-brand-ink">보유 중</span>
                    )}
                    {it.tag === "최근 본" && (
                      <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-fill px-1.5 text-[11px] font-bold text-sub">최근 본</span>
                    )}
                  </p>
                  <p className="text-[13px] text-mute">
                    {it.symbol}
                    {it.exchange && ` · ${it.exchange}`}
                  </p>
                </div>
                <PriceCell quote={quotes.data?.get(it.symbol)} loading={quotes.isPending && quotes.fetchStatus !== "idle"} />
              </li>
            ))}
          </ul>
        )}
        {empty && (
          <p className="px-3 py-8 text-center text-[15px] text-sub">
            {typed ? `'${typed}'에 맞는 종목이 없어요. 이름이나 6자리 코드로 찾아 보세요.` : "종목명이나 코드를 입력하세요. 최근 본 종목도 여기에 모여요."}
          </p>
        )}
        {/* 결과 수는 화면 읽기에만 (입력하는 동안 결과가 바뀐 것을 알린다) */}
        <p aria-live="polite" className="sr-only">
          {typed && !loading ? `검색 결과 ${items.length}개` : ""}
        </p>
      </div>

      <div className="flex items-center justify-between gap-3 border-t border-line px-5 py-3 text-[13px] text-mute">
        <span aria-hidden="true">↑↓ 고르기 · Enter 열기 · Esc 닫기</span>
        <Link to={searchHref} onClick={onClose} className="font-semibold text-brand-ink hover:underline">
          검색 화면에서 보기
        </Link>
      </div>
    </>
  );
}

/** 오른쪽 가격 칸 (시세를 받기 전에는 같은 폭의 자리 — 가격이 늦게 끼어들며 줄이 밀리지 않게). */
function PriceCell({ quote, loading }: { quote: Quote | undefined; loading: boolean }) {
  if (!quote) {
    return loading ? (
      <div aria-hidden="true" className="w-20 shrink-0">
        <Skeleton className="ml-auto h-4 w-16" />
        <Skeleton className="mt-1.5 ml-auto h-3 w-10" />
      </div>
    ) : null;
  }
  return (
    <div className="shrink-0 text-right">
      <p className="text-[15px] font-semibold tabular-nums">
        <span className="sr-only">{quotePriceName(quote.basis)} </span>
        {formatPrice(quote.price, quote.currency)}
      </p>
      <RateText rate={quote.changeRate} className="text-[13px] font-medium" />
    </div>
  );
}
