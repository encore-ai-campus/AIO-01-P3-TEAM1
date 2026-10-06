// /reports: 주린이모드 켬(쉬운 보기)·끔(전문가 보기) 공통으로 [만드는 중인 내 리포트(있을 때만) → 만들기 카드 | 칩 "내 리포트 · 팀 리포트 · 교차검증 분석" 목록].
// 전문가 보기에서만: 만들기 카드의 장애 주입, 팀 리포트의 전체·자동·장애 주입 거르기, 오늘의 선별 결과, (접힘) 작업 계획(Planner) 미리 보기
// (docs/컨셉변경계획.md 4-2 "리포트 목록" — 장애 주입·작업 계획·개념 문서는 전문가 보기·관리자 화면으로. 개념 문서는 관리자 화면 /ops에 있다).
//
// 위치: ① 만들기가 이 탭의 주 행동이라 첫 화면(엄지 영역 위쪽)에 둔다. 그 위의 '만드는 중인 내 리포트'는 탭의 점을 보고 들어온 사람의 목적지라
// 있을 때만 맨 위에 얇게. 목록은 그다음. 전문가 섹션은 사용 빈도 순(선별 > 구조 설명)으로 아래 전체 폭.
// PC(lg)는 [왼쪽: 띠 + 만들기 카드(따라옴) | 오른쪽: 목록] 두 열 — 긴 목록을 훑는 동안 만들기 버튼이 보이고 두 열 높이가 맞는다. DOM 순서는 모바일과 같다.
import { useEffect, useState } from "react";
import { errorMessage } from "../api/client";
import { useReportPlan } from "../api/queries";
import { useScreening } from "../api/reports";
import type { ExecutionPlan } from "../api/types";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { CreateReportCard } from "../components/reports/CreateReportCard";
import { InProgressStrip } from "../components/reports/InProgressStrip";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ReportList } from "../components/reports/ReportList";
import { ExampleTag } from "../components/reports/StatusChip";
import { ViewToggle } from "../components/reports/ViewToggle";
import { Card, ErrorState, Notice, PageHeader, Skeleton } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { NOT_IMPLEMENTED, policyName } from "../lib/reports";

const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "-");

/** 오늘의 선별 결과: 상위 종목·점수, 탈락 사유 요약. 선별이 아직 없으면(404) 서버 대신 예시를 보인다(api/reports.ts) — 오류는 오류로. */
function ScreeningPanel() {
  const { data, isPending, isError, error, refetch, isFetching } = useScreening();
  const reveal = useRevealAfterLoading(isPending);
  const s = data?.data;
  const reasons = new Map<string, number>();
  for (const d of s?.dropped ?? []) reasons.set(text(d.reason), (reasons.get(text(d.reason)) ?? 0) + 1);
  return (
    <Card aria-labelledby="screening-title">
      <h2 id="screening-title" className="flex flex-wrap items-center gap-1.5 text-[17px] font-bold">
        오늘의 선별 결과 {data?.example && <ExampleTag />}
      </h2>
      {isPending ? (
        <div className="mt-3 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <div className="grid gap-2 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-14 rounded-xl" />
            ))}
          </div>
        </div>
      ) : isError ? (
        <div className="mt-2">
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} compact />
        </div>
      ) : !s ? (
        <p className="mt-2 text-[14px] text-mute">오늘 선별이 아직 없습니다.</p>
      ) : (
        <div className={reveal ? "reveal-fade" : undefined}>
          <p className="mt-0.5 text-[13px] text-mute">
            {formatDateTime(s.at)} · 거래대금 상위 {s.rankCount}개 중 {s.eligibleCount}개 대상 · {s.picks.length}개 선별
          </p>
          <ol aria-label="선별 종목" className="mt-3 grid gap-2 sm:grid-cols-3">
            {s.picks.map((p, i) => (
              <li key={text(p.symbol)} className="flex items-center gap-2.5 rounded-xl bg-fill px-3 py-2.5">
                {/* 반전 순위 원: 다크에서는 밝은 원 + 어두운 숫자 */}
                <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-bold text-on-ink">{i + 1}</span>
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
        </div>
      )}
    </Card>
  );
}

/** 작업 계획(Planner) 미리 보기 (접힘). 사용자 용어 "실행 준비·실행 확인"과 겹치지 않게 "실행 계획"이라 부르지 않는다. */
function PlanPreview({ plan, error, onRetry, retrying }: { plan: ExecutionPlan | undefined; error: unknown; onRetry: () => void; retrying: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Card aria-labelledby="plan-title">
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
          <ErrorState message={errorMessage(error)} onRetry={onRetry} retrying={retrying} />
        ) : (
          <Skeleton className="h-40 w-full" />
        )}
      </Collapse>
    </Card>
  );
}

/**
 * PC 만들기 카드의 스크롤 상자: 아래에 붙는 '고른 종목·만들기' 묶음의 높이를 재서 상자에 --dock-h로 넘긴다.
 * 상자의 scroll-padding-bottom이 그만큼이라 Tab으로 옮긴 칸(장애 주입 직접 설정·마지막 검색 결과)이 묶음 밑에 가려지지 않는다 —
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
        <Collapse open={expert && plan !== undefined && !plan.implemented} className="mb-0">
          <div className="pb-3 lg:pb-4">
            <Notice tone="warn">{NOT_IMPLEMENTED}</Notice>
          </div>
        </Collapse>
        {/* grid-cols-1(= minmax(0,1fr)): 열 정의가 없으면 긴 한 줄 요약이 열을 밀어 모바일 화면이 가로로 넘친다 */}
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start lg:gap-4">
          {/* 왼쪽 열은 행 높이만큼 늘여 만들기 카드가 그 안에서 따라오게 한다 (sticky) */}
          <div className="min-w-0 space-y-3 lg:space-y-4 lg:self-stretch">
            <InProgressStrip expert={expert} />
            {/* 화면보다 길어지면(장애 주입 직접 설정·검색 결과) 카드 안에서 스크롤한다 — 만들기 버튼 묶음은 그 아래에 붙어 늘 보인다(CreateReportCard).
                둥근 자르기(카드 모서리 + 여백 4px): 안에서 스크롤해도 카드 모서리가 각지게 잘려 보이지 않게.
                scroll-pb: 붙은 묶음 높이(잰 값, 재기 전에는 9.5rem) + 8px — 포커스가 묶음 밑에 숨지 않게 */}
            <div
              ref={boxRef}
              className="lg:sticky lg:top-8 lg:-m-1 lg:max-h-[calc(100dvh-4rem)] lg:scroll-pb-[calc(var(--dock-h,9.5rem)_+_0.5rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-[1.25rem] lg:p-1"
            >
              <CreateReportCard plan={plan} expert={expert} dockRef={dockRef} />
            </div>
          </div>
          <ReportList expert={expert} />
        </div>
        {expert && (
          <>
            <ScreeningPanel />
            <PlanPreview plan={plan} error={error} onRetry={() => void refetch()} retrying={isFetching} />
          </>
        )}
      </div>
    </>
  );
}
