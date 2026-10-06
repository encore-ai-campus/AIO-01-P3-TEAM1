// /recommendations/:id: 새 계획 제안(전문가 보기: AI 추천)의 실행 확인 (docs/컨셉변경계획.md 4-2 "실행 확인", 6장 "내 확인").
// 쉬운 보기: 계획 요약 → 예산 → 안전장치가 정한 수량·금액(장마감 기준) → 장 시간 안내(opensAt) → 체크 셋(손절 시 손실 · 보유 기간 끝 매도 ·
//   AI 제안/모의)을 모두 켜야 "모의 자동매매 시작"(acknowledged: true).
// 전문가 보기: 머리 → 가격 사다리 → 지표 → 결론·근거·리스크 → 활성화 카드(예산 → 리스크 미리 보기 → 같은 체크 셋을 한 줄 요약 확인 → "계획 활성화").
// Discord 활성화 링크(?t=)로 들어오면 위에 띠를 보이고 활성화 요청에 token으로 넣는다 (via=discord).
// 배치: 여정 ② 검토 → ③ 실행 순서 그대로 (왼쪽에서 읽고 오른쪽에서 확인). PC 오른쪽 열은 화면보다 길면 아래 끝(시작 버튼)이 보이게 붙는다.
import { type RefObject, useId, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useActivate } from "../api/autotrade";
import { ApiError, errorMessage } from "../api/client";
import { isPlanLive, useMarket, useQuotes, useRecommendation, useRiskPreview } from "../api/queries";
import type { Recommendation, RiskPreview } from "../api/types";
import { PlanStatusChip, ReadinessChip, RecStatusChip, RiskLevelBadge, SourceBadge } from "../components/autotrade/Badges";
import { PriceLadder } from "../components/autotrade/PriceLadder";
import { Icon } from "../components/Icon";
import { Collapse } from "../components/motion/Collapse";
import { useToast } from "../components/toast";
import { AsOf, Card, ErrorState, Flash, Notice, PageHeader, Row, Skeleton, SkeletonCard, Spinner } from "../components/ui";
import { useViewMode } from "../hooks/useBeginnerMode";
import { useRevealAfterLoading } from "../hooks/useMotionState";
import { SOURCE, STICKY_FIT_TOP, closedMarketNotice, kstDayOf, nextActionOf, parseBudget, stickyFit, timeLeft } from "../lib/autotrade";
import { cn } from "../lib/cn";
import { formatDateTime, formatDayLabel, formatKrw, formatPercent, formatPrice, formatQty, formatRate } from "../lib/format";
import { prefersReducedMotion } from "../lib/motion";
import { reasonSentence, rejectionSentences } from "../lib/plainText";
import { useDebounced } from "../lib/useDebounced";

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

/** 안전장치(리스크 엔진)가 수량을 정한 이유를 쉬운 말로 (RiskPreview.limitedBy). */
function limitedByText(limitedBy: string): string {
  switch (limitedBy) {
    case "건당 위험 한도":
      return "손절에 팔려도 계좌의 약 1%만 잃게 정했어요";
    case "매수 가능 금액":
      return "지금 쓸 수 있는 현금 안에서 정했어요";
    case "총 금액 한도":
      return "총 투자 금액 한도 안에서 정했어요";
    case "유동성 한도":
      return "거래량에 비해 너무 많이 사지 않게 정했어요";
    case "예산":
      return "내가 적은 예산 안에서 정했어요";
    default:
      return limitedBy;
  }
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
 * 쉬운 보기의 체크 셋. 셋 다 켜야 onReady(true). 금액이 바뀌면(예산·수량) 부모가 key로 새로 그려 체크를 지운다.
 * disabled: 안전장치가 막았으면 켤 수 없게 흐리게 둔다 (숨기지 않는다 — 무엇을 확인하게 되는지는 미리 읽을 수 있게).
 */
function Checklist({
  r,
  pv,
  onReady,
  onTouch,
  disabled,
}: {
  r: Recommendation;
  pv: RiskPreview;
  onReady: (ok: boolean) => void;
  onTouch: () => void;
  disabled: boolean;
}) {
  const [checks, setChecks] = useState([false, false, false]);
  const set = (i: number) => (v: boolean) => {
    const next = checks.map((c, j) => (j === i ? v : c));
    setChecks(next);
    onReady(next.every(Boolean));
    if (v) onTouch();
  };
  const items = [
    `손절 가격(${formatPrice(r.stopPrice, r.currency)})에 팔리면 약 ${formatKrw(pv.maxLossKrw)}을 잃어요. 가격이 갑자기 크게 떨어지면 더 잃을 수도 있어요.`,
    `산 뒤 최대 ${r.holdingDays}거래일 보유해요. 그때까지 목표·손절에 닿지 않으면 그날 가격에 팔아요 — 이익일 수도, 손실일 수도 있어요.`,
    thirdCheck(r),
  ];
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
  checked,
  onChange,
  disabled,
}: {
  r: Recommendation;
  pv: RiskPreview;
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
      </ul>
      <label htmlFor={id} className="mt-1 flex min-h-11 cursor-pointer items-center gap-2 py-2 in-disabled:cursor-not-allowed">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-5 accent-brand" />
        <span className="text-[14px] font-semibold">위 내용을 확인했습니다</span>
      </label>
    </fieldset>
  );
}

function ActivateCard({ r, token, titleRef }: { r: Recommendation; token: string | null; titleRef: RefObject<HTMLHeadingElement | null> }) {
  const navigate = useNavigate();
  const toast = useToast();
  const { easy } = useViewMode();
  const { data: market } = useMarket();
  const [raw, setRaw] = useState("");
  // 확인은 그때 본 수량·손실 금액에 대한 것이다 (예산을 바꿔 금액이 바뀌면 다시 확인한다)
  const [ackedFor, setAckedFor] = useState<string | null>(null);
  const budget = parseBudget(raw);
  const debounced = useDebounced(budget.value, 400);
  const open = r.status === "open";
  const preview = useRiskPreview(r.id, debounced, open && !budget.error);
  const activate = useActivate(r.id);
  const pv = preview.data;
  const ackKey = pv ? `${pv.quantity}:${pv.maxLossKrw}` : null;
  // 금액이 바뀌면 체크 셋(key={ackKey})을 새로 그려 체크를 지운다. 확인 상태도 그때 같이 지운다 —
  // 예산을 지워 금액이 처음 값(A → B → A)으로 돌아와도 빈 체크 아래에서 버튼이 켜지지 않게.
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
  const acked = ackedFor !== null && ackedFor === ackKey;
  const setAcked = (ok: boolean) => setAckedFor(ok ? ackKey : null);
  const touch = () => {
    setTouched(true);
    setReset(null);
  };
  const settling = debounced !== budget.value || preview.isFetching;
  const blocked = pv?.activatable === false;
  const canActivate = open && !budget.error && !settling && pv?.activatable === true && acked && !activate.isPending;
  const session = market?.markets.find((m) => m.market === r.market);
  const closedNotice = closedMarketNotice(session, r.market);
  const rejected = activate.isError ? rejectionSentences(activate.error) : null;
  const title = easy ? "모의 자동매매 시작" : "계획 활성화";
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
          ? "AI는 제안만 해요. 몇 주를 살지와 시작할 수 있는지는 안전장치가 내 모의 계좌로 정해요."
          : "AI는 제안만 합니다. 수량과 활성화 가능 여부는 리스크 엔진(건당 위험 1%, 손익비·매수 가능 금액·한도)이 정합니다."}
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
          {easy
            ? `이 계획은 ${formatDayLabel(kstDayOf(r.validUntil))}에 기한이 끝났어요. 가격이 바뀌었을 수 있으니 새로 만들어 보세요.`
            : `유효 기한(${formatDateTime(r.validUntil)})이 지나 활성화할 수 없습니다.`}
        </Notice>
      ) : (
        <>
          <div className="mt-4">
            <label htmlFor="budget" className="block text-[15px] font-semibold">
              예산 (원, 선택)
            </label>
            <input
              id="budget"
              inputMode="numeric"
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={easy ? "비우면 안전장치가 정한 수량" : "비우면 리스크 엔진이 정한 수량"}
              aria-describedby="budget-help"
              aria-invalid={budget.error ? true : undefined}
              className="mt-1.5 h-12 w-full rounded-xl bg-fill px-3.5 text-[16px] tabular-nums outline-none focus:ring-2 focus:ring-brand"
            />
            <p id="budget-help" className={cn("mt-1 text-[13px]", budget.error ? "text-up-ink" : "text-mute")}>
              {budget.error ??
                (easy
                  ? "예산을 적으면 그 안에서만 사요. 안전장치가 더 적게 정하면 그 수량으로 사요."
                  : "예산을 주면 수량을 그만큼 줄입니다 (늘리지는 않습니다).")}
            </p>
          </div>

          {/* 안전장치의 계산 결과는 정보라 채움 상자. 다시 계산하는 동안은 흐리게 + 오른쪽 위 작은 표시 (높이가 변하지 않게 — motion-18).
              받지 못했을 때는 테두리 상자 — 안의 '다시 시도'(채움 버튼)가 바탕에 묻히지 않게 */}
          <section
            aria-label={easy ? "안전장치가 정한 수량" : "리스크 미리 보기"}
            aria-busy={settling}
            className={cn("relative mt-3 rounded-xl p-3.5", preview.isError ? "ring-1 ring-line" : "bg-fill")}
          >
            {preview.isError ? (
              // 미리 보기는 저절로 다시 받지 않는다 (예산을 바꾸거나 창으로 돌아올 때만) — 여기서 다시 받게 한다 (증권사 조회 장애 503 등)
              <ErrorState compact message={errorMessage(preview.error)} onRetry={() => void preview.refetch()} retrying={preview.isFetching} />
            ) : !pv ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : (
              <>
                <div className={cn("transition-opacity duration-fast", settling && "opacity-60")}>
                  {easy ? <EasyPreview r={r} pv={pv} /> : <ExpertPreview r={r} pv={pv} />}
                </div>
                {settling && <Spinner className="absolute top-3.5 right-3.5 text-mute" />}
              </>
            )}
          </section>

          {closedNotice && <Notice className="mt-3">{closedNotice}</Notice>}
          {r.market === "US" && easy && <p className="mt-2 text-[13px] text-mute">가격은 달러, 이익·손실은 원화(그때 환율)로 보여요.</p>}

          {reset && (
            <Notice tone="warn" className="mt-3">
              {easy
                ? `금액이 바뀌어 다시 확인해 주세요 · 손절 시 약 ${formatKrw(reset.from)} → ${formatKrw(reset.to)}`
                : `금액이 바뀌어 확인을 다시 받습니다 · 손절 시 손실 ${formatKrw(reset.from)} → ${formatKrw(reset.to)}`}
            </Notice>
          )}

          {pv &&
            (easy ? (
              <div className="mt-3 space-y-2">
                {blocked && <p className="text-[13px] font-semibold text-sub">시작할 수 있게 되면 확인할 수 있어요.</p>}
                <p className={cn("text-[14px] leading-snug text-sub", blocked && "opacity-50")}>
                  {formatPrice(r.entryPrice, r.currency)} 이하가 될 때까지 {formatDayLabel(kstDayOf(r.validUntil))}까지만 기다려요. 그때까지 안 내려오면
                  사지 않고 끝나요(돈은 그대로).
                </p>
                <Checklist key={ackKey} r={r} pv={pv} onReady={setAcked} onTouch={touch} disabled={blocked} />
              </div>
            ) : (
              <>
                {blocked && <p className="mt-3 text-[13px] font-semibold text-sub">활성화할 수 있게 되면 확인할 수 있습니다.</p>}
                <SummaryCheck
                  r={r}
                  pv={pv}
                  checked={acked}
                  onChange={(v) => {
                    setAcked(v);
                    if (v) touch();
                  }}
                  disabled={blocked}
                />
              </>
            ))}

          <button
            type="button"
            disabled={!canActivate}
            onClick={() =>
              activate.mutate(
                {
                  ...(budget.value !== null ? { budgetKrw: budget.value } : {}),
                  ...(token ? { token } : {}),
                  acknowledged: true,
                },
                {
                  onSuccess: (plan) => {
                    if (plan.status === "failed") toast(easy ? "모의 주문을 넣지 못해 계획이 끝났어요." : "첫 주문 접수가 거절되어 계획이 실패했습니다.", "error");
                    else toast(easy ? `${plan.name} 모의 자동매매를 시작했어요. 사는 주문을 넣었어요.` : `${plan.name} 계획을 활성화했습니다. 진입 주문을 냈습니다.`, "success");
                    // replace: 뒤로 가기가 이미 쓴 실행 확인·?t= 토큰 주소로 돌아가지 않게. started: 도착 화면의 단계 체크가 한 번 튄다
                    navigate(`/plans/${plan.id}`, { replace: true, state: { started: true } });
                  },
                },
              )
            }
            className="press mt-4 flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
          >
            {activate.isPending && <Spinner />}
            {title}
          </button>
          {pv?.activatable && !acked && (
            <p className="mt-2 text-[13px] text-mute">{easy ? "위의 확인 셋을 모두 켜면 시작할 수 있어요." : "확인에 체크하면 활성화할 수 있습니다."}</p>
          )}
          {next === "other_plans" && (
            <Link to="/recommendations" className="press mt-2 flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line">
              {easy ? "다른 계획 제안 보기" : "다른 추천 보기"}
              <Icon name="chevron" className="size-4" />
            </Link>
          )}
          {next === "portfolio" && (
            <Link to="/portfolio" className="press mt-2 flex h-11 items-center justify-between rounded-xl bg-fill px-3.5 text-[15px] font-semibold hover:bg-line">
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

/** 사유 코드와 쉬운 문장 짝 (같은 문장은 한 번만). */
function reasonPairs(pv: RiskPreview): { code: string | undefined; text: string }[] {
  const out: { code: string | undefined; text: string }[] = [];
  const n = Math.max(pv.reasonCodes.length, pv.reasons.length);
  for (let i = 0; i < n; i++) {
    const text = reasonSentence(pv.reasonCodes[i], pv.reasons[i]);
    if (text && !out.some((x) => x.text === text)) out.push({ code: pv.reasonCodes[i], text });
  }
  return out;
}

/**
 * 사용자 입력(예산)으로 바뀐 금액은 중립 강조(Flash neutral — 회색이 0.8초에 걸쳐 사라진다). 오름·내림(빨강·파랑)을 쓰지 않는다 —
 * 예산을 줄여 금액이 줄면 파랑으로 깜빡여 가격 하락처럼 읽히므로 (trade-16·31). 미리 보기가 처음 도착한 것은 바뀐 것이 아니라 움직이지 않는다.
 * 쉬운 보기는 문장 전체를 한 덩어리로 감싼다 (테스트가 "이 계좌로는 ○주 · ○원" 문장 하나로 찾는다).
 */
function EasyPreview({ r, pv }: { r: Recommendation; pv: RiskPreview }) {
  const reasons = reasonPairs(pv);
  return (
    <>
      <p className="pr-6 text-[16px] font-semibold tabular-nums">
        <Flash tone="neutral" value={pv.amountKrw}>
          이 계좌로는 {formatQty(pv.quantity)} · {formatKrw(pv.amountKrw)}
        </Flash>
      </p>
      <dl className="mt-1">
        <Row label="목표에 팔면">
          <span className="text-up">+{formatKrw(pv.expectedProfitKrw)}</span>
        </Row>
        <Row label="손절에 팔면">
          <span className="text-down">-{formatKrw(pv.maxLossKrw)}</span>
        </Row>
        <Row label="직전 종가">{formatPrice(pv.lastPrice, r.currency)}</Row>
      </dl>
      <AsOf at={pv.lastPriceAsOf} market={r.market} className="block text-right" />
      <p className="mt-1 text-[13px] text-sub">안전장치: {limitedByText(pv.limitedBy)}. 가격이 갑자기 크게 떨어지면 손실이 더 클 수도 있어요.</p>
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
        </div>
      )}
    </>
  );
}

function ExpertPreview({ r, pv }: { r: Recommendation; pv: RiskPreview }) {
  return (
    <>
      <p className="flex items-center gap-1.5 pr-6 text-[14px] font-semibold">
        <Icon name={pv.approved ? "check" : "ban"} className={cn("size-4", pv.approved ? "text-ok" : "text-up")} />
        {pv.approved ? "리스크 엔진 통과" : "리스크 엔진 거절"}
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
          <span className="text-up">+{formatKrw(pv.expectedProfitKrw)}</span>
        </Row>
        <Row label="손절 시 손실">
          <span className="text-down">-{formatKrw(pv.maxLossKrw)}</span>
        </Row>
        <Row label="수량을 정한 제약">{pv.limitedBy}</Row>
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

export function RecommendationPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const token = params.get("t");
  const { easy } = useViewMode();
  const { data: r, isPending, isError, error, refetch, isFetching } = useRecommendation(Number(id));
  const reveal = useRevealAfterLoading(isPending);
  const { data: quotes } = useQuotes(r ? [r.symbol] : []);
  const quote = r ? quotes?.get(r.symbol) : undefined;
  const last = quote?.price ?? null;
  const open = r?.status === "open";
  // 머리 칩은 안전장치 결과로 말한다. 실행 확인 카드의 첫 미리 보기(예산 없음)와 같은 쿼리라 요청이 늘지 않는다 (trade-04)
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
  const chip =
    !open ? (
      <RecStatusChip open={open} validUntil={r.validUntil} easy={easy} className="h-7 px-2 text-[13px]" />
    ) : live ? (
      <ReadinessChip state="live" easy={easy} className="h-7 px-2 text-[13px]" />
    ) : head.data ? (
      <ReadinessChip state={head.data.activatable ? "ready" : "blocked"} easy={easy} className="h-7 px-2 text-[13px]" />
    ) : head.isError ? (
      // 안전장치 결과를 받지 못했으면 시간 사실(기한)로 돌아간다 — 뼈대로 남으면 '불러오는 중'으로 읽힌다.
      // 오류 문장과 다시 시도는 실행 확인 카드가 맡는다 (같은 쿼리라 거기서 다시 받으면 이 칩도 바뀐다 — trade-r5)
      <RecStatusChip open={open} validUntil={r.validUntil} easy={easy} className="h-7 px-2 text-[13px]" />
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
          {easy
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
            <div className="mt-2 flex flex-wrap gap-1.5">
              <SourceBadge source={r.source} />
              {!easy && <RiskLevelBadge level={r.riskLevel} />}
            </div>
            <p className="mt-2 text-[14px] text-sub">
              {r.requestedBy ? `${r.requestedBy} ${easy ? "님이 만듦" : "신청"}` : "자동"} · {formatDateTime(r.createdAt)}
              {" · "}
              {open ? `${timeLeft(r.validUntil)} (${formatDateTime(r.validUntil)}까지)` : `${formatDateTime(r.validUntil)}에 ${easy ? "기한 지남" : "만료"}`}
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
                  <b className="text-down tabular-nums">{formatRate(r.stopLossRate, 1)}</b> <span className="text-[13px] text-mute">(비용 전)</span>
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
          <ActivateCard key={r.id} r={r} token={token} titleRef={titleRef} />
          <p className="px-1 text-[13px] text-mute">
            {easy ? `팀에서 이 계획으로 시작한 모의 자동매매 ${r.planCount}건` : `팀에서 이 추천으로 활성화한 계획 ${r.planCount}건`}
          </p>
        </div>
      </div>
    </>
  );
}
