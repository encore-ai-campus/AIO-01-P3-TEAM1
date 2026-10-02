"""모의 주문 흐름 (웹용 Desk, docs/DECISIONS.md 8-1~8-3)과 run_engine 루프가 하는 일.

엔진 `trading.Desk`와 같은 순서다: 종목 확인 → 정규장 판단 → 확인 가격·환율 조회 → 엔진 `PaperExecutor`로 체결.
체결·계좌 계산 규칙은 엔진 것(PaperExecutor, records.account)을 그대로 쓰고 여기서 새로 쓰지 않는다.
정규장 밖 시장가 매수·전량 매도는 DB 예약(Reservation)으로 넣고 run_engine이 다음 정규장 시작에 실행한다.

주문 변경은 엔진 주문 잠금(data/paper.lock) → DB 트랜잭션 → 계좌 행 잠금(select_for_update) 순서로 잡은 구간에서 한다.
웹 요청과 run_engine이 같은 순서로 잡으므로 서로 기다릴 뿐 엇갈려 막히지 않는다. 시세 조회는 잠금 밖에서 먼저 한다.
"""
from contextlib import contextmanager
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from accounts.models import Profile, profile_of
from django.db import IntegrityError, transaction
from django.utils import timezone
from paper_engine.agents.executor import STATUS_LABEL, OrderRejected, PaperExecutor, qty_text
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.records import account as paper_account
from paper_engine.records.account import ACTIVE, ENTRY_PENDING, EXIT_WATCHING
from paper_engine.scheduler import current_session, last_session_end, next_session_start
from paper_engine.trading import MAX_MANAGED_DAYS, RESERVED_BUY_MAX_DRIFT
from rest_framework.exceptions import NotFound

from config import engine
from config.api import Rejected, Unavailable

from . import market
from .models import EquityDaily, PaperAccount, PaperOrder, Reservation
from .payloads import order_json, position_json, reservation_json
from .store import AccountStore, iso

KST = ZoneInfo("Asia/Seoul")
MARKET, LIMIT = "MARKET", "LIMIT"
NO_PRICE = "확인된 가격이 없어 주문하지 않음"
RESERVATION_RETRY = timedelta(minutes=10)  # 예약 실행이 일시 오류로 실패하면 정규장 시작 뒤 이만큼 다시 시도한다
DUPLICATE = "같은 종목에 진행 중인 모의 주문이 있음 (같은 종목은 포지션 하나만)"


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
    if days is None:
        return None
    if not 1 <= days <= MAX_MANAGED_DAYS:
        raise Rejected(f"기한은 1~{MAX_MANAGED_DAYS}일")
    return f"{at.date() + timedelta(days=days)}"


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
        target: float | None, stop: float | None, days: int | None, at: datetime) -> dict:
    """모의 매수 → OrderResult. 정규장 밖 시장가는 예약, 정규장 밖 지정가는 체결 대기로 접수한다."""
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
    open_ = market.is_open(mkt, at)
    store = AccountStore(account)
    if limit is None and not open_:
        return _reserve_buy(account, item, quantity, target, stop, days, at)
    price = market.confirmed_price(symbol) if open_ else market.last_price(symbol)
    if price is None:
        raise Rejected(NO_PRICE)
    fx = fx_if_needed(store, currency)
    notes = Notes()
    with _rejects(), locked(account, notes) as executor:
        oid = executor.buy(symbol, name, mkt, currency, quantity, price, fx, at, username, limit, target, stop,
                           expire, regular_open=open_)
    return result(store.paper_order(oid), None, notes.last)


def _reserve_buy(account: PaperAccount, item: dict, quantity: float, target: float | None, stop: float | None,
                 days: int | None, at: datetime) -> dict:
    symbol, name, mkt = item["symbol"], item["name"], item["market"]
    currency = market.CURRENCY[mkt]
    price = market.last_price(symbol)
    if price is None:
        raise Rejected(NO_PRICE)
    store = AccountStore(account)
    fx = fx_if_needed(store, currency)
    with _rejects(), locked(account, Notes()) as executor:
        reasons = executor.buy_blockers(symbol, mkt, currency, quantity, price, None, fx, target, stop, True)
        if Reservation.objects.filter(account=account, kind="BUY", symbol=symbol).exists():
            reasons.append("같은 종목의 매수 예약이 이미 있음")
        if reasons:
            raise Rejected("; ".join(reasons))
        r = Reservation.objects.create(account=account, kind="BUY", symbol=symbol, name=name, market=mkt,
                                       currency=currency, quantity=quantity, target_price=target, stop_price=stop,
                                       days=days, reference_price=price, created_at=at)
    return result(None, r, f"[예약 #{r.id}] {name} ({symbol}) {qty_text(quantity)} 시장가 매수 예약. "
                           f"{_when(r)} 정규장 시작 때 실행")


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
    """목표가·손절가·기한 수정 → Order. 현재가를 받으면 손절가 < 현재가 < 목표가 순서를 본다."""
    store = AccountStore(account)
    row = order_of(store, order_id)
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

def _held_prices(symbols: list[str]) -> tuple[dict[str, float], str | None]:
    """보유 종목 현재가 (평가용). 받지 못하면 ({}, 사유) — 그때는 체결가로 평가한다 (엔진 account.summary 방식)."""
    if not symbols:
        return {}, None
    try:
        return market.current_prices(symbols), None
    except Unavailable as e:
        return {}, str(e)


def _valuations(accounts: list[PaperAccount]) -> tuple[dict[int, dict], str | None]:
    """계좌별 records.account.summary. 보유 종목 현재가는 모든 계좌를 묶어 한 번에 조회한다."""
    orders = PaperOrder.objects.filter(account__in=accounts)
    symbols = sorted(set(orders.filter(status=EXIT_WATCHING).values_list("symbol", flat=True)))
    prices, note = _held_prices(symbols)
    fx = market.fx_rate() if orders.filter(status__in=ACTIVE, currency="USD").exists() else None
    rates = engine.engine_config().commission
    return {a.id: paper_account.summary(AccountStore(a), prices, fx, rates) for a in accounts}, note


def _profit_rate(s: dict) -> float:
    initial = s["initialCapitalKrw"]
    return s["equityKrw"] / initial - 1 if initial else 0.0


def summary(account: PaperAccount, at: datetime) -> dict:
    """AccountSummary. 시세를 받지 못해도 체결가로 평가해 돌려주고 notes에 사유를 남긴다."""
    store = AccountStore(account)
    orders = {r["id"]: r for r in store.paper_orders((EXIT_WATCHING,))}
    values, note = _valuations([account])
    s = values[account.id]
    positions = [position_json(h, orders.get(h["id"]) or store.paper_order(h["id"])) for h in s["holdings"]]
    return {
        "initialCapitalKrw": s["initialCapitalKrw"], "cashKrw": s["cashKrw"], "holdingsValueKrw": s["holdingsValueKrw"],
        "equityKrw": s["equityKrw"], "investedKrw": sum(p["costKrw"] for p in positions),
        "profitKrw": s["profitKrw"], "profitRate": _profit_rate(s), "pendingKrw": s["pendingKrw"],
        "buyingPowerKrw": s["buyingPowerKrw"], "positions": positions,
        "notes": ([f"시세를 조회하지 못해 체결가로 평가함: {note}"] if note else []) + s["notes"],
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
    """MarketStatus. 증권사 키가 없거나 장 달력을 받지 못하면 그 시장은 닫힘·시각 null로 둔다."""
    ready = engine.broker_client() is not None
    markets = []
    for m in engine.engine_config().markets:
        entry = {"market": m, "isOpen": False, "opensAt": None, "closesAt": None}
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
        markets.append(entry)
    return {"markets": markets, "halted": engine.HALT_FILE.exists(), "brokerReady": ready}


def ranking(user, at: datetime) -> dict:
    """Ranking. 내 정보 공개를 켠 사용자만 results에 넣고, 닉네임과 수익률 말고는 내지 않는다."""
    public = list(Profile.objects.filter(is_public=True, user__is_active=True).select_related("user"))
    mine = profile_of(user)
    accounts = {a.user_id: a for a in PaperAccount.objects.filter(user_id__in={p.user_id for p in public} | {user.pk})}
    values, _ = _valuations(list(accounts.values()))

    def rate(user_id: int) -> float:
        a = accounts.get(user_id)
        return _profit_rate(values[a.id]) if a else 0.0

    ordered = sorted(((rate(p.user_id), p.nickname, p.user_id) for p in public), key=lambda e: (-e[0], e[1]))
    results = [{"rank": i, "nickname": nickname, "profitRate": r, "isMe": uid == user.pk}
               for i, (r, nickname, uid) in enumerate(ordered, 1)]
    my_rank = next((e["rank"] for e in results if e["isMe"]), None)
    return {"results": results,
            "me": {"isPublic": mine.is_public, "rank": my_rank if mine.is_public else None, "profitRate": rate(user.pk)},
            "asOf": at.isoformat()}


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
    expire = None if r.days is None else f"{at.date() + timedelta(days=r.days)}"
    fx = fx_if_needed(store, r.currency)
    with locked(account, notes) as executor:
        executor.buy(r.symbol, r.name, r.market, r.currency, r.quantity, price, fx, at, username,
                     target=r.target_price, stop=r.stop_price, expire_date=expire)


def record_equity(at: datetime, log) -> int:
    """국내 정규장이 끝난 날 하루 한 번 계좌별 일별 자산 (KST 날짜). 기록한 계좌 수를 돌려준다.

    보유 종목 시세를 받지 못하면 기록하지 않고 오류를 낸다 (다음 루프에서 다시 한다).
    """
    markets = engine.engine_config().markets
    base = "KR" if "KR" in markets else markets[0]
    day = at.astimezone(KST).date()
    if not any(end <= at and end.astimezone(KST).date() == day for _, end in market.sessions(base)):
        return 0
    accounts = list(PaperAccount.objects.exclude(equity_days__day=day).order_by("id"))
    if not accounts:
        return 0
    values, note = _valuations(accounts)
    if note:
        raise RuntimeError(f"보유 종목 시세를 받지 못해 일별 자산 기록을 미룸: {note}")
    for a in accounts:
        s = values[a.id]
        EquityDaily.objects.update_or_create(account=a, day=day, defaults={
            "cash_krw": s["cashKrw"], "holdings_value_krw": s["holdingsValueKrw"], "equity_krw": s["equityKrw"],
            "recorded_at": at})
    log(f"[자산 기록] {day}: 계좌 {len(accounts)}개")
    return len(accounts)
