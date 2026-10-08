"""모의 주문 흐름 (웹용 Desk, docs/DECISIONS.md 8-1~8-3)과 run_engine 루프가 하는 일.

엔진 `trading.Desk`와 같은 순서다: 종목 확인 → 정규장 판단 → 확인 가격·환율 조회 → 엔진 `PaperExecutor`로 체결.
체결·계좌 계산 규칙은 엔진 것(PaperExecutor, records.account)을 그대로 쓰고 여기서 새로 쓰지 않는다.
정규장 밖 시장가 매수·전량 매도는 DB 예약(Reservation)으로 넣고 run_engine이 다음 정규장 시작에 실행한다.

화면에 보이는 평가(계좌·랭킹·일별 자산)는 **장마감 기준**(직전 정규장 종가, market.closes — 그 종가 뒤에 산 보유는 체결가, _today_fills)이고, 체결·청산·예약 실행·
목표·손절 순서 점검은 지금처럼 장중 확인 가격(market.confirmed_prices·last_price)을 쓴다 (docs/API.md 공통 규칙 "장마감 기준").
직접 주문의 시장가 장기 보유 점검 가격은 실시간 시세와 같은 현재가다 (market.quote_price, 2026-10-06).
주문의 보유 방식(style: swing·long)은 docs/API.md "보유 방식"을 따른다.

주문 변경은 엔진 주문 잠금(data/paper.lock) → DB 트랜잭션 → 계좌 행 잠금(select_for_update) 순서로 잡은 구간에서 한다.
웹 요청과 run_engine이 같은 순서로 잡으므로 서로 기다릴 뿐 엇갈려 막히지 않는다. 시세 조회는 잠금 밖에서 먼저 한다.
"""
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from accounts.models import Profile, profile_of
from django.db import IntegrityError, transaction
from django.utils import timezone
from paper_engine.agents.executor import STATUS_LABEL, OrderRejected, PaperExecutor, qty_text
from paper_engine.data.calendar import close_basis_day
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.judge.risk import LIMITS, AccountContext, assess_position
from paper_engine.records import account as paper_account
from paper_engine.records.account import ACTIVE, ENTRY_PENDING, EXIT_WATCHING, FxUnavailable
from paper_engine.scheduler import current_session, last_session_end, next_session_start
from paper_engine.trading import MAX_MANAGED_DAYS, RESERVED_BUY_MAX_DRIFT
from rest_framework.exceptions import NotFound

from config import engine
from config.api import Rejected, Unavailable

from . import market
from .models import LONG, STYLES, SWING, EquityDaily, PaperAccount, PaperOrder, Reservation
from .payloads import order_json, position_json, reservation_json
from .store import AccountStore, iso

KST = ZoneInfo("Asia/Seoul")
MARKET, LIMIT = "MARKET", "LIMIT"
NO_PRICE = "확인된 가격이 없어 주문하지 않음"
RESERVATION_RETRY = timedelta(minutes=10)  # 예약 실행이 일시 오류로 실패하면 정규장 시작 뒤 이만큼 다시 시도한다
DUPLICATE = "같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만)"
NEEDS_EXITS = "{label} 주문은 목표가와 손절가를 함께 지정해야 함 (기한은 선택)"
LONG_NO_EXITS = "장기 보유 주문은 목표가·손절가·기한을 받지 않음 (자동 매도 없음, 직접 팔 때까지 보유)"
LONG_FIXED = "장기 보유 주문은 목표가·손절가·기한을 바꿀 수 없음 (보유 방식은 주문 뒤에 바뀌지 않음)"
STYLE_LABEL = {SWING: "스윙", LONG: "장기 보유"}


class Blocked(Rejected):
    """리스크 점검에서 막힌 주문 → 400 {"detail", "reasonCodes"} (docs/API.md "실행 불가 사유 코드").

    reasons(사람이 읽는 사유)와 codes(사유 코드)는 같은 길이·같은 순서다. config.api의 예외 처리는 detail 밖의 필드를
    버리므로 뷰가 body()로 Response를 직접 만든다 (잡지 않으면 400 {"detail"}로 나간다).
    """

    def __init__(self, reasons: list[str], codes: list[str]):
        super().__init__("; ".join(reasons))
        self.reasons, self.codes = list(reasons), list(codes)

    def body(self) -> dict:
        return {"detail": "; ".join(self.reasons), "reasonCodes": list(self.codes)}


class Notes:
    """PaperExecutor의 알림 수집기. 마지막 send를 주문 결과 메시지로 쓴다. echo가 있으면 한 줄씩 넘긴다 (run_engine 콘솔)."""

    def __init__(self, echo=None):
        self.sent: list[str] = []
        self.echo = echo

    def send(self, text: str) -> None:
        self.sent.append(text)
        if self.echo:
            self.echo(text)

    def log(self, text: str) -> None:
        if self.echo:
            self.echo(text)

    @property
    def last(self) -> str:
        return self.sent[-1] if self.sent else ""


def now() -> datetime:
    return timezone.localtime()


def executor_for(store: AccountStore, notes: Notes) -> PaperExecutor:
    return PaperExecutor(store, notes, engine.HALT_FILE, engine.engine_config().commission)


@contextmanager
def locked(account: PaperAccount, notes: Notes):
    """주문 변경 구간. 그 계좌의 PaperExecutor를 돌려준다."""
    executor = executor_for(AccountStore(account), notes)
    with executor.lock, transaction.atomic():
        PaperAccount.objects.select_for_update().get(pk=account.pk)
        yield executor


@contextmanager
def _rejects():
    """엔진의 주문 거절과 같은 종목 중복(부분 유일 인덱스) → 400."""
    try:
        yield
    except OrderRejected as e:
        raise Rejected(str(e)) from None
    except IntegrityError:
        raise Rejected(DUPLICATE) from None


def fx_if_needed(store: AccountStore, currency: str = "KRW") -> float | None:
    """주문 종목이나 진행 중 주문에 달러 종목이 있을 때만 환율을 조회한다."""
    if currency == "USD" or any(r["currency"] == "USD" for r in store.paper_orders(ACTIVE)):
        return market.fx_rate()
    return None


def _expire(days: int | None, at: datetime) -> str | None:
    """보유 기한 = at의 **한국 날짜** + days (달력 일수). at이 UTC여도 00:00~09:00 KST에 하루 앞당겨지지 않게 KST로 바꿔 본다."""
    if days is None:
        return None
    if not 1 <= days <= MAX_MANAGED_DAYS:
        raise Rejected(f"기한은 1~{MAX_MANAGED_DAYS}일")
    return f"{timezone.localtime(at).date() + timedelta(days=days)}"


def order_style(style: str | None, target: float | None, stop: float | None, days: int | None) -> str:
    """보유 방식 (docs/API.md "보유 방식"). style이 없으면 목표·손절·기한이 모두 없을 때 long, 하나라도 있으면 swing.

    swing은 목표가와 손절가가 둘 다 있어야 하고, long은 셋 다 받지 않는다. 어기면 Rejected.
    """
    no_exits = target is None and stop is None and days is None
    if style is None:
        style = LONG if no_exits else SWING
    if style not in STYLES:
        raise Rejected("style은 swing 또는 long입니다.")
    if style == LONG and not no_exits:
        raise Rejected(LONG_NO_EXITS)
    if style == SWING and (target is None or stop is None):
        raise Rejected(NEEDS_EXITS.format(label=STYLE_LABEL[style]))
    return style


def order_of(store: AccountStore, order_id: int) -> dict:
    row = store.paper_order(order_id)
    if row is None:
        raise NotFound("모의 주문을 찾을 수 없습니다.")
    return row


def result(order: dict | None, reservation: Reservation | None, message: str) -> dict:
    """OrderResult."""
    return {"order": None if order is None else order_json(order),
            "reservation": None if reservation is None else reservation_json(reservation, run_at(reservation)),
            "message": message}


# --- 주문 ---

def buy(account: PaperAccount, username: str, symbol: str, quantity: float, order_type: str, limit: float | None,
        target: float | None, stop: float | None, days: int | None, at: datetime, *, style: str | None = None) -> dict:
    """모의 매수 → OrderResult. 정규장 밖 시장가는 예약, 정규장 밖 지정가는 체결 대기로 접수한다.

    style(swing·long)이 없으면 order_style의 추론 규칙. long은 엔진 비중 점검(assess_position — 시장가는 현재가,
    자산은 장마감 기준)을 먼저 통과해야 하고 막히면 Blocked.
    """
    style = order_style(style, target, stop, days)
    item = market.stock_item(symbol)
    if item is None:
        raise Rejected(f"'{symbol}' 종목을 찾을 수 없음")
    symbol, name, mkt = item["symbol"], item["name"], item["market"]
    currency = market.CURRENCY[mkt]
    info = market.stock_info(symbol)
    if info is not None and info.get("status", "ACTIVE") != "ACTIVE":
        raise Rejected(f"{name}({symbol})은(는) 거래 가능한 상태가 아님 ({info.get('status')})")
    if order_type == MARKET:
        limit = None
    expire = _expire(days, at)
    if style == LONG:
        check_long(account, item, quantity, limit, at)
    open_ = market.is_open(mkt, at)
    store = AccountStore(account)
    if limit is None and not open_:
        return _reserve_buy(account, item, quantity, target, stop, days, at, style)
    price = market.confirmed_price(symbol) if open_ else market.last_price(symbol)
    if price is None:
        raise Rejected(NO_PRICE)
    fx = fx_if_needed(store, currency)
    notes = Notes()
    with _rejects(), locked(account, notes) as executor:
        oid = executor.buy(symbol, name, mkt, currency, quantity, price, fx, at, username, limit, target, stop,
                           expire, regular_open=open_, style=style)
    return result(store.paper_order(oid), None, notes.last)


def check_long(account: PaperAccount, item: dict, quantity: float, limit: float | None, at: datetime) -> None:
    """장기 보유 매수의 비중 점검 (엔진 assess_position: 매수 가능 금액·종목당 비중 한도 100%·총 금액 한도). 막히면 Blocked.

    가격은 지정가 주문이면 지정가, 시장가면 현재가 (실시간 시세와 같은 값 — 화면의 예상 금액과 같다. 받지 못하면 직전 종가).
    자산·매수 가능 금액은 장마감 기준 평가(summary)다.
    수량은 사용자가 정하고 이 점검은 줄이지 않는다. 수량·가격이 0 이하면 엔진 접수 점검이 사유를 내므로 여기서는 넘긴다.
    """
    symbol, mkt = item["symbol"], item["market"]
    currency = market.CURRENCY[mkt]
    price = limit if limit is not None else market.quote_price(symbol)
    if price is None:
        raise Rejected(NO_PRICE)
    if quantity <= 0 or price <= 0:
        return
    store = AccountStore(account)
    fx_rate = fx_if_needed(store, currency)
    try:
        fx = paper_account.fx_for(store, currency, fx_rate)
        invested = paper_account.invested_krw(store, fx_rate)
    except FxUnavailable as e:
        raise Rejected(str(e)) from None
    s = summary(account, at)
    power = s["buyingPowerKrw"] if s["buyingPowerKrw"] is not None else 0.0
    cfg = engine.engine_config()
    ctx = AccountContext(
        equity_krw=s["equityKrw"], buying_power=max(power, 0.0) / fx, commission_rate=cfg.commission[mkt], fx_rate=fx,
        position_value=sum(p["valueKrw"] for p in s["positions"] if p["symbol"] == symbol) / fx,
        invested_krw=invested, max_total_krw=cfg.max_total_invest_krw)
    ok, reasons, codes = assess_position(price, quantity, ctx, LIMITS["LONG_TERM"])
    if not ok:
        raise Blocked(reasons, codes)


def _reserve_buy(account: PaperAccount, item: dict, quantity: float, target: float | None, stop: float | None,
                 days: int | None, at: datetime, style: str) -> dict:
    """정규장 밖 시장가 매수 → 예약. 보유 방식은 받을 때 정한 style을 저장하고 실행할 때 그대로 쓴다 (다시 추론하지 않는다)."""
    symbol, name, mkt = item["symbol"], item["name"], item["market"]
    currency = market.CURRENCY[mkt]
    price = market.last_price(symbol)
    if price is None:
        raise Rejected(NO_PRICE)
    store = AccountStore(account)
    fx = fx_if_needed(store, currency)
    with _rejects(), locked(account, Notes()) as executor:
        reasons = executor.buy_blockers(symbol, mkt, currency, quantity, price, None, fx, target, stop, True,
                                        style=style)
        if Reservation.objects.filter(account=account, kind="BUY", symbol=symbol).exists():
            reasons.append("같은 종목의 매수 예약이 이미 있음")
        if reasons:
            raise Rejected("; ".join(reasons))
        r = Reservation.objects.create(account=account, kind="BUY", symbol=symbol, name=name, market=mkt,
                                       currency=currency, quantity=quantity, target_price=target, stop_price=stop,
                                       days=days, reference_price=price, created_at=at, style=style)
    return result(None, r, f"[예약 #{r.id}] {name} ({symbol}) {qty_text(quantity)} 시장가 매수 예약 "
                           f"({STYLE_LABEL[style]}). {_when(r)} 정규장 시작 때 실행")


def sell(account: PaperAccount, username: str, order_id: int, at: datetime) -> dict:
    """보유 전량 매도 → OrderResult. 대기 주문이면 취소, 정규장 밖이면 매도 예약."""
    store = AccountStore(account)
    row = order_of(store, order_id)
    notes = Notes()
    if row["status"] == ENTRY_PENDING:
        with _rejects(), locked(account, notes) as executor:
            # 상태는 잠금 밖에서 읽었다. 그사이 run_engine이 체결했으면 취소하지 않고 아래에서 매도한다
            pending = store.paper_order(order_id)["status"] == ENTRY_PENDING
            if pending:
                executor.cancel(order_id, at, username)
        row = store.paper_order(order_id)
        if pending:
            return result(row, None, notes.last)
    if row["status"] != EXIT_WATCHING:
        raise Rejected(f"모의 주문 #{order_id}은(는) 이미 {STATUS_LABEL[row['status']]} 상태")
    if not market.is_open(row["market"], at):
        with locked(account, notes):
            if Reservation.objects.filter(account=account, kind="SELL", order_id=order_id).exists():
                raise Rejected(f"모의 주문 #{order_id}의 매도 예약이 이미 있음")
            r = Reservation.objects.create(account=account, kind="SELL", symbol=row["symbol"], name=row["name"],
                                           market=row["market"], currency=row["currency"],
                                           quantity=row["filled_quantity"], order_id=order_id,
                                           reference_price=row["fill_price"], created_at=at)
        return result(row, r, f"[예약 #{r.id}] {row['name']} ({row['symbol']}) 모의 주문 #{order_id} 전량 시장가 매도 예약. "
                              f"{_when(r)} 정규장 시작 때 실행")
    price = market.confirmed_price(row["symbol"])
    if price is None:
        raise Rejected(NO_PRICE)
    fx = fx_if_needed(store, row["currency"])
    with _rejects(), locked(account, notes) as executor:
        executor.sell(order_id, price, fx, at, username)
    return result(store.paper_order(order_id), None, notes.last)


def cancel(account: PaperAccount, username: str, order_id: int, at: datetime) -> dict:
    """체결 대기 주문 취소 → Order."""
    store = AccountStore(account)
    order_of(store, order_id)
    with _rejects(), locked(account, Notes()) as executor:
        executor.cancel(order_id, at, username)
    return order_json(store.paper_order(order_id))


def modify(account: PaperAccount, order_id: int, target: float | None, stop: float | None, days: int | None,
           at: datetime) -> dict:
    """목표가·손절가·기한 수정 → Order. 현재가를 받으면 손절가 < 현재가 < 목표가 순서를 본다 (장중 가격, 문장에는 숫자 없음).

    보유 방식은 바뀌지 않는다: long은 셋 다 받지 않는다.
    """
    store = AccountStore(account)
    row = order_of(store, order_id)
    style = row.get("style") or SWING
    if style == LONG and (target is not None or stop is not None or days is not None):
        raise Rejected(LONG_FIXED)
    expire = _expire(days, at)
    try:
        price = market.last_price(row["symbol"])
    except Unavailable:
        price = None
    with _rejects(), locked(account, Notes()) as executor:
        executor.modify(order_id, price, target, stop, expire, at)
    return order_json(store.paper_order(order_id))


def delete_reservation(account: PaperAccount, reservation_id: int) -> None:
    if not Reservation.objects.filter(account=account, pk=reservation_id).delete()[0]:
        raise NotFound("예약을 찾을 수 없습니다.")


# --- 조회 ---

def _held_prices(symbols: list[str]) -> tuple[dict[str, dict], str | None]:
    """보유 종목의 직전 정규장 종가 (평가용, 장마감 기준): {symbol: market.closes 값}.

    모든 보유 종목을 한 번에 받는다 (예산 = 종목 수, 같은 종목·기준일은 하루 캐시). 받지 못한 종목은 빠지고 체결가로
    평가한다 (엔진 account.summary 방식). 종목 목록·시세를 아예 받지 못하면 ({}, 사유).
    """
    if not symbols:
        return {}, None
    try:
        return market.closes(symbols, budget=[len(symbols)]), None
    except Unavailable as e:
        return {}, str(e)


def _as_of(closes: dict[str, dict], markets: dict[str, str]) -> dict[str, str]:
    """평가에 쓴 종가의 기준 시각 (시장별 pricesAsOf): 그 시장 보유 종목 종가 asOf 중 가장 늦은 것. 종가가 없는 시장은 뺀다."""
    out: dict[str, str] = {}
    for symbol, close in closes.items():
        m = markets.get(symbol)
        if m and close.get("asOf") and (m not in out or datetime.fromisoformat(close["asOf"]) >
                                        datetime.fromisoformat(out[m])):
            out[m] = close["asOf"]
    return out


def _today_fills(rows: list[tuple], closes: dict[str, dict]) -> dict[int, dict[str, float]]:
    """오늘 산 종목 (docs/API.md "장마감 기준"의 "오늘 산 종목"): 체결 시각이 그 종목 평가 종가의 asOf보다 뒤인 보유.

    rows는 (계좌 id, 종목, 체결가, 체결 시각). {계좌 id: {종목: 체결가}} — 같은 종목도 계좌마다 체결 시각이 달라 계좌별로 둔다.
    종가를 받지 못한 종목은 빠진다 (그때는 어차피 체결가로 평가한다 — priceBasis fill).
    """
    out: dict[int, dict[str, float]] = {}
    for account_id, symbol, fill_price, filled_at in rows:
        as_of = closes.get(symbol, {}).get("asOf")
        if as_of and filled_at and filled_at > datetime.fromisoformat(as_of):
            out.setdefault(account_id, {})[symbol] = fill_price
    return out


def _account_summary(store: AccountStore, prices: dict[str, float], today: dict[str, float], fx: float | None,
                     rates: dict[str, float]) -> dict:
    """records.account.summary에 보유마다 priceBasis를 붙인다 (close · today_fill · fill).

    오늘 산 종목(today)은 종가 대신 체결가로 평가하고(손익 0) lastPrice는 직전 종가 그대로 둔다.
    """
    s = paper_account.summary(store, prices | today, fx, rates)
    for h in s["holdings"]:
        if h["symbol"] in today:
            h.update(lastPrice=prices[h["symbol"]], priceBasis="today_fill")
        else:
            h["priceBasis"] = "close" if h["priced"] else "fill"
    return s


def _valuations(accounts: list[PaperAccount]) -> tuple[dict[int, dict], str | None, dict[str, str], list[str]]:
    """계좌별 records.account.summary (장마감 기준, 오늘 산 종목은 체결가). 보유 종목 종가는 모든 계좌를 묶어 한 번에 받는다.

    (계좌별 요약, 종가 조회 실패 사유, 시장별 pricesAsOf, 종가를 받지 못한 보유 종목)을 돌려준다.
    """
    orders = PaperOrder.objects.filter(account__in=accounts)
    rows = list(orders.filter(status=EXIT_WATCHING).values_list("account_id", "symbol", "market", "fill_price",
                                                                 "filled_at"))
    held = {symbol: mkt for _, symbol, mkt, _, _ in rows}
    symbols = sorted(held)
    closes, note = _held_prices(symbols)
    prices = {s: c["price"] for s, c in closes.items()}
    today = _today_fills([(a, s, price, at) for a, s, _, price, at in rows], closes)
    fx = market.fx_rate() if orders.filter(status__in=ACTIVE, currency="USD").exists() else None
    rates = engine.engine_config().commission
    values = {a.id: _account_summary(AccountStore(a), prices, today.get(a.id, {}), fx, rates) for a in accounts}
    return values, note, _as_of(closes, held), [s for s in symbols if s not in prices]


def _profit_rate(s: dict) -> float:
    initial = s["initialCapitalKrw"]
    return s["equityKrw"] / initial - 1 if initial else 0.0


def _close_note(text: str) -> str:
    """엔진 안내 문장의 "현재가"를 장마감 기준 표현으로 ("현재가를 받지 못해 체결가로 평가" → "종가를 받지 못해 …")."""
    return text.replace("현재가를 받지 못해", "종가를 받지 못해")


def summary(account: PaperAccount, at: datetime) -> dict:
    """AccountSummary (장마감 기준 평가). 종가를 받지 못해도 체결가로 평가해 돌려주고 notes에 사유를 남긴다."""
    store = AccountStore(account)
    orders = {r["id"]: r for r in store.paper_orders((EXIT_WATCHING,))}
    values, note, as_of, _ = _valuations([account])
    s = values[account.id]
    positions = [position_json(h, orders.get(h["id"]) or store.paper_order(h["id"])) for h in s["holdings"]]
    return {
        "initialCapitalKrw": s["initialCapitalKrw"], "cashKrw": s["cashKrw"], "holdingsValueKrw": s["holdingsValueKrw"],
        "equityKrw": s["equityKrw"], "investedKrw": sum(p["costKrw"] for p in positions),
        "profitKrw": s["profitKrw"], "profitRate": _profit_rate(s), "pendingKrw": s["pendingKrw"],
        "buyingPowerKrw": s["buyingPowerKrw"], "positions": positions,
        "notes": ([f"종가를 조회하지 못해 체결가로 평가함: {note}"] if note else []) + [_close_note(n) for n in s["notes"]],
        "pricesAsOf": as_of,
        "asOf": at.isoformat(),
    }


def equity_points(account: PaperAccount, days: int) -> list[dict]:
    rows = list(EquityDaily.objects.filter(account=account).order_by("-day")[:days])[::-1]
    return [{"day": iso(r.day), "equityKrw": r.equity_krw} for r in rows]


def run_at(r: Reservation, sessions: dict | None = None) -> str | None:
    """예약 실행 예정: 예약 뒤 처음 시작하는 정규장 (지났으면 다음 정규장). 장 달력을 받지 못하면 None."""
    sessions = {} if sessions is None else sessions
    try:
        if r.market not in sessions:
            sessions[r.market] = market.sessions(r.market)
    except Unavailable:
        return None
    found = sessions[r.market]
    start = next_session_start(found, r.created_at) or next_session_start(found, now())
    return iso(start)


def _when(r: Reservation) -> str:
    start = run_at(r)
    return f"{datetime.fromisoformat(start):%m-%d %H:%M}" if start else "다음"


def reservations(account: PaperAccount) -> list[dict]:
    sessions: dict = {}
    return [reservation_json(r, run_at(r, sessions)) for r in Reservation.objects.filter(account=account).order_by("id")]


def market_status(at: datetime) -> dict:
    """MarketStatus. 증권사 키가 없거나 장 달력을 받지 못하면 그 시장은 닫힘·시각 null로 둔다.

    closeDate·lastCloseAt은 그 시장의 장마감 기준일과 그날 정규장 종료 시각 (장 달력으로 계산한 값, 못 받으면 null).
    """
    cfg = engine.engine_config()
    ready = engine.broker_client() is not None
    markets = []
    for m in cfg.markets:
        entry = {"market": m, "isOpen": False, "opensAt": None, "closesAt": None, "closeDate": None, "lastCloseAt": None}
        if ready:
            try:
                found = market.sessions(m)
            except Unavailable:
                found = []
            session = current_session(found, at)
            if session:
                entry.update(isOpen=True, opensAt=iso(session[0]), closesAt=iso(session[1]))
            else:
                entry["opensAt"] = iso(next_session_start(found, at))
            close = market.basis(m)
            if close:
                entry.update(closeDate=close["date"], lastCloseAt=close["asOf"])
        markets.append(entry)
    return {"markets": markets, "halted": engine.HALT_FILE.exists(), "brokerReady": ready,
            "quoteProvider": market.quote_provider()}


def ranking(user, at: datetime) -> dict:
    """Ranking (장마감 기준 평가). 내 정보 공개를 켠 사용자만 results에 넣고, 닉네임과 수익률 말고는 내지 않는다.

    pricesAsOf는 평가한 계좌들(공개 사용자 + 나)이 보유한 시장의 종가 기준 시각이다.
    """
    public = list(Profile.objects.filter(is_public=True, user__is_active=True).select_related("user"))
    mine = profile_of(user)
    accounts = {a.user_id: a for a in PaperAccount.objects.filter(user_id__in={p.user_id for p in public} | {user.pk})}
    values, _, as_of, _ = _valuations(list(accounts.values()))

    def rate(user_id: int) -> float:
        a = accounts.get(user_id)
        return _profit_rate(values[a.id]) if a else 0.0

    ordered = sorted(((rate(p.user_id), p.nickname, p.user_id) for p in public), key=lambda e: (-e[0], e[1]))
    results = [{"rank": i, "nickname": nickname, "profitRate": r, "isMe": uid == user.pk}
               for i, (r, nickname, uid) in enumerate(ordered, 1)]
    my_rank = next((e["rank"] for e in results if e["isMe"]), None)
    return {"results": results,
            "me": {"isPublic": mine.is_public, "rank": my_rank if mine.is_public else None, "profitRate": rate(user.pk)},
            "pricesAsOf": as_of, "asOf": at.isoformat()}


# --- run_engine 루프 ---

def sync_accounts(at: datetime, log) -> int:
    """진행 중 주문이 있는 모든 계좌의 체결·청산 확인 (엔진 Desk.sync와 같은 인자). 확인 가격은 묶어 한 번에 받는다."""
    rows = list(PaperOrder.objects.filter(status__in=ACTIVE).values("account_id", "market", "symbol", "currency"))
    if not rows:
        return 0
    sessions = _sessions(sorted({r["market"] for r in rows}), log)  # 장 달력을 받지 못한 시장은 이번에 건너뛴다
    open_markets = {m for m, found in sessions.items() if current_session(found, at)}
    last_close = {m: last_session_end(found, at) for m, found in sessions.items()}
    # 현재가 한 건만 믿지 않는다. 호가와 함께 본 가격을 쓴다 (튀는 체결가 대비).
    prices = market.confirmed_prices(sorted({r["symbol"] for r in rows if r["market"] in open_markets}))
    fx = market.fx_rate() if any(r["currency"] == "USD" for r in rows) else None
    for account in PaperAccount.objects.filter(pk__in={r["account_id"] for r in rows}).order_by("id"):
        try:
            with locked(account, Notes(log)) as executor:
                executor.sync(prices, at, open_markets, fx, last_close)
        except Exception as e:  # 한 계좌의 문제가 다른 계좌의 체결 확인을 막지 않게
            log(f"계좌 {account.name} 체결 확인 실패: {e}")
    return len(rows)


def _sessions(markets, log) -> dict[str, list]:
    """시장별 정규장 목록. 장 달력을 받지 못한 시장은 빼고 로그에 남긴다 (한 시장의 실패가 다른 시장을 멈추지 않게)."""
    found = {}
    for m in markets:
        try:
            found[m] = market.sessions(m)
        except Unavailable as e:
            log(f"{m} 장 운영 정보를 받지 못해 이번 확인에서 건너뜀: {e}")
    return found


def run_reservations(at: datetime, log) -> int:
    """시장이 열린 예약을 실행한다. 실행한 수를 돌려준다.

    실행했거나 거절된 예약은 지우고 사유를 로그에 남긴다. 증권사 조회 실패 같은 일시 오류는 정규장 시작 뒤
    RESERVATION_RETRY 동안 다음 확인에서 다시 시도하고, 그래도 안 되면 지운다.
    """
    reservations = list(Reservation.objects.select_related("account__user").order_by("id"))
    markets = engine.engine_config().markets
    sessions = _sessions(sorted({r.market for r in reservations if r.market in markets}), log)
    done = 0
    for r in reservations:
        if r.market not in sessions:
            continue
        session = current_session(sessions[r.market], at)
        if not session or session[0] <= r.created_at:
            continue
        if not Reservation.objects.filter(pk=r.pk).delete()[0]:
            continue  # 그사이 취소됨
        label = f"[예약 #{r.id}] {r.account.name} {r.name} ({r.symbol}) {'매도' if r.kind == 'SELL' else '매수'}"
        log(f"{label} 실행")
        try:
            execute_reservation(r, at, Notes(log))
            done += 1
        except (OrderRejected, Rejected) as e:
            log(f"{label} 실행하지 않음: {e}")
        except IntegrityError:
            log(f"{label} 실행하지 않음: {DUPLICATE}")
        except (Unavailable, KiwoomApiError, OSError) as e:
            if at - session[0] < RESERVATION_RETRY:
                r.save(force_insert=True)  # 같은 번호로 되살려 다음 확인에서 다시 시도한다
                log(f"{label} 실패, 다시 시도 예정: {e}")
            else:
                log(f"{label} 실패 (정규장 시작 뒤 {RESERVATION_RETRY.seconds // 60}분 동안 실행하지 못해 예약을 지움): {e}")
    return done


def execute_reservation(r: Reservation, at: datetime, notes: Notes) -> None:
    """예약 실행. 점검은 즉시 주문과 같다 (엔진 Desk.run_reservation). 실행하지 못하면 OrderRejected."""
    account = r.account
    store = AccountStore(account)
    username = account.user.username
    if r.kind == "SELL":
        row = store.paper_order(r.order_id)
        if row is None or row["status"] != EXIT_WATCHING:
            raise OrderRejected(f"모의 주문 #{r.order_id}이(가) 보유 중이 아님 (이미 청산됐을 수 있음)")
        price = market.confirmed_price(r.symbol)
        if price is None:
            raise Unavailable("확인 가격을 받지 못함")  # 일시 오류: 다시 시도한다
        fx = fx_if_needed(store, row["currency"])
        with locked(account, notes) as executor:
            executor.sell(r.order_id, price, fx, at, username)
        return
    price = market.confirmed_price(r.symbol)
    if price is None:
        raise Unavailable("확인 가격을 받지 못함")  # 일시 오류: 다시 시도한다
    if r.reference_price:
        drift = abs(price / r.reference_price - 1)
        if drift > RESERVED_BUY_MAX_DRIFT:
            raise OrderRejected(f"현재가 {price:,}가 예약 때 가격 {r.reference_price:,}에서 {drift:.1%} 벗어남 "
                                f"(허용 {RESERVED_BUY_MAX_DRIFT:.0%})")
    # 받을 때 정한 보유 방식 그대로 (다시 추론하지 않는다). 2026-10-04 전 예약은 마이그레이션이 채웠고, 비었으면 같은 규칙
    style = r.style or (LONG if r.target_price is None and r.stop_price is None and r.days is None else SWING)
    expire = None if style == LONG else _expire(r.days, at)  # 기한은 실행한 날(KST)부터
    fx = fx_if_needed(store, r.currency)
    with locked(account, notes) as executor:
        executor.buy(r.symbol, r.name, r.market, r.currency, r.quantity, price, fx, at, username,
                     target=r.target_price, stop=r.stop_price, expire_date=expire, style=style)


def record_equity(at: datetime, log) -> int:
    """일별 자산: 기준 시장(KR)의 장마감 기준일이 오늘이 되고 (국내 거래일 15:40 KST = 정규장 종료 + 10분 이후 — 수능일 같은
    특별 운영일은 장 달력의 늦은 종료 + 10분) 그날 종가가 굳은 뒤 (현지 17:00, market.CLOSE_FINAL_AT) 하루 한 번
    계좌별로 남긴다 (그 기준일). 기록한 계좌 수를 돌려준다.

    평가는 화면과 같은 장마감 기준이다: 국내 보유는 그날 종가, 미국 보유는 그때의 최신 미국 종가 (AccountSummary.pricesAsOf와 같은 값).
    종목 목록에 없는 보유 종목(상장 폐지 등 — 다시 해도 종가가 오지 않는다)은 화면처럼 체결가로 평가하고 로그에 남긴다.
    종목 목록에 있는데 종가를 받지 못한 종목(일시 오류)이 있으면 그 종목을 가진 계좌만 미루고 나머지는 기록한 뒤 오류를 낸다
    (다음 루프에서 미룬 계좌만 다시 한다). 종목 목록·장 달력을 아예 받지 못하면 기록하지 않고 오류.
    """
    markets = engine.engine_config().markets
    base = "KR" if "KR" in markets else markets[0]
    day = close_basis_day(market.calendar(base), base, at)
    if day is None or day != f"{at.astimezone(market.MARKET_TZ[base]).date()}" or not market.close_final(base, day, at):
        return 0
    day = date.fromisoformat(day)
    accounts = list(PaperAccount.objects.exclude(equity_days__day=day).order_by("id"))
    if not accounts:
        return 0
    values, note, _, missing = _valuations(accounts)
    if note:
        raise RuntimeError(f"보유 종목 종가를 받지 못해 일별 자산 기록을 미룸: {note}")
    gone = market.unlisted(missing)  # 체결가로 평가 (summary와 같다)
    pending = sorted(set(missing) - gone)
    held = list(PaperOrder.objects.filter(account__in=accounts, status=EXIT_WATCHING, symbol__in=missing)
                .values_list("account_id", "symbol")) if missing else []
    blocked = {a for a, symbol in held if symbol not in gone}
    ready = [a for a in accounts if a.id not in blocked]
    at_fill = sorted({symbol for a, symbol in held if symbol in gone and a not in blocked})
    for a in ready:
        s = values[a.id]
        EquityDaily.objects.update_or_create(account=a, day=day, defaults={
            "cash_krw": s["cashKrw"], "holdings_value_krw": s["holdingsValueKrw"], "equity_krw": s["equityKrw"],
            "recorded_at": at})
    if ready:
        log(f"[자산 기록] {day}: 계좌 {len(ready)}개"
            + (f" (종목 목록에 없어 체결가로 평가: {', '.join(at_fill)})" if at_fill else ""))
    if pending:
        raise RuntimeError(f"보유 종목 종가를 받지 못해 계좌 {len(blocked)}개의 일별 자산 기록을 미룸: {', '.join(pending)}")
    return len(ready)
