// /search 종목 검색 (하단 탭 '종목' — 여정 ① 만들기의 출발점). 가격은 실시간 (docs/API.md 공통 규칙 "실시간 시세" — 현재가를 받지 못한 종목만 직전 장마감 종가).
// - 검색어는 주소(?q=)에 둔다(기록을 쌓지 않는 replace): 종목을 열었다가 뒤로 오면 검색어·결과·스크롤이 그대로다. 하단 탭 '종목'은 빈 /search로 간다.
// - 검색어가 없으면 바로가기: 최근 본 종목(이 기기) → 내 보유 → 오늘 팀이 리포트를 만든 종목 (다시 찾는 빈도 순).
//   모바일은 검색칸 아래, PC는 오른쪽 sticky 열 (왼쪽 검색·결과는 720px까지 — 이름과 가격 사이 시선이 멀어지지 않게).
// - 검색어를 다듬는 동안 이전 결과를 흐리게 남긴다(keepPrevious — 스켈레톤으로 깜빡이며 목록이 밀리지 않게).
// - Enter·키보드 '검색' 키는 키보드를 닫고, 맞는 종목이 하나뿐이면 바로 그 종목으로 간다. 탭의 첫 화면이라 뒤로 가기는 없다.
import { type FormEvent, type ReactNode, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { useAccount, useMe, useQuotes, useReports, useSearch } from "../api/queries";
import { clearRecentStocks, type RecentStock, useRecentStocks } from "../api/trading";
import type { Market, Quote, QuoteBasis, StockItem } from "../api/types";
import { Icon } from "../components/Icon";
import { useToast } from "../components/toast";
import { AsOf, EmptyState, ErrorState, Flash, PageHeader, RateText, Skeleton } from "../components/ui";
import { revealList, useRevealAfterLoading } from "../hooks/useMotionState";
import { isTodayKst } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatPrice } from "../lib/format";
import { quotePriceName } from "../lib/plainText";
import { useDebounced } from "../hooks/useDebounced";

interface BasisTime {
  market: Market;
  at: string;
  basis: QuoteBasis;
}

/**
 * 검색 결과에 보이는 시세의 기준 표기. 실시간은 한 줄(종목마다 받은 시각이 조금씩 달라 가장 늦게 받은 시각 하나),
 * 현재가를 받지 못해 직전 종가로 보이는 종목은 시장·시각별 하나씩 (실시간이 앞).
 */
function basisTimes(results: StockItem[], quotes: Map<string, Quote> | undefined): BasisTime[] {
  const seen = new Map<string, BasisTime>();
  let live: BasisTime | null = null;
  for (const r of results) {
    const q = quotes?.get(r.symbol);
    const at = q?.asOf;
    if (!q || !at) continue;
    if (q.basis === "live") {
      if (!live || Date.parse(at) > Date.parse(live.at)) live = { market: r.market, at, basis: "live" };
    } else if (!seen.has(`${r.market}:${at}`)) {
      seen.set(`${r.market}:${at}`, { market: r.market, at, basis: "close" });
    }
  }
  const closes = [...seen.values()].sort((a, b) => a.market.localeCompare(b.market) || a.at.localeCompare(b.at));
  return live ? [live, ...closes] : closes;
}

/** 기준 표기 줄의 앞 문장 (실시간이 하나라도 있으면 실시간, 직전 종가로 보이는 종목이 섞여 있으면 그것도 밝힌다). */
function basisNote(times: BasisTime[]): string {
  const live = times.some((t) => t.basis === "live");
  if (!live) return "가격은 직전 장마감 종가예요";
  return times.some((t) => t.basis !== "live") ? "가격은 실시간이에요 (받지 못한 종목은 직전 장마감 종가)" : "가격은 실시간이에요";
}

const norm = (s: string) => s.replace(/\s+/g, "").toUpperCase();

/** Enter로 바로 갈 종목: 종목코드·이름이 정확히 맞는 것이 하나뿐이거나, 결과가 하나뿐이면. */
function onlyMatch(results: StockItem[], term: string): StockItem | null {
  const t = norm(term);
  const exact = results.filter((r) => norm(r.symbol) === t || norm(r.name) === t);
  if (exact.length === 1) return exact[0];
  return results.length === 1 ? results[0] : null;
}

const stockPath = (symbol: string) => `/stocks/${encodeURIComponent(symbol)}`;

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
        <Flash value={quote.price}>{formatPrice(quote.price, quote.currency)}</Flash>
      </p>
      <RateText rate={quote.changeRate} className="text-[13px] font-medium" />
    </div>
  );
}

function Badge({ children, tone }: { children: string; tone: "brand" | "plain" }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-bold",
        tone === "brand" ? "bg-brand-soft text-brand-ink" : "bg-fill text-sub",
      )}
    >
      {children}
    </span>
  );
}

// 행의 키보드 포커스 테두리는 안쪽에 그린다 — 행을 감싼 카드가 overflow-hidden rounded라 바깥 테두리는 잘려
// 선 하나만 남거나 이웃 행의 테두리처럼 보인다. 카드의 아래 끝(마지막 행)과 위 끝(목록이 카드 맨 위일 때 첫 행)은 모서리를 카드와 맞춘다
const ROW_FOCUS = "focus-visible:outline-offset-[-2px] [li:last-child>&]:rounded-b-2xl [ul:first-child>li:first-child>&]:rounded-t-2xl";

/** 종목 한 줄 (검색 결과·바로가기 공용): 이름(+ 배지)·코드 / 현재가·등락. */
function StockRow({
  item,
  quote,
  quoteLoading,
  held = false,
  reported = false,
}: {
  item: { symbol: string; name: string; exchange?: string };
  quote: Quote | undefined;
  quoteLoading: boolean;
  held?: boolean;
  reported?: boolean;
}) {
  return (
    <Link to={stockPath(item.symbol)} className={cn("press-row flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-fill/60", ROW_FOCUS)}>
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[16px] font-semibold">{item.name}</span>
          {held && <Badge tone="brand">보유 중</Badge>}
          {reported && <Badge tone="plain">오늘 리포트</Badge>}
        </p>
        <p className="text-[13px] text-mute">
          {item.symbol}
          {item.exchange && ` · ${item.exchange}`}
        </p>
      </div>
      <PriceCell quote={quote} loading={quoteLoading} />
    </Link>
  );
}

interface ShortcutData {
  recent: RecentStock[];
  holdings: { symbol: string; name: string }[];
  team: { symbol: string; name: string }[];
}

/**
 * 바로가기: 최근 본 종목(칩) → 내 보유 종목 → 오늘 팀이 리포트를 만든 종목. 비어 있는 묶음은 그리지 않는다.
 * PC에서 셋 다 비어 있으면 무엇이 여기 모이는지 한 줄로 알린다 (오른쪽 열이 텅 비지 않게).
 * '지우기'로 최근 묶음이 통째로 사라지면 포커스를 다음 묶음 제목으로 옮긴다 (없으면 onEmptied — 검색칸). 누른 버튼과 함께 body로 빠지지 않게.
 */
function Shortcuts({
  data,
  onClearRecent,
  onEmptied,
  className,
}: {
  data: ShortcutData;
  onClearRecent: () => void;
  onEmptied: () => void;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const refocus = useRef(false); // '지우기'를 눌렀다 → 최근 묶음이 사라진 렌더에서 포커스를 옮긴다
  const recentCount = data.recent.length;
  useLayoutEffect(() => {
    if (!refocus.current || recentCount > 0) return;
    refocus.current = false;
    const next = box.current?.querySelector<HTMLElement>("h2[tabindex]");
    if (next) next.focus({ preventScroll: true });
    else onEmptied();
  }, [recentCount, onEmptied]);
  const symbols = [...data.holdings, ...data.team].map((s) => s.symbol);
  const quotesQ = useQuotes(symbols);
  const quotes = quotesQ.data;
  const loading = quotesQ.isPending && symbols.length > 0;
  const empty = data.recent.length === 0 && data.holdings.length === 0 && data.team.length === 0;
  const list = (title: string, items: { symbol: string; name: string }[]) => (
    <section aria-label={title} className="overflow-hidden rounded-2xl bg-card">
      {/* tabIndex -1: '지우기' 뒤 포커스가 옮겨 오는 자리 (화면 머리 제목처럼 테두리 없이) */}
      <h2 tabIndex={-1} className="px-5 pt-4 pb-1 text-[15px] font-bold outline-none">
        {title}
      </h2>
      <ul className="divide-y divide-line">
        {items.map((s) => (
          <li key={s.symbol}>
            <StockRow item={s} quote={quotes?.get(s.symbol)} quoteLoading={loading} />
          </li>
        ))}
      </ul>
    </section>
  );
  return (
    <div ref={box} className={cn("space-y-3", className)}>
      {data.recent.length > 0 && (
        <section aria-labelledby="recent-stocks" className="rounded-2xl bg-card px-5 pt-3 pb-4">
          <div className="flex items-center justify-between">
            <h2 id="recent-stocks" className="text-[15px] font-bold">
              최근 본 종목
            </h2>
            <button
              type="button"
              onClick={() => {
                refocus.current = true;
                onClearRecent();
              }}
              className="press -mr-2 h-11 rounded-xl px-2.5 text-[13px] font-semibold text-sub hover:bg-fill"
            >
              지우기
            </button>
          </div>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {data.recent.map((s) => (
              <li key={s.symbol}>
                <Link
                  to={stockPath(s.symbol)}
                  className="press inline-flex h-11 items-center rounded-full bg-fill px-4 text-[14px] font-semibold text-ink hover:bg-line"
                >
                  {s.name}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.holdings.length > 0 && list("내 보유 종목", data.holdings)}
      {data.team.length > 0 && list("오늘 팀이 리포트를 만든 종목", data.team)}
      {empty && (
        <p className="hidden rounded-2xl bg-card px-5 py-4 text-[14px] leading-relaxed text-sub lg:block">
          종목을 열어 보면 여기에 최근 본 종목이 모여요. 내 보유 종목과 오늘 팀이 리포트를 만든 종목도 함께 보여요.
        </p>
      )}
    </div>
  );
}

/**
 * 검색 결과 카드. 검색어가 생길 때 마운트된다 — 처음 받아 올 때만 목록이 페이드로 나타나고,
 * 검색어를 다듬는 동안은 이전 결과를 흐리게 남긴다 (opacity .6, aria-busy).
 */
function Results({
  q,
  search,
  held,
  reported,
}: {
  q: string;
  search: ReturnType<typeof useSearch>;
  held: Set<string>;
  reported: Set<string>;
}) {
  const results = search.data?.results ?? [];
  const quotesQ = useQuotes(
    results.map((r) => r.symbol),
    { keepPrevious: true },
  );
  const quotes = quotesQ.data;
  const times = basisTimes(results, quotes);
  const reveal = useRevealAfterLoading(search.isPending);
  const dim = search.isPlaceholderData;
  const offline = search.fetchStatus === "paused" && !search.data;

  let body: ReactNode;
  if (search.isError && !search.data) {
    body = <ErrorState message={errorMessage(search.error)} onRetry={() => void search.refetch()} retrying={search.isFetching} />;
  } else if (offline) {
    // 연결이 없어 묻지 못한 것 — '없어요'로 보이면 사실과 다르다
    body = (
      <EmptyState icon="wifi-off" title="연결되면 찾아볼게요">
        인터넷 연결이 끊겨 지금은 찾을 수 없어요.
      </EmptyState>
    );
  } else if (search.isPending) {
    body = (
      <ul aria-hidden="true" className="divide-y divide-line">
        {[0, 1, 2].map((i) => (
          <li key={i} className="flex min-h-16 items-center gap-3 px-5 py-3">
            <div className="flex-1">
              <Skeleton className="h-4 w-2/5" />
              <Skeleton className="mt-2 h-3 w-1/4" />
            </div>
            <Skeleton className="h-4 w-16" />
          </li>
        ))}
      </ul>
    );
  } else if (results.length === 0) {
    body = (
      <EmptyState icon="search" title={`"${q}"에 맞는 종목이 없어요`}>
        철자를 확인하거나 종목코드 6자리·영문 티커로 찾아보세요.
      </EmptyState>
    );
  } else {
    body = (
      <>
        {times.length > 0 ? (
          <p aria-label="가격 기준" className="flex flex-wrap gap-x-3 gap-y-0.5 border-b border-line px-5 py-2.5 text-[12px] text-mute">
            <span>{basisNote(times)}</span>
            {times.map((t) => (
              <AsOf key={t.basis === "live" ? "live" : `${t.market}:${t.at}`} at={t.at} market={t.market} basis={t.basis} />
            ))}
          </p>
        ) : quotesQ.isPending || quotesQ.isPlaceholderData ? (
          // 기준 시각 줄 자리 (시세가 오면 진짜 줄로 바뀐다 — 목록이 아래로 밀리지 않게).
          // 검색어를 다듬는 동안(이전 시세를 남겨 둔 때) 새 결과와 겹치는 종목이 없어도 줄이 빠졌다 다시 끼지 않게 자리를 둔다
          <p aria-hidden="true" className="border-b border-line px-5 py-2.5 text-[12px]">
            &nbsp;
          </p>
        ) : null}
        <ul {...revealList(reveal)} className={cn("divide-y divide-line transition-opacity duration-fast", dim && "opacity-60")}>
          {results.map((r) => (
            <li key={r.symbol}>
              <StockRow
                item={r}
                quote={quotes?.get(r.symbol)}
                quoteLoading={quotesQ.isPending || quotesQ.isPlaceholderData}
                held={held.has(r.symbol)}
                reported={reported.has(r.symbol)}
              />
            </li>
          ))}
        </ul>
      </>
    );
  }

  return (
    <section aria-label="검색 결과" aria-busy={dim || search.isPending || undefined} className="overflow-hidden rounded-2xl bg-card">
      {body}
    </section>
  );
}

export function SearchPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: me } = useMe();
  const userId = me?.id ?? null;
  const [params, setParams] = useSearchParams();
  const urlQ = (params.get("q") ?? "").trim();
  const [text, setText] = useState(params.get("q") ?? "");
  const typed = useDebounced(text.trim(), 300);
  const [submitted, setSubmitted] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  // 주소가 밖에서 바뀌면(하단 탭 '종목'으로 빈 /search 등) 입력이 따라간다. 내가 쓴 주소(= 디바운스한 입력)는 건너뛴다
  const [seenQ, setSeenQ] = useState(urlQ);
  if (urlQ !== seenQ) {
    setSeenQ(urlQ); // 렌더 중 조건부 파생 상태
    if (urlQ !== typed) setText(urlQ);
  }

  const writeQ = (next: string) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (next) sp.set("q", next);
        else sp.delete("q");
        return sp;
      },
      { replace: true },
    );
  // 입력이 300ms 멈추면 주소에 쓴다 (검색은 주소의 q로 한다 — 주소가 기준이라 뒤로 와도 같은 결과)
  const syncQ = useEffectEvent((next: string) => {
    if (next !== urlQ) writeQ(next);
  });
  useEffect(() => {
    syncQ(typed);
  }, [typed]);

  const q = urlQ;
  const search = useSearch(q, { keepPrevious: true });
  const hasText = text.trim().length > 0;

  // 바로가기 자료 (최근 본 종목은 이 기기에 계정마다 따로)
  const recent = useRecentStocks(userId);
  const holdings = useAccount().data?.positions ?? [];
  const reports = useReports({ limit: 20 }).data?.results ?? [];
  const team: { symbol: string; name: string }[] = [];
  for (const r of reports) {
    if (r.status !== "failed" && isTodayKst(r.createdAt) && !team.some((x) => x.symbol === r.symbol)) team.push({ symbol: r.symbol, name: r.name });
  }
  const shortcuts: ShortcutData = { recent, holdings: holdings.map((p) => ({ symbol: p.symbol, name: p.name })), team };
  const anyShortcut = recent.length + holdings.length + team.length > 0;
  const held = new Set(holdings.map((p) => p.symbol));
  const reported = new Set(team.map((x) => x.symbol));

  const results = q ? (search.data?.results ?? []) : [];
  const settled = Boolean(q) && !search.isPending && !search.isPlaceholderData && !search.isError;
  const announce = settled ? (results.length ? `검색 결과 ${results.length}개` : "맞는 종목이 없어요") : "";
  // 결과가 있으면 모바일에서는 바로가기를 숨긴다 (결과가 없을 때는 그 아래에 둔다)
  const hideShortcutsOnMobile = hasText && q !== "" && (search.isPending || results.length > 0);

  // Enter로 낸 검색어의 결과가 오면: 맞는 종목이 하나뿐이면 그 종목으로
  const target = submitted !== null && submitted === q && search.data && !search.isPlaceholderData ? onlyMatch(search.data.results, submitted) : null;
  useEffect(() => {
    if (target) navigate(stockPath(target.symbol));
  }, [target, navigate]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const term = text.trim();
    input.current?.blur(); // 모바일 키보드를 닫는다 (결과를 가리지 않게)
    if (!term) return;
    if (term !== urlQ) writeQ(term); // 디바운스를 기다리지 않는다
    setSubmitted(term);
  };

  const clear = () => {
    setText("");
    setSubmitted(null);
    writeQ("");
    input.current?.focus();
  };

  // 최근 본 종목 지우기: 묶음이 사라지므로 결과를 알린다 (포커스는 Shortcuts가 다음 묶음 제목으로, 남은 묶음이 없으면 검색칸으로)
  const clearRecent = () => {
    if (userId !== null) clearRecentStocks(userId);
    toast("최근 본 종목을 지웠어요", "success");
  };
  const focusSearch = () => input.current?.focus({ preventScroll: true });

  return (
    <>
      <PageHeader title="종목 검색" />
      <div className="lg:grid lg:grid-cols-[minmax(0,720px)_minmax(0,1fr)] lg:items-start lg:gap-6">
        <div className="min-w-0">
          <form role="search" onSubmit={submit} className="sticky top-14 z-20 -mx-4 bg-bg px-4 pb-3 lg:static lg:mx-0 lg:px-0">
            <div className="flex h-12 items-center rounded-2xl bg-card pr-1 focus-within:ring-2 focus-within:ring-brand">
              {/* 지우기 버튼은 label 밖에 둔다 (안에 있으면 검색칸 이름이 '… 검색어 지우기'로 읽힌다) */}
              <label className="flex h-full min-w-0 flex-1 items-center gap-2 pl-4">
                <Icon name="search" className="size-5 shrink-0 text-mute-weak" />
                <span className="sr-only">종목명 또는 종목코드</span>
                <input
                  ref={input}
                  type="search"
                  enterKeyHint="search"
                  autoComplete="off"
                  autoCorrect="off"
                  spellCheck={false}
                  // 새로 연 검색만 키보드를 띄운다 (뒤로 와서 결과가 있으면 키보드가 결과를 가리지 않게)
                  autoFocus={!urlQ}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    setSubmitted(null);
                  }}
                  placeholder="종목명·코드 (예: 삼성전자)"
                  className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-mute-weak [&::-webkit-search-cancel-button]:appearance-none"
                />
              </label>
              {hasText && (
                <button
                  type="button"
                  aria-label="검색어 지우기"
                  // 누르는 동안 입력칸의 포커스(모바일 키보드)를 빼앗지 않는다
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={clear}
                  className="grid size-11 shrink-0 place-items-center rounded-full text-mute-weak transition-colors hover:text-sub active:bg-line/60"
                >
                  <Icon name="x-circle" className="size-5" />
                </button>
              )}
            </div>
          </form>
          {/* 결과가 바뀐 것을 화면 읽기에 알린다 (role=status는 토스트가 쓴다) */}
          <p className="sr-only" aria-live="polite">
            {announce}
          </p>

          {hasText && q ? (
            <Results q={q} search={search} held={held} reported={reported} />
          ) : (
            <section
              aria-label="검색 결과"
              aria-busy={hasText || undefined}
              className={cn(
                "rounded-2xl bg-card transition-opacity duration-fast",
                hasText && "opacity-60", // 입력한 뒤 찾기 전(300ms) — 지금 찾는 중
                anyShortcut && "max-lg:hidden",
              )}
            >
              <EmptyState icon="search" title="어떤 종목을 볼까요?">
                종목명이나 종목코드로 찾아보세요. 예: 삼성전자 · 005930 · AAPL
              </EmptyState>
            </section>
          )}
        </div>

        <Shortcuts
          data={shortcuts}
          onClearRecent={clearRecent}
          onEmptied={focusSearch}
          className={cn("mt-3 lg:sticky lg:top-8 lg:mt-0", hideShortcutsOnMobile && "max-lg:hidden")}
        />
      </div>
    </>
  );
}
