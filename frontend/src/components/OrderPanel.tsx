import { useMutation } from "@tanstack/react-query";
import { type InputHTMLAttributes, type ReactNode, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorMessage } from "../api/client";
import { useFundamentals } from "../api/longterm";
import { useMarket } from "../api/queries";
import { useRefreshTrading, useSymbolTrading } from "../api/trading";
import type {
  HoldingStyle,
  MarketStatus,
  Order,
  OrderRequest,
  OrderResult,
  Position,
  PricesAsOf,
  Reservation,
  StockDetail,
} from "../api/types";
import { cn } from "../lib/cn";
import {
  formatDate,
  formatDateTime,
  formatKrw,
  formatNumber,
  formatPrice,
  formatQty,
  formatRate,
  formatSignedKrw,
  trendClass,
} from "../lib/format";
import { HOLDING_STYLE_TEXT, MARKET_ORDER_ESTIMATE, errorSentence } from "../lib/plainText";
import { StyleBadge } from "./autotrade/Badges";
import { Icon } from "./Icon";
import { ThesisForm } from "./longterm/ThesisForm";
import { useToast } from "./toast";
import { AsOf, ErrorState, Flash, Notice, Row, Segmented, Skeleton, Spinner } from "./ui";

export interface Prefill {
  analysisId: number;
  targetPrice: number;
  stopPrice: number;
  days: number;
}

type Session = MarketStatus["markets"][number] | undefined;
/** 웹 주문이 받는 보유 방식 (단타는 단타 연습장에서만 — docs/API.md "보유 방식"). */
type BuyStyle = Exclude<HoldingStyle, "day">;

const KR_COMMISSION = 0.00015;
const toNum = (s: string) => (s.trim() === "" ? null : Number(s));

/** 주문 요청. 막히면 토스트로: 실행 불가 사유 코드가 있으면 쉬운 문장(rejectionSentences), 아니면 서버 detail. */
function useOrderMutation<T>(fn: () => Promise<T>, onOk: (data: T) => void) {
  const toast = useToast();
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data) => {
      onOk(data);
      await refresh();
    },
    onError: (err) => toast(errorSentence(err), "error"),
  });
}

const primaryBtn =
  "flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[17px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const subBtn =
  "flex h-12 w-full items-center justify-center rounded-xl bg-fill text-[15px] font-semibold text-sub transition-colors hover:bg-line";

/**
 * 종목 상세의 주문 패널. 보유 중이면 보유 정보와 전량 매도, 대기 주문이면 취소, 아니면 매수 입력(보유 방식: 스윙·장기 보유).
 * 장기 보유를 사면 "왜 샀나요?"(산 이유, components/longterm/ThesisForm)를 연다 — 바텀시트가 닫혀도 보이게 body에 띄운다.
 * 펀더멘털 점검을 적용하지 않는 종목(미국·ETF·금융업·리츠 — FundamentalsView.applicable false)은 산 이유를 묻지 않는다 (점검이 오지 않으므로).
 */
export function OrderPanel({ stock, prefill, onDone }: { stock: StockDetail; prefill?: Prefill | null; onDone?: () => void }) {
  const { data: market } = useMarket();
  const t = useSymbolTrading(stock.symbol);
  const session = market?.markets.find((m) => m.market === stock.market);
  const [thesisOpen, setThesisOpen] = useState(false);
  // 종목 상세의 펀더멘털 패널과 같은 캐시. 아직 모르면(불러오는 중·실패) 열고, 대화상자가 다시 확인한다.
  const thesisApplicable = useFundamentals(stock.symbol).data?.applicable !== false;

  let body: ReactNode;
  if (!t.ready) {
    body = t.error ? (
      <Notice tone="error">{errorMessage(t.error)}</Notice>
    ) : (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
    );
  } else if (t.order?.status === "EXIT_WATCHING") {
    body = (
      <Holding
        order={t.order}
        position={t.position}
        pricesAsOf={t.account?.pricesAsOf ?? {}}
        session={session}
        sellReservation={t.sellReservation}
        onDone={onDone}
        onThesis={thesisApplicable ? () => setThesisOpen(true) : null}
      />
    );
  } else if (t.order?.status === "ENTRY_PENDING") {
    body = <Pending order={t.order} onDone={onDone} />;
  } else if (t.buyReservation) {
    body = <Reserved r={t.buyReservation} onDone={onDone} />;
  } else {
    body = (
      <BuyForm
        stock={stock}
        session={session}
        halted={market?.halted ?? false}
        buyingPower={t.account?.buyingPowerKrw ?? null}
        prefill={prefill}
        onDone={onDone}
        onLongBought={() => thesisApplicable && setThesisOpen(true)}
      />
    );
  }

  return (
    <div className="space-y-4">
      {market && !market.brokerReady && <Notice tone="warn">증권사 조회 키가 없어 시세·주문이 되지 않습니다.</Notice>}
      {body}
      {thesisOpen && <ThesisDialog symbol={stock.symbol} name={stock.name} onClose={() => setThesisOpen(false)} />}
    </div>
  );
}

/**
 * "왜 샀나요?" — 장기 보유의 산 이유 (저장하면 공시가 나올 때 펀더멘털 점검). 건너뛰어도 된다.
 * 이미 적은 산 이유는 펀더멘털 조회(FundamentalsView.thesis, 종목 상세 패널과 같은 캐시)에서 받아 폼에 채운다 —
 * 받기 전에 빈 폼을 보이면 저장이 기존 이유·축을 덮어쓰므로, 받을 때까지 폼을 그리지 않는다.
 */
function ThesisDialog({ symbol, name, onClose }: { symbol: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const q = useFundamentals(symbol);
  const f = q.data;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center lg:items-center">
      <button type="button" aria-label="닫기" onClick={onClose} className="absolute inset-0 bg-ink/40" />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="thesis-title"
        className="relative max-h-[88dvh] w-full animate-sheet-up overflow-y-auto rounded-t-3xl bg-card p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:max-w-md lg:animate-none lg:rounded-3xl"
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <h2 id="thesis-title" className="text-[18px] font-bold">
            왜 샀나요?
          </h2>
          <button type="button" aria-label="나중에 적기" onClick={onClose} className="-mt-1 -mr-2 grid size-10 place-items-center rounded-full text-sub hover:bg-fill">
            <Icon name="close" className="size-5" />
          </button>
        </div>
        {q.isPending ? (
          <div className="space-y-2" aria-busy="true" aria-label="불러오는 중">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : q.isError || !f ? (
          <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} />
        ) : !f.applicable ? (
          <>
            <p className="text-[14px] leading-snug text-sub">
              {name}은(는) 정기공시 숫자 점검을 하지 않는 종목이에요{f.reason ? ` (${f.reason})` : ""}. 산 이유를 적어도 점검 알림은 오지 않아요.
            </p>
            <button type="button" onClick={onClose} className={cn(subBtn, "mt-4")}>
              닫기
            </button>
          </>
        ) : (
          <>
            <p className="mb-4 text-[14px] leading-snug text-sub">
              {name}을(를) 산 이유를 1~3개 적어 두면, 정기공시가 나올 때 그 이유와 관련된 숫자를 정해진 기준으로 점검해 알려 드려요. 매도를 권하거나
              자동으로 팔지 않아요. 건너뛰어도 돼요.
            </p>
            <ThesisForm
              symbol={symbol}
              name={name}
              intro={false}
              initial={f.thesis ? { reasons: f.thesis.reasons, axes: f.thesis.axes } : null}
              onSaved={() => {
                toast("산 이유를 저장했어요.");
                onClose();
              }}
              onCancel={onClose}
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}

function ClosedNotice({ session, children }: { session: Session; children: ReactNode }) {
  return (
    <Notice tone="info">
      <p>{children}</p>
      {session?.opensAt && <p className="mt-0.5 text-[13px] opacity-80">다음 정규장 시작 {formatDateTime(session.opensAt)}</p>}
    </Notice>
  );
}

function Field({
  label,
  suffix,
  hint,
  ...input
}: { label: string; suffix?: string; hint?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-[14px] font-medium text-sub">
        {label}
      </label>
      <div className="flex h-12 items-center rounded-xl bg-fill px-3.5 focus-within:ring-2 focus-within:ring-brand">
        <input
          id={id}
          type="number"
          className="h-full min-w-0 flex-1 bg-transparent text-right text-[17px] font-semibold tabular-nums outline-none placeholder:font-normal placeholder:text-mute"
          {...input}
        />
        {suffix && <span className="ml-1.5 shrink-0 text-[15px] text-sub">{suffix}</span>}
      </div>
      {hint && <p className="mt-1 text-[12px] text-mute">{hint}</p>}
    </div>
  );
}

/** 입력이 아직 비어 있어서 생긴 안내 (빨간 경고로 띄우지 않는다). */
const MISSING = new Set(["수량을 입력해 주세요.", "스윙은 목표가와 손절가를 둘 다 넣어 주세요."]);

function BuyForm({
  stock,
  session,
  halted,
  buyingPower,
  prefill,
  onDone,
  onLongBought,
}: {
  stock: StockDetail;
  session: Session;
  halted: boolean;
  buyingPower: number | null;
  prefill?: Prefill | null;
  onDone?: () => void;
  onLongBought: () => void;
}) {
  const toast = useToast();
  const price = stock.quote.price; // 직전 장마감 종가 (화면 추정용)
  const kr = stock.market === "KR";
  const [style, setStyle] = useState<BuyStyle>(prefill ? "swing" : "long");
  const [type, setType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limit, setLimit] = useState(price != null ? String(price) : "");
  const [qty, setQty] = useState("");
  const [target, setTarget] = useState(prefill ? String(prefill.targetPrice) : "");
  const [stop, setStop] = useState(prefill ? String(prefill.stopPrice) : "");
  const [days, setDays] = useState(prefill ? String(prefill.days) : "");

  const base = type === "LIMIT" ? toNum(limit) : price;
  const q = toNum(qty);
  const estimate = base != null && q != null && q > 0 ? base * q : null;
  const closed = session ? !session.isOpen : false;
  const maxQty = kr && base && buyingPower != null ? Math.max(0, Math.floor(buyingPower / (base * (1 + KR_COMMISSION)))) : null;
  const swing = style === "swing";

  const problem = (() => {
    if (halted) return "새 모의 매수가 중단되어 있습니다.";
    if (type === "LIMIT" && !(toNum(limit)! > 0)) return "지정가를 입력해 주세요.";
    if (type === "MARKET" && price == null) return "직전 종가를 받지 못해 시장가로 주문할 수 없습니다.";
    if (q == null) return "수량을 입력해 주세요.";
    if (!(q > 0)) return "수량은 0보다 커야 합니다.";
    if (kr && !Number.isInteger(q)) return "국내 종목은 정수 주만 주문할 수 있습니다.";
    if (swing) {
      const tp = toNum(target);
      const sp = toNum(stop);
      if (tp == null || sp == null) return "스윙은 목표가와 손절가를 둘 다 넣어 주세요.";
      if (base != null && !(sp < base && base < tp)) {
        return type === "MARKET" ? "손절가 < 직전 종가 < 목표가 순서여야 합니다." : "손절가 < 지정가 < 목표가 순서여야 합니다.";
      }
      const d = toNum(days);
      if (d != null && !(Number.isInteger(d) && d >= 1)) return "보유 기한은 1일 이상 정수로 입력해 주세요.";
    }
    if (kr && estimate != null && buyingPower != null && estimate * (1 + KR_COMMISSION) > buyingPower) {
      return "매수 가능액이 부족합니다.";
    }
    return null;
  })();

  const mutation = useOrderMutation(
    () => {
      const body: OrderRequest = { symbol: stock.symbol, quantity: q!, orderType: type, style };
      if (type === "LIMIT") body.limitPrice = toNum(limit)!;
      if (swing) {
        body.targetPrice = toNum(target)!;
        body.stopPrice = toNum(stop)!;
        const d = toNum(days);
        if (d != null) body.days = d;
      }
      return api.post<OrderResult>("/api/orders", body);
    },
    (res) => {
      toast(res.message);
      setQty("");
      onDone?.();
      if (style === "long") onLongBought();
    },
  );

  const quiet = problem !== null && MISSING.has(problem);

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) mutation.mutate();
      }}
    >
      <div>
        <p className="mb-1.5 text-[14px] font-medium text-sub">보유 방식</p>
        <Segmented
          label="보유 방식"
          value={style}
          onChange={setStyle}
          className="w-full"
          options={[
            { value: "swing", label: "스윙" },
            { value: "long", label: "장기 보유" },
          ]}
        />
        <p className="mt-1 text-[12px] text-mute">
          {swing ? "목표가·손절가에 닿으면 자동으로 팔아요 (보유 기한은 선택)." : `${HOLDING_STYLE_TEXT.long.hint}. 사고 나면 산 이유를 적어 둘 수 있어요.`}
        </p>
      </div>

      <Segmented
        label="주문 방식"
        value={type}
        onChange={setType}
        className="w-full"
        options={[
          { value: "MARKET", label: "시장가" },
          { value: "LIMIT", label: "지정가" },
        ]}
      />

      {type === "LIMIT" ? (
        <Field
          label="지정가"
          suffix={kr ? "원" : "USD"}
          value={limit}
          min={0}
          step={kr ? 1 : 0.01}
          inputMode="decimal"
          onChange={(e) => setLimit(e.target.value)}
          hint="확인 가격이 지정가 이하가 되면 체결되고, 그날 정규장이 끝날 때까지 안 되면 취소됩니다."
        />
      ) : (
        <div className="rounded-xl bg-fill px-3.5 py-3">
          <div className="flex items-center justify-between text-[15px]">
            <span className="text-sub">시장가 · 직전 종가</span>
            <b className="font-semibold tabular-nums">
              <Flash value={price}>{formatPrice(price, stock.currency)}</Flash>
            </b>
          </div>
          <AsOf at={stock.quote.asOf} market={stock.market} className="mt-0.5 block text-right" />
        </div>
      )}

      <div>
        <Field
          label="수량"
          suffix="주"
          placeholder={maxQty != null ? `최대 ${formatNumber(maxQty)}` : "0"}
          value={qty}
          min={0}
          step={kr ? 1 : "any"}
          inputMode={kr ? "numeric" : "decimal"}
          onChange={(e) => setQty(e.target.value)}
        />
        {maxQty != null && maxQty > 0 && (
          <div className="mt-2 grid grid-cols-4 gap-1.5">
            {[
              ["10%", 0.1],
              ["25%", 0.25],
              ["50%", 0.5],
              ["최대", 1],
            ].map(([label, ratio]) => (
              <button
                key={label}
                type="button"
                onClick={() => setQty(String(Math.max(1, Math.floor(maxQty * (ratio as number)))))}
                className="h-11 rounded-lg bg-fill text-[13px] font-semibold text-sub hover:bg-line"
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {swing && (
        <fieldset className="space-y-3 rounded-xl border border-line px-3.5 py-3">
          <legend className="px-1 text-[14px] font-semibold text-sub">스윙 자동 매도</legend>
          {prefill && <p className="text-[13px] text-brand-dark">AI 분석 #{prefill.analysisId}의 목표가·손절가·보유 기한을 채웠습니다.</p>}
          <div className="grid grid-cols-2 gap-2">
            <Field label="목표가" suffix={kr ? "원" : "USD"} value={target} min={0} step="any" inputMode="decimal" onChange={(e) => setTarget(e.target.value)} />
            <Field label="손절가" suffix={kr ? "원" : "USD"} value={stop} min={0} step="any" inputMode="decimal" onChange={(e) => setStop(e.target.value)} />
          </div>
          <Field label="보유 기한" suffix="일" placeholder="선택" value={days} min={1} step={1} inputMode="numeric" onChange={(e) => setDays(e.target.value)} />
          <p className="text-[12px] text-mute">목표가·손절가·기한 조건을 2회 연속 확인하면 엔진이 모의 계좌에서 자동으로 전량 매도합니다.</p>
        </fieldset>
      )}

      <dl className="space-y-0.5">
        <Row label="예상 금액">{estimate != null ? formatPrice(estimate, stock.currency) : "-"}</Row>
        <Row label="매수 가능액">{formatKrw(buyingPower)}</Row>
        {type === "MARKET" && <p className="text-[12px] leading-snug text-mute">{MARKET_ORDER_ESTIMATE}.</p>}
        {!kr && <p className="text-right text-[12px] text-mute">미국 종목은 체결 시점 환율로 원화 환산합니다.</p>}
      </dl>

      {closed && type === "MARKET" && <ClosedNotice session={session}>장이 닫혀 있어 다음 정규장 시작에 예약됩니다.</ClosedNotice>}
      {closed && type === "LIMIT" && (
        <ClosedNotice session={session}>장이 닫혀 있어 체결 대기 주문으로 접수되고, 정규장에서 체결을 확인합니다.</ClosedNotice>
      )}
      {problem && !(quiet && q == null) && (
        <p role={quiet ? undefined : "alert"} className={cn("text-[14px] font-medium", quiet ? "text-mute" : "text-up")}>
          {problem}
        </p>
      )}

      <button type="submit" disabled={Boolean(problem) || mutation.isPending} className={cn(primaryBtn, "bg-up hover:bg-[#d93a47]")}>
        {mutation.isPending && <Spinner />}
        {mutation.isPending ? "주문 중…" : closed && type === "MARKET" ? "매수 예약하기" : "매수하기"}
      </button>
      <p className="text-center text-[12px] text-mute">모의 계좌에서만 주문해요 (실제 돈이 아니에요).</p>
    </form>
  );
}

function Holding({
  order,
  position,
  pricesAsOf,
  session,
  sellReservation,
  onDone,
  onThesis,
}: {
  order: Order;
  position: Position | null;
  pricesAsOf: PricesAsOf;
  session: Session;
  sellReservation: Reservation | null;
  onDone?: () => void;
  /** "왜 샀나요?"를 연다. null이면 버튼을 그리지 않는다 (펀더멘털 점검을 적용하지 않는 종목). */
  onThesis: (() => void) | null;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const closed = session ? !session.isOpen : false;
  const sell = useOrderMutation(
    () => api.post<OrderResult>(`/api/orders/${order.id}/sell`),
    (res) => {
      toast(res.message);
      setConfirm(false);
      onDone?.();
    },
  );
  const cancelReservation = useOrderMutation(
    () => api.del(`/api/reservations/${sellReservation!.id}`),
    () => toast("매도 예약을 취소했습니다."),
  );
  const c = order.currency;
  const style = position?.style ?? order.style;

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-sub">
          보유 중 <StyleBadge style={style} />
        </h3>
        <p className="mt-1 text-[22px] font-bold tabular-nums">
          <Flash value={position?.valueKrw}>{formatKrw(position?.valueKrw ?? null)}</Flash>
        </p>
        {position && (
          <p className={cn("text-[15px] font-semibold tabular-nums", trendClass(position.profitKrw))}>
            {formatSignedKrw(position.profitKrw)} ({formatRate(position.profitRate)})
          </p>
        )}
        <AsOf at={pricesAsOf[order.market]} market={order.market} className="block" />
      </div>
      <dl className="border-t border-line pt-2">
        <Row label="보유 수량">{formatQty(order.quantity)}</Row>
        <Row label="평균 체결가">{formatPrice(position?.avgPrice ?? order.fillPrice, c)}</Row>
        <Row label="종가">{formatPrice(position?.lastPrice ?? null, c)}</Row>
        <Row label="매수 원금">{formatKrw(position?.costKrw ?? null)}</Row>
        {style === "long" ? (
          <Row label="자동 매도">없음 (내가 팔 때까지 보유)</Row>
        ) : (
          <>
            <Row label="목표가 / 손절가">
              <span className="text-up">{formatPrice(order.targetPrice, c)}</span> / <span className="text-down">{formatPrice(order.stopPrice, c)}</span>
            </Row>
            {style === "day" ? (
              <Row label="정리">그날 15:15 (단타)</Row>
            ) : (
              <Row label="보유 기한">{order.expireDate ? `${formatDate(order.expireDate)}까지` : "-"}</Row>
            )}
          </>
        )}
      </dl>
      {style === "long" && onThesis && (
        <button type="button" onClick={onThesis} className={subBtn}>
          왜 샀나요? (산 이유 적기)
        </button>
      )}

      {sellReservation ? (
        <>
          <Notice>
            <p>다음 정규장 시작에 전량 매도하도록 예약되어 있습니다.</p>
            {sellReservation.runAt && <p className="mt-0.5 text-[13px] opacity-80">실행 예정 {formatDateTime(sellReservation.runAt)}</p>}
          </Notice>
          <button type="button" className={subBtn} disabled={cancelReservation.isPending} onClick={() => cancelReservation.mutate()}>
            매도 예약 취소
          </button>
        </>
      ) : confirm ? (
        <div className="space-y-2 rounded-xl bg-fill p-3">
          <p className="text-center text-[15px] font-semibold">{formatQty(order.quantity)}를 모두 매도할까요?</p>
          {closed && <p className="text-center text-[13px] text-sub">장이 닫혀 있어 다음 정규장 시작에 예약됩니다.</p>}
          <div className="grid grid-cols-2 gap-2">
            <button type="button" className={cn(subBtn, "bg-card")} onClick={() => setConfirm(false)}>
              취소
            </button>
            <button
              type="button"
              disabled={sell.isPending}
              onClick={() => sell.mutate()}
              className="flex h-12 items-center justify-center gap-2 rounded-xl bg-down text-[15px] font-bold text-white hover:bg-brand-dark disabled:opacity-50"
            >
              {sell.isPending && <Spinner />}
              {closed ? "매도 예약" : "매도하기"}
            </button>
          </div>
        </div>
      ) : (
        <>
          {closed && <ClosedNotice session={session}>장이 닫혀 있어 매도는 다음 정규장 시작에 예약됩니다.</ClosedNotice>}
          <button type="button" onClick={() => setConfirm(true)} className={cn(primaryBtn, "bg-down hover:bg-brand-dark")}>
            전량 매도
          </button>
        </>
      )}
      <p className="text-[12px] text-mute">같은 종목은 포지션 하나만 가질 수 있고, 매도는 전량만 됩니다. 평가는 직전 장마감 종가 기준이에요.</p>
    </div>
  );
}

function Pending({ order, onDone }: { order: Order; onDone?: () => void }) {
  const toast = useToast();
  const cancel = useOrderMutation(
    () => api.post<Order>(`/api/orders/${order.id}/cancel`),
    () => {
      toast("주문을 취소했습니다.");
      onDone?.();
    },
  );
  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-sub">
          체결 대기 중 <StyleBadge style={order.style} />
        </h3>
        <p className="mt-1 text-[22px] font-bold tabular-nums">
          {formatQty(order.quantity)} · {order.orderType === "LIMIT" ? "지정가" : "시장가"}
        </p>
      </div>
      <dl className="border-t border-line pt-2">
        {order.limitPrice != null && <Row label="지정가">{formatPrice(order.limitPrice, order.currency)}</Row>}
        <Row label="접수 시각">{formatDateTime(order.createdAt)}</Row>
        {order.targetPrice != null && (
          <Row label="목표가 / 손절가">
            {formatPrice(order.targetPrice, order.currency)} / {formatPrice(order.stopPrice, order.currency)}
          </Row>
        )}
      </dl>
      <p className="text-[13px] text-mute">확인 가격이 지정가 이하가 되면 체결되고, 그날 정규장이 끝날 때까지 안 되면 취소됩니다.</p>
      <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()} className={subBtn}>
        주문 취소
      </button>
    </div>
  );
}

function Reserved({ r, onDone }: { r: Reservation; onDone?: () => void }) {
  const toast = useToast();
  const currency = r.market === "KR" ? "KRW" : "USD";
  const cancel = useOrderMutation(
    () => api.del(`/api/reservations/${r.id}`),
    () => {
      toast("예약을 취소했습니다.");
      onDone?.();
    },
  );
  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-sub">
          매수 예약됨 {r.style && <StyleBadge style={r.style} />}
        </h3>
        <p className="mt-1 text-[22px] font-bold tabular-nums">{formatQty(r.quantity)} · 시장가</p>
      </div>
      <dl className="border-t border-line pt-2">
        <Row label="실행 예정">{formatDateTime(r.runAt)}</Row>
        {r.targetPrice != null && (
          <Row label="목표가 / 손절가">
            {formatPrice(r.targetPrice, currency)} / {formatPrice(r.stopPrice, currency)}
          </Row>
        )}
        {r.days != null && <Row label="보유 기한">{r.days}일</Row>}
      </dl>
      <p className="text-[13px] text-mute">정규장 밖 시장가 주문이라 다음 정규장 시작에 엔진이 실행합니다. 체결 가격은 그때의 가격이에요.</p>
      <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()} className={subBtn}>
        예약 취소
      </button>
    </div>
  );
}
