// 리포트 목록 맨 위의 만들기 카드: 종목 검색 → 고르기 → 큰 버튼 "AI 리포트 만들기" + 오늘 남은 횟수 (D-7).
// 고르면 검색 결과를 접고 고른 종목을 칩("현대차 005380 · 바꾸기")으로 보인다 — 버튼이 입력칸 바로 아래로 올라와 엄지가 닿는다.
// 오늘 그 종목 리포트가 이미 있으면(내 것·팀 것, 완성·만드는 중) 종목 상세와 같은 규칙: 주 버튼 "오늘 리포트 보기", "새로 만들기"는 작게
// (docs/plans/컨셉변경계획.md 4-2 — 같은 날 같은 종목을 다시 만들어 한도·비용·기다림을 쓰지 않게).
// 검색어를 바꾸는 동안은 이전 결과를 흐리게 남긴다 (스켈레톤으로 바뀌며 높이가 출렁이지 않게). 장애 주입(ChaosForm)은 전문가 보기에서만.
// 결과를 고르면 포커스는 고른 종목 칩으로 간다 — 접히는 결과 목록(inert) 안에 남아 body로 떨어지지 않게, 화면 읽기에는 칩 이름('고른 종목 … 바꾸기')이 읽힌다.
import { type Ref, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Link, useNavigate } from "react-router";
import { errorMessage } from "../../api/client";
import { useSearch } from "../../api/queries";
import { useReportQuota, useRequestReport, useSymbolReports } from "../../api/reports";
import type { ChaosRequest, ExecutionPlan, StockItem } from "../../api/types";
import { cn } from "../../lib/cn";
import { errorSentence, reportStatusText } from "../../lib/plainText";
import { todayReport } from "../../lib/reports";
import { useDebounced } from "../../hooks/useDebounced";
import { Icon } from "../Icon";
import { ErrorPanel } from "../errors/ErrorPanel";
import { errorKindOf } from "../errors/errorTypes";
import { Collapse } from "../motion/Collapse";
import { Card, Skeleton, Spinner } from "../ui";
import { ChaosForm } from "./ChaosForm";
import { QuotaLine } from "./QuotaLine";

/** 만들기 카드의 검색 칸 id (다른 곳에서 '종목 고르기'로 포커스를 옮길 때). */
export const REPORT_SEARCH_ID = "report-search";

/**
 * dockRef: PC에서 카드 아래에 붙는 '고른 종목·만들기' 묶음 — 카드를 감싼 스크롤 상자(ReportsPage)가 그 높이만큼 아래 여백(scroll-padding)을 둬
 * Tab으로 옮긴 칸이 묶음 밑에 가려지지 않게 잰다.
 */
export function CreateReportCard({ plan, expert, dockRef }: { plan: ExecutionPlan | undefined; expert: boolean; dockRef?: Ref<HTMLDivElement> }) {
  const navigate = useNavigate();
  const [chaos, setChaos] = useState<ChaosRequest | null>(null);
  const workers = plan ? plan.workers.filter((w) => plan.steps.some((st) => st.workers.includes(w.id))) : [];
  const [input, setInput] = useState("");
  const [picked, setPicked] = useState<StockItem | null>(null);
  // 결과 목록을 펼쳐 둘지 (고르면 접고, 칩을 누르거나 검색어를 고치면 다시 편다)
  const [listOpen, setListOpen] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  const resultsId = useId();
  const q = useDebounced(input.trim(), 300);
  const { data, isFetching, isError, error, refetch, isPlaceholderData } = useSearch(q, { keepPrevious: true });
  const request = useRequestReport();
  const quota = useReportQuota();
  const today = useSymbolReports(picked?.symbol ?? null);
  const existing = picked && today.data ? todayReport(today.data.results) : null;
  // 고른 종목의 오늘 리포트를 확인하는 동안은 만들기를 막는다 — 확인 전에 누르면 같은 날 같은 종목을 또 만들어 한도·비용을 쓴다
  // (종목 상세도 확인 전에는 누를 수 있는 '만들기'를 보이지 않는다). 확인이 실패하면 막지 않는다
  const checking = picked !== null && today.isPending;
  const results = q ? (data?.results ?? []).slice(0, 8) : [];
  const full = quota.data?.remaining === 0;
  const showList = listOpen && q !== "";
  const create = () =>
    picked && request.mutate({ symbol: picked.symbol, chaos: expert ? chaos : null }, { onSuccess: (r) => navigate(`/reports/${r.id}`) });

  const pick = (r: StockItem) => {
    // 칩을 먼저 그려 포커스를 옮긴 뒤 목록을 접는다 (접히는 동안 목록이 inert라 누른 결과에 포커스가 남으면 body로 떨어진다)
    flushSync(() => setPicked(r));
    chipRef.current?.focus({ preventScroll: true });
    setListOpen(false);
  };
  const change = () => {
    setListOpen(true);
    inputRef.current?.focus();
  };

  return (
    <Card aria-labelledby="request-title">
      <h2 id="request-title" className="text-[17px] font-bold">
        리포트 만들기
      </h2>
      <p className="mt-0.5 text-[13px] leading-snug text-sub">
        {expert
          ? "종목을 골라 만들면 팀 리포트 목록에 기록됩니다."
          : "종목을 고르면 AI 담당자들이 시세·재무·뉴스를 조사하고, 리포트를 쓰고, 검토까지 해요."}
      </p>
      <label className="mt-3 flex h-12 items-center gap-2 rounded-2xl bg-fill px-4 focus-within:ring-2 focus-within:ring-brand">
        <Icon name="search" className="size-5 text-mute-weak" />
        <span className="sr-only">종목 검색</span>
        <input
          ref={inputRef}
          id={REPORT_SEARCH_ID}
          type="search"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setListOpen(true);
          }}
          placeholder="종목명이나 종목코드 (예: 삼성전자, 005930)"
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-mute-weak"
        />
      </label>

      {/* 결과는 버튼 아래로 펼치고(240ms) 고르면 접는다 — 버튼이 첫 화면 밖으로 밀리지 않게 */}
      <Collapse open={showList} id={resultsId} className="mt-2">
        {isError ? (
          <ErrorPanel kind={errorKindOf(error)} detail={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} secondary={null} compact />
        ) : isFetching && !data ? (
          <div aria-busy="true" aria-label="검색하는 중" className="divide-y divide-line">
            {[0, 1].map((i) => (
              <div key={i} className="flex min-h-14 flex-col justify-center gap-1.5 px-3">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3.5 w-1/4" />
              </div>
            ))}
          </div>
        ) : results.length === 0 ? (
          <p className="py-4 text-center text-[14px] text-mute">&ldquo;{q}&rdquo;에 맞는 종목이 없습니다.</p>
        ) : (
          <ul
            aria-label="검색한 종목"
            aria-busy={isPlaceholderData || undefined}
            className={cn("divide-y divide-line transition-opacity duration-fast", isPlaceholderData && "opacity-60")}
          >
            {results.map((r) => {
              const on = picked?.symbol === r.symbol;
              return (
                <li key={r.symbol}>
                  <button
                    type="button"
                    aria-pressed={on}
                    onClick={() => pick(r)}
                    className={cn("press-row flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left", on ? "bg-brand-soft" : "hover:bg-fill")}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold">{r.name}</span>
                      <span className="block text-[13px] text-mute">
                        {r.symbol} · {r.exchange}
                      </span>
                    </span>
                    {on && <Icon name="check" className="size-5 text-brand" />}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Collapse>

      {expert && (
        <div className="mt-3">
          <ChaosForm value={chaos} onChange={setChaos} workers={workers} />
        </div>
      )}

      {/* 고른 종목·만들기·남은 횟수: PC에서 카드가 화면보다 길어 카드 안에서 스크롤될 때(장애 주입 직접 설정·긴 검색 결과)도
          카드 아래에 붙어 늘 보인다 — 주 행동이 카드 안쪽 아래에 숨지 않게. flow-root: 첫 줄의 위 여백까지 바탕이 덮는다.
          -bottom-1: 스크롤 상자(ReportsPage)의 안쪽 여백 4px까지 덮어 그 아래로 내용이 비치지 않게 */}
      <div ref={dockRef} className="lg:sticky lg:-bottom-1 lg:-mx-5 lg:-mb-5 lg:flow-root lg:rounded-b-2xl lg:bg-card lg:px-5 lg:pb-5">
        {picked ? (
          // 고른 종목 칩: 누르면 결과를 다시 펴고 검색 칸으로 간다 (이름이 검색 결과 버튼과 겹치지 않게 '바꾸기'를 붙인다)
          <button
            ref={chipRef}
            type="button"
            onClick={change}
            aria-label={`고른 종목 ${picked.name} ${picked.symbol} 바꾸기`}
            className="press mt-3 flex h-11 w-full items-center gap-2 rounded-xl bg-brand-soft px-3.5 text-left text-[14px] text-brand-ink"
          >
            <Icon name="check" className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              <b className="text-ink">{picked.name}</b> <span className="tabular-nums">{picked.symbol}</span>
            </span>
            <span className="shrink-0 font-semibold">바꾸기</span>
          </button>
        ) : (
          <p className="mt-3 text-[14px] text-sub">종목을 골라 주세요.</p>
        )}

        {existing ? (
          // 오늘 이 종목 리포트가 이미 있으면 그것을 먼저 (종목 상세와 같은 규칙)
          <div className="mt-2">
            <Link
              to={`/reports/${existing.id}`}
              className="press flex h-13 w-full items-center justify-center gap-1.5 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark"
            >
              <Icon name="doc" className="size-5" />
              오늘 리포트 보기
            </Link>
            <p className="mt-1.5 text-center text-[13px] text-sub">
              {existing.requestedBy} 님이 만듦 · {reportStatusText(existing.status, !expert)}
            </p>
            <button
              type="button"
              disabled={request.isPending || full}
              onClick={create}
              className="press mx-auto mt-1 flex h-11 items-center gap-1 rounded-lg px-3 text-[14px] font-semibold text-sub hover:bg-fill disabled:opacity-40"
            >
              {request.isPending && <Spinner />}
              새로 만들기
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={!picked || checking || request.isPending || full}
            aria-busy={checking || undefined}
            onClick={create}
            className="press mt-2 flex h-13 w-full items-center justify-center gap-1.5 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
          >
            {request.isPending || checking ? <Spinner /> : <Icon name="doc" className="size-5" />}
            AI 리포트 만들기
          </button>
        )}
        <QuotaLine className="mt-2 text-center" />
        {request.isError && (
          <ErrorPanel
            kind={errorKindOf(request.error)}
            detail={expert ? errorMessage(request.error) : errorSentence(request.error)}
            onRetry={create}
            retrying={request.isPending}
            secondary={null}
            compact
            className="mt-3 bg-fill"
          />
        )}
      </div>
    </Card>
  );
}
