// 종목 상세의 펀더멘털 패널 (docs/API.md "장기투자" FundamentalsView). 종목 상세(F-trade)가 쓴다.
//
// - 스스로 받는다: useFundamentals(symbol).
// - 쉬운 보기: 신호등(종합 — 중립 표기 "기준 충족"·"주의"·"확인 필요"·"적용하지 않음") + 한 줄 + 축(성장·수익성·재무 안정)별 한 줄.
// - 전문가 보기: 9개 지표 표(값·기준선·변화·✓△✗·note). 지표 이름은 <Term>으로 풀이.
// - 늘 보이는 것: caption("공시 숫자를 정해진 기준으로 본 것이며 투자 권유가 아닙니다"), 출처(source), 보고서 기간·접수일(asOf),
//   applicable이 false면 reason 한 줄, 내 산 이유(thesis)가 있으면 그 점검(lastCheck)과 "산 이유 고치기"(ThesisForm).
import { useId, useState } from "react";
import { errorMessage } from "../../api/client";
import { useFundamentals } from "../../api/longterm";
import type { FundamentalsOverall, FundamentalsRow, Thesis, ThesisAxis } from "../../api/types";
import type { ViewMode } from "../../hooks/useBeginnerMode";
import { cn } from "../../lib/cn";
import { formatDate, formatDateTime } from "../../lib/format";
import { CHECK_STATUS_TEXT, FUNDAMENTALS_CAPTION, FUNDAMENTALS_OVERALL_TEXT, THESIS_AXIS_TEXT } from "../../lib/plainText";
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

const LIGHTS: { key: Exclude<FundamentalsOverall, "na">; on: string }[] = [
  { key: "solid", on: "bg-ok" },
  { key: "caution", on: "bg-warn" },
  { key: "review", on: "bg-up" },
];

const STATUS_CLS: Record<FundamentalsRow["status"], string> = {
  ok: "text-ok",
  warn: "text-[#9a5b00]",
  bad: "text-up",
  na: "text-mute",
};

/** 신호등 + 종합 이름 (중립 표기). */
function TrafficLight({ overall }: { overall: FundamentalsOverall }) {
  return (
    <div className="flex items-center gap-3">
      <div aria-hidden="true" className="flex gap-1.5 rounded-full bg-ink px-2 py-1.5">
        {LIGHTS.map((l) => (
          <span key={l.key} className={cn("size-4 rounded-full", overall === l.key ? l.on : "bg-white/20")} />
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

/** 지표 표 (전문가 보기). 기준선이 있는 행이 하나라도 있으면 기준선·변화 열을 보인다. */
function RowsTable({ rows, caption }: { rows: FundamentalsRow[]; caption: string }) {
  const showBase = rows.some((r) => r.baseline !== null);
  const th = "px-2 py-1.5 text-left font-semibold text-mute";
  const td = "px-2 py-2 align-top tabular-nums";
  return (
    <div className="-mx-2 overflow-x-auto">
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
          {rows.map((r) => {
            const term = FUNDAMENTAL_TERM[r.key];
            return (
              <tr key={r.key} className="border-b border-line/60">
                <th scope="row" className={cn(td, "whitespace-nowrap text-left font-medium text-ink")}>
                  {term ? (
                    <Term k={term} className="text-left">
                      {r.label}
                    </Term>
                  ) : (
                    r.label
                  )}
                </th>
                <td className={cn(td, "text-right")}>{formatFundamentalValue(r, r.value)}</td>
                {showBase && (
                  <>
                    <td className={cn(td, "text-right text-sub")}>{formatFundamentalValue(r, r.baseline)}</td>
                    <td className={cn(td, "text-right text-sub")}>{formatFundamentalChange(r)}</td>
                  </>
                )}
                <td className={td}>
                  <StatusCell status={r.status} />
                </td>
                <td className={cn(td, "text-sub")}>{r.note ?? ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

/** 내 산 이유와 최근 점검 (+ 고치기). */
function ThesisSection({ thesis, view }: { thesis: Thesis; view: ViewMode }) {
  const [editing, setEditing] = useState(false);
  const check = thesis.lastCheck;
  const labelOf = (key: string) => check?.rows.find((r) => r.key === key)?.label ?? key;
  return (
    <div aria-label="내 산 이유" role="group" className="mt-4 border-t border-line pt-4">
      {editing ? (
        <ThesisForm
          symbol={thesis.symbol}
          name={thesis.name}
          initial={{ reasons: thesis.reasons, axes: thesis.axes }}
          onSaved={() => setEditing(false)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-bold">내 산 이유</h3>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="h-9 rounded-lg bg-fill px-3 text-[13px] font-semibold text-sub hover:bg-line"
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
            점검 축: {thesis.axes.length ? thesis.axes.map((a) => THESIS_AXIS_TEXT[a]).join(" · ") : "성장 · 수익성 · 재무 안정 (전부)"}
            {thesis.baselinePeriod && ` · 기준선 ${thesis.baselinePeriod}`}
          </p>
          {!thesis.active && <p className="mt-1 text-[13px] text-mute">지금 장기 보유 중이 아니라 점검을 멈췄어요.</p>}

          {check ? (
            <div className="mt-3 rounded-xl bg-fill p-3.5">
              <p className="text-[14px]">
                최근 점검: <b>{FUNDAMENTALS_OVERALL_TEXT[check.overall]}</b>
                {check.previousOverall && <span className="text-mute"> (직전 {FUNDAMENTALS_OVERALL_TEXT[check.previousOverall]})</span>}
              </p>
              <p className="mt-0.5 text-[12px] text-mute">
                {formatDateTime(check.checkedAt)} · {check.trigger === "weekly" ? "주간 점검" : "정기공시 점검"}
                {check.period && ` · ${check.period}`}
                {check.receivedAt && ` (접수 ${formatDate(check.receivedAt)})`}
              </p>
              {check.newBad.length > 0 && (
                <p className="mt-1.5 text-[13px] text-sub">
                  이번에 '확인 필요'가 된 지표: {check.newBad.map(labelOf).join(", ")}
                </p>
              )}
              {view === "expert" ? (
                <div className="mt-2">
                  <RowsTable rows={orderRows(check.rows, thesis.axes)} caption="산 이유 점검 지표 (기준선 비교)" />
                </div>
              ) : (
                <AxisLines rows={check.rows} first={thesis.axes} />
              )}
              <p className="mt-2 text-[12px] text-mute">{check.caption || FUNDAMENTALS_CAPTION}</p>
            </div>
          ) : (
            <p className="mt-2 text-[13px] text-mute">아직 점검 전이에요. 정기공시가 나오거나 월요일에 점검해요.</p>
          )}
        </>
      )}
    </div>
  );
}

export function FundamentalsPanel({ symbol, view, className }: FundamentalsPanelProps) {
  const q = useFundamentals(symbol);
  const titleId = useId();
  const f = q.data;

  return (
    <section aria-labelledby={titleId} className={cn("rounded-2xl bg-card p-5", className)}>
      <h2 id={titleId} className="text-[17px] font-bold">
        펀더멘털 점검
      </h2>

      {q.isPending ? (
        <div className="mt-3 space-y-2" aria-busy="true" aria-label="불러오는 중">
          <Skeleton className="h-6 w-1/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : q.isError || !f ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
      ) : (
        <>
          <div className="mt-2">
            {!f.applicable ? (
              <>
                <p aria-label={`종합 판정: ${FUNDAMENTALS_OVERALL_TEXT.na}`} className="text-[18px] font-bold text-sub">
                  {FUNDAMENTALS_OVERALL_TEXT.na}
                </p>
                <p className="mt-1 text-[14px] text-sub">{f.reason ?? "이 종목에는 일반 기업용 점검을 적용하지 않아요."}</p>
              </>
            ) : view === "easy" ? (
              <>
                <TrafficLight overall={f.overall} />
                <p className="mt-2 text-[14px] text-ink">{f.overall === "na" && f.reason ? f.reason : OVERALL_LINE[f.overall]}</p>
                <AxisLines rows={f.rows} first={f.thesis?.axes} />
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
        </>
      )}
    </section>
  );
}
