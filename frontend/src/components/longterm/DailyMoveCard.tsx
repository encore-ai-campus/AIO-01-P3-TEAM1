// 오늘의 내 종목 뉴스 카드 (docs/API.md "장기투자" DailyMove). 홈이 쓴다.
//
// - 스스로 받는다: useDailyMoves(date) — 내가 보유 중인 국내 종목의 그날 기록. 기록이 없으면 빈 안내.
// - 쉬운 보기: 종목마다 세 숫자(시장(대용 ETF 기준) · 업종(자료 없음) · 내 종목) + headline + 설명 문장(최대 3개),
//   uncertain이면 "뚜렷한 소식을 찾지 못했어요", 근거(evidence)는 출처·시각과 함께 접어서.
// - 전문가 보기: 수치형 — 종목 등락률 · 시장 대용 ETF 등락률 · 시장 대비 초과 등락 · 20일 변동성 · 수급 비율 + 근거 목록(출처·시각·공시 원문 링크).
//   density="summary"(홈): 종목마다 한 줄 요약을 눌러 펼친다 — 근거는 숫자가 이상해 보일 때만 필요한 2차 정보라 홈을 덮지 않게 (근거 목록도 접는다).
// - emptyMode="compact"(홈): 보유가 없으면 그리지 않고, 미국 종목만 있거나 기록 전이면 한 줄만.
// - 늘 보이는 것: 고정 문구 DAILY_MOVE_CAPTION(내용을 보일 때), "국내 종목만", 업종 자료 없음, 종가의 장마감 기준(AsOf).
// 숫자 분해는 회계식(β=1)이지 원인이 아니다 — 화면도 "때문에" 같은 말을 쓰지 않는다.
import { type RefObject, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useAccount } from "../../api/queries";
import { useDailyMoves } from "../../api/longterm";
import type { DailyMove, DailyMoveEvidence } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { useNewKeys, useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatDateTime, formatDayLabel, formatKrw, formatPercent, formatRate } from "../../lib/format";
import { prefersReducedMotion } from "../../lib/motion";
import { DAILY_MOVE_CAPTION, DAILY_MOVE_KR_ONLY, DAILY_MOVE_UNCERTAIN, SECTOR_MISSING } from "../../lib/plainText";
import { CHANGED_MS } from "../home/homeHooks";
import { kstDay } from "../home/homeData";
import { SectionError } from "../home/HomeStates";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { Term } from "../Term";
import { AsOf, RateText, Row, Skeleton } from "../ui";
import { EVIDENCE_KIND_TEXT, RELIABILITY_TEXT } from "./longtermText";

export interface DailyMoveCardProps {
  /** 기록 날짜 YYYY-MM-DD. 없으면 가장 최근 기록일 (홈 카드). */
  date?: string | null;
  /** 쉬운 보기(문장) · 전문가 보기(수치형). */
  view: ViewMode;
  /** 처음에 보일 종목 수 (홈 카드는 3). 없으면 전부. 넘는 종목은 "외 N종목 더 보기"로 펼친다. */
  limit?: number;
  /** 전문가 보기의 모양: full(기본) 다 펼침 · summary(홈) 종목마다 한 줄 요약 → 눌러 펼친다. */
  density?: "full" | "summary";
  /**
   * 빈 상태: full(기본) 늘 빈 안내 · compact(홈) 보유가 없으면 그리지 않고, 미국 종목만·기록 전이면 한 줄.
   * compact는 홈 열(space-y-6)에서 앞 섹션 다음에 둔다 — 카드 위 24px 간격을 접히는 안쪽에 스스로 가진다 (HomeDailyMove).
   */
  emptyMode?: "full" | "compact";
  /** 카드의 id (홈의 알림 착지점 #daily-move). */
  id?: string;
  /** 바뀌면(알림에서 왔을 때) 기록을 받은 뒤 카드로 스크롤하고, 제목에 포커스·잠깐 강조하고, 첫 종목을 펼친다. */
  focusKey?: string | null;
  className?: string;
}

/** 홈의 빈 상태 판단에 쓰는 보유 상황 (계좌를 아직 받지 않았으면 unknown). */
type Holdings = "unknown" | "none" | "us-only" | "kr";

function Evidence({ items, day, detailed }: { items: DailyMoveEvidence[]; day: string; detailed: boolean }) {
  return (
    <ul aria-label="같은 날 나온 소식" className="mt-2 space-y-2">
      {items.map((e) => (
        <li key={e.id} className="rounded-lg bg-fill px-3 py-2 text-[13px] leading-snug">
          <p className="flex flex-wrap items-center gap-x-1.5 text-[12px] text-mute">
            {detailed && <span className="font-mono">{e.id}</span>}
            <span className="font-semibold text-sub">{EVIDENCE_KIND_TEXT[e.kind]}</span>
            <span>· {RELIABILITY_TEXT[e.reliability]}</span>
          </p>
          <p className="mt-0.5 text-ink">{e.text}</p>
          <p className="mt-0.5 text-[12px] text-mute">
            출처: {e.source} · {e.at ? formatDateTime(e.at) : `${formatDayLabel(day)} (날짜만)`}
            {e.url && (
              <>
                {" · "}
                <a href={e.url} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-ink underline">
                  공시 원문
                </a>
              </>
            )}
          </p>
        </li>
      ))}
    </ul>
  );
}

/** 근거를 접어 두는 줄 (누름 자리 44px, 펼치면 › 가 돈다). */
function EvidenceFold({ m, detailed, label }: { m: DailyMove; detailed: boolean; label: string }) {
  return (
    <details className="group mt-1">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1 rounded-lg text-[13px] font-semibold text-sub [&::-webkit-details-marker]:hidden">
        {label}
        <Icon name="chevron-down" className="size-4 shrink-0 text-mute-weak transition-transform duration-fast group-open:rotate-180" />
      </summary>
      <Evidence items={m.evidence} day={m.date} detailed={detailed} />
    </details>
  );
}

function Number3({ label, value, rate }: { label: string; value?: string; rate?: number | null }) {
  // 라벨이 두 줄로 꺾여도 값은 칸 아래에 맞춘다 (세 숫자를 한 줄로 비교하는 장치라 값의 높이가 같아야 한다)
  return (
    <div className="flex flex-col rounded-xl bg-fill px-2.5 py-2">
      <dt className="text-[12px] leading-tight text-mute">{label}</dt>
      <dd className="mt-auto pt-0.5 text-[15px] font-bold tabular-nums">{value ?? <RateText rate={rate} />}</dd>
    </div>
  );
}

function EasyMove({ m }: { m: DailyMove }) {
  return (
    <>
      <dl aria-label={`${m.name} 세 숫자`} className="mt-2 grid grid-cols-3 gap-2 text-center">
        <Number3 label={`시장(${m.marketProxy.name} 기준)`} rate={m.marketProxy.changeRate} />
        <Number3 label="업종" value={SECTOR_MISSING.replace("업종 ", "")} />
        <Number3 label="내 종목" rate={m.changeRate} />
      </dl>
      <p className="mt-3 text-[15px] font-bold leading-snug">{m.headline}</p>
      <ul className="mt-1 space-y-1 text-[14px] leading-relaxed text-sub">
        {m.summary.slice(0, 3).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      {m.uncertain && <p className="mt-2 rounded-lg bg-fill px-3 py-2 text-[13px] text-sub">{DAILY_MOVE_UNCERTAIN}</p>}
      {m.evidence.length > 0 && <EvidenceFold m={m} detailed={false} label={`같은 날 나온 소식 ${m.evidence.length}개 (출처·시각)`} />}
    </>
  );
}

const excessText = (m: DailyMove) => (m.excessChangeRate === null ? "-" : `${formatRate(m.excessChangeRate)}p`);

function ExpertMove({ m, foldEvidence }: { m: DailyMove; foldEvidence: boolean }) {
  const flows = m.flows;
  const flow = (v: number | null | undefined) => formatRate(v ?? null, 1);
  return (
    <>
      <dl aria-label={`${m.name} 등락 분해`} className="mt-2 grid gap-x-6 sm:grid-cols-2">
        <Row label="종목 등락률">
          <RateText rate={m.changeRate} />
        </Row>
        <Row label={`시장 (${m.marketProxy.name} 기준)`}>
          <RateText rate={m.marketProxy.changeRate} />
        </Row>
        <Row label={<Term k="초과 등락">시장 대비 초과 등락</Term>}>{excessText(m)}</Row>
        <Row label="업종">{SECTOR_MISSING.replace("업종 ", "")}</Row>
        <Row label={<Term k="변동성">20일 변동성</Term>}>{formatPercent(m.volatility20, 2)}</Row>
        <Row label="종가 (전일)">
          {formatKrw(m.close)} ({formatKrw(m.prevClose)})
        </Row>
      </dl>
      <div className="mt-2">
        <p className="text-[13px] font-semibold text-sub">
          <Term k="수급" /> (순매수 ÷ 거래량)
        </p>
        {flows ? (
          <p className="mt-0.5 text-[14px] tabular-nums">
            외국인 {flow(flows.foreign)} · 기관 {flow(flows.institution)} · 개인 {flow(flows.individual)}
          </p>
        ) : (
          <p className="mt-0.5 text-[13px] text-mute">수급 자료 없음</p>
        )}
      </div>
      <p className="mt-3 text-[15px] font-bold leading-snug">{m.headline}</p>
      <ul className="mt-1 space-y-1 text-[14px] leading-relaxed text-sub">
        {m.summary.slice(0, 3).map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
      <p className="mt-1 text-[12px] text-mute">
        {m.method === "llm" ? `AI 설명 (검사 통과) · 근거 ${m.drivers.join(", ") || "-"}` : "정해진 문장 (AI 설명 아님)"}
        {m.uncertain && ` · ${DAILY_MOVE_UNCERTAIN}`}
      </p>
      {m.evidence.length === 0 ? (
        <p className="mt-2 text-[13px] text-mute">근거 자료 없음</p>
      ) : foldEvidence ? (
        <EvidenceFold m={m} detailed label={`같은 날 나온 소식 ${m.evidence.length}개 (출처·시각·공시 원문)`} />
      ) : (
        <Evidence items={m.evidence} day={m.date} detailed />
      )}
      {m.missing.length > 0 && (
        <ul aria-label="비운 칸" className="mt-2 list-disc space-y-0.5 pl-5 text-[12px] text-mute">
          {m.missing.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 홈 전문가 보기의 종목 한 줄 요약: 이름·코드 / 종가·등락률 / 시장 대비 / 헤드라인 → 누르면 등락 분해·수급·근거가 펼쳐진다. */
function SummaryMove({ m, open, onToggle, showAsOf }: { m: DailyMove; open: boolean; onToggle: () => void; showAsOf: boolean }) {
  const bodyId = useId();
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={onToggle}
        className="press-row -mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-xl px-2 py-2.5 text-left hover:bg-fill/50"
      >
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline justify-between gap-x-3">
            <span className="text-[16px] font-bold">
              {m.name} <span className="text-[13px] font-normal text-mute">{m.symbol}</span>
            </span>
            <span className="text-[14px] tabular-nums">
              종가 {formatKrw(m.close)} <RateText rate={m.changeRate} className="text-[13px]" />
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-[13px] text-sub">
            <span className="shrink-0 tabular-nums">시장 대비 {excessText(m)}</span>
            <span aria-hidden="true" className="text-mute-weak">
              ·
            </span>
            <span className="truncate">{m.headline}</span>
          </span>
        </span>
        <Icon name="chevron-down" className={cn("mt-1 size-5 shrink-0 text-mute-weak transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id={bodyId}>
        <div className="pb-2">
          {showAsOf && <AsOf at={m.asOf} />}
          <ExpertMove m={m} foldEvidence />
        </div>
      </Collapse>
    </>
  );
}

/** 알림에서 왔을 때: 기록을 받은 다음 프레임에 카드로 스크롤 → 제목 포커스 → 2초 강조 → 첫 종목 펼치기. */
function useLanding(
  focusKey: string | null | undefined,
  ready: boolean,
  section: RefObject<HTMLElement | null>,
  heading: RefObject<HTMLHeadingElement | null>,
  onLand: () => void,
): boolean {
  // 강조 중인 착지 번호 (0 = 꺼짐). 착지할 때마다 바뀌어 끄는 타이머가 새로 2초를 센다
  const [lit, setLit] = useState(0);
  const landed = useEffectEvent(onLand);
  useEffect(() => {
    if (!focusKey || !ready) return;
    const run = () => {
      const el = section.current;
      if (!el) return;
      if (typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "start", behavior: prefersReducedMotion() ? "auto" : "smooth" });
      heading.current?.focus({ preventScroll: true });
      landed();
      // 강조는 정적 테두리를 잠깐 붙였다 뗀다 (동작 줄이기에서도 보이게). 떼는 순간만 부드럽게 빠진다
      setLit((n) => n + 1);
    };
    // 다음 프레임에 (위 섹션들이 막 그려진 뒤의 자리로 가게)
    const raf = typeof requestAnimationFrame === "function";
    const handle = raf ? requestAnimationFrame(run) : window.setTimeout(run, 0);
    return () => {
      if (raf) cancelAnimationFrame(handle);
      else window.clearTimeout(handle);
    };
  }, [focusKey, ready, section, heading]);
  // 끄는 타이머는 착지와 따로 둔다 — 2초 안에 뒤로 가기로 착지가 풀려도(focusKey가 비어 위 effect가 정리돼도) 강조가 남지 않게
  useEffect(() => {
    if (lit === 0) return;
    const timer = window.setTimeout(() => setLit(0), CHANGED_MS);
    return () => window.clearTimeout(timer);
  }, [lit]);
  return lit > 0;
}

function MoveCard({
  date = null,
  view,
  limit,
  density = "full",
  id,
  focusKey,
  className,
  holdings,
}: DailyMoveCardProps & { holdings: Holdings }) {
  const q = useDailyMoves(date);
  const expert = view === "expert";
  const summary = expert && density === "summary";
  // 홈(compact): 계좌로 보유를 알면 빈 상태를 한 줄로 줄인다 (모르면 지금처럼 빈 안내)
  const homeEmpty = holdings !== "unknown";
  const [expanded, setExpanded] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const all = q.data?.results ?? [];
  const shown = limit && !expanded ? all.slice(0, limit) : all;
  const day = q.data?.date ?? date;
  const titleId = useId();
  const reveal = useRevealAfterLoading(q.isPending);
  // '더 보기'로 새로 보인 종목만 움직인다 (처음 받은 목록은 그대로)
  const fresh = useNewKeys(
    shown.map((m) => m.symbol),
    !q.isPending,
  );
  const section = useRef<HTMLElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const firstNew = useRef<HTMLElement>(null);
  const lit = useLanding(focusKey, q.isSuccess, section, heading, () => {
    if (summary && all[0]) setOpened(new Set([all[0].symbol]));
  });

  // '더 보기'를 누르면 버튼이 사라진다 → 새로 보인 첫 종목으로 포커스 (키보드·화면 읽기가 자리를 잃지 않게)
  useEffect(() => {
    if (expanded) firstNew.current?.focus();
  }, [expanded]);

  const toggle = (symbol: string) =>
    setOpened((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });

  // 종목들의 기준 시각이 모두 같으면 머리에 한 번만 (종목마다 같은 줄을 되풀이하지 않게)
  const asOfs = new Set(shown.map((m) => m.asOf));
  const sharedAsOf = asOfs.size === 1 ? shown[0].asOf : null;
  // 기록일이 오늘(한국 시간)이 아니면 '오늘의'와 지난 날짜가 함께 보여 자료가 멈춘 줄 안다 — 지난 거래일이라고 밝힌다
  const past = day !== null && day !== kstDay();

  return (
    <section
      ref={section}
      id={id}
      aria-labelledby={titleId}
      className={cn(
        "scroll-mt-20 rounded-2xl bg-card p-5 transition-shadow duration-slow ease-standard lg:scroll-mt-8",
        lit && "ring-2 ring-brand",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={titleId} ref={heading} tabIndex={-1} className="min-w-0 text-[17px] font-bold outline-none">
          오늘의 내 종목 뉴스
          {day && (
            // 날짜는 한 덩어리로 (좁으면 제목 아래 줄로 내려가고, '국내 종목만'은 오른쪽 위에 남는다). 앞 띄어쓰기는 줄이 바뀌면 사라진다
            <>
              {" "}
              <span className="inline-block text-[14px] font-semibold whitespace-nowrap text-mute">
                {past && "지난 거래일 · "}
                {formatDayLabel(day)}
              </span>
            </>
          )}
        </h2>
        <span className="mt-0.5 inline-flex h-6 shrink-0 items-center rounded-md bg-fill px-2 text-[12px] font-bold text-sub">{DAILY_MOVE_KR_ONLY}</span>
      </div>
      {sharedAsOf && <AsOf at={sharedAsOf} className="mt-0.5 block" />}

      {q.isPending ? (
        <div role="group" className="mt-3 space-y-2" aria-busy="true" aria-label="불러오는 중">
          <Skeleton className="h-4 w-1/3" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : !q.data ? (
        <SectionError bare className="mt-3" onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : all.length === 0 ? (
        homeEmpty ? (
          // 홈: 국내 보유는 있는데 아직 기록 전(또는 미국 종목만) — 큰 여백 없이 한 줄
          <p className={cn("mt-2 text-[14px] leading-snug text-sub", reveal && "reveal-fade")}>
            {holdings === "us-only"
              ? "오늘의 내 종목 뉴스는 국내 종목만 만들어요."
              : holdings === "none"
                ? "지금은 가진 국내 종목이 없어요. 국내 종목을 사면 장 마감 뒤(16:30 이후)에 그 종목의 기록이 만들어져요."
                : "오늘 기록은 국내 장 마감 뒤(16:30 이후)에 만들어져요."}
          </p>
        ) : (
          <p className="py-6 text-center text-[14px] leading-relaxed text-sub">
            보유 중인 국내 종목의 기록이 아직 없어요.
            <br />
            국내 거래일 장 마감 뒤(16:30 이후)에 만들어져요.
          </p>
        )
      ) : (
        <ul className={cn("mt-2 divide-y divide-line", reveal && "reveal-fade")}>
          {shown.map((m, i) => (
            <li key={m.symbol} className={cn(summary ? "py-1" : "py-3", fresh.has(m.symbol) && "is-new")}>
              <article
                ref={expanded && i === limit ? firstNew : undefined}
                tabIndex={fresh.has(m.symbol) ? -1 : undefined}
                aria-label={`${m.name} 오늘의 뉴스`}
                className="scroll-mt-20 rounded-lg"
              >
                {summary ? (
                  <SummaryMove m={m} open={opened.has(m.symbol)} onToggle={() => toggle(m.symbol)} showAsOf={!sharedAsOf} />
                ) : (
                  <>
                    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                      <p className="text-[16px] font-bold">
                        {m.name} <span className="text-[13px] font-normal text-mute">{m.symbol}</span>
                      </p>
                      <p className="text-[14px] tabular-nums">
                        종가 {formatKrw(m.close)}
                        {/* 쉬운 보기는 등락률을 '내 종목' 칸이 보인다 — 머리 줄에서 겹치지 않게 */}
                        {expert && (
                          <>
                            {" "}
                            <RateText rate={m.changeRate} className="text-[13px]" />
                          </>
                        )}
                      </p>
                    </div>
                    {!sharedAsOf && <AsOf at={m.asOf} />}
                    {expert ? <ExpertMove m={m} foldEvidence={false} /> : <EasyMove m={m} />}
                  </>
                )}
              </article>
            </li>
          ))}
        </ul>
      )}
      {shown.length < all.length && (
        // 알림(오늘의 내 종목 뉴스)은 홈으로 온다 — 나머지 종목도 여기서 펼쳐 볼 수 있게
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="press mt-1 h-11 w-full rounded-xl bg-fill text-[14px] font-semibold text-sub hover:bg-line"
        >
          외 {all.length - shown.length}종목 더 보기
        </button>
      )}
      {/* 고정 문구는 내용(등락 설명)을 보일 때의 약속 — 홈에서 기록이 없으면 함께 뺀다 (미국 종목만이면 설명할 내용이 없다) */}
      {!(homeEmpty && holdings === "us-only" && all.length === 0) && (
        <p className="mt-3 border-t border-line pt-3 text-[12px] leading-snug text-mute">{DAILY_MOVE_CAPTION}</p>
      )}
    </section>
  );
}

/** 홈: 계좌의 보유로 빈 상태를 정한다. 계좌를 받기 전에는 보통 카드(스켈레톤)를, 보유가 없으면 접혀 사라진다. */
function HomeDailyMove(props: DailyMoveCardProps) {
  const acc = useAccount();
  const positions = acc.data?.positions;
  const holdings: Holdings = !positions
    ? "unknown"
    : positions.length === 0
      ? "none"
      : positions.some((p) => p.market === "KR")
        ? "kr"
        : "us-only";
  // 보유가 없으면 접는다. 단, 알림에서 왔으면(focusKey) 펼쳐 둔다 — 그날 기록이나 '가진 국내 종목이 없어요'라도 보여야 눌러도 아무 일이 없어 보이지 않는다.
  // 접힌 뒤 사라지는 순간 아래가 한 번 더 튀지 않게: 카드 위 간격은 접히는 안쪽(pt-6)에 두고, 늘 남는 감싸개의 -mt-6이 앞 섹션의 여백
  // (홈 열의 space-y-6 = 24px)을 상쇄한다. 감싸개가 늘 있으니 앞 섹션이 마지막 자식이 되어 여백을 잃는 일(쉬운 보기)이 없고,
  // flow-root라 비어도 위아래 여백이 서로 겹쳐 사라지지 않는다(전문가 보기 — 아래 섹션과의 24px 유지). 홈 열 간격과 같은 값이다
  return (
    <div className="-mt-6 flow-root">
      <Collapse open={holdings !== "none" || Boolean(props.focusKey)}>
        <div className="pt-6">
          <MoveCard {...props} holdings={holdings} />
        </div>
      </Collapse>
    </div>
  );
}

export function DailyMoveCard(props: DailyMoveCardProps) {
  return props.emptyMode === "compact" ? <HomeDailyMove {...props} /> : <MoveCard {...props} holdings="unknown" />;
}
