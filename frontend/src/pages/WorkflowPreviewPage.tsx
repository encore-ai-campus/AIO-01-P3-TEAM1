import { type CSSProperties, useState } from "react";
import { Link } from "react-router";
import { FeedbackLoopPanel } from "../components/reports/FeedbackLoopPanel";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ReplayBar, ScenarioPicker } from "../components/reports/ReplayControls";
import { RunSummary } from "../components/reports/RunSummary";
import { SharedStatePanel } from "../components/reports/SharedStatePanel";
import { TraceTimeline } from "../components/reports/TraceTimeline";
import { useHeight } from "../components/reports/useHeight";
import { Card, PageHeader } from "../components/ui";
import { useIsPc } from "../hooks/useIsPc";
import { cn } from "../lib/cn";
import { useReplay } from "../lib/reportExamples";
import { reportPlan } from "../mocks/seed";

/** VITE_MOCK=1 전용: 백엔드 없이 Agent Workflow의 모든 발표 상태를 눈으로 확인한다. */
export function WorkflowPreviewPage() {
  const plan = reportPlan();
  const replay = useReplay("frontend-workflow-preview");
  // PC: 재생 띠가 위 바 아래에 붙고, 그 높이(+12px)를 --replay-h로 넘겨 Trace 카드·따라가는 단계가 띠 밑에 숨지 않게 (리포트 상세 '진행 기록'과 같다)
  const isPc = useIsPc();
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
  const barH = useHeight(isPc ? barEl : null);
  const vars = { "--replay-h": `${isPc && barH > 0 ? barH + 12 : 0}px` } as CSSProperties;

  return (
    <>
      <PageHeader title="Agent Workflow 미리보기" back />
      <div className="space-y-3 lg:space-y-4">
        <Card>
          {/* 화면 제목(h1)은 PageHeader 하나 — 이 카드는 그 아래 단계(h2) */}
          <h2 className="text-[18px] font-bold">백엔드 없이 화면 검수</h2>
          <p className="mt-1 text-[14px] leading-relaxed text-sub">
            프로젝트에 이미 정의된 예시 Trace를 재생합니다. 실제 API·LLM은 호출하지 않으며 화면에는 계속 <b>예시 데이터</b>라고 표시됩니다.
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-mute">
            계획서 부록 A8의 DR-LLM-01~04, DR-CRT-01~02, DR-SEC-01 중 프론트 화면으로 확인할 수 있는 상황을 모았습니다.
          </p>
          <Link
            to="/ui/errors"
            className="press mt-3 inline-flex h-11 items-center rounded-xl bg-fill px-3.5 text-[14px] font-semibold text-brand-ink hover:bg-line"
          >
            로딩·빈 화면·오류 화면 보기
          </Link>
        </Card>

        <Card aria-label="예시 Workflow 선택">
          <ScenarioPicker replay={replay} />
        </Card>

        {replay.active ? (
          // PC 넓은 화면(xl): 리포트 상세 '진행 기록'과 같은 두 칸 — 왼쪽 작업 계획(가로 띠)·State, 오른쪽 Trace(따라오며 안에서 스크롤)
          <div style={vars} className={cn("space-y-3 lg:space-y-4", "xl:grid xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start xl:gap-4 xl:space-y-0 2xl:grid-cols-[minmax(0,1fr)_440px]")}>
            <div className="lg:sticky lg:top-(--rail-top) lg:z-(--z-header) xl:col-span-2">
              <ReplayBar replay={replay} ref={setBarEl} />
            </div>
            <RunSummary plan={plan} trace={replay.trace} state={replay.state} costUsd={null} example className="xl:col-span-2" />
            <FeedbackLoopPanel trace={replay.trace} plan={plan} example className="xl:col-span-2" />
            <Card aria-labelledby="preview-plan-title" className="xl:col-start-1">
              <h2 id="preview-plan-title" className="mb-3 text-[17px] font-bold">
                작업 계획(Planner) · Agent 상태
              </h2>
              <PlanGraph plan={plan} trace={replay.trace} currentStep={replay.state.currentStep} lanes follow={isPc} />
            </Card>
            <Card
              aria-labelledby="preview-trace-title"
              className="xl:sticky xl:top-[calc(var(--rail-top)+var(--replay-h))] xl:col-start-2 xl:row-span-2 xl:max-h-[calc(100dvh-var(--rail-top)-var(--replay-h)-2rem)] xl:overflow-y-auto xl:overscroll-contain"
            >
              <h2 id="preview-trace-title" className="mb-3 text-[17px] font-bold">
                Trace Timeline · 실행 사건
              </h2>
              <TraceTimeline trace={replay.trace} plan={plan} />
            </Card>
            <Card aria-labelledby="preview-state-title" className="xl:col-start-1">
              <h2 id="preview-state-title" className="mb-3 text-[17px] font-bold">
                Shared State · 공유 실행 상태
              </h2>
              <SharedStatePanel state={replay.state} plan={plan} />
            </Card>
          </div>
        ) : (
          <Card>
            <p className="py-5 text-center text-[14px] leading-relaxed text-mute">
              위에서 시나리오를 선택하면 Agent 상태·Trace State·Feedback Loop·실패·복구 과정이 순서대로 움직입니다.
            </p>
          </Card>
        )}
      </div>
    </>
  );
}
