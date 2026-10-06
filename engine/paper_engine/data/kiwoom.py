"""키움 REST API 클라이언트. 조회만 다룬다 (계좌·주문 TR은 만들지 않는다).

엔진 내부 데이터 형식은 토스 Open API 응답 형식을 그대로 쓴다. 키움 응답 → 내부 형식 변환은 이 파일 안에서만 한다.
그래야 선별·백테스트·스냅샷·시장 기록 코드를 고치지 않고 쓸 수 있다. TR ID·필드·호출 제한은 docs/KIWOOM.md.

토큰은 파일 캐시로 공유하고 만료가 가까울 때만 재발급한다. 429·호출 제한은 간격을 두고 다시 시도하고, gzip 응답을 푼다.
엔진은 프로세스에 클라이언트를 하나만 만들고(`__main__._client`) serve의 여러 스레드가 같이 쓴다. 그래서 토큰 발급과
호출 간격 조절은 잠금 안에서 한다. 키움 한도는 토큰 단위라 다른 프로세스(CLI 등)와 동시에 쓰면 합쳐서 넘을 수 있다 (재시도로 흡수).

키움 숫자 표기: 가격은 "+71000"/"-71000"처럼 전일 대비 방향 부호가 붙고(값 자체는 양수), 종목 목록은 "00136000"처럼
앞자리를 0으로 채운다. 등락률은 % 단위("+1.23"), 거래대금은 국내 백만원·미국 천USD 단위다. 변환 후에는 부호 없는 가격,
소수 비율(0.0123), 원·USD 단위 금액이다.

이 파일의 공개 메서드 이름·인자·반환 형식은 공통 결정(docs/DECISIONS.md 3장)이다. 바꾸지 않는다.
"""
import gzip
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from zoneinfo import ZoneInfo

from .calendar import MarketCalendar, drop_incomplete

BASE_URL = "https://api.kiwoom.com"
KST = ZoneInfo("Asia/Seoul")
NEW_YORK = ZoneInfo("America/New_York")

TOKEN_MARGIN_SEC = 300
MAX_RETRIES = 3
TIMEOUT_SEC = 10
MAX_PAGES = 50              # 연속 조회 상한 (서버가 계속 cont-yn=Y를 주더라도 멈춘다)
OUTLIER_GAP = 0.03          # 현재가가 호가 기준 가격에서 이만큼 벗어나면 로그에 남긴다
QUOTE_CHUNK = 50            # ka10095 한 번에 묻는 종목 수 (문서에 상한이 없다. 실측 전이라 보수적으로)
FX_CACHE_SEC = 60           # 환율 TR은 초당 1회라 잠시 캐시한다

# 호출 간격. 공식 안내: 계좌(토큰)별 조회 TR 초당 5회(국내·미국), 미국 피크(09~10시 KST) 초당 3회,
# 환전 TR 초당 1회, 미국 종목리스트(usa10099) 분당 5회. 여러 프로세스가 토큰을 같이 쓰므로 여유를 둔다.
CALL_INTERVAL_SEC = 0.25
US_PEAK_INTERVAL_SEC = 0.34
TR_INTERVAL_SEC = {"usa10099": 12.5, "ust31301": 1.1}

AUTH_RETRY_CODES = {8005, 8031, 8103}   # 토큰 무효·만료 → 한 번 재발급 후 다시 시도
RATE_LIMIT_CODES = {1700, 1701, 1702}   # 허용 요청 개수 초과 → 간격을 두고 다시 시도
NOT_FOUND_CODES = {1901, 1902, 1903}    # 시장 코드·종목 정보 없음
_EMBEDDED_CODE = re.compile(r"\[(\d{3,5}):")  # return_code=3 + return_msg "[8005:...]" 형태

TR_PATHS = {
    "au10001": "/oauth2/token",
    "ka10004": "/api/dostk/mrkcond",
    "ka10027": "/api/dostk/rkinfo", "ka10032": "/api/dostk/rkinfo",
    "ka10059": "/api/dostk/stkinfo", "ka10095": "/api/dostk/stkinfo",
    "ka10099": "/api/dostk/stkinfo", "ka10100": "/api/dostk/stkinfo",
    "ka10081": "/api/dostk/chart",
    "usa06012": "/api/us/chart",
    "usa10098": "/api/us/stkinfo", "usa10099": "/api/us/stkinfo",
    "usa20100": "/api/us/mrkcond", "usa20101": "/api/us/mrkcond",
    "usa20540": "/api/us/rkinfo", "usa20910": "/api/us/rkinfo",
    "ust31301": "/api/us/exchange",
}

# ka10099 시장구분 → (거래소, 종목 유형). 같은 종목이 여러 목록에 있으면 앞의 특수 유형이 이긴다.
# 거래소(KOSPI·KOSDAQ)는 0·10 목록에 있는지로 정한다. 그 밖의 상품은 모두 유가증권시장(KOSPI) 상장이다.
KR_LISTS = (
    ("8", "ETF"), ("60", "ETN"), ("70", "ETN"), ("90", "ETN"), ("3", "ELW"), ("6", "REIT"),
    ("2", "INFRA_FUND"), ("4", "MUTUAL_FUND"), ("9", "HIGH_YIELD_FUND"), ("5", "WARRANT"), ("7", "WARRANT"),
    ("0", "STOCK"), ("10", "STOCK"),
)
KR_EXCHANGES = {"KOSPI": "0", "KOSDAQ": "10"}
US_EXCHANGES = {"NYSE": "NY", "NASDAQ": "ND", "AMEX": "NA"}
US_MARKET_NAMES = {v: k for k, v in US_EXCHANGES.items()}

# ka10099/ka10100 orderWarning → 매수 유의 유형 (warnings·exclude_caution)
ORDER_WARNINGS = {"1": "ETF_INVESTMENT_CAUTION", "2": "LIQUIDATION_TRADING", "3": "SHORT_TERM_OVERHEATED",
                  "4": "INVESTMENT_RISK", "5": "INVESTMENT_WARNING"}
AUDIT_WARNINGS = (("환기", "INVESTMENT_CAUTION_ALERT"), ("투자주의", "INVESTMENT_CAUTION"),
                  ("투자경고", "INVESTMENT_WARNING"), ("투자위험", "INVESTMENT_RISK"))
STATE_WARNINGS = (("관리종목", "ADMINISTRATIVE_ISSUE"), ("거래정지", "TRADING_SUSPENDED"),
                  ("정리매매", "LIQUIDATION_TRADING"))

RANKING_TYPES = ("MARKET_TRADING_AMOUNT", "TOP_GAINERS", "TOP_LOSERS")


class KiwoomApiError(Exception):
    """키움 API 오류. status는 HTTP 상태 코드(전송 오류는 0), body는 응답 본문(dict)."""

    def __init__(self, status: int, body: dict):
        self.status = status
        self.body = body
        super().__init__(f"HTTP {status} {body.get('return_code')}: {body.get('return_msg')}")


def _unsupported(message: str) -> KiwoomApiError:
    return KiwoomApiError(0, {"return_code": None, "return_msg": message})


class KiwoomClient:
    def __init__(self, appkey: str, secretkey: str, token_cache: Path | None = None,
                 calendar=None, base_url: str = BASE_URL):
        """calendar는 data.calendar의 장 달력 (market_calendar가 쓴다). None이면 공휴일 없이 요일·고정 시간만 쓴다."""
        self._appkey = appkey
        self._secretkey = secretkey
        self._token_cache = Path(token_cache) if token_cache else None
        self._calendar = calendar
        self._base_url = base_url.rstrip("/")
        self._token = None
        self._expires_at = 0.0
        self._token_lock = threading.Lock()
        self._throttle_lock = threading.Lock()
        self._data_lock = threading.Lock()
        self._directory_lock = threading.Lock()  # 종목 목록을 여러 스레드가 동시에 받지 않게
        self._next_call = 0.0
        self._next_tr: dict[str, float] = {}
        self._directory: tuple[str, dict] | None = None   # (KST 날짜, 종목코드 → 국내 종목 정보)
        self._us_info: dict[str, dict] = {}                # 미국 종목코드 → usa10098 항목
        self._fx: tuple[float, str] | None = None          # (monotonic 시각, USD/KRW)
        # 테스트에서 바꾼다
        self._urlopen = urllib.request.urlopen
        self._sleep = time.sleep
        self._clock = time.time
        self._monotonic = time.monotonic
        self._now = lambda: datetime.now(timezone.utc)

    # --- 인증 ---
    # 토큰은 프로세스끼리 파일 캐시로 공유하고 만료 5분 전까지 쓴다. 다른 프로세스가 재발급해 무효가 된 경우를 대비해
    # 인증 오류면 캐시 파일을 다시 읽어 보고, 같은 토큰이면 한 번만 재발급한다.

    def _access_token(self) -> str:
        with self._token_lock:
            now = self._clock()
            if self._token and now < self._expires_at - TOKEN_MARGIN_SEC:
                return self._token
            cached = self._read_token_cache()
            if cached and now < cached[1] - TOKEN_MARGIN_SEC:
                self._token, self._expires_at = cached
                return self._token
            return self._issue_token()

    def _refresh_token(self, rejected: str) -> str:
        with self._token_lock:
            cached = self._read_token_cache()
            if cached and cached[0] != rejected and self._clock() < cached[1] - TOKEN_MARGIN_SEC:
                self._token, self._expires_at = cached
                return self._token
            if self._token and self._token != rejected:
                return self._token
            return self._issue_token()

    def _issue_token(self) -> str:
        self._throttle("au10001")
        res, _ = self._send(TR_PATHS["au10001"], {"api-id": "au10001"}, {
            "grant_type": "client_credentials", "appkey": self._appkey, "secretkey": self._secretkey})
        try:
            expires = datetime.strptime(res["expires_dt"], "%Y%m%d%H%M%S").replace(tzinfo=KST)
            token = res["token"]
        except (KeyError, TypeError, ValueError):
            raise KiwoomApiError(200, {**res, "return_msg": f"토큰 응답 형식 오류: {res.get('return_msg')}"}) from None
        self._token, self._expires_at = token, expires.timestamp()
        if self._token_cache:
            self._token_cache.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._token_cache.with_name(f"{self._token_cache.name}.tmp{os.getpid()}")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"access_token": token, "expires_at": self._expires_at,
                           "base_url": self._base_url, "key": self._key_fingerprint()}, f)
            os.replace(tmp, self._token_cache)
        return token

    def _read_token_cache(self) -> tuple[str, float] | None:
        if not self._token_cache or not self._token_cache.exists():
            return None
        try:
            cached = json.loads(self._token_cache.read_text())
            if cached.get("base_url") != self._base_url or cached.get("key") != self._key_fingerprint():
                return None  # 실전·모의 도메인이나 앱키가 다르면 쓸 수 없다
            return cached["access_token"], float(cached["expires_at"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _key_fingerprint(self) -> str:
        return hashlib.sha256(self._appkey.encode()).hexdigest()[:16]

    # --- HTTP ---

    def _throttle(self, api_id: str) -> None:
        """호출 간격을 지킨다. 잠금 안에서 내 차례 시각을 예약하고 잠금 밖에서 기다린다."""
        interval = CALL_INTERVAL_SEC
        if api_id.startswith("us") and 9 <= self._now().astimezone(KST).hour < 10:
            interval = US_PEAK_INTERVAL_SEC
        with self._throttle_lock:
            now = self._monotonic()
            at = max(now, self._next_call, self._next_tr.get(api_id, 0.0))
            self._next_call = at + interval
            if api_id in TR_INTERVAL_SEC:
                self._next_tr[api_id] = at + TR_INTERVAL_SEC[api_id]
        if at > now:
            self._sleep(at - now)

    def _send(self, path: str, headers: dict, payload: dict) -> tuple[dict, dict]:
        """(응답 본문, 응답 헤더). 429와 호출 제한 오류는 간격을 두고 MAX_RETRIES번까지 다시 보낸다."""
        data = json.dumps(payload).encode()
        for attempt in range(MAX_RETRIES + 1):
            req = urllib.request.Request(self._base_url + path, data=data, method="POST", headers={
                "Content-Type": "application/json;charset=UTF-8", "Accept-Encoding": "gzip", **headers})
            try:
                with self._urlopen(req, timeout=TIMEOUT_SEC) as res:
                    status, body, res_headers = res.status, _decode(res.read()), res.headers
            except urllib.error.HTTPError as e:
                status, body, res_headers = e.code, _decode(e.read()), e.headers
            except (urllib.error.URLError, OSError) as e:  # 연결 실패·시간 초과
                raise KiwoomApiError(0, {"return_code": None, "return_msg": f"전송 오류: {e}"}) from None
            code = _return_code(body)
            if (status == 429 or code in RATE_LIMIT_CODES) and attempt < MAX_RETRIES:
                self._sleep(_retry_after(res_headers, attempt))
                continue
            if status >= 400 or code not in (None, 0):
                raise KiwoomApiError(status, body)
            return body, _lower_headers(res_headers)
        raise AssertionError("unreachable")

    def _call(self, api_id: str, body: dict, next_key: str | None = None) -> tuple[dict, str | None]:
        """TR 한 번. (응답 본문, 다음 페이지 키 또는 None). next_key를 주면 연속 조회로 보낸다."""
        headers = {"api-id": api_id}
        if next_key is not None:
            headers.update({"cont-yn": "Y", "next-key": next_key})
        self._throttle(api_id)
        token = self._access_token()
        try:
            data, res_headers = self._send(TR_PATHS[api_id], {**headers, "authorization": f"Bearer {token}"}, body)
        except KiwoomApiError as e:
            if not _auth_failed(e):
                raise
            token = self._refresh_token(token)
            self._throttle(api_id)
            data, res_headers = self._send(TR_PATHS[api_id], {**headers, "authorization": f"Bearer {token}"}, body)
        more = res_headers.get("cont-yn") == "Y"
        return data, (res_headers.get("next-key") or "") if more else None

    def _pages(self, api_id: str, body: dict, key: str, next_key: str | None = None):
        """연속 조회를 따라가며 (이 페이지의 항목, 다음 페이지 키 또는 None)를 낸다."""
        for _ in range(MAX_PAGES):
            data, next_key = self._call(api_id, body, next_key)
            yield data.get(key) or [], next_key
            if next_key is None:
                return

    def _collect(self, api_id: str, body: dict, key: str, limit: int | None = None) -> list[dict]:
        rows = []
        for page, _ in self._pages(api_id, body, key):
            rows += page
            if limit and len(rows) >= limit:
                break
        return rows

    # --- 시세·종목 ---

    def prices(self, symbols: list[str]) -> list[dict]:
        """현재가. [{"symbol": "005930", "lastPrice": "71000"}, ...] (가격은 문자열, 받은 종목만)."""
        found = {}
        kr = [s for s in symbols if _is_kr(s)]
        for i in range(0, len(kr), QUOTE_CHUNK):
            data, _ = self._call("ka10095", {"stk_cd": "|".join(kr[i:i + QUOTE_CHUNK])})
            for row in data.get("atn_stk_infr") or []:
                price = _price(row.get("cur_prc"))
                if price:
                    found[_code(row.get("stk_cd"))] = price
        for symbol in dict.fromkeys(symbols):
            if not _is_kr(symbol):
                try:
                    data, _ = self._call("usa20100", {"stex_tp": self._us_exchange(symbol), "stk_cd": symbol})
                except KiwoomApiError as e:
                    if _return_code(e.body) in NOT_FOUND_CODES:  # 없는 종목은 빼고 받은 종목만 돌려준다
                        continue
                    raise
                price = _price(data.get("cur_prc"))
                if price:
                    found[symbol] = price
        return [{"symbol": s, "lastPrice": found[s]} for s in dict.fromkeys(symbols) if s in found]

    def orderbook(self, symbol: str) -> dict:
        """호가. {"bids": [{"price": "70900", "quantity": "123"}, ...], "asks": [...]} (최우선 호가가 0번)."""
        if _is_kr(symbol):
            data, _ = self._call("ka10004", {"stk_cd": symbol})
            levels = [("fpr", "fpr")] + [(f"{n}th_pre", f"{n}th_pre") for n in range(2, 11)]
            asks = [(data.get(f"sel_{p}_bid"), data.get(f"sel_{q}_req")) for p, q in levels]
            bids = [(data.get(f"buy_{p}_bid"), data.get(f"buy_{q}_req")) for p, q in levels]
        else:
            data, _ = self._call("usa20101", {"stex_tp": self._us_exchange(symbol), "stk_cd": symbol})
            asks = [(data.get(f"sel_{n}bid"), data.get(f"sel_{n}bid_req")) for n in range(1, 11)]
            bids = [(data.get(f"buy_{n}bid"), data.get(f"buy_{n}bid_req")) for n in range(1, 11)]
        return {"bids": _levels(bids), "asks": _levels(asks)}

    def confirmed_prices(self, symbols: list[str]) -> dict[str, float]:
        """주문 판단(모의 체결)에 쓰는 가격: 현재가, 최우선 매수호가, 최우선 매도호가의 중간값.

        현재가는 마지막 체결 한 건의 가격이라 비정상 체결 한 건으로 크게 튈 수 있다. 호가와 함께 보면 튀는 값 하나는 버려진다.
        상한가·하한가처럼 한쪽 호가만 있으면 현재가가 그 호가와 OUTLIER_GAP 안일 때만 현재가를 쓴다
        (상한가에 잠긴 종목의 목표가 청산이 막히지 않게). 호가를 받지 못한 종목은 돌려주지 않는다
        (확인되지 않은 가격으로 체결하지 않기 위해).
        """
        if not symbols:
            return {}
        last = {p["symbol"]: float(p["lastPrice"]) for p in self.prices(symbols)}
        prices = {}
        for symbol in symbols:
            try:
                book = self.orderbook(symbol)
                sides = [float(book[k][0]["price"]) for k in ("bids", "asks") if book.get(k)]
                current = last[symbol]
            except (KiwoomApiError, KeyError, IndexError, TypeError, ValueError):
                continue
            if len(sides) == 2:
                price = sorted((current, *sides))[1]
                if abs(current / price - 1) > OUTLIER_GAP:
                    print(f"{symbol} 현재가 {current:,}가 호가({sides[0]:,} / {sides[1]:,})와 크게 달라 호가 기준 가격을 씀",
                          flush=True)
            elif len(sides) == 1 and abs(current / sides[0] - 1) <= OUTLIER_GAP:
                price = current
            else:
                continue
            prices[symbol] = price
        return prices

    def stocks(self, symbols: list[str]) -> list[dict]:
        """종목 정보. 항목: symbol, name, englishName(없으면 None), market(KOSPI|KOSDAQ|NYSE|NASDAQ|AMEX),
        currency(KRW|USD), securityType(STOCK|FOREIGN_STOCK|DEPOSITARY_RECEIPT|ETF|ETN|...), status(ACTIVE|...),
        leverageFactor(없으면 None), koreanMarketDetail({"krxTradingSuspended": bool, "liquidationTrading": bool}).
        screen.eligible이 이 필드로 ETF·ETN·레버리지·거래정지·정리매매를 거른다.

        국내는 종목정보 리스트(ka10099)를 하루 한 번 받아 유형을 정한다 (ETF·ETN·ELW·리츠·펀드·신주인수권 목록에 있으면
        그 유형, 이름에 "스팩"이 있으면 SPAC). 목록에 없는 종목은 종목정보 조회(ka10100)로 묻는다. 찾지 못한 종목은 뺀다.
        """
        out = []
        directory = self._kr_directory() if any(_is_kr(s) for s in symbols) else {}
        for symbol in dict.fromkeys(symbols):
            try:
                if _is_kr(symbol):
                    entry = directory.get(symbol) or self._kr_lookup(symbol)
                    if entry:
                        out.append(_kr_stock(symbol, entry))
                else:
                    out.append(_us_stock(self._us_lookup(symbol)))
            except KiwoomApiError as e:
                if _return_code(e.body) not in NOT_FOUND_CODES:  # 종목 정보 없음은 빼고 넘어간다
                    raise
        return out

    def daily_candles(self, symbol: str, count: int = 200) -> list[dict]:
        """일봉, 과거 → 최신. 항목: timestamp("2026-09-29T00:00:00+09:00" 형식, 앞 10자가 거래일),
        openPrice, highPrice, lowPrice, closePrice, volume (문자열 숫자, 수정주가). 장중이면 마지막 봉은 미완성이다."""
        return self.candles_before(symbol, None, count)[0][-count:]

    def candles_before(self, symbol: str, before: str | None = None,
                       count: int = 200) -> tuple[list[dict], str | None]:
        """(일봉 과거 → 최신, 다음 페이지 커서). before는 앞 페이지가 준 커서 (None이면 최신부터).
        더 과거 페이지가 없으면 커서는 None. 커서는 불투명한 문자열이다.

        한 번에 count개 이상을 받으면 멈춘다 (키움 페이지 단위라 count보다 많을 수 있다). 수정주가는 기준일자 이후에
        권리가 생긴 경우에만 반영되므로, 첫 요청의 기준일자를 커서에 담아 연속 조회 내내 같은 기준일자로 묻는다.
        """
        base, next_key = before.split("|", 1) if before else (self._now().astimezone(KST).strftime("%Y%m%d"), None)
        if _is_kr(symbol):
            api_id, key, convert = "ka10081", "stk_dt_pole_chart_qry", _kr_candle
            body = {"stk_cd": symbol, "base_dt": base, "upd_stkpc_tp": "1"}
        else:
            api_id, key, convert = "usa06012", "result_list", _us_candle
            body = {"stex_tp": self._us_exchange(symbol), "stk_cd": symbol, "upd_stkpc_tp": "1", "exrt_appl_tp": "0"}
        rows, cursor = [], None
        for page, next_key in self._pages(api_id, body, key, next_key):
            rows += page
            cursor = f"{base}|{next_key}" if next_key is not None else None
            if len(rows) >= count:
                break
        candles = {c["timestamp"][:10]: c for c in map(convert, rows) if c}
        return [candles[d] for d in sorted(candles)], cursor

    def completed_daily_candles(self, symbol: str, market_country: str, count: int = 200) -> list[dict]:
        """정규장이 끝난 일봉만 (drop_incomplete + market_calendar)."""
        calendar = self.market_calendar(market_country)
        return drop_incomplete(self.daily_candles(symbol, count), calendar, self._now())

    def market_calendar(self, market_country: str) -> dict:
        """장 운영 정보 (data/calendar.py 형식). market_country는 KR | US."""
        if self._calendar is None:
            self._calendar = MarketCalendar()
        return self._calendar.calendar(market_country, self._now())

    def listed_stocks(self, market: str) -> list[dict]:
        """거래소(KOSPI, KOSDAQ, NYSE, NASDAQ, AMEX)의 전체 종목 목록. 항목에 최소 symbol, name."""
        if market in KR_EXCHANGES:
            return [{"symbol": code, "name": e["name"], "market": market, "securityType": e["kind"]}
                    for code, e in self._kr_directory().items() if e["market"] == market]
        if market in US_EXCHANGES:
            rows = self._collect("usa10099", {"stex_tp": US_EXCHANGES[market]}, "list")
            out = []
            for row in rows:
                symbol = (row.get("stk_cd") or "").strip()
                if symbol:
                    self._us_info.setdefault(symbol, row)
                    out.append({"symbol": symbol, "name": row.get("stk_nm") or symbol,
                                "englishName": row.get("stk_enm") or None, "market": market,
                                "securityType": "ETF" if row.get("isEtf") == "Y" else "STOCK"})
            return out
        raise _unsupported(f"지원하지 않는 거래소: {market}")

    def warnings(self, symbol: str) -> list[dict]:
        """매수 유의사항. [{"warningType": "INVESTMENT_CAUTION"}, ...]. 없으면 [].

        국내는 종목정보의 투자유의(orderWarning)·감리구분(auditInfo)·종목상태(state)에서 만든다. 미국은 키움이 주지 않아 [].
        """
        if not _is_kr(symbol):
            return []
        entry = self._kr_directory().get(symbol) or self._kr_lookup(symbol) or {}
        return [{"warningType": t, "description": d} for t, d in _kr_warnings(entry)]

    def investor_trading(self, symbol: str, count: int = 20) -> list[dict]:
        """투자자별 매매동향 (국내만), 최신 → 과거. 항목: {"date": "YYYY-MM-DD",
        "individual": {"netBuyVolume": "123"}, "foreigner": {...}, "institution": {...}} (없는 투자자는 None)."""
        if not _is_kr(symbol):
            raise _unsupported("투자자별 매매동향은 국내 종목만 지원")
        body = {"dt": self._now().astimezone(KST).strftime("%Y%m%d"), "stk_cd": symbol,
                "amt_qty_tp": "2", "trde_tp": "0", "unit_tp": "1"}  # 수량, 순매수, 1주 단위
        out = []
        for row in self._collect("ka10059", body, "stk_invsr_orgn", count):
            if not row.get("dt"):
                continue
            out.append({"date": _iso_day(row["dt"]),
                        **{name: ({"netBuyVolume": v} if (v := _signed(row.get(field))) is not None else None)
                           for name, field in (("individual", "ind_invsr"), ("foreigner", "frgnr_invsr"),
                                               ("institution", "orgn"))}})
        out.sort(key=lambda r: r["date"], reverse=True)
        return out[:count]

    def rankings(self, type_: str, market_country: str, duration: str = "1d",
                 count: int = 30) -> list[dict]:
        """rankings_with_time(...)[0]."""
        return self.rankings_with_time(type_, market_country, duration, count)[0]

    def rankings_with_time(self, type_: str, market_country: str, duration: str = "1d", count: int = 30,
                           exclude_caution: bool = True) -> tuple[list[dict], str | None]:
        """(순위 목록, 집계 기준 시각 ISO 또는 None). type_: MARKET_TRADING_AMOUNT | TOP_GAINERS | TOP_LOSERS.
        duration: 1d(필수 지원), 그 밖(1w, 1mo, 3mo, 6mo, 1y)은 지원하지 않으면 KiwoomApiError.
        항목: {"rank": 1, "symbol": "005930", "tradingAmount": "1.2e12", "tradingVolume": "123",
               "price": {"lastPrice": "71000", "changeRate": "0.0123"}} (changeRate는 소수 비율).
        exclude_caution이면 투자 유의 종목을 뺀다.

        키움 순위 TR은 당일 순위만 있고 집계 시각을 주지 않는다 (기준 시각은 None). 등락률 순위에는 거래대금이 없다
        (tradingAmount None). 국내는 관리종목을 요청 옵션으로 빼고, 투자 유의(warnings와 같은 기준)는 종목정보로 거른 뒤
        순위를 1부터 다시 매긴다. 미국은 투자 유의 정보가 없어 거르지 않는다.
        """
        if type_ not in RANKING_TYPES:
            raise _unsupported(f"지원하지 않는 순위 유형: {type_}")
        if duration != "1d":
            raise _unsupported(f"키움 순위 TR은 당일(1d)만 지원: {duration}")
        if market_country == "KR":
            if type_ == "MARKET_TRADING_AMOUNT":
                api_id, key = "ka10032", "trde_prica_upper"
                body = {"mrkt_tp": "000", "mang_stk_incls": "0" if exclude_caution else "1", "stex_tp": "1"}
            else:
                api_id, key = "ka10027", "pred_pre_flu_rt_upper"
                body = {"mrkt_tp": "000", "sort_tp": "1" if type_ == "TOP_GAINERS" else "3", "trde_qty_cnd": "0000",
                        "stk_cnd": "1" if exclude_caution else "0", "crd_cnd": "0", "updown_incls": "1",
                        "pric_cnd": "0", "trde_prica_cnd": "0", "stex_tp": "1"}
            directory = self._kr_directory() if exclude_caution else {}
            convert, amount_unit = _kr_rank, 1_000_000  # 거래대금 백만원
        elif market_country == "US":
            if type_ == "MARKET_TRADING_AMOUNT":
                api_id, key = "usa20540", "result_list"
                body = {"stex_tp": "0", "inds_cd": "", "stk_tp": "0", "trde_qty_tp": "0", "stk_cnd": "0",
                        "pric_cnd": "0", "trde_prica_cnd": "0"}
            else:
                api_id, key = "usa20910", "result_list"
                body = {"stex_tp": "0", "inds_cd": "", "inds_cls_tp": "0", "sort_tp": "1" if type_ == "TOP_GAINERS"
                        else "4", "stk_tp": "0", "stk_cnd": "0", "pric_cnd": "0", "trde_prica_cnd": "0",
                        "trde_qty_tp": "0"}
            directory = {}
            convert, amount_unit = _us_rank, 1_000  # 거래대금 천USD
        else:
            raise _unsupported(f"지원하지 않는 시장: {market_country}")
        items: list[dict] = []
        for page, _ in self._pages(api_id, body, key):
            for row in page:
                item = convert(row, amount_unit)
                if not item or any(i["symbol"] == item["symbol"] for i in items):
                    continue
                if directory and _kr_warnings(directory.get(item["symbol"]) or {}):
                    continue
                if market_country == "US" and row.get("stex_tp"):
                    self._us_info.setdefault(item["symbol"], {"stk_cd": item["symbol"], "stex_tp": row["stex_tp"],
                                                              "stk_nm": row.get("stk_nm"),
                                                              "stk_enm": row.get("stk_enm")})
                items.append({"rank": len(items) + 1, **item})
            if len(items) >= count:
                break
        return items[:count], None

    def exchange_rate(self, base: str = "USD", quote: str = "KRW") -> dict:
        """환율. {"rate": "1390.5"} (base 1단위의 quote 가격, 문자열).

        키움 환율 조회(ust31301)의 원화→달러 매수 적용환율과 달러→원화 매도 적용환율의 평균(매매기준율 근사)이다.
        한쪽만 받으면 그 값을 쓴다. USD/KRW와 KRW/USD만 지원한다.
        """
        if {base, quote} != {"USD", "KRW"}:
            raise _unsupported(f"지원하지 않는 통화쌍: {base}/{quote}")
        with self._data_lock:
            fresh = self._fx and self._monotonic() - self._fx[0] < FX_CACHE_SEC
            usd_krw = self._fx[1] if fresh else None
        if usd_krw is None:
            usd_krw = self._fetch_usd_krw()
            with self._data_lock:
                self._fx = (self._monotonic(), usd_krw)
        if base == "USD":
            return {"rate": usd_krw}
        return {"rate": format(Decimal(1) / Decimal(usd_krw), ".10f")}

    def _fetch_usd_krw(self) -> str:
        rates, error = [], None
        for exch_tp, field in (("1", "buy_aplc_exrt"), ("2", "sell_aplc_exrt")):
            try:
                data, _ = self._call("ust31301", {"exch_tp": exch_tp})
            except KiwoomApiError as e:
                error = e
                continue
            value = _decimal(data.get(field)) or _decimal(data.get("aplc_exrt"))
            if value:
                rates.append(value)
        if not rates:
            raise error or KiwoomApiError(200, {"return_code": None, "return_msg": "환율 응답에 값이 없음"})
        return format(sum(rates) / len(rates), "f")

    # --- 국내 종목 목록 (하루 캐시) ---

    def _kr_directory(self) -> dict[str, dict]:
        """종목코드 → {"name", "kind", "market", "orderWarning", "auditInfo", "state"}. KST 날짜별로 한 번 만든다.
        token_cache와 같은 폴더에 kiwoom-stocks-<날짜>.json으로 캐시해 프로세스끼리 같이 쓴다."""
        day = self._now().astimezone(KST).date().isoformat()
        with self._directory_lock:
            return self._load_directory(day)

    def _load_directory(self, day: str) -> dict[str, dict]:
        with self._data_lock:
            if self._directory and self._directory[0] == day:
                return self._directory[1]
        path = self._token_cache.parent / f"kiwoom-stocks-{day}.json" if self._token_cache else None
        directory = None
        if path and path.exists():
            try:
                directory = json.loads(path.read_text())
            except (OSError, ValueError):
                directory = None
        if directory is None:
            directory = self._build_directory()
            if path:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_name(f"{path.name}.tmp{os.getpid()}")
                tmp.write_text(json.dumps(directory, ensure_ascii=False))
                os.replace(tmp, path)
                for old in path.parent.glob("kiwoom-stocks-*.json"):
                    if old != path:
                        old.unlink(missing_ok=True)
        with self._data_lock:
            self._directory = (day, directory)
        return directory

    def _build_directory(self) -> dict[str, dict]:
        directory: dict[str, dict] = {}
        for mrkt_tp, kind in KR_LISTS:
            market = next((m for m, code in KR_EXCHANGES.items() if code == mrkt_tp), None)
            for row in self._collect("ka10099", {"mrkt_tp": mrkt_tp}, "list"):
                code = _code(row.get("code"))
                if not code:
                    continue
                entry = directory.get(code)
                if entry is None:
                    entry = directory[code] = _kr_entry(row, kind)
                if market:
                    entry["market"] = market
        return directory

    def _kr_lookup(self, symbol: str) -> dict | None:
        """목록에 없는 종목 (오늘 상장 등). ka10100의 시장구분코드로 유형을 정하고, 모르는 코드는 UNKNOWN."""
        try:
            data, _ = self._call("ka10100", {"stk_cd": symbol})
        except KiwoomApiError as e:
            if _return_code(e.body) in NOT_FOUND_CODES:
                return None
            raise
        if not data.get("code"):
            return None
        market_code = str(data.get("marketCode") or "").strip()
        kind = dict(KR_LISTS).get(market_code, "UNKNOWN")
        entry = _kr_entry(data, kind)
        entry["market"] = "KOSDAQ" if market_code == "10" or "코스닥" in (data.get("marketName") or "") else "KOSPI"
        return entry

    # --- 미국 종목 ---

    def _us_lookup(self, symbol: str) -> dict:
        with self._data_lock:
            info = self._us_info.get(symbol)
        if info and info.get("stk_nm") is not None and "isEtf" in info:
            return info
        data, _ = self._call("usa10098", {"stk_cd": symbol})
        rows = [r for r in data.get("list") or [] if (r.get("stk_cd") or "").strip() == symbol] or data.get("list")
        if not rows:
            raise KiwoomApiError(200, {"return_code": 1903, "return_msg": f"미국 종목 정보 없음: {symbol}"})
        with self._data_lock:
            self._us_info[symbol] = rows[0]
        return rows[0]

    def _us_exchange(self, symbol: str) -> str:
        """미국 TR에 필요한 거래소구분(NY·ND·NA)."""
        with self._data_lock:
            info = self._us_info.get(symbol)
        if info and info.get("stex_tp"):
            return info["stex_tp"]
        return self._us_lookup(symbol)["stex_tp"]


# --- 변환 (키움 → 내부 형식) ---

def _is_kr(symbol: str) -> bool:
    """국내 종목코드는 숫자로 시작하는 6자리(신규 코드는 0001A0처럼 영문 포함), 미국은 영문 티커."""
    return len(symbol) == 6 and symbol[0].isdigit()


def _code(value) -> str:
    """"A005930"·"005930_AL" 같은 표기에서 종목코드만."""
    text = str(value or "").strip()
    text = text.split("_", 1)[0]
    return text[1:] if len(text) == 7 and text[0] == "A" else text


def _decimal(value) -> Decimal | None:
    text = str(value if value is not None else "").strip().replace(",", "")
    if not text:
        return None
    try:
        return Decimal(text)
    except InvalidOperation:
        return None


def _price(value) -> str | None:
    """부호(전일 대비 방향)·앞자리 0을 뗀 가격 문자열. 값이 없거나 0이면 None."""
    d = _decimal(value)
    if d is None or d == 0:
        return None
    return format(abs(d).normalize(), "f")


def _number(value) -> str | None:
    """부호 없는 수량·금액."""
    d = _decimal(value)
    return None if d is None else format(abs(d).normalize(), "f")


def _signed(value) -> str | None:
    """부호가 의미 있는 수 (순매수 등). "+1584" → "1584", "-61779" → "-61779"."""
    d = _decimal(value)
    return None if d is None else format(d.normalize(), "f")


def _rate(value) -> str | None:
    """% 단위 등락률 → 소수 비율. "+1.23" → "0.0123"."""
    d = _decimal(value)
    return None if d is None else format((d / 100).normalize(), "f")


def _amount(value, unit: int) -> str | None:
    d = _decimal(value)
    return None if d is None else format((abs(d) * unit).normalize(), "f")


def _iso_day(text: str) -> str:
    text = str(text).strip()
    return f"{text[:4]}-{text[4:6]}-{text[6:8]}"


def _kr_candle(row: dict) -> dict | None:
    if not row.get("dt") or not _price(row.get("cur_prc")):
        return None
    return {"timestamp": f"{_iso_day(row['dt'])}T00:00:00+09:00",
            "openPrice": _price(row.get("open_pric")), "highPrice": _price(row.get("high_pric")),
            "lowPrice": _price(row.get("low_pric")), "closePrice": _price(row.get("cur_prc")),
            "volume": _number(row.get("trde_qty")) or "0"}


def _us_candle(row: dict) -> dict | None:
    if not row.get("dt") or not _price(row.get("cur_prc")):
        return None
    day = _iso_day(row["dt"])
    start = datetime.fromisoformat(day).replace(tzinfo=NEW_YORK)  # 미국 거래일 (장 달력 date와 같은 기준)
    return {"timestamp": start.isoformat(),
            "openPrice": _price(row.get("open_pric")), "highPrice": _price(row.get("high_pric")),
            "lowPrice": _price(row.get("low_pric")), "closePrice": _price(row.get("cur_prc")),
            "volume": _number(row.get("acc_trde_qty")) or "0"}


def _levels(pairs) -> list[dict]:
    """(가격, 잔량) 목록 → 호가 항목. 가격이 0이거나 없는 단계(장 마감 후 등)는 뺀다."""
    out = []
    for price, quantity in pairs:
        p = _price(price)
        if p:
            out.append({"price": p, "quantity": _number(quantity) or "0"})
    return out


def _kr_rank(row: dict, amount_unit: int) -> dict | None:
    symbol = _code(row.get("stk_cd"))
    if not symbol:
        return None
    return {"symbol": symbol, "name": row.get("stk_nm"),
            "tradingAmount": _amount(row.get("trde_prica"), amount_unit) if "trde_prica" in row else None,
            "tradingVolume": _number(row.get("now_trde_qty")),
            "price": {"lastPrice": _price(row.get("cur_prc")), "changeRate": _rate(row.get("flu_rt"))}}


def _us_rank(row: dict, amount_unit: int) -> dict | None:
    symbol = (row.get("stk_cd") or "").strip()
    if not symbol:
        return None
    return {"symbol": symbol, "name": row.get("stk_nm"),
            "tradingAmount": _amount(row.get("trde_prica"), amount_unit) if "trde_prica" in row else None,
            "tradingVolume": _number(row.get("acc_trde_qty") if "acc_trde_qty" in row else row.get("trde_qty")),
            "price": {"lastPrice": _price(row.get("cur_prc")), "changeRate": _rate(row.get("flu_rt"))}}


def _kr_entry(row: dict, kind: str) -> dict:
    name = (row.get("name") or "").strip()
    if kind == "STOCK" and "스팩" in name:
        kind = "SPAC"
    return {"name": name, "kind": kind, "market": None,
            "orderWarning": str(row.get("orderWarning") or "0").strip(),
            "auditInfo": (row.get("auditInfo") or "").strip(), "state": (row.get("state") or "").strip()}


def _kr_warnings(entry: dict) -> list[tuple[str, str]]:
    found = []
    order = entry.get("orderWarning") or "0"
    if order in ORDER_WARNINGS:
        found.append((ORDER_WARNINGS[order], f"투자유의 {order}"))
    audit = entry.get("auditInfo") or ""
    if audit and audit != "정상":
        found.append((next((t for word, t in AUDIT_WARNINGS if word in audit), "AUDIT"), audit))
    state = entry.get("state") or ""
    for word, type_ in STATE_WARNINGS:
        if word in state:
            found.append((type_, word))
    seen = {}
    for type_, description in found:
        seen.setdefault(type_, description)  # 같은 유형은 하나만
    return list(seen.items())


def _leverage(name: str, kind: str) -> str | None:
    if kind not in ("ETF", "ETN"):
        return None
    if re.search(r"인버스\s*2X|곱버스", name, re.I):
        return "-2"
    if "인버스" in name:
        return "-1"
    if re.search(r"레버리지|2X|3X", name, re.I):
        return "3" if re.search(r"3X", name, re.I) else "2"
    return None


def _kr_stock(symbol: str, entry: dict) -> dict:
    state = entry.get("state") or ""
    return {"symbol": symbol, "name": entry["name"], "englishName": None,
            "market": entry.get("market") or "KOSPI", "currency": "KRW", "securityType": entry["kind"],
            "status": "ACTIVE", "leverageFactor": _leverage(entry["name"], entry["kind"]),
            "koreanMarketDetail": {"krxTradingSuspended": "거래정지" in state,
                                   "liquidationTrading": entry.get("orderWarning") == "2" or "정리매매" in state}}


def _us_stock(info: dict) -> dict:
    symbol = (info.get("stk_cd") or "").strip()
    return {"symbol": symbol, "name": info.get("stk_nm") or symbol, "englishName": info.get("stk_enm") or None,
            "market": US_MARKET_NAMES.get(info.get("stex_tp"), info.get("mkgb")), "currency": "USD",
            "securityType": "ETF" if info.get("isEtf") == "Y" else "STOCK", "status": "ACTIVE",
            "leverageFactor": None, "koreanMarketDetail": None}


# --- HTTP 보조 ---

def _decode(raw: bytes) -> dict:
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    try:
        data = json.loads(raw or b"{}")
    except ValueError:
        return {"return_code": None, "return_msg": "non-json-response: " + raw[:300].decode(errors="replace")}
    return data if isinstance(data, dict) else {"return_code": None, "return_msg": "unexpected-json", "data": data}


def _return_code(body: dict) -> int | None:
    """return_code는 숫자 또는 숫자 문자열로 온다. 없거나 숫자가 아니면 None."""
    value = body.get("return_code")
    if value is None or isinstance(value, bool):
        return None
    try:
        return int(str(value).strip())
    except ValueError:
        return None


def _auth_failed(e: KiwoomApiError) -> bool:
    if e.status == 401 or _return_code(e.body) in AUTH_RETRY_CODES:
        return True
    match = _EMBEDDED_CODE.search(str(e.body.get("return_msg") or ""))
    return bool(match) and int(match.group(1)) in AUTH_RETRY_CODES


def _retry_after(headers, attempt: int) -> float:
    try:
        return max(float(headers.get("Retry-After")), 0.5)
    except (TypeError, ValueError, AttributeError):
        return float(2 ** attempt)


def _lower_headers(headers) -> dict:
    try:
        return {k.lower(): v for k, v in headers.items()}
    except AttributeError:
        return {}
