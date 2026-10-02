import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../api/client";
import { useQuotes, useSearch } from "../api/queries";
import { Icon } from "../components/Icon";
import { EmptyState, ErrorState, Flash, PageHeader, RateText, Skeleton } from "../components/ui";
import { formatPrice } from "../lib/format";
import { useDebounced } from "../lib/useDebounced";

export function SearchPage() {
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get("q") ?? "");
  const q = useDebounced(text.trim(), 300);
  const { data, isFetching, isError, error, refetch } = useSearch(q);
  const results = q ? (data?.results ?? []) : [];
  const { data: quotes } = useQuotes(results.map((r) => r.symbol));

  return (
    <>
      <PageHeader title="종목 검색" back />
      <div className="sticky top-14 z-20 -mx-4 bg-bg px-4 pb-3 lg:static lg:mx-0 lg:px-0">
        <label className="flex h-12 items-center gap-2 rounded-2xl bg-card px-4 focus-within:ring-2 focus-within:ring-brand">
          <Icon name="search" className="size-5 text-mute" />
          <span className="sr-only">종목명 또는 종목코드</span>
          <input
            type="search"
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="종목명이나 종목코드 (예: 삼성전자, 005930, AAPL)"
            className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-mute"
          />
        </label>
      </div>

      <section aria-label="검색 결과" className="rounded-2xl bg-card">
        {!q ? (
          <EmptyState>종목명이나 종목코드로 찾아보세요.</EmptyState>
        ) : isError ? (
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
        ) : isFetching && !data ? (
          <div className="space-y-4 p-5">
            <Skeleton className="h-5 w-2/3" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-5 w-3/5" />
          </div>
        ) : results.length === 0 ? (
          <EmptyState>"{q}"에 맞는 종목이 없습니다.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {results.map((r) => {
              const quote = quotes?.get(r.symbol);
              return (
                <li key={r.symbol}>
                  <Link to={`/stocks/${encodeURIComponent(r.symbol)}`} className="flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-fill/60">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[16px] font-semibold">{r.name}</p>
                      <p className="text-[13px] text-mute">
                        {r.symbol} · {r.exchange}
                      </p>
                    </div>
                    {quote && (
                      <div className="text-right">
                        <p className="text-[15px] font-semibold tabular-nums">
                          <Flash value={quote.price}>{formatPrice(quote.price, quote.currency)}</Flash>
                        </p>
                        <RateText rate={quote.changeRate} className="text-[13px] font-medium" />
                      </div>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}
