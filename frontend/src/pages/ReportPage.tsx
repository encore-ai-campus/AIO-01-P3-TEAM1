// /reports/:id: 주린이모드 켬(쉬운 보기, 기본)이면 components/reports/easy/EasyReport, 끔(전문가 보기)이면 아래 화면 그대로 —
// 머리 카드 → 실행 요약 띠 → 탭 3개 (리포트 / 진행 기록 / 자세히). 구성은 docs/tasks/05-프론트.md "화면 구성".
// 보기는 useViewMode(): "이 화면만 자세히 보기"는 ?view=expert (저장하지 않음). 분기는 이 파일 한 곳.
// Snapshot을 먼저 받고 SSE로 이어 받는다 (api/reports.ts). 예시 재생은 화면 안에서만 바뀌고 서버에는 아무것도 보내지 않는다.
import { Suspense, lazy, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { type Delivery, isFinished, useReportLive, useRequestReport } from "../api/reports";
import type { ReportDetail, SharedState, TraceEvent } from "../api/types";
import { SourceRecommendations } from "../components/autotrade/SourceRecommendations";
import { Icon } from "../components/Icon";
import { EduDocSection } from "../components/reports/EduDocSection";
import { PlanGraph } from "../components/reports/PlanGraph";
import { PolicyGuide } from "../components/reports/PolicyGuide";
import { ReplayBar, ScenarioPicker } from "../components/reports/ReplayControls";
import { RunSummary } from "../components/reports/RunSummary";
import { SharedStatePanel } from "../components/reports/SharedStatePanel";
import { AutoBadge, DeliveryBadge, ExampleTag, InjectedBadge, ReportStatusBadge } from "../components/reports/StatusChip";
import { TraceTimeline } from "../components/reports/TraceTimeline";
import { ViewToggle } from "../components/reports/ViewToggle";
import { EasyReport } from "../components/reports/easy/EasyReport";
import { Card, ErrorState, Notice, PageHeader, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { type ViewModeState, useViewMode } from "../hooks/useBeginnerMode";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { useReplay } from "../lib/reportExamples";
import { DISCLAIMER } from "../lib/plainText";
import { ERROR_LABEL, NOT_IMPLEMENTED, actorLabel, policyName } from "../lib/reports";

const Markdown = lazy(() => import("../components/reports/Markdown").then((m) => ({ default: m.Markdown })));

type Tab = "report" | "run" | "more";
const TABS: { value: Tab; label: string }[] = [
  { value: "report", label: "리포트" },
  { value: "run", label: "진행 기록" }, // Trace (사용자 용어 "실행 준비·실행 확인"과 겹치지 않게 — docs/컨셉변경계획.md 4-3)
  { value: "more", label: "자세히" },
];
const isTab = (v: string | null): v is Tab => TABS.some((t) => t.value === v);

function CardTitle({ id, title, sub, example }: { id: string; title: string; sub?: string; example?: boolean }) {
  return (
    <div className="mb-3">
      <h2 id={id} className="flex flex-wrap items-center gap-1.5 text-[17px] font-bold">
        {title}
        {example && <ExampleTag />}
      </h2>
      {sub && <p className="mt-0.5 text-[13px] leading-snug text-mute">{sub}</p>}
    </div>
  );
}

/** 실패한 리포트: 왜 실패했는지 사람이 읽을 말로 + 다시 신청 (같은 종목, 같은 장애 주입 설정). */
function FailureCard({ r, trace, state }: { r: ReportDetail; trace: TraceEvent[]; state: SharedState }) {
  const navigate = useNavigate();
  const request = useRequestReport();
  const last = [...trace].reverse().find((e) => e.action === "workflow_failed");
  const reason = typeof last?.details.reason === "string" ? last.details.reason : "";
  const errors = Object.entries(state.errors);
  return (
    <Card aria-labelledby="failure-title" className="border-2 border-up/40">
      <h2 id="failure-title" className="flex items-center gap-1.5 text-[17px] font-bold text-up">
        <Icon name="alert" className="size-5" />
        리포트를 만들지 못했습니다
      </h2>
      {reason && <p className="mt-1.5 text-[14px] leading-snug text-sub">{reason}</p>}
      {errors.length > 0 && (
        <ul aria-label="실패한 Agent" className="mt-2 space-y-1 text-[14px]">
          {errors.map(([id, msg]) => (
            <li key={id}>
              <b>{actorLabel(r.plan, id)}</b> <span className="text-sub">{ERROR_LABEL[msg as keyof typeof ERROR_LABEL] ?? msg}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[13px] text-mute">재시도와 대체 모델로도 복구하지 못했습니다. 어느 모델이 실패했는지는 &ldquo;진행 기록&rdquo; 탭에서 볼 수 있습니다.</p>
      <button
        type="button"
        disabled={request.isPending}
        onClick={() => request.mutate({ symbol: r.symbol, chaos: r.chaos }, { onSuccess: (n) => navigate(`/reports/${n.id}`) })}
        className="mt-3 flex h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
      >
        {request.isPending ? <Spinner /> : <Icon name="restart" className="size-4" />}
        다시 신청{r.chaos?.enabled ? " (같은 장애 주입 설정)" : ""}
      </button>
      {request.isError && (
        <Notice tone="error" className="mt-3">
          {errorMessage(request.error)}
        </Notice>
      )}
    </Card>
  );
}

export function ReportPage() {
  const { id } = useParams();
  const rid = Number(id);
  const view = useViewMode();
  const { data: r, isPending, isError, error, refetch, delivery } = useReportLive(rid);

  if (isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-40" />} back />
        <SkeletonCard lines={6} />
      </>
    );
  }
  if (isError) {
    return (
      <>
        <PageHeader title="AI 리포트" back />
        <Card>
          <ErrorState
            message={error instanceof ApiError && error.status === 404 ? "리포트를 찾을 수 없습니다." : errorMessage(error)}
            onRetry={() => void refetch()}
          />
        </Card>
      </>
    );
  }

  if (view.easy) {
    return (
      <>
        <PageHeader title={`${r.name} AI 리포트`} back />
        <EasyReport r={r} view={view} />
      </>
    );
  }
  return <ExpertReport r={r} delivery={delivery} view={view} />;
}

/** 전문가 보기 (주린이모드 끔 또는 ?view=expert): 예전 화면 그대로. 머리말 오른쪽에 "쉬운 보기" 전환만 더했다. */
function ExpertReport({ r, delivery, view }: { r: ReportDetail; delivery: Delivery; view: ViewModeState }) {
  const rid = r.id;
  const [params, setParams] = useSearchParams();
  const [first, setFirst] = useState<{ id: number; tab: Tab } | null>(null);
  const replay = useReplay(r.state.taskId || `report-${rid}`);

  // 예시 재생 중이면 그래프·타임라인·요약·State에 예시 사건을 보인다 (작업 계획은 실제 Registry 그대로)
  const ex = replay.active;
  const trace = ex ? replay.trace : r.trace;
  const state = ex ? replay.state : r.state;
  const finished = isFinished(r.status);
  // 기본 탭은 처음 받았을 때의 상태로 정한다: 끝났으면 리포트, 아니면 진행 기록. 보는 중에 끝나도 탭을 바꾸지 않는다.
  // 주소에 tab이 있으면 그것
  if (first?.id !== rid) setFirst({ id: rid, tab: finished ? "report" : "run" });
  const param = params.get("tab");
  const tab: Tab = isTab(param) ? param : (first?.id === rid ? first.tab : finished ? "report" : "run");
  // 다른 쿼리(?view=expert 등)는 그대로 둔다
  const setTab = (t: Tab) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        sp.set("tab", t);
        return sp;
      },
      { replace: true },
    );
  const startExample = () => setTab("run");

  return (
    <>
      <PageHeader title={`${r.name} AI 리포트`} back right={<ViewToggle view={view} compact />} />
      <div className="space-y-3 lg:space-y-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[14px] text-mute">
                {r.symbol} · {r.market === "KR" ? "국내" : "미국"} · 리포트 #{r.id}
              </p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[22px] font-bold tracking-tight">
                {r.name}
                {r.source === "auto" && <AutoBadge />}
                {r.chaosEnabled && <InjectedBadge />}
              </p>
            </div>
            <ReportStatusBadge status={r.status} className="h-8 px-2.5 text-[14px]" />
          </div>
          <p className="mt-2 text-[14px] text-sub">
            {r.requestedBy} 신청 · {formatDateTime(r.createdAt)}
            {r.startedAt && ` · 시작 ${formatDateTime(r.startedAt)}`}
            {r.finishedAt && ` · 종료 ${formatDateTime(r.finishedAt)}`}
          </p>
          <div className="mt-2">
            <DeliveryBadge delivery={delivery} />
          </div>
          {!r.plan.implemented && (
            <Notice tone="warn" className="mt-3">
              {NOT_IMPLEMENTED} &ldquo;예시 Trace 재생&rdquo;으로 흐름을 확인할 수 있습니다.
            </Notice>
          )}
        </Card>

        <RunSummary
          plan={r.plan}
          trace={trace}
          state={state}
          costUsd={r.costUsd}
          example={ex}
          onShowReport={!ex && r.status === "completed" && tab !== "report" ? () => setTab("report") : undefined}
        />

        <div role="tablist" aria-label="리포트 화면" className="flex gap-1">
          {TABS.map((t) => (
            <button
              key={t.value}
              role="tab"
              type="button"
              aria-selected={tab === t.value}
              aria-controls={`panel-${t.value}`}
              id={`tab-${t.value}`}
              onClick={() => setTab(t.value)}
              className={cn(
                "h-11 min-w-0 flex-1 rounded-full px-3 text-[15px] font-semibold transition-colors sm:flex-none sm:px-5",
                tab === t.value ? "bg-ink text-white" : "bg-card text-sub hover:bg-line",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "report" && (
          <div role="tabpanel" id="panel-report" aria-labelledby="tab-report" className="space-y-3 lg:space-y-4">
            {r.status === "failed" && <FailureCard r={r} trace={r.trace} state={r.state} />}
            <SourceRecommendations source="report" sourceId={r.id} />
            <Card aria-labelledby="content-title">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <CardTitle id="content-title" title="리포트 본문" />
                {(r.hasPdf || r.status === "completed") && (
                  <a
                    href={`/api/reports/${r.id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex h-9 items-center gap-1 rounded-xl bg-fill px-3 text-[14px] font-semibold text-ink hover:bg-line"
                  >
                    <Icon name="download" className="size-4" />
                    PDF 내려받기
                  </a>
                )}
              </div>
              {r.content ? (
                <Suspense fallback={<SkeletonCard lines={4} className="px-0" />}>
                  <Markdown>{r.content}</Markdown>
                </Suspense>
              ) : (
                <div className="rounded-xl bg-fill px-4 py-6 text-center">
                  <p className="text-[15px] text-mute">
                    {r.plan.implemented ? (finished ? "본문이 없습니다." : "리포트를 쓰는 중입니다.") : "리포트 본문은 Agent 구현 뒤에 표시됩니다 (미구현)"}
                  </p>
                  <button type="button" onClick={() => setTab("run")} className="mt-2 h-9 rounded-xl bg-card px-3 text-[14px] font-semibold text-brand hover:bg-line">
                    진행 기록 보기
                  </button>
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === "run" && (
          <div role="tabpanel" id="panel-run" aria-labelledby="tab-run" className="space-y-3 lg:space-y-4">
            {ex ? (
              <ReplayBar replay={replay} />
            ) : (
              r.trace.length === 0 && (
                <Card aria-label="예시 Trace 재생">
                  <ScenarioPicker replay={replay} onStart={startExample} />
                </Card>
              )
            )}
            <Card aria-labelledby="plan-title">
              <CardTitle id="plan-title" title="작업 계획(Planner)" sub={`${r.plan.title} · 실패 정책 ${policyName(r.plan.failurePolicy)} · 노드를 누르면 자세히`} example={ex} />
              <PlanGraph plan={r.plan} trace={trace} currentStep={state.currentStep} />
            </Card>
            <Card aria-labelledby="trace-title">
              <CardTitle id="trace-title" title="Trace 타임라인" sub="새 사건은 아래에 붙습니다." example={ex} />
              <TraceTimeline trace={trace} plan={r.plan} />
            </Card>
          </div>
        )}

        {tab === "more" && (
          <div role="tabpanel" id="panel-more" aria-labelledby="tab-more" className="space-y-3 lg:space-y-4">
            <Card aria-label="예시 Trace 재생">
              <ScenarioPicker replay={replay} onStart={startExample} />
            </Card>
            <Card aria-labelledby="state-title">
              <CardTitle id="state-title" title="Shared State" example={ex} />
              <SharedStatePanel state={state} plan={r.plan} />
            </Card>
            <Card aria-labelledby="policy-title">
              <CardTitle id="policy-title" title="정책 안내" sub="부분 실패 정책과 Handoff 계약 (교육용 문서 04 Distributed Collaboration)" />
              <PolicyGuide plan={r.plan} />
            </Card>
            <EduDocSection />
          </div>
        )}
        <p className="px-1 text-[12px] leading-snug text-mute">{DISCLAIMER}</p>
      </div>
    </>
  );
}
