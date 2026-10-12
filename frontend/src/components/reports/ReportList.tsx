// 리포트 목록: 칩 "내 리포트 · 팀 리포트" (B8 ?mine=1). 고른 칩은 주소의 ?list=에 둔다 (기본 팀 리포트).
// 교차검증 분석(D-1)은 2026-10-12부터 '오늘의 선별 결과' 카드의 칩이다 (ScreeningCard, docs/DECISIONS.md 34장).
// 10개씩 쪽으로 넘긴다 (쪽은 주소의 ?page=, 서버 페이지 ?limit=10&offset= — 거르기도 서버가 해서 쪽마다 10개가 찬다).
// 카드 = 종목 · AI 의견 배지 · 한 줄 요약 · 상태(대기 중·만드는 중·완성·실행 가능·만들지 못함).
// "실행 가능"은 상세(매매 계획 카드)와 같은 판단으로만 쓴다: 열린 추천을 한 번에 받고(GET /api/recommendations?source=report&status=open&limit=100),
// 화면 위쪽 완성 카드 5개까지만 리스크 미리 보기(상세와 같은 캐시)를 불러 activatable일 때 '실행 가능'. 받기 전·막힌 계획은 '완성' + 문장
// (목록이 약속하고 상세가 거둬들이는 모순을 막는다 — docs/plans/컨셉변경계획.md 4-5 "실행할 수 없는 경우를 숨기지 않는다").
// 전문가 보기는 예전 행 모양 그대로에 의견·한 줄 요약을 더하고, 팀 리포트에서 전체·자동으로 거른다 (묶음보다 낮은 위계의 작은 칩).
// 고른 거르기도 쪽처럼 주소(?filter=auto)에 둔다 — 상세에 다녀와도 보던 거르기·쪽이 함께 돌아온다.
// 장애 주입 거르기·"주입" 배지는 2026-10-12에 지웠다 — 장애 주입은 관리 서버에서만 켜고 보고, 서비스 목록에 나오지 않는다 (DECISIONS 35장).
// 움직임: 처음 불러온 목록은 한 번에 페이드, 거르기를 바꾸는 동안은 이전 목록을 흐리게 남긴다 (높이가 출렁이지 않게). 행은 누르면 바탕이 바뀐다.
// 팀 리포트에서는 남이 신청한 실패 리포트·자동 리포트 실패를 뺀다(서버 ?feed=team) — 서비스가 고장 난 것처럼 보인다 (UX-15). 내 실패는 남기고, 쉬운 보기에서는
// 카드 아래 '다시 만들기'(같은 종목 — 상세 실패 화면과 같다)를 둔다.
// 카드의 한 줄 요약은 상세와 같이 다듬어 보인다 (쉼표 없는 금액·의견 영어 — lib/reports.ts cleanReportText).
import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { isPlanLive, useMe, useRecommendations, useReports, useRiskPreview } from "../../api/queries";
import { useReportQuota, useRequestReport } from "../../api/reports";
import type { Recommendation, ReportSummary } from "../../api/types";
import { useChanged, useRevealAfterLoading, revealList } from "../../hooks/useMotionState";
import { usePageParam } from "../../hooks/usePageParam";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { errorSentence } from "../../lib/plainText";
import { PLAN_NOTE, REPORT_CARD_TEXT, cleanReportText, formatCost, reportCardStatus } from "../../lib/reports";
import { Icon } from "../Icon";
import { ErrorPanel } from "../errors/ErrorPanel";
import { errorKindOf } from "../errors/errorTypes";
import { Card, EmptyState, Segmented, Spinner } from "../ui";
import { ListSkeleton } from "./ListSkeleton";
import { OpinionBadge } from "./OpinionBadge";
import { Pager } from "./Pager";
import { AutoBadge, ReportStatusBadge } from "./StatusChip";

type Group = "mine" | "team";
const GROUPS: { value: Group; label: string }[] = [
  { value: "mine", label: "내 리포트" },
  { value: "team", label: "팀 리포트" },
];
const isGroup = (v: string | null): v is Group => GROUPS.some((g) => g.value === v);

type Filter = "all" | "auto";
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "auto", label: "자동" },
];
const isFilter = (v: string | null): v is Filter => FILTERS.some((f) => f.value === v);

/** 한 쪽의 리포트 수. */
const PAGE_SIZE = 10;
/** 한 쪽의 위쪽에서 리스크 미리 보기를 불러 '실행 가능'을 확인할 완성 카드 수 (요청이 목록 길이만큼 늘지 않게). */
const PREVIEW_LIMIT = 5;

// 넓은 PC(1400px 이상 — 목록 칸이 720px 넘게 남을 때)의 표 모양 행: [종목·의견·한 줄 요약 1fr | 상태 | 종목코드·만든 사람·시각].
// 그보다 좁으면(1024~1399) 모바일과 같은 쌓인 행 — 표로 만들면 종목 이름 칸이 너무 좁아진다. 머리 줄(ColumnHead)과 같은 값을 쓴다.
// 쉬운 보기의 상태 칸은 칩 + 문장, 전문가 보기는 배지만이라 좁다
const COLS = "min-[87.5rem]:grid-cols-[minmax(0,1fr)_13.5rem_9.5rem]";
const EXPERT_COLS = "min-[87.5rem]:grid-cols-[minmax(0,1fr)_6.5rem_10.5rem]";
const ROW_GRID = cn("min-[87.5rem]:grid min-[87.5rem]:gap-x-5", COLS);
const EXPERT_ROW_GRID = "min-[87.5rem]:grid min-[87.5rem]:grid-cols-[minmax(0,1fr)_6.5rem_10.5rem_1rem] min-[87.5rem]:gap-x-5 min-[87.5rem]:gap-y-0";

/** 종목코드 · 만든 사람 · 시각 (· 비용). 표 모양 행(1400px 이상)에서는 오른쪽 칸에 두 줄로 오른쪽 맞춤. */
function Meta({ r, cost, className }: { r: ReportSummary; cost?: boolean; className?: string }) {
  return (
    <span className={cn(className, "min-[87.5rem]:col-start-3 min-[87.5rem]:row-span-2 min-[87.5rem]:row-start-1 min-[87.5rem]:mt-0 min-[87.5rem]:self-center min-[87.5rem]:text-right min-[87.5rem]:text-[13px] min-[87.5rem]:leading-snug")}>
      <span className="min-[87.5rem]:block min-[87.5rem]:truncate">
        {r.symbol} · {r.requestedBy}
      </span>
      <span className="min-[87.5rem]:hidden"> · </span>
      <span className="tabular-nums min-[87.5rem]:block">
        {formatDateTime(r.createdAt)}
        {cost && typeof r.costUsd === "number" && ` · ${formatCost(r.costUsd)}`}
      </span>
    </span>
  );
}

/** 표 모양 목록(1400px 이상)의 열 이름 줄 (화면 읽기에는 각 행이 이미 이름을 말하므로 숨긴다). */
function ColumnHead({ expert }: { expert: boolean }) {
  return (
    <div aria-hidden="true" className="mt-1 hidden gap-3 border-b border-line px-5 pb-2 text-[12px] font-semibold text-mute min-[87.5rem]:flex">
      <span className={cn("grid flex-1 gap-x-5", expert ? EXPERT_COLS : COLS)}>
        <span>종목 · AI 의견</span>
        <span>상태</span>
        <span className="text-right">만든 사람 · 시각</span>
      </span>
      <span className="w-4" />
    </div>
  );
}

function EasyCard({ r, rec, check, live }: { r: ReportSummary; rec: Recommendation | null; check: boolean; live: boolean }) {
  const completed = r.status === "completed";
  // 상세와 같은 판단: 미리 보기(예산 없음)가 activatable일 때만 '실행 가능'. 진행 중인 내 계획이 있으면 부르지 않는다
  const preview = useRiskPreview(rec?.id ?? NaN, null, check && completed && rec !== null && !live);
  const pv = preview.data && !preview.isPlaceholderData ? preview.data : undefined;
  const status = reportCardStatus(r.status, Boolean(pv?.activatable));
  const s = REPORT_CARD_TEXT[status];
  // 계획이 붙은 완성 카드의 문장 (받기 전에는 아무것도 말하지 않는다 — '실행 가능'이 떴다 사라지지 않게 칩도 '완성'으로 시작)
  const note = completed && rec && status !== "ready" ? (live ? PLAN_NOTE.live : pv ? PLAN_NOTE.blocked : check ? null : PLAN_NOTE.unchecked) : null;
  const sentence = note ?? (s.sentence || null);
  // 상태 칩이 바뀌는 순간(완성 → 실행 가능)만 살짝 페이드
  const chipChanged = useChanged(status);
  return (
    <Link to={`/reports/${r.id}`} className="press-row flex min-h-16 items-start gap-3 px-5 py-3.5 hover:bg-fill/60 min-[87.5rem]:items-center min-[87.5rem]:py-3">
      {/* 넓은 PC(1400px 이상): 표 모양 행 [종목·의견·한 줄 요약 | 상태 | 종목코드·만든 사람·시각] — 칸 배치만 바꾼다 (DOM 순서는 모바일과 같다) */}
      <article aria-label={`${r.name} 리포트`} className={cn("min-w-0 flex-1", ROW_GRID)}>
        {/* 한 줄 요약이 없으면 이름이 두 줄 높이 가운데에 (옆 칸의 상태·시각과 같은 높이) */}
        <span className={cn("flex flex-wrap items-center gap-1.5 min-[87.5rem]:col-start-1 min-[87.5rem]:row-start-1", !(completed && r.oneLiner) && "min-[87.5rem]:row-span-2 min-[87.5rem]:self-center")}>
          <span className="truncate text-[16px] font-semibold">{r.name}</span>
          {completed && <OpinionBadge opinion={r.opinion} />}
          {r.source === "auto" && <AutoBadge />}
        </span>
        {completed && r.oneLiner && (
          <span className="mt-1 block text-[14px] leading-snug text-ink min-[87.5rem]:col-start-1 min-[87.5rem]:row-start-2 min-[87.5rem]:mt-0.5 min-[87.5rem]:text-sub">{cleanReportText(r.oneLiner)}</span>
        )}
        <span className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[13px] text-sub min-[87.5rem]:col-start-2 min-[87.5rem]:row-span-2 min-[87.5rem]:row-start-1 min-[87.5rem]:mt-0 min-[87.5rem]:self-center min-[87.5rem]:leading-snug">
          <span
            key={status}
            className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[12px] font-bold", s.chip, chipChanged && "reveal-fade")}
          >
            <Icon name={s.icon} className="size-3.5" />
            {s.label}
          </span>
          {sentence}
        </span>
        <Meta r={r} className="mt-1 block text-[12px] text-mute" />
      </article>
      <Icon name="chevron" className="mt-1 size-4 shrink-0 text-mute-weak min-[87.5rem]:mt-0" />
    </Link>
  );
}

function ExpertRow({ r }: { r: ReportSummary }) {
  return (
    <Link to={`/reports/${r.id}`} className={cn("press-row flex min-h-16 items-center gap-3 px-5 py-3 hover:bg-fill/60", EXPERT_ROW_GRID)}>
      {/* min-w-0: 긴 한 줄 요약(truncate)이 행 폭을 밀어 화면이 가로로 넘치지 않게.
          넓은 PC(1400px 이상): 표 모양 행 [종목·의견·한 줄 요약 | 상태 | 종목코드·신청자·시각·비용] — 이 묶음을 풀어(contents) 상태 배지와 같은 격자에 둔다 (DOM 순서 그대로) */}
      <span className="min-w-0 flex-1 min-[87.5rem]:contents">
        <span
          className={cn(
            "flex min-w-0 items-center gap-1.5 min-[87.5rem]:col-start-1 min-[87.5rem]:row-start-1",
            !(r.status === "completed" && r.oneLiner) && "min-[87.5rem]:row-span-2 min-[87.5rem]:self-center",
          )}
        >
          <span className="truncate text-[16px] font-semibold">{r.name}</span>
          {r.source === "auto" && <AutoBadge />}
          {r.status === "completed" && <OpinionBadge opinion={r.opinion} expert />}
        </span>
        {r.status === "completed" && r.oneLiner && (
          <span className="block truncate text-[13px] text-sub min-[87.5rem]:col-start-1 min-[87.5rem]:row-start-2">{cleanReportText(r.oneLiner)}</span>
        )}
        <Meta r={r} cost className="block text-[13px] text-mute" />
      </span>
      <span className="shrink-0 min-[87.5rem]:col-start-2 min-[87.5rem]:row-span-2 min-[87.5rem]:row-start-1 min-[87.5rem]:self-center">
        <ReportStatusBadge status={r.status} />
      </span>
      <Icon name="chevron" className="size-4 shrink-0 text-mute-weak min-[87.5rem]:col-start-4 min-[87.5rem]:row-span-2 min-[87.5rem]:row-start-1 min-[87.5rem]:-ml-2 min-[87.5rem]:self-center" />
    </Link>
  );
}

/** 내 실패 리포트 카드 아래의 '다시 만들기' (같은 종목 — 상세 실패 화면 EasyFailure와 같다). 카드 링크 안에 버튼을 넣지 않는다. */
function RetryRow({ r }: { r: ReportSummary }) {
  const navigate = useNavigate();
  const request = useRequestReport();
  const quota = useReportQuota();
  const full = quota.data?.remaining === 0;
  return (
    <div className="-mt-1.5 flex flex-wrap items-center gap-x-2 px-5 pb-2.5">
      <button
        type="button"
        disabled={request.isPending || full}
        onClick={() => request.mutate({ symbol: r.symbol }, { onSuccess: (n) => navigate(`/reports/${n.id}`) })}
        className="press -ml-1.5 flex min-h-11 items-center gap-1 rounded-lg px-1.5 text-[13px] font-semibold text-brand-ink hover:bg-fill disabled:cursor-not-allowed disabled:opacity-40"
      >
        {request.isPending ? <Spinner /> : <Icon name="restart" className="size-4" />}
        {r.name} 다시 만들기
      </button>
      {full && <span className="text-[12px] text-mute">오늘은 다 만들었어요</span>}
      {request.isError && (
        <span role="alert" className="basis-full text-[12px] leading-snug text-up-ink">
          {errorSentence(request.error)}
        </span>
      )}
    </div>
  );
}

/** 팀 리포트 거르기: 묶음 칩보다 낮은 위계의 작은 글자 칩 (보이는 높이 32px, 누름 영역 44px). */
function FilterChips({ value, onChange }: { value: Filter; onChange: (v: Filter) => void }) {
  return (
    <div role="group" aria-label="리포트 거르기" className="flex flex-wrap gap-1.5">
      {FILTERS.map((f) => {
        const on = value === f.value;
        return (
          <button
            key={f.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(f.value)}
            className={cn(
              "press relative h-8 rounded-full border px-3 text-[13px] font-semibold before:absolute before:inset-x-0 before:-inset-y-1.5",
              on ? "border-ink bg-ink text-on-ink" : "border-line bg-card text-sub hover:bg-fill",
            )}
          >
            {f.label}
          </button>
        );
      })}
    </div>
  );
}

function Reports({ group, expert }: { group: Group; expert: boolean }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("filter");
  const filter: Filter = isFilter(raw) ? raw : "all";
  const [page, setPage] = usePageParam("page");
  const byFilter = expert && group === "team" ? filter : "all";
  // 팀 리포트는 남의 실패·자동 리포트 실패를 서버가 뺀다(feed=team, UX-15)
  const at = { limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE };
  const query = useReports(
    group === "mine" ? { mine: true, ...at } : byFilter === "auto" ? { source: "auto", feed: "team", ...at } : { feed: "team", ...at },
    { keepPrevious: true },
  );
  const { data, isPending, isError, error, refetch, isFetching, isPlaceholderData } = query;
  const pages = Math.ceil((data?.count ?? 0) / PAGE_SIZE);
  // 없는 쪽(주소를 직접 고쳤거나 목록이 줄었다)이면 마지막 쪽으로
  const over = data !== undefined && !isPlaceholderData && pages > 0 && page > pages;
  useEffect(() => {
    if (over) setPage(pages);
  }, [over, pages, setPage]);
  // 거르기를 바꾸면 첫 쪽부터 (한 번에 바꿔 없는 쪽을 잠깐도 부르지 않게)
  const changeFilter = (f: Filter) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (f === "all") sp.delete("filter");
        else sp.set("filter", f);
        sp.delete("page");
        return sp;
      },
      { replace: true },
    );
  // 처음 불러온 목록만 한 번 페이드 (캐시로 바로 그리면 움직이지 않는다). early return보다 앞에서 부른다
  const reveal = useRevealAfterLoading(isPending);
  // 쉬운 보기의 "실행 가능": 열린 리포트 추천을 한 번에 받는다 (내 계획 진행 여부 myPlan 포함)
  const open = useRecommendations({ source: "report", status: "open", limit: 100 }, !expert);
  const recOf = new Map<number, Recommendation>();
  for (const x of open.data?.results ?? []) {
    if (x.sourceId === null) continue;
    const prev = recOf.get(x.sourceId);
    if (!prev || x.createdAt > prev.createdAt) recOf.set(x.sourceId, x);
  }
  // 내 리포트인지: 내 리포트 목록(하단 탭의 점·만드는 중 띠와 같은 캐시)에 있거나 신청자가 내 닉네임 (자동 리포트는 "자동")
  const me = useMe();
  const mineQ = useReports({ mine: true });
  const mineIds = new Set((mineQ.data?.results ?? []).map((r) => r.id));
  const isMine = (r: ReportSummary) => group === "mine" || mineIds.has(r.id) || (r.source !== "auto" && me.data?.nickname === r.requestedBy);
  const rows = data?.results ?? [];
  // 쪽 위쪽 완성 카드 5개까지만 미리 보기를 확인한다
  const checked = new Set<number>();
  for (const r of rows) {
    const rec = recOf.get(r.id);
    if (checked.size >= PREVIEW_LIMIT) break;
    if (r.status === "completed" && rec && !(rec.myPlan && isPlanLive(rec.myPlan.status))) checked.add(r.id);
  }
  const empty =
    group === "mine"
      ? "아직 만든 리포트가 없어요. 만들기 카드에서 종목을 골라 만들 수 있어요."
      : byFilter === "auto"
        ? "자동 리포트가 아직 없습니다."
        : "아직 신청한 리포트가 없습니다.";

  return (
    <>
      {expert && group === "team" && (
        <div className="px-5 pb-1">
          <FilterChips value={filter} onChange={changeFilter} />
        </div>
      )}
      {isPending ? (
        <ListSkeleton />
      ) : isError ? (
        <div className="px-5 py-3">
          <ErrorPanel kind={errorKindOf(error)} detail={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} secondary={null} compact className="bg-fill" />
        </div>
      ) : rows.length === 0 && !over ? (
        <EmptyState icon="doc" compact className="px-5">
          {empty}
        </EmptyState>
      ) : (
        <>
          <ColumnHead expert={expert} />
          <ul
            aria-label="리포트 목록"
            aria-busy={isPlaceholderData || undefined}
            {...revealList(reveal)}
            className={cn("mt-2 divide-y divide-line transition-opacity duration-fast", isPlaceholderData && "opacity-60")}
          >
            {rows.map((r) => {
              const rec = recOf.get(r.id) ?? null;
              const live = rec?.myPlan && isPlanLive(rec.myPlan.status) ? rec.myPlan : null;
              return (
                <li key={r.id}>
                  {expert ? <ExpertRow r={r} /> : <EasyCard r={r} rec={rec} check={checked.has(r.id)} live={live !== null} />}
                  {!expert && r.status === "failed" && isMine(r) && <RetryRow r={r} />}
                  {/* 이 리포트로 진행 중인 내 모의 자동매매로 바로 (카드 링크 안에 링크를 넣지 않는다) */}
                  {!expert && live && r.status === "completed" && (
                    <Link
                      to={`/plans/${live.id}`}
                      className="press-row -mt-1.5 flex min-h-11 items-center gap-1 px-5 pb-2.5 text-[13px] font-semibold text-brand-ink hover:bg-fill/60"
                    >
                      <Icon name="flow" className="size-4" />
                      내 모의 자동매매 보기
                      <Icon name="chevron" className="size-3.5" />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          <Pager page={Math.min(page, Math.max(pages, 1))} total={pages} onChange={setPage} name="리포트 목록" anchorId="list-title" />
        </>
      )}
    </>
  );
}

export function ReportList({ expert, className }: { expert: boolean; className?: string }) {
  const [params, setParams] = useSearchParams();
  const raw = params.get("list");
  const group: Group = isGroup(raw) ? raw : "team";
  const choose = (g: Group) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (g === "team") sp.delete("list");
        else sp.set("list", g);
        sp.delete("page");
        sp.delete("filter");
        return sp;
      },
      { replace: true },
    );
  const sub = group === "mine" ? "내가 만든 리포트 · 최신순" : "팀 전체 공용 · 최신순";

  return (
    <Card aria-labelledby="list-title" className={cn("scroll-mt-20 px-0 pb-2 lg:scroll-mt-(--rail-top)", className)}>
      {/* PC: 묶음 칩이 이미 고른 묶음 이름을 보이므로 제목은 화면 읽기용으로만 두고(이름은 그대로), 칩 오른쪽에 정렬 설명 한 줄 */}
      <div className="px-5 lg:grid lg:grid-cols-[auto_minmax(0,1fr)] lg:items-center lg:gap-x-4 lg:pb-1">
        <h2 id="list-title" className="scroll-mt-20 text-[17px] font-bold lg:sr-only">
          {GROUPS.find((g) => g.value === group)?.label}
        </h2>
        <p className="mt-0.5 text-[13px] text-mute lg:col-start-2 lg:row-start-1 lg:mt-0 lg:text-right">{sub}</p>
        <Segmented label="리포트 묶음" className="mt-2.5 mb-2.5 w-full lg:col-start-1 lg:row-start-1 lg:my-0 lg:w-auto lg:min-w-[22rem]" value={group} onChange={choose} options={GROUPS} />
      </div>
      {/* 묶음을 바꾸면 그 묶음의 목록을 새로 그린다 (다른 묶음의 목록이 그 제목 아래 잠깐 보이지 않게) */}
      <Reports key={group} group={group} expert={expert} />
    </Card>
  );
}
