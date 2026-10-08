"""시세 서비스 (docs/DECISIONS.md 8-2·14-1·17). 증권사 조회는 `config.engine.broker_client()` 하나로 하고 Django 캐시에 짧게 둔다.

- **종목 조회의 시세는 실시간**이다 (docs/API.md 공통 규칙 "실시간 시세"): `quotes`(현재가 + 전 거래일 종가)·`candles`·`quote_price`.
  현재가를 받지 못한 종목만 장마감 기준 Quote(basis "close")다.
- **그 밖에 화면에 보이는 가격은 장마감 기준**이다 (docs/API.md 공통 규칙 "장마감 기준"): `basis`·`closes`·`close_price`·`completed_candles`.
  종가는 종목·기준일별로 캐시한다 (같은 종목·같은 기준일은 몇 명이 봐도 증권사 일봉 조회 1번).
  리포트 시세 조사와 미리 보기의 가격 점검은 `traded_since_basis`(기준일 뒤 정규장이 시작됨)이면 현재가를 쓴다 (docs/API.md "리포트 시세", DECISIONS 26).
- `confirmed_prices`·`last_price`는 **내부 경로 전용**이다 (모의 체결, sync, 예약 실행, 재주문, 활성화의 장중 확인).
  `current_prices`는 내부 경로와 실시간 시세가 같이 쓴다 (같은 1초 캐시).
- 현재가 1초, 일봉 120개·장 달력·환율 60초, 종가·전 거래일 종가(실시간 시세의 prevClose)·종목 목록(거래소별)·종목 정보·매수 유의는 하루
  (종가는 봉 날짜가 기준일보다 앞이거나 오늘 봉인데 현지 17:00(CLOSE_FINAL_AT) 전이면 10분, 전 거래일 종가는 장 달력의 직전 영업일과 맞지 않으면 10분).
- 체결에 쓰는 확인 가격(confirmed_prices)은 캐시하지 않는다.
- 클라이언트가 없거나 조회가 실패하면(KiwoomApiError, OSError) Unavailable(503). 환율만은 실패하면 None (엔진 Desk 방식).
- 응답 형식은 엔진 조회 클라이언트(키움·토스 같음) 형식이다: 가격은 문자열, 일봉은 openPrice/.../timestamp.
- 시세 출처 이름(quote_provider)은 여기 하나만 둔다 (longterm이 쓴다).
"""
import re
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from django.core.cache import cache
from django.utils import timezone
from paper_engine.data.calendar import NEW_YORK, close_basis_day, close_of, session_end_iso
from paper_engine.data.kiwoom import KiwoomApiError
from paper_engine.scheduler import current_session, regular_sessions
from paper_engine.trading import MARKET_LISTS

from config import engine
from config.api import Unavailable

PRICE_TTL, SHORT_TTL, DAY_TTL = 1, 60, 24 * 3600  # 현재가 1초는 실시간 시세와 내부 경로(체결·예약 기준 가격)가 같이 쓴다
CANDLE_COUNT = 120
# closes·quotes 한 번이 새로 받는 종가(실시간 시세는 전 거래일 종가) 수 (종목마다 일봉 조회 1번). 나머지는 다음 호출(폴링)에 채운다
CLOSE_BATCH = 10
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
# Quote.basis: 현재가(실시간) · 현재가를 받지 못한 종목은 직전 정규장 종가(장마감 기준)
BASIS_LIVE, BASIS_CLOSE = "live", "close"
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


# 한글로 읽은 영문 상호 → 종목 목록의 표기 (검색어는 _norm을 거친 대문자). 검색어에 있으면 바꾼 검색어로도 찾는다 (UX-12)
SEARCH_ALIASES = {
    "엘지": "LG", "에스케이": "SK", "네이버": "NAVER", "케이티앤지": "KT&G", "케이티": "KT", "씨제이": "CJ", "지에스": "GS",
    "에이치디": "HD", "케이비": "KB", "엘에스": "LS", "디비": "DB", "에쓰오일": "S-OIL", "에스오일": "S-OIL",
    "포스코": "POSCO", "에이치엠엠": "HMM", "에이치엘비": "HLB", "케이씨씨": "KCC", "에스디아이": "SDI",
}


def _variants(q: str) -> list[str]:
    """검색어와, 별칭을 바꾼 검색어 (다르면). 긴 별칭부터 바꾼다 (케이티앤지 → KT&G가 케이티 → KT보다 먼저)."""
    swapped = q
    for alias in sorted(SEARCH_ALIASES, key=len, reverse=True):
        swapped = swapped.replace(alias, SEARCH_ALIASES[alias])
    return [q] if swapped == q else [q, swapped]


def _rank(q: str, symbol: str, name: str) -> int | None:
    """정확히 같음 0, 앞부분이 같음 1, 이름에 들어 있음 2, 아니면 None."""
    if q in (symbol, name):
        return 0
    if symbol.startswith(q) or name.startswith(q):
        return 1
    return 2 if q in name else None


def search(query: str, limit: int) -> list[dict]:
    """이름 부분 일치·코드 앞부분 일치. 정확히 같은 것, 앞부분이 같은 것, 나머지 순.

    한글로 읽은 영문 상호(엘지 → LG 등, SEARCH_ALIASES)는 바꾼 검색어로도 찾아 합친다 (종목마다 더 나은 순위 하나만).
    """
    q = _norm(query)
    if not q:
        return []
    variants = _variants(q)
    ranked = []
    for item in directory().values():
        symbol, name = item["symbol"].upper(), _norm(item["name"])
        ranks = [r for v in variants if (r := _rank(v, symbol, name)) is not None]
        if ranks:
            ranked.append((min(ranks), len(name), item["symbol"], item))
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

def live_prices(symbols: list[str]) -> dict[str, tuple[float, str]]:
    """현재가와 받은 시각: {symbol: (가격, 받은 시각 ISO — 서버 시각, 초까지)}.

    종목마다 1초 캐시하고 없는 것만 한 번에 묶어 조회한다. 받지 못한 종목은 빠진다. 증권사 오류는 Unavailable(503).
    """
    out, missing = {}, []
    for symbol in dict.fromkeys(symbols):
        value = cache.get(f"trading:live:{symbol}", _MISSING)
        if value is _MISSING:
            missing.append(symbol)
        elif value is not None:
            out[symbol] = value
    if missing:
        fetched = {p["symbol"]: float(p["lastPrice"]) for p in _call("prices", missing) if p.get("lastPrice")}
        at = timezone.localtime().replace(microsecond=0).isoformat()
        for symbol in missing:
            value = (fetched[symbol], at) if symbol in fetched else None
            cache.set(f"trading:live:{symbol}", value, PRICE_TTL)
            if value is not None:
                out[symbol] = value
    return out


def current_prices(symbols: list[str]) -> dict[str, float]:
    """현재가 (실시간 시세·내부 평가용). live_prices와 같은 1초 캐시. 받지 못한 종목은 빠진다."""
    return {symbol: price for symbol, (price, _) in live_prices(symbols).items()}


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


def traded_since_basis(market: str, now: datetime | None = None) -> bool:
    """기준일 뒤 날짜의 정규장이 이미 시작됐는지 — 직전 정규장 종가보다 새 가격(현재가)이 있다 (docs/API.md "리포트 시세").

    정규장 중이거나, 오늘 정규장이 끝났지만 기준일이 아직 오늘로 바뀌기 전(KR 15:30~15:40 KST)이면 True.
    장 시작 전·기준일이 오늘로 바뀐 뒤·휴장이면 False. 장 달력(60초 캐시)을 받지 못하면 False (장마감 기준 쪽).
    """
    now = now or timezone.now()
    try:
        cal = calendar(market)
        day = close_basis_day(cal, market, now)
        starts = [start for start, _ in regular_sessions(cal)]
    except (Unavailable, KeyError, TypeError, ValueError):
        return False
    tz = MARKET_TZ[market]
    return bool(day) and any(start <= now and f"{start.astimezone(tz).date()}" > day for start in starts)


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


# --- 실시간 시세 (docs/API.md 공통 규칙 "실시간 시세", docs/DECISIONS.md 17) ---

def _session_today(market: str, today: date) -> tuple[bool, str | None]:
    """(오늘(그 시장 현지 날짜)에 정규장이 있는지, 장 달력의 직전 영업일 YYYY-MM-DD).

    장 달력(60초 캐시)을 받지 못하면 (평일인지, None) — 평일을 거래일로 본다.
    """
    tz = MARKET_TZ[market]
    try:
        cal = calendar(market)
        found = any(start.astimezone(tz).date() == today for start, _ in regular_sessions(cal))
        previous = (cal.get("previousBusinessDay") or {}).get("date")
    except (Unavailable, AttributeError, KeyError, TypeError, ValueError):
        return today.weekday() < 5, None
    return found, previous


def _prev_close(symbol: str, market: str, today: date, session: tuple[bool, str | None],
                budget: list[int]) -> float | None:
    """현재가가 속한 거래일의 전 거래일 종가 (일봉 candles()에서). 예산이 없으면 받지 않고 None (다음 호출에 채운다).

    가격이 속한 거래일 = 오늘(현지) 정규장이 있으면 오늘, 없으면(주말·휴장) 마지막 일봉 날짜.
    전 거래일 종가 = 날짜가 그 거래일보다 앞선 마지막 일봉의 종가. 일봉이 없으면 None.
    종목·오늘(현지 날짜)별로 하루 캐시한다 — 기준이 된 봉(오늘 거래일이면 전 거래일 봉, 아니면 마지막 봉)의 날짜가
    장 달력의 직전 영업일과 다르거나 장 달력을 받지 못했으면 10분(CLOSE_LAG_TTL), 받지 못하면 60초.
    """
    trading, previous = session
    key = f"trading:prev:{symbol}:{today}:{int(trading)}"
    value = cache.get(key, _MISSING)
    if value is not _MISSING:
        return value
    if budget[0] <= 0:
        return None
    budget[0] -= 1
    try:
        rows = candles(symbol)
        day = f"{today}" if trading else rows[-1]["timestamp"][:10]
        before = [c for c in rows if c["timestamp"][:10] < day]
        value = float(before[-1]["closePrice"]) if before else None
    except (Unavailable, IndexError, KeyError, TypeError, ValueError):
        value = None
    if value is None:
        cache.set(key, None, SHORT_TTL)  # 실패·봉 없음은 60초 뒤에 다시
        return None
    checked = before[-1]["timestamp"][:10] if trading else day
    cache.set(key, value, DAY_TTL if previous is not None and checked == previous else CLOSE_LAG_TTL)
    return value


def _quote(item: dict, price: float | None, prev: float | None, as_of: str | None, basis_: str) -> dict:
    both = price is not None and bool(prev)
    return {"symbol": item["symbol"], "name": item["name"], "currency": CURRENCY[item["market"]],
            "price": price, "prevClose": prev, "change": price - prev if both else None,
            "changeRate": price / prev - 1 if both else None, "asOf": as_of, "basis": basis_}


def quotes(symbols: list[str]) -> list[dict]:
    """Quote 목록 (실시간, docs/API.md Quote·공통 규칙 "실시간 시세"). 종목 목록에 없는 종목은 빠진다.

    live: price = 현재가 (live_prices, 1초 캐시), asOf = 받은 시각, prevClose = 그 가격이 속한 거래일의 전 거래일 종가 (_prev_close).
    현재가를 받지 못한 종목(조회 실패면 모두)은 장마감 기준(basis "close", closes): price = 직전 정규장 종가,
    prevClose = 그 전 거래일 종가, asOf = 종가 봉 날짜의 정규장 종료 시각. 종가를 받지 못하면 price·asOf가 null.
    한 호출이 새로 받는 일봉은 두 경우를 합쳐 CLOSE_BATCH(10)개까지라 처음 보는 종목은 prevClose(close면 price도)가
    잠깐 null일 수 있다 (다음 폴링에 채운다).
    """
    known = directory()
    items = [item for s in dict.fromkeys(map(norm_symbol, symbols)) if (item := known.get(s))]
    if not items:
        return []
    try:
        live = live_prices([i["symbol"] for i in items])
    except Unavailable:
        live = {}  # 현재가 조회 실패: 모두 장마감 기준으로
    budget = [CLOSE_BATCH]
    found = closes([i["symbol"] for i in items if i["symbol"] not in live], budget)
    local: dict[str, tuple[date, tuple[bool, str | None]]] = {}  # 시장 → (현지 오늘, _session_today)
    out = []
    for item in items:
        symbol, mkt = item["symbol"], item["market"]
        if symbol not in live:
            close = found.get(symbol) or {}
            out.append(_quote(item, close.get("price"), close.get("prevClose"), close.get("asOf"), BASIS_CLOSE))
            continue
        if mkt not in local:
            today = timezone.now().astimezone(MARKET_TZ[mkt]).date()
            local[mkt] = today, _session_today(mkt, today)
        today, session = local[mkt]
        price, as_of = live[symbol]
        out.append(_quote(item, price, _prev_close(symbol, mkt, today, session, budget), as_of, BASIS_LIVE))
    return out


def quote_price(symbol: str) -> float | None:
    """시세와 같은 가격: 현재가, 받지 못하면 직전 정규장 종가 (직접 주문의 시장가 매수 가능 점검 — docs/API.md POST /api/orders)."""
    symbol = norm_symbol(symbol)
    try:
        price = current_prices([symbol]).get(symbol)
    except Unavailable:
        price = None
    return price if price is not None else close_price(symbol)


def in_progress(market: str, day: str) -> bool:
    """day(그 시장 현지 날짜) 일봉이 오늘 진행 중인 봉인지: 오늘 봉이고 오늘 정규장 종료(장 달력, 없으면 기본 시각) 전."""
    now = timezone.now()
    return day == f"{now.astimezone(MARKET_TZ[market]).date()}" and now < datetime.fromisoformat(session_end(market, day))


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


# --- 시세 출처 ---

def quote_provider() -> str:
    """시세 출처 이름 (docs/API.md MarketStatus.quoteProvider). 장기투자 근거 목록의 출처 표기도 이 값을 쓴다."""
    return QUOTE_PROVIDERS.get(engine.engine_config().broker, QUOTE_PROVIDERS["kiwoom"])
