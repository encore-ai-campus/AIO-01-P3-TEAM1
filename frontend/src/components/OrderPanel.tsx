import { useMutation } from "@tanstack/react-query";
import { type InputHTMLAttributes, type ReactNode, useId, useState } from "react";
import { api, errorMessage } from "../api/client";
import { useMarket } from "../api/queries";
import { useRefreshTrading, useSymbolTrading } from "../api/trading";
import type { MarketStatus, Order, OrderRequest, OrderResult, Position, Reservation, StockDetail } from "../api/types";
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
import { useToast } from "./toast";
import { Flash, Notice, Row, Segmented, Skeleton, Spinner } from "./ui";

export interface Prefill {
  analysisId: number;
  targetPrice: number;
  stopPrice: number;
  days: number;
}

type Session = MarketStatus["markets"][number] | undefined;

const KR_COMMISSION = 0.00015;
const toNum = (s: string) => (s.trim() === "" ? null : Number(s));

function useOrderMutation<T>(fn: () => Promise<T>, onOk: (data: T) => void) {
  const toast = useToast();
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data) => {
      onOk(data);
      await refresh();
    },
    onError: (err) => toast(errorMessage(err), "error"),
  });
}

const primaryBtn =
  "flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[17px] font-bold text-white transition-colors disabled:cursor-not-allowed disabled:opacity-40";
const subBtn =
  "flex h-12 w-full items-center justify-center rounded-xl bg-fill text-[15px] font-semibold text-sub transition-colors hover:bg-line";

/** 종목 상세의 주문 패널. 보유 중이면 보유 정보와 전량 매도, 대기 주문이면 취소, 아니면 매수 입력. */
export function OrderPanel({ stock, prefill, onDone }: { stock: StockDetail; prefill?: Prefill | null; onDone?: () => void }) {
  const { data: market } = useMarket();
  const t = useSymbolTrading(stock.symbol);
  const session = market?.markets.find((m) => m.market === stock.market);

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
    body = <Holding order={t.order} position={t.position} session={session} sellReservation={t.sellReservation} onDone={onDone} />;
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
      />
    );
  }

  return (
    <div className="space-y-4">
      {market && !market.brokerReady && <Notice tone="warn">증권사 조회 키가 없어 시세·주문이 되지 않습니다.</Notice>}
      {body}
    </div>
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

function BuyForm({
  stock,
  session,
  halted,
  buyingPower,
  prefill,
  onDone,
}: {
  stock: StockDetail;
  session: Session;
  halted: boolean;
  buyingPower: number | null;
  prefill?: Prefill | null;
  onDone?: () => void;
}) {
  const toast = useToast();
  const price = stock.quote.price;
  const kr = stock.market === "KR";
  const unit = kr ? "원" : "$";
  const [type, setType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limit, setLimit] = useState(price != null ? String(price) : "");
  const [qty, setQty] = useState("");
  const [exitOpen, setExitOpen] = useState(Boolean(prefill));
  const [target, setTarget] = useState(prefill ? String(prefill.targetPrice) : "");
  const [stop, setStop] = useState(prefill ? String(prefill.stopPrice) : "");
  const [days, setDays] = useState(prefill ? String(prefill.days) : "");

  const base = type === "LIMIT" ? toNum(limit) : price;
  const q = toNum(qty);
  const estimate = base != null && q != null && q > 0 ? base * q : null;
  const closed = session ? !session.isOpen : false;
  const maxQty = kr && base && buyingPower != null ? Math.max(0, Math.floor(buyingPower / (base * (1 + KR_COMMISSION)))) : null;

  const problem = (() => {
    if (halted) return "새 모의 매수가 중단되어 있습니다.";
    if (type === "LIMIT" && !(toNum(limit)! > 0)) return "지정가를 입력해 주세요.";
    if (type === "MARKET" && price == null) return "현재가를 받지 못해 시장가로 주문할 수 없습니다.";
    if (q == null) return "수량을 입력해 주세요.";
    if (!(q > 0)) return "수량은 0보다 커야 합니다.";
    if (kr && !Number.isInteger(q)) return "국내 종목은 정수 주만 주문할 수 있습니다.";
    if (exitOpen) {
      const tp = toNum(target);
      const sp = toNum(stop);
      if ((tp == null) !== (sp == null)) return "목표가와 손절가는 함께 입력해 주세요.";
      if (tp != null && sp != null && base != null && !(sp < base && base < tp)) {
        return "손절가 < 기준가 < 목표가 순서여야 합니다.";
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
      const body: OrderRequest = { symbol: stock.symbol, quantity: q!, orderType: type };
      if (type === "LIMIT") body.limitPrice = toNum(limit)!;
      if (exitOpen) {
        const tp = toNum(target);
        const sp = toNum(stop);
        const d = toNum(days);
        if (tp != null && sp != null) {
          body.targetPrice = tp;
          body.stopPrice = sp;
        }
        if (d != null) body.days = d;
      }
      return api.post<OrderResult>("/api/orders", body);
    },
    (res) => {
      toast(res.message);
      setQty("");
      onDone?.();
    },
  );

  // 수량 입력 전의 "수량을 입력해 주세요"는 안내만 하고 빨간 경고로 띄우지 않는다
  const showProblem = problem && !(q == null && problem === "수량을 입력해 주세요.");

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!problem) mutation.mutate();
      }}
    >
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
        <div className="flex items-center justify-between rounded-xl bg-fill px-3.5 py-3 text-[15px]">
          <span className="text-sub">시장가 (현재가)</span>
          <b className="font-semibold tabular-nums">
            <Flash value={price}>{formatPrice(price, stock.currency)}</Flash>
          </b>
        </div>
      )}

      <div>
        <Field
          label="수량"
          suffix="주"
          placeholder={maxQty != null ? `최대 ${formatNumber(maxQty)}주` : "0"}
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

      <div className="rounded-xl border border-line px-3.5 py-1">
        <button
          type="button"
          aria-expanded={exitOpen}
          onClick={() => setExitOpen((v) => !v)}
          className="flex h-11 w-full items-center justify-between text-[15px] font-semibold text-sub"
        >
          목표가·손절가 자동 매도 (선택)
          <span aria-hidden="true" className={cn("text-mute transition-transform", exitOpen && "rotate-180")}>
            ▾
          </span>
        </button>
        {exitOpen && (
          <div className="space-y-3 pb-3">
            {prefill && (
              <p className="text-[13px] text-brand-dark">AI 분석 #{prefill.analysisId}의 목표가·손절가·보유 기한을 채웠습니다.</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="목표가" suffix={unit === "$" ? "USD" : "원"} value={target} min={0} step="any" inputMode="decimal" onChange={(e) => setTarget(e.target.value)} />
              <Field label="손절가" suffix={unit === "$" ? "USD" : "원"} value={stop} min={0} step="any" inputMode="decimal" onChange={(e) => setStop(e.target.value)} />
            </div>
            <Field label="보유 기한" suffix="일" value={days} min={1} step={1} inputMode="numeric" onChange={(e) => setDays(e.target.value)} />
            <p className="text-[12px] text-mute">목표가·손절가·기한 조건을 2회 연속 확인하면 엔진이 자동으로 전량 매도합니다.</p>
          </div>
        )}
      </div>

      <dl className="space-y-0.5">
        <Row label="예상 금액">
          {estimate != null ? formatPrice(estimate, stock.currency) : "-"}
        </Row>
        <Row label="매수 가능액">{formatKrw(buyingPower)}</Row>
        {!kr && <p className="text-right text-[12px] text-mute">미국 종목은 체결 시점 환율로 원화 환산합니다.</p>}
      </dl>

      {closed && type === "MARKET" && <ClosedNotice session={session}>장이 닫혀 있어 다음 정규장 시작에 예약됩니다.</ClosedNotice>}
      {closed && type === "LIMIT" && (
        <ClosedNotice session={session}>장이 닫혀 있어 체결 대기 주문으로 접수되고, 정규장에서 체결을 확인합니다.</ClosedNotice>
      )}
      {showProblem && (
        <p role="alert" className="text-[14px] font-medium text-up">
          {problem}
        </p>
      )}

      <button type="submit" disabled={Boolean(problem) || mutation.isPending} className={cn(primaryBtn, "bg-up hover:bg-[#d93a47]")}>
        {mutation.isPending && <Spinner />}
        {mutation.isPending ? "주문 중…" : closed && type === "MARKET" ? "매수 예약하기" : "매수하기"}
      </button>
    </form>
  );
}

function Holding({
  order,
  position,
  session,
  sellReservation,
  onDone,
}: {
  order: Order;
  position: Position | null;
  session: Session;
  sellReservation: Reservation | null;
  onDone?: () => void;
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

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-[15px] font-semibold text-sub">보유 중</h3>
        <p className="mt-1 text-[22px] font-bold tabular-nums">
          <Flash value={position?.valueKrw}>{formatKrw(position?.valueKrw ?? null)}</Flash>
        </p>
        {position && (
          <p className={cn("text-[15px] font-semibold tabular-nums", trendClass(position.profitKrw))}>
            {formatSignedKrw(position.profitKrw)} ({formatRate(position.profitRate)})
          </p>
        )}
      </div>
      <dl className="border-t border-line pt-2">
        <Row label="보유 수량">{formatQty(order.quantity)}</Row>
        <Row label="평균 체결가">{formatPrice(position?.avgPrice ?? order.fillPrice, c)}</Row>
        <Row label="현재가">{formatPrice(position?.lastPrice ?? null, c)}</Row>
        <Row label="매수 원금">{formatKrw(position?.costKrw ?? null)}</Row>
        <Row label="목표가 / 손절가">
          <span className="text-up">{formatPrice(order.targetPrice, c)}</span> / <span className="text-down">{formatPrice(order.stopPrice, c)}</span>
        </Row>
        <Row label="보유 기한">{order.expireDate ? `${formatDate(order.expireDate)}까지` : "-"}</Row>
      </dl>

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
      <p className="text-[12px] text-mute">같은 종목은 포지션 하나만 가질 수 있고, 매도는 전량만 됩니다.</p>
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
        <h3 className="text-[15px] font-semibold text-sub">체결 대기 중</h3>
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
        <h3 className="text-[15px] font-semibold text-sub">매수 예약됨</h3>
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
      <p className="text-[13px] text-mute">정규장 밖 시장가 주문이라 다음 정규장 시작에 엔진이 실행합니다.</p>
      <button type="button" disabled={cancel.isPending} onClick={() => cancel.mutate()} className={subBtn}>
        예약 취소
      </button>
    </div>
  );
}
