import gzip
import inspect
import io
import json
import os
import stat
import urllib.error
import urllib.parse
from datetime import datetime, timezone

import pytest

from paper_engine.data.broker import make_client
from paper_engine.data.kiwoom import KiwoomApiError, KiwoomClient
from paper_engine.data.toss import BASE_URL, TossApiError, TossClient

NOW = datetime(2026, 10, 1, 3, 0, tzinfo=timezone.utc)  # 2026-10-01 12:00 KST (목요일, 장중)
TOKEN_PATH = "/oauth2/token"
TOKEN_OK = {"access_token": "T1", "token_type": "Bearer", "expires_in": 86400}
UNAUTHORIZED = (401, {"error": {"code": "UNAUTHORIZED", "message": "invalid token", "requestId": "r1"}}, {})


def ok(result):
    return {"result": result}


class Http:
    """가짜 전송. routes: 경로 → 응답 목록 (마지막 응답은 계속 쓴다).

    응답: dict(본문, HTTP 200) 또는 (상태, 본문, 응답 헤더).
    """

    def __init__(self, routes, gzip_body=False):
        self.routes = {k: list(v) for k, v in routes.items()}
        self.calls = []
        self.gzip_body = gzip_body

    def __call__(self, req, timeout):
        url = urllib.parse.urlsplit(req.full_url)
        self.calls.append({"method": req.get_method(), "path": url.path, "host": url.netloc,
                           "query": dict(urllib.parse.parse_qsl(url.query)),
                           "headers": {k.lower(): v for k, v in req.header_items()}, "data": req.data})
        route = self.routes[url.path]
        res = route.pop(0) if len(route) > 1 else route[0]
        status, data, res_headers = (200, res, {}) if isinstance(res, dict) else res
        raw = data if isinstance(data, bytes) else json.dumps(data, ensure_ascii=False).encode()
        if self.gzip_body:
            raw = gzip.compress(raw)
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "error", res_headers, io.BytesIO(raw))
        return Response(raw)

    def paths(self):
        return [c["path"] for c in self.calls]


class Response:
    def __init__(self, raw):
        self._raw = raw

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def make(routes, tmp_path=None, gzip_body=False, client_id="client-id"):
    cache = tmp_path / "toss_token.json" if tmp_path else None
    c = TossClient(client_id, "client-secret", cache)
    http = Http({TOKEN_PATH: [TOKEN_OK], **routes}, gzip_body)
    c._urlopen = http
    c.sleeps = []
    c._sleep = c.sleeps.append
    c._clock = lambda: NOW.timestamp()
    c._now = lambda: NOW
    return c, http


PRICES = {"/api/v1/prices": [ok([{"symbol": "005930", "lastPrice": "71000"}])]}


# --- 토큰 ---

def test_token_is_issued_once_and_cached_with_private_permissions(tmp_path):
    c, http = make(PRICES, tmp_path)
    assert c.prices(["005930"]) == [{"symbol": "005930", "lastPrice": "71000"}]
    c.prices(["005930"])
    assert http.paths() == [TOKEN_PATH, "/api/v1/prices", "/api/v1/prices"]
    token_call = http.calls[0]
    assert (token_call["method"], token_call["host"]) == ("POST", urllib.parse.urlsplit(BASE_URL).netloc)
    assert dict(urllib.parse.parse_qsl(token_call["data"].decode())) == {
        "grant_type": "client_credentials", "client_id": "client-id", "client_secret": "client-secret"}
    assert http.calls[1]["headers"]["authorization"] == "Bearer T1"
    path = tmp_path / "toss_token.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert "client-secret" not in path.read_text() and "client-id" not in path.read_text()

    # 다른 프로세스(새 클라이언트)는 캐시를 읽어 재발급하지 않는다 (재발급하면 앞 토큰이 무효가 된다)
    c2, http2 = make(PRICES, tmp_path)
    c2.prices(["005930"])
    assert http2.paths() == ["/api/v1/prices"]


def test_token_is_reissued_close_to_expiry(tmp_path):
    c, http = make(PRICES, tmp_path)
    http.routes[TOKEN_PATH] = [{**TOKEN_OK, "expires_in": 240}, TOKEN_OK]  # 4분 뒤 만료 (여유 5분 안쪽)
    c.prices(["005930"])
    c.prices(["005930"])
    assert http.paths() == [TOKEN_PATH, "/api/v1/prices", TOKEN_PATH, "/api/v1/prices"]


def test_cached_token_of_another_client_is_not_used(tmp_path):
    c, _ = make(PRICES, tmp_path)
    c.prices(["005930"])
    other, http = make(PRICES, tmp_path, client_id="another-client")
    other.prices(["005930"])
    assert http.paths() == [TOKEN_PATH, "/api/v1/prices"]


def test_401_reissues_once_and_retries(tmp_path):
    c, http = make({"/api/v1/prices": [UNAUTHORIZED, *PRICES["/api/v1/prices"]]}, tmp_path)
    http.routes[TOKEN_PATH] = [TOKEN_OK, {**TOKEN_OK, "access_token": "T2"}]
    assert c.prices(["005930"])[0]["lastPrice"] == "71000"
    assert http.paths() == [TOKEN_PATH, "/api/v1/prices", TOKEN_PATH, "/api/v1/prices"]
    assert http.calls[-1]["headers"]["authorization"] == "Bearer T2"


def test_401_twice_raises_engine_catchable_error(tmp_path):
    c, http = make({"/api/v1/prices": [UNAUTHORIZED]}, tmp_path)
    with pytest.raises(KiwoomApiError) as e:  # 엔진은 KiwoomApiError만 잡는다
        c.prices(["005930"])
    assert isinstance(e.value, TossApiError) and e.value.status == 401
    assert "UNAUTHORIZED" in str(e.value) and "r1" in str(e.value)
    assert http.paths().count(TOKEN_PATH) == 2


def test_401_uses_token_refreshed_by_another_process(tmp_path):
    c, http = make({"/api/v1/prices": [UNAUTHORIZED, *PRICES["/api/v1/prices"]]}, tmp_path)
    c._access_token()
    other, _ = make({}, tmp_path)
    other._urlopen = Http({TOKEN_PATH: [{**TOKEN_OK, "access_token": "T-other"}]})
    other._issue_token()  # 다른 프로세스가 재발급해 캐시 파일을 바꿨다
    c.prices(["005930"])
    assert http.paths() == [TOKEN_PATH, "/api/v1/prices", "/api/v1/prices"]
    assert http.calls[-1]["headers"]["authorization"] == "Bearer T-other"


def test_bad_credentials_raise():
    c, http = make({})
    http.routes[TOKEN_PATH] = [(401, {"error": "invalid_client", "error_description": "bad secret"}, {})]
    with pytest.raises(TossApiError, match="invalid_client: bad secret"):
        c.prices(["005930"])
    assert http.paths() == [TOKEN_PATH]


# --- 재시도·오류·gzip ---

def test_429_is_retried_with_backoff():
    limited = (429, {"error": {"code": "TOO_MANY_REQUESTS"}}, {})
    c, http = make({"/api/v1/prices": [(429, {}, {"Retry-After": "1.5"}), limited, *PRICES["/api/v1/prices"]]})
    assert c.prices(["005930"])[0]["lastPrice"] == "71000"
    assert http.paths().count("/api/v1/prices") == 3
    assert c.sleeps == [1.5, 2.0]  # Retry-After, 그다음 2**1초


def test_retries_give_up_after_three():
    c, http = make({"/api/v1/prices": [(429, {"error": {"code": "TOO_MANY_REQUESTS"}}, {})]})
    with pytest.raises(TossApiError) as e:
        c.prices(["005930"])
    assert e.value.status == 429 and http.paths().count("/api/v1/prices") == 4


def test_transport_error_is_status_zero():
    c, _ = make({})

    def down(req, timeout):
        raise urllib.error.URLError("connection refused")
    c._urlopen = down
    with pytest.raises(KiwoomApiError) as e:
        c.prices(["005930"])
    assert e.value.status == 0


def test_gzip_and_non_json_responses():
    c, _ = make(PRICES, gzip_body=True)
    assert c.prices(["005930"])[0]["symbol"] == "005930"
    c, _ = make({"/api/v1/prices": [(502, b"<html>bad gateway</html>", {})]})
    with pytest.raises(TossApiError, match="non-json-response") as e:
        c.prices(["005930"])
    assert e.value.status == 502
    c, _ = make({"/api/v1/prices": [{"unexpected": 1}]})
    with pytest.raises(TossApiError, match="result 없음"):
        c.prices(["005930"])


# --- 조회 ---

def candle(day, close="100"):
    return {"timestamp": f"{day}T00:00:00+09:00", "openPrice": close, "highPrice": close, "lowPrice": close,
            "closePrice": close, "volume": "10"}


def session(day):
    return {"date": day, "integrated": {"regularMarket": {"startTime": f"{day}T09:00:00+09:00",
                                                           "endTime": f"{day}T15:30:00+09:00"}}}


def test_quote_methods_send_original_paths_and_params():
    c, http = make({
        "/api/v1/prices": [ok([{"symbol": "005930", "lastPrice": "71000"}, {"symbol": "AAPL", "lastPrice": "250.5"}])],
        "/api/v1/orderbook": [ok({"bids": [{"price": "70900"}], "asks": [{"price": "71000"}]})],
        "/api/v1/stocks": [ok([{"symbol": "005930", "name": "삼성전자", "securityType": "STOCK"}])],
        "/api/v1/stocks/all": [ok([{"symbol": "005930", "name": "삼성전자"}])],
        "/api/v1/stocks/005930/warnings": [ok([{"warningType": "INVESTMENT_CAUTION"}])],
        "/api/v1/stocks/005930/investor-trading": [ok({"records": [{"date": "2026-09-30"}]})],
        "/api/v1/exchange-rate": [ok({"rate": "1390.5"})],
        "/api/v1/market-calendar/KR": [ok({"today": session("2026-10-01")})],
    })
    assert len(c.prices(["005930", "AAPL"])) == 2
    assert c.orderbook("005930")["bids"][0]["price"] == "70900"
    assert c.stocks(["005930"])[0]["securityType"] == "STOCK"
    assert c.listed_stocks("KOSPI") == [{"symbol": "005930", "name": "삼성전자"}]
    assert c.warnings("005930") == [{"warningType": "INVESTMENT_CAUTION"}]
    assert c.investor_trading("005930", 5) == [{"date": "2026-09-30"}]
    assert c.exchange_rate() == {"rate": "1390.5"}
    assert c.market_calendar("KR")["today"]["date"] == "2026-10-01"
    queries = {call["path"]: call["query"] for call in http.calls[1:]}
    assert queries == {
        "/api/v1/prices": {"symbols": "005930,AAPL"},
        "/api/v1/orderbook": {"symbol": "005930"},
        "/api/v1/stocks": {"symbols": "005930"},
        "/api/v1/stocks/all": {"market": "KOSPI"},
        "/api/v1/stocks/005930/warnings": {},
        "/api/v1/stocks/005930/investor-trading": {"count": "5"},
        "/api/v1/exchange-rate": {"baseCurrency": "USD", "quoteCurrency": "KRW"},
        "/api/v1/market-calendar/KR": {},
    }


def test_candles_are_oldest_first_with_paging_cursor():
    newest_first = [candle("2026-09-30"), candle("2026-09-29")]
    c, http = make({"/api/v1/candles": [ok({"candles": newest_first, "nextBefore": "cursor-1"}),
                                        ok({"candles": [candle("2026-09-28")]})]})
    page, cursor = c.candles_before("005930", None, 2)
    assert [x["timestamp"][:10] for x in page] == ["2026-09-29", "2026-09-30"] and cursor == "cursor-1"
    assert http.calls[-1]["query"] == {"symbol": "005930", "interval": "1d", "count": "2"}
    page, cursor = c.candles_before("005930", cursor, 2)
    assert [x["timestamp"][:10] for x in page] == ["2026-09-28"] and cursor is None
    assert http.calls[-1]["query"]["before"] == "cursor-1"
    assert c.daily_candles("005930", 1) == page


def test_completed_daily_candles_drop_todays_bar_during_session():
    c, _ = make({"/api/v1/candles": [ok({"candles": [candle("2026-10-01"), candle("2026-09-30")]})],
                 "/api/v1/market-calendar/KR": [ok({"today": session("2026-10-01")})]})
    assert [x["timestamp"][:10] for x in c.completed_daily_candles("005930", "KR")] == ["2026-09-30"]


def test_rankings_with_time_and_caution_filter():
    ranks = [{"rank": 1, "symbol": "005930", "tradingAmount": "1.2e12"}]
    c, http = make({"/api/v1/rankings": [ok({"rankings": ranks, "rankedAt": "2026-10-01T12:00:00+09:00"}),
                                         ok({"rankings": ranks})]})
    assert c.rankings_with_time("MARKET_TRADING_AMOUNT", "KR", "1d", 100) == (ranks, "2026-10-01T12:00:00+09:00")
    assert http.calls[-1]["query"] == {"type": "MARKET_TRADING_AMOUNT", "marketCountry": "KR", "duration": "1d",
                                       "excludeInvestmentCaution": "true", "count": "100"}
    assert c.rankings_with_time("MARKET_TRADING_AMOUNT", "KR", "1mo", 100, exclude_caution=False) == (ranks, None)
    assert "excludeInvestmentCaution" not in http.calls[-1]["query"]
    assert c.rankings("TOP_GAINERS", "KR") == ranks and http.calls[-1]["query"]["count"] == "30"


def test_confirmed_prices_follow_engine_fill_rule():
    """현재가·최우선 호가의 중간값. 한쪽 호가만 있으면 현재가가 3% 안일 때만, 호가가 없으면 뺀다 (DECISIONS 4-2)."""
    books = {"A": {"bids": [{"price": "99"}], "asks": [{"price": "101"}]},
             "B": {"bids": [{"price": "100"}], "asks": []},
             "C": {"bids": [], "asks": []}}

    class Quotes(TossClient):
        def prices(self, symbols):
            return [{"symbol": s, "lastPrice": "150" if s == "A" else "100"} for s in symbols]

        def orderbook(self, symbol):
            if symbol == "D":
                raise TossApiError(500, {"error": {"code": "INTERNAL"}})
            return books[symbol]

    assert Quotes("id", "secret").confirmed_prices(["A", "B", "C", "D"]) == {"A": 101.0, "B": 100.0}


# --- 조회 전용 ---

def public_methods(cls):
    return {name: list(inspect.signature(fn).parameters)
            for name, fn in inspect.getmembers(cls, inspect.isfunction) if not name.startswith("_")}


def test_public_interface_matches_kiwoom_client_and_has_no_account_or_order_calls():
    """공개 메서드는 KiwoomClient와 이름·인자가 같다. 계좌·주문 메서드는 없다 (실주문 코드 0건)."""
    assert public_methods(TossClient) == public_methods(KiwoomClient)


def test_every_data_request_is_a_get_without_account_header():
    c, http = make({**PRICES, "/api/v1/exchange-rate": [ok({"rate": "1390.5"})]})
    c.prices(["005930"])
    c.exchange_rate()
    assert [(call["method"], call["path"]) for call in http.calls] == [
        ("POST", TOKEN_PATH), ("GET", "/api/v1/prices"), ("GET", "/api/v1/exchange-rate")]
    for call in http.calls[1:]:
        assert call["data"] is None
        assert set(call["headers"]) == {"accept-encoding", "authorization"}


# --- 설정 (BROKER) ---

@pytest.fixture
def env(monkeypatch):
    from paper_engine import config
    monkeypatch.setattr(config, "REPO_ROOT", config.REPO_ROOT / "no-such-dir")  # 저장소 .env를 읽지 않는다
    for key in ("BROKER", "CLIENT_ID", "CLIENT_SECRET", "KIWOOM_APPKEY", "KIWOOM_SECRETKEY", "POSTGRES_HOST"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("DJANGO_DEBUG", "on")  # 로컬 개발 환경
    return monkeypatch


def test_broker_defaults_to_kiwoom(env):
    from paper_engine.config import ROOT, load_config
    env.setenv("CLIENT_ID", "id")  # 토스 키가 있어도 BROKER를 주지 않으면 키움이다
    env.setenv("CLIENT_SECRET", "secret")
    cfg = load_config(require_broker=False)
    assert cfg.broker == "kiwoom" and not cfg.broker_ready
    env.setenv("KIWOOM_APPKEY", "app")
    env.setenv("KIWOOM_SECRETKEY", "key")
    cfg = load_config()
    assert cfg.broker_ready and isinstance(make_client(cfg, ROOT / ".cache"), KiwoomClient)


def test_broker_toss_needs_only_toss_keys(env):
    from paper_engine.config import ROOT, ConfigError, load_config
    env.setenv("BROKER", "Toss")
    with pytest.raises(ConfigError, match="CLIENT_ID, CLIENT_SECRET"):
        load_config()
    assert not load_config(require_broker=False).broker_ready
    env.setenv("CLIENT_ID", "id")
    env.setenv("CLIENT_SECRET", "secret")
    cfg = load_config()
    assert (cfg.broker, cfg.toss_client_id, cfg.toss_client_secret) == ("toss", "id", "secret")
    assert cfg.broker_ready and cfg.kiwoom_appkey is None
    assert cfg.toss_token_cache == ROOT / ".cache" / "toss_token.json" != cfg.token_cache
    assert isinstance(make_client(cfg, ROOT / ".cache"), TossClient)


@pytest.mark.parametrize("debug", ["off", "", None])
def test_broker_toss_is_refused_outside_local_dev(env, debug):
    """운영(DJANGO_DEBUG가 꺼져 있거나 없음)에서는 토스를 고를 수 없다."""
    from paper_engine.config import ConfigError, load_config
    for key, value in (("BROKER", "toss"), ("CLIENT_ID", "id"), ("CLIENT_SECRET", "secret")):
        env.setenv(key, value)
    if debug is None:
        env.delenv("DJANGO_DEBUG")
    else:
        env.setenv("DJANGO_DEBUG", debug)
    with pytest.raises(ConfigError, match="로컬 개발 환경 전용"):
        load_config()
    with pytest.raises(ConfigError, match="로컬 개발 환경 전용"):
        load_config(require_broker=False)
    env.setenv("BROKER", "kiwoom")
    assert load_config(require_broker=False).broker == "kiwoom"


def test_broker_toss_works_with_local_postgres(env):
    """로컬 개발에서도 PostgreSQL을 쓸 수 있다. DB 종류로 운영을 가리지 않는다."""
    from paper_engine.config import load_config
    for key, value in (("BROKER", "toss"), ("CLIENT_ID", "id"), ("CLIENT_SECRET", "secret"),
                       ("POSTGRES_HOST", "127.0.0.1")):
        env.setenv(key, value)
    assert load_config().broker == "toss"


def test_unknown_broker_is_rejected(env):
    from paper_engine.config import ConfigError, load_config
    env.setenv("BROKER", "kis")
    with pytest.raises(ConfigError, match="kiwoom, toss"):
        load_config(require_broker=False)


def test_engine_client_factory_follows_broker(env):
    from paper_engine import __main__ as main
    from paper_engine.config import load_config
    env.setenv("BROKER", "toss")
    with pytest.raises(SystemExit, match="CLIENT_ID, CLIENT_SECRET"):
        main._client(load_config(require_broker=False))
    assert main._client_if_configured(load_config(require_broker=False)) is None
    env.setenv("CLIENT_ID", "id")
    env.setenv("CLIENT_SECRET", "secret")
    client = main._client(load_config())
    assert isinstance(client, TossClient) and main._client(load_config()) is client  # 프로세스에 하나
