"""모의 주문 요청 처리. CLI(`python -m paper_engine buy|sell|...`), serve의 예약 실행, 이후 작업 큐(4C)가 같이 쓴다.

여기서는 종목 찾기, 시세·환율·장 시간 조회, 정규장 밖 시장가 주문의 예약만 한다.
체결 판단과 계좌 계산은 모의 체결기(agents/executor.py)가 한다.

- 매수: 종목코드나 정확한 종목명. 정규장이면 시장가는 확인 가격에 바로 체결, 지정가는 접수 (당일 유효).
  정규장 밖 시장가는 다음 정규장 시작 예약 (REDIS_URL 필요). 미국 종목은 MARKETS에 US가 있을 때만 받는다.
- 매도: 모의 주문(포지션) 번호로 전량. 정규장 밖이면 예약. 체결 대기 주문이면 취소.
"""
import json
import re
from datetime import date, datetime, timedelta

from .agents import executor as ex
from .agents.executor import OrderRejected, PaperExecutor
from .config import ROOT
from .data.kiwoom import KiwoomApiError
from .scheduler import Reservation, ReservationBook, current_session, last_session_end, next_session_start, \
    regular_sessions
from .symbols import SymbolError, resolve_listed

LISTED_MARKETS = ("KOSPI", "KOSDAQ", "NYSE", "NASDAQ", "AMEX")
MARKET_LISTS = {"KR": ("KOSPI", "KOSDAQ"), "US": ("NYSE", "NASDAQ", "AMEX")}
RESERVED_BUY_MAX_DRIFT = 0.10  # 예약 매수는 실행 때 가격이 예약 때보다 이만큼 넘게 움직이면 취소한다
DEFAULT_MANAGED_DAYS = 30  # 목표·손절을 주고 기한을 주지 않은 매수의 보유 기한 (달력 일수)
MAX_MANAGED_DAYS = 180


def _cached_daily(name: str, fetch):
    """하루 한 번 바뀌는 데이터를 .cache에 날짜별로 둔다."""
    path = ROOT / ".cache" / f"{name}-{date.today()}.json"
    if path.exists():
        return json.loads(path.read_text())
    data = fetch()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False))
    return data


def listed_stocks(client, markets) -> list[dict]:
    """전체 종목 목록 (하루 한 번 받아 .cache에 둔다). markets는 KOSPI, NASDAQ 같은 거래소 이름."""
    listed = []
    for market in markets:
        listed += _cached_daily(f"stocks-all-{market}", lambda m=market: client.listed_stocks(m))
    return listed


class Desk:
    """모의 주문 창구. client는 키움 조회 클라이언트 (없으면 기록만 보는 조회만 된다)."""

    def __init__(self, cfg, store, notifier, client=None, book: ReservationBook | None = None,
                 halt_file=None, sessions=None):
        """sessions(market)는 정규장 (시작, 끝) 목록을 돌려준다. 없으면 client.market_calendar로 조회한다."""
        self.cfg = cfg
        self.store = store
        self.notifier = notifier
        self.client = client
        self.book = book
        self.executor = PaperExecutor(store, notifier, halt_file or ROOT / "data" / "HALT", cfg.commission)
        self._sessions = sessions

    # --- 조회 ---

    def sessions(self, market: str) -> list:
        if self._sessions:
            return self._sessions(market)
        return regular_sessions(self._need_client().market_calendar(market))

    def _need_client(self):
        if self.client is None:
            raise OrderRejected("키움 클라이언트가 없음 (.env의 KIWOOM_APPKEY, KIWOOM_SECRETKEY)")
        return self.client

    def is_open(self, market: str, now: datetime) -> bool:
        return bool(current_session(self.sessions(market), now))

    def fx_rate(self) -> float | None:
        """달러 1의 원화 가치. 조회하지 못하면 None (원화 종목만 다루면 필요 없다)."""
        if self.client is None:
            return None
        try:
            return float(self.client.exchange_rate()["rate"])
        except (KiwoomApiError, OSError, KeyError, TypeError, ValueError) as e:
            self.notifier.log(f"환율 조회 실패: {e}")
            return None

    def fx_if_needed(self, currency: str = "KRW") -> float | None:
        """주문 종목이나 진행 중 주문에 달러 종목이 있을 때만 환율을 조회한다."""
        if currency == "USD" or any(r["currency"] == "USD" for r in self.store.paper_orders(ex.ACTIVE)):
            return self.fx_rate()
        return None

    def confirmed_price(self, symbol: str) -> float | None:
        return self._need_client().confirmed_prices([symbol]).get(symbol)

    def last_price(self, symbol: str) -> float | None:
        """확인 가격, 없으면 현재가 (예약 기준 가격과 순서 점검용. 체결에는 쓰지 않는다)."""
        price = self.confirmed_price(symbol)
        if price is None:
            found = self._need_client().prices([symbol])
            price = float(found[0]["lastPrice"]) if found else None
        return price

    def held_prices(self) -> dict[str, float]:
        """보유 종목의 확인 가격 (평가용). 클라이언트가 없거나 실패하면 빈 dict (체결가로 평가한다)."""
        symbols = sorted({r["symbol"] for r in self.store.paper_orders((ex.EXIT_WATCHING,))})
        if not (symbols and self.client):
            return {}
        try:
            return self.client.confirmed_prices(symbols)
        except (KiwoomApiError, OSError) as e:
            self.notifier.log(f"보유 종목 가격 조회 실패: {e}")
            return {}

    def account_summary(self) -> dict:
        prices = self.held_prices()
        fx = self.fx_if_needed() if self.client else None
        return self.executor.account_summary(prices, fx)

    def account_context(self, symbol: str, currency: str, liquidity: float | None, warnings: list[str],
                        cap_krw: float | None = None):
        """리스크 엔진 입력 (모의 계좌 기준). AI 경로는 SWING만 매매하므로(TRADABLE_HORIZONS) 하루 주문 수·손실은
        style swing 주문만 센다."""
        return self.executor.account_context(
            symbol, currency, self.fx_if_needed(currency), self.held_prices(), liquidity, warnings,
            self.cfg.max_total_invest_krw, cap_krw, date.today(), style=ex.SWING)

    def find_listed(self, query: str) -> dict:
        """매수할 종목. 종목코드면 바로 조회하고, 아니면 전체 종목 목록에서 이름이 같은 종목을 찾는다."""
        client = self._need_client()
        code = query.strip().upper()
        info = None
        if re.fullmatch(r"[A-Z0-9.\-]+", code):
            found = client.stocks([code])
            info = found[0] if found else None
        if info is None:
            markets = [x for m in self.cfg.markets for x in MARKET_LISTS[m]]
            listed = resolve_listed(query, listed_stocks(client, markets))
            info = client.stocks([listed["symbol"]])[0]
        if info.get("status") != "ACTIVE":
            raise SymbolError(f"{info['name']}({info['symbol']})은(는) 거래 가능한 상태가 아님 ({info.get('status')})")
        market = "KR" if info["currency"] == "KRW" else "US"
        if market not in self.cfg.markets:
            raise OrderRejected(f"{info['name']}({info['symbol']}): MARKETS에 {market}이(가) 없어 받지 않음")
        return info

    # --- 주문 ---

    def buy(self, query: str, quantity: float, requested_by: str, limit: float | None = None,
            target: float | None = None, stop: float | None = None, days: int | None = None,
            now: datetime | None = None) -> str:
        """모의 매수. 결과 한 줄을 돌려준다 (알림은 체결기가 보낸다)."""
        now = now or datetime.now().astimezone()
        info = self.find_listed(query)
        symbol, name, currency = info["symbol"], info["name"], info["currency"]
        market = "KR" if currency == "KRW" else "US"
        if target is not None and days is None:
            days = DEFAULT_MANAGED_DAYS
        if days is not None and not 1 <= days <= MAX_MANAGED_DAYS:
            raise OrderRejected(f"기한은 1~{MAX_MANAGED_DAYS}일")
        open_ = self.is_open(market, now)
        if limit is None and not open_:
            return self.reserve_buy(info, quantity, requested_by, target, stop, days, now)
        price = self.confirmed_price(symbol) if open_ else self.last_price(symbol)
        if price is None:
            raise OrderRejected(f"{name}({symbol})의 확인 가격(현재가·호가)을 받지 못함. 잠시 뒤 다시 시도")
        expire = None if days is None else f"{now.date() + timedelta(days=days)}"
        oid = self.executor.buy(symbol, name, market, currency, quantity, price, self.fx_if_needed(currency), now,
                                requested_by, limit, target, stop, expire, regular_open=open_)
        row = self.store.paper_order(oid)
        return f"모의 주문 #{oid} {ex.STATUS_LABEL[row['status']]}"

    def reserve_buy(self, info: dict, quantity: float, requested_by: str, target: float | None,
                    stop: float | None, days: int | None, now: datetime) -> str:
        book = self._need_book()
        symbol, name, currency = info["symbol"], info["name"], info["currency"]
        market = "KR" if currency == "KRW" else "US"
        price = self.last_price(symbol)
        if price is None:
            raise OrderRejected(f"{name}({symbol})의 현재가를 받지 못함")
        reasons = self.executor.buy_blockers(symbol, market, currency, quantity, price, None,
                                              self.fx_if_needed(currency), target, stop, True)
        if reasons:
            raise OrderRejected("; ".join(reasons))
        res = book.add(market=market, side="BUY", symbol=symbol, name=name, quantity=f"{quantity:g}",
                       created_at=now.isoformat(), reference_price=f"{price:g}", requested_by=requested_by,
                       target=None if target is None else f"{target:g}", stop=None if stop is None else f"{stop:g}",
                       days=days)
        return self._announce_reservation(res, market, now)

    def sell(self, order_id: int, requested_by: str, now: datetime | None = None) -> str:
        """포지션 전량 모의 매도 (체결 대기 주문이면 취소). 정규장 밖이면 예약."""
        now = now or datetime.now().astimezone()
        row = self.store.paper_order(order_id)
        if row is None:
            raise OrderRejected(f"모의 주문 #{order_id}이(가) 없음")
        if row["status"] == ex.ENTRY_PENDING:
            self.executor.cancel(order_id, now, requested_by)
            return f"모의 주문 #{order_id} 취소"
        if row["status"] != ex.EXIT_WATCHING:
            raise OrderRejected(f"모의 주문 #{order_id}은(는) 이미 {ex.STATUS_LABEL[row['status']]} 상태")
        if not self.is_open(row["market"], now):
            book = self._need_book()
            if any(r.side == "SELL" and r.order_id == order_id for r in book.all()):
                raise OrderRejected(f"모의 주문 #{order_id}의 매도 예약이 이미 있음")
            res = book.add(market=row["market"], side="SELL", symbol=row["symbol"], name=row["name"],
                           quantity=f"{row['filled_quantity']:g}", created_at=now.isoformat(),
                           reference_price=f"{row['fill_price']:g}", requested_by=requested_by, order_id=order_id)
            return self._announce_reservation(res, row["market"], now)
        price = self.confirmed_price(row["symbol"])
        if price is None:
            raise OrderRejected(f"{row['name']}({row['symbol']})의 확인 가격을 받지 못함. 잠시 뒤 다시 시도")
        self.executor.sell(order_id, price, self.fx_if_needed(row["currency"]), now, requested_by)
        return f"모의 주문 #{order_id} 매도 완료"

    def cancel(self, order_id: int, requested_by: str, now: datetime | None = None) -> str:
        self.executor.cancel(order_id, now or datetime.now().astimezone(), requested_by)
        return f"모의 주문 #{order_id} 취소"

    def modify(self, order_id: int, target: float | None, stop: float | None, days: int | None,
               now: datetime | None = None) -> dict:
        now = now or datetime.now().astimezone()
        row = self.store.paper_order(order_id)
        if row is None:
            raise OrderRejected(f"모의 주문 #{order_id}이(가) 없음")
        if days is not None and not 1 <= days <= MAX_MANAGED_DAYS:
            raise OrderRejected(f"기한은 1~{MAX_MANAGED_DAYS}일")
        expire = None if days is None else f"{now.date() + timedelta(days=days)}"
        price = self.last_price(row["symbol"]) if self.client else None
        return self.executor.modify(order_id, price, target, stop, expire, now)

    def _need_book(self) -> ReservationBook:
        if not self.book:
            raise OrderRejected("정규장 밖 시장가 주문은 다음 정규장 예약으로 받는데, 예약에는 REDIS_URL이 필요함. "
                                "지정가로 주문하거나 정규장에 다시 시도")
        return self.book

    def _announce_reservation(self, res: Reservation, market: str, now: datetime) -> str:
        start = next_session_start(self.sessions(market), now)
        when = f"{start:%m-%d %H:%M}" if start else "다음 정규장"
        self.notifier.send(f"[예약] {res.label} 등록. {when} 정규장 시작 때 모의 체결")
        return f"예약 #{res.id} ({when} 실행)"

    # --- 예약 실행과 체결 확인 (serve) ---

    def run_reservation(self, r: Reservation, now: datetime) -> None:
        """예약 실행. 점검은 즉시 주문과 같다. 실행하지 못하면 OrderRejected."""
        self.notifier.send(f"[예약] {r.label} 실행")
        if r.side == "SELL":
            row = self.store.paper_order(r.order_id)
            if row is None or row["status"] != ex.EXIT_WATCHING:
                raise OrderRejected(f"모의 주문 #{r.order_id}이(가) 보유 중이 아님 (이미 청산됐을 수 있음)")
            price = self.confirmed_price(r.symbol)
            if price is None:
                raise OrderRejected("확인 가격을 받지 못함")
            self.executor.sell(r.order_id, price, self.fx_if_needed(row["currency"]), now, r.requested_by)
            return
        currency = "KRW" if r.market == "KR" else "USD"
        price = self.confirmed_price(r.symbol)
        if price is None:
            raise OrderRejected("확인 가격을 받지 못함")
        drift = abs(price / float(r.reference_price) - 1)
        if drift > RESERVED_BUY_MAX_DRIFT:
            raise OrderRejected(f"현재가 {price:,}가 예약 때 가격 {r.reference_price}에서 {drift:.1%} 벗어남 "
                                f"(허용 {RESERVED_BUY_MAX_DRIFT:.0%})")
        expire = None if r.days is None else f"{now.date() + timedelta(days=int(r.days))}"
        self.executor.buy(r.symbol, r.name, r.market, currency, float(r.quantity), price,
                          self.fx_if_needed(currency), now, r.requested_by,
                          target=None if r.target is None else float(r.target),
                          stop=None if r.stop is None else float(r.stop), expire_date=expire)

    def sync(self, now: datetime | None = None) -> str:
        """진행 중인 모의 주문의 체결·청산을 지금 한 번 확인한다. 요약 한 줄을 돌려준다."""
        now = now or datetime.now().astimezone()
        rows = self.store.paper_orders(ex.ACTIVE)
        if not rows:
            return f"{now:%H:%M} 진행 중인 모의 주문 없음"
        markets = sorted({r["market"] for r in rows})
        sessions = {m: self.sessions(m) for m in markets}
        open_markets = {m for m in markets if current_session(sessions[m], now)}
        last_close = {m: last_session_end(sessions[m], now) for m in markets}
        symbols = sorted({r["symbol"] for r in rows if r["market"] in open_markets})
        # 현재가 한 건만 믿지 않는다. 호가와 함께 본 가격을 쓴다 (튀는 체결가 대비).
        prices = self._need_client().confirmed_prices(symbols) if symbols else {}
        fx = self.fx_rate() if any(r["currency"] == "USD" for r in rows) else None
        n = self.executor.sync(prices, now, open_markets, fx, last_close)
        state = ", ".join(f"{m} {'정규장' if m in open_markets else '장 밖'}" for m in markets)
        return f"{now:%H:%M} 모의 주문 {n}건 확인 ({state})"
