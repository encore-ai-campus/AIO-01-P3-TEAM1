// /reports/:id: 주린이모드 켬(쉬운 보기, 기본)이면 components/reports/easy/EasyReport, 끔(전문가 보기)이면 아래 화면 —
// 머리 카드 → 실행 요약 띠 → 탭 3개 (리포트 / 진행 기록 / 자세히). 구성은 docs/tasks/05-프론트.md "화면 구성".
// 보기는 useViewMode(): "이 화면만 자세히 보기"는 ?view=expert (저장하지 않음). 분기는 이 파일 한 곳. 바꾼 뒤 맨 위·페이드는 기반이 한다.
// Snapshot을 먼저 받고 SSE로 이어 받는다 (api/reports.ts). 예시 재생은 화면 안에서만 바뀌고 서버에는 아무것도 보내지 않는다.
//
// 위치(전문가 보기): 머리 카드는 이름·상태 한 줄, 신청자·시각·전달 방식 한 줄로 줄이고 보기 전환은 쉬운 보기와 같은 자리(머리 카드 오른쪽 위).
// 탭 줄은 모바일에서 화면 머리 아래에 붙어 긴 본문·타임라인을 보는 중에도 탭을 바꿀 수 있다 (예시 재생 중이면 그 안에 재생 미니 줄).
// '리포트' 탭은 실패 카드 → 이 리포트의 AI 추천(증권사 리포트 첫 장의 투자의견 상자) → 본문 순서. PC는 본문 왼쪽, 추천은 오른쪽 열에 붙어 따라온다.
// '진행 기록'은 구조(그래프) → 사건(타임라인), '자세히'는 빈도 순(예시 재생 → State → 정책 → 개념 문서).
import { Suspense, lazy, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { ApiError, errorMessage } from "../api/client";
import { useRecommendations } from "../api/queries";
import { type Delivery, isFinished, useReportLive, useRequestReport } from "../api/reports";
import type { ReportDetail, SharedState, TraceEvent } from "../api/types";
import { SourceRecommendations } from "../components/autotrade/SourceRecommendations";
import { Icon } from "../components/Icon";
import { EduDocSection } from "../components/reports/EduDocSection";
import { PlanGraph } from "../components/reports/PlanGraph";
import { PolicyGuide } from "../components/reports/PolicyGuide";
import { ReplayBar, ReplayMini, ScenarioPicker } from "../components/reports/ReplayControls";
import { RunSummary } from "../components/reports/RunSummary";
import { SharedStatePanel } from "../components/reports/SharedStatePanel";
import { AutoBadge, DeliveryBadge, ExampleTag, InjectedBadge, ReportStatusBadge } from "../components/reports/StatusChip";
import { TraceTimeline } from "../components/reports/TraceTimeline";
import { ViewToggle } from "../components/reports/ViewToggle";
import { EasyReport } from "../components/reports/easy/EasyReport";
import { Card, EmptyState, ErrorState, Notice, PageHeader, PillTabs, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { type ViewModeState, useViewMode } from "../hooks/useBeginnerMode";
import { useChanged, useRevealAfterLoading } from "../hooks/useMotionState";
import { cn } from "../lib/cn";
import { formatDateTime } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { useReplay } from "../lib/reportExamples";
import { DISCLAIMER, reportFailureSentence } from "../lib/plainText";
import { ERROR_LABEL, EXPERT_FAILURE_FALLBACK, EXPERT_FAILURE_NOTE, NOT_IMPLEMENTED, actorLabel, opinionOf, policyName } from "../lib/reports";

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

/** 실패한 리포트: 사유 문장(쉬운 말) + 사유 코드 + 사유에 맞는 둘째 문장 + 다시 신청 (같은 종목, 같은 장애 주입 설정). */
function FailureCard({ r, trace, state }: { r: ReportDetail; trace: TraceEvent[]; state: SharedState }) {
  const navigate = useNavigate();
  const request = useRequestReport();
  const last = [...trace].reverse().find((e) => e.action === "workflow_failed");
  const reason = typeof last?.details.reason === "string" ? last.details.reason : "";
  const errors = Object.entries(state.errors);
  return (
    <Card aria-labelledby="failure-title" className="border-2 border-up/40">
      <h2 id="failure-title" className="flex items-center gap-1.5 text-[17px] font-bold text-up-ink">
        <Icon name="alert" className="size-5" />
        리포트를 만들지 못했습니다
      </h2>
      {reason && (
        <p className="mt-1.5 text-[14px] leading-snug text-ink">
          {reportFailureSentence(reason)}{" "}
          <code className="rounded bg-fill px-1 py-0.5 font-mono text-[12px] text-sub">({reason})</code>
        </p>
      )}
      {errors.length > 0 && (
        <ul aria-label="실패한 Agent" className="mt-2 space-y-1 text-[14px]">
          {errors.map(([id, msg]) => (
            <li key={id}>
              <b>{actorLabel(r.plan, id)}</b> <span className="text-sub">{ERROR_LABEL[msg as keyof typeof ERROR_LABEL] ?? msg}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-[13px] leading-snug text-sub">{EXPERT_FAILURE_NOTE[reason] ?? EXPERT_FAILURE_FALLBACK}</p>
      <button
        type="button"
        disabled={request.isPending}
        onClick={() => request.mutate({ symbol: r.symbol, chaos: r.chaos }, { onSuccess: (n) => navigate(`/reports/${n.id}`) })}
        className="press mt-3 flex h-11 items-center gap-1.5 rounded-xl bg-brand px-4 text-[15px] font-semibold text-white hover:bg-brand-dark disabled:opacity-40"
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

/** 없는 리포트(404·숫자가 아닌 주소): 다시 시도해도 소용없으니 목록으로 가는 길을 준다 (알림·Discord 링크로 들어오는 화면). */
function NotFound({ easy }: { easy: boolean }) {
  return (
    <Card>
      <EmptyState
        icon="doc"
        title={easy ? "리포트를 찾을 수 없어요" : "리포트를 찾을 수 없습니다."}
        action={{ label: "리포트 목록으로", to: "/reports" }}
      >
        {easy ? "지워졌거나 주소가 틀렸을 수 있어요." : "지워졌거나 주소가 틀렸을 수 있습니다."}
      </EmptyState>
    </Card>
  );
}

export function ReportPage() {
  const { id } = useParams();
  const rid = Number(id);
  const view = useViewMode();
  const { data: r, isPending, isError, error, refetch, isFetching, delivery } = useReportLive(rid);
  // 기다린 끝에 내용이 왔을 때만 한 번 페이드 (캐시로 바로 그리면 움직이지 않는다). early return보다 앞에서 부른다
  const reveal = useRevealAfterLoading(isPending);

  // 숫자가 아닌 주소(/reports/abc)는 요청하지 않으므로 끝없이 기다리지 않고 바로 '찾을 수 없음'
  if (!Number.isFinite(rid) || (isError && error instanceof ApiError && error.status === 404)) {
    return (
      <>
        <PageHeader title="AI 리포트" back />
        <NotFound easy={view.easy} />
      </>
    );
  }
  if (isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-40" />} docTitle="AI 리포트" back />
        <div className="space-y-3">
          <SkeletonCard lines={3} />
          <SkeletonCard lines={6} />
        </div>
      </>
    );
  }
  if (isError) {
    return (
      <>
        <PageHeader title="AI 리포트" back />
        <Card>
          <ErrorState message={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} />
        </Card>
      </>
    );
  }

  if (view.easy) {
    return (
      <>
        <PageHeader title={`${r.name} AI 리포트`} back />
        <div className={reveal ? "reveal-fade" : undefined}>
          <EasyReport r={r} view={view} />
        </div>
      </>
    );
  }
  return (
    <div className={reveal ? "reveal-fade" : undefined}>
      <ExpertReport r={r} delivery={delivery} view={view} />
    </div>
  );
}

/** 모바일에서 위에 붙어 있는 화면 머리(56px)와 탭 줄(60px)이 덮는 높이(여유 포함), 재생 미니 줄이 붙으면 늘어나는 높이 (px). */
const COVERED = 120;
const MINI_H = 48;

/**
 * 모바일에서 화면 머리 아래에 붙는 탭 줄(재생 미니 줄 포함)의 높이를 문서(html)의 --sticky-tabs-h로 알린다 — index.css의 키보드 포커스 여백
 * (:focus-visible scroll-margin-top = 머리 4rem + 이 값)에 더해져, Tab·Shift+Tab으로 옮긴 포커스가 붙은 머리·탭 줄 밑에 가려지지 않게
 * 브라우저가 그만큼 비켜 스크롤한다 (WCAG 2.4.11). 높이는 재서 넣는다(미니 줄이 붙으면 늘어난다). 화면을 떠나거나 PC(탭 줄이 붙지 않음)면 지운다.
 * html scroll-padding-top으로 주지 않는 이유: 붙어 있는 줄(탭 줄·펼친 개념 문서 머리) 안의 칸으로 Shift+Tab 할 때도 걸려 페이지가 튄다 (index.css 주석).
 */
function useStickyTabsPadding(row: HTMLElement | null) {
  useEffect(() => {
    if (!row || typeof ResizeObserver === "undefined") return;
    const root = document.documentElement;
    const pc = typeof window.matchMedia === "function" ? window.matchMedia("(min-width: 64rem)") : null;
    const apply = () => {
      if (pc?.matches) {
        root.style.removeProperty("--sticky-tabs-h");
        return;
      }
      root.style.setProperty("--sticky-tabs-h", `${Math.ceil(row.getBoundingClientRect().height)}px`);
    };
    const ro = new ResizeObserver(apply);
    ro.observe(row);
    pc?.addEventListener("change", apply);
    apply();
    return () => {
      ro.disconnect();
      pc?.removeEventListener("change", apply);
      root.style.removeProperty("--sticky-tabs-h");
    };
  }, [row]);
}

/** 요소가 화면에 보이는지 (IntersectionObserver가 없으면 null — 그때는 보조 표시를 그리지 않는다). top: 위에서 덮인 높이(px) — 그 아래부터 본다. */
function useInView(el: HTMLElement | null, top: number): boolean | null {
  const [visible, setVisible] = useState<boolean | null>(null);
  useEffect(() => {
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: `-${top}px 0px 0px 0px` });
    io.observe(el);
    return () => io.disconnect();
  }, [el, top]);
  return el ? visible : null;
}

/** 이 리포트의 AI 추천 카드 자리 (받는 동안). 실제 카드와 높이가 비슷해 받은 뒤 본문이 밀리지 않는다. */
function RecsSkeleton() {
  return (
    <div role="group" aria-busy="true" aria-label="이 리포트의 AI 추천 불러오는 중" className="space-y-3 rounded-2xl bg-card p-5">
      <Skeleton className="h-6 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-54 w-full rounded-xl" />
    </div>
  );
}

/** 전문가 보기 (주린이모드 끔 또는 ?view=expert). */
function ExpertReport({ r, delivery, view }: { r: ReportDetail; delivery: Delivery; view: ViewModeState }) {
  const rid = r.id;
  const [params, setParams] = useSearchParams();
  const [first, setFirst] = useState<{ id: number; tab: Tab } | null>(null);
  const replay = useReplay(r.state.taskId || `report-${rid}`);
  const [barEl, setBarEl] = useState<HTMLDivElement | null>(null);
  const runTop = useRef<HTMLDivElement>(null);
  const [jump, setJump] = useState(0);
  // 이 리포트의 추천이 있는지 (SourceRecommendations와 같은 캐시) — PC에서 본문 옆 열을 둘지 정한다.
  // 받는 동안은 추천이 생기는 리포트(긍정적 완성)면 자리를 미리 잡아 둔다 — 받은 뒤에 한 열 → 두 열로 바뀌며 본문이 다시 흐르지 않게 (모바일은 본문이 덜 밀리게)
  const recs = useRecommendations({ status: "all", source: "report", sourceId: rid }, Number.isFinite(rid));
  const recsPending = recs.isPending && r.status === "completed" && opinionOf(r) === "buy";
  const hasRecs = recsPending || (recs.data?.results.length ?? 0) > 0;
  const recsReveal = useRevealAfterLoading(recsPending);

  // 예시 재생 중이면 그래프·타임라인·요약·State에 예시 사건을 보인다 (작업 계획은 실제 Registry 그대로)
  const ex = replay.active;
  const trace = ex ? replay.trace : r.trace;
  const state = ex ? replay.state : r.state;
  const finished = isFinished(r.status);
  // 기본 탭은 처음 받았을 때의 상태로 정한다: 끝났으면 리포트, 아니면 진행 기록. 보는 중에 끝나도 탭을 바꾸지 않는다.
  // 주소에 tab이 있으면 그것
  if (first?.id !== rid) setFirst({ id: rid, tab: finished ? "report" : "run" });
  const param = params.get("tab");
  const tab: Tab = isTab(param) ? param : first?.id === rid ? first.tab : finished ? "report" : "run";
  // 탭을 바꾼 뒤에만 패널이 짧게 페이드한다
  const tabChanged = useChanged(tab);
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
  // 예시를 고르면 '진행 기록'으로 옮기고, 재생 띠가 화면 위쪽에 오게 한다 (컨트롤과 그래프 첫 단계가 같이 보이게).
  // 탭 이동(주소 바꾸기)은 라우터가 전환으로 늦게 그리므로, 그사이 재생은 시작됐는데 탭은 아직 '자세히'인 렌더가 생긴다 —
  // 그때 미니 줄을 붙였다 떼면 붙은 탭 줄이 48px 출렁인다. 탭이 '진행 기록'으로 바뀔 때까지(starting) 미니 줄을 붙이지 않는다
  const [starting, setStarting] = useState(false);
  const startExample = () => {
    setStarting(true);
    setTab("run");
    setJump((n) => n + 1);
  };
  if (starting && tab === "run") setStarting(false); // 렌더 중 조건부 파생 상태 (탭 이동이 그려졌다)
  // 탭 이동(주소 바꾸기)은 전환으로 늦게 그려질 수 있어, '진행 기록' 패널이 그려진 뒤 한 번만 옮긴다
  const handledJump = useRef(0);
  useEffect(() => {
    if (jump === handledJump.current || tab !== "run") return;
    const el = runTop.current;
    if (!el) return;
    handledJump.current = jump;
    if (typeof el.scrollIntoView !== "function") return;
    // 모바일은 화면 머리와 탭 줄(약 120px)이 위를 덮는다. 이미 그 아래 위쪽 절반에 있으면 옮기지 않는다 (읽던 자리를 코드가 바꾸지 않게)
    const covered = typeof window.matchMedia === "function" && window.matchMedia("(min-width: 64rem)").matches ? 0 : COVERED;
    const top = el.getBoundingClientRect().top;
    if (top < covered || top > window.innerHeight * 0.5) el.scrollIntoView({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
  }, [jump, tab]);
  // 재생 띠가 화면 밖이면(또는 다른 탭이면) 탭 줄 안에 재생 미니 줄을 붙인다.
  // 미니 줄이 붙으면 위에 붙은 탭 줄이 그만큼 길어지므로 보는 선도 같이 내린다 — 그대로 두면 스크롤 앵커링이 없는 브라우저(Safari)에서
  // 미니 줄이 띠를 밀어 내려 띠가 다시 보이고 → 미니 줄이 사라지고 → 띠가 다시 가려지기를 끝없이 되풀이한다 (탭 줄과 본문이 떨린다)
  const [miniOn, setMiniOn] = useState(false);
  const barVisible = useInView(tab === "run" ? barEl : null, miniOn ? COVERED + MINI_H : COVERED);
  const showMini = ex && !starting && typeof IntersectionObserver !== "undefined" && !(tab === "run" && barVisible !== false);
  if (showMini !== miniOn) setMiniOn(showMini); // 렌더 중 조건부 파생 상태
  // 붙은 탭 줄(미니 줄 포함) 높이만큼 포커스 스크롤 여백 (모바일)
  const [tabRow, setTabRow] = useState<HTMLDivElement | null>(null);
  useStickyTabsPadding(tabRow);

  return (
    <>
      <PageHeader title={`${r.name} AI 리포트`} back />
      <div className="space-y-3 lg:space-y-4">
        {/* 머리 카드: 보기 전환은 쉬운 보기와 같은 자리(오른쪽 위) — 되돌아가는 버튼을 찾지 않게 */}
        <Card aria-label="리포트 머리" className="py-4">
          <div className="flex items-start justify-between gap-2">
            <p className="min-w-0 pt-1.5 text-[13px] text-mute">
              {r.symbol} · {r.market === "KR" ? "국내" : "미국"} · 리포트 #{r.id}
            </p>
            <ViewToggle view={view} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <p className="mr-0.5 text-[22px] font-bold tracking-tight">{r.name}</p>
            <ReportStatusBadge status={r.status} />
            {r.source === "auto" && <AutoBadge />}
            {r.chaosEnabled && <InjectedBadge />}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] text-sub">
            <span>
              {r.requestedBy} 신청 · {formatDateTime(r.createdAt)}
              {r.startedAt && ` · 시작 ${formatDateTime(r.startedAt)}`}
              {r.finishedAt && ` · 종료 ${formatDateTime(r.finishedAt)}`}
            </span>
            <DeliveryBadge delivery={delivery} />
          </p>
          {/* 미구현 안내는 끝나지 않은 리포트에만 (완성된 리포트에는 소용없는 말) */}
          {!finished && !r.plan.implemented && (
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

        {/* 탭 줄: 모바일은 화면 머리(56px) 아래에 붙는다. 바탕은 불투명(뒤 글자가 비치지 않게), PC는 제자리.
            붙어 있는 동안 포커스가 그 밑에 숨지 않게 키보드 포커스 위 여백을 이 높이만큼 늘린다(useStickyTabsPadding) */}
        <div ref={setTabRow} className="sticky top-14 z-(--z-header) -mx-4 bg-bg px-4 py-2 lg:static lg:mx-0 lg:p-0">
          <PillTabs label="리포트 화면" value={tab} options={TABS} onChange={setTab} stretch />
          {showMini && <ReplayMini replay={replay} />}
        </div>

        {tab === "report" && (
          <div
            key="report"
            role="tabpanel"
            id="panel-report"
            aria-labelledby="tab-report"
            className={cn(
              "space-y-3",
              // PC: 본문 왼쪽, 이 리포트의 AI 추천은 오른쪽 열에 붙어 따라온다 (추천이 없으면 한 열)
              hasRecs ? "lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:items-start lg:gap-4 lg:space-y-0" : "lg:space-y-4",
              tabChanged && "reveal-fade",
            )}
          >
            {r.status === "failed" && (
              <div className={cn(hasRecs && "lg:col-span-2")}>
                <FailureCard r={r} trace={r.trace} state={r.state} />
              </div>
            )}
            {hasRecs && (
              <div
                className={cn("lg:sticky lg:top-8 lg:col-start-2", r.status === "failed" ? "lg:row-start-2" : "lg:row-start-1", recsReveal && "reveal-fade")}
              >
                {recsPending ? <RecsSkeleton /> : <SourceRecommendations source="report" sourceId={r.id} />}
              </div>
            )}
            <Card aria-labelledby="content-title" className={cn(hasRecs && "lg:col-start-1", hasRecs && (r.status === "failed" ? "lg:row-start-2" : "lg:row-start-1"))}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <CardTitle id="content-title" title="리포트 본문" />
                {(r.hasPdf || r.status === "completed") && (
                  // 서버가 PDF를 새 창에 바로 보여 준다(inline) — 쉬운 보기와 같은 이름·아이콘
                  <a
                    href={`/api/reports/${r.id}/pdf`}
                    target="_blank"
                    rel="noreferrer"
                    className="press flex h-10 items-center gap-1 rounded-xl bg-fill px-3 text-[14px] font-semibold text-ink hover:bg-line"
                  >
                    <Icon name="doc" className="size-4" />
                    PDF로 보기
                  </a>
                )}
              </div>
              {r.content ? (
                <Suspense fallback={<SkeletonCard lines={4} className="px-0" />}>
                  {/* 카드 제목(h2) 아래라 문서 제목을 한 단계 더 낮춘다 */}
                  <Markdown levelOffset={2}>{r.content}</Markdown>
                </Suspense>
              ) : (
                <div className="rounded-xl bg-fill px-4 py-6 text-center">
                  <p className="text-[15px] text-mute">
                    {r.plan.implemented ? (finished ? "본문이 없습니다." : "리포트를 쓰는 중입니다.") : "리포트 본문은 Agent 구현 뒤에 표시됩니다 (미구현)"}
                  </p>
                  <button
                    type="button"
                    onClick={() => setTab("run")}
                    className="press mt-2 h-10 rounded-xl bg-card px-3.5 text-[14px] font-semibold text-brand-ink hover:bg-line"
                  >
                    진행 기록 보기
                  </button>
                </div>
              )}
            </Card>
          </div>
        )}

        {tab === "run" && (
          <div
            key="run"
            ref={runTop}
            role="tabpanel"
            id="panel-run"
            aria-labelledby="tab-run"
            // 모바일은 위에 붙은 화면 머리(56px)와 탭 줄(60px) 아래로 옮긴다 (128px)
            className={cn("scroll-mt-32 space-y-3 lg:scroll-mt-8 lg:space-y-4", tabChanged && "reveal-fade")}
          >
            {ex ? (
              <ReplayBar replay={replay} ref={setBarEl} />
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
          <div
            key="more"
            role="tabpanel"
            id="panel-more"
            aria-labelledby="tab-more"
            className={cn("space-y-3 lg:space-y-4", tabChanged && "reveal-fade")}
          >
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
            {/* 탭 줄(재생 중이면 미니 줄까지)이 모바일에서 붙어 있으므로 펼친 문서의 머리는 그 아래에 붙인다 */}
            <EduDocSection stickyTop={showMini ? "top-[10.25rem] lg:top-4" : "top-[7.25rem] lg:top-4"} />
          </div>
        )}
        {/* 면책 문장은 꼭 읽어야 하는 문장이라 보조 글자색 */}
        <p className="px-1 text-[12px] leading-snug text-sub">{DISCLAIMER}</p>
      </div>
    </>
  );
}
