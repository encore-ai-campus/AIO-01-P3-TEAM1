// 리포트 목록 맨 위의 만들기 카드: 종목 검색 → 고르기 → 큰 버튼 "AI 리포트 만들기" + 오늘 남은 횟수 (D-7).
// 장애 주입(ChaosForm)은 전문가 보기에서만 (docs/컨셉변경계획.md 4-2 "리포트 목록").
import { useState } from "react";
import { useNavigate } from "react-router";
import { errorMessage } from "../../api/client";
import { useSearch } from "../../api/queries";
import { useReportQuota, useRequestReport } from "../../api/reports";
import type { ChaosRequest, ExecutionPlan, StockItem } from "../../api/types";
import { cn } from "../../lib/cn";
import { errorSentence } from "../../lib/plainText";
import { useDebounced } from "../../lib/useDebounced";
import { Icon } from "../Icon";
import { Card, ErrorState, Notice, Skeleton, Spinner } from "../ui";
import { ChaosForm } from "./ChaosForm";
import { QuotaLine } from "./QuotaLine";

export function CreateReportCard({ plan, expert }: { plan: ExecutionPlan | undefined; expert: boolean }) {
  const navigate = useNavigate();
  const [chaos, setChaos] = useState<ChaosRequest | null>(null);
  const workers = plan ? plan.workers.filter((w) => plan.steps.some((st) => st.workers.includes(w.id))) : [];
  const [input, setInput] = useState("");
  const [picked, setPicked] = useState<StockItem | null>(null);
  const q = useDebounced(input.trim(), 300);
  const { data, isFetching, isError, error } = useSearch(q);
  const request = useRequestReport();
  const quota = useReportQuota();
  const results = q ? (data?.results ?? []).slice(0, 8) : [];
  const full = quota.data?.remaining === 0;

  return (
    <Card aria-labelledby="request-title">
      <h2 id="request-title" className="text-[17px] font-bold">
        리포트 만들기
      </h2>
      <p className="mt-0.5 text-[13px] leading-snug text-mute">
        {expert
          ? "종목을 골라 만들면 팀 리포트 목록에 기록됩니다."
          : "종목을 고르면 AI 담당자들이 시세·재무·뉴스를 조사하고, 리포트를 쓰고, 검토까지 해요."}
      </p>
      <label className="mt-3 flex h-12 items-center gap-2 rounded-2xl bg-fill px-4 focus-within:ring-2 focus-within:ring-brand">
        <Icon name="search" className="size-5 text-mute" />
        <span className="sr-only">종목 검색</span>
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="종목명이나 종목코드 (예: 삼성전자, 005930)"
          className="h-full min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-mute"
        />
      </label>

      {q && (
        <div className="mt-2">
          {isError ? (
            <ErrorState message={errorMessage(error)} />
          ) : isFetching && !data ? (
            <div className="space-y-3 p-3">
              <Skeleton className="h-5 w-2/3" />
              <Skeleton className="h-5 w-1/2" />
            </div>
          ) : results.length === 0 ? (
            <p className="py-4 text-center text-[14px] text-mute">"{q}"에 맞는 종목이 없습니다.</p>
          ) : (
            <ul aria-label="검색한 종목" className="divide-y divide-line">
              {results.map((r) => {
                const on = picked?.symbol === r.symbol;
                return (
                  <li key={r.symbol}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPicked(r)}
                      className={cn("flex min-h-14 w-full items-center gap-3 rounded-xl px-3 py-2 text-left", on ? "bg-brand-soft" : "hover:bg-fill")}
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
        </div>
      )}

      {expert && (
        <div className="mt-3">
          <ChaosForm value={chaos} onChange={setChaos} workers={workers} />
        </div>
      )}

      <p className="mt-3 text-[14px] text-sub">
        {picked ? (
          <>
            선택: <b className="text-ink">{picked.name}</b> ({picked.symbol})
          </>
        ) : (
          "종목을 골라 주세요."
        )}
      </p>
      <button
        type="button"
        disabled={!picked || request.isPending || full}
        onClick={() =>
          picked && request.mutate({ symbol: picked.symbol, chaos: expert ? chaos : null }, { onSuccess: (r) => navigate(`/reports/${r.id}`) })
        }
        className="mt-2 flex h-13 w-full items-center justify-center gap-1.5 rounded-2xl bg-brand text-[17px] font-bold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
      >
        {request.isPending ? <Spinner /> : <Icon name="doc" className="size-5" />}
        AI 리포트 만들기
      </button>
      <QuotaLine className="mt-2 text-center" />
      {request.isError && (
        <Notice tone="error" className="mt-3">
          {expert ? errorMessage(request.error) : errorSentence(request.error)}
        </Notice>
      )}
    </Card>
  );
}
