"""시세 서비스 (docs/DECISIONS.md 8-2·14-1). 증권사 조회는 `config.engine.broker_client()` 하나로 하고 Django 캐시에 짧게 둔다.

- **화면에 보이는 가격은 장마감 기준**이다 (docs/API.md 공통 규칙 "장마감 기준"): `basis`·`closes`·`close_price`·`completed_candles`.
  종가는 종목·기준일별로 캐시한다 (같은 종목·같은 기준일은 몇 명이 봐도 증권사 일봉 조회 1번).
- `current_prices`·`confirmed_prices`·`last_price`는 **내부 경로 전용**이다 (모의 체결, sync, 예약 실행, 재주문, 활성화의 장중 확인).
- 현재가 1초, 일봉 120개·장 달력·환율 60초, 종가·종목 목록(거래소별)·종목 정보·매수 유의는 하루
  (종가는 봉 날짜가 기준일보다 앞이거나 오늘 봉인데 현지 17:00(CLOSE_FINAL_AT) 전이면 10분).
- 분봉(단타 연습, 국내만)은 완성된 정규장 세션만 낸다: 종목·날짜·간격별로 다 받은 세션은 하루, 일부만 받았으면 5분 캐시.
- 체결에 쓰는 확인 가격(confirmed_prices)은 캐시하지 않는다.
- 클라이언트가 없거나 조회가 실패하면(KiwoomApiError, OSError) Unavailable(503). 환율만은 실패하면 None (엔진 Desk 방식).
- 응답 형식은 엔진 조회 클라이언트(키움·토스 같음) 형식이다: 가격은 문자열, 일봉은 openPrice/.../timestamp.
- 단타 진입 세션 판정(day_entry_open)과 시세 출처 이름(quote_provider)은 여기 하나만 둔다 (autotrade·daytrade·longterm이 쓴다).
"""
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.utils import timezone
from paper_engine.agents.executor import DAY_CLOSE_AT
from paper_engine.data.calendar import NEW_YORK, close_basis_day, close_of, session_end_iso
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.scheduler import current_session, regular_sessions
from paper_engine.trading import MARKET_LISTS

from config import engine
from config.api import Unavailable

PRICE_TTL, SHORT_TTL, DAY_TTL = 1, 60, 24 * 3600  # 현재가 1초는 내부 경로(체결·예약 기준 가격)용
CANDLE_COUNT = 120
CLOSE_BATCH = 10  # closes 한 번이 새로 받는 종가 수 (종목마다 일봉 조회 1번). 나머지는 다음 호출(폴링)에 채운다
# 받은 종가 봉이 기준일보다 앞이면(증권사가 아직 그날 봉을 안 줌, 또는 장 달력이 모르는 휴장일) 하루가 아니라 이만큼만 둔다
CLOSE_LAG_TTL = 10 * 60
# 오늘(시장 현지) 봉의 종가는 이 현지 시각부터 굳은 값으로 본다. 그 전에는 CLOSE_LAG_TTL만 캐시하고 일별 자산은 기다린다
# (장 달력이 모르는 늦은 마감 — 표에 없는 수능일, 장애로 인한 마감 연장 — 이면 기준일이 바뀐 뒤에도 장중 값일 수 있다)
CLOSE_FINAL_AT = time(17, 0)
KST = ZoneInfo("Asia/Seoul")
MARKET_TZ = {"KR": KST, "US": NEW_YORK}
CURRENCY = {"KR": "KRW", "US": "USD"}
WARNING_LABELS = {
    "ETF_INVESTMENT_CAUTION": "ETF 투자유의", "LIQUIDATION_TRADING": "정리매매", "SHORT_TERM_OVERHEATED": "단기과열",
    "INVESTMENT_RISK": "투자위험", "INVESTMENT_WARNING": "투자경고", "INVESTMENT_CAUTION": "투자주의",
    "INVESTMENT_CAUTION_ALERT": "투자주의 환기", "ADMINISTRATIVE_ISSUE": "관리종목", "TRADING_SUSPENDED": "거래정지",
}
BASIS = "close"  # Quote.basis: 가격 기준은 지금 장마감 종가 하나뿐이다
# 분봉 (docs/API.md "단타 연습"): 허용 간격(분), 국내 정규장 구간, 일부만 받은 세션의 캐시
MINUTE_STEPS = (1, 3, 5, 10, 15, 30, 60)
KR_REGULAR = (time(9, 0), time(15, 30))
MINUTE_PARTIAL_TTL = 5 * 60
# MarketStatus.quoteProvider: 엔진 설정 BROKER별 시세 출처 이름 (toss는 로컬 개발 전용, 그 밖은 키움)
QUOTE_PROVIDERS = {"toss": "토스증권 Open API(개발)", "kiwoom": "키움증권 REST API"}
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


def unlisted(symbols) -> set[str]:
    """symbols 중 설정한 시장(MARKETS)의 종목 목록에 없는 것 (상장 폐지·목록에서 빠짐 — closes가 종가를 받지 않는다).

    거래소 목록을 하나라도 받지 못하면 빠진 것인지 알 수 없으므로 빈 집합이다 (일시 오류와 섞지 않는다).
    """
    symbols = set(symbols)
    if not symbols:
        return set()
    known = set()
    for market in engine.engine_config().markets:
        for exchange in MARKET_LISTS[market]:
            try:
                known.update(item["symbol"] for item in listed(exchange))
            except Unavailable:
                return set()
    return {s for s in symbols if norm_symbol(s) not in known}


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


# --- 장마감 기준 (docs/API.md 공통 규칙 "장마감 기준", docs/DECISIONS.md 14-1) ---

def _basis(market: str) -> tuple[str, dict] | None:
    """(기준일, 장 달력). 장 달력(60초 캐시)을 받지 못하거나 기준일을 정하지 못하면 None."""
    try:
        cal = calendar(market)
        day = close_basis_day(cal, market, timezone.now())
    except (Unavailable, KeyError, TypeError, ValueError):
        return None
    return (day, cal) if day else None


def basis(market: str) -> dict | None:
    """그 시장의 장마감 기준: {"date": 기준일 YYYY-MM-DD, "asOf": 기준일의 정규장 종료 시각 ISO}.

    기준일 = 정규장 종료 + 10분이 지금 이전인 가장 최근 영업일 (엔진 data/calendar.close_basis_day). 장 달력을
    받지 못하면 None. 종목 가격의 정확한 기준 시각은 closes의 asOf (실제 마지막 봉 날짜)다.
    """
    found = _basis(market)
    if found is None:
        return None
    day, cal = found
    return {"date": day, "asOf": session_end_iso(cal, market, day)}


def _basis_day(market: str) -> tuple[str, dict]:
    """(기준일, 장 달력). 장 달력을 받지 못하면 그 시장 현지 어제 날짜로 본다 (오늘 미완성 봉을 넣지 않는 쪽)."""
    found = _basis(market)
    if found is not None:
        return found
    yesterday = timezone.now().astimezone(MARKET_TZ[market]).date() - timedelta(days=1)
    return f"{yesterday}", {}


def basis_day(market: str) -> str:
    """그 시장의 기준일 YYYY-MM-DD. 장 달력을 받지 못하면 그 시장 현지 어제 날짜 (closes·completed_candles와 같은 값)."""
    return _basis_day(market)[0]


def session_end(market: str, day: str) -> str:
    """day(그 시장 현지 날짜)의 정규장 종료 시각 ISO. 장 달력(60초 캐시)에 그 날짜가 없거나 받지 못하면 기본 시각."""
    try:
        cal = calendar(market)
    except Unavailable:
        cal = {}
    return session_end_iso(cal, market, day)


def _close(symbol: str, market: str, day: str, cal: dict, budget: list[int]) -> dict | None:
    """종목 하나의 종가 (종목·기준일별 캐시). 예산이 없으면 받지 않고 None (다음 호출에 채운다)."""
    key = f"trading:close:{symbol}:{day}"
    value = cache.get(key, _MISSING)
    if value is not _MISSING:
        return value
    if budget[0] <= 0:
        return None
    budget[0] -= 1
    try:
        found = close_of(candles(symbol), day)
    except (Unavailable, KeyError, TypeError, ValueError):
        found = None
    if found is None:
        cache.set(key, None, SHORT_TTL)  # 실패·봉 없음은 60초 뒤에 다시
        return None
    value = {"price": found["close"], "prevClose": found["prevClose"], "date": found["date"],
             "asOf": session_end_iso(cal, market, found["date"])}
    settled = found["date"] == day and close_final(market, day)
    cache.set(key, value, DAY_TTL if settled else CLOSE_LAG_TTL)
    return value


def close_final(market: str, day: str, now: datetime | None = None) -> bool:
    """day(그 시장 현지 날짜) 봉의 종가를 굳은 값으로 볼 수 있는지: 그날이 지났거나 그날 현지 CLOSE_FINAL_AT(17:00) 이후."""
    local = (now or timezone.now()).astimezone(MARKET_TZ[market])
    today = f"{local.date()}"
    return today > day or (today == day and local.time() >= CLOSE_FINAL_AT)


def closes(symbols: list[str], budget: list[int] | None = None) -> dict[str, dict]:
    """종목별 직전 정규장 종가: {symbol: {"price", "prevClose", "date", "asOf"}} (장마감 기준).

    price = 날짜가 기준일 이하인 마지막 일봉의 종가, prevClose = 그 앞 봉의 종가 (없으면 None), date = 그 봉 날짜,
    asOf = 그 봉 날짜의 정규장 종료 시각. 종목의 시장은 종목 목록(stock_item)으로 알고, 일봉은 candles()(120개)를 쓴다.
    종목·기준일별로 하루 캐시하고(봉 날짜가 기준일보다 앞이거나, 오늘 봉인데 현지 17:00 전이면 10분), 받지 못하면 60초 캐시한다.
    한 호출이 새로 받는 종목은 budget([남은 횟수], 여러 호출이 나눠 쓸 수 있다)만큼, 없으면 CLOSE_BATCH(10)개까지다.
    종목 목록에 없거나, 받지 못했거나, 예산이 모자라 아직 받지 않은 종목은 결과에서 빠진다.
    """
    budget = [CLOSE_BATCH] if budget is None else budget
    days: dict[str, tuple[str, dict]] = {}
    out = {}
    symbols = list(dict.fromkeys(map(norm_symbol, symbols)))
    known = directory() if symbols else {}
    for symbol in symbols:
        item = known.get(symbol)
        if item is None:
            continue
        market = item["market"]
        if market not in days:
            days[market] = _basis_day(market)
        day, cal = days[market]
        value = _close(item["symbol"], market, day, cal, budget)
        if value is not None:
            out[item["symbol"]] = value
    return out


def close_price(symbol: str) -> float | None:
    """종목의 직전 정규장 종가 (장마감 기준). 받지 못하면 None."""
    found = closes([symbol]).get(norm_symbol(symbol))
    return found["price"] if found else None


def completed_candles(symbol: str) -> list[dict]:
    """일봉 최근 120개 중 날짜가 기준일 이하인 완성 봉만 (과거 → 최신, 장중에도 오늘 미완성 봉이 없다).

    종목 목록에 없으면 국내 종목으로 본다. 증권사 조회가 실패하면 Unavailable(503).
    """
    item = stock_item(symbol)
    market = item["market"] if item else "KR"
    day, _ = _basis_day(market)
    return [c for c in candles(norm_symbol(symbol)) if c["timestamp"][:10] <= day]


def quotes(symbols: list[str]) -> list[dict]:
    """Quote 목록 (장마감 기준, docs/API.md Quote). 종목 목록에 없는 종목은 빠진다.

    price = 직전 정규장 종가, prevClose = 그 전 거래일 종가 (같은 일봉), asOf = 종가 봉 날짜의 정규장 종료 시각.
    한 호출이 새로 받는 종가는 CLOSE_BATCH(10)개까지라 처음 보는 종목은 잠깐 null일 수 있다 (다음 폴링에 채운다).
    종가를 받지 못한 종목도 price·asOf가 null이다.
    """
    known = directory()
    items = [item for s in dict.fromkeys(map(norm_symbol, symbols)) if (item := known.get(s))]
    found = closes([i["symbol"] for i in items]) if items else {}
    out = []
    for item in items:
        close = found.get(item["symbol"]) or {}
        price, prev = close.get("price"), close.get("prevClose")
        both = price is not None and bool(prev)
        out.append({"symbol": item["symbol"], "name": item["name"], "currency": CURRENCY[item["market"]],
                    "price": price, "prevClose": prev, "change": price - prev if both else None,
                    "changeRate": price / prev - 1 if both else None, "asOf": close.get("asOf"), "basis": BASIS})
    return out


# --- 분봉 (단타 연습, docs/API.md "단타 연습") ---

def minute_candles(symbol: str, day: str, minutes: int = 1) -> dict:
    """MinuteCandles: 국내 종목 symbol의 day(YYYY-MM-DD, KST) 정규장(09:00~15:30) 분봉, 과거 → 최신.

    완성된 정규장 세션만 낸다 — day가 KR 기준일 이하인지는 부르는 쪽(뷰)이 본다. 봉은 엔진 조회 클라이언트의
    minute_candles(symbol, day, minutes) → (봉 목록, 세션 시작까지 받았는지)를 화면 형식으로 바꾼 것이고, 정규장 밖 봉은
    한 번 더 거른다. partial = 그 세션을 09:00부터 다 받지 못함. 종목·날짜·간격별 캐시: 다 받았으면 하루, 일부만이면 5분.
    증권사 조회가 실패하면 Unavailable(503, 캐시하지 않는다).
    """
    symbol = norm_symbol(symbol)
    key = f"trading:minute:{symbol}:{day}:{minutes}"
    value = cache.get(key, _MISSING)
    if value is not _MISSING:
        return value
    rows, complete = _call("minute_candles", symbol, day, minutes)
    candles = _minute_rows(rows, day)
    value = {"symbol": symbol, "date": day, "minutes": minutes,
             "asOf": session_end("KR", day) if candles else None, "candles": candles, "partial": not complete}
    cache.set(key, value, DAY_TTL if complete else MINUTE_PARTIAL_TTL)
    return value


def _minute_rows(rows, day: str) -> list[dict]:
    """엔진 분봉(토스 형식, 문자열) → MinuteCandle. 그 날짜 정규장 밖이거나 읽지 못하는 봉은 버리고 시각순으로 둔다."""
    session = date.fromisoformat(day)
    out = {}
    for row in rows or []:
        try:
            at = datetime.fromisoformat(row["timestamp"])
            at = (at if at.tzinfo else at.replace(tzinfo=KST)).astimezone(KST)
            candle = {"time": at.isoformat(), "open": float(row["openPrice"]), "high": float(row["highPrice"]),
                      "low": float(row["lowPrice"]), "close": float(row["closePrice"]), "volume": float(row["volume"])}
        except (KeyError, TypeError, ValueError):
            continue
        if at.date() == session and KR_REGULAR[0] <= at.time() <= KR_REGULAR[1]:
            out[candle["time"]] = candle  # 같은 시각이 두 번 오면 나중 것
    return [out[k] for k in sorted(out)]


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


# --- 단타 연습 세션 (docs/API.md "단타 연습" 세션 규칙 — 판정은 여기 하나: autotrade.risk·daytrade.session·trading.service) ---

def regular_market(entry) -> dict | None:
    """장 달력 날짜 항목의 정규장 구간 {"startTime", "endTime", ...}. 휴장일이거나 모양이 다르면 None (국내는 integrated 아래)."""
    if not isinstance(entry, dict):
        return None
    found = entry.get("integrated") or entry
    regular = found.get("regularMarket") if isinstance(found, dict) else None
    return regular if isinstance(regular, dict) and regular.get("startTime") and regular.get("endTime") else None


def next_weekday(day: date) -> date:
    day += timedelta(days=1)
    while day.weekday() >= 5:
        day += timedelta(days=1)
    return day


def kr_trading_day(now) -> tuple[bool, date]:
    """(오늘(KST)이 국내 거래일인지, 오늘 다음 국내 거래일). 국내 장 달력(60초 캐시)으로 보고,
    받지 못했거나 장 달력이 오늘을 모르면 주말만 거른다 (공휴일은 모른다)."""
    today = now.astimezone(KST).date()
    try:
        cal = calendar("KR")
    except Unavailable:
        cal = None
    entry = cal.get("today") if isinstance(cal, dict) else None
    if not isinstance(entry, dict) or entry.get("date") != f"{today}":
        return today.weekday() < 5, next_weekday(today)
    following = (cal.get("nextBusinessDay") or {}).get("date")
    try:
        next_day = date.fromisoformat(following) if following else next_weekday(today)
    except (TypeError, ValueError):
        next_day = next_weekday(today)
    return regular_market(entry) is not None, next_day


def day_entry_cutoff(day: date) -> datetime:
    """그 세션(KST 날짜)의 단타 진입 마감 = 엔진 DAY_CLOSE_AT (15:15 KST). 체결 대기 단타 주문 취소·보유 정리와 같은 시각."""
    return datetime.combine(day, DAY_CLOSE_AT, tzinfo=KST)


def day_entry_open(now) -> bool:
    """지금 단타 진입(단타 계획 만들기·style day 주문 접수)을 받는지 = DaySession.acceptingPlans:
    오늘(KST)이 국내 거래일이고 지금이 그날 단타 진입 마감(15:15 KST) 전."""
    return now < day_entry_cutoff(now.astimezone(KST).date()) and kr_trading_day(now)[0]


# --- 시세 출처 ---

def quote_provider() -> str:
    """시세 출처 이름 (docs/API.md MarketStatus.quoteProvider). 장기투자 근거 목록의 출처 표기도 이 값을 쓴다."""
    return QUOTE_PROVIDERS.get(engine.engine_config().broker, QUOTE_PROVIDERS["kiwoom"])
