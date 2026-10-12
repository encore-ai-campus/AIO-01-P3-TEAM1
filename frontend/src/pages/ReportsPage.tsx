// /reports: 주린이모드 켬(쉬운 보기)·끔(전문가 보기) 공통으로 [만드는 중인 내 리포트(있을 때만) → 만들기 카드 | 칩 "내 리포트 · 팀 리포트 · 교차검증 분석" 목록].
// 전문가 보기에서만: 만들기 카드의 장애 주입, 팀 리포트의 전체·자동·장애 주입 거르기, 오늘의 선별 결과, (접힘) 작업 계획(Planner) 미리 보기
// (docs/plans/컨셉변경계획.md 4-2 "리포트 목록" — 장애 주입·작업 계획·개념 문서는 전문가 보기·관리자 화면으로. 개념 문서는 관리자 화면 /ops에 있다).
//
// 오늘의 선별 결과는 선정 팀(stock_selection)이 고른 날이면 "AI 선정 팀이 고르고 안전장치가 거른 종목", 팀이 실패한 날이면 "오늘은 규칙으로 골랐어요"와
// 사유, 고르는 중이면 그 사실을 먼저 말한다. 예전 파일(선정 키 없음)은 예전 화면 그대로다.
//
// 위치: ① 만들기가 이 탭의 주 행동이라 첫 화면(엄지 영역 위쪽)에 둔다. 그 위의 '만드는 중인 내 리포트'는 탭의 점을 보고 들어온 사람의 목적지라
// 있을 때만 맨 위에 얇게. 목록은 그다음. 전문가 섹션은 사용 빈도 순(선별 > 구조 설명)으로 아래 전체 폭.
// PC(lg)는 [왼쪽: 띠 + 만들기 카드(따라옴) | 오른쪽: 목록] 두 열 — 긴 목록을 훑는 동안 만들기 버튼이 보이고 두 열 높이가 맞는다. DOM 순서는 모바일과 같다.
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { errorMessage } from "../api/client";
import { useReportPlan } from "../api/queries";
import { useScreening } from "../api/reports";
import type { ExecutionPlan, ScreeningFiltered, ScreeningResult } from "../api/types";
import { Icon } from "../components/Icon";
import { ErrorPanel } from "../components/errors/ErrorPanel";
import { errorKindOf } from "../components/errors/errorTypes";
import { Collapse } from "../components/motion/Collapse";
import { CreateReportCard } from "../components/reports/CreateReportCard";
import { InProgressStrip } from "../components/reports/InProgressStrip";
import { PlanGraph } from "../components/reports/PlanGraph";
import { ReportList } from "../components/reports/ReportList";
import { ExampleTag } from "../components/reports/StatusChip";
import { ViewToggle } from "../components/reports/ViewToggle";
import { Card, LiveDot, Notice, PageHeader, Skeleton } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { selectionFallbackSentence } from "../lib/plainText";
import { NOT_IMPLEMENTED, policyName } from "../lib/reports";

const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "-");
/** 있으면 그 글자, 비었거나 글자가 아니면 null (선정 팀 키는 예전 파일에 없다). */
const optText = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const optInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

const tag = "inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-[12px] font-semibold whitespace-nowrap";

/**
 * 누가 골랐는지: AI 선정 팀 · 규칙(Fallback, 사유) · 고르는 중. 선정 키가 없는 파일이면 아무것도 보이지 않는다.
 * 선정 실행이 있으면 그 과정(/reports/{id})으로 가는 길 — 예시(서버에 선별이 없음)에는 두지 않는다 (다른 리포트로 가지 않게).
 */
function SelectionNote({ s, example }: { s: ScreeningResult; example: boolean }) {
  const reportId = !example && typeof s.selection?.reportId === "number" ? s.selection.reportId : null;
  const link = reportId !== null && (
    <Link
      to={`/reports/${reportId}`}
      className="-mx-1 inline-flex min-h-9 items-center gap-0.5 rounded-md px-1 text-[13px] font-semibold text-brand-ink hover:bg-fill"
    >
      AI 선정 과정 보기 <Icon name="chevron" className="size-4" />
    </Link>
  );
  if (s.selectedBy === "ai") {
    return (
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <p className="inline-flex items-center gap-1.5 rounded-lg bg-brand-soft px-2 py-1 text-[13px] font-semibold text-brand-ink">
          <Icon name="sparkle" className="size-4 shrink-0" />
          AI 선정 팀이 고르고 안전장치가 거른 종목
        </p>
        {link}
      </div>
    );
  }
  if (s.selectedBy === "rule") {
    return (
      <Notice tone="info" className="mt-2">
        <p className="font-semibold">오늘은 규칙으로 골랐어요</p>
        <p className="mt-0.5 text-[13px]">{selectionFallbackSentence(s.fallbackReason)}</p>
        {link}
      </Notice>
    );
  }
  if (s.selection?.status === "running") {
    return (
      <Notice tone="info" className="mt-2">
        <p className="flex items-center gap-2 font-semibold">
          <LiveDot />
          AI가 오늘의 종목을 고르는 중이에요
        </p>
        <p className="mt-0.5 text-[13px]">지금 보이는 종목은 규칙 점수 순서예요. 고르기가 끝나면 바뀔 수 있어요</p>
        {link}
      </Notice>
    );
  }
  return null;
}

/** 선정 Guard가 뺀 종목 (접힘). AI가 고른 종목과, 모자라 규칙 후보로 채우다 뺀 종목을 나눠 보인다. */
function FilteredList({ s }: { s: ScreeningResult }) {
  const [open, setOpen] = useState(false);
  const items = s.filtered ?? [];
  const aiSymbols = new Set((s.aiPicks ?? []).map((p) => p.symbol));
  // 후보 밖 종목은 AI만 고를 수 있다. 선정안 원문이 없으면 누가 골랐는지는 selectedBy로
  const byAi = (f: ScreeningFiltered) => f.stage === "candidates" || (aiSymbols.size > 0 ? aiSymbols.has(f.symbol) : s.selectedBy === "ai");
  const ai = items.filter(byAi);
  const rule = items.filter((f) => !byAi(f));
  if (items.length === 0) return null;
  const label =
    ai.length > 0
      ? `AI는 골랐지만 안전장치가 뺀 종목 ${ai.length}개${rule.length > 0 ? ` · 규칙 후보 ${rule.length}개` : ""}`
      : `안전장치가 뺀 종목 ${rule.length}개`;
  const rows = (list: ScreeningFiltered[], name: string) => (
    <ul aria-label={name} className="space-y-1">
      {list.map((f, i) => (
        <li key={`${f.symbol}-${i}`} className="text-[13px] leading-snug">
          <b className="font-semibold">{optText(f.name) ?? f.symbol}</b> <span className="text-mute">{f.symbol}</span>
          <span className="text-sub"> — {text(f.reason)}</span>
        </li>
      ))}
    </ul>
  );
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? "screening-filtered" : undefined}
        onClick={() => setOpen((v) => !v)}
        className="-ml-1 inline-flex min-h-9 items-center gap-0.5 rounded-md px-1 text-left text-[13px] font-semibold text-brand-ink hover:bg-fill"
      >
        {label}
        <Icon name="chevron-down" className={cn("size-4 shrink-0 transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id="screening-filtered">
        <div className="space-y-2 pt-1 pb-0.5">
          {ai.length > 0 && rows(ai, "AI는 골랐지만 안전장치가 뺀 종목")}
          {rule.length > 0 && (
            <div>
              {ai.length > 0 && <p className="mb-0.5 text-[12px] font-semibold text-mute">규칙 후보로 채우다 뺀 종목</p>}
              {rows(rule, "규칙 후보 중 안전장치가 뺀 종목")}
            </div>
          )}
        </div>
      </Collapse>
    </div>
  );
}

/** 선별 종목 한 칸: 순위 · 이름 · 코드 · 거래대금 순위 · 점수, 선정 팀 키가 있으면 AI 순위·테마·규칙으로 채움·다시 시도 꼬리표와 AI가 고른 이유. */
function PickItem({ p, rank, ruleDay }: { p: Record<string, unknown>; rank: number; ruleDay: boolean }) {
  const aiRank = optInt(p.aiRank);
  const aiReason = optText(p.aiReason);
  const theme = optText(p.theme);
  // 규칙으로 고른 날은 모두 규칙이라 칸마다 붙이지 않는다 (위 안내가 말한다)
  const byRule = p.filledByRule === true && !ruleDay;
  const retryRound = optInt(p.retryRound);
  const tags = aiRank !== null || theme !== null || byRule || retryRound !== null;
  return (
    <li className="rounded-xl bg-fill px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {/* 반전 순위 원: 다크에서는 밝은 원 + 어두운 숫자 */}
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-bold text-on-ink">{rank}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{text(p.name)}</span>
          <span className="block text-[12px] text-mute">
            {text(p.symbol)} · 거래대금 {text(p.tradingAmountRank)}위
          </span>
        </span>
        <span className="text-[17px] font-bold tabular-nums">{text(p.score)}</span>
      </div>
      {tags && (
        <p className="mt-1.5 flex flex-wrap gap-1">
          {aiRank !== null && <span className={cn(tag, "bg-brand-soft text-brand-ink")}>AI {aiRank}위</span>}
          {theme !== null && <span className={cn(tag, "bg-card text-sub")}>{theme}</span>}
          {byRule && <span className={cn(tag, "bg-warn-soft text-warn-ink")}>규칙으로 채움</span>}
          {retryRound !== null && <span className={cn(tag, "bg-card text-sub")}>다시 시도 {retryRound}차</span>}
        </p>
      )}
      {aiReason !== null && <p className="mt-1 text-[13px] leading-snug text-sub">{aiReason}</p>}
    </li>
  );
}

/**
 * 오늘의 선별 결과: 누가 골랐는지(AI 선정 팀·규칙·고르는 중), 종목·점수(AI 이유·테마), 안전장치가 뺀 종목(접힘), 탈락 사유 요약.
 * 선별이 아직 없으면(404) 서버 대신 예시를 보인다(api/reports.ts) — 오류는 오류로.
 */
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
          <ErrorPanel kind={errorKindOf(error)} detail={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} secondary={null} compact className="bg-fill" />
        </div>
      ) : !s ? (
        <p className="mt-2 text-[14px] text-mute">오늘 선별이 아직 없습니다.</p>
      ) : (
        <div className={reveal ? "reveal-fade" : undefined}>
          <p className="mt-0.5 text-[13px] text-mute">
            {formatDateTime(s.at)} · 거래대금 상위 {s.rankCount}개 중 {s.eligibleCount}개 대상
            {s.candidates && s.candidates.length > 0 && ` · 후보 ${s.candidates.length}개`} · {s.picks.length}개 선별
            {s.retries ? ` (손익비 기준을 넘는 추천이 없어 다시 시도 ${s.retries}번)` : null}
          </p>
          <SelectionNote s={s} example={data.example} />
          {s.picks.length > 0 ? (
            <ol aria-label="선별 종목" className="mt-3 grid gap-2 sm:grid-cols-3">
              {s.picks.map((p, i) => (
                <PickItem key={text(p.symbol)} p={p} rank={i + 1} ruleDay={s.selectedBy === "rule"} />
              ))}
            </ol>
          ) : (
            <p className="mt-3 rounded-xl bg-fill px-3 py-3 text-[14px] text-mute">오늘 선별된 종목이 없어요.</p>
          )}
          <FilteredList s={s} />
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
