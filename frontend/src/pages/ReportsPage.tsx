// /reports: 주린이모드 켬(쉬운 보기)·끔(전문가 보기) 공통으로 [만들기 카드 | 칩 "내 리포트 · 팀 리포트 · 교차검증 분석" 목록].
// 전문가 보기에서만: 만들기 카드의 장애 주입, 팀 리포트의 전체·자동·장애 주입 거르기, 오늘의 선별 결과, (접힘) 작업 계획(Planner) 미리 보기, (접힘) 교육용 문서
// (docs/컨셉변경계획.md 4-2 "리포트 목록" — 장애 주입·작업 계획·개념 문서는 전문가 보기·관리자 화면으로).
import { useState } from "react";
import { errorMessage } from "../api/client";
import { useReportPlan } from "../api/queries";
import { useScreening } from "../api/reports";
import type { ExecutionPlan } from "../api/types";
import { Icon } from "../components/Icon";
import { CreateReportCard } from "../components/reports/CreateReportCard";
import { EduDocSection } from "../components/reports/EduDocSection";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ReportList } from "../components/reports/ReportList";
import { ExampleTag } from "../components/reports/StatusChip";
import { ViewToggle } from "../components/reports/ViewToggle";
import { Card, ErrorState, Notice, PageHeader, Skeleton } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { NOT_IMPLEMENTED, policyName } from "../lib/reports";

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

/** 작업 계획(Planner) 미리 보기 (접힘). 사용자 용어 "실행 준비·실행 확인"과 겹치지 않게 "실행 계획"이라 부르지 않는다. */
function PlanPreview({ plan, error, onRetry }: { plan: ExecutionPlan | undefined; error: unknown; onRetry: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card aria-labelledby="plan-title">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 text-left">
        <span>
          <span id="plan-title" className="block text-[17px] font-bold">
            작업 계획(Planner) 미리 보기
          </span>
          <span className="block text-[13px] text-mute">
            {plan ? `${plan.title} · 실패 정책 ${policyName(plan.failurePolicy)} · 신청한 리포트는 이 계획대로 만들어집니다` : "Agent 구성과 순서"}
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
  const view = useViewMode();
  const expert = view.expert;
  const { data: plan, error, refetch } = useReportPlan();
  return (
    <>
      <PageHeader title="AI 리포트" right={<ViewToggle view={view} compact />} />
      <div className="space-y-3 lg:space-y-4">
        {expert && plan && !plan.implemented && <Notice tone="warn">{NOT_IMPLEMENTED}</Notice>}
        <div className="grid gap-3 lg:grid-cols-2 lg:items-start lg:gap-4">
          <CreateReportCard plan={plan} expert={expert} />
          <ReportList expert={expert} />
        </div>
        {expert && (
          <>
            <ScreeningPanel />
            <PlanPreview plan={plan} error={error} onRetry={() => void refetch()} />
            <EduDocSection />
          </>
        )}
      </div>
    </>
  );
}
