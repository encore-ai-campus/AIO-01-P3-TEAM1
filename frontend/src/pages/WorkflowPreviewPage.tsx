import { Link } from "react-router";
import { FeedbackLoopPanel } from "../components/reports/FeedbackLoopPanel";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ReplayBar, ScenarioPicker } from "../components/reports/ReplayControls";
import { RunSummary } from "../components/reports/RunSummary";
import { SharedStatePanel } from "../components/reports/SharedStatePanel";
import { TraceTimeline } from "../components/reports/TraceTimeline";
import { Card, PageHeader } from "../components/ui";
import { useReplay } from "../lib/reportExamples";
import { reportPlan } from "../mocks/seed";

/** VITE_MOCK=1 전용: 백엔드 없이 Agent Workflow의 모든 발표 상태를 눈으로 확인한다. */
export function WorkflowPreviewPage() {
  const plan = reportPlan();
  const replay = useReplay("frontend-workflow-preview");

  return (
    <>
      <PageHeader title="Agent Workflow 미리보기" back />
      <div className="space-y-3 lg:space-y-4">
        <Card>
          <h1 className="text-[18px] font-bold">백엔드 없이 화면 검수</h1>
          <p className="mt-1 text-[14px] leading-relaxed text-sub">
            프로젝트에 이미 정의된 예시 Trace를 재생합니다. 실제 API·LLM은 호출하지 않으며 화면에는 계속 <b>예시 데이터</b>라고 표시됩니다.
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-mute">
            TEAM_DEV_PLAN의 DR-LLM-01~04, DR-CRT-01~02, DR-SEC-01 중 프론트 화면으로 확인할 수 있는 상황을 모았습니다.
          </p>
          <Link
            to="/ui/errors"
            className="press mt-3 inline-flex h-11 items-center rounded-xl bg-fill px-3.5 text-[14px] font-semibold text-brand-ink hover:bg-line"
          >
            로딩·빈 화면·오류 화면 보기
          </Link>
        </Card>

        <>
            <Card aria-label="예시 Workflow 선택">
              <ScenarioPicker replay={replay} />
            </Card>

            {replay.active ? (
              <>
                <ReplayBar replay={replay} />
                <RunSummary plan={plan} trace={replay.trace} state={replay.state} costUsd={null} example />
                <FeedbackLoopPanel trace={replay.trace} plan={plan} example />
                <Card aria-labelledby="preview-plan-title">
                  <h2 id="preview-plan-title" className="mb-3 text-[17px] font-bold">작업 계획(Planner) · Agent 상태</h2>
                  <PlanGraph plan={plan} trace={replay.trace} currentStep={replay.state.currentStep} />
                </Card>
                <Card aria-labelledby="preview-trace-title">
                  <h2 id="preview-trace-title" className="mb-3 text-[17px] font-bold">Trace Timeline · 실행 사건</h2>
                  <TraceTimeline trace={replay.trace} plan={plan} />
                </Card>
                <Card aria-labelledby="preview-state-title">
                  <h2 id="preview-state-title" className="mb-3 text-[17px] font-bold">Shared State · 공유 실행 상태</h2>
                  <SharedStatePanel state={replay.state} plan={plan} />
                </Card>
              </>
            ) : (
              <Card>
                <p className="py-5 text-center text-[14px] leading-relaxed text-mute">
                  위에서 시나리오를 선택하면 Agent 상태·Trace State·Feedback Loop·실패·복구 과정이 순서대로 움직입니다.
                </p>
              </Card>
            )}
        </>
      </div>
    </>
  );
}
