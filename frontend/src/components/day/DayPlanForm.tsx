// 단타 계획 만들기 (docs/API.md "단타 연습"): 종목(국내) → 사는·목표·손절 가격 · 예산 → 미리 보기(POST /api/day/preview, 비용 합계)
// → 체크리스트(손절 시 손실 · 15:15 강제 정리 · 비용) → 시작(POST /api/day/plans, acknowledged: true) → 결과 카드.
// 수량과 시작 가능 여부는 서버의 리스크 엔진(DAY 한도)이 정한다. 화면의 가격·금액은 장마감 기준이다.
// 계획용 분봉은 완성된 마지막 세션(장 전·장중은 직전 세션)이다.
//
// 배치: 폼 안 순서(고르기 → 분봉 보기 → 가격 정하기 → 숫자 확인 → 동의 → 시작)는 여정 그대로다. 시작 버튼은 체크리스트 바로 아래에 둔다
// (하단 고정으로 빼지 않는다 — 체크리스트를 읽은 다음 누르게). PC(lg)는 미리 보기를 오른쪽 칸(previewSlot)에 그린다:
// 입력은 왼쪽, 입력에 반응하는 숫자는 오른쪽 — 값을 고치면서 숫자가 바뀌는 것을 같은 화면에서 본다. DOM은 늘 한 벌이다(포털).
// 만들 수 없는 시각(15:15 이후·주말·휴장일)은 '연습 모드'다: 숫자는 미리 볼 수 있고 체크리스트·시작은 막힌다.
import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { errorMessage } from "../../api/client";
import { useCreateDayPlan, useDayPreview } from "../../api/day";
import { usePlan, usePlans, useSearch, useStock } from "../../api/queries";
import type { DayPlanInput, DayPreview, DayStatus, StockDetail, TradePlanDetail } from "../../api/types";
import { revealList, useChanged, useRevealAfterLoading } from "../../hooks/useMotionState";
import { parseBudget } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatDayLabel, formatKrw, formatPrice, formatQty } from "../../lib/format";
import { DAY_COST_NOTE, DAY_EOD_NOTE, PLAN_STATUS_TEXT, REASON_TEXT, errorSentence, planStatusText, reasonSentences } from "../../lib/plainText";
import { useDebounced } from "../../lib/useDebounced";
import { Icon } from "../Icon";
import { Term } from "../Term";
import { AsOf, ErrorState, Notice, PriceChange, Row, Skeleton, Spinner } from "../ui";
import { USAGE_TEXT, formatPriceInput, hm, parsePrice, pctFrom, revealIntoView, usageLevel } from "./dayUtil";
import type { MinuteChartLine } from "./MinuteChart";
import { MinuteChartPanel } from "./MinuteChartPanel";

interface Picked {
  symbol: string;
  name?: string;
}

const inputCls =
  "h-12 w-full rounded-xl bg-fill px-3.5 text-[16px] tabular-nums outline-none placeholder:text-mute-weak focus:ring-2 focus:ring-brand aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-up";

const isPrice = (n: number | null): n is number => n !== null && !Number.isNaN(n);

/** 검색 결과 (국내만 고를 수 있다). 검색어를 고치는 동안 이전 결과를 흐리게 남긴다 — 목록이 스켈레톤으로 바뀌며 출렁이지 않게. */
function StockResults({ q, onPick }: { q: string; onPick: (p: Picked) => void }) {
  const search = useSearch(q, { keepPrevious: true });
  const reveal = useRevealAfterLoading(search.isPending);
  const all = search.data?.results ?? [];
  const results = all.filter((r) => r.market === "KR").slice(0, 8);
  const stale = search.isPlaceholderData;
  return (
    <ul
      aria-label="종목 검색 결과"
      aria-busy={stale || undefined}
      {...revealList(reveal)}
      className={cn("mt-2 divide-y divide-line overflow-hidden rounded-xl border border-line transition-opacity duration-fast", stale && "opacity-60")}
    >
      {search.isPending ? (
        <li className="px-3.5 py-3">
          <Skeleton className="h-4 w-1/2" />
        </li>
      ) : search.isError ? (
        <li className="px-3.5 py-2">
          <ErrorState compact message={errorMessage(search.error)} onRetry={() => void search.refetch()} retrying={search.isFetching} />
        </li>
      ) : results.length === 0 ? (
        <li className="px-3.5 py-3 text-[14px] text-mute">{all.length ? "단타 연습은 국내 종목만 돼요." : `"${q}"에 맞는 국내 종목이 없어요.`}</li>
      ) : (
        results.map((r) => (
          <li key={r.symbol}>
            <button
              type="button"
              onClick={() => onPick({ symbol: r.symbol, name: r.name })}
              className="press-row flex min-h-12 w-full items-center justify-between gap-2 px-3.5 py-2 text-left hover:bg-fill/60"
            >
              <span className="truncate text-[15px] font-semibold">{r.name}</span>
              <span className="shrink-0 text-[13px] text-mute">
                {r.symbol} · {r.exchange}
              </span>
            </button>
          </li>
        ))
      )}
    </ul>
  );
}

/** 종목 찾기. autoFocus: '바꾸기'·'다른 종목으로 새 계획' 뒤에만 (처음 열 때는 화면 제목이 포커스를 받는다 — 휴대폰 키패드가 바로 뜨지 않게). */
function StockPicker({ onPick, autoFocus }: { onPick: (p: Picked) => void; autoFocus: boolean }) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  return (
    <div>
      <label htmlFor="day-stock" className="block text-[15px] font-semibold">
        종목 (국내만)
      </label>
      <input
        id="day-stock"
        type="search"
        autoFocus={autoFocus}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="종목명·코드 (예: NAVER, 035420)" // '종목명이나 종목코드 …'는 360·390px·PC 좁은 칸에서 끝이 잘렸다
        className={cn(inputCls, "mt-1.5")}
      />
      {q && <StockResults q={q} onPick={onPick} />}
    </div>
  );
}

/** 고른 종목: 이름 · 직전 종가(장마감 기준) · 바꾸기. 고른 직후 이름 줄이 포커스를 받는다 (키패드를 띄우지 않고 다음 단계인 분봉을 먼저 보게). */
function PickedStock({
  symbol,
  stock: s,
  fallbackName,
  autoFocus,
  onClear,
}: {
  symbol: string;
  stock: StockDetail | undefined;
  fallbackName?: string;
  autoFocus: boolean;
  onClear: () => void;
}) {
  const name = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (autoFocus) name.current?.focus({ preventScroll: true });
  }, [autoFocus]);
  return (
    <div role="group" aria-labelledby="day-picked-name" className="flex items-start justify-between gap-3 rounded-xl bg-fill px-3.5 py-3">
      <div className="min-w-0">
        <p id="day-picked-name" ref={name} tabIndex={-1} className="flex flex-wrap items-baseline gap-x-2 outline-none">
          <span className="truncate text-[16px] font-bold">{s?.name ?? fallbackName ?? symbol}</span>
          <span className="text-[13px] text-mute">{symbol}</span>
        </p>
        {s && (
          <>
            <p className="mt-0.5 text-[14px] tabular-nums">
              <Term k="종가">직전 종가</Term> {formatPrice(s.quote.price, s.currency)}{" "}
              <PriceChange change={s.quote.change} rate={s.quote.changeRate} currency={s.currency} className="text-[13px]" />
            </p>
            <AsOf at={s.quote.asOf ?? s.asOf} market={s.market} />
          </>
        )}
      </div>
      {/* 연한 상자 안의 버튼은 thumb(다크에서 상자보다 밝게) — card를 쓰면 다크에서 눌려 들어간 모양이 된다 */}
      <button type="button" onClick={onClear} className="press h-11 shrink-0 rounded-lg bg-thumb px-3.5 text-[14px] font-semibold text-sub hover:bg-line">
        바꾸기
      </button>
    </div>
  );
}

/**
 * 미리 보기 결과. 머리는 결론(지금 시작할 수 있는가)이 먼저이고, 리스크 엔진 판정은 둘째 줄로 내린다 —
 * 사용자는 첫 신호로 판단하므로 시작할 수 없는데 초록 '통과'가 먼저 보이면 안 된다.
 * panel: PC 오른쪽 칸에 따로 놓일 때(카드 모양). 아니면 폼 안의 테두리 상자.
 */
function DayPreviewCard({
  pv,
  settling,
  easy,
  panel,
  reveal,
  name,
  existingPlanId,
}: {
  pv: DayPreview;
  settling: boolean;
  easy: boolean;
  panel: boolean;
  reveal: boolean;
  name?: string;
  existingPlanId: number | null;
}) {
  // 같은 뜻의 두 사유(진행 중 계획·진행 중 주문)가 같이 오면 계획 쪽 하나만 (계획 보기 링크가 붙는 쪽)
  const keep = pv.reasonCodes.map((_, i) => i).filter((i) => !(pv.reasonCodes.includes("plan_exists") && pv.reasonCodes[i] === "position_exists"));
  const reasons = reasonSentences(
    keep.map((i) => pv.reasonCodes[i]),
    keep.map((i) => pv.reasons[i]),
  );
  const ok = pv.activatable;
  const verdict = pv.approved ? (easy ? "안전장치 통과" : "리스크 엔진 통과") : easy ? "안전장치가 막았어요" : "리스크 엔진 거절";
  const closed = pv.reasonCodes.includes("day_entry_closed") || !pv.session.acceptingPlans;
  const cost = (c: DayPreview["costsAtTarget"]) => `수수료 ${formatKrw(c.commissionKrw)} · 거래세 ${formatKrw(c.taxKrw)}`;
  return (
    <section
      aria-label="단타 미리 보기"
      aria-busy={settling}
      className={cn(
        "transition-opacity duration-fast",
        panel ? "rounded-2xl bg-card p-5" : "rounded-xl border border-line p-3.5",
        settling && "opacity-60",
        reveal && "reveal-fade",
      )}
    >
      {panel && <p className="mb-2 text-[13px] font-semibold text-mute">미리 보기{name ? ` · ${name}` : ""}</p>}
      <div className="flex items-start gap-1.5">
        <Icon name={ok ? "check-circle" : "ban"} className={cn("mt-0.5 size-4 shrink-0", ok ? "text-ok" : "text-up")} />
        <div className="min-w-0 flex-1">
          <p className={cn("text-[14px] font-semibold", !ok && "text-up-ink")}>
            {ok ? "시작할 수 있어요" : `지금은 시작할 수 없어요 (사유 ${reasons.length}개)`}
          </p>
          <p className="mt-0.5 text-[12px] text-mute">
            {verdict}
            {closed && ` · ${formatDayLabel(pv.session.date)} 0시부터 만들 수 있어요`}
          </p>
        </div>
        {/* 다시 계산하는 동안: 제목 줄 오른쪽 작은 스피너 + 흐림. 줄을 더하지 않아 아래 체크리스트가 움직이지 않는다 */}
        {settling && <Spinner className="ml-auto text-mute-weak" />}
      </div>
      <dl className="mt-2">
        <Row label="안전장치가 정한 수량">{formatQty(pv.quantity)}</Row>
        <Row label="사는 금액">{formatKrw(pv.amountKrw)}</Row>
        <Row label="목표 가격에 팔면">
          <span className="text-up">+{formatKrw(pv.expectedProfitKrw)}</span>
        </Row>
        <Row label="손절 가격에 팔면">
          <span className="text-down">-{formatKrw(pv.maxLossKrw)}</span>
        </Row>
        <Row label="수량을 정한 기준">{pv.limitedBy}</Row>
        <Row label="직전 종가">{formatKrw(pv.lastPrice)}</Row>
      </dl>
      <div className="text-right">
        <AsOf at={pv.lastPriceAsOf} />
      </div>
      <p className="mt-1 text-[12px] leading-snug text-mute">금액은 비용(수수료·거래세)을 뺀 값이에요. 손실은 가격이 갑자기 움직이면 더 클 수도 있어요.</p>

      <div aria-label="비용 합계" role="group" className="mt-3 rounded-lg bg-warn-soft p-3">
        <p className="text-[14px] font-semibold text-warn-ink">{DAY_COST_NOTE}</p>
        <dl className="mt-1">
          <Row label="목표 가격에 팔 때 비용">{formatKrw(pv.costsAtTarget.totalKrw)}</Row>
        </dl>
        <p className="text-right text-[12px] text-mute tabular-nums">{cost(pv.costsAtTarget)}</p>
        <dl>
          <Row label="손절 가격에 팔 때 비용">{formatKrw(pv.costsAtStop.totalKrw)}</Row>
        </dl>
        <p className="text-right text-[12px] text-mute tabular-nums">{cost(pv.costsAtStop)}</p>
      </div>

      {reasons.length > 0 && (
        <div role="alert" className="mt-3 rounded-lg bg-up-soft/70 p-3">
          <p className="text-[13px] font-semibold text-up-ink">시작할 수 없는 사유</p>
          <ul aria-label="시작할 수 없는 사유" className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
            {reasons.map((x) => (
              <li key={x}>
                {x}
                {/* 막힌 이유와 함께 갈 곳을 준다 (같은 종목은 계획 하나만 — 막다른 길이 되지 않게) */}
                {x === REASON_TEXT.plan_exists && (
                  <Link
                    to={existingPlanId ? `/plans/${existingPlanId}` : "/plans"}
                    className="ml-1 inline-flex items-center font-semibold whitespace-nowrap text-brand-ink underline-offset-2 hover:underline"
                  >
                    진행 중인 계획 보기
                    <Icon name="chevron" className="size-3.5" />
                  </Link>
                )}
              </li>
            ))}
          </ul>
          {!easy && pv.reasons.length > 0 && <p className="mt-1.5 text-[12px] text-mute">원문: {pv.reasons.join(" · ")}</p>}
        </div>
      )}
    </section>
  );
}

/** 미리 보기를 처음 기다리는 동안의 자리 (실제 카드와 비슷한 높이 — 내용이 오면 높이가 덜 바뀌게). */
function PreviewSkeleton({ panel }: { panel: boolean }) {
  return (
    <div
      aria-busy="true"
      aria-label="미리 보기 불러오는 중"
      className={cn("space-y-3", panel ? "rounded-2xl bg-card p-5" : "rounded-xl border border-line p-3.5")}
    >
      <Skeleton className="h-4 w-1/2" />
      {Array.from({ length: 6 }, (_, i) => (
        <Skeleton key={i} className="h-4 w-full" />
      ))}
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

const NONE = [false, false, false];

/**
 * 시작 전 확인 셋을 모두 켜야 시작한다 (서버도 acknowledged: true를 요구한다 — '본 숫자에 대한 동의').
 * - ackKey(입력 + 보여 준 숫자)가 바뀌면 처음부터 다시 켠다. 창 포커스로 다시 받아 숫자가 같으면 그대로 둔다.
 * - 숫자를 다시 계산하는 동안·시작할 수 없는 사유가 있는 동안은 켤 수 없다. 상태 문장 줄은 높이를 고정해 체크박스가 움직이지 않게 한다.
 * - 시작에 실패한 오류는 그 시도의 ackKey인 동안만 보인다 (sent): 입력을 고쳐 새 숫자가 오면 지운다 — 남겨 두면 고친 값까지 틀린 것처럼 읽혔다.
 *   mutation.reset()으로 지우지 않는다: 보내는 중에 부르면 mutate의 onSuccess가 불리지 않아, 계획은 만들어졌는데 결과 카드가 뜨지 않는다.
 */
function DayChecklist({
  input,
  pv,
  ackKey,
  settling,
  accepting,
  closedNow,
  onCreated,
}: {
  input: DayPlanInput;
  pv: DayPreview;
  ackKey: string;
  settling: boolean;
  accepting: boolean;
  closedNow: boolean;
  onCreated: (plan: TradePlanDetail) => void;
}) {
  const [ack, setAck] = useState({ key: ackKey, checks: NONE, cleared: false, sent: false });
  // 렌더 중 조건부 파생 상태: 숫자가 바뀌면 체크와 지난 시도(sent)를 지우고, 켜 둔 것이 있었으면 '다시 확인해요'를 남긴다
  if (ack.key !== ackKey) setAck({ key: ackKey, checks: NONE, cleared: ack.cleared || ack.checks.some(Boolean), sent: false });
  const current = ack.key === ackKey;
  const checks = current ? ack.checks : NONE;
  const create = useCreateDayPlan();
  const busy = create.isPending;
  const blocked = !pv.activatable || !accepting;
  const canCheck = !blocked && !settling && !busy;
  const can = canCheck && checks.every(Boolean);
  const items = [
    `손절 가격(${formatKrw(input.stopPrice)})에 닿으면 약 ${formatKrw(pv.maxLossKrw)} 손실이 나요. 가격이 갑자기 움직이면 더 클 수도 있어요`,
    DAY_EOD_NOTE,
    `수수료·거래세가 목표 가격에 팔면 ${formatKrw(pv.costsAtTarget.totalKrw)}, 손절 가격에 팔면 ${formatKrw(pv.costsAtStop.totalKrw)} 들어요`,
  ];
  const state = settling ? (
    <span className="flex items-center gap-1.5 text-mute">
      <Spinner className="size-3.5" />
      숫자를 다시 계산하는 중…
    </span>
  ) : blocked ? (
    <span className="text-mute">사유가 있어 지금은 확인하지 않아도 돼요</span>
  ) : ack.cleared ? (
    <span className="reveal-fade font-semibold text-warn-ink">숫자가 바뀌어 다시 확인해요</span>
  ) : checks.every(Boolean) ? (
    <span className="text-sub">모두 확인했어요</span>
  ) : (
    <span className="text-mute">미리 보기 숫자를 읽었으면 하나씩 켜요</span>
  );

  return (
    <div className="mt-3">
      <fieldset disabled={!canCheck} className="rounded-xl border border-line p-3.5 pt-2.5">
        <legend className="px-1 text-[14px] font-semibold">시작 전 확인 (셋 다 켜야 시작해요)</legend>
        <p className="min-h-5 px-1 text-[13px] leading-5">{state}</p>
        <div className="mt-1 space-y-1">
          {items.map((text, i) => (
            <label
              key={i}
              className="-mx-1 flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-[14px] leading-snug transition-[background-color,opacity] duration-fast has-checked:bg-brand-soft has-disabled:cursor-not-allowed has-disabled:opacity-70 has-[:enabled:not(:checked)]:hover:bg-fill/60"
            >
              <input
                type="checkbox"
                checked={checks[i]}
                disabled={!canCheck} // fieldset도 막지만 칸에도 둔다 (상태가 칸 자체에 드러나게)
                onChange={(e) => setAck((cur) => ({ ...cur, checks: cur.checks.map((v, j) => (j === i ? e.target.checked : v)), cleared: false }))}
                className="mt-0.5 size-5 shrink-0 accent-brand"
              />
              <span>{text}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {/* 보내는 동안은 disabled 대신 aria-disabled: 누른 버튼에 포커스가 남는다 (막으면 포커스가 body로 빠져, 실패했을 때 제자리를 잃는다) */}
      <button
        type="button"
        disabled={!can && !busy}
        aria-disabled={busy || undefined}
        aria-busy={busy || undefined}
        onClick={() => {
          if (busy) return;
          setAck((cur) => ({ ...cur, sent: true }));
          create.mutate({ ...input, acknowledged: true }, { onSuccess: onCreated });
        }}
        className="press mt-3 flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
      >
        {busy && <Spinner />}
        모의 단타 계획 시작
      </button>
      <p className="mt-1.5 text-[12px] text-mute">AI 아님 · 내가 정한 가격으로 모의 계좌에서만 주문해요.</p>
      {closedNow && <p className="reveal-fade mt-1 text-[13px] font-semibold text-up-ink">15:15가 지나 오늘은 더 시작할 수 없어요.</p>}
      {create.isError && current && ack.sent && (
        <Notice tone="error" className="mt-3">
          {errorSentence(create.error)}
        </Notice>
      )}
    </div>
  );
}

/** 고른 종목으로 계획을 짜는 부분. 종목을 바꾸면 새로 마운트된다(key) — 가격 칸이 함께 비워진다. */
function PlanEditor({
  picked,
  status,
  easy,
  focusName,
  previewSlot,
  onClear,
  onCreated,
}: {
  picked: Picked;
  status: DayStatus;
  easy: boolean;
  focusName: boolean;
  previewSlot: HTMLElement | null;
  onClear: () => void;
  onCreated: (plan: TradePlanDetail) => void;
}) {
  const accepting = status.session.acceptingPlans;
  const stock = useStock(picked.symbol);
  const s = stock.data;
  const notKr = s !== undefined && s.market !== "KR";
  // 같은 종목에 진행 중인 계획(스윙 포함)이 있으면 가격을 넣기 전에 알린다 — 다 넣은 뒤 막히면 늦다
  const existing = usePlans("active").data?.results.find((p) => p.symbol === picked.symbol) ?? null;

  const [entryRaw, setEntryRaw] = useState("");
  const [targetRaw, setTargetRaw] = useState("");
  const [stopRaw, setStopRaw] = useState("");
  const [budgetRaw, setBudgetRaw] = useState("");
  // 가격 칸을 고친 횟수 — 입력이 멈췄는지를 값이 아니라 횟수로 잰다 (2 → 203000 → 2처럼 같은 값으로 돌아와도 새로 센다)
  const [edits, setEdits] = useState(0);
  const [leftEdits, setLeftEdits] = useState<number | null>(null);

  const entry = parsePrice(entryRaw);
  const target = parsePrice(targetRaw);
  const stop = parsePrice(stopRaw);
  const budget = parseBudget(budgetRaw);
  const bad = (n: number | null) => n !== null && Number.isNaN(n);
  const priceError =
    bad(entry) || bad(target) || bad(stop)
      ? "가격은 0보다 큰 숫자로 적어 주세요."
      : entry && target && stop && !(stop < entry && entry < target)
        ? "손절 가격 < 사는 가격 < 목표 가격 순서로 적어 주세요."
        : null;
  // 쓰는 도중의 오류는 보이지 않는다 (목표가를 고쳐 쓰는 중에 빨간 테두리가 깜빡이지 않게): 가격 입력이 400ms 멈추거나 칸을 떠난 뒤에만.
  // 기다림은 오류 문장이 아니라 고친 횟수로 잰다 — 같은 문장이 이어져도(2 → 20 → 2050) 글자마다 새로 센다.
  // 한 번 보인 오류는 같은 오류인 동안 고쳐 쓰는 중에도 남긴다 (글자마다 나타났다 사라지지 않게)
  const pausedEdits = useDebounced(edits, 400);
  const settledPrices = pausedEdits === edits || leftEdits === edits;
  const [stuckError, setStuckError] = useState<string | null>(null);
  // 렌더 중 파생 상태: 값이 멈췄을 때의 오류를 기억하고, 고치면(오류 없음) 바로 잊는다
  if ((settledPrices || priceError === null) && stuckError !== priceError) setStuckError(priceError);
  const shownError = priceError !== null && (settledPrices || priceError === stuckError) ? priceError : null;
  const input: DayPlanInput | null =
    !notKr && entry && target && stop && !priceError && !budget.error
      ? { symbol: picked.symbol, entryPrice: entry, targetPrice: target, stopPrice: stop, ...(budget.value !== null ? { budgetKrw: budget.value } : {}) }
      : null;
  // 입력이 멈춘 뒤에만 미리 보기를 부른다 (값이 같으면 같은 키)
  const inputKey = input ? JSON.stringify(input) : "";
  const settledKey = useDebounced(inputKey, 400);
  const settledInput = useMemo(() => (settledKey ? (JSON.parse(settledKey) as DayPlanInput) : null), [settledKey]);
  const preview = useDayPreview(settledInput);
  // 마지막으로 맞았던 입력 (렌더 중 파생 상태)
  const [lastKey, setLastKey] = useState("");
  if (inputKey && inputKey !== lastKey) setLastKey(inputKey);
  const lastInput = useMemo(() => (lastKey ? (JSON.parse(lastKey) as DayPlanInput) : null), [lastKey]);
  // 가격을 고쳐 쓰는 도중(입력이 멈추기 전, 값이 잠깐 비거나 틀린 동안)에는 마지막으로 맞았던 입력의 미리 보기·확인을 흐리게 남긴다 —
  // 글자마다 카드가 사라졌다 나타나 화면이 출렁이지 않게. 입력이 멈췄는데도 비었거나 틀렸으면(오류가 보이면) 그때 내린다
  const holding = input === null && !settledPrices && !shownError;
  const shownInput = input ?? (holding ? lastInput : null);
  // 남긴 동안도 '다시 계산하는 중'이라 확인·시작이 막힌다 — 시작에 보내는 값은 늘 지금 입력이다
  const settling = settledKey !== inputKey || preview.isFetching || holding;
  const revealPreview = useRevealAfterLoading(preview.isPending);

  // 보는 중에 15:15가 지나면(세션 상태는 30초마다 다시 받는다) 미리 보기도 다시 받아 day_entry_closed를 버튼·사유에 같이 반영한다
  const qc = useQueryClient();
  const [seenAccepting, setSeenAccepting] = useState(accepting);
  const [closedNow, setClosedNow] = useState(false);
  if (seenAccepting !== accepting) {
    setSeenAccepting(accepting);
    setClosedNow(!accepting);
  }
  useEffect(() => {
    if (closedNow) void qc.invalidateQueries({ queryKey: ["day", "preview"] });
  }, [closedNow, qc]);

  const lines: MinuteChartLine[] = [];
  if (isPrice(entry)) lines.push({ price: entry, kind: "entry" });
  if (isPrice(target)) lines.push({ price: target, kind: "target" });
  if (isPrice(stop)) lines.push({ price: stop, kind: "stop" });
  // 차트의 가격 선은 입력이 멈춘 뒤에 옮긴다 — 고쳐 쓰는 도중의 값(2, 20, 2050…)이 축 범위에 들어가 차트가 글자마다 납작해지지 않게
  const chartLinesKey = useDebounced(JSON.stringify(lines), 400);
  const chartLines = JSON.parse(chartLinesKey) as MinuteChartLine[];

  // 칸 아래 도움말: 처음에는 방향(높게·낮게), 값을 넣으면 기준 대비 % (자릿수 실수를 바로 알아채게)
  const last = s?.quote.price ?? null;
  const entryPct = isPrice(entry) ? pctFrom(last, entry) : null;
  const targetPct = isPrice(entry) && isPrice(target) ? pctFrom(entry, target) : null;
  const stopPct = isPrice(entry) && isPrice(stop) ? pctFrom(entry, stop) : null;

  const field = (id: string, label: string, value: string, set: (v: string) => void, help: string, placeholder?: string) => (
    <div>
      <label htmlFor={id} className="block text-[15px] font-semibold">
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={value}
          onChange={(e) => {
            set(e.target.value);
            setEdits((n) => n + 1);
          }}
          onBlur={() => {
            set(formatPriceInput(value)); // 쉼표만 넣는다 — 읽은 값은 같아서 고친 횟수로 세지 않는다
            setLeftEdits(edits);
          }}
          aria-invalid={shownError && value ? true : undefined}
          aria-describedby={cn(`${id}-help`, shownError && "day-price-error") || undefined}
          placeholder={placeholder}
          className={cn(inputCls, "pr-10")}
        />
        <span aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-3.5 flex items-center text-[15px] text-mute">
          원
        </span>
      </div>
      <p id={`${id}-help`} className="mt-1 text-[12px] text-mute tabular-nums">
        {help}
      </p>
    </div>
  );

  const panel = previewSlot !== null;
  let previewArea: ReactNode = null;
  if (shownInput) {
    previewArea = preview.isError ? (
      <Notice tone="error">{errorSentence(preview.error)}</Notice>
    ) : !preview.data ? (
      <PreviewSkeleton panel={panel} />
    ) : (
      <DayPreviewCard
        pv={preview.data}
        settling={settling}
        easy={easy}
        panel={panel}
        reveal={revealPreview}
        name={s?.name ?? picked.name}
        existingPlanId={existing?.id ?? null}
      />
    );
  } else if (panel && !notKr) {
    // PC 오른쪽 칸: 결과가 어디에 나올지 미리 알려 둔다
    previewArea = (
      <div className="rounded-2xl border-2 border-dashed border-line p-5 text-[14px] leading-relaxed text-mute">
        사는·목표·손절 가격을 넣으면 여기에서 수량·금액·비용을 바로 계산해요.
      </div>
    );
  }
  const pv = shownInput && !preview.isError ? preview.data : undefined;

  return (
    <div className="space-y-4">
      <PickedStock symbol={picked.symbol} stock={s} fallbackName={picked.name} autoFocus={focusName} onClear={onClear} />
      {notKr ? (
        <Notice tone="warn">
          <p>단타 연습은 국내 종목만 돼요.</p>
          <button type="button" onClick={onClear} className="mt-1 inline-flex min-h-11 items-center font-semibold underline underline-offset-2">
            다른 종목 고르기
          </button>
        </Notice>
      ) : (
        <>
          {existing && (
            <Notice tone="warn">
              <p>이 종목은 진행 중인 계획이 있어요. 한 종목은 계획 하나만 진행해요 (숫자는 미리 볼 수 있어요).</p>
              <Link to={`/plans/${existing.id}`} className="mt-1 inline-flex min-h-11 items-center gap-0.5 font-semibold underline-offset-2 hover:underline">
                진행 중인 계획 보기 · {planStatusText(existing.status, easy)}
                <Icon name="chevron" className="size-4" />
              </Link>
            </Notice>
          )}
          <MinuteChartPanel symbol={picked.symbol} name={picked.name} title="계획용 분봉 (직전 세션)" lines={chartLines} />
          {/* 세 칸은 이 묶음의 폭이 넉넉할 때만 한 줄에 (화면 폭이 아니라 묶음 폭으로 고른다 — PC 2단의 좁은 왼쪽 칸(1024~1100px)에서는
              칸이 91px로 줄어 '191,000'이 '원' 앞에서 잘렸다. 7자리 가격까지 들어가는 폭이 28rem) */}
          <div className="@container">
            <div className="grid gap-3 @md:grid-cols-3">
              {field(
                "day-entry",
                "사는 가격",
                entryRaw,
                setEntryRaw,
                entryPct ? `지정가 · 직전 종가보다 ${entryPct}` : "지정가로 주문해요",
                last ? `예: ${last.toLocaleString("ko-KR")}` : undefined,
              )}
              {field("day-target", "목표 가격", targetRaw, setTargetRaw, targetPct ? `사는 가격보다 ${targetPct}` : "사는 가격보다 높게")}
              {field("day-stop", "손절 가격", stopRaw, setStopRaw, stopPct ? `사는 가격보다 ${stopPct}` : "사는 가격보다 낮게")}
            </div>
          </div>
          {shownError && (
            <p id="day-price-error" role="alert" className="reveal-fade text-[13px] text-up-ink">
              {shownError}
            </p>
          )}
          <div>
            <label htmlFor="day-budget" className="block text-[15px] font-semibold">
              예산 (원, 선택)
            </label>
            <input
              id="day-budget"
              inputMode="numeric"
              autoComplete="off"
              value={budgetRaw}
              onChange={(e) => setBudgetRaw(e.target.value)}
              onBlur={() => setBudgetRaw(formatPriceInput(budgetRaw))}
              aria-invalid={budget.error ? true : undefined}
              aria-describedby="day-budget-help"
              placeholder="비우면 안전장치가 정한 수량"
              className={cn(inputCls, "mt-1.5")}
            />
            <p id="day-budget-help" className={cn("mt-1 text-[12px]", budget.error ? "text-up-ink" : "text-mute")}>
              {budget.error ?? "예산을 주면 수량을 그만큼 줄여요 (늘리지는 않아요)."}
            </p>
          </div>
          {panel ? previewSlot && createPortal(previewArea, previewSlot) : previewArea}
          {shownInput && pv && (
            <DayChecklist
              input={shownInput}
              pv={pv}
              // 동의는 '본 숫자로 지금 시작'에 대한 것이라, 숫자나 시작 가능 여부(15:15 등)가 바뀌면 처음부터 다시 켠다
              ackKey={`${inputKey}|${pv.quantity}|${pv.maxLossKrw}|${pv.costsAtTarget.totalKrw}|${pv.costsAtStop.totalKrw}|${pv.activatable && accepting}`}
              settling={settling}
              accepting={accepting}
              closedNow={closedNow}
              onCreated={onCreated}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * 시작한 뒤: 폼 본문을 결과 카드 하나로 바꾼다 — '됐다, 어디서 보나, 다음은 뭘 하나'를 같은 자리에서.
 * 같은 종목은 계획 하나만이라 입력 칸을 남기지 않는다. 제목에 포커스를 주고, 화면 밖이면 보이는 곳으로 옮긴다.
 * 옮기기는 그리기 전에 바로 한다: 폼이 줄면 화면이 페이지 바닥으로 튄 뒤 부드럽게 되돌아오는 두 번 움직임이 보였다 (실측) —
 * 첫 프레임부터 결과 카드가 보이고, 카드는 제자리에서 페이드로 나타난다.
 * 상태는 만든 순간의 응답이 아니라 지금 계획을 그린다 (usePlan — 진행 중이면 5초마다, 끝나면 멈춘다. 만들 때 캐시에 넣어 두어 첫 렌더부터 있다):
 * 장중에는 몇 초 안에 체결·청산되는데, 응답에 멈춰 있으면 '체결 대기'로 남아 바로 아래 오늘 계획 줄('청산 완료')과 반대로 말했다.
 */
function CreatedCard({ plan: made, easy, onAnother }: { plan: TradePlanDetail; easy: boolean; onAnother: () => void }) {
  const plan = usePlan(made.id).data ?? made;
  const box = useRef<HTMLDivElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    title.current?.focus({ preventScroll: true });
    revealIntoView(box.current, "nearest", false);
  }, []);
  const failed = plan.status === "failed";
  return (
    <div ref={box} className="reveal-fade scroll-mt-20">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className={cn("grid size-10 shrink-0 place-items-center rounded-full", failed ? "bg-up-soft text-up" : "bg-ok-soft text-ok")}>
          <Icon name={failed ? "alert-circle" : "check-circle"} className="size-6" />
        </span>
        <div className="min-w-0">
          <h3 ref={title} tabIndex={-1} className="text-[17px] font-bold leading-snug outline-none">
            {failed ? "모의 주문을 넣지 못해 계획이 멈췄어요" : `${plan.name} 모의 단타 계획을 시작했어요`}
          </h3>
          <p className="mt-1 text-[14px] text-sub tabular-nums">
            {failed
              ? `${plan.name} · ${easy || !plan.failureReason ? PLAN_STATUS_TEXT.failed.line : plan.failureReason}`
              : `${formatQty(plan.quantity)} · 사는 ${formatKrw(plan.entryPrice)}(지정가) · ${planStatusText(plan.status, easy)}`}
          </p>
          {!failed && <p className="mt-0.5 text-[13px] text-mute">{DAY_EOD_NOTE}.</p>}
        </div>
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2">
        <Link
          to={`/plans/${plan.id}`}
          className="press flex h-12 items-center justify-center rounded-xl bg-brand text-[15px] font-bold text-white hover:bg-brand-dark"
        >
          {failed ? "계획 보기" : "진행 보기"}
        </Link>
        <button type="button" onClick={onAnother} className="press flex h-12 items-center justify-center rounded-xl bg-fill text-[15px] font-semibold text-sub hover:bg-line">
          다른 종목으로 새 계획
        </button>
      </div>
    </div>
  );
}

export interface DayPlanFormProps {
  /** 세션·한도·오늘 쓴 양 (머리 배지·모바일 한 줄 요약). */
  status: DayStatus;
  easy?: boolean;
  /** 처음 고를 종목 (?symbol=). */
  initialSymbol?: string | null;
  /** 계획을 만들면 (201 — status가 failed일 수도 있다). */
  onCreated?: (plan: TradePlanDetail) => void;
  /** PC(lg)에서 미리 보기를 그릴 오른쪽 칸. null이면 폼 안에 그린다 (모바일·테스트). */
  previewSlot?: HTMLElement | null;
  className?: string;
}

export function DayPlanForm({ status, easy = false, initialSymbol = null, onCreated, previewSlot = null, className }: DayPlanFormProps) {
  const { session, limits, today } = status;
  const accepting = session.acceptingPlans;
  const [picked, setPicked] = useState<Picked | null>(initialSymbol ? { symbol: initialSymbol } : null);
  const [created, setCreated] = useState<TradePlanDetail | null>(null);
  // 사용자가 단계를 옮긴 뒤에만 포커스를 옮긴다 (처음 열 때는 화면 제목이 받는다)
  const [focus, setFocus] = useState<"search" | "picked" | null>(null);
  // 단계가 바뀔 때(고르기 ↔ 계획 ↔ 결과)만 새 내용이 페이드로 나타난다. 처음 그린 화면은 움직이지 않는다
  const stepChanged = useChanged(created ? `done:${created.id}` : (picked?.symbol ?? ""));
  const orders = usageLevel(today.orders, limits.maxDailyTrades);
  const loss = usageLevel(today.lossKrw, today.lossLimitKrw);
  const badge = !accepting
    ? { text: "연습 모드", cls: "bg-fill text-sub" }
    : orders === "full" || loss === "full"
      ? { text: "오늘 한도를 다 썼어요", cls: "bg-up-soft text-up-ink" }
      : null;

  return (
    <section aria-labelledby="day-form-title" className={cn("rounded-2xl bg-card p-5", className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 id="day-form-title" className="text-[17px] font-bold">
          단타 계획 만들기
        </h2>
        {badge && <span className={cn("inline-flex h-6 items-center rounded-md px-2 text-[12px] font-bold", badge.cls)}>{badge.text}</span>}
      </div>
      <p className="mt-1 text-[13px] leading-snug text-sub">
        {accepting
          ? "사는·목표·손절 가격은 내가 정하고, 수량과 시작할 수 있는지는 안전장치(리스크 엔진)가 정해요."
          : `지금은 연습 모드예요 — 숫자만 미리 볼 수 있고 ${formatDayLabel(session.date)} 0시부터 시작할 수 있어요.`}
      </p>
      {/* 모바일: 실행의 전제(마감·남은 한도)를 입력보다 먼저. PC는 오른쪽 상태 카드가 같은 일을 한다 */}
      {accepting && (
        <dl className="mt-3 grid grid-cols-3 rounded-xl bg-fill py-2.5 text-center lg:hidden">
          <div className="px-1">
            <dt className="text-[12px] text-mute">진입 마감</dt>
            <dd className="mt-0.5 text-[14px] font-bold tabular-nums">오늘 {hm(session.entryCutoffAt)}</dd>
          </div>
          <div className="border-x border-line px-1">
            <dt className="text-[12px] text-mute">단타 주문</dt>
            <dd className={cn("mt-0.5 text-[14px] font-bold tabular-nums", USAGE_TEXT[orders])}>
              {today.orders} / {limits.maxDailyTrades}건
            </dd>
          </div>
          <div className="px-1">
            <dt className="text-[12px] text-mute">확정 손실</dt>
            <dd className={cn("mt-0.5 text-[14px] font-bold tabular-nums", USAGE_TEXT[loss])}>{formatKrw(today.lossKrw)}</dd>
            <dd className="text-[11px] text-mute tabular-nums">한도 {formatKrw(today.lossLimitKrw)}</dd>
          </div>
        </dl>
      )}

      <div className="mt-4">
        {created ? (
          <CreatedCard
            key={`done:${created.id}`}
            plan={created}
            easy={easy}
            onAnother={() => {
              setCreated(null);
              setFocus("search");
            }}
          />
        ) : picked ? (
          <div key={picked.symbol} className={stepChanged ? "reveal-fade" : undefined}>
            <PlanEditor
              picked={picked}
              status={status}
              easy={easy}
              focusName={focus === "picked"}
              previewSlot={previewSlot}
              onClear={() => {
                setPicked(null);
                setFocus("search");
              }}
              onCreated={(plan) => {
                setCreated(plan);
                setPicked(null);
                setFocus(null);
                onCreated?.(plan);
              }}
            />
          </div>
        ) : (
          <div key="pick" className={stepChanged ? "reveal-fade" : undefined}>
            <StockPicker
              autoFocus={focus === "search"}
              onPick={(p) => {
                setPicked(p);
                setFocus("picked");
              }}
            />
          </div>
        )}
      </div>
    </section>
  );
}
