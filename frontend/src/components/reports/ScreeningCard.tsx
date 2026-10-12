// 리포트 탭의 '오늘의 선별 결과' 카드 — 쉬운 보기·전문가 보기 공통 (2026-10-12, docs/DECISIONS.md 34장).
// 칩 [오늘의 선별 · 교차검증 분석]: 교차검증 분석 목록(예전 리포트 목록의 셋째 칩)이 이 카드로 들어왔다. 고른 칩은 주소의 ?screening=cross
// (기본 오늘의 선별). 예전 주소 ?list=analyses(홈 '교차검증 분석 전체 보기'·분석 상세의 '뒤로')는 ?screening=cross로 바꿔 읽고 이 카드로 옮긴다.
//
// 오늘의 선별은 선정 팀(stock_selection)이 고른 날이면 "AI 선정 팀이 고르고 안전장치가 거른 종목", 팀이 실패한 날이면 "오늘은 규칙으로 골랐어요"와
// 사유, 고르는 중이면 그 사실을 먼저 말한다. 예전 파일(선정 키 없음)은 예전 화면 그대로다.
// 종목마다 그 종목의 가장 최근 교차검증 분석을 잇는다 — 있으면 결과(날짜와 함께), 없으면 종목 화면에서 받기. 선별 → 교차검증 → 리포트로 이어 보게.
// 쉬운 보기는 고른 종목·테마·AI가 고른 이유만 — 점수·거래대금 순위·AI 순위·다시 시도·안전장치가 뺀 종목·탈락 사유는 전문가 보기에서만
// (점수·확률은 끔 모드에서 — DECISIONS 13-1 D-1과 같은 기준).
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { errorMessage } from "../../api/client";
import { useAnalyses } from "../../api/queries";
import { useScreening } from "../../api/reports";
import type { AnalysisSummary, ScreeningFiltered, ScreeningResult } from "../../api/types";
import { useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatDateTime } from "../../lib/format";
import { selectionFallbackSentence } from "../../lib/plainText";
import { CROSS_CHECK_TEXT, VERDICT_TEXT } from "../../lib/reports";
import { Icon } from "../Icon";
import { ErrorPanel } from "../errors/ErrorPanel";
import { errorKindOf } from "../errors/errorTypes";
import { Collapse } from "../motion/Collapse";
import { Card, LiveDot, Notice, Segmented, Skeleton } from "../ui";
import { CrossCheckList } from "./CrossCheckList";
import { ExampleTag } from "./StatusChip";

type Tab = "picks" | "cross";
const TABS: { value: Tab; label: string }[] = [
  { value: "picks", label: "오늘의 선별" },
  { value: "cross", label: "교차검증 분석" },
];

const text = (v: unknown) => (typeof v === "string" || typeof v === "number" ? String(v) : "-");
/** 있으면 그 글자, 비었거나 글자가 아니면 null (선정 팀 키는 예전 파일에 없다). */
const optText = (v: unknown) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);
const optInt = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);

const tag = "inline-flex h-6 shrink-0 items-center rounded-md px-1.5 text-[12px] font-semibold whitespace-nowrap";
const linkRow = "-mx-1 inline-flex min-h-9 items-center gap-1 rounded-md px-1 text-[13px] font-semibold text-brand-ink";

/**
 * 누가 골랐는지: AI 선정 팀 · 규칙(Fallback, 사유) · 고르는 중. 선정 키가 없는 파일이면 아무것도 보이지 않는다.
 * 선정 실행이 있으면 그 과정(/reports/{id})으로 가는 길 — 예시(서버에 선별이 없음)에는 두지 않는다 (다른 리포트로 가지 않게).
 */
function SelectionNote({ s, example }: { s: ScreeningResult; example: boolean }) {
  const reportId = !example && typeof s.selection?.reportId === "number" ? s.selection.reportId : null;
  const link = reportId !== null && (
    <Link to={`/reports/${reportId}`} className={cn(linkRow, "gap-0.5 hover:bg-fill")}>
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

/** 선정 Guard가 뺀 종목 (접힘, 전문가 보기). AI가 고른 종목과, 모자라 규칙 후보로 채우다 뺀 종목을 나눠 보인다. */
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

/** 선별 종목의 교차검증 한 줄: 최근 분석이 있으면 그 결과로, 없으면 종목 화면(교차검증 받기)으로. 칸 전체를 링크로 만들지 않는다 (링크 하나만). */
function CrossCheckLink({ symbol, a, expert }: { symbol: string; a: AnalysisSummary | undefined; expert: boolean }) {
  if (!a) {
    return (
      <Link to={`/stocks/${symbol}`} className={cn(linkRow, "mt-1.5 hover:bg-card")}>
        <Icon name="sparkle" className="size-4 shrink-0" />
        종목에서 교차검증 받기
        <Icon name="chevron" className="size-3.5 shrink-0" />
      </Link>
    );
  }
  const verdict = expert ? VERDICT_TEXT[a.verdict] : CROSS_CHECK_TEXT[a.verdict].badge;
  return (
    <Link
      to={`/analyses/${a.id}`}
      aria-label={`${a.name} 교차검증 결과 보기 — ${verdict}, ${formatDateTime(a.analyzedAt)}`}
      className={cn(linkRow, "mt-1.5 flex-wrap hover:bg-card")}
    >
      교차검증
      <span className={cn(tag, "h-5", a.verdict === "BUY" ? "bg-brand-soft text-brand-ink" : "bg-card text-sub")}>{verdict}</span>
      <span className="font-normal text-mute tabular-nums">{formatDateTime(a.analyzedAt)}</span>
      <Icon name="chevron" className="size-3.5 shrink-0" />
    </Link>
  );
}

/**
 * 선별 종목 한 칸: 순위 · 이름 · 코드, 테마 · AI가 고른 이유 · 교차검증 한 줄.
 * 전문가 보기는 거래대금 순위 · 점수와 AI 순위 · 규칙으로 채움 · 다시 시도 꼬리표를 더한다.
 */
function PickItem({
  p,
  rank,
  ruleDay,
  expert,
  analysis,
}: {
  p: Record<string, unknown>;
  rank: number;
  ruleDay: boolean;
  expert: boolean;
  analysis: AnalysisSummary | undefined;
}) {
  const aiRank = expert ? optInt(p.aiRank) : null;
  const aiReason = optText(p.aiReason);
  const theme = optText(p.theme);
  // 규칙으로 고른 날은 모두 규칙이라 칸마다 붙이지 않는다 (위 안내가 말한다)
  const byRule = expert && p.filledByRule === true && !ruleDay;
  const retryRound = expert ? optInt(p.retryRound) : null;
  const tags = aiRank !== null || theme !== null || byRule || retryRound !== null;
  const symbol = text(p.symbol);
  return (
    <li className="flex flex-col rounded-xl bg-fill px-3 py-2.5">
      <div className="flex items-center gap-2.5">
        {/* 반전 순위 원: 다크에서는 밝은 원 + 어두운 숫자 */}
        <span className="grid size-6 shrink-0 place-items-center rounded-full bg-ink text-[12px] font-bold text-on-ink">{rank}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[15px] font-semibold">{text(p.name)}</span>
          <span className="block text-[12px] text-mute">
            {symbol}
            {expert && ` · 거래대금 ${text(p.tradingAmountRank)}위`}
          </span>
        </span>
        {expert && <span className="text-[17px] font-bold tabular-nums">{text(p.score)}</span>}
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
      {/* 교차검증 한 줄은 칸 바닥에 (옆 칸과 높이가 달라도 같은 선에) */}
      <span className="mt-auto">
        <CrossCheckLink symbol={symbol} a={analysis} expert={expert} />
      </span>
    </li>
  );
}

/** 선별 칩: 누가 골랐는지, 종목(교차검증 한 줄과 함께), 전문가 보기면 안전장치가 뺀 종목(접힘)·탈락 사유 요약. 선별이 없으면(404) 서버 대신 예시(api/reports.ts). */
function Picks({ expert }: { expert: boolean }) {
  const { data, isPending, isError, error, refetch, isFetching } = useScreening();
  // 종목별 가장 최근 교차검증 분석: 최근 목록 한 번 (홈 '교차검증 분석' 카드와 같은 캐시)
  const analyses = useAnalyses();
  const reveal = useRevealAfterLoading(isPending);
  const s = data?.data;
  const latest = new Map<string, AnalysisSummary>();
  for (const a of analyses.data?.results ?? []) {
    const prev = latest.get(a.symbol);
    if (!prev || a.analyzedAt > prev.analyzedAt) latest.set(a.symbol, a);
  }
  const reasons = new Map<string, number>();
  for (const d of s?.dropped ?? []) reasons.set(text(d.reason), (reasons.get(text(d.reason)) ?? 0) + 1);
  if (isPending) {
    return (
      <div className="mt-3 space-y-2 px-5">
        <Skeleton className="h-4 w-1/2" />
        <div className="grid gap-2 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }
  if (isError) {
    return (
      <div className="mt-2 px-5">
        <ErrorPanel kind={errorKindOf(error)} detail={errorMessage(error)} onRetry={() => void refetch()} retrying={isFetching} secondary={null} compact className="bg-fill" />
      </div>
    );
  }
  if (!s) return <p className="mt-2 px-5 text-[14px] text-mute">오늘 선별이 아직 없습니다.</p>;
  return (
    <div className={cn("px-5", reveal && "reveal-fade")}>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[13px] text-mute">
        {data.example && <ExampleTag />}
        {expert ? (
          <span>
            {formatDateTime(s.at)} · 거래대금 상위 {s.rankCount}개 중 {s.eligibleCount}개 대상
            {s.candidates && s.candidates.length > 0 && ` · 후보 ${s.candidates.length}개`} · {s.picks.length}개 선별
            {s.retries ? ` (손익비 기준을 넘는 추천이 없어 다시 시도 ${s.retries}번)` : null}
          </span>
        ) : (
          <span>
            {formatDateTime(s.at)} · 거래가 많은 {s.rankCount}개 종목 중 {s.picks.length}개를 골랐어요
          </span>
        )}
      </p>
      <SelectionNote s={s} example={data.example} />
      {s.picks.length > 0 ? (
        <ol aria-label="선별 종목" className="mt-3 grid gap-2 sm:grid-cols-3">
          {s.picks.map((p, i) => (
            <PickItem
              key={text(p.symbol)}
              p={p}
              rank={i + 1}
              ruleDay={s.selectedBy === "rule"}
              expert={expert}
              analysis={latest.get(text(p.symbol))}
            />
          ))}
        </ol>
      ) : (
        <p className="mt-3 rounded-xl bg-fill px-3 py-3 text-[14px] text-mute">오늘 선별된 종목이 없어요.</p>
      )}
      {expert && <FilteredList s={s} />}
      {expert && reasons.size > 0 && (
        <p className="mt-2.5 text-[13px] text-sub">
          탈락 {s.dropped.length}개: {[...reasons].map(([r, n]) => `${r} ${n}`).join(" · ")}
          {s.excluded.length > 0 && ` · 제외(ETF 등) ${s.excluded.length}개`}
        </p>
      )}
    </div>
  );
}

export function ScreeningCard({ expert, className }: { expert: boolean; className?: string }) {
  const [params, setParams] = useSearchParams();
  const legacy = params.get("list") === "analyses";
  const tab: Tab = params.get("screening") === "cross" || legacy ? "cross" : "picks";
  const title = useRef<HTMLHeadingElement>(null);
  const choose = (t: Tab) =>
    setParams(
      (prev) => {
        const sp = new URLSearchParams(prev);
        if (t === "cross") sp.set("screening", "cross");
        else sp.delete("screening");
        sp.delete("cpage");
        return sp;
      },
      { replace: true },
    );
  // 교차검증 칩을 고른 주소로 들어오면(홈 '교차검증 분석 전체 보기'·분석 상세의 '뒤로') 이 카드로 옮긴다 — 들어온 때만.
  // 예전 주소 ?list=analyses는 ?screening=cross로 바꾼다 (리포트 목록의 ?list=와 섞이지 않게)
  const [arrivedCross] = useState(tab === "cross");
  useEffect(() => {
    if (legacy)
      setParams(
        (prev) => {
          const sp = new URLSearchParams(prev);
          sp.delete("list");
          sp.set("screening", "cross");
          return sp;
        },
        { replace: true },
      );
  }, [legacy, setParams]);
  useEffect(() => {
    const card = title.current?.closest("section");
    if (!arrivedCross || !card || typeof card.scrollIntoView !== "function") return;
    const align = () => card.scrollIntoView({ block: "start" });
    align();
    // 위의 목록(만들기 카드·리포트 목록)이 늦게 그려지면 카드가 아래로 밀린다 — 잠깐(1.5초) 동안은 높이가 바뀔 때마다 다시 맞춘다.
    // 사용자가 먼저 움직이면(굴림·누름·키) 그만둔다 (읽던 자리를 빼앗지 않게)
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(align);
    ro?.observe(document.body);
    const events = ["wheel", "touchstart", "pointerdown", "keydown"] as const;
    const stop = () => {
      ro?.disconnect();
      for (const e of events) window.removeEventListener(e, stop);
    };
    for (const e of events) window.addEventListener(e, stop, { passive: true });
    const timer = setTimeout(stop, 1500);
    return () => {
      clearTimeout(timer);
      stop();
    };
  }, [arrivedCross]);
  return (
    <Card aria-labelledby="screening-title" className={cn("scroll-mt-20 px-0 pb-3 lg:scroll-mt-(--rail-top)", className)}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2.5 px-5">
        <h2 ref={title} id="screening-title" className="text-[17px] font-bold">
          오늘의 선별 결과
        </h2>
        <Segmented label="선별 결과 묶음" className="w-full sm:w-auto sm:min-w-[16rem]" value={tab} onChange={choose} options={TABS} />
      </div>
      {tab === "picks" ? (
        <Picks expert={expert} />
      ) : (
        <div className="pt-2.5">
          <CrossCheckList expert={expert} anchorId="screening-title" />
        </div>
      )}
    </Card>
  );
}
