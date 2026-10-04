// /reports: 복구 지표 미니 카드 → [신청(장애 주입 포함) | 팀 리포트(필터·배지)] → 오늘의 선별 결과 → (접힘) 실행 계획 미리 보기 → (접힘) 교육용 문서.
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { errorMessage } from "../api/client";
import { useReportPlan, useReports, useSearch } from "../api/queries";
import { useRequestReport, useScreening } from "../api/reports";
import type { ChaosRequest, ExecutionPlan, StockItem } from "../api/types";
import { Icon } from "../components/Icon";
import { EduDocSection } from "../components/reports/EduDocSection";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ChaosForm } from "../components/reports/ChaosForm";
import { AutoBadge, ExampleTag, InjectedBadge, ReportStatusBadge } from "../components/reports/StatusChip";
import { Card, EmptyState, ErrorState, Notice, PageHeader, Segmented, Skeleton, Spinner } from "../components/ui";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { NOT_IMPLEMENTED, formatCost, policyName } from "../lib/reports";
import { useDebounced } from "../lib/useDebounced";

function RequestCard({ plan }: { plan: ExecutionPlan | undefined }) {
  const navigate = useNavigate();
  const [chaos, setChaos] = useState<ChaosRequest | null>(null);
  const workers = plan ? plan.workers.filter((w) => plan.steps.some((st) => st.workers.includes(w.id))) : [];
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

      <div className="mt-3">
        <ChaosForm value={chaos} onChange={setChaos} workers={workers} />
      </div>

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
          onClick={() => picked && request.mutate({ symbol: picked.symbol, chaos }, { onSuccess: (r) => navigate(`/reports/${r.id}`) })}
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

type Filter = "all" | "auto" | "chaos";

function ReportList() {
  const [filter, setFilter] = useState<Filter>("all");
  const { data, isPending, isError, error, refetch } = useReports(filter === "auto" ? { source: "auto" } : {});
  // "장애 주입"은 API에 조건이 없어 받은 목록에서 거른다. "자동"은 서버가 source를 아직 모를 수 있어 한 번 더 거른다
  const rows = (data?.results ?? []).filter((r) => (filter === "auto" ? r.source === "auto" : filter === "chaos" ? r.chaosEnabled : true));
  return (
    <Card aria-labelledby="list-title" className="px-0 pb-2">
      <div className="px-5">
        <h2 id="list-title" className="text-[17px] font-bold">
          팀 리포트
        </h2>
        <p className="mt-0.5 text-[13px] text-mute">팀 전체 공용 · 최신순</p>
        <Segmented
          label="리포트 거르기"
          className="mt-2.5"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "전체" },
            { value: "auto", label: "자동" },
            { value: "chaos", label: "장애 주입" },
          ]}
        />
      </div>
      {isPending ? (
        <div className="space-y-3 p-5">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-5 w-1/2" />
        </div>
      ) : isError ? (
        <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState>{filter === "all" ? "아직 신청한 리포트가 없습니다." : filter === "auto" ? "자동 리포트가 아직 없습니다." : "장애 주입을 켠 리포트가 아직 없습니다."}</EmptyState>
      ) : (
        <ul aria-label="리포트 목록" className="mt-2 divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id}>
              <Link to={`/reports/${r.id}`} className="flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-fill/60">
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate text-[16px] font-semibold">{r.name}</span>
                    {r.source === "auto" && <AutoBadge />}
                    {r.chaosEnabled && <InjectedBadge />}
                  </span>
                  <span className="block text-[13px] text-mute">
                    {r.symbol} · {r.requestedBy} · {formatDateTime(r.createdAt)}
                    {typeof r.costUsd === "number" && ` · ${formatCost(r.costUsd)}`}
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

const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "-");

/** 오늘의 선별 결과: 상위 종목·점수, 탈락 사유 요약. */
function ScreeningPanel() {
  const { data, isPending, isError } = useScreening();
  const s = data?.data;
  const reasons = new Map<string, number>();
  for (const d of s?.dropped ?? []) reasons.set(text(d.reason), (reasons.get(text(d.reason)) ?? 0) + 1);
  return (
    <Card aria-labelledby="screening-title">
      <h2 id="screening-title" className="flex flex-wrap items-center gap-1.5 text-[17px] font-bold">
        오늘의 선별 결과 {data?.example && <ExampleTag />}
      </h2>
      {isPending ? (
        <Skeleton className="mt-3 h-16 w-full" />
      ) : isError || !s ? (
        <p className="mt-2 text-[14px] text-mute">오늘 선별이 아직 없습니다.</p>
      ) : (
        <>
          <p className="mt-0.5 text-[13px] text-mute">
            {formatDateTime(s.at)} · 거래대금 상위 {s.rankCount}개 중 {s.eligibleCount}개 대상 · {s.picks.length}개 선별
          </p>
          <ol aria-label="선별 종목" className="mt-3 grid gap-2 sm:grid-cols-3">
            {s.picks.map((p, i) => (
              <li key={text(p.symbol)} className="flex items-center gap-2.5 rounded-xl bg-fill px-3 py-2.5">
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-bold text-white">{i + 1}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-semibold">{text(p.name)}</span>
                  <span className="block text-[12px] text-mute">
                    {text(p.symbol)} · 거래대금 {text(p.tradingAmountRank)}위
                  </span>
                </span>
                <span className="text-[17px] font-bold tabular-nums">{text(p.score)}</span>
              </li>
            ))}
          </ol>
          {reasons.size > 0 && (
            <p className="mt-2.5 text-[13px] text-sub">
              탈락 {s.dropped.length}개: {[...reasons].map(([r, n]) => `${r} ${n}`).join(" · ")}
              {s.excluded.length > 0 && ` · 제외(ETF 등) ${s.excluded.length}개`}
            </p>
          )}
        </>
      )}
    </Card>
  );
}

/** 실행 계획 미리 보기 (접힘). */
function PlanPreview({ plan, error, onRetry }: { plan: ExecutionPlan | undefined; error: unknown; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card aria-labelledby="plan-title">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left">
        <span>
          <span id="plan-title" className="block text-[17px] font-bold">
            실행 계획 미리 보기
          </span>
          <span className="block text-[13px] text-mute">
            {plan ? `${plan.title} · 실패 정책 ${policyName(plan.failurePolicy)} · 신청한 리포트는 이 계획대로 실행됩니다` : "Agent 구성과 순서"}
          </span>
        </span>
        <Icon name="chevron" className={cn("size-5 shrink-0 text-mute transition-transform", open ? "-rotate-90" : "rotate-90")} />
      </button>
      {open && (
        <div className="mt-3">
          {plan ? <PlanGraph plan={plan} trace={[]} currentStep={null} /> : error ? <ErrorState message={errorMessage(error)} onRetry={onRetry} /> : <Skeleton className="h-40 w-full" />}
        </div>
      )}
    </Card>
  );
}

export function ReportsPage() {
  const { data: plan, error, refetch } = useReportPlan();
  return (
    <>
      <PageHeader title="AI 리포트" />
      <div className="space-y-3 lg:space-y-4">
        {plan && !plan.implemented && <Notice tone="warn">{NOT_IMPLEMENTED}</Notice>}
        <div className="grid gap-3 lg:grid-cols-2 lg:items-start lg:gap-4">
          <RequestCard plan={plan} />
          <ReportList />
        </div>
        <ScreeningPanel />
        <PlanPreview plan={plan} error={error} onRetry={() => void refetch()} />
        <EduDocSection />
      </div>
    </>
  );
}
