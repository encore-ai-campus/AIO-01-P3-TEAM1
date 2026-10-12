// /recommendations/:id: 새 계획 제안(전문가 보기: AI 추천)의 실행 확인 (docs/plans/컨셉변경계획.md 4-2 "실행 확인", 6장 "내 확인").
// 넣을 돈은 사용자가 정한다 (2026-10-11 DECISIONS 28장): 내 자금(매수 가능 금액)의 % 또는 금액(원) — 필수, 기본값 없음(정하기 전에는 시작 버튼이 꺼진다).
//   요청에는 budgetPercent·budgetKrw 중 하나만 보낸다. 수량은 그 금액으로 계산하고, 리스크 엔진은 한도를 점검만 한다(넘으면 막는다, 줄이지 않는다).
// 쉬운 보기: 계획 요약 → 얼마를 넣을까요?(% 칩 10·25·50·100 + 직접 입력 | 금액) → 그 금액으로 사는 수량·금액·손절 시 손실(내 자산의 %)
//   → 손절 손실이 자산의 1%를 넘으면 경고 한 줄(막지 않음) → 장 시간 안내(opensAt) → 체크 셋(손절 시 손실 · 보유 기간 끝 매도 · AI 제안/모의)을
//   모두 켜야 "모의 자동매매 시작"(acknowledged: true). 금액을 정하기 전에는 미리 보기 대신 빈 상태와 버튼 아래 안내.
// 전문가 보기: 머리 → 가격 사다리 → 지표 → 결론·근거·리스크 → 활성화 카드(투자 금액 → 리스크 미리 보기 → 같은 체크 셋을 한 줄 요약 확인 → "계획 활성화").
// Discord 활성화 링크(?t=)로 들어오면 위에 띠를 보이고 활성화 요청에 token으로 넣는다 (via=discord).
// 배치: 여정 ② 검토 → ③ 실행 순서 그대로 (왼쪽에서 읽고 오른쪽에서 확인). PC 오른쪽 열은 화면보다 길면 아래 끝(시작 버튼)이 보이게 붙는다.
// 시작할 수 없으면(계좌와 무관한 사유 blockedBy 또는 금액 없는 안전장치 미리 보기 activatable=false) 머리 배지 아래에 이유 한 줄,
// 실행 확인은 투자 금액·체크리스트·시작 버튼 대신 이유와 '다른 계획 제안 보기'만 (UX-2). 금액 때문에 막힌 것(cash_short·total_limit·budget_too_small)은
// 금액을 고칠 수 있게 입력을 그대로 둔다.
// 지금 실시간 가격이 사는 가격 이하이고 정규장 중이면 "시작하면 바로 사요"라고 말한다 (UX-3 — 숫자는 넣지 않는다).
// ?manual=1 (시연용 수동 시작, DECISIONS 31장): 금액 없는 미리 보기가 손익비·기대값으로만 막았으면 그 이유를 보이고, 같은 넣을 돈·확인 넷·
//   경고색 시작 버튼으로 manualStart: true를 보낸다. 머리 칩·이유 한 줄·카드 제목은 그대로 둔다 (안전장치 판정을 숨기지 않는다).
//   Discord 링크(?t=)로 같이 왔으면 시연용 띠 대신 Discord 띠가 '시연용'과 실제 시작 버튼 이름을 말한다 (위쪽 이동 버튼은 하나).
import { type RefObject, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useActivate, useDeleteRecommendation } from "../api/autotrade";
import { ApiError, errorMessage } from "../api/client";
import { isPlanLive, useMarket, useQuotes, useRecommendation, useRiskPreview } from "../api/queries";
import type { BudgetMode, Quote, Recommendation, RiskPreview } from "../api/types";
import { PlanStatusChip, ReadinessChip, RecStatusChip, RiskLevelBadge, SourceBadge } from "../components/autotrade/Badges";
import { PriceLadder } from "../components/autotrade/PriceLadder";
import { DeleteAction } from "../components/DeleteAction";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { useToast } from "../components/toast";
import { AsOf, Card, ErrorState, Flash, Notice, PageHeader, Row, Segmented, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import {
  BUDGET_PERCENT_CHIPS,
  type BudgetChoice,
  SOURCE,
  STICKY_FIT_TOP,
  blockedCodes,
  budgetParams,
  buysRightAway,
  canStartManually,
  closedMarketNotice,
  deadlineMovedEarlier,
  entryDeadlineLabel,
  kstDayOf,
  manualStartPath,
  nextActionOf,
  onlyManualSkip,
  parseBudget,
  percentToKrw,
  stickyFit,
  timeLeft,
} from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDateTime, formatDayLabel, formatKrw, formatPercent, formatPrice, formatQty, formatRate, formatSignedKrw } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { MANUAL_START_TEXT, blockedShort, priceExpiredText, reasonSentence, rejectionSentences } from "../lib/plainText";
import { useDebounced } from "../hooks/useDebounced";

/** 지표 칸. 값은 줄을 바꾸지 않고(자릿수 중간에서 갈라지지 않게), 보조 줄은 넘치면 줄임표 + 전체는 title (trade-03). */
function Metric({ label, value, sub, className }: { label: string; value: string; sub?: string; className?: string }) {
  return (
    <div className="min-w-0 rounded-xl bg-fill p-3">
      <dt className="text-[12px] text-mute">{label}</dt>
      <dd className={cn("mt-0.5 text-[17px] font-bold whitespace-nowrap tabular-nums", className)}>{value}</dd>
      {sub && (
        <dd className="truncate text-[11px] text-mute" title={sub}>
          {sub}
        </dd>
      )}
    </div>
  );
}

function sourceLink(r: Recommendation, easy: boolean): { to: string; label: string } | null {
  if (r.source === "report" && r.sourceId != null) return { to: `/reports/${r.sourceId}`, label: easy ? "이 계획이 나온 AI 리포트 보기" : `AI 리포트 #${r.sourceId} 보기` };
  if (r.source === "analysis" && r.sourceId != null) {
    return { to: `/analyses/${r.sourceId}`, label: easy ? "AI 교차검증 분석 보기 (리포트 없음)" : `AI 분석 #${r.sourceId} 보기` };
  }
  return null;
}

/** 수량을 정한 것을 쉬운 말로 (RiskPreview.limitedBy — 2026-10-11부터 "내가 정한 금액" 하나, 모르는 값은 그대로). */
function limitedByText(limitedBy: string): string {
  return limitedBy === "내가 정한 금액" ? "내가 정한 금액으로 계산했어요" : limitedBy;
}

/** 손절 시 손실 ÷ 총자산 (maxLossRate)을 "0.9%"로. 0.0%로 보이면 한 자리 더. */
function lossRateText(rate: number): string {
  const t = formatPercent(rate, 1);
  return t === "0.0%" && rate > 0 ? formatPercent(rate, 2) : t;
}

/** 넣을 돈 때문에 막힌 사유 (금액을 고치면 풀린다 — 입력 블록을 그대로 둔다). */
const BUDGET_CODES = ["cash_short", "total_limit", "budget_too_small"];

/** 넣을 돈 입력 아래 도움말: 매수 가능 금액 중 얼마인지 (정하기 전에는 매수 가능 금액만). 매수 가능 금액을 모르면 null. */
function budgetHelp(mode: BudgetMode, value: number | null, buyingPowerKrw: number | null): string | null {
  if (buyingPowerKrw == null) return null;
  const head = `매수 가능 금액 ${formatKrw(buyingPowerKrw)}`;
  if (value == null) return head;
  if (mode === "percent") return `${head} 중 ${formatKrw(percentToKrw(buyingPowerKrw, value))}`;
  return `${head} 중 ${formatKrw(value)}${buyingPowerKrw > 0 ? ` (${formatPercent(value / buyingPowerKrw, 1)})` : ""}`;
}

/**
 * 넣을 돈 (2026-10-11 DECISIONS 28장): [내 자금의 % | 금액(원)] 전환(공용 Segmented) → % 칩 10·25·50·100 + 직접 입력(1~100 정수) 또는 원 입력.
 * 칩은 입력 칸을 채우는 지름길이라 칸의 값과 같은 칩이 눌린 상태다. 방식을 바꾸면 부모가 입력을 비운다 (다른 단위의 숫자가 남지 않게).
 */
function BudgetPicker({
  mode,
  raw,
  onMode,
  onRaw,
  value,
  error,
  buyingPowerKrw,
  easy,
}: {
  mode: BudgetMode;
  raw: string;
  onMode: (m: BudgetMode) => void;
  onRaw: (v: string) => void;
  value: number | null;
  error: string | null;
  buyingPowerKrw: number | null;
  easy: boolean;
}) {
  const help = budgetHelp(mode, value, buyingPowerKrw);
  const percent = mode === "percent";
  return (
    <fieldset className="mt-4">
      <legend className="text-[15px] font-semibold">{easy ? "얼마를 넣을까요?" : "투자 금액"}</legend>
      <Segmented
        label={easy ? "넣을 돈 정하는 방식" : "투자 금액 방식"}
        value={mode}
        onChange={(m) => onMode(m)}
        className="mt-2 w-full"
        options={[
          { value: "percent", label: "내 자금의 %" },
          { value: "amount", label: "금액(원)" },
        ]}
      />
      {percent && (
        <div role="group" aria-label="내 자금의 %" className="mt-2 grid grid-cols-4 gap-1.5">
          {BUDGET_PERCENT_CHIPS.map((p) => {
            const on = value === p;
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                onClick={() => onRaw(String(p))}
                className={cn(
                  "press h-11 rounded-lg text-[14px] font-semibold tabular-nums",
                  // 고대비(forced-colors)에서는 바탕색이 사라지므로 고른 칩을 시스템 선택색으로 (Segmented와 같다)
                  on
                    ? "bg-brand-soft text-brand-ink ring-1 ring-brand forced-colors:bg-[color:Highlight] forced-colors:text-[color:HighlightText] forced-colors:forced-color-adjust-none"
                    : "bg-fill text-sub hover:bg-line",
                )}
              >
                {p}%
              </button>
            );
          })}
        </div>
      )}
      <div className="relative mt-2">
        <input
          id="budget"
          inputMode="numeric"
          value={raw}
          onChange={(e) => onRaw(e.target.value)}
          aria-label={percent ? "직접 입력 (%)" : easy ? "넣을 금액 (원)" : "투자 금액 (원)"}
          placeholder={percent ? "직접 입력 (1~100)" : "예: 1,000,000"}
          aria-describedby="budget-help"
          aria-invalid={error ? true : undefined}
          className="h-12 w-full rounded-xl bg-fill pr-10 pl-3.5 text-[16px] tabular-nums outline-none focus:ring-2 focus:ring-brand"
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-[15px] text-mute">
          {percent ? "%" : "원"}
        </span>
      </div>
      <p id="budget-help" className={cn("mt-1 text-[13px] tabular-nums", error ? "text-up-ink" : "text-mute")}>
        {/* 매수 가능 금액은 머리 칩과 같은 금액 없는 미리 보기에서 온다 (보통 이미 받아 둠 — 못 받았으면 비워 둔다) */}
        {error ?? help}
      </p>
    </fieldset>
  );
}

/** 체크 셋 ③: AI 제안 / 연습용 예시(AI 아님). */
function thirdCheck(r: Recommendation): string {
  return r.source === "demo"
    ? "AI가 아닌 연습용 예시 계획이며, 실제 돈이 아닌 모의 투자예요."
    : "AI의 제안이며, 실제 돈이 아닌 모의 투자예요.";
}

/** 확인 한 줄. 줄 전체가 label이라 글자·여백 어디를 눌러도 켜진다 (한 줄짜리 확인도 높이 44px 이상 — trade-22). */
function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: string }) {
  return (
    <li>
      <label className="flex min-h-11 cursor-pointer items-start gap-2.5 py-2 in-disabled:cursor-not-allowed">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 size-5 shrink-0 accent-brand" />
        <span className="text-[14px] leading-snug">{children}</span>
      </label>
    </li>
  );
}

/**
 * 쉬운 보기의 체크 셋(시연용 수동 시작이면 넷 — DECISIONS 31장). 다 켜야 onReady(true). 금액이 바뀌면(수량·손실) 부모가 key로 새로 그려 체크를 지운다.
 * disabled: 안전장치가 막았으면 켤 수 없게 흐리게 둔다 (숨기지 않는다 — 무엇을 확인하게 되는지는 미리 읽을 수 있게).
 */
function Checklist({
  r,
  pv,
  manual,
  onReady,
  onTouch,
  disabled,
}: {
  r: Recommendation;
  pv: RiskPreview;
  /** 시연용 수동 시작: 넷째 확인 (손익비·기대 수익 점검을 건너뛴다는 것) */
  manual: boolean;
  onReady: (ok: boolean) => void;
  onTouch: () => void;
  disabled: boolean;
}) {
  // 칸 수는 항목 수로 정한다 (부모가 key에 manual을 넣어 바뀌면 새로 그린다)
  const items = [
    `손절 가격(${formatPrice(r.stopPrice, r.currency)})에 팔리면 약 ${formatKrw(pv.maxLossKrw)}을 잃어요. 가격이 갑자기 크게 떨어지면 더 잃을 수도 있어요.`,
    `산 뒤 최대 ${r.holdingDays}거래일 보유해요. 그때까지 목표·손절에 닿지 않으면 그날 가격에 팔아요 — 이익일 수도, 손실일 수도 있어요.`,
    thirdCheck(r),
    ...(manual ? [MANUAL_START_TEXT.check] : []),
  ];
  const [checks, setChecks] = useState(() => items.map(() => false));
  const set = (i: number) => (v: boolean) => {
    const next = checks.map((c, j) => (j === i ? v : c));
    setChecks(next);
    onReady(next.every(Boolean));
    if (v) onTouch();
  };
  return (
    <fieldset disabled={disabled} className={cn("rounded-xl border border-line px-3.5 pt-1.5 pb-2", disabled && "opacity-50")}>
      <legend className="px-1 text-[15px] font-semibold">시작하기 전에 확인해 주세요</legend>
      <ul>
        {items.map((text, i) => (
          <Check key={i} checked={checks[i]} onChange={set(i)}>
            {text}
          </Check>
        ))}
      </ul>
    </fieldset>
  );
}

/** 전문가 보기: 같은 체크 셋을 한 줄 요약 확인으로 (사용자 확인 묶음이라 테두리 상자 — trade-20). */
function SummaryCheck({
  r,
  pv,
  manual,
  checked,
  onChange,
  disabled,
}: {
  r: Recommendation;
  pv: RiskPreview;
  /** 시연용 수동 시작: 목록 끝에 건너뛰는 점검 한 줄 (DECISIONS 31장) */
  manual: boolean;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled: boolean;
}) {
  const id = useId();
  return (
    <fieldset disabled={disabled} className={cn("mt-3 rounded-xl border border-line p-3", disabled && "opacity-50")}>
      <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-sub">
        <li>손절 시 손실 -{formatKrw(pv.maxLossKrw)} (급락하면 더 클 수 있음)</li>
        <li>최대 {r.holdingDays}거래일 보유 후 그날 가격에 매도 (손익 무관)</li>
        <li>{r.source === "demo" ? "연습용 예시 계획(AI 아님)" : "AI의 제안"} · 모의 계좌</li>
        {manual && <li>{MANUAL_START_TEXT.expertCheck}</li>}
      </ul>
      <label htmlFor={id} className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 py-2 in-disabled:cursor-not-allowed">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-brand" />
        <span className="text-[14px] font-semibold">위 내용을 확인했습니다</span>
      </label>
    </fieldset>
  );
}

/** 링크 줄 (다음 행동). */
const NEXT_LINK = "press mt-2 flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line";
/** 시연용 수동 시작 링크 줄 (경고색 — NEXT_LINK와 바탕이 달라 따로 둔다. lib/cn은 클래스를 덮어쓰지 않고 잇기만 한다). */
const MANUAL_LINK = "press mt-2 flex h-11 items-center justify-between rounded-xl bg-warn-soft px-3.5 text-[15px] font-semibold text-warn-ink hover:bg-warn-soft/70";

/**
 * 이 계획을 지금 시작할 수 없을 때 실행 확인 카드의 본문: 이유 목록 + 다음 행동 (투자 금액·체크리스트·꺼진 시작 버튼 대신 — UX-2).
 * 이유는 금액 없는 미리 보기(내 계좌까지 본 결과)가 있으면 그것, 아직 없으면 계좌와 무관한 사유(blockedBy)로.
 * 금액 없는 미리 보기의 사유가 손익비·기대값뿐이면 '수동매매 (시연용)' 링크 줄(?manual=1, Discord ?t= 이어 붙임 — DECISIONS 31장).
 * blockedBy만으로는 보이지 않는다 (같은 종목 계획·주문 같은 내 계좌 사유가 나중에 와서 뒤집히지 않게).
 */
function BlockedBody({ r, pv, codes, easy, token }: { r: Recommendation; pv: RiskPreview | undefined; codes: string[]; easy: boolean; token: string | null }) {
  const fromPreview = pv && !pv.activatable && (pv.reasons.length > 0 || pv.reasonCodes.length > 0);
  const manualOk = fromPreview && onlyManualSkip(pv.reasonCodes);
  const easyReasons = fromPreview ? reasonPairs(pv) : codes.map((c) => ({ code: c, text: reasonSentence(c, null, "plan") }));
  const expertReasons = fromPreview
    ? pv.reasons.length > 0
      ? pv.reasons
      : pv.reasonCodes.map((c) => reasonSentence(c, null, "plan"))
    : codes.map((c) => blockedShort([c], false));
  const next = nextActionOf(fromPreview ? pv.reasonCodes : codes);
  return (
    <>
      <div role="alert" className="mt-3 rounded-lg bg-up-soft/70 p-3">
        <p className="text-[13px] font-semibold text-up-ink">{easy ? "지금은 시작할 수 없어요" : "활성화할 수 없는 사유"}</p>
        {easy ? (
          <ul aria-label="시작할 수 없는 이유" className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
            {easyReasons.map((x) => (
              <li key={x.text}>
                {x.text}
                {r.myPlan && x.code === "plan_exists" && (
                  <>
                    {" "}
                    <Link to={`/plans/${r.myPlan.id}`} className="font-semibold text-brand-ink">
                      보기
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <ul aria-label="활성화할 수 없는 사유" className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
            {expertReasons.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        )}
      </div>
      {next === "portfolio" && (
        <Link to="/portfolio" className={NEXT_LINK}>
          {easy ? "내 모의투자 보기" : "보유·주문 보기"}
          <Icon name="chevron" className="size-4" />
        </Link>
      )}
      {manualOk && (
        <>
          <Link to={manualStartPath(r.id, token)} className={MANUAL_LINK}>
            {MANUAL_START_TEXT.button}
            <Icon name="chevron" className="size-4" />
          </Link>
          <p className="mt-1 px-0.5 text-[12px] leading-snug text-mute">{easy ? MANUAL_START_TEXT.linkHint.easy : MANUAL_START_TEXT.linkHint.expert}</p>
        </>
      )}
      <Link to="/recommendations" className={NEXT_LINK}>
        {easy ? "다른 계획 제안 보기" : "다른 추천 보기"}
        <Icon name="chevron" className="size-4" />
      </Link>
    </>
  );
}

/** 시연용 수동 시작 안내 (DECISIONS 31장): 건너뛰는 사유(금액 없는 미리 보기의 사유 — 전부 손익비·기대값) 목록. role은 두지 않는다. */
function ManualBanner({ pv, easy }: { pv: RiskPreview; easy: boolean }) {
  const lines = easy ? reasonPairs(pv).map((x) => x.text) : pv.reasons;
  return (
    <Notice tone="warn" className="mt-3">
      <p className="font-semibold">{easy ? MANUAL_START_TEXT.banner.easy : MANUAL_START_TEXT.banner.expert}</p>
      <ul aria-label={easy ? "건너뛰는 안전장치" : "건너뛰는 점검"} className="mt-1 list-disc space-y-0.5 pl-5 text-[13px]">
        {lines.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
    </Notice>
  );
}

function ActivateCard({
  r,
  token,
  titleRef,
  quote,
  manualRequested,
}: {
  r: Recommendation;
  token: string | null;
  titleRef: RefObject<HTMLHeadingElement | null>;
  /** 이 종목의 시세 (바로 사는지 판단 — 실시간일 때만) */
  quote: Quote | undefined;
  /** 주소에 ?manual=1 (시연용 수동 시작 — 자격은 아래에서 금액 없는 미리 보기로 다시 본다) */
  manualRequested: boolean;
}) {
  const navigate = useNavigate();
  const toast = useToast();
  const { easy } = useViewMode();
  const { data: market } = useMarket();
  // 넣을 돈: 방식(기본 %)과 입력 칸 (기본값 없음 — 칩은 칸을 채운다)
  const [mode, setMode] = useState<BudgetMode>("percent");
  const [raw, setRaw] = useState("");
  // 확인은 그때 본 수량·손실 금액에 대한 것이다 (금액을 바꿔 수량·손실이 바뀌면 다시 확인한다)
  const [ackedFor, setAckedFor] = useState<string | null>(null);
  const budget = parseBudget(raw, mode);
  const choice: BudgetChoice | null = budget.value !== null ? { mode, value: budget.value } : null;
  const choiceKey = choice ? `${choice.mode}:${choice.value}` : null;
  const debouncedKey = useDebounced(choiceKey, 400);
  const [dMode, dValue] = debouncedKey?.split(":") ?? [];
  const debounced: BudgetChoice | null = debouncedKey ? { mode: dMode as BudgetMode, value: Number(dValue) } : null;
  const open = r.status === "open";
  // 금액 없는 미리 보기 (머리 칩과 같은 쿼리): 이것이 막혔거나 계좌와 무관한 사유가 있으면 이 계획은 지금 시작할 수 없다.
  // 매수 가능 금액(% 기준)도 여기서 읽는다
  const head = useRiskPreview(r.id, null, open);
  const codes = blockedCodes(r);
  // 시연용 수동 시작 (DECISIONS 31장): ?manual=1이고, 금액 없는 미리 보기를 받았고 그것이 손익비·기대값으로만 막았을 때만 (blockedBy로는 정하지 않는다)
  const manual = manualRequested && open && canStartManually(head.data);
  // 금액을 정한 미리 보기. manual이면 ?manualStart=1로 따로 된 캐시에 받는다 (머리 칩·리포트 카드의 일반 미리 보기와 섞이지 않게)
  const preview = useRiskPreview(r.id, debounced, open && debounced !== null, manual);
  const hardBlocked = open && !manual && (codes.length > 0 || head.data?.activatable === false);
  const activate = useActivate(r.id);
  // 금액을 정한 미리 보기만 쓴다: 금액이 비면 같은 키(금액 없음)의 캐시나 이전 값이 남아도 보이지 않는다 (0주 미리 보기가 섞이지 않게)
  const pv = choice && preview.data?.budgetMode === choice.mode ? preview.data : undefined;
  const buyingPower = pv?.buyingPowerKrw ?? head.data?.buyingPowerKrw ?? null;
  const ackKey = pv ? `${pv.quantity}:${pv.maxLossKrw}` : null;
  // 금액이 바뀌면 체크 셋(key={ackKey})을 새로 그려 체크를 지운다. 확인 상태도 그때 같이 지운다 —
  // 금액을 지웠다 다시 정해 처음 값(A → B → A)으로 돌아와도 빈 체크 아래에서 버튼이 켜지지 않게.
  // 확인 칸을 켠 뒤 지워졌으면 이유를 한 번 알린다 (말없이 지워지면 '고장'으로 읽힌다 — trade-16)
  const [touched, setTouched] = useState(false);
  const [seen, setSeen] = useState<{ key: string | null; loss: number | null }>({ key: ackKey, loss: pv?.maxLossKrw ?? null });
  const [reset, setReset] = useState<{ from: number; to: number } | null>(null);
  if (seen.key !== ackKey) {
    if (touched && seen.key !== null && seen.loss !== null && pv) setReset({ from: seen.loss, to: pv.maxLossKrw });
    // 안내가 떠 있는 채로 다시 바뀌면 '지금' 금액으로 고친다 (처음 확인한 금액 → 지금 금액). 처음 금액으로 돌아왔으면 지운다
    else if (reset && pv) setReset(pv.maxLossKrw === reset.from ? null : { from: reset.from, to: pv.maxLossKrw });
    setSeen({ key: ackKey, loss: pv?.maxLossKrw ?? null });
    setAckedFor(null);
    setTouched(false);
  }
  // 확인 칸이 화면에서 빠지면(평소 막힌 화면) 확인도 지운다. 다시 나타나는 확인 칸은 빈 칸으로 새로 그려지므로, 남아 있으면 빈 칸 아래에서 시작 버튼이 켜진다
  // (?manual=1에서 뒤로 갔다가 다시 들어오기 — 쿼리만 바뀌어 이 카드는 새로 그려지지 않는다, 중단 스위치를 켰다 끄기 — DECISIONS 31장)
  if (hardBlocked && (ackedFor !== null || touched || reset)) {
    setAckedFor(null);
    setTouched(false);
    setReset(null);
  }
  const acked = ackedFor !== null && ackedFor === ackKey;
  const setAcked = (ok: boolean) => setAckedFor(ok ? ackKey : null);
  const touch = () => {
    setTouched(true);
    setReset(null);
  };
  const settling = debouncedKey !== choiceKey || preview.isFetching;
  const blocked = pv?.activatable === false;
  const canActivate = open && choice !== null && !settling && pv?.activatable === true && acked && !activate.isPending;
  const session = market?.markets.find((m) => m.market === r.market);
  const closedNotice = closedMarketNotice(session, r.market);
  const buysNow = buysRightAway(session, quote, r.entryPrice);
  const rejected = activate.isError ? rejectionSentences(activate.error, "plan") : null;
  const title = manual ? (easy ? MANUAL_START_TEXT.start.easy : MANUAL_START_TEXT.start.expert) : easy ? "모의 자동매매 시작" : "계획 활성화";
  const priceGone = priceExpiredText(r.expiredReason, easy);
  // 시작할 수 없을 때 버튼 아래의 다음 행동 하나 (진행 중인 내 계획은 위쪽 '내 모의 자동매매 보기'가 이미 잇는다 — trade-15)
  const next = blocked && pv ? nextActionOf(pv.reasonCodes) : null;

  return (
    <Card aria-labelledby="activate-title" className={cn(token && "ring-2 ring-brand")}>
      <h2 id="activate-title" ref={titleRef} tabIndex={-1} className="flex scroll-mt-20 items-center gap-1.5 text-[17px] font-bold outline-none">
        <Icon name="bolt" className="size-5 text-brand" />
        {easy ? "실행 확인" : "계획 활성화"}
      </h2>
      <p className="mt-1 text-[13px] leading-snug text-mute">
        {easy
          ? "AI는 제안만 해요. 넣을 돈은 내가 정하고, 모의 자동매매를 시작할 수 있는지는 안전장치가 확인해요."
          : "AI는 제안만 합니다. 투자 금액은 내가 정하고, 수량 계산과 활성화 가능 여부(손익비·매수 가능 금액·한도)는 리스크 엔진이 확인합니다."}
      </p>

      {r.myPlan && (
        <Link
          to={`/plans/${r.myPlan.id}`}
          className="press mt-3 flex h-11 items-center justify-between gap-2 rounded-xl bg-brand-soft px-3.5 text-[15px] font-semibold text-brand-ink hover:bg-brand-soft/70"
        >
          <span className="flex items-center gap-2">
            {easy ? "내 모의 자동매매 보기" : "내 계획 보기"} <PlanStatusChip status={r.myPlan.status} easy={easy} />
          </span>
          <Icon name="chevron" className="size-4" />
        </Link>
      )}

      {!open ? (
        <Notice tone="warn" className="mt-3">
          {priceGone
            ? // 가격이 이미 손절가·목표가를 지나 끝난 제안 (DECISIONS 25장 — 장중 가격 숫자는 넣지 않는다)
              easy
              ? `${priceGone}. 가격이 바뀌었으니 새로 만들어 보세요.`
              : `${priceGone} — 활성화할 수 없습니다.`
            : easy
              ? `이 계획은 ${formatDayLabel(kstDayOf(r.validUntil))}에 기한이 끝났어요. 가격이 바뀌었을 수 있으니 새로 만들어 보세요.`
              : `유효 기한(${formatDateTime(r.validUntil)})이 지나 활성화할 수 없습니다.`}
        </Notice>
      ) : hardBlocked ? (
        <BlockedBody r={r} pv={head.data} codes={codes} easy={easy} token={token} />
      ) : (
        <>
          {manual && head.data && <ManualBanner pv={head.data} easy={easy} />}
          <BudgetPicker
            mode={mode}
            raw={raw}
            onMode={(m) => {
              // 방식을 바꾸면 입력을 비운다 (25%의 25가 25원으로 남지 않게)
              setMode(m);
              setRaw("");
            }}
            onRaw={setRaw}
            value={budget.value}
            error={budget.error}
            buyingPowerKrw={buyingPower}
            easy={easy}
          />

          {/* 계산 결과는 정보라 채움 상자. 다시 계산하는 동안은 흐리게 + 오른쪽 위 작은 표시 (높이가 변하지 않게 — motion-18).
              받지 못했을 때는 테두리 상자 — 안의 '다시 시도'(채움 버튼)가 바탕에 묻히지 않게. 금액을 정하기 전에는 빈 상태 한 줄 */}
          <section
            aria-label={easy ? "이 금액으로 사는 수량" : "리스크 미리 보기"}
            aria-busy={choice !== null && settling}
            className={cn("relative mt-3 rounded-xl p-3.5", (choice ? preview.isError : head.isError) ? "ring-1 ring-line" : "bg-fill")}
          >
            {!choice ? (
              head.isError ? (
                // 금액 없는 미리 보기(머리 칩·매수 가능 금액)를 받지 못했으면 여기서 다시 받는다 — 같은 쿼리라 머리 칩도 바뀐다 (trade-r5)
                <ErrorState compact message={errorMessage(head.error)} onRetry={() => void head.refetch()} retrying={head.isFetching} />
              ) : (
                <p className="text-[14px] text-mute">
                  {easy ? "금액을 정하면 몇 주를 사는지 보여 드려요." : "투자 금액을 정하면 수량·매수 금액·손절 시 손실을 계산합니다."}
                </p>
              )
            ) : preview.isError ? (
              // 미리 보기는 저절로 다시 받지 않는다 (금액을 바꾸거나 창으로 돌아올 때만) — 여기서 다시 받게 한다 (증권사 조회 장애 503 등).
              // 금액 없는 미리 보기도 실패해 있었으면 같이 다시 받는다 (머리 칩)
              <ErrorState
                compact
                message={errorMessage(preview.error)}
                onRetry={() => {
                  void preview.refetch();
                  if (head.isError) void head.refetch();
                }}
                retrying={preview.isFetching}
              />
            ) : !pv ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : (
              <>
                <div className={cn("transition-opacity duration-fast", settling && "opacity-60")}>
                  {easy ? <EasyPreview r={r} pv={pv} /> : <ExpertPreview r={r} pv={pv} manual={manual} />}
                </div>
                {settling && <Spinner className="absolute top-3.5 right-3.5 text-mute" />}
              </>
            )}
          </section>

          {pv?.activatable && pv.largeLoss && pv.maxLossRate != null && (
            // 건당 위험 1%는 수량을 정하지 않는다 — 넘으면 알리기만 하고 막지 않는다 (2026-10-11 B3).
            // 다른 사유로 막혔을 때는 사유 상자가 말한다 ('활성화는 가능'과 '활성화할 수 없음'이 같이 보이지 않게)
            <Notice tone="warn" className="mt-3">
              {easy
                ? `손절되면 내 자산의 ${lossRateText(pv.maxLossRate)}를 잃어요. 안전장치 기준(1%)보다 커요. 금액을 줄이면 손실도 줄어요.`
                : `손절 시 손실이 총자산의 ${lossRateText(pv.maxLossRate)}로 건당 위험 기준 1%를 넘습니다 (경고만, 활성화는 가능).`}
            </Notice>
          )}
          {closedNotice && <Notice className="mt-3">{closedNotice}</Notice>}
          {r.market === "US" && easy && <p className="mt-2 text-[13px] text-mute">가격은 달러, 이익·손실은 원화(그때 환율)로 보여요.</p>}

          {reset && (
            <Notice tone="warn" className="mt-3">
              {easy
                ? `금액이 바뀌어 다시 확인해 주세요 · 손절 시 약 ${formatKrw(reset.from)} → ${formatKrw(reset.to)}`
                : `금액이 바뀌어 확인을 다시 받습니다 · 손절 시 손실 ${formatKrw(reset.from)} → ${formatKrw(reset.to)}`}
            </Notice>
          )}

          {/* 언제 사는지는 금액과 무관해 정하기 전에도 보인다. 확인(체크)은 금액을 정한 미리 보기의 수량·손실에 대한 것이라 그 뒤에 */}
          {easy ? (
            <div className="mt-3 space-y-2">
              {blocked && <p className="text-[13px] font-semibold text-sub">시작할 수 있게 되면 확인할 수 있어요.</p>}
              <p className={cn("text-[14px] leading-snug text-sub", blocked && "opacity-50")}>
                {buysNow
                  ? "지금 가격이 사는 가격보다 낮아서, 시작하면 모의 계좌에서 바로 사요."
                  : `${formatPrice(r.entryPrice, r.currency)} 이하가 될 때까지 ${entryDeadlineLabel(r.validUntil, r.market)}까지만 기다려요. 그때까지 안 내려오면 사지 않고 끝나요(돈은 그대로).`}
              </p>
              {pv && <Checklist key={`${ackKey}:${manual}`} r={r} pv={pv} manual={manual} onReady={setAcked} onTouch={touch} disabled={blocked} />}
            </div>
          ) : (
            <>
              {blocked && <p className="mt-3 text-[13px] font-semibold text-sub">활성화할 수 있게 되면 확인할 수 있습니다.</p>}
              {buysNow && <p className="mt-3 text-[13px] text-sub">현재가가 진입가 이하라 활성화하면 바로 모의 체결됩니다.</p>}
              {pv && (
                <SummaryCheck
                  r={r}
                  pv={pv}
                  manual={manual}
                  checked={acked}
                  onChange={(v) => {
                    setAcked(v);
                    if (v) touch();
                  }}
                  disabled={blocked}
                />
              )}
            </>
          )}

          <button
            type="button"
            disabled={!canActivate}
            onClick={() =>
              activate.mutate(
                {
                  ...(choice ? budgetParams(choice) : {}),
                  ...(token ? { token } : {}),
                  acknowledged: true,
                  // 시연용 수동 시작은 자격이 될 때만 보낸다 (일반 활성화 본문에는 키를 넣지 않는다)
                  ...(manual ? { manualStart: true } : {}),
                },
                {
                  onSuccess: (plan) => {
                    // 시연용 수동 시작 계획이면 토스트 앞에 그 표시를 붙인다 (DECISIONS 31장)
                    const say = (t: string, tone: "success" | "error") => toast(plan.manualStart ? `${MANUAL_START_TEXT.toast}${t}` : t, tone);
                    // 토스트는 응답의 상태로 고른다: 시작하자마자 샀으면(holding) "샀어요" — "주문을 넣었어요"라고 하지 않는다 (UX-3)
                    if (plan.status === "failed") say(easy ? "모의 주문을 넣지 못해 계획이 끝났어요." : "첫 주문 접수가 거절되어 계획이 실패했습니다.", "error");
                    else if (plan.status === "holding" && plan.fillPrice != null) {
                      const fill = formatPrice(plan.fillPrice, plan.currency);
                      say(
                        easy
                          ? `${plan.name} 모의 자동매매를 시작했어요. 모의 계좌에서 ${formatQty(plan.quantity)}를 ${fill}에 샀어요.`
                          : `${plan.name} 계획을 활성화했습니다. ${formatQty(plan.quantity)} ${fill}에 바로 체결됐습니다.`,
                        "success",
                      );
                    } else if (plan.status === "active") {
                      // 첫 주문을 일시 오류로 아직 못 냄 — 엔진 루프가 곧 낸다 (합친 알림도 '시작했어요', 리뷰 R-9)
                      say(easy ? `${plan.name} 모의 자동매매를 시작했어요. 사는 주문은 곧 넣어요.` : `${plan.name} 계획을 활성화했습니다. 진입 주문은 곧 접수됩니다.`, "success");
                    } else say(easy ? `${plan.name} 모의 자동매매를 시작했어요. 사는 주문을 넣었어요.` : `${plan.name} 계획을 활성화했습니다. 진입 주문을 냈습니다.`, "success");
                    // replace: 뒤로 가기가 이미 쓴 실행 확인·?t= 토큰 주소로 돌아가지 않게. started: 도착 화면의 단계 체크가 한 번 튄다
                    navigate(`/plans/${plan.id}`, { replace: true, state: { started: true } });
                  },
                },
              )
            }
            className={cn(
              "press mt-4 flex h-13 w-full items-center justify-center gap-2 rounded-xl text-[16px] font-bold disabled:opacity-40",
              // 시연용 수동 시작은 경고색 (lib/cn은 덮어쓰지 않으므로 바탕·글자색을 나눠 고른다)
              manual ? "bg-warn-soft text-warn-ink ring-1 ring-warn/40 hover:bg-warn-soft/70" : "bg-brand text-white hover:bg-brand-dark",
            )}
          >
            {activate.isPending && <Spinner />}
            {title}
          </button>
          {!choice ? (
            <p className="mt-2 text-[13px] text-mute">{easy ? "넣을 돈을 먼저 정해 주세요." : "투자 금액을 정하면 활성화할 수 있습니다."}</p>
          ) : (
            pv?.activatable &&
            !acked && (
              <p className="mt-2 text-[13px] text-mute">
                {easy ? (manual ? MANUAL_START_TEXT.checksHint : "위의 확인 셋을 모두 켜면 시작할 수 있어요.") : "확인에 체크하면 활성화할 수 있습니다."}
              </p>
            )
          )}
          {next === "other_plans" && (
            <Link to="/recommendations" className={NEXT_LINK}>
              {easy ? "다른 계획 제안 보기" : "다른 추천 보기"}
              <Icon name="chevron" className="size-4" />
            </Link>
          )}
          {next === "portfolio" && (
            <Link to="/portfolio" className={NEXT_LINK}>
              {easy ? "내 모의투자 보기" : "보유·주문 보기"}
              <Icon name="chevron" className="size-4" />
            </Link>
          )}
          {activate.isError &&
            (rejected && rejected.length > 0 ? (
              <div role="alert" className="mt-3 rounded-lg bg-up-soft/70 p-3">
                <p className="text-[13px] font-semibold text-up-ink">{easy ? "지금은 시작할 수 없어요" : "활성화할 수 없습니다"}</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
                  {(easy ? rejected : (activate.error as ApiError).detail.split("; ")).map((x) => (
                    <li key={x}>{x}</li>
                  ))}
                </ul>
              </div>
            ) : (
              <Notice tone="error" className="mt-3">
                {errorMessage(activate.error)}
              </Notice>
            ))}
        </>
      )}
    </Card>
  );
}

/** 사유 코드와 쉬운 문장 짝 (같은 문장은 한 번만, 계획 문맥 — cash_short는 '넣을 돈이 …'). */
function reasonPairs(pv: RiskPreview): { code: string | undefined; text: string }[] {
  const out: { code: string | undefined; text: string }[] = [];
  const n = Math.max(pv.reasonCodes.length, pv.reasons.length);
  for (let i = 0; i < n; i++) {
    const text = reasonSentence(pv.reasonCodes[i], pv.reasons[i], "plan");
    if (text && !out.some((x) => x.text === text)) out.push({ code: pv.reasonCodes[i], text });
  }
  return out;
}

/**
 * 사용자 입력(넣을 돈)으로 바뀐 금액은 중립 강조(Flash neutral — 회색이 0.8초에 걸쳐 사라진다). 오름·내림(빨강·파랑)을 쓰지 않는다 —
 * 금액을 줄여 매수 금액이 줄면 파랑으로 깜빡여 가격 하락처럼 읽히므로 (trade-16·31). 미리 보기가 처음 도착한 것은 바뀐 것이 아니라 움직이지 않는다.
 * 쉬운 보기는 문장 전체를 한 덩어리로 감싼다 (테스트가 "이 금액으로 ○주 · ○원" 문장 하나로 찾는다).
 */
function EasyPreview({ r, pv }: { r: Recommendation; pv: RiskPreview }) {
  const reasons = reasonPairs(pv);
  const fixable = pv.reasonCodes.some((c) => BUDGET_CODES.includes(c));
  return (
    <>
      <p className="pr-6 text-[16px] font-semibold tabular-nums">
        <Flash tone="neutral" value={pv.amountKrw}>
          이 금액으로 {formatQty(pv.quantity)} · {formatKrw(pv.amountKrw)}
        </Flash>
      </p>
      <dl className="mt-1">
        <Row label="목표에 팔면">
          {/* 손익비가 0 이하인 계획(시연용 수동 시작)은 목표에 팔아도 손실이다 — '+-'로 보이지 않게 */}
          <span className={pv.expectedProfitKrw < 0 ? "text-down" : "text-up"}>
            {pv.expectedProfitKrw < 0 ? formatSignedKrw(pv.expectedProfitKrw) : `+${formatKrw(pv.expectedProfitKrw)}`}
          </span>
        </Row>
        <Row label="손절에 팔면">
          <span className="text-down">-{formatKrw(pv.maxLossKrw)}</span>
          {pv.maxLossRate != null && <span className="text-[13px] font-normal text-mute"> (내 자산의 {lossRateText(pv.maxLossRate)})</span>}
        </Row>
        <Row label="직전 종가">{formatPrice(pv.lastPrice, r.currency)}</Row>
      </dl>
      <AsOf at={pv.lastPriceAsOf} market={r.market} className="block text-right" />
      <p className="mt-1 text-[13px] text-sub">
        {pv.limitedBy ? `${limitedByText(pv.limitedBy)}. ` : ""}가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요.
      </p>
      {reasons.length > 0 && (
        <div role="alert" className="mt-2 rounded-lg bg-up-soft/70 p-3">
          <p className="text-[13px] font-semibold text-up-ink">지금은 시작할 수 없어요</p>
          <ul aria-label="시작할 수 없는 이유" className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
            {reasons.map((x) => (
              <li key={x.text}>
                {x.text}
                {r.myPlan && x.code === "plan_exists" && (
                  <>
                    {" "}
                    <Link to={`/plans/${r.myPlan.id}`} className="font-semibold text-brand-ink">
                      보기
                    </Link>
                  </>
                )}
              </li>
            ))}
          </ul>
          {fixable && <p className="mt-1 text-[13px] text-sub">위에서 넣을 돈을 바꾸면 다시 계산해요.</p>}
        </div>
      )}
    </>
  );
}

function ExpertPreview({ r, pv, manual }: { r: Recommendation; pv: RiskPreview; manual: boolean }) {
  // 시연용 수동 시작으로 건너뛰었고 남은 사유가 없을 때만 '기준 미달 — 건너뜀' (cash_short 등이 남았으면 그대로 '거절')
  const skipped = manual && pv.skippedCodes.length > 0 && pv.activatable;
  return (
    <>
      <p className="flex items-center gap-1.5 pr-6 text-[14px] font-semibold">
        <Icon name={skipped ? "alert" : pv.approved ? "check" : "ban"} className={cn("size-4", skipped ? "text-warn" : pv.approved ? "text-ok" : "text-up")} />
        {skipped ? MANUAL_START_TEXT.previewSkipped : pv.approved ? "리스크 엔진 통과" : "리스크 엔진 거절"}
      </p>
      <dl className="mt-2">
        <Row label="수량">
          <Flash tone="neutral" value={pv.quantity}>
            {formatQty(pv.quantity)}
          </Flash>
        </Row>
        <Row label="매수 금액">
          <Flash tone="neutral" value={pv.amountKrw}>
            {formatKrw(pv.amountKrw)}
          </Flash>
        </Row>
        <Row label="목표 도달 시 이익">
          <span className={pv.expectedProfitKrw < 0 ? "text-down" : "text-up"}>
            {pv.expectedProfitKrw < 0 ? formatSignedKrw(pv.expectedProfitKrw) : `+${formatKrw(pv.expectedProfitKrw)}`}
          </span>
        </Row>
        <Row label="손절 시 손실">
          <span className="text-down">-{formatKrw(pv.maxLossKrw)}</span>
          {pv.maxLossRate != null && <span className="text-[13px] font-normal text-mute"> (총자산의 {lossRateText(pv.maxLossRate)})</span>}
        </Row>
        <Row label="수량 기준">{pv.limitedBy ?? "-"}</Row>
        {pv.lastPrice != null && <Row label="직전 종가">{formatPrice(pv.lastPrice, r.currency)}</Row>}
      </dl>
      <AsOf at={pv.lastPriceAsOf} market={r.market} className="block text-right" />
      {pv.reasons.length > 0 && (
        <div role="alert" className="mt-2 rounded-lg bg-up-soft/70 p-3">
          <p className="text-[13px] font-semibold text-up-ink">활성화할 수 없는 사유</p>
          <ul aria-label="활성화할 수 없는 사유" className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
            {pv.reasons.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          {pv.reasonCodes.some((c) => BUDGET_CODES.includes(c)) && <p className="mt-1 text-[13px] text-sub">투자 금액을 바꾸면 다시 계산합니다.</p>}
        </div>
      )}
    </>
  );
}

/** 쉬운 보기의 근거 목록: 접어 두고 개수만 (모바일에서 실행 확인까지의 길이를 줄인다). 위험은 펼친 채 둔다. */
function ReasonsFold({ reasons }: { reasons: string[] }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div className="mt-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className="press -mx-1 flex h-11 w-[calc(100%+0.5rem)] items-center justify-between rounded-lg px-1 text-[14px] font-semibold text-sub hover:bg-fill/50"
      >
        근거 {reasons.length}개 보기
        <Icon name="chevron-down" className={cn("size-5 text-mute-weak transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id={id}>
        <ul className="list-disc space-y-1 pt-1 pl-5 text-[14px] leading-relaxed">
          {reasons.map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

/**
 * 머리의 '시작할 수 없는 이유' 한 줄 (첫 사유 하나). 금액 없는 미리 보기(내 계좌까지 본 결과)가 막혔으면 그 사유, 아니면 계좌와 무관한 사유(blockedBy).
 * 시작할 수 있거나 아직 모르면 null. 기한이 지난 추천은 머리 칩('기한 지남')과 실행 확인 안내가 말하므로 null.
 * 가격이 이미 손절가·목표가를 지나 끝난 추천은 그 까닭 한 줄 (쉬운 보기 긴 문장, 전문가 보기 '손절가 이탈로 만료' 등 — DECISIONS 25장).
 */
function blockedLine(r: Recommendation, pv: RiskPreview | undefined, easy: boolean): string | null {
  if (r.status !== "open") return priceExpiredText(r.expiredReason, easy);
  if (pv && !pv.activatable) {
    const first = easy ? reasonPairs(pv)[0]?.text : (pv.reasons[0] ?? reasonSentence(pv.reasonCodes[0], null, "plan"));
    if (first) return first;
  }
  const code = blockedCodes(r)[0];
  return code ? reasonSentence(code, null, "plan") : null;
}

export function RecommendationPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t");
  // 시연용 수동 시작 요청 (DECISIONS 31장) — 자격(손익비·기대값으로만 막힘)은 금액 없는 미리 보기로 다시 본다. 자격이 없으면 무시한다
  const manualRequested = params.get("manual") === "1";
  const { easy } = useViewMode();
  const { data: r, isPending, isError, error, refetch, isFetching } = useRecommendation(Number(id));
  const reveal = useRevealAfterLoading(isPending);
  const { data: quotes } = useQuotes(r ? [r.symbol] : []);
  const quote = r ? quotes?.get(r.symbol) : undefined;
  const last = quote?.price ?? null;
  const open = r?.status === "open";
  // 머리 칩은 안전장치 결과로 말한다. 실행 확인 카드의 금액 없는 미리 보기와 같은 쿼리라 요청이 늘지 않는다 (trade-04)
  const head = useRiskPreview(r?.id ?? Number.NaN, null, Boolean(r && open));
  const titleRef = useRef<HTMLHeadingElement>(null);

  if (isPending) {
    return (
      <>
        <PageHeader title={<Skeleton className="h-6 w-40" />} docTitle={easy ? "새 계획 제안" : "AI 추천"} back />
        <SkeletonCard lines={6} />
      </>
    );
  }
  if (isError) {
    return (
      <>
        <PageHeader title={easy ? "새 계획 제안" : "AI 추천"} back />
        <Card>
          <ErrorState
            message={error instanceof ApiError && error.status === 404 ? (easy ? "계획을 찾을 수 없어요." : "추천을 찾을 수 없습니다.") : errorMessage(error)}
            onRetry={() => void refetch()}
            retrying={isFetching}
          />
        </Card>
      </>
    );
  }

  const src = sourceLink(r, easy);
  const live = r.myPlan != null && isPlanLive(r.myPlan.status);
  const manualReady = manualRequested && open && canStartManually(head.data);
  const why = blockedLine(r, head.data, easy);
  const weekend = open && easy && deadlineMovedEarlier(r.validUntil, r.market); // 주말·장 시작 전 기한은 앞 거래일 장 마감으로
  const chip =
    !open ? (
      <RecStatusChip open={open} validUntil={r.validUntil} expiredReason={r.expiredReason} easy={easy} className="h-7 px-2 text-[13px]" />
    ) : live ? (
      <ReadinessChip state="live" easy={easy} className="h-7 px-2 text-[13px]" />
    ) : head.data ? (
      <ReadinessChip state={head.data.activatable ? "ready" : "blocked"} easy={easy} className="h-7 px-2 text-[13px]" />
    ) : head.isError ? (
      // 안전장치 결과를 받지 못했으면 시간 사실(기한)로 돌아간다 — 뼈대로 남으면 '불러오는 중'으로 읽힌다.
      // 오류 문장과 다시 시도는 실행 확인 카드가 맡는다 (같은 쿼리라 거기서 다시 받으면 이 칩도 바뀐다 — trade-r5)
      <RecStatusChip open={open} validUntil={r.validUntil} expiredReason={r.expiredReason} easy={easy} className="h-7 px-2 text-[13px]" />
    ) : (
      <Skeleton className="h-7 w-24 shrink-0 rounded-md" />
    );
  // Discord 링크로 온 사람의 목적은 확인하고 시작하는 것: 모바일에서 실행 확인까지 바로 (자동 스크롤이 아니라 버튼 — 검토 순서를 해치지 않게)
  const goActivate = () => {
    const el = titleRef.current;
    if (!el) return;
    el.scrollIntoView?.({ behavior: prefersReducedMotion() ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  };

  return (
    <>
      <PageHeader title={easy ? `${r.name} 계획 제안` : `${r.name} 추천`} back />
      {token && (
        <Notice className="mb-3">
          <b>Discord에서 연 활성화 링크</b> ·{" "}
          {manualReady
            ? // 시연용 수동 시작(DECISIONS 31장): 시연용 띠를 따로 두지 않으므로 실제 시작 버튼 이름과 '시연용'을 이 띠가 말한다 (없는 버튼 이름을 말하지 않게)
              easy
              ? MANUAL_START_TEXT.discordNote.easy
              : MANUAL_START_TEXT.discordNote.expert
            : easy
              ? "내용을 확인하고 “모의 자동매매 시작”을 누르면 내 모의 계좌에서 시작해요 (Discord로 시작한 것으로 기록해요)."
              : "내용을 확인하고 “계획 활성화”를 누르면 내 모의 계좌에 계획이 만들어집니다 (Discord로 활성화한 것으로 기록)."}
          <button
            type="button"
            onClick={goActivate}
            className="press mt-2 flex h-10 items-center gap-1 rounded-lg bg-card px-3 text-[14px] font-semibold text-brand-ink hover:bg-card/70 lg:hidden"
          >
            {easy ? "실행 확인으로 이동" : "활성화 카드로 이동"}
            <Icon name="chevron-down" className="size-4" />
          </button>
        </Notice>
      )}
      {/* 시연용 수동 시작 띠: Discord 띠 자리에, token이 없을 때만 (token이 있으면 Discord 띠의 이동 버튼 하나만 둔다) */}
      {manualReady && !token && (
        <Notice tone="warn" className="mb-3">
          <b>{MANUAL_START_TEXT.badge}</b> · {easy ? MANUAL_START_TEXT.topNote.easy : MANUAL_START_TEXT.topNote.expert}
          <button
            type="button"
            onClick={goActivate}
            className="press mt-2 flex h-10 items-center gap-1 rounded-lg bg-card px-3 text-[14px] font-semibold text-warn-ink hover:bg-card/70 lg:hidden"
          >
            {easy ? "실행 확인으로 이동" : "활성화 카드로 이동"}
            <Icon name="chevron-down" className="size-4" />
          </button>
        </Notice>
      )}
      <div className={cn("grid gap-4 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-start lg:gap-6", reveal && "reveal-fade")}>
        <div className="min-w-0 space-y-3">
          <Card>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[14px] text-mute">
                  {r.symbol} · {r.market === "KR" ? "국내" : "미국"} · {easy ? "계획" : "추천"} #{r.id}
                </p>
                <p className="mt-0.5 text-[22px] font-bold tracking-tight">{r.name}</p>
              </div>
              {chip}
            </div>
            {/* 시작할 수 없는 이유 한 줄: 배지 바로 아래 (맨 아래 실행 확인까지 내려가야 알던 것 — UX-2) */}
            {why && (
              <p className="mt-2 flex items-start gap-1.5 text-[14px] leading-snug font-semibold text-sub">
                <Icon name="ban" className="mt-0.5 size-4 shrink-0 text-mute" />
                {why}
              </p>
            )}
            <div className="mt-2 flex flex-wrap gap-1.5">
              <SourceBadge source={r.source} />
              {!easy && <RiskLevelBadge level={r.riskLevel} />}
            </div>
            <p className="mt-2 text-[14px] text-sub">
              {r.requestedBy ? `${r.requestedBy} ${easy ? "님이 만듦" : "신청"}` : "자동"} · {formatDateTime(r.createdAt)}
              {/* 가격 때문에 끝난 제안은 머리 칩과 이름 아래 문장이 이미 말하므로 기한 칸을 비운다 (같은 말 세 번 — DECISIONS 25장) */}
              {!open && priceExpiredText(r.expiredReason, easy) ? null : " · "}
              {!open
                ? priceExpiredText(r.expiredReason, easy)
                  ? null
                  : `${formatDateTime(r.validUntil)}에 ${easy ? "기한 지남" : "만료"}`
                : weekend
                  ? // 기한이 주말·장 시작 전이면 실제로 살 수 있는 마지막(앞 거래일 장 마감)으로 (UX-11, 리뷰 R-5)
                    `${entryDeadlineLabel(r.validUntil, r.market)}까지`
                  : `${timeLeft(r.validUntil)} (${formatDateTime(r.validUntil)}까지)`}
            </p>
            {r.source === "demo" && (
              <Notice tone="warn" className="mt-3">
                {easy ? "연습용 예시 계획(AI 아님)이에요." : "연습용 예시 계획입니다 (AI 아님)."} {SOURCE.demo.hint}.
              </Notice>
            )}
            <div className="mt-5">
              <PriceLadder
                stop={r.stopPrice}
                entry={r.entryPrice}
                target={r.targetPrice}
                last={last}
                basis={quote?.basis}
                currency={r.currency}
                easy={easy}
                reveal={reveal}
              />
              <AsOf at={quote?.asOf} market={r.market} basis={quote?.basis} className="mt-1 block text-right" />
            </div>
          </Card>

          {easy ? (
            <Card aria-labelledby="plan-summary-title">
              <h2 id="plan-summary-title" className="text-[17px] font-bold">
                계획 요약
              </h2>
              <ul className="mt-2 space-y-1.5 text-[15px] leading-relaxed">
                <li>
                  목표에 팔면 <b className="text-up tabular-nums">{formatRate(r.targetReturn, 1)}</b> · 손절에 팔면{" "}
                  <b className="text-down tabular-nums">{formatRate(r.stopLossRate, 1)}</b> <span className="text-[13px] text-mute">(수수료·세금 빼기 전)</span>
                </li>
                <li>목표에 팔면 버는 돈이 손절에 팔면 잃는 돈의 {r.rewardRisk.toFixed(1)}배예요 (수수료·세금 반영).</li>
                <li>산 뒤 최대 {r.holdingDays}거래일 보유해요.</li>
                <li className="text-[14px] text-sub">
                  만들 때 직전 종가 <span className="tabular-nums">{formatPrice(r.priceAtCreation, r.currency)}</span>
                </li>
              </ul>
            </Card>
          ) : (
            // 칸 수는 카드 폭으로 정한다: 1024px처럼 왼쪽 열이 좁으면 2칸, 넓으면 4칸 (화면 폭 sm으로 쪼개면 '+12./15%'처럼 깨진다 — trade-03)
            <Card aria-labelledby="metrics-title" className="@container">
              <h2 id="metrics-title" className="mb-3 text-[17px] font-bold">
                지표
              </h2>
              <dl className="grid grid-cols-2 gap-2 @lg:grid-cols-4">
                <Metric label="목표 수익률" value={formatRate(r.targetReturn)} className="text-up" sub="비용 전" />
                <Metric label="손절률" value={formatRate(r.stopLossRate)} className="text-down" sub="비용 전" />
                <Metric label="손익비" value={r.rewardRisk.toFixed(2)} sub="비용 반영" />
                <Metric label="목표 도달 확률" value={formatPercent(r.probability)} sub={r.probabilityAssumed ? "가정 (AI가 주지 않음)" : undefined} />
                <Metric label="기대수익률" value={formatRate(r.expectedReturn)} className={r.expectedReturn >= 0 ? "text-up" : "text-down"} sub="비용 반영" />
                <Metric label="보유 기간" value={`${r.holdingDays}거래일`} />
                <Metric label="신뢰도" value={r.confidence == null ? "-" : `${Math.round(r.confidence)}점`} sub={r.confidence == null ? "없음" : "0~100"} />
                <Metric label="추천 때 종가" value={formatPrice(r.priceAtCreation, r.currency)} sub="만들 때의 직전 종가" />
              </dl>
            </Card>
          )}

          <Card aria-labelledby="summary-title">
            <h2 id="summary-title" className="text-[17px] font-bold">
              {easy ? "AI 의견 요약" : "결론"}
            </h2>
            <p className="mt-1 text-[15px] leading-relaxed">{r.summary}</p>
            {r.reasons.length > 0 &&
              (easy ? (
                <ReasonsFold reasons={r.reasons} />
              ) : (
                <div className="mt-3">
                  <h3 className="text-[14px] font-semibold text-sub">근거</h3>
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-[14px] leading-relaxed">
                    {r.reasons.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                </div>
              ))}
            {r.risks.length > 0 && (
              <div className="mt-3">
                <h3 className="text-[14px] font-semibold text-sub">{easy ? "위험" : "리스크"}</h3>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-[14px] leading-relaxed">
                  {r.risks.map((x, i) => (
                    <li key={i}>{x}</li>
                  ))}
                </ul>
              </div>
            )}
            {src && (
              <Link to={src.to} className="press mt-4 flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line">
                {src.label}
                <Icon name="chevron" className="size-4" />
              </Link>
            )}
          </Card>
        </div>

        <div ref={stickyFit} className="space-y-3 lg:sticky" style={{ top: STICKY_FIT_TOP }}>
          <ActivateCard key={r.id} r={r} token={token} titleRef={titleRef} quote={quote} manualRequested={manualRequested} />
          <p className="px-1 text-[13px] text-mute">
            {easy ? `팀에서 이 계획으로 시작한 모의 자동매매 ${r.planCount}건` : `팀에서 이 추천으로 활성화한 계획 ${r.planCount}건`}
          </p>
        </div>
      </div>
      {r.canDelete && <DeleteRec key={r.id} r={r} easy={easy} />}
    </>
  );
}

/**
 * 내가 만든 계획 제안 지우기 (DECISIONS 25장): 화면 맨 아래, 눈에 덜 띄게. 확인 → DELETE → 목록으로 옮기고 토스트.
 * 리포트 추천이면 출처 리포트도 같이 사라진다고 미리 말한다. 진행 중인 계획이 있으면 서버의 400 문장을 그대로 보인다.
 */
function DeleteRec({ r, easy }: { r: Recommendation; easy: boolean }) {
  const navigate = useNavigate();
  const toast = useToast();
  const del = useDeleteRecommendation(r);
  return (
    <DeleteAction
      className="mt-6"
      label={easy ? "이 제안 지우기" : "추천 지우기"}
      title={easy ? "이 제안을 지울까요?" : "이 추천을 지울까요?"}
      description={r.source === "report" ? "제안과 출처 리포트가 목록에서 사라져요." : "제안이 목록에서 사라져요."}
      pending={del.isPending}
      error={del.error}
      onOpen={del.reset}
      onConfirm={() =>
        del.mutate(undefined, {
          onSuccess: () => {
            navigate("/recommendations", { replace: true });
            toast(easy ? "제안을 지웠어요" : "추천을 지웠어요", "success");
          },
        })
      }
    />
  );
}
