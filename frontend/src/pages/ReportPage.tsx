// /reports/:id: 리포트 본문, 실행 계획 그래프, Trace 타임라인, Shared State, 정책 안내, 개념 문서 탭, 예시 Trace 재생.
// Snapshot을 먼저 받고 SSE로 이어 받는다 (api/reports.ts). 예시 재생은 화면 안에서만 바뀌고 서버에는 아무것도 보내지 않는다.
import { Suspense, lazy } from "react";
import { useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useReportLive } from "../api/reports";
import { LazyEduDoc } from "../components/reports/EduDocSection";
import { PlanGraph } from "../components/reports/PlanGraph";
import { PolicyGuide } from "../components/reports/PolicyGuide";
import { ExampleBanner, ReplayControls } from "../components/reports/ReplayControls";
import { SharedStatePanel } from "../components/reports/SharedStatePanel";
import { DeliveryBadge, ExampleTag, ReportStatusBadge } from "../components/reports/StatusChip";
import { TraceTimeline } from "../components/reports/TraceTimeline";
import { Card, ErrorState, Notice, PageHeader, Skeleton, SkeletonCard } from "../components/ui";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { useReplay } from "../lib/reportExamples";
import { NOT_IMPLEMENTED, policyName } from "../lib/reports";

const Markdown = lazy(() => import("../components/reports/Markdown").then((m) => ({ default: m.Markdown })));

type Tab = "report" | "doc";
const TABS: { value: Tab; label: string }[] = [
  { value: "report", label: "리포트·Trace" },
  { value: "doc", label: "개념 문서" },
];

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

export function ReportPage() {
  const { id } = useParams();
  const rid = Number(id);
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "doc" ? "doc" : "report";
  const { data: r, isPending, isError, error, refetch, delivery } = useReportLive(rid);
  const replay = useReplay(r?.state.taskId ?? `report-${id}`);

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

  // 예시 재생 중이면 그래프·타임라인·State에 예시 사건을 보인다 (실행 계획은 실제 Registry 그대로)
  const ex = replay.active;
  const trace = ex ? replay.trace : r.trace;
  const state = ex ? replay.state : r.state;

  return (
    <>
      <PageHeader title={`${r.name} AI 리포트`} back />
      <div className="space-y-3 lg:space-y-4">
        <Card>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[14px] text-mute">
                {r.symbol} · {r.market === "KR" ? "국내" : "미국"} · 리포트 #{r.id}
              </p>
              <p className="mt-0.5 text-[22px] font-bold tracking-tight">{r.name}</p>
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
              {NOT_IMPLEMENTED} 아래 &ldquo;예시 Trace 재생&rdquo;으로 흐름을 확인할 수 있습니다.
            </Notice>
          )}
        </Card>

        <div role="tablist" aria-label="리포트 화면" className="flex gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.value}
              role="tab"
              type="button"
              aria-selected={tab === t.value}
              aria-controls={`panel-${t.value}`}
              id={`tab-${t.value}`}
              onClick={() => setParams(t.value === "report" ? {} : { tab: t.value }, { replace: true })}
              className={cn(
                "h-11 shrink-0 rounded-full px-4 text-[15px] font-semibold transition-colors",
                tab === t.value ? "bg-ink text-white" : "bg-card text-sub hover:bg-line",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === "doc" ? (
          <div role="tabpanel" id="panel-doc" aria-labelledby="tab-doc">
            <Card>
              <LazyEduDoc />
            </Card>
          </div>
        ) : (
          <div role="tabpanel" id="panel-report" aria-labelledby="tab-report" className="space-y-3 lg:space-y-4">
            <Card aria-label="예시 Trace 재생">
              <ReplayControls replay={replay} />
            </Card>
            {ex && <ExampleBanner />}

            <Card aria-labelledby="content-title">
              <CardTitle id="content-title" title="리포트 본문" />
              {r.content ? (
                <Suspense fallback={<SkeletonCard lines={4} className="px-0" />}>
                  <Markdown>{r.content}</Markdown>
                </Suspense>
              ) : (
                <p className="rounded-xl bg-fill px-4 py-6 text-center text-[15px] text-mute">
                  리포트 본문은 Agent 구현 뒤에 표시됩니다 (미구현)
                </p>
              )}
            </Card>

            <Card aria-labelledby="plan-title">
              <CardTitle
                id="plan-title"
                title="실행 계획"
                sub={`${r.plan.title} · 실패 정책 ${policyName(r.plan.failurePolicy)} · 노드 상태는 Trace에서 그 Agent의 마지막 사건으로 정합니다`}
                example={ex}
              />
              <PlanGraph plan={r.plan} trace={trace} currentStep={state.currentStep} />
            </Card>

            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start lg:gap-4">
              <Card aria-labelledby="trace-title">
                <CardTitle id="trace-title" title="Trace 타임라인" sub="모든 실행 사건을 step 순서로 남깁니다. 새 사건은 아래에 붙습니다." example={ex} />
                <TraceTimeline trace={trace} plan={r.plan} />
              </Card>
              <Card aria-labelledby="state-title">
                <CardTitle id="state-title" title="Shared State" example={ex} />
                <SharedStatePanel state={state} plan={r.plan} />
              </Card>
            </div>

            <Card aria-labelledby="policy-title">
              <CardTitle id="policy-title" title="정책 안내" sub="부분 실패 정책과 Handoff 계약 (교육용 문서 04 Distributed Collaboration)" />
              <PolicyGuide plan={r.plan} />
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
