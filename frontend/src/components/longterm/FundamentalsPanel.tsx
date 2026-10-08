// 종목 상세의 펀더멘털 패널 (docs/API.md "장기투자" FundamentalsView). 종목 상세(F-trade)가 쓴다.
//
// - 스스로 받는다: useFundamentals(symbol).
// - 쉬운 보기: 신호등(종합 — 중립 표기 "기준 충족"·"주의"·"확인 필요") + 한 줄 + '확인 필요·주의' 지표 이름(용어 풀이) + 축별 한 줄.
//   그 아래 접힌 '지표 자세히'를 펼치면 전문가 보기와 같은 표를 그 자리에서 본다.
// - 전문가 보기: 9개 지표 표(값·기준선·변화·✓△✗·note). 지표 이름은 <Term>으로 풀이. 좁은 화면에서는 판정 기호를 지표 이름 옆에도 보이고,
//   옆으로 밀 수 있으면 오른쪽 끝을 흐리게 해 단서를 준다 (표 구조·열 순서는 그대로 — 화면 읽기·테스트 계약).
// - 늘 보이는 것: caption("공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"), 출처(source), 보고서 기간·접수일(asOf),
//   내 산 이유(thesis)가 있으면 그 점검(lastCheck)과 "산 이유 고치기"(ThesisForm). 쉬운 보기는 "정기공시"·"점검 축"·"기준선"을 쉬운 말로.
// - 적용하지 않는 종목(미국·ETF·금융업·리츠)은 제목 옆 회색 표시 + 이유 한 줄로 작게 (정보가 없는 카드가 같은 무게를 차지하지 않게).
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { errorMessage } from "../../api/client";
import { useFundamentals } from "../../api/longterm";
import type { FundamentalsOverall, FundamentalsRow, Thesis, ThesisAxis } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { useChanged, useRevealAfterLoading } from "../../hooks/useMotionState";
import { cn } from "../../lib/cn";
import { formatDate, formatDateTime } from "../../lib/format";
import { CHECK_STATUS_TEXT, FUNDAMENTALS_CAPTION, FUNDAMENTALS_OVERALL_TEXT, THESIS_AXIS_TEXT } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { Term } from "../Term";
import { ErrorState, Skeleton } from "../ui";
import { FUNDAMENTAL_TERM, OVERALL_LINE, THESIS_AXES, axisLine, formatFundamentalChange, formatFundamentalValue, orderRows } from "./longtermText";
import { ThesisForm } from "./ThesisForm";

export interface FundamentalsPanelProps {
  symbol: string;
  /** 쉬운 보기(신호등) · 전문가 보기(지표 표). */
  view: ViewMode;
  className?: string;
}

// 한국 가로 신호등 순서 (왼쪽부터 빨강·노랑·초록) — 익숙한 배열이어야 한눈에 읽힌다
const LIGHTS: { key: Exclude<FundamentalsOverall, "na">; on: string }[] = [
  { key: "review", on: "bg-up" },
  { key: "caution", on: "bg-warn" },
  { key: "solid", on: "bg-ok" },
];

// 판정은 글자라 글자용 토큰 (bad: 빨강 text-up은 흰 바탕에서 3.7:1로 작은 글자 AA 미달 — 경고 글자 warn-ink와 같은 이유로 up-ink)
const STATUS_CLS: Record<FundamentalsRow["status"], string> = {
  ok: "text-ok-ink",
  warn: "text-warn-ink",
  bad: "text-up-ink",
  na: "text-mute",
};

/** 신호등 + 종합 이름 (중립 표기). 신호등은 물건이라 테마와 상관없이 몸체가 어둡다 (다크에서도 밝게 뒤집지 않는다). */
function TrafficLight({ overall }: { overall: FundamentalsOverall }) {
  return (
    <div className="flex items-center gap-3">
      <div aria-hidden="true" className="flex gap-1.5 rounded-full bg-ink px-2 py-1.5 dark:bg-bg dark:ring-1 dark:ring-line">
        {LIGHTS.map((l) => (
          <span key={l.key} className={cn("size-4 rounded-full", overall === l.key ? l.on : "bg-mute-weak/40")} />
        ))}
      </div>
      <p aria-label={`종합 판정: ${FUNDAMENTALS_OVERALL_TEXT[overall]}`} className="text-[18px] font-bold">
        {FUNDAMENTALS_OVERALL_TEXT[overall]}
      </p>
    </div>
  );
}

function StatusCell({ status }: { status: FundamentalsRow["status"] }) {
  const s = CHECK_STATUS_TEXT[status];
  return (
    <span className={cn("whitespace-nowrap font-semibold", STATUS_CLS[status])}>
      <span aria-hidden="true">{s.mark}</span> {s.label}
    </span>
  );
}

/** 지표 이름 (풀이가 있으면 Term — 표 행 높이만큼 눌러도 열리게 누름 영역을 넓힌다). */
function RowLabel({ row, wide = false }: { row: FundamentalsRow; wide?: boolean }) {
  const term = FUNDAMENTAL_TERM[row.key];
  if (!term) return <>{row.label}</>;
  return (
    <Term k={term} className={cn("text-left", wide && "relative before:absolute before:-inset-x-1 before:-inset-y-2")}>
      {row.label}
    </Term>
  );
}

/**
 * 가로로 밀리는 표 상자. 오른쪽에 더 볼 내용이 있으면 끝을 흐리게 하고, 처음에는 '밀어 보기 →'를 보인다(한 번 밀면 사라진다).
 * 측정은 ResizeObserver가 처음 알려 줄 때부터 (테스트 jsdom에는 없어 아무것도 그리지 않는다).
 */
function ScrollTable({ children, surface }: { children: ReactNode; surface: "card" | "fill" }) {
  const box = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ more: false, moved: false });
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver !== "function") return;
    const measure = (moved: boolean) =>
      setEdge((s) => {
        const more = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
        const next = { more, moved: s.moved || moved };
        return next.more === s.more && next.moved === s.moved ? s : next;
      });
    const ro = new ResizeObserver(() => measure(false));
    ro.observe(el);
    const onScroll = () => measure(true);
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  }, []);
  return (
    <div className="relative -mx-2">
      <div ref={box} className="overflow-x-auto px-2">
        {children}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 right-0 flex w-12 items-start justify-end bg-linear-to-l to-transparent transition-opacity duration-fast",
          surface === "card" ? "from-card" : "from-fill",
          edge.more ? "opacity-100" : "opacity-0",
        )}
      >
        <span
          className={cn(
            "mt-1.5 mr-1 rounded-full bg-ink px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap text-on-ink transition-opacity duration-fast",
            edge.moved && "opacity-0",
          )}
        >
          밀어 보기 →
        </span>
      </div>
    </div>
  );
}

/** 지표 표 (전문가 보기·쉬운 보기의 '지표 자세히'). 기준선이 있는 행이 하나라도 있으면 기준선·변화 열을 보인다. */
function RowsTable({ rows, caption, surface = "card" }: { rows: FundamentalsRow[]; caption: string; surface?: "card" | "fill" }) {
  const showBase = rows.some((r) => r.baseline !== null);
  const th = "px-2 py-1.5 text-left font-semibold text-mute";
  const td = "px-2 py-2 align-top tabular-nums";
  return (
    <ScrollTable surface={surface}>
      <table className="w-full min-w-[520px] border-collapse text-[13px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className={th}>
              지표
            </th>
            <th scope="col" className={cn(th, "text-right")}>
              값
            </th>
            {showBase && (
              <>
                <th scope="col" className={cn(th, "text-right")}>
                  기준선
                </th>
                <th scope="col" className={cn(th, "text-right")}>
                  변화
                </th>
              </>
            )}
            <th scope="col" className={th}>
              판정
            </th>
            <th scope="col" className={th}>
              메모
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className="border-b border-line/60">
              <th scope="row" className={cn(td, "whitespace-nowrap text-left font-medium text-ink")}>
                {/* 좁은 화면에서는 판정 열이 오른쪽 밖에 있으므로 지표 이름 옆에도 기호를 보인다 (판정 열은 그대로 — 읽기는 한 번) */}
                <span aria-hidden="true" className={cn("mr-1 inline-block w-3 sm:hidden", STATUS_CLS[r.status])}>
                  {CHECK_STATUS_TEXT[r.status].mark}
                </span>
                <RowLabel row={r} wide />
              </th>
              {/* 숫자는 한 줄로 ("7,154억 원"이 좁은 화면에서 '원'만 다음 줄로 넘어가지 않게) */}
              <td className={cn(td, "whitespace-nowrap text-right")}>{formatFundamentalValue(r, r.value)}</td>
              {showBase && (
                <>
                  <td className={cn(td, "whitespace-nowrap text-right text-sub")}>{formatFundamentalValue(r, r.baseline)}</td>
                  <td className={cn(td, "whitespace-nowrap text-right text-sub")}>{formatFundamentalChange(r)}</td>
                </>
              )}
              <td className={td}>
                <StatusCell status={r.status} />
              </td>
              <td className={cn(td, "min-w-[10rem] text-sub")}>{r.note ?? ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollTable>
  );
}

function AxisLines({ rows, first }: { rows: FundamentalsRow[]; first?: readonly ThesisAxis[] }) {
  const order = first?.length ? [...first, ...THESIS_AXES.filter((a) => !first.includes(a))] : THESIS_AXES;
  return (
    <ul aria-label="축별 판정" className="mt-2 space-y-1 text-[14px] text-sub">
      {order.map((a) => (
        <li key={a}>{axisLine(rows, a)}</li>
      ))}
    </ul>
  );
}

/** 쉬운 보기: '확인 필요'·'주의' 지표 이름 (무엇을 확인해야 하는지 행동으로 이어지게). 용어 풀이가 있으면 눌러서 본다. */
function FlaggedLines({ rows }: { rows: FundamentalsRow[] }) {
  const groups = (["bad", "warn"] as const).map((s) => [s, rows.filter((r) => r.status === s)] as const).filter(([, list]) => list.length > 0);
  if (groups.length === 0) return null;
  return (
    <div className="mt-2 space-y-1 text-[14px] leading-relaxed">
      {groups.map(([s, list]) => (
        <p key={s}>
          <span className={cn("font-semibold", STATUS_CLS[s])}>
            <span aria-hidden="true">{CHECK_STATUS_TEXT[s].mark} </span>
            {CHECK_STATUS_TEXT[s].label}
          </span>
          <span className="text-sub">: </span>
          {list.map((r, i) => (
            <Fragment key={r.key}>
              {i > 0 && <span className="text-sub">, </span>}
              <RowLabel row={r} />
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}

/** 쉬운 보기의 '지표 자세히' (접힘) — 펼치면 전문가 표를 그 자리에서. */
function MoreRows({ rows, caption }: { rows: FundamentalsRow[]; caption: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className="-ml-2 inline-flex h-11 items-center gap-1 rounded-lg px-2 text-[14px] font-semibold text-brand-ink transition-colors hover:bg-fill active:bg-line/60"
      >
        지표 자세히
        <Icon name="chevron-down" className={cn("size-4 transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id={id}>
        <div className="pt-1">
          <RowsTable rows={rows} caption={caption} />
        </div>
      </Collapse>
    </div>
  );
}

/** 내 산 이유와 최근 점검 (+ 고치기). 보기↔고치기는 바뀐 뒤에만 페이드하고, 포커스를 새 내용으로(닫으면 '고치기' 버튼으로) 옮긴다. */
function ThesisSection({ thesis, view }: { thesis: Thesis; view: ViewMode }) {
  const [editing, setEditing] = useState(false);
  const changed = useChanged(editing);
  const editButton = useRef<HTMLButtonElement>(null);
  const backToButton = useRef(false);
  const check = thesis.lastCheck;
  const labelOf = (key: string) => check?.rows.find((r) => r.key === key)?.label ?? key;
  const easy = view === "easy";
  const report = easy ? "실적 보고서(정기공시)" : "정기공시";

  const close = () => {
    backToButton.current = true;
    setEditing(false);
  };
  useEffect(() => {
    if (editing || !backToButton.current) return;
    backToButton.current = false;
    editButton.current?.focus({ preventScroll: true });
  }, [editing]);

  return (
    <div aria-label="내 산 이유" role="group" className="mt-4 border-t border-line pt-4">
      <div key={editing ? "edit" : "view"} className={changed ? "reveal-fade" : undefined}>
        {editing ? (
          <ThesisForm
            symbol={thesis.symbol}
            name={thesis.name}
            initial={{ reasons: thesis.reasons, axes: thesis.axes }}
            onSaved={close}
            onCancel={close}
            focusOnMount
            easy={easy}
          />
        ) : (
          <>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[15px] font-bold">내 산 이유</h3>
              <button
                ref={editButton}
                type="button"
                onClick={() => setEditing(true)}
                className="press -my-1 h-11 rounded-xl bg-fill px-3.5 text-[13px] font-semibold text-sub hover:bg-line"
              >
                산 이유 고치기
              </button>
            </div>
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[14px]">
              {thesis.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
            <p className="mt-1.5 text-[13px] text-mute">
              {easy ? "먼저 볼 것" : "점검 축"}: {thesis.axes.length ? thesis.axes.map((a) => THESIS_AXIS_TEXT[a]).join(" · ") : "성장 · 수익성 · 재무 안정 (전부)"}
              {thesis.baselinePeriod && (easy ? ` · ${thesis.baselinePeriod} 숫자와 비교해요` : ` · 기준선 ${thesis.baselinePeriod}`)}
            </p>
            {!thesis.active && <p className="mt-1 text-[13px] text-mute">지금 장기 보유 중이 아니라 점검을 멈췄어요.</p>}

            {check ? (
              <div className="mt-3 rounded-xl bg-fill p-3.5">
                <p className="text-[14px]">
                  최근 점검: <b>{FUNDAMENTALS_OVERALL_TEXT[check.overall]}</b>
                  {check.previousOverall && <span className="text-mute"> (직전 {FUNDAMENTALS_OVERALL_TEXT[check.previousOverall]})</span>}
                </p>
                <p className="mt-0.5 text-[12px] text-mute">
                  {formatDateTime(check.checkedAt)} · {check.trigger === "weekly" ? "주간 점검" : `${easy ? "실적 보고서" : "정기공시"} 점검`}
                  {check.period && ` · ${check.period}`}
                  {check.receivedAt && ` (접수 ${formatDate(check.receivedAt)})`}
                </p>
                {check.newBad.length > 0 && (
                  <p className="mt-1.5 text-[13px] text-sub">이번에 '확인 필요'가 된 지표: {check.newBad.map(labelOf).join(", ")}</p>
                )}
                {view === "expert" ? (
                  <div className="mt-2">
                    <RowsTable rows={orderRows(check.rows, thesis.axes)} caption="산 이유 점검 지표 (기준선 비교)" surface="fill" />
                  </div>
                ) : (
                  <AxisLines rows={check.rows} first={thesis.axes} />
                )}
                <p className="mt-2 text-[12px] text-mute">{check.caption || FUNDAMENTALS_CAPTION}</p>
              </div>
            ) : (
              <p className="mt-2 text-[13px] text-mute">아직 점검 전이에요. {report}가 나오거나 월요일에 점검해요.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function FundamentalsPanel({ symbol, view, className }: FundamentalsPanelProps) {
  const q = useFundamentals(symbol);
  const titleId = useId();
  const f = q.data;
  const reveal = useRevealAfterLoading(q.isPending);
  const na = f !== undefined && !f.applicable;

  return (
    <section aria-labelledby={titleId} className={cn("rounded-2xl bg-card p-5", className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 id={titleId} className="text-[17px] font-bold">
          펀더멘털 점검
        </h2>
        {na && (
          <span aria-label={`종합 판정: ${FUNDAMENTALS_OVERALL_TEXT.na}`} className="rounded-md bg-fill px-2 py-1 text-[12px] font-semibold text-sub">
            {FUNDAMENTALS_OVERALL_TEXT.na}
          </span>
        )}
      </div>

      {q.isPending ? (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="불러오는 중">
          <Skeleton className="h-7 w-1/2" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : q.isError || !f ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} retrying={q.isFetching} compact />
      ) : na ? (
        <div className={reveal ? "reveal-fade" : undefined}>
          <p className="mt-1 text-[14px] text-sub">{f.reason ?? "이 종목에는 일반 기업용 점검을 적용하지 않아요."}</p>
          <p className="mt-2 text-[12px] text-mute">{f.caption || FUNDAMENTALS_CAPTION}</p>
          {f.thesis && <ThesisSection thesis={f.thesis} view={view} />}
        </div>
      ) : (
        <div className={reveal ? "reveal-fade" : undefined}>
          <div className="mt-2">
            {view === "easy" ? (
              <>
                <TrafficLight overall={f.overall} />
                <p className="mt-2 text-[14px] text-ink">{f.overall === "na" && f.reason ? f.reason : OVERALL_LINE[f.overall]}</p>
                <FlaggedLines rows={f.rows} />
                <AxisLines rows={f.rows} first={f.thesis?.axes} />
                <MoreRows rows={orderRows(f.rows, f.thesis?.axes)} caption={`${f.name} 펀더멘털 지표`} />
              </>
            ) : (
              <>
                <p className="flex items-center gap-2 text-[14px]">
                  종합{" "}
                  <b aria-label={`종합 판정: ${FUNDAMENTALS_OVERALL_TEXT[f.overall]}`} className="text-[16px]">
                    {FUNDAMENTALS_OVERALL_TEXT[f.overall]}
                  </b>
                </p>
                {f.reason && <p className="mt-1 text-[13px] text-sub">{f.reason}</p>}
                <div className="mt-2">
                  <RowsTable rows={orderRows(f.rows, f.thesis?.axes)} caption={`${f.name} 펀더멘털 지표`} />
                </div>
                <p className="mt-1 text-[12px] text-mute">기준선 비교는 산 이유를 저장한 종목의 점검에서 해요.</p>
              </>
            )}
          </div>

          <p className="mt-3 text-[12px] text-mute">
            출처: {f.source}
            {f.asOf?.period && ` · ${f.asOf.period}`}
            {f.asOf?.receivedAt && ` (접수 ${formatDate(f.asOf.receivedAt)})`}
          </p>
          <p className="mt-1 text-[12px] font-medium text-sub">{f.caption || FUNDAMENTALS_CAPTION}</p>

          {f.thesis && <ThesisSection thesis={f.thesis} view={view} />}
        </div>
      )}
    </section>
  );
}
