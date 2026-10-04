"""모의 체결기. 승인된 AI 시나리오와 사용자 주문을 가상 현금 계좌(docs/DECISIONS.md 4장)에서 체결한다.

AI를 쓰지 않고, 증권사에 주문을 내지 않는다. 가격·환율·시각·정규장 여부는 모두 호출하는 쪽이 넘긴다
(엔진이 키움 확인 가격 `confirmed_prices`로 조회한다). 그래서 클라이언트 없이 시험할 수 있다.

주문 흐름 (매수 주문 하나 = 포지션 하나):
  1. 진입 (ENTRY_PENDING)
     - 시장가: 정규장이면 받은 확인 가격에 바로 체결. 정규장 밖 시장가는 여기서 받지 않는다 (호출하는 쪽이 예약으로 넣는다)
     - 지정가: 확인 가격 ≤ 지정가면 그 확인 가격으로 체결. 접수 뒤 처음 끝나는 정규장까지 안 되면 취소 (당일 유효)
     - AI 시나리오: 진입가 지정가 (submit_plan)
  2. 보유·감시 (EXIT_WATCHING): 목표가·손절가·보유 기한 조건이 2회 연속 확인되면 확인 가격으로 전량 매도
     (원본 토스 실주문의 소수점 감시 청산 `_check_local_exit`와 같다. 튀는 가격 한 번으로 팔지 않는다)
  3. 종료 (CLOSED) / 취소 (CANCELED)

보유 방식 style (docs/API.md "보유 방식"): swing(목표·손절·기한으로 자동 매도) · long(장기 보유, 자동 매도·보유 기한 없음) ·
day(단타 연습, 국내만). day 주문의 세션은 접수 시각(created_at)의 KST 날짜이고, 그 세션 DAY_CLOSE_AT(15:15 KST)부터는
체결 대기면 취소("단타 진입 마감"), 보유 중이면 정규장 첫 확인에서 2회 확인 없이 바로 판다(EOD, "장 마감 전 정리").
장이 닫혀 놓친 보유는 다음 정규장 첫 확인에서 같은 방식으로 판다. 15:15부터는 새 단타 매수를 받지 않는다(day_entry_closed).

사람이 읽는 거절 문장(buy_blockers·modify)에는 장중 확인 가격이나 그것으로 계산한 금액을 넣지 않는다 (docs/API.md
"장중 가격 숫자는 문장에 넣지 않는다"). 지정가·목표가·손절가·현금처럼 사용자가 아는 숫자만 넣는다.

비용: 수수료 = 금액 × 시장별 수수료율 (매수·매도 각각), 국내 매도는 거래세 SELL_TAX_RATE["KR"]를 더한다.
현금은 원화만 둔다. 달러 종목은 체결 시점 환율로 환산해 넣고 뺀다.
중단 스위치(data/HALT)는 새 모의 매수 접수만 막는다. 이미 접수한 지정가의 체결과 청산은 계속한다.
주문을 바꾸는 메서드(접수·매도·취소·수정·체결 확인)는 주문 잠금(OrderLock) 안에서 돈다. serve의 스레드(sync, 예약, 전략)와
CLI 프로세스가 동시에 점검(같은 종목, 매수 가능액, 체결 시점 현금)하고 기록해 중복 포지션이나 현금 초과가 생기지 않게 한다.
"""
import fcntl
import functools
import threading
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from datetime import time as dt_time
from pathlib import Path
from zoneinfo import ZoneInfo

from ..data.ticks import round_price
from ..judge.risk import SELL_TAX_RATE, STOP_LIMIT_BUFFER, AccountContext
from ..judge.verdict import Candidate
from ..records import account
from ..records.account import ACTIVE, CANCELED, CLOSED, ENTRY_PENDING, EXIT_WATCHING, MARKET_OF, FxUnavailable

MAX_ANALYSIS_AGE_MIN = 30  # 분석 후 이 시간이 지나면 다시 분석해야 한다
MAX_PRICE_DRIFT = 0.02  # 현재가가 진입가에서 이만큼 벗어나면 주문하지 않는다
MAX_ORDER_KRW = 100_000_000  # 1억원 이상 주문은 받지 않는다
MIN_AMOUNT_ORDER = 1.0  # 소수점(금액) 주문의 최소 금액 (달러)
LOCAL_EXIT_CONFIRMATIONS = 2  # 청산 조건이 이만큼 연속으로 확인돼야 판다 (튀는 가격 대비)
MARKET, LIMIT = "MARKET", "LIMIT"
ENTRY, TARGET, STOP, EXPIRED, MANUAL, EOD = "ENTRY", "TARGET", "STOP", "EXPIRED", "MANUAL", "EOD"
EXIT_LABEL = {TARGET: "목표가 도달", STOP: "손절가 도달", EXPIRED: "보유 기한 경과", MANUAL: "사용자 매도",
              EOD: "장 마감 전 정리"}
STATUS_LABEL = {ENTRY_PENDING: "체결 대기", EXIT_WATCHING: "보유 중", CLOSED: "종료", CANCELED: "취소"}
SWING, LONG, DAY = "swing", "long", "day"   # 보유 방식 (paper_orders.style)
STYLES = (SWING, LONG, DAY)
KST = ZoneInfo("Asia/Seoul")
DAY_CLOSE_AT = dt_time(15, 15)   # 단타 진입 마감·강제 정리 (KST, 장 마감 단일가 15:20 전 — docs/DECISIONS.md 14-4)
DAY_ENTRY_CLOSED = "단타 진입 마감"   # 15:15에 취소한 체결 대기 단타 주문의 note (계획은 expired)

# 매수 거절 사유 코드 (buy_checks, OrderRejected.codes). 사유 문장과 같은 길이·같은 순서다.
# docs/API.md "실행 불가 사유 코드" 표에 있는 코드: halted · price_passed · cash_short · position_exists · day_entry_closed.
# 나머지는 엔진 안의 코드다 (API reasonCodes로 내보내려면 먼저 표에 더한다).
INVALID_ORDER = "invalid_order"         # 수량·지정가·목표·손절·보유 방식 입력이 맞지 않음
MARKET_CLOSED = "market_closed"         # 정규장 밖 시장가
ORDER_TOO_LARGE = "order_too_large"     # 1억원 이상
FX_UNAVAILABLE = "fx_unavailable"       # 환율을 몰라 원화 금액을 셀 수 없음

__all__ = ["ACTIVE", "CANCELED", "CLOSED", "DAY", "ENTRY_PENDING", "EXIT_WATCHING", "LONG", "OrderPlan",
           "OrderRejected", "PaperExecutor", "STYLES", "SWING", "expected_pnl", "make_plan", "pre_trade_checks",
           "signed_money"]


@dataclass(frozen=True)
class OrderPlan:
    symbol: str
    currency: str
    quantity: float  # 정수 주. 소수점 방식이면 금액 ÷ 진입가로 계산한 수량
    entry_price: str
    target_price: str
    stop_trigger: str
    stop_order_price: str  # 손절 감시가에서 STOP_LIMIT_BUFFER만큼 낮춘 값 (리스크 엔진이 손실을 이 값으로 계산한다)
    expire_date: str  # 보유 기한 (YYYY-MM-DD)
    entry_amount: float | None = None  # 소수점 방식의 매수 금액. None이면 정수 주

    @property
    def fractional(self) -> bool:
        return self.entry_amount is not None

    @property
    def amount(self) -> float:
        if self.entry_amount is not None:
            return self.entry_amount
        return self.quantity * float(self.entry_price)


def make_plan(c: Candidate, today: date) -> OrderPlan:
    s = c.final
    stop = float(round_price(s.stop_price, s.currency))
    return OrderPlan(
        symbol=s.symbol, currency=s.currency, quantity=c.assessment.quantity,
        entry_amount=c.assessment.amount if c.assessment.fractional else None,
        # 매수는 내림, 매도는 내림 (목표가를 조금 낮춰 체결 가능성을 높인다)
        entry_price=round_price(s.entry_price, s.currency),
        target_price=round_price(s.target_price, s.currency),
        stop_trigger=round_price(stop, s.currency),
        stop_order_price=round_price(stop * (1 - STOP_LIMIT_BUFFER), s.currency),
        # 보유 기간은 거래일 기준이라 달력 날짜로 넉넉히 바꾼다
        expire_date=f"{today + timedelta(days=s.holding_days * 7 // 5 + 2)}",
    )


class OrderRejected(Exception):
    """모의 주문을 받아들일 수 없음. 계좌와 주문 기록은 바뀌지 않았다.

    codes는 사유 코드 (buy·submit_plan의 매수 거절이면 "; "로 이은 사유와 같은 길이·같은 순서, 그 밖에는 빈 목록).
    str(e)는 지금처럼 사유 문장이다.
    """

    def __init__(self, message: str = "", codes: list[str] | None = None):
        super().__init__(message)
        self.codes = list(codes or [])


class OrderLock:
    """모의 주문 변경을 한 번에 하나씩 하게 하는 잠금. 스레드는 RLock으로, 프로세스는 잠금 파일(flock)로 묶는다.

    같은 스레드는 다시 잡을 수 있다 (sell → cancel 등). 같은 잠금 파일에는 프로세스 안에서 객체 하나만 쓴다 (for_path).
    """
    _registry: dict[Path, "OrderLock"] = {}
    _registry_lock = threading.Lock()

    def __init__(self, path: Path):
        self.path = path
        self._thread = threading.RLock()
        self._depth = 0
        self._file = None

    @classmethod
    def for_path(cls, path: Path) -> "OrderLock":
        path = Path(path).resolve()
        with cls._registry_lock:
            return cls._registry.setdefault(path, cls(path))

    def __enter__(self):
        self._thread.acquire()
        if self._depth == 0:
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self._file = open(self.path, "a")
                fcntl.flock(self._file, fcntl.LOCK_EX)
            except BaseException:
                if self._file:
                    self._file.close()
                    self._file = None
                self._thread.release()
                raise
        self._depth += 1
        return self

    def __exit__(self, *exc):
        self._depth -= 1
        if self._depth == 0:
            fcntl.flock(self._file, fcntl.LOCK_UN)
            self._file.close()
            self._file = None
        self._thread.release()


def _locked(method):
    """PaperExecutor의 주문 변경 메서드를 주문 잠금 안에서 돌린다."""
    @functools.wraps(method)
    def wrapper(self, *args, **kwargs):
        with self.lock:
            return method(self, *args, **kwargs)
    return wrapper


def signed_money(value: float, currency: str) -> str:
    """부호를 붙인 금액 (예: +1,950원, -$17.50)."""
    body = f"{abs(value):,.0f}원" if currency == "KRW" else f"${abs(value):,.2f}"
    return ("+" if value >= 0 else "-") + body


def money(value: float, currency: str) -> str:
    return f"{value:,.0f}원" if currency == "KRW" else f"${value:,.2f}"


def qty_text(quantity: float) -> str:
    return f"{quantity:g}주" if quantity == int(quantity) else f"{quantity:.4f}주"


def expected_pnl(row) -> tuple[float | None, float | None]:
    """목표가, 손절가에 청산될 때의 (목표가 청산 손익, 손절 청산 손익). 수수료·세금 전. 값이 없으면 None.

    체결됐으면 체결 수량과 체결가, 아직이면 주문 수량과 지정가(없으면 진입가)로 계산한다.
    """
    if row["filled_quantity"] and row["fill_price"]:
        qty, price = row["filled_quantity"], row["fill_price"]
    else:
        qty = row["quantity"]
        price = row["limit_price"] if row["limit_price"] is not None else row["entry_price"]
    gain = None if row["target_price"] is None else qty * (row["target_price"] - price)
    loss = None if row["stop_price"] is None else qty * (row["stop_price"] - price)
    return gain, loss


def pre_trade_checks(c: Candidate, plan: OrderPlan, last_price: float, analyzed_at: datetime,
                     now: datetime, fx_rate: float, active_symbols: set[str],
                     halted: bool) -> list[str]:
    """AI 시나리오의 모의 주문을 막는 사유. 비어 있으면 주문할 수 있다."""
    reasons = []
    if halted:
        reasons.append("중단 스위치가 켜져 있음 (resume 명령으로 해제)")
    if not c.selected:
        reasons.append("판정 또는 최종 컨펌을 통과하지 못한 시나리오")
    age = (now - analyzed_at).total_seconds() / 60
    if age > MAX_ANALYSIS_AGE_MIN:
        reasons.append(f"분석한 지 {age:.0f}분 지남 (허용 {MAX_ANALYSIS_AGE_MIN}분). 다시 분석 필요")
    entry, target, stop = (float(plan.entry_price), float(plan.target_price),
                           float(plan.stop_trigger))
    if not stop < entry < target:
        reasons.append("호가 단위를 맞춘 뒤 가격 순서가 손절가 < 진입가 < 목표가가 아님")
    if last_price <= stop:
        reasons.append(f"현재가 {last_price:,}가 이미 손절가 {plan.stop_trigger} 이하")
    elif last_price >= target:
        reasons.append(f"현재가 {last_price:,}가 이미 목표가 {plan.target_price} 이상")
    elif abs(last_price / entry - 1) > MAX_PRICE_DRIFT:
        reasons.append(f"현재가 {last_price:,}가 진입가에서 {abs(last_price / entry - 1):.1%} 벗어남 "
                       f"(허용 {MAX_PRICE_DRIFT:.0%})")
    if plan.fractional:
        if plan.entry_amount < MIN_AMOUNT_ORDER:
            reasons.append(f"주문 금액이 최소 {MIN_AMOUNT_ORDER:g}달러보다 적음")
    elif plan.quantity < 1:
        reasons.append("주문 수량이 1주 미만")
    if plan.amount * fx_rate >= MAX_ORDER_KRW:
        reasons.append("주문 금액이 1억원 이상")
    if plan.symbol in active_symbols:
        reasons.append("같은 종목에 진행 중인 모의 주문이 있음")
    return reasons


class PaperExecutor:
    def __init__(self, store, notifier, halt_file: Path, commission_rates: dict[str, float]):
        """commission_rates는 시장별 모의 수수료율 {"KR": .., "US": ..} (PAPER_COMMISSION_KR|US).

        주문 잠금 파일은 중단 스위치와 같은 폴더의 paper.lock이다 (data/paper.lock).
        """
        self.store = store
        self.notifier = notifier
        self.halt_file = halt_file
        self.rates = commission_rates
        self.lock = OrderLock.for_path(Path(halt_file).with_name("paper.lock"))

    @property
    def halted(self) -> bool:
        return self.halt_file.exists()

    # --- 주문 접수 ---

    @_locked
    def submit_plan(self, c: Candidate, plan: OrderPlan, name: str, trade_id: int | None, requested_by: str,
                    now: datetime, fx_rate: float | None = None) -> int:
        """승인된 AI 시나리오를 진입가 지정가로 접수한다 (오늘 정규장 끝까지 유효). 실행 직전 점검은 호출하는 쪽이 한다.

        체결은 sync가 정규장에서 확인 가격을 보고 한다.
        """
        currency = plan.currency
        market = MARKET_OF[currency]
        limit = float(plan.entry_price)
        reasons, codes = self.buy_checks(plan.symbol, market, currency, plan.quantity, limit, limit, fx_rate,
                                         float(plan.target_price), float(plan.stop_trigger), True, now=now)
        if reasons:
            raise OrderRejected("; ".join(reasons), codes)
        oid = self.store.add_paper_order(
            requested_by=requested_by, trade_id=trade_id, symbol=plan.symbol, name=name, market=market,
            currency=currency, order_type=LIMIT, limit_price=limit, quantity=plan.quantity, entry_price=limit,
            target_price=float(plan.target_price), stop_price=float(plan.stop_trigger),
            expire_date=plan.expire_date, status=ENTRY_PENDING, created_at=now.isoformat(), style=SWING)
        self.notifier.send(f"[모의 주문 #{oid}] {name} ({plan.symbol}) {qty_text(plan.quantity)} 지정가 "
                           f"{money(limit, currency)} 매수 접수 (AI 시나리오, 요청 {requested_by}). "
                           f"체결되면 목표 {money(float(plan.target_price), currency)} / 손절 "
                           f"{money(float(plan.stop_trigger), currency)} 감시, 기한 {plan.expire_date}")
        return oid

    @_locked
    def buy(self, symbol: str, name: str, market: str, currency: str, quantity: float, price: float,
            fx_rate: float | None, now: datetime, requested_by: str, limit_price: float | None = None,
            target: float | None = None, stop: float | None = None, expire_date: str | None = None,
            regular_open: bool = True, *, style: str = SWING) -> int:
        """사용자·전략 매수. price는 지금 확인 가격. 정규장이면 시장가는 바로, 지정가는 가격이 맞으면 바로 체결한다.

        목표·손절을 주면 체결 뒤 자동 청산을 감시한다 (기한 expire_date가 있으면 지나면 청산). 주문 번호를 돌려준다.
        style(swing | long | day)은 주문에 저장한다. long·day는 보유 기한이 없다 (expire_date를 쓰지 않는다).
        long은 목표·손절을 받지 않고 자동 매도가 없다. day는 국내만, 15:15 KST부터는 받지 않는다.
        막히면 OrderRejected (codes: buy_checks의 코드).
        """
        limit = None if limit_price is None else float(round_price(limit_price, currency))
        target = None if target is None else float(round_price(target, currency))
        stop = None if stop is None else float(round_price(stop, currency))
        if style in (LONG, DAY):
            expire_date = None
        reasons, codes = self.buy_checks(symbol, market, currency, quantity, price, limit, fx_rate, target, stop,
                                         regular_open, style=style, now=now)
        if reasons:
            raise OrderRejected("; ".join(reasons), codes)
        oid = self.store.add_paper_order(
            requested_by=requested_by, trade_id=None, symbol=symbol, name=name, market=market, currency=currency,
            order_type=MARKET if limit is None else LIMIT, limit_price=limit, quantity=quantity,
            entry_price=limit if limit is not None else price, target_price=target, stop_price=stop,
            expire_date=expire_date, status=ENTRY_PENDING, created_at=now.isoformat(), style=style)
        how = "시장가" if limit is None else f"지정가 {money(limit, currency)}"
        managed = (f". 체결되면 목표 {money(target, currency)} / 손절 {money(stop, currency)} 감시"
                   + (f", 기한 {expire_date}" if expire_date else "")) if target is not None else ""
        if style == DAY:
            managed += f". 단타: {DAY_CLOSE_AT:%H:%M}에 장 마감 전 정리"
        elif style == LONG:
            managed += ". 장기 보유 (자동 매도 없음)"
        self.notifier.send(f"[모의 주문 #{oid}] {name} ({symbol}) {qty_text(quantity)} {how} 매수 접수 "
                           f"(요청 {requested_by}){managed}")
        if regular_open:
            self._try_entry(self.store.paper_order(oid), price, fx_rate, now)
        return oid

    def buy_blockers(self, symbol: str, market: str, currency: str, quantity: float, price: float,
                     limit: float | None, fx_rate: float | None, target: float | None, stop: float | None,
                     regular_open: bool, *, style: str = SWING, now: datetime | None = None) -> list[str]:
        """매수를 막는 사유 문장 (buy_checks의 문장만). 비어 있으면 접수할 수 있다."""
        return self.buy_checks(symbol, market, currency, quantity, price, limit, fx_rate, target, stop, regular_open,
                               style=style, now=now)[0]

    def buy_checks(self, symbol: str, market: str, currency: str, quantity: float, price: float,
                   limit: float | None, fx_rate: float | None, target: float | None, stop: float | None,
                   regular_open: bool, *, style: str = SWING,
                   now: datetime | None = None) -> tuple[list[str], list[str]]:
        """(매수를 막는 사유 문장, 사유 코드). 둘은 같은 길이·같은 순서이고, 비어 있으면 접수할 수 있다.

        price는 지금 확인 가격(장중일 수 있다)이라 문장에 그 숫자나 그것으로 계산한 금액을 넣지 않는다. 코드는 이 파일 머리의
        상수와 docs/API.md "실행 불가 사유 코드"(halted · price_passed · cash_short · position_exists · day_entry_closed).
        now는 단타(style day)의 진입 마감(15:15 KST)을 볼 때 쓴다 (없으면 지금 시각, 시간대가 없으면 KST로 본다).
        """
        reasons, codes = [], []

        def block(code: str, reason: str) -> None:
            codes.append(code)
            reasons.append(reason)

        if self.halted:
            block("halted", "중단 스위치가 켜져 있음 (resume 명령으로 해제)")
        if style not in STYLES:
            block(INVALID_ORDER, f"모르는 보유 방식: {style} ({' | '.join(STYLES)})")
        elif style == DAY:
            if market != "KR":
                block(INVALID_ORDER, "단타 연습은 국내 종목만 받음")
            if _kst(now or datetime.now(KST)).time() >= DAY_CLOSE_AT:
                block("day_entry_closed",
                      f"단타 진입 마감 ({DAY_CLOSE_AT:%H:%M} KST부터는 새 단타 매수를 받지 않음)")
        if limit is None and not regular_open:
            block(MARKET_CLOSED, "정규장 밖에서는 시장가로 체결하지 않음 (다음 정규장 시작 예약이나 지정가로 주문)")
        if quantity <= 0:
            block(INVALID_ORDER, "수량이 0 이하")
        elif market == "KR" and quantity != int(quantity):
            block(INVALID_ORDER, "국내 종목은 정수 주만 살 수 있음")
        if limit is not None and limit <= 0:
            block(INVALID_ORDER, "지정가는 0보다 커야 함")
        if style == LONG and (target is not None or stop is not None):
            block(INVALID_ORDER, "장기 보유는 목표가·손절가 없이 보유 (자동 매도 없음)")
        elif (target is None) != (stop is None):
            block(INVALID_ORDER, "목표가와 손절가를 함께 지정해야 함")
        elif target is not None:
            if limit is not None:
                if not stop < limit < target:
                    block(INVALID_ORDER, f"손절가 {_num(stop)} < 지정가 {_num(limit)} < 목표가 {_num(target)} 순서가 아님")
            elif not stop < price < target:  # 시장가: 지금 가격이 이미 목표가 이상이거나 손절가 이하 (숫자는 넣지 않는다)
                block("price_passed" if stop < target else INVALID_ORDER,
                      f"손절가 {_num(stop)} < 현재가 < 목표가 {_num(target)} 순서가 아님")
        try:
            fx = account.fx_for(self.store, currency, fx_rate)
            needed = quantity * (limit if limit is not None else price) * fx * (1 + self.rates[market])
            if needed >= MAX_ORDER_KRW:
                block(ORDER_TOO_LARGE, "주문 금액이 1억원 이상")
            power = account.buying_power_krw(self.store, fx_rate, self.rates)
            if needed > power:
                block("cash_short", f"매수 가능 금액 부족 (가능 {power:,.0f}원)")
        except FxUnavailable as e:
            block(FX_UNAVAILABLE, str(e))
        if any(r["symbol"] == symbol for r in self.store.paper_orders(ACTIVE)):
            block("position_exists", "같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만)")
        return reasons, codes

    @_locked
    def sell(self, order_id: int, price: float, fx_rate: float | None, now: datetime, requested_by: str) -> None:
        """사용자 매도: 보유 중인 포지션을 확인 가격에 전량 매도한다 (정규장 여부는 호출하는 쪽이 본다).

        체결 대기(ENTRY_PENDING) 주문이면 취소한다.
        """
        row = self._order(order_id)
        if row["status"] == ENTRY_PENDING:
            self.cancel(order_id, now, requested_by)
            return
        if row["status"] != EXIT_WATCHING:
            raise OrderRejected(f"모의 주문 #{order_id}은(는) 이미 {STATUS_LABEL[row['status']]} 상태")
        try:
            self._close(row, price, fx_rate, now, MANUAL, f"{requested_by} 매도")
        except FxUnavailable as e:
            raise OrderRejected(str(e)) from None

    @_locked
    def cancel(self, order_id: int, now: datetime, requested_by: str = "") -> None:
        """체결 대기 주문을 취소한다. 보유 중인 포지션은 sell로 판다."""
        row = self._order(order_id)
        if row["status"] != ENTRY_PENDING:
            hint = " (보유 중인 포지션은 매도)" if row["status"] == EXIT_WATCHING else ""
            raise OrderRejected(f"모의 주문 #{order_id}은(는) {STATUS_LABEL[row['status']]} 상태라 취소할 수 없음{hint}")
        self._cancel(row, now, f"사용자 취소 ({requested_by})" if requested_by else "사용자 취소")

    @_locked
    def modify(self, order_id: int, price: float | None, target: float | None, stop: float | None,
               expire_date: str | None, now: datetime) -> dict:
        """진행 중 주문의 목표가·손절가·기한을 바꾼다. 주지 않은 값은 그대로 둔다. price는 지금 확인 가격 (순서 점검).

        바뀐 값을 돌려준다. 청산 조건 연속 확인 횟수는 처음부터 다시 센다. price는 장중 가격일 수 있어 거절 문장에
        그 숫자를 넣지 않는다. 장기 보유(long)는 목표·손절·기한을, 단타(day)는 기한을 받지 않고 목표·손절은 단타 계획에서 바꾼다.
        """
        row = self._order(order_id)
        currency = row["currency"]
        style = _style(row)
        new = {"target_price": row["target_price"], "stop_price": row["stop_price"],
               "expire_date": expire_date or row["expire_date"]}
        if target is not None:
            new["target_price"] = float(round_price(target, currency))
        if stop is not None:
            new["stop_price"] = float(round_price(stop, currency))
        reasons = []
        if row["status"] not in ACTIVE:
            reasons.append(f"{STATUS_LABEL[row['status']]} 상태라 수정할 수 없음")
        if style == LONG and (target is not None or stop is not None or expire_date):
            reasons.append("장기 보유 주문은 목표가·손절가·기한을 정하지 않음 (자동 매도 없음)")
        if style == DAY and expire_date:
            reasons.append("단타 주문은 보유 기한이 없음")
        if style == DAY and (target is not None or stop is not None):
            reasons.append("단타 계획에서 바꿔요")
        t, s = new["target_price"], new["stop_price"]
        if (t is None) != (s is None):
            reasons.append("목표가와 손절가를 함께 지정해야 함")
        elif t is not None and price is not None and not s < price < t:
            reasons.append(f"손절가 {_num(s)} < 현재가 < 목표가 {_num(t)} 순서가 아님")
        if new["expire_date"] and new["expire_date"] < f"{_kst(now).date()}":
            reasons.append(f"기한 {new['expire_date']}이(가) 이미 지남")
        if all(new[k] == row[k] for k in new):
            reasons.append("바뀌는 값이 없음")
        if reasons:
            raise OrderRejected("; ".join(reasons))
        self.store.update_paper_order(order_id, signal_count=0, **new)
        self.notifier.send(f"[모의 주문 #{order_id}] {row['name']} 수정: 목표 {_opt_money(t, currency)} / "
                           f"손절 {_opt_money(s, currency)} / 기한 {new['expire_date'] or '없음'}")
        return new

    def _order(self, order_id: int):
        row = self.store.paper_order(order_id)
        if row is None:
            raise OrderRejected(f"모의 주문 #{order_id}이(가) 없음")
        return row

    # --- 체결 확인 ---

    @_locked
    def sync(self, prices: dict[str, float], now: datetime, open_markets: set[str], fx_rate: float | None,
             last_close: dict[str, datetime | None]) -> int:
        """진행 중인 주문의 체결·청산을 확인한다. 확인한 주문 수를 돌려준다.

        prices: 확인 가격 (키움 confirmed_prices). 없는 종목은 이번에 건너뛴다 (확인되지 않은 가격으로 체결하지 않는다).
        open_markets: 지금 정규장이 열린 시장. 체결과 청산은 이 시장에서만 한다.
        fx_rate: 달러 1의 원화 가치 (달러 종목이 없으면 None이어도 된다).
        last_close: 시장별로 지금까지 끝난 가장 최근 정규장의 종료 시각. 그보다 먼저 접수한 지정가 대기 주문은
          그 정규장 안에 체결되지 않은 것이므로 취소한다 (당일 유효).

        단타(style day) 주문은 그 세션(접수 시각의 KST 날짜) 15:15 KST부터 먼저 정리한다: 체결 대기는 장이 닫혀 있어도
        취소하고("단타 진입 마감"), 보유는 정규장에서 확인 가격을 받으면 2회 확인 없이 바로 판다 (EOD). 장이 닫혀 있어
        못 판 보유는 다음 정규장 첫 확인에서 판다.
        """
        rows = self.store.paper_orders(ACTIVE)
        for row in rows:
            market, symbol = row["market"], row["symbol"]
            close = last_close.get(market)
            if _style(row) == DAY and _kst(now) >= day_cutoff(row["created_at"]):
                self._day_close(row, prices, now, open_markets, fx_rate)
                continue
            if row["status"] == ENTRY_PENDING and close and datetime.fromisoformat(row["created_at"]) < close:
                self._cancel(row, now, "정규장이 끝날 때까지 지정가에 체결되지 않음")
                continue
            if market not in open_markets:
                continue
            if symbol not in prices:
                self.notifier.log(f"모의 주문 #{row['id']} {row['name']}: 확인된 가격이 없어 이번에는 건너뜀")
                continue
            try:
                if row["status"] == ENTRY_PENDING:
                    self._try_entry(row, prices[symbol], fx_rate, now)
                else:
                    self._check_exit(row, prices[symbol], fx_rate, now)
            except FxUnavailable as e:
                self.notifier.log(f"모의 주문 #{row['id']} {row['name']}: {e}. 다음 확인에서 다시 봄")
        return len(rows)

    def _day_close(self, row, prices: dict[str, float], now: datetime, open_markets: set[str],
                   fx_rate: float | None) -> None:
        """진입 마감(15:15)이 지난 단타 주문 정리. 체결 대기는 취소, 보유는 정규장 확인 가격에 바로 판다 (EOD)."""
        if row["status"] == ENTRY_PENDING:
            self._cancel(row, now, DAY_ENTRY_CLOSED)
            return
        if row["market"] not in open_markets:
            return  # 장이 닫혀 있다. 다음 정규장 첫 확인에서 판다
        price = prices.get(row["symbol"])
        if price is None:
            self.notifier.log(f"모의 주문 #{row['id']} {row['name']}: 확인된 가격이 없어 장 마감 전 정리를 다음 확인에서 함")
            return
        try:
            self._close(row, price, fx_rate, now, EOD, None)
        except FxUnavailable as e:
            self.notifier.log(f"모의 주문 #{row['id']} {row['name']}: {e}. 다음 확인에서 다시 봄")

    def _try_entry(self, row, price: float, fx_rate: float | None, now: datetime) -> None:
        """진입 체결. 지정가는 확인 가격이 지정가 이하일 때만, 그 확인 가격으로 산다."""
        if row["order_type"] == LIMIT and price > row["limit_price"]:
            return
        fx = account.fx_for(self.store, row["currency"], fx_rate)
        qty = row["quantity"]
        amount = price * qty
        commission = amount * self.rates[row["market"]]
        cost_krw = (amount + commission) * fx
        cash = self.store.account()["cash_krw"]
        if cost_krw > cash:  # 필요 금액은 장중 가격으로 센 것이라 문장에 넣지 않는다 (계획 failureReason이 된다)
            self._cancel(row, now, f"체결 시점 현금 부족 (현금 {cash:,.0f}원)")
            return
        self.store.add_fill(row["id"], "BUY", price, qty, commission, 0.0, fx, -cost_krw, ENTRY, now.isoformat(),
                            {"status": EXIT_WATCHING, "filled_quantity": qty, "fill_price": price,
                             "fill_fx_rate": fx, "filled_at": now.isoformat(), "signal_count": 0})
        c = row["currency"]
        if row["target_price"] is not None:
            watch = f" · 목표 {money(row['target_price'], c)} / 손절 {money(row['stop_price'], c)} 감시"
        elif _style(row) == LONG:
            watch = " · 장기 보유 (자동 매도 없음)"
        else:
            watch = " · 목표·손절 없이 보유"
        if _style(row) == DAY:
            watch += f" · {DAY_CLOSE_AT:%H:%M}에 장 마감 전 정리"
        self.notifier.send(f"[모의 체결 #{row['id']}] {row['name']} ({row['symbol']}) {qty_text(qty)} 매수 "
                           f"@ {money(price, c)} (수수료 {money(commission, c)}, 요청 {row['requested_by']}){watch}")

    def _check_exit(self, row, price: float, fx_rate: float | None, now: datetime) -> None:
        """목표가·손절가에 닿았거나 기한이 지났는지. 조건이 LOCAL_EXIT_CONFIRMATIONS번 연속 확인되면 판다.
        장기 보유(long)·단타(day)에는 보유 기한이 없다 (기한 값이 있어도 보지 않는다)."""
        if row["target_price"] is not None and price >= row["target_price"]:
            reason = TARGET
        elif row["stop_price"] is not None and price <= row["stop_price"]:
            reason = STOP
        elif (row["expire_date"] and _style(row) not in (LONG, DAY)
              and f"{_kst(now).date()}" > row["expire_date"]):
            reason = EXPIRED
        else:
            if row["signal_count"]:
                self.store.update_paper_order(row["id"], signal_count=0)
            return
        # 한 번 본 가격으로 팔지 않는다. 연속으로 확인돼야 한다.
        count = (row["signal_count"] or 0) + 1
        if count < LOCAL_EXIT_CONFIRMATIONS:
            self.store.update_paper_order(row["id"], signal_count=count)
            self.notifier.log(f"모의 주문 #{row['id']} {row['name']} 확인 가격 {price:,}: {EXIT_LABEL[reason]} "
                              f"({count}/{LOCAL_EXIT_CONFIRMATIONS}회 확인)")
            return
        self._close(row, price, fx_rate, now, reason, None, signal_count=count)

    def _close(self, row, price: float, fx_rate: float | None, now: datetime, reason: str, note: str | None,
               **extra) -> None:
        """보유 수량 전부를 price에 판다. 손익은 매수 체결(수수료 포함)과 비교한다."""
        fx = account.fx_for(self.store, row["currency"], fx_rate)
        qty = row["filled_quantity"]
        amount = price * qty
        commission = amount * self.rates[row["market"]]
        tax = amount * SELL_TAX_RATE[row["market"]]
        proceeds = amount - commission - tax
        buy = next(f for f in self.store.order_fills(row["id"]) if f["side"] == "BUY")
        pnl = proceeds - (buy["amount"] + buy["commission"])
        pnl_krw = proceeds * fx + buy["cash_change_krw"]
        self.store.add_fill(row["id"], "SELL", price, qty, commission, tax, fx, proceeds * fx, reason,
                            now.isoformat(), {"status": CLOSED, "exit_price": price, "exit_fx_rate": fx,
                                              "exit_reason": reason, "closed_at": now.isoformat(), "pnl": pnl,
                                              "pnl_krw": pnl_krw, "note": note or row["note"], **extra})
        c = row["currency"]
        krw = f" ({signed_money(pnl_krw, 'KRW')})" if c != "KRW" else ""
        self.notifier.send(f"[모의 청산 #{row['id']}] {row['name']} ({row['symbol']}) {EXIT_LABEL[reason]}: "
                           f"{qty_text(qty)} 매도 @ {money(price, c)} (매수 {money(row['fill_price'], c)}). "
                           f"손익 {signed_money(pnl, c)}{krw}, 수수료·세금 포함")

    def _cancel(self, row, now: datetime, note: str) -> None:
        self.store.update_paper_order(row["id"], status=CANCELED, closed_at=now.isoformat(), note=note)
        self.notifier.send(f"[모의 주문 #{row['id']}] {row['name']} ({row['symbol']}) 취소: {note}")

    # --- 계좌 ---

    def account_summary(self, prices: dict[str, float], fx_rate: float | None) -> dict:
        return account.summary(self.store, prices, fx_rate, self.rates)

    def buying_power_krw(self, fx_rate: float | None = None) -> float:
        return account.buying_power_krw(self.store, fx_rate, self.rates)

    def account_context(self, symbol: str, currency: str, fx_rate: float | None, prices: dict[str, float],
                        liquidity: float | None, warnings: list[str], max_total_krw: float | None,
                        cap_krw: float | None, today: date, *, style: str | None = None) -> AccountContext:
        """리스크 엔진 입력. 총자산 = 평가액, 매수 가능액은 시나리오 통화 (cap_krw가 있으면 그 값으로 줄인다).

        하루 주문 수·손실은 style을 주면 그 보유 방식의 주문만 센다 (단타 DAY 한도는 style day만 — docs/DECISIONS.md 14-4).
        """
        fx = account.fx_for(self.store, currency, fx_rate)
        s = self.account_summary(prices, fx_rate)
        power = s["buyingPowerKrw"] if s["buyingPowerKrw"] is not None else 0.0
        if cap_krw is not None:
            power = min(power, cap_krw)
        if style is None:
            trades_today, loss_today = self.store.paper_today(f"{today}")
        else:
            trades_today, loss_today = self.store.paper_today(f"{today}", style)
        return AccountContext(
            equity_krw=s["equityKrw"], buying_power=max(power, 0.0) / fx,
            commission_rate=self.rates[MARKET_OF[currency]], fx_rate=fx,
            position_value=sum(h["value"] for h in s["holdings"] if h["symbol"] == symbol),
            daily_loss_krw=loss_today, daily_trades=trades_today,
            avg_daily_trading_amount=liquidity, warnings=warnings,
            invested_krw=account.invested_krw(self.store, fx_rate), max_total_krw=max_total_krw)


def _opt_money(value: float | None, currency: str) -> str:
    return "없음" if value is None else money(value, currency)


def _num(value: float) -> str:
    """거절 문장의 가격 (정수면 소수점 없이)."""
    return f"{value:,.0f}" if float(value) == int(value) else f"{value:,.2f}"


def _kst(at: datetime) -> datetime:
    """KST 시각. 시간대가 없으면 KST로 본다."""
    return at.replace(tzinfo=KST) if at.tzinfo is None else at.astimezone(KST)


def _style(row) -> str:
    """주문의 보유 방식. style 열이 없는 행은 swing."""
    try:
        return row["style"] or SWING
    except (KeyError, IndexError):
        return SWING


def day_session(created_at: str) -> date:
    """단타 주문의 세션 날짜 = 접수 시각의 KST 날짜 (docs/API.md "단타 연습")."""
    return _kst(datetime.fromisoformat(created_at)).date()


def day_cutoff(created_at: str) -> datetime:
    """단타 주문의 진입 마감·강제 정리 시각 = 그 세션 날짜의 DAY_CLOSE_AT (KST)."""
    return datetime.combine(day_session(created_at), DAY_CLOSE_AT, KST)
