"""토스증권 Open API 클라이언트. 조회만 다룬다. **로컬 개발 환경 전용**이다 (.env의 BROKER=toss, docs/DECISIONS.md 3장).

운영(EC2)은 키움(data/kiwoom.py)을 쓴다. 키움 앱키 없이도 로컬에서 엔진을 돌려 볼 수 있게 원본 toss_trading의 조회
클라이언트를 되살린 것이다. 엔진 내부 데이터 형식이 토스 응답 형식이라 응답을 변환하지 않고 그대로 돌려준다.
공개 메서드 이름·인자·반환 형식은 KiwoomClient와 같다 (형식 설명은 KiwoomClient의 docstring).

계좌·주문 API는 넣지 않는다 (계좌 헤더도 보내지 않는다). 토큰 발급 말고는 GET만 보낸다.

토큰은 client당 유효한 것이 1개라, 새로 발급하면 같은 CLIENT_ID를 쓰는 다른 프로세스·다른 머신의 토큰이 무효가 된다.
이 머신의 프로세스끼리는 파일 캐시로 토큰을 공유하고 만료가 가까울 때만 재발급한다. 운영 중인 원본 toss_trading과
같은 CLIENT_ID를 쓰면 서로의 토큰을 무효로 만드므로 개발용 client를 따로 발급해 쓴다.
"""
import gzip
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from .calendar import drop_incomplete
from .kiwoom import KiwoomApiError, KiwoomClient

BASE_URL = "https://openapi.tossinvest.com"
TOKEN_MARGIN_SEC = 300
MAX_RETRIES = 3
TIMEOUT_SEC = 10


class TossApiError(KiwoomApiError):
    """토스 API 오류. status는 HTTP 상태 코드(전송 오류는 0), body는 응답 본문(dict).

    엔진은 조회 오류로 KiwoomApiError만 잡는다 (docs/DECISIONS.md 3장). 그 계약에 맞추려고 하위 클래스로 둔다.
    """

    def __init__(self, status: int, body: dict):
        self.status = status
        self.body = body
        err = body.get("error")
        if isinstance(err, dict):
            detail = f"{err.get('code')}: {err.get('message')} (requestId={err.get('requestId')})"
        else:
            detail = f"{err}: {body.get('error_description')}"
        Exception.__init__(self, f"HTTP {status} {detail}")


class TossClient:
    def __init__(self, client_id: str, client_secret: str, token_cache: Path | None = None,
                 base_url: str = BASE_URL):
        self._client_id = client_id
        self._client_secret = client_secret
        self._token_cache = Path(token_cache) if token_cache else None
        self._base_url = base_url.rstrip("/")
        self._token = None
        self._expires_at = 0.0
        self._token_lock = threading.Lock()  # serve의 여러 스레드가 클라이언트 하나를 같이 쓴다
        # 테스트에서 바꾼다
        self._urlopen = urllib.request.urlopen
        self._sleep = time.sleep
        self._clock = time.time
        self._now = lambda: datetime.now(timezone.utc)

    # --- 인증 ---
    # 토큰은 프로세스끼리 파일 캐시로 공유하고 만료 5분 전까지 쓴다. 다른 프로세스가 재발급해 무효가 된 경우를 대비해
    # 401이면 캐시 파일을 다시 읽어 보고, 같은 토큰이면 한 번만 재발급한다.

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
        body = urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": self._client_id,
            "client_secret": self._client_secret,
        }).encode()
        res = self._send("POST", "/oauth2/token", {"Content-Type": "application/x-www-form-urlencoded"}, body)
        try:
            token, expires_at = res["access_token"], self._clock() + float(res["expires_in"])
        except (KeyError, TypeError, ValueError):
            raise TossApiError(200, {"error": "bad-token-response",
                                     "error_description": "토큰 응답 형식 오류"}) from None
        self._token, self._expires_at = token, expires_at
        if self._token_cache:
            self._token_cache.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._token_cache.with_name(f"{self._token_cache.name}.tmp{os.getpid()}")
            fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"access_token": token, "expires_at": expires_at,
                           "base_url": self._base_url, "key": self._key_fingerprint()}, f)
            os.replace(tmp, self._token_cache)
        return token

    def _read_token_cache(self) -> tuple[str, float] | None:
        if not self._token_cache or not self._token_cache.exists():
            return None
        try:
            cached = json.loads(self._token_cache.read_text())
            if cached.get("base_url") != self._base_url or cached.get("key") != self._key_fingerprint():
                return None  # 다른 client의 토큰은 쓸 수 없다
            return cached["access_token"], float(cached["expires_at"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _key_fingerprint(self) -> str:
        return hashlib.sha256(self._client_id.encode()).hexdigest()[:16]

    # --- HTTP ---

    def _send(self, method: str, path: str, headers: dict, data: bytes | None = None) -> dict:
        """응답 본문. 429는 간격을 두고 MAX_RETRIES번까지 다시 보낸다."""
        for attempt in range(MAX_RETRIES + 1):
            req = urllib.request.Request(self._base_url + path, data=data, method=method,
                                         headers={"Accept-Encoding": "gzip", **headers})
            try:
                with self._urlopen(req, timeout=TIMEOUT_SEC) as res:
                    return _decode(res.read())
            except urllib.error.HTTPError as e:
                if e.code == 429 and attempt < MAX_RETRIES:
                    self._sleep(_retry_after(e.headers, attempt))
                    continue
                raise TossApiError(e.code, _decode(e.read())) from None
            except (urllib.error.URLError, OSError) as e:  # 연결 실패·시간 초과
                raise TossApiError(0, {"error": "transport", "error_description": f"전송 오류: {e}"}) from None
        raise AssertionError("unreachable")

    def _get(self, path: str, params: dict | None = None):
        """GET 한 번. 응답의 result를 돌려준다. 값이 None인 인자는 보내지 않는다."""
        params = {k: v for k, v in (params or {}).items() if v is not None}
        if params:
            path += "?" + urllib.parse.urlencode(params)
        token = self._access_token()
        try:
            res = self._send("GET", path, {"Authorization": f"Bearer {token}"})
        except TossApiError as e:
            if e.status != 401:
                raise
            res = self._send("GET", path, {"Authorization": f"Bearer {self._refresh_token(token)}"})
        if "result" not in res:
            raise TossApiError(200, {"error": "bad-response", "error_description": f"result 없음: {path}"})
        return res["result"]

    # --- 시세·종목 ---

    def prices(self, symbols: list[str]) -> list[dict]:
        return self._get("/api/v1/prices", {"symbols": ",".join(symbols)})

    def orderbook(self, symbol: str) -> dict:
        return self._get("/api/v1/orderbook", {"symbol": symbol})

    # 모의 체결 가격 규칙(docs/DECISIONS.md 4-2)은 증권사와 무관하다. prices·orderbook만 쓰는 키움 쪽 구현을 그대로 쓴다.
    confirmed_prices = KiwoomClient.confirmed_prices

    def stocks(self, symbols: list[str]) -> list[dict]:
        return self._get("/api/v1/stocks", {"symbols": ",".join(symbols)})

    def daily_candles(self, symbol: str, count: int = 200) -> list[dict]:
        """일봉, 과거 → 최신 (API는 최신순). 장중이면 마지막 봉은 미완성이다."""
        return self.candles_before(symbol, None, count)[0]

    def candles_before(self, symbol: str, before: str | None = None,
                       count: int = 200) -> tuple[list[dict], str | None]:
        """(일봉 과거 → 최신, 다음 페이지 커서). before는 앞 페이지가 준 커서 (None이면 최신부터)."""
        res = self._get("/api/v1/candles", {"symbol": symbol, "interval": "1d", "count": count, "before": before})
        return res["candles"][::-1], res.get("nextBefore") or None

    def completed_daily_candles(self, symbol: str, market_country: str, count: int = 200) -> list[dict]:
        """정규장이 끝난 일봉만."""
        calendar = self.market_calendar(market_country)
        return drop_incomplete(self.daily_candles(symbol, count), calendar, self._now())

    def market_calendar(self, market_country: str) -> dict:
        """장 운영 정보. market_country는 KR | US. data/calendar.py가 이 응답 형식을 따라 만든다."""
        return self._get(f"/api/v1/market-calendar/{_segment(market_country)}")

    def listed_stocks(self, market: str) -> list[dict]:
        """거래소(KOSPI, KOSDAQ, NYSE, NASDAQ, AMEX)의 전체 종목 목록."""
        return self._get("/api/v1/stocks/all", {"market": market})

    def warnings(self, symbol: str) -> list[dict]:
        return self._get(f"/api/v1/stocks/{_segment(symbol)}/warnings")

    def investor_trading(self, symbol: str, count: int = 20) -> list[dict]:
        """투자자별 매매동향. 국내 종목만 지원한다."""
        return self._get(f"/api/v1/stocks/{_segment(symbol)}/investor-trading", {"count": count})["records"]

    def rankings(self, type_: str, market_country: str, duration: str = "1d",
                 count: int = 30) -> list[dict]:
        return self.rankings_with_time(type_, market_country, duration, count)[0]

    def rankings_with_time(self, type_: str, market_country: str, duration: str = "1d", count: int = 30,
                           exclude_caution: bool = True) -> tuple[list[dict], str | None]:
        """(순위 목록, 집계 기준 시각 ISO 또는 None). 키움과 달리 1d 말고 1w, 1mo, 3mo, 6mo, 1y도 된다."""
        res = self._get("/api/v1/rankings", {
            "type": type_, "marketCountry": market_country, "duration": duration,
            "excludeInvestmentCaution": "true" if exclude_caution else None, "count": count})
        return res["rankings"], res.get("rankedAt")

    def exchange_rate(self, base: str = "USD", quote: str = "KRW") -> dict:
        return self._get("/api/v1/exchange-rate", {"baseCurrency": base, "quoteCurrency": quote})


def _segment(value: str) -> str:
    """URL 경로에 넣을 값."""
    return urllib.parse.quote(str(value), safe="")


def _decode(raw: bytes) -> dict:
    if raw[:2] == b"\x1f\x8b":
        raw = gzip.decompress(raw)
    try:
        body = json.loads(raw or b"{}")
    except ValueError:
        body = None
    if not isinstance(body, dict):
        return {"error": "non-json-response", "error_description": raw[:300].decode(errors="replace")}
    return body


def _retry_after(headers, attempt: int) -> float:
    try:
        return float(headers.get("Retry-After"))
    except (AttributeError, TypeError, ValueError):
        return float(2 ** attempt)
