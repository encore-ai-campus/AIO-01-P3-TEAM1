// /reports: 종목 검색 → 리포트 신청, 팀 리포트 목록, 실행 계획 미리 보기, 교육용 문서.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { errorMessage } from "../api/client";
import { useReportPlan, useReports, useSearch } from "../api/queries";
import { useRequestReport } from "../api/reports";
import type { StockItem } from "../api/types";
import { Icon } from "../components/Icon";
import { EduDocSection } from "../components/reports/EduDocSection";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ReportStatusBadge } from "../components/reports/StatusChip";
import { Card, EmptyState, ErrorState, Notice, PageHeader, Skeleton, Spinner } from "../components/ui";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { NOT_IMPLEMENTED, policyName } from "../lib/reports";
import { useDebounced } from "../lib/useDebounced";

function RequestCard() {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<StockItem | null>(null);
  const q = useDebounced(text.trim(), 300);
  const { data, isFetching, isError, error } = useSearch(q);
  const request = useRequestReport();
  const results = q ? (data?.results ?? []).slice(0, 8) : [];

  return (
    <Card aria-labelledby="request-title">
      <h2 id="request-title" className="text-[17px] font-bold">
        리포트 신청
      </h2>
      <p className="mt-0.5 text-[13px] text-mute">종목을 골라 신청하면 팀 리포트 목록에 기록됩니다.</p>
      <label className="mt-3 flex h-12 items-center gap-2 rounded-2xl bg-fill px-4 focus-within:ring-2 focus-within:ring-brand">
        <Icon name="search" className="size-5 text-mute" />
        <span className="sr-only">종목 검색</span>
        <input
          type="search"
          value={text}
          onChange={(e) => setText(e.target.value)}
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

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <p className="text-[14px] text-sub">
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
          disabled={!picked || request.isPending}
          onClick={() => picked && request.mutate(picked.symbol, { onSuccess: (r) => navigate(`/reports/${r.id}`) })}
          className="flex h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:cursor-not-allowed disabled:opacity-40"
        >
          {request.isPending ? <Spinner /> : <Icon name="doc" className="size-4" />}
          리포트 신청
        </button>
      </div>
      {request.isError && (
        <Notice tone="error" className="mt-3">
          {errorMessage(request.error)}
        </Notice>
      )}
    </Card>
  );
}

function ReportList() {
  const { data, isPending, isError, error, refetch } = useReports();
  return (
    <Card aria-labelledby="list-title" className="px-0 pb-2">
      <div className="px-5">
        <h2 id="list-title" className="text-[17px] font-bold">
          팀 리포트
        </h2>
        <p className="mt-0.5 text-[13px] text-mute">팀 전체 공용 · 최신순</p>
      </div>
      {isPending ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : isError ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : data.results.length === 0 ? (
        <EmptyState>아직 신청한 리포트가 없습니다.</EmptyState>
      ) : (
        <ul aria-label="리포트 목록" className="mt-2 divide-y divide-line">
          {data.results.map((r) => (
            <li key={r.id}>
              <Link to={`/reports/${r.id}`} className="flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-fill/60">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-semibold">{r.name}</span>
                  <span className="block text-[13px] text-mute">
                    {r.symbol} · {r.requestedBy} · {formatDateTime(r.createdAt)}
                  </span>
                </span>
                <ReportStatusBadge status={r.status} />
                <Icon name="chevron" className="size-4 text-mute" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

export function ReportsPage() {
  const { data: plan, isError, error, refetch } = useReportPlan();
  return (
    <>
      <PageHeader title="AI 리포트" />
      <div className="space-y-3 lg:space-y-4">
        {plan && !plan.implemented && <Notice tone="warn">{NOT_IMPLEMENTED}</Notice>}
        <div className="grid gap-3 lg:grid-cols-2 lg:items-start lg:gap-4">
          <RequestCard />
          <ReportList />
        </div>
        <Card aria-labelledby="plan-title">
          <h2 id="plan-title" className="text-[17px] font-bold">
            실행 계획 미리 보기
          </h2>
          {plan ? (
            <>
              <p className="mt-0.5 mb-3 text-[13px] text-mute">
                {plan.title} · 실패 정책 {policyName(plan.failurePolicy)} · 신청한 리포트는 이 계획대로 실행됩니다 (지금은 모두 대기)
              </p>
              <PlanGraph plan={plan} trace={[]} currentStep={null} />
            </>
          ) : isError ? (
            <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
          ) : (
            <Skeleton className="mt-3 h-40 w-full" />
          )}
        </Card>
        <EduDocSection />
      </div>
    </>
  );
}
