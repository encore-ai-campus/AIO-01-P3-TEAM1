// 단타 계획 만들기 (docs/API.md "단타 연습"): 종목(국내) → 사는·목표·손절 가격 · 예산 → 미리 보기(POST /api/day/preview, 비용 합계)
// → 체크리스트(손절 시 손실 · 15:15 강제 정리 · 비용) → 시작(POST /api/day/plans, acknowledged: true).
// 수량과 시작 가능 여부는 서버의 리스크 엔진(DAY 한도)이 정한다. 화면의 가격·금액은 장마감 기준이다.
// 계획용 분봉은 완성된 마지막 세션(장 전·장중은 직전 세션)이다.
import { useMemo, useState } from "react";
import { useCreateDayPlan, useDayPreview } from "../../api/day";
import { useSearch, useStock } from "../../api/queries";
import type { DayPlanInput, DayPreview, DaySession, TradePlanDetail } from "../../api/types";
import { parseBudget } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import { formatDayLabel, formatKrw, formatPrice, formatQty } from "../../lib/format";
import { DAY_COST_NOTE, DAY_EOD_NOTE, errorSentence, reasonSentences } from "../../lib/plainText";
import { useDebounced } from "../../lib/useDebounced";
import { Icon } from "../Icon";
import { Term } from "../Term";
import { useToast } from "../toast";
import { AsOf, Notice, PriceChange, Row, Skeleton, Spinner } from "../ui";
import { parsePrice } from "./dayUtil";
import type { MinuteChartLine } from "./MinuteChart";
import { MinuteChartPanel } from "./MinuteChartPanel";

interface Picked {
  symbol: string;
  name?: string;
}

const inputCls =
  "mt-1.5 h-12 w-full rounded-xl bg-fill px-3.5 text-[16px] tabular-nums outline-none focus:ring-2 focus:ring-brand aria-[invalid=true]:ring-2 aria-[invalid=true]:ring-up";

/** 종목 찾기 (국내만 고를 수 있다). */
function StockPicker({ onPick }: { onPick: (p: Picked) => void }) {
  const [text, setText] = useState("");
  const q = useDebounced(text.trim(), 300);
  const search = useSearch(q);
  const all = q ? (search.data?.results ?? []) : [];
  const results = all.filter((r) => r.market === "KR").slice(0, 8);
  return (
    <div>
      <label htmlFor="day-stock" className="block text-[15px] font-semibold">
        종목 (국내만)
      </label>
      <input
        id="day-stock"
        type="search"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="종목명이나 종목코드 (예: NAVER, 035420)"
        className={inputCls}
      />
      {q && (
        <ul aria-label="종목 검색 결과" className="mt-2 divide-y divide-line rounded-xl border border-line">
          {search.isFetching && !search.data ? (
            <li className="px-3.5 py-3">
              <Skeleton className="h-4 w-1/2" />
            </li>
          ) : results.length === 0 ? (
            <li className="px-3.5 py-3 text-[14px] text-mute">{all.length ? "단타 연습은 국내 종목만 돼요." : `"${q}"에 맞는 국내 종목이 없어요.`}</li>
          ) : (
            results.map((r) => (
              <li key={r.symbol}>
                <button
                  type="button"
                  onClick={() => onPick({ symbol: r.symbol, name: r.name })}
                  className="flex min-h-12 w-full items-center justify-between gap-2 px-3.5 py-2 text-left hover:bg-fill/60"
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
      )}
    </div>
  );
}

/** 고른 종목: 이름 · 직전 종가(장마감 기준) · 바꾸기. */
function PickedStock({ symbol, fallbackName, onClear }: { symbol: string; fallbackName?: string; onClear: () => void }) {
  const { data: s } = useStock(symbol);
  return (
    <div className="flex items-start justify-between gap-3 rounded-xl bg-fill px-3.5 py-3">
      <div className="min-w-0">
        <p className="flex flex-wrap items-baseline gap-x-2">
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
      <button type="button" onClick={onClear} className="h-9 shrink-0 rounded-lg bg-card px-3 text-[13px] font-semibold text-sub hover:bg-line">
        바꾸기
      </button>
    </div>
  );
}

/** 미리 보기 결과: 안전장치가 정한 수량·금액, 목표·손절에서 팔 때의 비용, 시작할 수 없는 사유. */
function DayPreviewCard({ pv, settling, easy }: { pv: DayPreview; settling: boolean; easy: boolean }) {
  const reasons = reasonSentences(pv.reasonCodes, pv.reasons);
  const cost = (c: DayPreview["costsAtTarget"]) => `수수료 ${formatKrw(c.commissionKrw)} · 거래세 ${formatKrw(c.taxKrw)}`;
  return (
    <section aria-label="단타 미리 보기" aria-busy={settling} className={cn("rounded-xl border border-line p-3.5 transition-opacity", settling && "opacity-60")}>
      <p className="flex items-center gap-1.5 text-[14px] font-semibold">
        <Icon name={pv.approved ? "check" : "ban"} className={cn("size-4", pv.approved ? "text-ok" : "text-up")} />
        {pv.approved ? (easy ? "안전장치 통과" : "리스크 엔진 통과") : easy ? "안전장치가 막았어요" : "리스크 엔진 거절"}
        {settling && <Spinner className="ml-auto text-mute" />}
      </p>
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
      <p className="mt-1 text-[12px] leading-snug text-mute">
        금액은 비용(수수료·거래세)을 뺀 값이에요. 손실은 가격이 갑자기 움직이면 더 클 수도 있어요.
      </p>

      <div aria-label="비용 합계" role="group" className="mt-3 rounded-lg bg-warn-soft p-3">
        <p className="text-[14px] font-semibold text-[#9a5b00]">{DAY_COST_NOTE}</p>
        <dl className="mt-1">
          <Row label="목표 가격에 팔 때 비용">{formatKrw(pv.costsAtTarget.totalKrw)}</Row>
        </dl>
        <p className="text-right text-[12px] text-mute tabular-nums">{cost(pv.costsAtTarget)}</p>
        <dl>
          <Row label="손절 가격에 팔 때 비용">{formatKrw(pv.costsAtStop.totalKrw)}</Row>
        </dl>
        <p className="text-right text-[12px] text-mute tabular-nums">{cost(pv.costsAtStop)}</p>
      </div>

      {!pv.session.acceptingPlans && (
        <Notice tone="warn" className="mt-3">
          지금은 계획을 만들 수 없는 시간이에요. {formatDayLabel(pv.session.date)} 0시부터 만들 수 있어요 (숫자는 지금 연습해 볼 수 있어요).
        </Notice>
      )}
      {reasons.length > 0 && (
        <div role="alert" className="mt-3 rounded-lg bg-up-soft/70 p-3">
          <p className="text-[13px] font-semibold text-up">시작할 수 없는 사유</p>
          <ul aria-label="시작할 수 없는 사유" className="mt-1 list-disc space-y-0.5 pl-5 text-[13px] text-sub">
            {reasons.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
          {!easy && pv.reasons.length > 0 && <p className="mt-1.5 text-[12px] text-mute">원문: {pv.reasons.join(" · ")}</p>}
        </div>
      )}
    </section>
  );
}

/** 시작 전 확인 셋을 모두 켜야 시작한다 (서버도 acknowledged: true를 요구한다). 입력이 바뀌면 처음부터 다시 켠다 (부모가 key로 새로 만든다). */
function DayChecklist({
  input,
  pv,
  settling,
  onCreated,
}: {
  input: DayPlanInput;
  pv: DayPreview;
  settling: boolean;
  onCreated: (plan: TradePlanDetail) => void;
}) {
  const [checks, setChecks] = useState([false, false, false]);
  const create = useCreateDayPlan();
  const toast = useToast();
  const items = [
    `손절 가격(${formatKrw(input.stopPrice)})에 닿으면 약 ${formatKrw(pv.maxLossKrw)} 손실이 나요. 가격이 갑자기 움직이면 더 클 수도 있어요`,
    DAY_EOD_NOTE,
    `수수료·거래세가 목표 가격에 팔면 ${formatKrw(pv.costsAtTarget.totalKrw)}, 손절 가격에 팔면 ${formatKrw(pv.costsAtStop.totalKrw)} 들어요`,
  ];
  const can = checks.every(Boolean) && pv.activatable && !settling && !create.isPending;

  return (
    <div className="mt-3">
      <fieldset className="rounded-xl border border-line p-3.5">
        <legend className="px-1 text-[14px] font-semibold">시작 전 확인 (셋 다 켜야 시작해요)</legend>
        <div className="space-y-2">
          {items.map((text, i) => (
            <label key={i} className="flex cursor-pointer items-start gap-2.5 text-[14px] leading-snug">
              <input
                type="checkbox"
                checked={checks[i]}
                onChange={(e) => setChecks((cur) => cur.map((v, j) => (j === i ? e.target.checked : v)))}
                className="mt-0.5 size-5 shrink-0 accent-brand"
              />
              <span>{text}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <button
        type="button"
        disabled={!can}
        onClick={() =>
          create.mutate(
            { ...input, acknowledged: true },
            {
              onSuccess: (plan) => {
                if (plan.status === "failed") toast(`${plan.name} 모의 주문을 넣지 못해 계획이 멈췄어요`, "error");
                else toast(`${plan.name} 모의 단타 계획을 시작했어요`);
                onCreated(plan);
              },
            },
          )
        }
        className="mt-3 flex h-13 w-full items-center justify-center gap-2 rounded-xl bg-brand text-[16px] font-bold text-white hover:bg-brand-dark disabled:opacity-40"
      >
        {create.isPending && <Spinner />}
        모의 단타 계획 시작
      </button>
      <p className="mt-1.5 text-[12px] text-mute">AI 아님 · 내가 정한 가격으로 모의 계좌에서만 주문해요.</p>
      {create.isError && (
        <Notice tone="error" className="mt-3">
          {errorSentence(create.error)}
        </Notice>
      )}
    </div>
  );
}

export interface DayPlanFormProps {
  session: DaySession;
  easy?: boolean;
  /** 처음 고를 종목 (?symbol=). */
  initialSymbol?: string | null;
  /** 계획을 만들면 (201 — status가 failed일 수도 있다). */
  onCreated?: (plan: TradePlanDetail) => void;
  className?: string;
}

export function DayPlanForm({ session, easy = false, initialSymbol = null, onCreated, className }: DayPlanFormProps) {
  const [picked, setPicked] = useState<Picked | null>(initialSymbol ? { symbol: initialSymbol } : null);
  const [entryRaw, setEntryRaw] = useState("");
  const [targetRaw, setTargetRaw] = useState("");
  const [stopRaw, setStopRaw] = useState("");
  const [budgetRaw, setBudgetRaw] = useState("");

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
  const input: DayPlanInput | null =
    picked && entry && target && stop && !priceError && !budget.error
      ? { symbol: picked.symbol, entryPrice: entry, targetPrice: target, stopPrice: stop, ...(budget.value !== null ? { budgetKrw: budget.value } : {}) }
      : null;
  // 입력이 멈춘 뒤에만 미리 보기를 부른다 (값이 같으면 같은 키)
  const inputKey = input ? JSON.stringify(input) : "";
  const settledKey = useDebounced(inputKey, 400);
  const settledInput = useMemo(() => (settledKey ? (JSON.parse(settledKey) as DayPlanInput) : null), [settledKey]);
  const preview = useDayPreview(settledInput);
  const settling = settledKey !== inputKey || preview.isFetching;

  const lines: MinuteChartLine[] = [];
  if (entry && !Number.isNaN(entry)) lines.push({ price: entry, kind: "entry" });
  if (target && !Number.isNaN(target)) lines.push({ price: target, kind: "target" });
  if (stop && !Number.isNaN(stop)) lines.push({ price: stop, kind: "stop" });

  const reset = () => {
    setEntryRaw("");
    setTargetRaw("");
    setStopRaw("");
    setBudgetRaw("");
  };

  const price = (id: string, label: string, value: string, set: (v: string) => void, help?: string) => (
    <div>
      <label htmlFor={id} className="block text-[15px] font-semibold">
        {label}
      </label>
      <input
        id={id}
        inputMode="numeric"
        value={value}
        onChange={(e) => set(e.target.value)}
        aria-invalid={priceError && value ? true : undefined}
        placeholder="원"
        className={inputCls}
      />
      {help && <p className="mt-1 text-[12px] text-mute">{help}</p>}
    </div>
  );

  return (
    <section aria-labelledby="day-form-title" className={cn("rounded-2xl bg-card p-5", className)}>
      <h2 id="day-form-title" className="text-[17px] font-bold">
        단타 계획 만들기
      </h2>
      <p className="mt-1 text-[13px] leading-snug text-mute">
        사는·목표·손절 가격은 내가 정하고, 수량과 시작할 수 있는지는 안전장치(리스크 엔진)가 정해요. 계획은 {formatDayLabel(session.date)} 세션에 들어가요.
      </p>

      <div className="mt-4 space-y-4">
        {picked ? (
          <PickedStock
            symbol={picked.symbol}
            fallbackName={picked.name}
            onClear={() => {
              setPicked(null);
              reset();
            }}
          />
        ) : (
          <StockPicker onPick={setPicked} />
        )}

        {picked && (
          <>
            <MinuteChartPanel
              symbol={picked.symbol}
              name={picked.name}
              title="계획용 분봉 (직전 세션)"
              lines={lines}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              {price("day-entry", "사는 가격", entryRaw, setEntryRaw, "지정가로 주문해요")}
              {price("day-target", "목표 가격", targetRaw, setTargetRaw)}
              {price("day-stop", "손절 가격", stopRaw, setStopRaw)}
            </div>
            {priceError && (
              <p role="alert" className="text-[13px] text-up">
                {priceError}
              </p>
            )}
            <div>
              <label htmlFor="day-budget" className="block text-[15px] font-semibold">
                예산 (원, 선택)
              </label>
              <input
                id="day-budget"
                inputMode="numeric"
                value={budgetRaw}
                onChange={(e) => setBudgetRaw(e.target.value)}
                aria-invalid={budget.error ? true : undefined}
                aria-describedby="day-budget-help"
                placeholder="비우면 안전장치가 정한 수량"
                className={inputCls}
              />
              <p id="day-budget-help" className={cn("mt-1 text-[12px]", budget.error ? "text-up" : "text-mute")}>
                {budget.error ?? "예산을 주면 수량을 그만큼 줄여요 (늘리지는 않아요)."}
              </p>
            </div>
          </>
        )}

        {input && settledInput && (
          <div>
            {preview.isError ? (
              <Notice tone="error">{errorSentence(preview.error)}</Notice>
            ) : !preview.data ? (
              <div className="space-y-2 rounded-xl border border-line p-3.5" aria-busy="true" aria-label="미리 보기 불러오는 중">
                <Skeleton className="h-4 w-1/2" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : (
              <>
                <DayPreviewCard pv={preview.data} settling={settling} easy={easy} />
                <DayChecklist
                  key={inputKey}
                  input={input}
                  pv={preview.data}
                  settling={settling}
                  onCreated={(plan) => {
                    reset();
                    onCreated?.(plan);
                  }}
                />
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
