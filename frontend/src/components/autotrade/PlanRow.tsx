// 계획 한 줄: 종목·상태(진행 중이면 그 아래 4칸 단계 막대)·수량·진입/체결·목표/손절·손익·출처. 누르면 /plans/:id.
// easy면 쉬운 보기 문구 (사는 가격·목표 가격·손절 가격, 상태는 "사는 가격을 기다리는 중" 등).
// 진행 중 행은 '지금 어느 단계인지'를 들어가지 않고 본다 (문서 4-2 "진행 중 모의 자동매매(단계 표시)", trade-13). 막대는 움직이지 않는다.
// 시연용 수동 시작 계획(DECISIONS 31장)은 출처 배지 옆에 "시연용 수동 시작" 배지, 화면 읽기 설명에도 같은 말.
// table(PC 목록 — /plans·모의투자 탭의 진행 중): lg 이상에서 열을 맞춘 표 한 줄 [종목·출처 | 수량 | 진입·체결 | 목표·손절 | 상태·손익] + 머리(PlanTableHead).
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
export function PlanRow({ p, easy = false, compact = false, table = false }: { p: TradePlan; easy?: boolean; compact?: boolean; table?: boolean }) {
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
  // table: PC(lg)에서 목록 머리(PLAN_TABLE_HEAD)와 열을 맞춘 표 한 줄. 래퍼는 lg:contents로 풀어 칸마다 격자 자리를 준다 —
  // DOM과 모바일 모습은 그대로다 (DESIGN 부록 B0-7). 홈 요약처럼 좁은 자리는 table 없이 쓴다
  const t = (cls: string) => (table ? cls : undefined);
  return (
    <Link
      to={`/plans/${p.id}`}
      aria-label={`${p.name} 계획 보기`}
      aria-describedby={descId}
      className={cn("press-row flex items-center gap-3 px-5 py-4 hover:bg-fill/50", table && PLAN_TABLE_ROW, ROW_FOCUS)}
    >
      <div className={cn("min-w-0 flex-1", t("lg:contents"))}>
        {/* 쉬운 보기의 긴 상태 칩('목표·손절을 지켜보는 중')이 좁은 화면에서 왼쪽 숫자 줄을 세 줄로 짜부라뜨리지 않게,
            글자 칸이 10rem보다 좁아지면 칩·단계 막대가 아래 줄로 내려간다 (전문가 보기의 짧은 칩은 그대로 오른쪽) */}
        <div className={cn("flex flex-wrap items-start justify-between gap-x-3 gap-y-2", t("lg:contents"))}>
          <div className={cn("min-w-40 flex-1", t("lg:contents"))}>
            <p className={cn("truncate text-[16px] font-semibold", t("lg:col-start-1 lg:row-start-1 lg:self-end"))}>{p.name}</p>
            {/* 이름과 값은 한 덩어리로, 가르는 점은 앞 덩어리 끝에 (좁은 화면에서 '사는 가격'과 금액이 다른 줄로, 점만 한 줄로 떨어지지 않게).
                표 줄(PC)에서는 수량 · 진입 · 체결이 각자 칸으로 가고 점은 숨긴다 */}
            <p className={cn("text-[13px] text-mute tabular-nums", t("lg:contents"))}>
              <span className={cn("whitespace-nowrap", t(`lg:col-start-2 ${CELL_SPAN} lg:text-right lg:text-[14px] lg:font-medium lg:text-ink`))}>
                {formatQty(p.quantity)}
                <span className={t("lg:hidden")}> ·</span>
              </span>{" "}
              <span className={cn("whitespace-nowrap", t("lg:col-start-3 lg:row-start-1 lg:self-end lg:text-right"))}>
                {/* 칸 이름은 PC 표에서 열 머리가 말한다 (화면 읽기용으로만 남긴다 — 보유 표와 같은 방식) */}
                <span className={t("lg:sr-only")}>{easy ? "사는 가격" : "진입"} </span>
                <span className={t("lg:font-medium lg:text-ink")}>{formatPrice(p.entryPrice, p.currency)}</span>
                {p.fillPrice != null && <span className={t("lg:hidden")}> ·</span>}
              </span>
              {p.fillPrice != null && (
                <>
                  {" "}
                  <span className={cn("whitespace-nowrap", t("lg:col-start-3 lg:row-start-2 lg:self-start lg:text-right"))}>
                    <span className={t("lg:sr-only")}>{easy ? "산 가격" : "체결"} </span>
                    <span className={t("lg:font-medium lg:text-ink")}>{formatPrice(p.fillPrice, p.currency)}</span>
                  </span>
                </>
              )}
            </p>
          </div>
          <div className={cn("flex shrink-0 flex-col items-end gap-1.5", t("lg:contents"))}>
            <PlanStatusChip status={p.status} easy={easy} className={t("lg:col-start-5 lg:row-start-1 lg:self-end lg:justify-self-end")} />
            {live && (
              <span className={cn("flex", t("lg:col-start-5 lg:row-start-2 lg:self-start lg:justify-self-end lg:pt-1"))}>
                <MiniSteps p={p} />
              </span>
            )}
          </div>
        </div>
        <div className={cn("mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]", t("lg:contents"))}>
          {/* 출처 · 시연용 배지는 PC 표 줄에서 이름 아래 한 칸 (모바일은 contents라 이 줄의 항목 그대로) */}
          <span className={cn("contents", t("lg:col-start-1 lg:row-start-2 lg:flex lg:min-w-0 lg:flex-wrap lg:items-center lg:gap-1.5 lg:self-start"))}>
            <SourceBadge source={p.source} />
            {p.manualStart && <ManualStartBadge />}
          </span>
          {/* 목표·손절은 한 덩어리로 (좁은 화면에서 '손절 가격'만 다음 줄로 떨어지지 않게). PC 표 줄에서는 두 줄로 */}
          <span className={cn("whitespace-nowrap tabular-nums", t(`lg:col-start-4 ${CELL_SPAN} lg:text-right`))}>
            {/* PC 표 줄은 짧은 이름 '목표'·'손절'만 보인다 (쉬운 보기의 '가격'은 화면 읽기용으로 남긴다) */}
            <span className={cn("text-up", t("lg:block"))}>
              목표{easy && <span className={t("lg:sr-only")}> 가격</span>} {formatPrice(p.targetPrice, p.currency)}
            </span>
            <span className={cn("text-mute-weak", t("lg:hidden"))}> · </span>
            <span className={cn("text-down", t("lg:block"))}>
              손절{easy && <span className={t("lg:sr-only")}> 가격</span>} {formatPrice(p.stopPrice, p.currency)}
            </span>
          </span>
          {/* 손익·날짜는 PC 표 줄에서 상태 칩 아래 (끝난 계획만 — 진행 중은 그 자리에 단계 막대) */}
          <span className={cn("contents", t("lg:col-start-5 lg:row-start-2 lg:flex lg:flex-col lg:items-end lg:self-start lg:pt-1"))}>
            {p.pnlKrw != null && <span className={cn("font-semibold tabular-nums", trendClass(p.pnlKrw))}>손익 {formatSignedKrw(p.pnlKrw)}</span>}
            {/* 날짜는 끝난 계획에만 (진행 중은 단계 막대가 '지금'을 말한다) */}
            {!live && <span className={cn("ml-auto text-mute tabular-nums", t("lg:ml-0 lg:text-[12px]"))}>{formatDateTime(p.activatedAt)}</span>}
          </span>
        </div>
      </div>
      <Icon name="chevron" className={cn("size-4 shrink-0 text-mute-weak", t("lg:col-start-6 lg:row-span-2 lg:row-start-1 lg:self-center"))} />
      <span id={descId} className="sr-only">
        {summary}
      </span>
    </Link>
  );
}

/** PC 표 줄의 열: 종목 · 수량 · 진입·체결 · 목표·손절 · 상태(손익) · 화살표. 머리(PLAN_TABLE_HEAD)와 같은 값을 쓴다. */
const PLAN_COLS =
  "lg:grid-cols-[minmax(0,1fr)_4rem_8rem_8rem_11rem_1rem] 2xl:grid-cols-[minmax(0,1fr)_5rem_9rem_9rem_12rem_1rem]";
const PLAN_TABLE_ROW = `lg:grid lg:min-h-16 lg:items-center lg:gap-x-3 lg:gap-y-0.5 lg:py-3 2xl:gap-x-5 ${PLAN_COLS}`;
/** 두 줄 높이 칸 (가운데). */
const CELL_SPAN = "lg:row-span-2 lg:row-start-1 lg:self-center";

/**
 * PC 표의 열 머리 (화면 읽기에는 숨긴다 — 각 줄의 링크 이름·설명이 같은 내용을 말한다). table 줄과 같은 목록 카드 위에 둔다.
 * PC에서만 그린다 (useIsPc) — 모바일 DOM에 없는 줄이라 같은 글자가 둘이 되지 않는다.
 */
export function PlanTableHead({ easy = false }: { easy?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "grid gap-x-3 border-b border-line px-5 py-2.5 text-[12px] font-medium text-mute 2xl:gap-x-5",
        PLAN_COLS, // PC에서만 그리므로 lg: 열이 늘 적용된다
      )}
    >
      <span>종목</span>
      <span className="text-right">수량</span>
      <span className="text-right">{easy ? "사는 가격 · 산 가격" : "진입 · 체결"}</span>
      <span className="text-right">{easy ? "목표 · 손절 가격" : "목표 · 손절"}</span>
      <span className="text-right">{easy ? "지금 단계 · 손익" : "상태 · 손익"}</span>
      <span />
    </div>
  );
}
