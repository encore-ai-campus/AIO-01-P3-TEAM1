"""시세 서비스 (docs/DECISIONS.md 8-2). 증권사 조회는 `config.engine.broker_client()` 하나로 하고 Django 캐시에 짧게 둔다.

- 현재가 1초, 일봉 120개·장 달력·환율 60초, 전일 종가·종목 목록(거래소별)·종목 정보·매수 유의는 하루.
- 체결에 쓰는 확인 가격(confirmed_prices)은 캐시하지 않는다.
- 클라이언트가 없거나 조회가 실패하면(KiwoomApiError, OSError) Unavailable(503). 환율만은 실패하면 None (엔진 Desk 방식).
- 응답 형식은 엔진 조회 클라이언트(키움·토스 같음) 형식이다: 가격은 문자열, 일봉은 openPrice/.../timestamp.
"""
import re
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.utils import timezone
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.scheduler import current_session, regular_sessions
from paper_engine.trading import MARKET_LISTS

from config import engine
from config.api import Unavailable

PRICE_TTL, SHORT_TTL, DAY_TTL = 1, 60, 24 * 3600  # 화면이 1초마다 시세를 받는다
CANDLE_COUNT = 120
PREV_CLOSE_BATCH = 10  # /api/quotes 한 번이 새로 받는 전일 종가 수 (종목마다 일봉 조회 1번)
KST = ZoneInfo("Asia/Seoul")
CURRENCY = {"KR": "KRW", "US": "USD"}
WARNING_LABELS = {
    "ETF_INVESTMENT_CAUTION": "ETF 투자유의", "LIQUIDATION_TRADING": "정리매매", "SHORT_TERM_OVERHEATED": "단기과열",
    "INVESTMENT_RISK": "투자위험", "INVESTMENT_WARNING": "투자경고", "INVESTMENT_CAUTION": "투자주의",
    "INVESTMENT_CAUTION_ALERT": "투자주의 환기", "ADMINISTRATIVE_ISSUE": "관리종목", "TRADING_SUSPENDED": "거래정지",
}
_MISSING = object()


def client():
    found = engine.broker_client()
    if found is None:
        raise Unavailable("증권사 조회 키가 없어 시세를 조회할 수 없습니다 (.env의 증권사 조회 키 확인).")
    return found


def _call(method: str, *args):
    """클라이언트 메서드 호출. 증권사 오류는 503으로 바꾼다."""
    try:
        return getattr(client(), method)(*args)
    except (KiwoomApiError, OSError) as e:
        raise Unavailable(f"증권사 조회 실패: {e}") from None


def _cached(key: str, ttl: int, fetch):
    value = cache.get(key, _MISSING)
    if value is _MISSING:
        value = fetch()
        cache.set(key, value, ttl)
    return value


def _today() -> str:
    return f"{timezone.now().astimezone(KST).date()}"


def norm_symbol(symbol: str) -> str:
    return symbol.strip().upper()


# --- 종목 ---

def listed(exchange: str) -> list[dict]:
    """거래소의 전체 종목 (StockItem 형식). 하루 캐시."""
    market = "KR" if exchange in MARKET_LISTS["KR"] else "US"
    return _cached(f"trading:listed:{exchange}:{_today()}", DAY_TTL, lambda: [
        {"symbol": s["symbol"], "name": s.get("name") or s["symbol"], "exchange": exchange, "market": market}
        for s in _call("listed_stocks", exchange) if s.get("symbol")])


def directory() -> dict[str, dict]:
    """설정한 시장(MARKETS)의 종목코드 → StockItem. 한 거래소 조회가 실패해도 나머지로 찾는다 (모두 실패하면 503)."""
    found, error = {}, None
    for market in engine.engine_config().markets:
        for exchange in MARKET_LISTS[market]:
            try:
                items = listed(exchange)
            except Unavailable as e:
                error = e
                continue
            for item in items:
                found.setdefault(item["symbol"], item)
    if not found and error:
        raise error
    return found


def stock_item(symbol: str) -> dict | None:
    return directory().get(norm_symbol(symbol))


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text).upper()


def search(query: str, limit: int) -> list[dict]:
    """이름 부분 일치·코드 앞부분 일치. 정확히 같은 것, 앞부분이 같은 것, 나머지 순."""
    q = _norm(query)
    if not q:
        return []
    ranked = []
    for item in directory().values():
        symbol, name = item["symbol"].upper(), _norm(item["name"])
        if q in (symbol, name):
            rank = 0
        elif symbol.startswith(q) or name.startswith(q):
            rank = 1
        elif q in name:
            rank = 2
        else:
            continue
        ranked.append((rank, len(name), item["symbol"], item))
    ranked.sort(key=lambda r: r[:3])
    return [r[3] for r in ranked[:limit]]


def stock_info(symbol: str) -> dict | None:
    """종목 정보 (stocks 형식: status, currency, ...). 60초 캐시 (거래정지 같은 당일 변화를 주문 점검이 봐야 한다)."""
    def fetch():
        found = _call("stocks", [symbol])
        return found[0] if found else None
    return _cached(f"trading:stock:{symbol}", SHORT_TTL, fetch)


def warnings(symbol: str) -> list[str]:
    """매수 유의 (투자경고 등) 한국어 이름. 하루 캐시."""
    def fetch():
        out = []
        for w in _call("warnings", symbol):
            label = WARNING_LABELS.get(w.get("warningType")) or w.get("description") or w.get("warningType")
            if label and label not in out:
                out.append(label)
        return out
    return _cached(f"trading:warnings:{symbol}:{_today()}", DAY_TTL, fetch)


# --- 시세 ---

def current_prices(symbols: list[str]) -> dict[str, float]:
    """현재가 (표시·평가용). 종목마다 1초 캐시하고 없는 것만 한 번에 묶어 조회한다. 받지 못한 종목은 빠진다."""
    out, missing = {}, []
    for symbol in dict.fromkeys(symbols):
        value = cache.get(f"trading:price:{symbol}", _MISSING)
        if value is _MISSING:
            missing.append(symbol)
        elif value is not None:
            out[symbol] = value
    if missing:
        fetched = {p["symbol"]: float(p["lastPrice"]) for p in _call("prices", missing) if p.get("lastPrice")}
        for symbol in missing:
            cache.set(f"trading:price:{symbol}", fetched.get(symbol), PRICE_TTL)
            if symbol in fetched:
                out[symbol] = fetched[symbol]
    return out


def confirmed_prices(symbols: list[str]) -> dict[str, float]:
    """체결 판단에 쓰는 확인 가격 (현재가·최우선 호가의 중간값). 캐시하지 않는다."""
    return _call("confirmed_prices", list(symbols)) if symbols else {}


def confirmed_price(symbol: str) -> float | None:
    return confirmed_prices([symbol]).get(symbol)


def last_price(symbol: str) -> float | None:
    """확인 가격, 없으면 현재가 (예약 기준 가격과 순서 점검용. 체결에는 쓰지 않는다)."""
    price = confirmed_price(symbol)
    if price is None:
        price = current_prices([symbol]).get(symbol)
    return price


def candles(symbol: str) -> list[dict]:
    """일봉 최근 120개 (과거 → 최신, 장중이면 마지막은 오늘 미완성 봉). 60초 캐시."""
    return _cached(f"trading:candles:{symbol}", SHORT_TTL, lambda: _call("daily_candles", symbol, CANDLE_COUNT))


def prev_close(symbol: str, market: str, budget: list[int] | None = None) -> float | None:
    """전 거래일 종가: 그 시장의 오늘(장 달력 today) 전 날짜인 완성된 일봉의 마지막 종가. 하루 캐시. 받지 못하면 None.

    종목마다 일봉을 한 번 불러야 해서 증권사 호출이 불어나기 쉽다. 그래서 실패(와 값 없음)도 60초 캐시해 폴링마다
    다시 부르지 않고, budget([남은 횟수])을 주면 새로 받는 수를 그만큼으로 제한한다 (넘으면 None, 다음 폴링에 채운다).
    """
    try:
        today = (calendar(market).get("today") or {}).get("date") or _today()
    except Unavailable:
        return None
    key = f"trading:prevclose:{symbol}:{today}"
    value = cache.get(key, _MISSING)
    if value is not _MISSING:
        return value
    if budget is not None:
        if budget[0] <= 0:
            return None
        budget[0] -= 1
    try:
        done = [c for c in candles(symbol) if c["timestamp"][:10] < today]
        value = float(done[-1]["closePrice"]) if done else None
    except (Unavailable, KeyError, TypeError, ValueError):
        value = None
    cache.set(key, value, DAY_TTL if value is not None else SHORT_TTL)
    return value


def quotes(symbols: list[str]) -> list[dict]:
    """Quote 목록. 종목 목록에 없는 종목은 빠진다. 전일 종가를 받지 못하면 그 값만 null."""
    known = directory()
    items = [item for s in dict.fromkeys(map(norm_symbol, symbols)) if (item := known.get(s))]
    prices = current_prices([i["symbol"] for i in items]) if items else {}
    budget = [PREV_CLOSE_BATCH]
    out = []
    for item in items:
        price = prices.get(item["symbol"])
        prev = prev_close(item["symbol"], item["market"], budget)
        both = price is not None and prev
        out.append({"symbol": item["symbol"], "name": item["name"], "currency": CURRENCY[item["market"]],
                    "price": price, "prevClose": prev, "change": price - prev if both else None,
                    "changeRate": price / prev - 1 if both else None})
    return out


def fx_rate() -> float | None:
    """달러 1의 원화 가치. 60초 캐시. 클라이언트가 없거나 조회하지 못하면 None (원화 종목만 다루면 필요 없다)."""
    value = cache.get("trading:fx", _MISSING)
    if value is not _MISSING:
        return value
    try:
        value = float(_call("exchange_rate")["rate"])
    except (Unavailable, KeyError, TypeError, ValueError):
        return None
    cache.set("trading:fx", value, SHORT_TTL)
    return value


# --- 장 시간 ---

def calendar(market: str) -> dict:
    """장 운영 정보 (data/calendar.py 형식). 60초 캐시."""
    return _cached(f"trading:calendar:{market}", SHORT_TTL, lambda: _call("market_calendar", market))


def sessions(market: str) -> list:
    """정규장 (시작, 끝) 목록 (전일·당일·익일)."""
    return regular_sessions(calendar(market))


def is_open(market: str, now) -> bool:
    return bool(current_session(sessions(market), now))
