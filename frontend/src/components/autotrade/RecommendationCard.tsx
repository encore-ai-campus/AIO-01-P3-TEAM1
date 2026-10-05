// 추천(새 계획 제안) 카드: 종목·출처·리스크 단계·진입/목표/손절·손익비·기대수익률·보유 기간·유효 기한·내 계획·팀 활성화 수. 누르면 상세.
// easy면 쉬운 보기: 사는·목표·손절 가격과 보유 기간만 (기대수익률·확률은 성공 확률로 오해할 수 있어 숨긴다 — docs/컨셉변경계획.md 4-4).
// 오른쪽 위 칩은 유효 기한(시간 사실)만 말한다. 시작할 수 있는지는 상세의 안전장치가 정한다 (trade-04).
// 상자 규칙: 정보는 채움(bg-fill), 확인·입력 묶음은 테두리. 카드 안에 카드를 넣지 않는다 — 다른 카드 안에서는 variant="flush" (trade-20).
import { useId } from "react";
import { Link } from "react-router";
import type { Recommendation } from "../../api/types";
import { SOURCE, timeLeftShort } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatPercent, formatPrice, formatRate } from "../../lib/format";
import { planStatusText } from "../../lib/plainText";
import { Icon } from "../Icon";
import { PlanStatusChip, RecStatusChip, RiskLevelBadge, SourceBadge } from "./Badges";

const linkName = (r: Recommendation, easy: boolean) => (easy ? `${r.name} 계획 제안 보기` : `${r.name} 추천 보기`);

// 압축 행의 키보드 포커스 테두리는 행 안쪽에 그린다: 행을 담는 목록 카드(ul)가 overflow-hidden rounded-2xl이라 바깥 테두리는 잘려
// 선 하나만 남거나 이웃 행의 테두리처럼 보인다 (a11y-5, 종목 검색 행과 같은 방식). 카드의 첫 행·마지막 행은 테두리 모서리를 카드와 맞춘다
const ROW_FOCUS = "focus-visible:outline-offset-[-2px] [li:first-child>&]:rounded-t-2xl [li:last-child>&]:rounded-b-2xl";

/** 화면 읽기용 한 문장 요약 (링크 이름은 짧게 두고 설명으로 잇는다). 보이는 글자 하나와 같은 문장이 되지 않게 여러 사실을 잇는다. */
function summaryOf(r: Recommendation, easy: boolean): string {
  const open = r.status === "open";
  return [
    open ? `${easy ? "기한" : "유효"} ${timeLeftShort(r.validUntil)}` : easy ? "기한 지남" : "만료",
    SOURCE[r.source]?.label ?? r.source,
    r.myPlan ? `내 계획: ${planStatusText(r.myPlan.status, easy)}` : null,
    `${easy ? "사는 가격" : "진입"} ${formatPrice(r.entryPrice, r.currency)}`,
    `${easy ? "목표 가격" : "목표"} ${formatPrice(r.targetPrice, r.currency)}`,
    `${easy ? "손절 가격" : "손절"} ${formatPrice(r.stopPrice, r.currency)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

export function RecommendationCard({
  r,
  compact,
  easy = false,
  variant = "card",
}: {
  r: Recommendation;
  compact?: boolean;
  easy?: boolean;
  /** card: 화면 위 카드 · flush: 다른 카드 안에 놓일 때(채움 상자, 테두리·이중 여백 없음) */
  variant?: "card" | "flush";
}) {
  const open = r.status === "open";
  const flush = variant === "flush";
  const descId = useId();
  return (
    <Link
      to={`/recommendations/${r.id}`}
      aria-label={linkName(r, easy)}
      aria-describedby={descId}
      className={cn(
        "block",
        flush
          ? "rounded-xl bg-fill p-4 transition-colors hover:bg-line/60 active:bg-line"
          : "press-row rounded-2xl bg-card p-5 hover:bg-fill/50",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className={cn("truncate text-[17px] font-bold", !open && "text-sub")}>{r.name}</h3>
          <p className="text-[13px] text-mute">
            {r.symbol} · {r.market === "KR" ? "국내" : "미국"}
            {r.requestedBy && ` · ${r.requestedBy}`}
          </p>
        </div>
        <RecStatusChip open={open} validUntil={r.validUntil} easy={easy} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <SourceBadge source={r.source} />
        {!easy && <RiskLevelBadge level={r.riskLevel} />}
        {r.myPlan && <PlanStatusChip status={r.myPlan.status} easy={easy} />}
      </div>

      <dl className={cn("mt-3 grid grid-cols-3 gap-2 rounded-xl p-3 text-center", flush ? "bg-card" : "bg-fill")}>
        <div>
          <dt className="text-[12px] text-mute">{easy ? "사는 가격" : "진입"}</dt>
          <dd className="text-[14px] font-semibold whitespace-nowrap tabular-nums">{formatPrice(r.entryPrice, r.currency)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">{easy ? "목표 가격" : "목표"}</dt>
          <dd className="text-[14px] font-semibold whitespace-nowrap tabular-nums text-up">{formatPrice(r.targetPrice, r.currency)}</dd>
          <dd className="text-[11px] text-up tabular-nums">{formatRate(r.targetReturn, 1)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-mute">{easy ? "손절 가격" : "손절"}</dt>
          <dd className="text-[14px] font-semibold whitespace-nowrap tabular-nums text-down">{formatPrice(r.stopPrice, r.currency)}</dd>
          <dd className="text-[11px] text-down tabular-nums">{formatRate(r.stopLossRate, 1)}</dd>
        </div>
      </dl>

      {!compact &&
        (easy ? (
          <p className="mt-2 text-[13px] leading-relaxed text-sub">
            산 뒤 최대 {r.holdingDays}거래일 보유해요 · 목표에 팔면 버는 돈이 손절에 팔면 잃는 돈의 {r.rewardRisk.toFixed(1)}배예요
          </p>
        ) : (
          <p className="mt-2 text-[13px] leading-relaxed text-sub">
            손익비 <b className="font-semibold text-ink tabular-nums">{r.rewardRisk.toFixed(2)}</b>
            <span className="mx-1.5 text-mute-weak">|</span>
            기대수익률 <b className="font-semibold text-ink tabular-nums">{formatRate(r.expectedReturn)}</b>
            <span className="mx-1.5 text-mute-weak">|</span>
            확률 <b className="font-semibold text-ink tabular-nums">{formatPercent(r.probability)}</b>
            {r.probabilityAssumed && <span className="ml-1 text-mute">(가정)</span>}
            <span className="mx-1.5 text-mute-weak">|</span>
            보유 {r.holdingDays}거래일
          </p>
        ))}
      <p className="mt-2 text-[13px] text-mute">
        {easy ? "팀에서 시작" : "팀 활성화"} {r.planCount}건
      </p>
      <span id={descId} className="sr-only">
        {summaryOf(r, easy)}
      </span>
    </Link>
  );
}

/**
 * 압축 한 줄 (모의투자 탭의 '새 계획 제안' 요약 — trade-29). 탭은 요약, /recommendations가 카드형 상세 목록이다.
 * 첫 줄 [종목 · 출처], 둘째 줄 [목표·손절 % · 남은 기한(내 계획이 있으면 그 상태)]. 사는 가격 같은 자세한 숫자는 상세에서 본다.
 * 출처 배지는 줄이지 않는다('AI 아님'이 잘리지 않게) — 좁으면 종목 이름이 줄임표가 되되 세 글자(3rem)는 남긴다.
 */
export function RecommendationRow({ r, easy = false }: { r: Recommendation; easy?: boolean }) {
  const descId = useId();
  const open = r.status === "open";
  const left = open ? timeLeftShort(r.validUntil) : null;
  const soon = left !== null && !left.includes("일");
  return (
    <Link
      to={`/recommendations/${r.id}`}
      aria-label={linkName(r, easy)}
      aria-describedby={descId}
      className={cn("press-row flex items-center gap-3 px-5 py-3.5 hover:bg-fill/50", ROW_FOCUS)}
    >
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-1.5">
          <span className={cn("min-w-12 truncate text-[16px] font-semibold", !open && "text-sub")}>{r.name}</span>
          <SourceBadge source={r.source} />
        </p>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-mute tabular-nums">
          <span className="whitespace-nowrap">
            목표 <span className="text-up">{formatRate(r.targetReturn, 1)}</span>
            <span className="text-mute-weak"> · </span>
            손절 <span className="text-down">{formatRate(r.stopLossRate, 1)}</span>
          </span>
          <span aria-hidden="true" className="text-mute-weak">
            ·
          </span>
          {r.myPlan ? (
            <PlanStatusChip status={r.myPlan.status} easy={easy} />
          ) : (
            <span className={cn("inline-flex items-center gap-1 whitespace-nowrap", soon && "font-semibold text-warn-ink")}>
              <Icon name="clock" className="size-3.5" />
              {open ? (easy ? `기한 ${left}` : `유효 ${left}`) : easy ? "기한 지남" : "만료"}
            </span>
          )}
        </div>
      </div>
      <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
      <span id={descId} className="sr-only">
        {summaryOf(r, easy)}
      </span>
    </Link>
  );
}
