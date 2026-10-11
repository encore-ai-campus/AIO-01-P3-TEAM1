// 계획 한 줄: 종목·상태(진행 중이면 그 아래 4칸 단계 막대)·수량·진입/체결·목표/손절·손익·출처. 누르면 /plans/:id.
// easy면 쉬운 보기 문구 (사는 가격·목표 가격·손절 가격, 상태는 "사는 가격을 기다리는 중" 등).
// 진행 중 행은 '지금 어느 단계인지'를 들어가지 않고 본다 (문서 4-2 "진행 중 모의 자동매매(단계 표시)", trade-13). 막대는 움직이지 않는다.
// 시연용 수동 시작 계획(DECISIONS 31장)은 출처 배지 옆에 "시연용 수동 시작" 배지, 화면 읽기 설명에도 같은 말.
import { useId } from "react";
import { Link } from "react-router";
import type { TradePlan } from "../../api/types";
import { SOURCE, easySteps, planStatusOf } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatDateTime, formatPrice, formatQty, formatSignedKrw, trendClass } from "../../lib/format";
import { MANUAL_START_TEXT, planStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";
import { ManualStartBadge, PlanStatusChip, SourceBadge } from "./Badges";

const STEP_CELL = { done: "bg-brand", current: "bg-brand/40", stopped: "bg-up/40", todo: "bg-line", skipped: "bg-line" } as const;

// 키보드 포커스 테두리는 행 안쪽에 그린다: 이 행을 담는 목록 카드(ul)가 overflow-hidden rounded-2xl이라 바깥 테두리는 잘려
// 선 하나만 남거나 이웃 행의 테두리처럼 보인다 (a11y-5, 종목 검색 행과 같은 방식). 카드의 첫 행·마지막 행은 테두리 모서리를 카드와 맞춘다
const ROW_FOCUS = "focus-visible:outline-offset-[-2px] [li:first-child>&]:rounded-t-2xl [li:last-child>&]:rounded-b-2xl";

/** 4칸 단계 막대 (장식 — 상태는 칩 글자가 말한다). 사건 없이 상태만으로 계산한다. */
function MiniSteps({ p }: { p: TradePlan }) {
  return (
    <span aria-hidden="true" className="flex w-20 gap-1">
      {easySteps(p, []).map((s) => (
        <span key={s.key} className={cn("h-1.5 flex-1 rounded-full", STEP_CELL[s.state])} />
      ))}
    </span>
  );
}

/**
 * compact: 요약 자리(모의투자 탭의 '끝난 계획', PC 오른쪽 340px 열)용 두 줄 — [종목 · 상태] / [출처 · 손익 · 날짜].
 * 가격 줄은 계획 상세·/plans 목록에서 본다.
 */
export function PlanRow({ p, easy = false, compact = false }: { p: TradePlan; easy?: boolean; compact?: boolean }) {
  const live = p.status === "active" || p.status === "entry_pending" || p.status === "holding";
  const descId = useId();
  // 링크 이름은 "○○ 계획 보기"로 짧게 두고, 상태·출처·손익은 설명으로 잇는다 (화면 읽기에서 이름이 내용을 가리지 않게).
  // 보이는 글자 하나와 똑같은 문장이 되지 않게 출처를 늘 붙인다.
  const summary = [
    easy ? planStatusText(p.status, true) : planStatusOf(p.status).label,
    SOURCE[p.source]?.label ?? p.source,
    p.manualStart ? MANUAL_START_TEXT.badge : null,
    p.pnlKrw != null ? `손익 ${formatSignedKrw(p.pnlKrw)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  if (compact) {
    return (
      <Link
        to={`/plans/${p.id}`}
        aria-label={`${p.name} 계획 보기`}
        aria-describedby={descId}
        className={cn("press-row flex items-center gap-3 px-5 py-3.5 hover:bg-fill/50", ROW_FOCUS)}
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="min-w-0 truncate text-[16px] font-semibold">{p.name}</p>
            <PlanStatusChip status={p.status} easy={easy} />
          </div>
          {/* 요약이라 날짜는 뺀다 (최근 순서로 놓이고, 날짜는 /plans 목록·상세에서 본다). 좁으면 손익이 다음 줄로 (배지는 줄이지 않는다) */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
            <SourceBadge source={p.source} />
            {p.manualStart && <ManualStartBadge />}
            {p.pnlKrw != null && (
              <span className={cn("font-semibold whitespace-nowrap tabular-nums", trendClass(p.pnlKrw))}>손익 {formatSignedKrw(p.pnlKrw)}</span>
            )}
          </div>
        </div>
        <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
        <span id={descId} className="sr-only">
          {summary}
        </span>
      </Link>
    );
  }
  return (
    <Link
      to={`/plans/${p.id}`}
      aria-label={`${p.name} 계획 보기`}
      aria-describedby={descId}
      className={cn("press-row flex items-center gap-3 px-5 py-4 hover:bg-fill/50", ROW_FOCUS)}
    >
      <div className="min-w-0 flex-1">
        {/* 쉬운 보기의 긴 상태 칩('목표·손절을 지켜보는 중')이 좁은 화면에서 왼쪽 숫자 줄을 세 줄로 짜부라뜨리지 않게,
            글자 칸이 10rem보다 좁아지면 칩·단계 막대가 아래 줄로 내려간다 (전문가 보기의 짧은 칩은 그대로 오른쪽) */}
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
          <div className="min-w-40 flex-1">
            <p className="truncate text-[16px] font-semibold">{p.name}</p>
            {/* 이름과 값은 한 덩어리로, 가르는 점은 앞 덩어리 끝에 (좁은 화면에서 '사는 가격'과 금액이 다른 줄로, 점만 한 줄로 떨어지지 않게) */}
            <p className="text-[13px] text-mute tabular-nums">
              <span className="whitespace-nowrap">{formatQty(p.quantity)} ·</span>{" "}
              <span className="whitespace-nowrap">
                {easy ? "사는 가격" : "진입"} {formatPrice(p.entryPrice, p.currency)}
                {p.fillPrice != null && " ·"}
              </span>
              {p.fillPrice != null && (
                <>
                  {" "}
                  <span className="whitespace-nowrap">{`${easy ? "산 가격" : "체결"} ${formatPrice(p.fillPrice, p.currency)}`}</span>
                </>
              )}
            </p>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <PlanStatusChip status={p.status} easy={easy} />
            {live && <MiniSteps p={p} />}
          </div>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          <SourceBadge source={p.source} />
          {p.manualStart && <ManualStartBadge />}
          {/* 목표·손절은 한 덩어리로 (좁은 화면에서 '손절 가격'만 다음 줄로 떨어지지 않게) */}
          <span className="whitespace-nowrap tabular-nums">
            <span className="text-up">
              {easy ? "목표 가격" : "목표"} {formatPrice(p.targetPrice, p.currency)}
            </span>
            <span className="text-mute-weak"> · </span>
            <span className="text-down">
              {easy ? "손절 가격" : "손절"} {formatPrice(p.stopPrice, p.currency)}
            </span>
          </span>
          {p.pnlKrw != null && <span className={cn("font-semibold tabular-nums", trendClass(p.pnlKrw))}>손익 {formatSignedKrw(p.pnlKrw)}</span>}
          {/* 날짜는 끝난 계획에만 (진행 중은 단계 막대가 '지금'을 말한다) */}
          {!live && <span className="ml-auto text-mute tabular-nums">{formatDateTime(p.activatedAt)}</span>}
        </div>
      </div>
      <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
      <span id={descId} className="sr-only">
        {summary}
      </span>
    </Link>
  );
}
