// 추천(새 계획 제안) 카드: 종목·출처·리스크 단계·진입/목표/손절·손익비·기대수익률·보유 기간·유효 기한·내 계획·팀 활성화 수. 누르면 상세.
// easy면 쉬운 보기: 사는·목표·손절 가격과 보유 기간만 (기대수익률·확률은 성공 확률로 오해할 수 있어 숨긴다 — docs/plans/컨셉변경계획.md 4-4).
// 오른쪽 위 칩은 유효 기한(시간 사실). 배지 줄의 '시작할 수 있음 / 지금은 시작할 수 없음 · 이유'는 계좌와 무관한 사유(blockedBy)로만 말한다 —
// 내 계좌 사정까지 본 최종 판단은 상세의 안전장치다 (UX-2, DECISIONS 23장). 같은 종목의 다른 제안(rest)은 카드 안에 접는다.
// 상자 규칙: 정보는 채움(bg-fill), 확인·입력 묶음은 테두리. 카드 안에 카드를 넣지 않는다 — 다른 카드 안에서는 variant="flush" (trade-20).
import { useId, useState } from "react";
import { Link } from "react-router";
import type { Recommendation } from "../../api/types";
import { SOURCE, isRecBlocked, timeLeftShort } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatPercent, formatPrice, formatRate } from "../../lib/format";
import { planStatusText, priceExpiredText } from "../../lib/plainText";
import { Icon } from "../Icon";
import { Collapse } from "../motion/Collapse";
import { BlockedMark, PlanStatusChip, ProposalReadiness, RecStatusChip, RiskLevelBadge, SourceBadge } from "./Badges";
import { WrapPrice } from "./PriceLadder";

const linkName = (r: Recommendation, easy: boolean) => (easy ? `${r.name} 계획 제안 보기` : `${r.name} 추천 보기`);

// 압축 행의 키보드 포커스 테두리는 행 안쪽에 그린다: 행을 담는 목록 카드(ul)가 overflow-hidden rounded-2xl이라 바깥 테두리는 잘려
// 선 하나만 남거나 이웃 행의 테두리처럼 보인다 (a11y-5, 종목 검색 행과 같은 방식). 카드의 첫 행·마지막 행은 테두리 모서리를 카드와 맞춘다
const ROW_FOCUS = "focus-visible:outline-offset-[-2px] [li:first-child>&]:rounded-t-2xl [li:last-child>&]:rounded-b-2xl";

/** 화면 읽기용 한 문장 요약 (링크 이름은 짧게 두고 설명으로 잇는다). 보이는 글자 하나와 같은 문장이 되지 않게 여러 사실을 잇는다. */
function summaryOf(r: Recommendation, easy: boolean): string {
  const open = r.status === "open";
  return [
    open ? `${easy ? "기한" : "유효"} ${timeLeftShort(r.validUntil)}` : (priceExpiredText(r.expiredReason, easy, "short") ?? (easy ? "기한 지남" : "만료")),
    SOURCE[r.source]?.label ?? r.source,
    r.myPlan ? `내 계획: ${planStatusText(r.myPlan.status, easy)}` : null,
    isRecBlocked(r) ? (easy ? "지금은 시작할 수 없음" : "활성화 불가") : null,
    `${easy ? "사는 가격" : "진입"} ${formatPrice(r.entryPrice, r.currency)}`,
    `${easy ? "목표 가격" : "목표"} ${formatPrice(r.targetPrice, r.currency)}`,
    `${easy ? "손절 가격" : "손절"} ${formatPrice(r.stopPrice, r.currency)}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** 가격 칸 글자 크기: 7자리 원화("1,603,000원")처럼 길면 좁은 카드(PC 2열 등)에서 한 단계 줄인다 (UX-16). 칸 폭은 가격 줄(dl)의 컨테이너 폭으로 잰다. */
function priceSize(r: Recommendation): string {
  const longest = Math.max(...[r.entryPrice, r.targetPrice, r.stopPrice].map((p) => formatPrice(p, r.currency).length));
  return longest >= 10 ? "text-[12px] @min-[18rem]:text-[14px]" : "text-[14px]";
}

/** 카드 안 '같은 종목의 이전 제안 n개' 접힘 (UX-2). 펼치면 압축 행으로 (누르면 그 제안의 상세). */
function RestFold({ r, rest, older, easy }: { r: Recommendation; rest: Recommendation[]; older: boolean; easy: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const noun = easy ? "제안" : "추천";
  return (
    <div className="border-t border-line">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "press flex min-h-11 w-full items-center justify-between gap-2 px-5 py-2 text-left text-[14px] font-semibold text-sub hover:bg-fill/50",
          !open && "rounded-b-2xl",
        )}
      >
        {`같은 종목의 ${older ? "이전" : "다른"} ${noun} ${rest.length}개`}
        <Icon name="chevron-down" className={cn("size-5 shrink-0 text-mute-weak transition-transform duration-fast", open && "rotate-180")} />
      </button>
      <Collapse open={open} id={id}>
        <ul aria-label={`${r.name} ${older ? "이전" : "다른"} ${noun}`} className="divide-y divide-line border-t border-line">
          {rest.map((x) => (
            <li key={x.id}>
              <RecommendationRow r={x} easy={easy} />
            </li>
          ))}
        </ul>
      </Collapse>
    </div>
  );
}

export function RecommendationCard({
  r,
  compact,
  easy = false,
  variant = "card",
  rest,
  restOlder = true,
}: {
  r: Recommendation;
  compact?: boolean;
  easy?: boolean;
  /** card: 화면 위 카드 · flush: 다른 카드 안에 놓일 때(채움 상자, 테두리·이중 여백 없음) */
  variant?: "card" | "flush";
  /** 같은 종목의 다른 제안 (최신순). 있으면 카드 아래에 접어 둔다 (목록 화면 — UX-2). */
  rest?: Recommendation[];
  /** rest가 모두 r보다 먼저 만든 것인지 ('이전' / '다른'). */
  restOlder?: boolean;
}) {
  const open = r.status === "open";
  const flush = variant === "flush";
  const folded = !flush && rest != null && rest.length > 0;
  const descId = useId();
  const link = (
    <Link
      to={`/recommendations/${r.id}`}
      aria-label={linkName(r, easy)}
      aria-describedby={descId}
      className={cn(
        "block",
        flush
          ? "rounded-xl bg-fill p-4 transition-colors hover:bg-line/60 active:bg-line"
          : folded
            ? "press-row rounded-t-2xl p-5 hover:bg-fill/50"
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
        <RecStatusChip open={open} validUntil={r.validUntil} expiredReason={r.expiredReason} easy={easy} />
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        <SourceBadge source={r.source} />
        {!easy && <RiskLevelBadge level={r.riskLevel} />}
        {r.myPlan && <PlanStatusChip status={r.myPlan.status} easy={easy} />}
        {/* 리포트·분석 화면 안의 카드(flush)는 그 화면의 매매 계획 카드가 안전장치 결과로 말한다 */}
        {!flush && <ProposalReadiness r={r} easy={easy} />}
      </div>

      {/* 가격 셋은 칸마다 줄이고(min-w-0), 길면 글자를 한 단계 줄이고, 그래도 좁으면 '원' 앞에서만 줄을 바꾼다 — 옆 칸과 붙지 않게 (UX-16) */}
      <dl className={cn("@container mt-3 grid grid-cols-3 gap-2 rounded-xl p-3 text-center", flush ? "bg-card" : "bg-fill")}>
        <div className="min-w-0">
          <dt className="text-[12px] text-mute">{easy ? "사는 가격" : "진입"}</dt>
          <dd className={cn("font-semibold tabular-nums", priceSize(r))}>
            <WrapPrice value={r.entryPrice} currency={r.currency} />
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] text-mute">{easy ? "목표 가격" : "목표"}</dt>
          <dd className={cn("font-semibold tabular-nums text-up", priceSize(r))}>
            <WrapPrice value={r.targetPrice} currency={r.currency} />
          </dd>
          <dd className="text-[11px] text-up tabular-nums">{formatRate(r.targetReturn, 1)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-[12px] text-mute">{easy ? "손절 가격" : "손절"}</dt>
          <dd className={cn("font-semibold tabular-nums text-down", priceSize(r))}>
            <WrapPrice value={r.stopPrice} currency={r.currency} />
          </dd>
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
  if (!folded) return link;
  return (
    <div className="rounded-2xl bg-card">
      {link}
      <RestFold r={r} rest={rest} older={restOlder} easy={easy} />
    </div>
  );
}

/**
 * 압축 한 줄 (모의투자 탭의 '새 계획 제안' 요약 — trade-29). 탭은 요약, /recommendations가 카드형 상세 목록이다.
 * 첫 줄 [종목 · 출처], 둘째 줄 [목표·손절 % · 남은 기한(내 계획이 있으면 그 상태) · 지금은 시작할 수 없으면 작은 표시(UX-2)]. 사는 가격 같은 자세한 숫자는 상세에서 본다.
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
              {open ? (easy ? `기한 ${left}` : `유효 ${left}`) : (priceExpiredText(r.expiredReason, easy, "short") ?? (easy ? "기한 지남" : "만료"))}
            </span>
          )}
          <BlockedMark r={r} easy={easy} />
        </div>
      </div>
      <Icon name="chevron" className="size-4 shrink-0 text-mute-weak" />
      <span id={descId} className="sr-only">
        {summaryOf(r, easy)}
      </span>
    </Link>
  );
}
