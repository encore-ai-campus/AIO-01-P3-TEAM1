// 종목 상세의 주문 패널. 한 벌로 두 자리에 쓴다:
//   layout "dock"   — 전문가 보기: PC 오른쪽 sticky 패널 = 모바일 바텀시트 (StockPage의 .order-dock, 한 벌 DOM)
//   layout "inline" — 쉬운 보기: 본문 안 '직접 주문(고급)'을 펼친 곳
// 상태별 본문: 매수 입력(보유 방식 스윙·장기 보유) · 보유(전량 매도 — 쉬운 보기 '모두 팔기') · 체결 대기(취소) · 매수 예약(취소).
// - 결과 토스트: 전문가 보기는 서버 원문, 쉬운 보기는 응답 숫자로 만든 정해진 문장 (lib/orderText — "모의 계좌에서 카카오 1주를 32,450원에 샀어요").
// - 보유 평가(평가 금액·손익·수익률)는 시세(stock.quote, 5초)와 체결가·수량으로 종목 통화로 계산한다 (lib/holding — 계획 화면의 현재 손익과 같은 식).
//   오늘 산 종목도 실시간 숫자다. 시세 가격을 받지 못하면(또는 오늘 산 종목인데 시세가 직전 종가면) 장마감 기준 Position 값:
//   오늘 산 보유(Position.priceBasis "today_fill")는 종가·손익 대신 "오늘 산 종목 · 장 마감(15:40) 뒤에 평가돼요".
// - 주문이 접수돼 상태가 바뀌면 새 본문이 페이드로 들어오고, 누른 버튼이 사라졌으면 새 본문 제목으로 포커스를 옮긴다 (키보드·화면 읽기 사용자가 자리를 잃지 않게).
// - dock: [문제 문구 · 예상 금액 · 매수 버튼]을 스크롤 영역 바닥에 붙인다 — 입력 → 금액 확인 → 제출이 늘 엄지 영역에 있고, 버튼이 화면 밖으로 밀리지 않는다.
// - 쉬운 보기(easy): 매수 전에 확인 상자(무엇을·얼마에·언제)를 거치고, 라벨 옆 용어를 눌러 풀이를 본다.
// - 거절(400)은 토스트와 함께 버튼 바로 위에 남는다 (고칠 대상 옆에서 읽히게). 입력을 바꾸면 지운다.
// - 장기 보유를 사면 "왜 샀나요?"(산 이유)를 바텀시트로 묻는다: 맨 위에 방금 주문 결과(체결·예약·대기)를 보이고, 예약·대기면 "왜 사려고 하나요?".
//   주문 시트가 닫히는 움직임이 끝난 뒤 연다 (두 층이 엇갈려 움직이지 않게). 펀더멘털 점검을 적용하지 않는 종목(미국·ETF·금융업·리츠)은 묻지 않는다.
import { useMutation } from "@tanstack/react-query";
import { type FormEvent, type InputHTMLAttributes, type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { api, errorMessage } from "../../api/client";
import { useFundamentals } from "../../api/longterm";
import { useMarket } from "../../api/queries";
import { type SymbolState, useRefreshTrading, useSymbolTrading } from "../../api/trading";
import type { HoldingStyle, Market, MarketStatus, Order, OrderRequest, OrderResult, Position, PricesAsOf, Quote, Reservation, StockDetail } from "../../api/types";
import { useChanged, useRevealAfterLoading } from "../../hooks/useMotionState";
import { formatOpensAt } from "../../lib/autotrade";
import { cn } from "../../lib/cn";
import {
  formatDateTime,
  formatDayLabel,
  formatKrw,
  formatNumber,
  formatPrice,
  formatQty,
  formatRate,
  formatSignedKrw,
  formatSignedPrice,
  trendClass,
} from "../../lib/format";
import type { GlossaryKey } from "../../lib/glossary";
import { quoteHolding } from "../../lib/holding";
import { CAN_ANIMATE, DURATION, prefersReducedMotion } from "../../lib/motion";
import { CANCEL_TEXT, buyResultText, isTodayFill, sellResultText, todayFillText } from "../../lib/orderText";
import { HOLDING_STYLE_TEXT, errorSentence, marketOrderEstimate, quotePriceName } from "../../lib/plainText";
import { StyleBadge } from "../autotrade/Badges";
import { Icon } from "../Icon";
import { josa } from "../longterm/longtermText";
import { ThesisForm } from "../longterm/ThesisForm";
import { Collapse } from "../motion/Collapse";
import { Sheet } from "../motion/Sheet";
import { Term } from "../Term";
import { useToast } from "../toast";
import { AsOf, ErrorState, Flash, Notice, Row, Segmented, Skeleton, Spinner } from "../ui";

export interface Prefill {
  analysisId: number;
  targetPrice: number;
  stopPrice: number;
  days: number;
}

/** dock: 전문가 보기의 패널·바텀시트 (버튼 묶음을 바닥에 붙인다) · inline: 쉬운 보기 본문 안. */
export type OrderLayout = "dock" | "inline";

type Session = MarketStatus["markets"][number] | undefined;

const KR_COMMISSION = 0.00015;
const toNum = (s: string) => (s.trim() === "" ? null : Number(s));
/**
 * 주문 버튼을 누른 뒤 이 시간 안에 패널 상태가 바뀌면 그 결과로 본다 (그 뒤의 폴링 변화는 포커스를 옮기지 않는다).
 * 종목 상세의 쉬운 보기 '내 모의 주문'이 주문이 끝나 저절로 접힐 때도 같은 기준을 쓴다 (pages/StockPage.tsx).
 */
export const ACTED_MS = 8000;

/** 주문 요청. 막히면 토스트로(실행 불가 사유 코드가 있으면 쉬운 문장, 아니면 서버 detail) + onFail로 같은 문장을 돌려준다. */
function useOrderMutation<T>(fn: () => Promise<T>, onOk: (data: T) => void, onFail?: (message: string) => void) {
  const toast = useToast();
  const refresh = useRefreshTrading();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (data) => {
      onOk(data);
      await refresh();
    },
    onError: (err) => {
      const message = errorSentence(err);
      toast(message, "error");
      onFail?.(message);
    },
  });
}

const primaryBtn =
  "press flex h-14 w-full items-center justify-center gap-2 rounded-2xl text-[17px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-40";
const subBtn =
  "press flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-fill text-[15px] font-semibold text-sub hover:bg-line disabled:opacity-40 aria-disabled:hover:bg-fill";
/** 연한 상자(bg-fill) 안의 보조 버튼: 다크에서는 상자보다 밝게 (card는 fill보다 어두워 눌려 들어간 모양이 된다). */
const boxBtn =
  "press flex h-12 w-full items-center justify-center rounded-xl bg-card text-[15px] font-semibold text-sub hover:bg-line dark:bg-line dark:hover:bg-thumb";
/** 패널 본문 제목 (상태가 바뀐 뒤 포커스를 받는 자리). */
const panelTitle = "flex items-center gap-1.5 text-[15px] font-semibold text-sub outline-none";

/**
 * 상태가 처음 정해진 뒤(불러오는 중 → 매수·보유…) 다시 바뀌었는지. 처음 정해질 때는 움직이지 않는다 (그건 '불러온 끝'이라 따로 페이드).
 * 한 번 바뀌면 계속 true.
 */
function useSettledChange<T>(value: T | null): boolean {
  const [seen, setSeen] = useState<{ first: T | null; changed: boolean }>({ first: value, changed: false });
  if (seen.first === null && value !== null) setSeen({ first: value, changed: false }); // 렌더 중 조건부 파생 상태
  const differs = seen.first !== null && value !== null && !Object.is(seen.first, value);
  if (differs && !seen.changed) setSeen({ first: seen.first, changed: true });
  return seen.changed || differs;
}

/**
 * 종목 상세의 주문 패널. 보유 중이면 보유 정보와 전량 매도, 대기 주문이면 취소, 아니면 매수 입력(보유 방식: 스윙·장기 보유).
 * onDone: 주문·매도·취소가 끝났을 때 (모바일 바텀시트를 닫는다 · 쉬운 보기는 저절로 접히는 '내 모의 주문'의 포커스를 접힘 버튼으로 옮길 표시).
 * 매도·취소 버튼은 보내는 동안 disabled 대신 aria-disabled로 누름만 무시한다 (막으면 누른 버튼의 포커스가 body로 빠진다 — a11y-11).
 */
export function OrderPanel({
  stock,
  prefill,
  onDone,
  layout = "dock",
  easy = false,
}: {
  stock: StockDetail;
  prefill?: Prefill | null;
  onDone?: () => void;
  layout?: OrderLayout;
  easy?: boolean;
}) {
  const { data: market } = useMarket();
  const t = useSymbolTrading(stock.symbol);
  const session = market?.markets.find((m) => m.market === stock.market);
  // 종목 상세의 펀더멘털 패널과 같은 캐시. 아직 모르면(불러오는 중·실패) 열고, 대화상자가 다시 확인한다.
  const fundamentals = useFundamentals(stock.symbol).data;
  const thesisApplicable = fundamentals?.applicable !== false;
  const hasThesis = Boolean(fundamentals?.thesis);
  const [thesis, setThesis] = useState<{ open: boolean; result: OrderResult | null }>({ open: false, result: null });
  const root = useRef<HTMLDivElement>(null);
  const actedAt = useRef(0); // 사용자가 주문·매도·취소를 눌러 성공한 때
  const timer = useRef(0); // '왜 샀나요?' 이어 열기
  const kind: SymbolState = t.state;
  const settled = kind === "loading" ? null : kind;
  const swapped = useSettledChange(settled);
  const arrived = useRevealAfterLoading(kind === "loading");

  useEffect(() => {
    const pending = timer;
    return () => window.clearTimeout(pending.current);
  }, []);

  // 누른 버튼이 사라졌으면(매수 폼 → 보유 등) 새 본문 제목으로 포커스. 다른 곳(대화상자·하단 버튼)에 있으면 그대로 둔다
  useLayoutEffect(() => {
    if (settled === null || !actedAt.current || Date.now() - actedAt.current > ACTED_MS) return;
    actedAt.current = 0;
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected || Boolean(root.current?.contains(active));
    if (lost) root.current?.querySelector<HTMLElement>("[data-panel-title]")?.focus({ preventScroll: true });
  }, [settled]);

  const acted = () => {
    actedAt.current = Date.now();
  };

  const openThesis = (result: OrderResult | null, afterSheet = false) => {
    window.clearTimeout(timer.current);
    const show = () => setThesis({ open: true, result });
    // 주문 시트가 닫히는 움직임이 끝난 뒤 연다. 움직임이 없으면(테스트·움직임 줄이기·PC 패널) 바로
    if (afterSheet && CAN_ANIMATE && !prefersReducedMotion()) timer.current = window.setTimeout(show, DURATION.base + 60);
    else show();
  };

  const closeThesis = () => {
    setThesis((s) => ({ ...s, open: false }));
    // 대화상자를 연 자리(주문 직후의 수량 칸 등)가 이미 사라졌으면 패널의 새 제목으로 (포커스를 잃지 않게)
    // (닫히는 동안 대화상자는 inert라 그 안의 포커스도 잃은 것으로 본다)
    requestAnimationFrame(() => {
      const active = document.activeElement;
      const lost = !active || active === document.body || !active.isConnected || active.closest("[inert]") !== null;
      if (lost) root.current?.querySelector<HTMLElement>("[data-panel-title]")?.focus({ preventScroll: true });
    });
  };

  let body: ReactNode;
  if (kind === "loading") {
    body = (
      <div className="space-y-4" aria-busy="true" aria-label="주문 정보를 불러오는 중">
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-10 w-full rounded-xl" />
        <Skeleton className="h-12 w-full rounded-xl" />
        <Skeleton className="h-14 w-full rounded-2xl" />
      </div>
    );
  } else if (kind === "error") {
    body = <Notice tone="error">{errorMessage(t.error)}</Notice>;
  } else if (kind === "holding" && t.order) {
    body = (
      <Holding
        order={t.order}
        position={t.position}
        quote={stock.quote}
        pricesAsOf={t.account?.pricesAsOf ?? {}}
        session={session}
        sellReservation={t.sellReservation}
        hasThesis={hasThesis}
        easy={easy}
        onDone={onDone}
        onActed={acted}
        onThesis={thesisApplicable ? () => openThesis(null) : null}
      />
    );
  } else if (kind === "pending" && t.order) {
    body = <Pending order={t.order} easy={easy} onDone={onDone} onActed={acted} />;
  } else if (kind === "reserved" && t.buyReservation) {
    body = <Reserved r={t.buyReservation} easy={easy} onDone={onDone} onActed={acted} />;
  } else {
    body = (
      <BuyForm
        stock={stock}
        session={session}
        halted={market?.halted ?? false}
        buyingPower={t.account?.buyingPowerKrw ?? null}
        prefill={prefill}
        layout={layout}
        easy={easy}
        onActed={acted}
        onDone={onDone}
        onLongBought={(res, afterSheet) => thesisApplicable && openThesis(res, afterSheet)}
      />
    );
  }

  return (
    <div ref={root}>
      <Collapse open={Boolean(market && !market.brokerReady)}>
        <div className="pb-4">
          <Notice tone="warn">증권사 조회 키가 없어 시세·주문이 되지 않아요.</Notice>
        </div>
      </Collapse>
      <div key={kind} className={swapped || arrived ? "reveal-fade" : undefined}>
        {body}
      </div>
      <ThesisDialog open={thesis.open} result={thesis.result} stock={stock} easy={easy} onClose={closeThesis} />
    </div>
  );
}

/**
 * "왜 샀나요?" — 장기 보유의 산 이유 (저장하면 공시가 나올 때 펀더멘털 점검). 건너뛰어도 된다.
 * 이미 적은 산 이유는 펀더멘털 조회(FundamentalsView.thesis, 종목 상세 패널과 같은 캐시)에서 받아 폼에 채운다 —
 * 받기 전에 빈 폼을 보이면 저장이 기존 이유·축을 덮어쓰므로, 받을 때까지 폼을 그리지 않는다.
 * result가 있으면(주문 직후) 맨 위에 결과를 보이고 대화상자의 설명(aria-describedby)으로 잇는다 — 화면 읽기가 제목 다음에 결과를 읽는다.
 * 처음 포커스는 시트 기본(첫 버튼 '나중에 적기')이다: 결과 띠는 조작할 곳이 아니고, 건너뛰기가 바로 손에 닿아야 한다.
 * 결과 띠는 체결·예약·체결 대기를 구분해 '모의 계좌'를 밝힌다 (lib/orderText.buyResultText — 쉬운 보기 토스트와 같은 문장).
 * easy: 쉬운 보기는 "정기공시"를 "실적 보고서(정기공시)"로 푼다.
 */
function ThesisDialog({
  open,
  result,
  stock,
  easy,
  onClose,
}: {
  open: boolean;
  result: OrderResult | null;
  stock: StockDetail;
  easy: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const q = useFundamentals(stock.symbol);
  const f = q.data;
  const titleId = useId();
  const bandId = useId();
  const name = stock.name;
  // 체결이 아니면(예약·체결 대기) 아직 산 것이 아니다
  const future = result !== null && result.order?.status !== "EXIT_WATCHING";

  return (
    // scroll-pb-24: 바닥에 붙은 [취소·산 이유 저장](약 80~92px) 밑으로 Tab한 칸이 가려지지 않게 그만큼 비켜 스크롤한다 (a11y-3)
    <Sheet open={open} onClose={onClose} labelledBy={titleId} describedBy={result ? bandId : undefined} className="scroll-pb-24">
      <div className="mb-2 flex items-start justify-between gap-2">
        <h2 id={titleId} className="pt-2 text-[18px] font-bold">
          {future ? "왜 사려고 하나요?" : "왜 샀나요?"}
        </h2>
        <button
          type="button"
          aria-label="나중에 적기"
          onClick={onClose}
          className="-mt-0.5 -mr-2.5 grid size-11 shrink-0 place-items-center rounded-full text-sub transition-colors hover:bg-fill active:bg-line/60"
        >
          <Icon name="close" className="size-5" />
        </button>
      </div>
      {result && (
        <div className="mb-3 flex items-start gap-2 rounded-xl bg-ok-soft px-3.5 py-3 text-[14px] leading-snug text-ink">
          <Icon name="check-circle" className="mt-0.5 size-4 shrink-0 text-ok" />
          <p id={bandId}>{buyResultText(result, stock.name, stock.market)}</p>
        </div>
      )}
      {q.isPending ? (
        <div className="space-y-2" aria-busy="true" aria-label="불러오는 중">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : q.isError || !f ? (
        <ErrorState message={errorMessage(q.error)} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : !f.applicable ? (
        <>
          <p className="text-[14px] leading-snug text-sub">
            {name}
            {josa(name, "은/는")} {easy ? "실적 보고서(정기공시)" : "정기공시"} 숫자 점검을 하지 않는 종목이에요{f.reason ? ` (${f.reason})` : ""}. 산 이유를
            적어도 점검 알림은 오지 않아요.
          </p>
          <button type="button" onClick={onClose} className={cn(subBtn, "mt-4")}>
            닫기
          </button>
        </>
      ) : (
        <>
          <p className="mb-4 text-[14px] leading-snug text-sub">
            {future && "사고 나면 이 이유로 점검해요. "}
            {name}
            {josa(name, "을/를")} {future ? "사려는" : "산"} 이유를 1~3개 적어 두면, {easy ? "실적 보고서(정기공시)" : "정기공시"}가 나올 때 그 이유와 관련된 숫자를
            정해진 기준으로 점검해 알려 드려요. {easy ? "팔라고 하거나" : "매도를 권하거나"} 자동으로 팔지 않아요. 건너뛰어도 돼요.
          </p>
          <ThesisForm
            symbol={stock.symbol}
            name={name}
            intro={false}
            easy={easy}
            stickyActions
            initial={f.thesis ? { reasons: f.thesis.reasons, axes: f.thesis.axes } : null}
            onSaved={() => {
              toast("산 이유를 저장했어요.", "success");
              onClose();
            }}
            onCancel={onClose}
          />
        </>
      )}
    </Sheet>
  );
}

function ClosedNotice({ session, market, children }: { session: Session; market: Market; children: ReactNode }) {
  return (
    <Notice tone="info">
      <p>{children}</p>
      {session?.opensAt && <p className="mt-0.5 text-[13px] opacity-80">다음 정규장 {formatOpensAt(session.opensAt, market)}</p>}
    </Notice>
  );
}

/**
 * 숫자 입력 칸. 안내(hint)와 문제 문구를 aria-describedby로 잇고, 문제가 이 칸 때문이면 aria-invalid.
 * term: 쉬운 보기에서 라벨 자체를 용어 풀이로 (보이는 라벨은 Term, 입력 이름은 숨긴 label이 준다 — 이름은 그대로).
 */
function Field({
  label,
  term,
  suffix,
  hint,
  describedBy,
  invalid = false,
  ...input
}: {
  label: string;
  term?: GlossaryKey;
  suffix?: string;
  hint?: ReactNode;
  describedBy?: string;
  invalid?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      {term ? (
        <>
          <label htmlFor={id} className="sr-only">
            {label}
          </label>
          <span className="mb-1.5 block text-[14px] font-medium text-sub">
            <Term k={term}>{label}</Term>
          </span>
        </>
      ) : (
        <label htmlFor={id} className="mb-1.5 block text-[14px] font-medium text-sub">
          {label}
        </label>
      )}
      <div className={cn("flex h-12 items-center rounded-xl bg-fill px-3.5 focus-within:ring-2 focus-within:ring-brand", invalid && "ring-2 ring-up/50")}>
        <input
          id={id}
          type="number"
          aria-invalid={invalid || undefined}
          aria-describedby={cn(hintId, describedBy) || undefined}
          className="h-full min-w-0 flex-1 bg-transparent text-right text-[17px] font-semibold tabular-nums outline-none placeholder:font-normal placeholder:text-mute-weak"
          {...input}
        />
        {suffix && <span className="ml-1.5 shrink-0 text-[15px] text-sub">{suffix}</span>}
      </div>
      {hint && (
        <div id={hintId} className="mt-1 text-[12px] leading-snug text-mute tabular-nums">
          {hint}
        </div>
      )}
    </div>
  );
}

type FieldKey = "limit" | "qty" | "target" | "stop" | "days";
/** 지금 주문을 막는 문제. quiet: 아직 비어 있어서 생긴 안내 (빨간 경고로 띄우지 않는다). fields: 어느 칸 때문인지. */
interface Problem {
  text: string;
  fields: FieldKey[];
  quiet?: boolean;
}

function BuyForm({
  stock,
  session,
  halted,
  buyingPower,
  prefill,
  layout,
  easy,
  onActed,
  onDone,
  onLongBought,
}: {
  stock: StockDetail;
  session: Session;
  halted: boolean;
  buyingPower: number | null;
  prefill?: Prefill | null;
  layout: OrderLayout;
  easy: boolean;
  onActed: () => void;
  onDone?: () => void;
  onLongBought: (res: OrderResult, afterSheet: boolean) => void;
}) {
  const toast = useToast();
  const ids = useId();
  const price = stock.quote.price; // 현재가 (화면 추정용 — 실시간 시세. 받지 못한 종목은 직전 장마감 종가)
  const basis = stock.quote.basis;
  const priceName = quotePriceName(basis, easy);
  const kr = stock.market === "KR";
  const unit = kr ? "원" : "USD";
  const [style, setStyle] = useState<HoldingStyle>(prefill ? "swing" : "long");
  const [type, setType] = useState<"MARKET" | "LIMIT">("MARKET");
  const [limit, setLimit] = useState(price != null ? String(price) : "");
  const [qty, setQty] = useState("");
  const [target, setTarget] = useState(prefill ? String(prefill.targetPrice) : "");
  const [stop, setStop] = useState(prefill ? String(prefill.stopPrice) : "");
  const [days, setDays] = useState(prefill ? String(prefill.days) : "");
  const [serverError, setServerError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const typeChanged = useChanged(type);
  const confirmChanged = useChanged(confirming);
  const submitButton = useRef<HTMLButtonElement>(null);
  const confirmTitle = useRef<HTMLParagraphElement>(null);

  // 입력을 바꾸면 서버 거절 문구와 확인 상자를 거둔다 (고친 값으로 다시 판단하게)
  const touched = () => {
    setServerError(null);
    setConfirming(false);
  };
  const edit = (set: (v: string) => void) => (v: string) => {
    set(v);
    touched();
  };

  const base = type === "LIMIT" ? toNum(limit) : price;
  const q = toNum(qty);
  const estimate = base != null && q != null && q > 0 ? base * q : null;
  const closed = session ? !session.isOpen : false;
  const maxQty = kr && base && buyingPower != null ? Math.max(0, Math.floor(buyingPower / (base * (1 + KR_COMMISSION)))) : null;
  const swing = style === "swing";

  const problem: Problem | null = (() => {
    if (halted) return { text: "새 모의 매수가 중단되어 있어요.", fields: [] };
    if (type === "LIMIT" && !(toNum(limit)! > 0)) return { text: "지정가를 입력해 주세요.", fields: ["limit"] };
    if (type === "MARKET" && price == null) return { text: "시세를 받지 못해 시장가로 주문할 수 없어요.", fields: [] };
    if (q == null) return { text: "수량을 입력해 주세요.", fields: ["qty"], quiet: true };
    if (!(q > 0)) return { text: "수량은 0보다 커야 해요.", fields: ["qty"] };
    if (kr && !Number.isInteger(q)) return { text: "국내 종목은 정수 주만 주문할 수 있어요.", fields: ["qty"] };
    if (swing) {
      const tp = toNum(target);
      const sp = toNum(stop);
      if (tp == null || sp == null) return { text: "스윙은 목표가와 손절가를 둘 다 넣어 주세요.", fields: tp == null ? ["target"] : ["stop"], quiet: true };
      if (base != null && !(sp < base && base < tp)) {
        return {
          text: type === "MARKET" ? `손절가 < ${basis === "live" ? "현재가" : "직전 종가"} < 목표가 순서여야 해요.` : "손절가 < 지정가 < 목표가 순서여야 해요.",
          fields: ["target", "stop"],
        };
      }
      const d = toNum(days);
      if (d != null && !(Number.isInteger(d) && d >= 1)) return { text: "보유 기한은 1일 이상 정수로 입력해 주세요.", fields: ["days"] };
    }
    if (kr && estimate != null && buyingPower != null && estimate * (1 + KR_COMMISSION) > buyingPower) {
      return { text: "매수 가능액이 부족해요.", fields: ["qty"] };
    }
    return null;
  })();
  // 보일 문구: 수량을 아직 안 넣었으면 아무것도 (빈 칸 안내는 조용히). 문제가 없으면 서버가 거절한 문장
  const shown: Problem | null = problem ? (problem.quiet && q == null ? null : problem) : serverError ? { text: serverError, fields: ["qty"] } : null;
  const loud = shown !== null && !shown.quiet;
  const problemId = `${ids}-problem`;
  const invalid = (f: FieldKey) => loud && shown.fields.includes(f);
  const describe = (f: FieldKey) => (shown?.fields.includes(f) ? problemId : undefined);

  /** 목표가·손절가·지정가 칸 아래 읽기 도움: 쉼표 찍은 금액 + 현재가(못 받으면 종가) 대비 (칸의 값은 그대로). */
  const relative = (raw: string): ReactNode => {
    const v = toNum(raw);
    if (v == null || !(v > 0) || price == null || price <= 0) return null;
    return (
      <>
        <span className="block">= {formatPrice(v, stock.currency)}</span>
        <span className="block">
          {priceName} 대비 <span className={trendClass(v - price)}>{formatRate(v / price - 1, 1)}</span>
        </span>
      </>
    );
  };

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
      toast(easy ? buyResultText(res, stock.name, stock.market) : res.message, "success");
      setQty("");
      setConfirming(false);
      onActed();
      // 모바일 바텀시트(모달)에서 샀으면 시트가 닫히는 중이다 — '왜 샀나요?'는 그 뒤에
      const afterSheet = document.documentElement.hasAttribute("data-scroll-lock");
      onDone?.();
      if (style === "long") onLongBought(res, afterSheet);
    },
    (message) => {
      setServerError(message);
      setConfirming(false);
    },
  );

  // 확인 상자가 열리면 그 질문으로, 닫혀서 포커스를 잃었으면 매수 버튼으로
  useEffect(() => {
    if (!confirmChanged) return;
    if (confirming) {
      const el = confirmTitle.current;
      el?.focus({ preventScroll: true });
      if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest", behavior: prefersReducedMotion() ? "auto" : "smooth" });
    } else if (!document.activeElement || document.activeElement === document.body) {
      submitButton.current?.focus({ preventScroll: true });
    }
  }, [confirming, confirmChanged]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (problem || mutation.isPending) return;
    if (easy && !confirming) {
      setConfirming(true);
      return;
    }
    mutation.mutate();
  };

  // 언제 사지는지 (확인 상자)
  const when =
    type === "LIMIT"
      ? `${formatPrice(toNum(limit), stock.currency)} 이하가 되면 사요${closed ? " (정규장에서 체결을 확인해요)" : ""}`
      : closed
        ? `${session?.opensAt ? formatOpensAt(session.opensAt, stock.market) : "다음 정규장 시작"}에 사요`
        : "지금 가격으로 바로 사요 (주문 시점 가격으로 체결)";

  return (
    <form noValidate onSubmit={submit}>
      <h3 data-panel-title tabIndex={-1} className="sr-only">
        매수 입력
      </h3>
      {prefill && (
        // 분석에서 채운 가격은 아래 스윙 칸에 있어 시트·패널의 첫 화면(바닥 버튼 묶음 위)에서는 보이지 않는다 — 무엇을 채웠는지 맨 위에서 먼저 알린다
        <Collapse open={swing}>
          <div className="pb-4">
            <Notice>
              <p className="font-semibold">AI 분석 #{prefill.analysisId}의 가격을 채웠어요</p>
              <p className="mt-0.5 text-[13px] tabular-nums">
                목표가 {formatPrice(prefill.targetPrice, stock.currency)} · 손절가 {formatPrice(prefill.stopPrice, stock.currency)} · 보유 기한{" "}
                {prefill.days}일
              </p>
            </Notice>
          </div>
        </Collapse>
      )}
      <div>
        <p className="mb-1.5 text-[14px] font-medium text-sub">보유 방식</p>
        <Segmented
          label="보유 방식"
          value={style}
          onChange={(v) => {
            setStyle(v);
            touched();
          }}
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

      <div className="mt-4">
        <p className="mb-1.5 text-[14px] font-medium text-sub">
          주문 방식
          {easy && (
            <span className="font-normal">
              {" "}
              (<Term k="시장가" /> · <Term k="지정가" />)
            </span>
          )}
        </p>
        <Segmented
          label="주문 방식"
          value={type}
          onChange={(v) => {
            setType(v);
            touched();
          }}
          className="w-full"
          options={[
            { value: "MARKET", label: "시장가" },
            { value: "LIMIT", label: "지정가" },
          ]}
        />
      </div>

      {/* 시장가 상자 ↔ 지정가 칸: 바꾼 뒤에만 새 내용이 페이드로 들어온다 */}
      <div key={type} className={cn("mt-4", typeChanged && "reveal-fade")}>
        {type === "LIMIT" ? (
          <Field
            label="지정가"
            suffix={unit}
            value={limit}
            min={0}
            step={kr ? 1 : 0.01}
            inputMode="decimal"
            invalid={invalid("limit")}
            describedBy={describe("limit")}
            onChange={(e) => edit(setLimit)(e.target.value)}
            hint={
              <>
                {relative(limit)}
                <span className="mt-0.5 block">확인 가격이 지정가 이하가 되면 체결되고, 그날 정규장이 끝날 때까지 안 되면 취소돼요.</span>
              </>
            }
          />
        ) : (
          <div className="rounded-xl bg-fill px-3.5 py-3">
            <div className="flex items-center justify-between text-[15px]">
              <span className="text-sub">
                {basis === "live" ? (
                  `시장가 · ${priceName}`
                ) : (
                  <>시장가 · 직전 {easy ? <Term k="종가" /> : "종가"}</>
                )}
              </span>
              <b className="font-semibold tabular-nums">
                <Flash value={price}>{formatPrice(price, stock.currency)}</Flash>
              </b>
            </div>
            <AsOf at={stock.quote.asOf} market={stock.market} basis={basis} className="mt-0.5 block text-right" />
            <p className="mt-1.5 text-[12px] leading-snug text-mute">{marketOrderEstimate(basis)}.</p>
          </div>
        )}
      </div>

      <div className="mt-4">
        <dl>
          <Row label="매수 가능액" className="pt-0">
            {formatKrw(buyingPower)}
          </Row>
        </dl>
        <Field
          label="수량"
          suffix="주"
          placeholder={maxQty != null ? `최대 ${formatNumber(maxQty)}` : "0"}
          value={qty}
          min={0}
          step={kr ? 1 : "any"}
          inputMode={kr ? "numeric" : "decimal"}
          invalid={invalid("qty")}
          describedBy={cn(describe("qty"), maxQty != null && `${ids}-max`) || undefined}
          onChange={(e) => edit(setQty)(e.target.value)}
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
                onClick={() => edit(setQty)(String(Math.max(1, Math.floor(maxQty * (ratio as number)))))}
                className="press h-11 rounded-lg bg-fill text-[13px] font-semibold text-sub hover:bg-line"
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {maxQty != null && (
          <p id={`${ids}-max`} className="mt-1.5 text-[12px] text-mute">
            매수 가능액 기준 최대 {formatNumber(maxQty)}주 · 투자 한도에 따라 막힐 수 있어요
          </p>
        )}
        {!kr && <p className="mt-1.5 text-[12px] text-mute">미국 종목은 체결 시점 환율로 원화 환산해요.</p>}
      </div>

      <Collapse open={swing}>
        <div className="pt-4">
          <fieldset className="space-y-3 rounded-xl border border-line px-3.5 py-3">
            <legend className="px-1 text-[14px] font-semibold text-sub">스윙 자동 매도</legend>
            <div className="grid grid-cols-2 gap-2">
              <Field
                label="목표가"
                term={easy ? "목표 가격" : undefined}
                suffix={unit}
                value={target}
                min={0}
                step="any"
                inputMode="decimal"
                invalid={invalid("target")}
                describedBy={describe("target")}
                hint={relative(target)}
                onChange={(e) => edit(setTarget)(e.target.value)}
              />
              <Field
                label="손절가"
                term={easy ? "손절" : undefined}
                suffix={unit}
                value={stop}
                min={0}
                step="any"
                inputMode="decimal"
                invalid={invalid("stop")}
                describedBy={describe("stop")}
                hint={relative(stop)}
                onChange={(e) => edit(setStop)(e.target.value)}
              />
            </div>
            <Field
              label="보유 기한"
              term={easy ? "보유 기간" : undefined}
              suffix="일"
              placeholder="선택"
              value={days}
              min={1}
              step={1}
              inputMode="numeric"
              invalid={invalid("days")}
              describedBy={describe("days")}
              onChange={(e) => edit(setDays)(e.target.value)}
            />
            <p className="text-[12px] text-mute">목표가·손절가·기한 조건을 2회 연속 확인하면 엔진이 모의 계좌에서 자동으로 전량 매도해요.</p>
          </fieldset>
        </div>
      </Collapse>

      {closed && (
        <div className="mt-4">
          <ClosedNotice session={session} market={stock.market}>
            {type === "MARKET" ? "장이 닫혀 있어 다음 정규장 시작에 예약돼요." : "장이 닫혀 있어 체결 대기 주문으로 접수되고, 정규장에서 체결을 확인해요."}
          </ClosedNotice>
        </div>
      )}

      {/* 바닥 묶음: 예상 금액 · 문제 문구(자리를 미리 잡아 입력 중에 버튼이 흔들리지 않게 — 막는 이유가 버튼 바로 위) · 매수 버튼. dock에서는 스크롤 영역 바닥에 붙는다 */}
      <div
        className={cn(
          "mt-4",
          layout === "dock" &&
            "sticky -bottom-[max(1.25rem,env(safe-area-inset-bottom))] z-10 -mx-5 -mb-[max(1.25rem,env(safe-area-inset-bottom))] border-t border-line bg-card px-5 pt-3 pb-[max(1.25rem,env(safe-area-inset-bottom))] lg:-bottom-5 lg:-mb-5 lg:pb-5",
        )}
      >
        <dl>
          <Row label="예상 금액" className="py-0.5">
            {estimate != null ? formatPrice(estimate, stock.currency) : "-"}
          </Row>
        </dl>
        <div id={problemId} className="mt-1 min-h-5 text-[14px] leading-5 font-medium">
          <p role="alert" className="text-up-ink">
            {loud ? shown.text : ""}
          </p>
          {shown?.quiet && <p className="text-mute">{shown.text}</p>}
        </div>
        <div key={confirming ? "confirm" : "button"} className={cn("mt-1.5", confirmChanged && "reveal-fade")}>
          {confirming ? (
            <div role="group" aria-labelledby={`${ids}-confirm`} className="space-y-3 rounded-xl bg-fill p-4">
              <div>
                <p id={`${ids}-confirm`} ref={confirmTitle} tabIndex={-1} className="text-[16px] font-bold outline-none">
                  모의 계좌로 {stock.name} {formatQty(q)}를 살까요?
                </p>
                <p className="mt-1 text-[14px] text-sub tabular-nums">
                  약 {formatPrice(estimate, stock.currency)} · {HOLDING_STYLE_TEXT[style].label}
                </p>
                <p className="mt-0.5 text-[14px] text-sub">{when}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <button type="button" onClick={() => setConfirming(false)} className={boxBtn}>
                  취소
                </button>
                <button
                  type="submit"
                  disabled={mutation.isPending}
                  className="press flex h-12 items-center justify-center gap-2 rounded-xl bg-up text-[15px] font-bold text-white hover:bg-up-dark disabled:opacity-50"
                >
                  {mutation.isPending && <Spinner />}
                  모의 매수 확정
                </button>
              </div>
            </div>
          ) : (
            <button
              ref={submitButton}
              type="submit"
              disabled={Boolean(problem) || mutation.isPending}
              aria-describedby={shown ? problemId : undefined}
              className={cn(primaryBtn, "bg-up hover:bg-up-dark")}
            >
              {mutation.isPending && <Spinner />}
              {mutation.isPending ? "주문 중…" : closed && type === "MARKET" ? "매수 예약하기" : "매수하기"}
            </button>
          )}
        </div>
        <p className="mt-2 text-center text-[12px] text-mute">모의 계좌에서만 주문해요 (실제 돈이 아니에요).</p>
      </div>
    </form>
  );
}

function Holding({
  order,
  position,
  quote,
  pricesAsOf,
  session,
  sellReservation,
  hasThesis,
  easy,
  onDone,
  onActed,
  onThesis,
}: {
  order: Order;
  position: Position | null;
  /** 종목 시세 (5초마다 새로 받는다) — 보유 평가의 가격. 가격이 없으면 장마감 기준 Position 값으로 돌아간다. */
  quote: Quote;
  pricesAsOf: PricesAsOf;
  session: Session;
  sellReservation: Reservation | null;
  hasThesis: boolean;
  /** 쉬운 보기: '전량 매도' → '모두 팔기', 결과 토스트는 정해진 쉬운 문장. */
  easy: boolean;
  onDone?: () => void;
  onActed: () => void;
  /** "왜 샀나요?"를 연다. null이면 버튼을 그리지 않는다 (펀더멘털 점검을 적용하지 않는 종목). */
  onThesis: (() => void) | null;
}) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const confirmChanged = useChanged(confirm);
  const title = useRef<HTMLHeadingElement>(null);
  const sellButton = useRef<HTMLButtonElement>(null);
  const question = useRef<HTMLParagraphElement>(null);
  const closed = session ? !session.isOpen : false;
  const sell = useOrderMutation(
    () => api.post<OrderResult>(`/api/orders/${order.id}/sell`),
    (res) => {
      toast(easy ? sellResultText(res, order.name, order.market) : res.message, "success");
      setConfirm(false);
      onActed();
      onDone?.();
    },
  );
  const reservationCancelled = useRef(false);
  const cancelReservation = useOrderMutation(
    () => api.del(`/api/reservations/${sellReservation!.id}`),
    () => {
      toast(CANCEL_TEXT.sellReservation[easy ? "easy" : "expert"], "success");
      reservationCancelled.current = true;
      onActed();
    },
  );
  const c = order.currency;
  const style = position?.style ?? order.style;
  // 시세로 평가한 보유 (종목 통화, 비용 전). 오늘 산 종목도 실시간 가격이면 그대로 계산한다. null이면 장마감 기준 Position 값
  // 계좌(Position)를 아직 받지 못했으면 오늘 산 종목인지 모른다 — 시세가 직전 종가일 때 체결가와 견주지 않게 오늘 산 것으로 본다 (독립 리뷰)
  const hv = quoteHolding(quote, { avgPrice: position?.avgPrice ?? order.fillPrice, quantity: order.quantity, todayFill: !position || isTodayFill(position) });
  // 장마감 기준 값으로 돌아갔을 때의 오늘 산 보유: 체결가로 평가한 값이라(손익 0) 종가·손익·장마감 기준 시각 대신 언제 평가되는지 알린다
  const today = hv === null && isTodayFill(position);
  const liveQuote = hv !== null && quote.basis === "live";
  const sellLabel = easy ? "모두 팔기" : "전량 매도";

  // 확인 상자가 열리면 그 질문으로, 닫혀서 포커스를 잃었으면 '전량 매도'(없으면 제목)로
  useEffect(() => {
    if (!confirmChanged) return;
    if (confirm) question.current?.focus({ preventScroll: true });
    else if (!document.activeElement || document.activeElement === document.body) (sellButton.current ?? title.current)?.focus({ preventScroll: true });
  }, [confirm, confirmChanged]);

  // 매도 예약을 취소하면 누른 '매도 예약 취소'가 같은 자리의 '전량 매도'로 바뀐다(사라진다): 포커스를 잃었으면 그 버튼으로 (a11y-11)
  useLayoutEffect(() => {
    if (sellReservation || !reservationCancelled.current) return;
    reservationCancelled.current = false;
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) (sellButton.current ?? title.current)?.focus({ preventScroll: true });
  }, [sellReservation]);

  return (
    <div className="space-y-4">
      <div>
        <h3 ref={title} data-panel-title tabIndex={-1} className={panelTitle}>
          보유 중 <StyleBadge style={style} />
        </h3>
        <p className="mt-1 text-[22px] font-bold tabular-nums">
          {hv ? (
            <Flash value={hv.value}>{formatPrice(hv.value, c)}</Flash>
          ) : (
            <Flash value={position?.valueKrw}>{formatKrw(position?.valueKrw ?? null)}</Flash>
          )}
        </p>
        {hv ? (
          hv.profit !== null && (
            <p className="tabular-nums">
              <span className={cn("text-[15px] font-semibold", trendClass(hv.profit))}>
                {formatSignedPrice(hv.profit, c)} ({formatRate(hv.rate)})
              </span>{" "}
              <span className="text-[12px] text-mute">수수료·세금 빼기 전</span>
            </p>
          )
        ) : (
          position &&
          (today ? (
            <p className="text-[14px] font-medium text-sub">{todayFillText(order.market, easy)}</p>
          ) : (
            <p className="tabular-nums">
              <span className={cn("text-[15px] font-semibold", trendClass(position.profitKrw))}>
                {formatSignedKrw(position.profitKrw)} ({formatRate(position.profitRate)})
              </span>{" "}
              <span className="text-[12px] text-mute">수수료·세금 빼기 전</span>
            </p>
          ))
        )}
        {hv ? (
          <AsOf at={quote.asOf} market={order.market} basis={quote.basis} className="block" />
        ) : (
          !today && <AsOf at={pricesAsOf[order.market]} market={order.market} className="block" />
        )}
        {hv && order.market === "US" && (
          <p className="mt-0.5 text-[12px] leading-snug text-mute">
            {easy ? "가격·손익은 달러예요 (산 금액만 원화예요)." : "평가·손익은 달러 기준이에요 (매수 원금은 원화)."}
          </p>
        )}
        <p className="mt-1 text-[12px] leading-snug text-mute">팔 때 수수료와 세금이 빠져서 받는 돈은 조금 적어요.</p>
      </div>
      <dl className="border-t border-line pt-2">
        <Row label="보유 수량">{formatQty(order.quantity)}</Row>
        <Row label={easy ? "산 가격" : "평균 체결가"}>{formatPrice(position?.avgPrice ?? order.fillPrice, c)}</Row>
        {hv ? (
          <Row label={quotePriceName(quote.basis, easy)}>{formatPrice(quote.price, c)}</Row>
        ) : (
          !today && <Row label="종가">{formatPrice(position?.lastPrice ?? null, c)}</Row>
        )}
        <Row label={easy ? "산 금액" : "매수 원금"}>{formatKrw(position?.costKrw ?? null)}</Row>
        {style === "long" ? (
          <Row label="자동 매도">없음 (내가 팔 때까지 보유)</Row>
        ) : (
          <>
            <Row label="목표가 / 손절가">
              <span className="text-up">{formatPrice(order.targetPrice, c)}</span> / <span className="text-down">{formatPrice(order.stopPrice, c)}</span>
            </Row>
            <Row label="보유 기한">{order.expireDate ? `${formatDayLabel(order.expireDate)}까지` : "-"}</Row>
          </>
        )}
      </dl>
      {style === "long" && onThesis && (
        <button type="button" onClick={onThesis} className={subBtn}>
          <Icon name="doc" className="size-4" />
          {hasThesis ? "산 이유 보기·고치기" : "왜 샀나요? (산 이유 적기)"}
        </button>
      )}

      <div key={sellReservation ? "reserved" : confirm ? "confirm" : "sell"} className={cn("space-y-4", confirmChanged && "reveal-fade")}>
        {sellReservation ? (
          <>
            <Notice>
              <p>{easy ? "다음 정규장이 열리면 모의 계좌에서 모두 팔도록 예약되어 있어요." : "다음 정규장 시작에 전량 매도하도록 예약되어 있어요."}</p>
              {sellReservation.runAt && <p className="mt-0.5 text-[13px] opacity-80">실행 예정 {formatOpensAt(sellReservation.runAt, order.market)}</p>}
            </Notice>
            <button
              type="button"
              className={cn(subBtn, cancelReservation.isPending && "cursor-progress")}
              aria-disabled={cancelReservation.isPending || undefined}
              aria-busy={cancelReservation.isPending || undefined}
              onClick={() => {
                if (!cancelReservation.isPending) cancelReservation.mutate();
              }}
            >
              {cancelReservation.isPending && <Spinner />}
              {easy ? "팔기 예약 취소" : "매도 예약 취소"}
            </button>
          </>
        ) : confirm ? (
          <div role="group" aria-labelledby={`sell-confirm-${order.id}`} className="space-y-2 rounded-xl bg-fill p-3">
            <p id={`sell-confirm-${order.id}`} ref={question} tabIndex={-1} className="text-center text-[15px] font-semibold outline-none">
              {formatQty(order.quantity)}를 모두 {easy ? "팔까요?" : "매도할까요?"}
            </p>
            {closed && (
              <p className="text-center text-[13px] text-sub">{easy ? "장이 닫혀 있어 다음 정규장이 열리면 팔도록 예약돼요." : "장이 닫혀 있어 다음 정규장 시작에 예약돼요."}</p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <button type="button" className={boxBtn} onClick={() => setConfirm(false)}>
                취소
              </button>
              <button
                type="button"
                aria-disabled={sell.isPending || undefined}
                aria-busy={sell.isPending || undefined}
                onClick={() => {
                  if (!sell.isPending) sell.mutate();
                }}
                className={cn(
                  "press flex h-12 items-center justify-center gap-2 rounded-xl bg-down text-[15px] font-bold text-white hover:bg-brand-dark aria-disabled:hover:bg-down",
                  sell.isPending && "cursor-progress",
                )}
              >
                {sell.isPending && <Spinner />}
                {easy ? (closed ? "팔기 예약" : "팔기") : closed ? "매도 예약" : "매도하기"}
              </button>
            </div>
          </div>
        ) : (
          <>
            {closed && (
              <ClosedNotice session={session} market={order.market}>
                {easy ? "장이 닫혀 있어 다음 정규장이 열리면 팔도록 예약돼요." : "장이 닫혀 있어 매도는 다음 정규장 시작에 예약돼요."}
              </ClosedNotice>
            )}
            <button ref={sellButton} type="button" onClick={() => setConfirm(true)} className={cn(primaryBtn, "bg-down hover:bg-brand-dark")}>
              {sellLabel}
            </button>
          </>
        )}
      </div>
      <p className="text-[12px] text-mute">
        {liveQuote
          ? easy
            ? "같은 종목은 한 번에 하나만 가질 수 있고, 팔 때는 가진 수량을 모두 팔아요. 여기 평가는 지금 가격이에요 (내 자산·랭킹은 장 마감 가격)."
            : "같은 종목은 포지션 하나만 가질 수 있고, 매도는 전량만 돼요. 여기 평가는 실시간이에요 (자산·랭킹은 직전 장마감 기준)."
          : easy
            ? "같은 종목은 한 번에 하나만 가질 수 있고, 팔 때는 가진 수량을 모두 팔아요. 평가는 지난 장 마감 가격으로 해요 (오늘 산 종목은 장 마감 뒤에)."
            : "같은 종목은 포지션 하나만 가질 수 있고, 매도는 전량만 돼요. 평가는 직전 장마감 종가 기준이에요 (당일 매수는 장 마감 뒤에)."}
      </p>
    </div>
  );
}

function Pending({ order, easy, onDone, onActed }: { order: Order; easy: boolean; onDone?: () => void; onActed: () => void }) {
  const toast = useToast();
  const cancel = useOrderMutation(
    () => api.post<Order>(`/api/orders/${order.id}/cancel`),
    () => {
      toast(CANCEL_TEXT.order[easy ? "easy" : "expert"], "success");
      onActed();
      onDone?.();
    },
  );
  return (
    <div className="space-y-4">
      <div>
        <h3 data-panel-title tabIndex={-1} className={panelTitle}>
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
      <p className="text-[13px] text-mute">확인 가격이 지정가 이하가 되면 체결되고, 그날 정규장이 끝날 때까지 안 되면 취소돼요.</p>
      <button
        type="button"
        aria-disabled={cancel.isPending || undefined}
        aria-busy={cancel.isPending || undefined}
        onClick={() => {
          if (!cancel.isPending) cancel.mutate();
        }}
        className={cn(subBtn, cancel.isPending && "cursor-progress")}
      >
        {cancel.isPending && <Spinner />}
        주문 취소
      </button>
    </div>
  );
}

function Reserved({ r, easy, onDone, onActed }: { r: Reservation; easy: boolean; onDone?: () => void; onActed: () => void }) {
  const toast = useToast();
  const currency = r.market === "KR" ? "KRW" : "USD";
  const cancel = useOrderMutation(
    () => api.del(`/api/reservations/${r.id}`),
    () => {
      toast(CANCEL_TEXT.buyReservation[easy ? "easy" : "expert"], "success");
      onActed();
      onDone?.();
    },
  );
  return (
    <div className="space-y-4">
      <div>
        <h3 data-panel-title tabIndex={-1} className={panelTitle}>
          매수 예약됨 {r.style && <StyleBadge style={r.style} />}
        </h3>
        <p className="mt-1 text-[22px] font-bold tabular-nums">{formatQty(r.quantity)} · 시장가</p>
      </div>
      <dl className="border-t border-line pt-2">
        <Row label="실행 예정">{formatOpensAt(r.runAt, r.market)}</Row>
        {r.targetPrice != null && (
          <Row label="목표가 / 손절가">
            {formatPrice(r.targetPrice, currency)} / {formatPrice(r.stopPrice, currency)}
          </Row>
        )}
        {r.days != null && <Row label="보유 기한">{r.days}일</Row>}
      </dl>
      <p className="text-[13px] text-mute">정규장 밖 시장가 주문이라 다음 정규장 시작에 엔진이 실행해요. 체결 가격은 그때의 가격이에요.</p>
      <button
        type="button"
        aria-disabled={cancel.isPending || undefined}
        aria-busy={cancel.isPending || undefined}
        onClick={() => {
          if (!cancel.isPending) cancel.mutate();
        }}
        className={cn(subBtn, cancel.isPending && "cursor-progress")}
      >
        {cancel.isPending && <Spinner />}
        예약 취소
      </button>
    </div>
  );
}
