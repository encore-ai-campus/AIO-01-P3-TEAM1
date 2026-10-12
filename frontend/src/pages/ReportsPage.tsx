// /reports: 주린이모드 켬(쉬운 보기)·끔(전문가 보기) 공통으로 [만드는 중인 내 리포트(있을 때만) → 만들기 카드 | 칩 "내 리포트 · 팀 리포트" 목록(10개씩 쪽)]
// → 오늘의 선별 결과(칩 "오늘의 선별 · 교차검증 분석" — components/reports/ScreeningCard.tsx). 쉬운 보기의 선별 결과는 고른 종목과 이유만 (2026-10-12, docs/DECISIONS.md 34장).
// 전문가 보기에서만: 팀 리포트의 전체·자동 거르기, 선별 결과의 점수·탈락 사유, (접힘) 작업 계획(Planner) 미리 보기
// (docs/plans/컨셉변경계획.md 4-2 "리포트 목록" — 작업 계획·개념 문서는 전문가 보기·관리자 화면으로. 개념 문서는 관리자 화면 /ops에 있다).
// 장애 주입은 2026-10-12부터 서비스에 없다 — 관리 서버 /chaos에서만 켠다 (docs/DECISIONS.md 35장).
//
// 위치: ① 만들기가 이 탭의 주 행동이라 첫 화면(엄지 영역 위쪽)에 둔다. 그 위의 '만드는 중인 내 리포트'는 탭의 점을 보고 들어온 사람의 목적지라
// 있을 때만 맨 위에 얇게. 목록은 그다음. 선별 결과, 전문가 섹션(구조 설명)은 아래 전체 폭.
// PC(lg)는 [왼쪽: 띠 + 만들기 카드(따라옴) | 오른쪽: 목록] 두 열 — 긴 목록을 훑는 동안 만들기 버튼이 보이고 두 열 높이가 맞는다. DOM 순서는 모바일과 같다.
// xl부터 왼쪽은 360px(2xl 380px)로 좁히고, 1400px 이상이면 목록은 표 모양 행·오늘의 선별 결과는 오른쪽 열 목록 아래(그리드 배치만 — 만들기 카드가 두 줄 내내 따라온다).
import { useEffect, useState } from "react";
import { errorMessage } from "../api/client";
import { useReportPlan } from "../api/queries";
import type { ExecutionPlan } from "../api/types";
import { Icon } from "../components/Icon";
import { ErrorPanel } from "../components/errors/ErrorPanel";
import { errorKindOf } from "../components/errors/errorTypes";
import { Collapse } from "../components/motion/Collapse";
import { CreateReportCard } from "../components/reports/CreateReportCard";
import { InProgressStrip } from "../components/reports/InProgressStrip";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ReportList } from "../components/reports/ReportList";
import { ScreeningCard } from "../components/reports/ScreeningCard";
import { ViewToggle } from "../components/reports/ViewToggle";
import { Card, Notice, PageHeader, Skeleton } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { cn } from "../lib/cn";
import { NOT_IMPLEMENTED, policyName } from "../lib/reports";

/** 작업 계획(Planner) 미리 보기 (접힘). 사용자 용어 "실행 준비·실행 확인"과 겹치지 않게 "실행 계획"이라 부르지 않는다. */
function PlanPreview({
  plan,
  error,
  onRetry,
  retrying,
  className,
}: {
  plan: ExecutionPlan | undefined;
  error: unknown;
  onRetry: () => void;
  retrying: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Card aria-labelledby="plan-title" className={className}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? "plan-preview" : undefined}
        onClick={() => setOpen((v) => !v)}
        className="-m-2 flex w-[calc(100%+1rem)] items-center justify-between gap-3 rounded-xl p-2 text-left hover:bg-fill/60"
      >
        <span>
          <span id="plan-title" className="block text-[17px] font-bold">
            작업 계획(Planner) 미리 보기
          </span>
          <span className="block text-[13px] text-mute">
            {plan ? `${plan.title} · 실패 정책 ${policyName(plan.failurePolicy)} · 신청한 리포트는 이 계획대로 만들어집니다` : "Agent 구성과 순서"}
          </span>
        </span>
        <Icon name="chevron-down" className={cn("size-5 shrink-0 text-mute transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id="plan-preview" className="mt-3">
        {plan ? (
          <PlanGraph plan={plan} trace={[]} currentStep={null} />
        ) : error ? (
          <ErrorPanel kind={errorKindOf(error)} detail={errorMessage(error)} onRetry={onRetry} retrying={retrying} secondary={null} compact className="bg-fill" />
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </Collapse>
    </Card>
  );
}

/**
 * PC 만들기 카드의 스크롤 상자: 아래에 붙는 '고른 종목·만들기' 묶음의 높이를 재서 상자에 --dock-h로 넘긴다.
 * 상자의 scroll-padding-bottom이 그만큼이라 Tab으로 옮긴 칸(마지막 검색 결과)이 묶음 밑에 가려지지 않는다 —
 * 브라우저가 상자를 그만큼 비켜 스크롤한다 (WCAG 2.4.11). 묶음 높이는 '오늘 리포트 보기'·오류 안내가 붙으면 달라진다.
 */
function useDockPadding() {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!box || !dock || typeof ResizeObserver === "undefined") return;
    const measure = () => box.style.setProperty("--dock-h", `${Math.ceil(dock.getBoundingClientRect().height)}px`);
    const ro = new ResizeObserver(measure);
    ro.observe(dock);
    measure();
    return () => {
      ro.disconnect();
      box.style.removeProperty("--dock-h");
    };
  }, [box, dock]);
  return { boxRef: setBox, dockRef: setDock };
}

export function ReportsPage() {
  const view = useViewMode();
  const expert = view.expert;
  const { data: plan, error, refetch, isFetching } = useReportPlan();
  const { boxRef, dockRef } = useDockPadding();
  return (
    <>
      <PageHeader title="AI 리포트" right={<ViewToggle view={view} compact />} />
      <div className="space-y-3 lg:space-y-4">
        {/* 계획을 받은 뒤에 알 수 있는 안내라 툭 끼어들지 않게 펼친다 (아래 간격도 펼쳐지는 안쪽에 — 부모 space-y 간격은 툭 생긴다) */}
        {/* 사실은 숨기지 않되 조용한 안내로 (경고색이 화면 첫머리를 차지하지 않게 — 정보 색·작은 글자) */}
        <Collapse open={expert && plan !== undefined && !plan.implemented} className="mb-0">
          <div className="pb-3 lg:pb-4">
            <Notice tone="info" className="py-2.5 text-[13px]">
              {NOT_IMPLEMENTED}
            </Notice>
          </div>
        </Collapse>
        {/* grid-cols-1(= minmax(0,1fr)): 열 정의가 없으면 긴 한 줄 요약이 열을 밀어 모바일 화면이 가로로 넘친다.
            PC: lg(1024~1279)는 같은 너비 두 열(목록 숫자가 좁아지지 않게), xl부터 [만들기 360px(2xl 380px) | 목록 1fr].
            오늘의 선별 결과는 1400px 이상에서 오른쪽 열 목록 아래(둘째 줄)에 둔다 — 목록이 첫 화면에서 밀리지 않게(목록 위에 두면 목록이 두 줄만 보였다). DOM은 모바일 순서 그대로 */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start lg:gap-4 xl:grid-cols-[360px_minmax(0,1fr)] 2xl:grid-cols-[380px_minmax(0,1fr)]">
          {/* 왼쪽 열은 행 높이만큼 늘여 만들기 카드가 그 안에서 따라오게 한다 (sticky) */}
          <div className="min-w-0 space-y-3 lg:space-y-4 lg:self-stretch min-[87.5rem]:col-start-1 min-[87.5rem]:row-span-2 min-[87.5rem]:row-start-1">
            <InProgressStrip expert={expert} />
            {/* 화면보다 길어지면(검색 결과) 카드 안에서 스크롤한다 — 만들기 버튼 묶음은 그 아래에 붙어 늘 보인다(CreateReportCard).
                둥근 자르기(카드 모서리 + 여백 4px): 안에서 스크롤해도 카드 모서리가 각지게 잘려 보이지 않게.
                scroll-pb: 붙은 묶음 높이(잰 값, 재기 전에는 9.5rem) + 8px — 포커스가 묶음 밑에 숨지 않게 */}
            <div
              ref={boxRef}
              className="lg:sticky lg:top-(--rail-top) lg:-m-1 lg:max-h-[calc(100dvh-var(--rail-top)-2rem)] lg:scroll-pb-[calc(var(--dock-h,9.5rem)_+_0.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-[1.25rem] lg:p-1"
            >
              <CreateReportCard expert={expert} dockRef={dockRef} />
            </div>
          </div>
          <ReportList expert={expert} className="min-[87.5rem]:col-start-2 min-[87.5rem]:row-start-1" />
          <ScreeningCard expert={expert} className="lg:col-span-2 min-[87.5rem]:col-span-1 min-[87.5rem]:col-start-2 min-[87.5rem]:row-start-2" />
          {expert && <PlanPreview plan={plan} error={error} onRetry={() => void refetch()} retrying={isFetching} className="lg:col-span-2" />}
        </div>
      </div>
    </>
  );
}
