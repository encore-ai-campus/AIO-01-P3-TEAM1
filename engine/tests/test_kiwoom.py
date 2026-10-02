import gzip
import io
import json
import os
import stat
import threading
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

import pytest

from paper_engine.data.calendar import MarketCalendar
from paper_engine.data.kiwoom import KiwoomApiError, KiwoomClient

FIXTURES = Path(__file__).parent / "fixtures" / "kiwoom"
NOW = datetime(2026, 10, 1, 3, 0, tzinfo=timezone.utc)  # 2026-10-01 12:00 KST (목요일, 장중)
TOKEN_OK = {"token": "T1", "token_type": "bearer", "expires_dt": "20261002120000",
            "return_code": 0, "return_msg": "정상적으로 처리되었습니다"}


def fixture(tr):
    return json.loads((FIXTURES / f"{tr}.json").read_text())


class Http:
    """가짜 전송. routes: api-id → 응답 목록 또는 함수(body, headers) → 응답.

    응답: dict(본문, HTTP 200) 또는 (상태, 본문, 응답 헤더). 함수 응답도 같은 형식.
    """

    def __init__(self, routes, gzip_body=False):
        self.routes = {k: (list(v) if isinstance(v, list) else v) for k, v in routes.items()}
        self.calls = []
        self.gzip_body = gzip_body
        self.lock = threading.Lock()

    def __call__(self, req, timeout):
        headers = {k.lower(): v for k, v in req.header_items()}
        body = json.loads(req.data)
        api_id = headers["api-id"]
        with self.lock:
            self.calls.append({"api": api_id, "url": req.full_url, "headers": headers, "body": body})
            route = self.routes[api_id]
            res = route(body, headers) if callable(route) else (route.pop(0) if len(route) > 1 else route[0])
        status, data, res_headers = (200, res, {}) if isinstance(res, dict) else res
        raw = json.dumps(data, ensure_ascii=False).encode() if not isinstance(data, bytes) else data
        if self.gzip_body:
            raw = gzip.compress(raw)
        if status >= 400:
            raise urllib.error.HTTPError(req.full_url, status, "error", res_headers, io.BytesIO(raw))
        return Response(status, raw, res_headers)

    def apis(self):
        return [c["api"] for c in self.calls]


class Response:
    def __init__(self, status, raw, headers):
        self.status, self._raw, self.headers = status, raw, headers

    def read(self):
        return self._raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def make(routes, tmp_path=None, gzip_body=False, calendar=None, **kw):
    cache = tmp_path / "kiwoom_token.json" if tmp_path else None
    c = KiwoomClient("appkey", "secret", cache, calendar, **kw)
    http = Http({"au10001": [TOKEN_OK], **routes}, gzip_body)
    c._urlopen = http
    c.sleeps = []
    c._sleep = c.sleeps.append
    c._clock = lambda: datetime(2026, 10, 1, 3, 0, tzinfo=timezone.utc).timestamp()
    c._now = lambda: NOW
    return c, http


# --- 토큰 ---

def test_token_is_issued_once_and_cached_with_private_permissions(tmp_path):
    c, http = make({"ka10095": [fixture("ka10095")]}, tmp_path)
    c.prices(["005930"])
    c.prices(["005930"])
    assert http.apis() == ["au10001", "ka10095", "ka10095"]
    token_call = http.calls[0]
    assert token_call["url"] == "https://api.kiwoom.com/oauth2/token"
    assert token_call["body"] == {"grant_type": "client_credentials", "appkey": "appkey", "secretkey": "secret"}
    assert http.calls[1]["headers"]["authorization"] == "Bearer T1"
    assert http.calls[1]["url"] == "https://api.kiwoom.com/api/dostk/stkinfo"
    path = tmp_path / "kiwoom_token.json"
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert "secret" not in path.read_text() and "appkey" not in path.read_text()

    # 다른 프로세스(새 클라이언트)는 캐시를 읽어 재발급하지 않는다
    c2, http2 = make({"ka10095": [fixture("ka10095")]}, tmp_path)
    c2.prices(["005930"])
    assert http2.apis() == ["ka10095"]


def test_token_is_reissued_close_to_expiry(tmp_path):
    soon = {**TOKEN_OK, "expires_dt": "20261001120400"}  # 4분 뒤 만료 (여유 5분 안쪽)
    c, http = make({"ka10095": [fixture("ka10095")]}, tmp_path)
    http.routes["au10001"] = [soon, TOKEN_OK]
    c.prices(["005930"])
    c.prices(["005930"])
    assert http.apis() == ["au10001", "ka10095", "au10001", "ka10095"]


def test_cached_token_for_another_domain_or_key_is_not_used(tmp_path):
    c, _ = make({"ka10095": [fixture("ka10095")]}, tmp_path)
    c.prices(["005930"])
    other, http = make({"ka10095": [fixture("ka10095")]}, tmp_path, base_url="https://mockapi.kiwoom.com")
    other.prices(["005930"])
    assert http.apis() == ["au10001", "ka10095"]
    assert http.calls[0]["url"] == "https://mockapi.kiwoom.com/oauth2/token"


@pytest.mark.parametrize("rejection", [
    (401, {"return_code": 3, "return_msg": "인증에 실패했습니다"}, {}),
    {"return_code": 8005, "return_msg": "Token이 유효하지 않습니다"},
    {"return_code": 3, "return_msg": "[8005:Token이 유효하지 않습니다]"},
])
def test_auth_failure_reissues_once_and_retries(tmp_path, rejection):
    c, http = make({"ka10095": [rejection, fixture("ka10095")]}, tmp_path)
    http.routes["au10001"] = [TOKEN_OK, {**TOKEN_OK, "token": "T2"}]
    assert c.prices(["005930"]) == [{"symbol": "005930", "lastPrice": "156600"}]
    assert http.apis() == ["au10001", "ka10095", "au10001", "ka10095"]
    assert http.calls[-1]["headers"]["authorization"] == "Bearer T2"


def test_auth_failure_twice_raises(tmp_path):
    bad = {"return_code": 8005, "return_msg": "Token이 유효하지 않습니다"}
    c, http = make({"ka10095": [bad]}, tmp_path)
    with pytest.raises(KiwoomApiError) as e:
        c.prices(["005930"])
    assert e.value.body["return_code"] == 8005
    assert http.apis().count("au10001") == 2


def test_auth_failure_uses_token_refreshed_by_another_process(tmp_path):
    c, http = make({"ka10095": [{"return_code": 8005, "return_msg": "x"}, fixture("ka10095")]}, tmp_path)
    c._access_token()
    # 다른 프로세스가 재발급해 캐시 파일을 바꿨다
    other, _ = make({}, tmp_path)
    other._urlopen = Http({"au10001": [{**TOKEN_OK, "token": "T-other"}]})
    other._issue_token()
    c.prices(["005930"])
    assert http.apis() == ["au10001", "ka10095", "ka10095"]
    assert http.calls[-1]["headers"]["authorization"] == "Bearer T-other"


def test_bad_credentials_raise_without_retry():
    c, http = make({})
    http.routes["au10001"] = [{"return_code": 8001, "return_msg": "App Key와 Secret Key 검증에 실패했습니다"}]
    with pytest.raises(KiwoomApiError) as e:
        c.prices(["005930"])
    assert e.value.status == 200 and e.value.body["return_code"] == 8001
    assert http.apis() == ["au10001"]


# --- 재시도·오류·gzip ---

def test_429_and_rate_limit_codes_are_retried_with_backoff():
    limited = {"return_code": 1700, "return_msg": "허용된 API 요청 개수를 초과하였습니다"}
    c, http = make({"ka10095": [(429, {"return_msg": "too many"}, {"Retry-After": "1.5"}), limited,
                                fixture("ka10095")]})
    assert c.prices(["005930"])[0]["lastPrice"] == "156600"
    assert http.apis() == ["au10001", "ka10095", "ka10095", "ka10095"]
    assert 1.5 in c.sleeps and 2.0 in c.sleeps  # Retry-After, 그다음 2**1초


def test_retries_give_up_after_three():
    c, http = make({"ka10095": [(429, {"return_msg": "too many"}, {})]})
    with pytest.raises(KiwoomApiError) as e:
        c.prices(["005930"])
    assert e.value.status == 429
    assert http.apis().count("ka10095") == 4


def test_business_error_in_http_200_raises():
    c, _ = make({"ka10004": [{"return_code": 1511, "return_msg": "필수 입력 값에 값이 존재하지 않습니다"}]})
    with pytest.raises(KiwoomApiError) as e:
        c.orderbook("005930")
    assert (e.value.status, e.value.body["return_code"]) == (200, 1511)
    assert "1511" in str(e.value)


def test_transport_error_is_status_zero():
    c, _ = make({})

    def down(req, timeout):
        raise urllib.error.URLError("connection refused")
    c._urlopen = down
    with pytest.raises(KiwoomApiError) as e:
        c.prices(["005930"])
    assert e.value.status == 0


def test_gzip_response_is_decoded():
    c, _ = make({"ka10095": [fixture("ka10095")]}, gzip_body=True)
    assert c.prices(["005930"]) == [{"symbol": "005930", "lastPrice": "156600"}]


def test_calls_are_spaced_across_threads():
    c, _ = make({"ka10095": [fixture("ka10095")]})
    clock = [100.0]
    c._monotonic = lambda: clock[0]
    c._access_token()
    c.sleeps.clear()
    threads = [threading.Thread(target=c.prices, args=(["005930"],)) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    # 시계가 멈춰 있으므로 각 호출은 앞 호출 예약 시각 + 0.25초를 기다린다 (첫 호출은 토큰 발급 뒤 0.25초)
    assert sorted(round(s, 2) for s in c.sleeps) == [0.25, 0.5, 0.75, 1.0]


def test_stock_list_tr_has_its_own_interval():
    c, _ = make({"usa10099": [fixture("usa10098")]})
    clock = [100.0]
    c._monotonic = lambda: clock[0]
    c.listed_stocks("NASDAQ")
    c.sleeps.clear()
    c.listed_stocks("NYSE")
    assert c.sleeps == [12.5]  # 미국 종목리스트는 분당 5회


# --- 시세 ---

def test_prices_join_symbols_and_strip_signs():
    quote = {"atn_stk_infr": [{"stk_cd": "005930", "cur_prc": "-71000"}, {"stk_cd": "000660", "cur_prc": "+215500"},
                              {"stk_cd": "035720", "cur_prc": ""}], "return_code": 0}
    c, http = make({"ka10095": [quote]})
    assert c.prices(["005930", "000660", "035720"]) == [
        {"symbol": "005930", "lastPrice": "71000"}, {"symbol": "000660", "lastPrice": "215500"}]
    assert http.calls[-1]["body"] == {"stk_cd": "005930|000660|035720"}


def test_prices_are_chunked():
    symbols = [f"{i:06d}" for i in range(1, 121)]
    c, http = make({"ka10095": lambda body, h: {"atn_stk_infr": [
        {"stk_cd": s, "cur_prc": "1000"} for s in body["stk_cd"].split("|")]}})
    assert len(c.prices(symbols)) == 120
    assert [len(call["body"]["stk_cd"].split("|")) for call in http.calls if call["api"] == "ka10095"] == [50, 50, 20]


def test_orderbook_from_fixture_shape():
    book = {"sel_fpr_bid": "+70100", "sel_fpr_req": "1200", "sel_2th_pre_bid": "+70200", "sel_2th_pre_req": "300",
            "buy_fpr_bid": "-70000", "buy_fpr_req": "500", "buy_2th_pre_bid": "-69900", "buy_2th_pre_req": "0",
            "buy_3th_pre_bid": "0", "return_code": 0}
    c, http = make({"ka10004": [book]})
    assert c.orderbook("005930") == {
        "bids": [{"price": "70000", "quantity": "500"}, {"price": "69900", "quantity": "0"}],
        "asks": [{"price": "70100", "quantity": "1200"}, {"price": "70200", "quantity": "300"}]}
    assert http.calls[-1]["url"].endswith("/api/dostk/mrkcond")
    # 장 마감 후처럼 호가가 모두 0이면 빈 목록
    c, _ = make({"ka10004": [fixture("ka10004")]})
    assert c.orderbook("005930") == {"bids": [], "asks": []}


class BookClient(KiwoomClient):
    def __init__(self, last, books):
        super().__init__("key", "secret")
        self.last, self.books = last, books

    def prices(self, symbols):
        return [{"symbol": s, "lastPrice": str(self.last[s])} for s in symbols]

    def orderbook(self, symbol):
        if self.books[symbol] is None:
            raise KiwoomApiError(500, {"return_code": 1999})
        bid, ask = self.books[symbol]
        return {"bids": [{"price": str(bid)}] if bid else [], "asks": [{"price": str(ask)}] if ask else []}


def test_confirmed_price_is_median_and_skips_missing_books(capsys):
    c = BookClient({"005930": 65000, "000660": 215000, "035720": 40000, "051910": 300000},
                   {"005930": (70900, 71000), "000660": (214500, 215500), "035720": None, "051910": (None, 300500)})
    # 051910은 매도 호가만 있다 (상한가처럼 한쪽이 비었다): 현재가가 그 호가와 3% 안이면 현재가를 쓴다
    assert c.confirmed_prices(["005930", "000660", "035720", "051910"]) == {
        "005930": 70900.0, "000660": 215000.0, "051910": 300000.0}
    assert "005930 현재가" in capsys.readouterr().out  # 호가와 3% 넘게 다르면 로그
    assert c.confirmed_prices([]) == {}


def test_confirmed_prices_over_http():
    book = {"sel_fpr_bid": "+156700", "sel_fpr_req": "1", "buy_fpr_bid": "+156500", "buy_fpr_req": "1"}
    c, _ = make({"ka10095": [fixture("ka10095")], "ka10004": [book]})
    assert c.confirmed_prices(["005930"]) == {"005930": 156600.0}


# --- 일봉 ---

def chart_pages(pages):
    """ka10081 페이지 목록 → 연속 조회 헤더를 붙여 돌려주는 경로."""
    def route(body, headers):
        index = int(headers.get("next-key") or 0)
        more = index + 1 < len(pages)
        res_headers = {"cont-yn": "Y", "next-key": str(index + 1)} if more else {"cont-yn": "N", "next-key": ""}
        return 200, {"stk_cd": body["stk_cd"], "stk_dt_pole_chart_qry": pages[index], "return_code": 0}, res_headers
    return route


def bar(day, close):
    return {"dt": day, "cur_prc": str(close), "open_pric": f"+{close - 100}", "high_pric": f"{close + 200}",
            "low_pric": f"-{close - 300}", "trde_qty": f"00{close}", "trde_prica": "1"}


def test_daily_candles_convert_fixture():
    c, http = make({"ka10081": [fixture("ka10081")]})
    candles = c.daily_candles("005930", 2)
    assert candles == [
        {"timestamp": "2025-09-05T00:00:00+09:00", "openPrice": "70300", "highPrice": "70400", "lowPrice": "69500",
         "closePrice": "69500", "volume": "11526724"},
        {"timestamp": "2025-09-08T00:00:00+09:00", "openPrice": "69800", "highPrice": "70500", "lowPrice": "69600",
         "closePrice": "70100", "volume": "9263135"}]
    assert http.calls[-1]["body"] == {"stk_cd": "005930", "base_dt": "20261001", "upd_stkpc_tp": "1"}
    assert "cont-yn" not in http.calls[-1]["headers"]


def test_candles_before_follows_continuation_with_same_base_date():
    pages = [[bar("20261001", 1000), bar("20260930", 990)], [bar("20260929", 980), bar("20260928", 970)],
             [bar("20260925", 960)]]
    c, http = make({"ka10081": chart_pages(pages)})
    first, cursor = c.candles_before("005930", None, 2)
    assert [x["timestamp"][:10] for x in first] == ["2026-09-30", "2026-10-01"]
    assert first[-1]["lowPrice"] == "700" and first[-1]["volume"] == "1000"
    assert cursor == "20261001|1"
    second, cursor = c.candles_before("005930", cursor, 200)
    assert [x["closePrice"] for x in second] == ["960", "970", "980"]
    assert cursor is None
    calls = [x for x in http.calls if x["api"] == "ka10081"]
    assert calls[1]["headers"]["cont-yn"] == "Y" and calls[1]["headers"]["next-key"] == "1"
    assert all(x["body"]["base_dt"] == "20261001" for x in calls)


def test_daily_candles_keep_latest_count():
    pages = [[bar("20261001", 1000), bar("20260930", 990), bar("20260929", 980)]]
    c, _ = make({"ka10081": chart_pages(pages)})
    assert [x["closePrice"] for x in c.daily_candles("005930", 2)] == ["990", "1000"]


def test_completed_daily_candles_drop_todays_bar_before_close():
    pages = [[bar("20261001", 1000), bar("20260930", 990)]]
    c, _ = make({"ka10081": chart_pages(pages)}, calendar=MarketCalendar())
    assert [x["timestamp"][:10] for x in c.completed_daily_candles("005930", "KR")] == ["2026-09-30"]
    c._now = lambda: datetime(2026, 10, 1, 7, 0, tzinfo=timezone.utc)  # 16:00 KST, 장 마감 후
    assert len(c.completed_daily_candles("005930", "KR")) == 2


def test_market_calendar_uses_given_calendar_or_default():
    class Fake:
        def calendar(self, market, now=None):
            return {"market": market, "now": now}
    c, _ = make({}, calendar=Fake())
    assert c.market_calendar("US") == {"market": "US", "now": NOW}
    c, _ = make({})
    assert set(c.market_calendar("KR")) == {"previousBusinessDay", "today", "nextBusinessDay"}


# --- 종목 정보 ---

def stock_row(code, name, order="0", audit="정상", state="증거금20%|담보대출|신용가능"):
    return {"code": code, "name": name, "listCount": "0000000026034239", "auditInfo": audit, "regDay": "20090803",
            "lastPrice": "00136000", "state": state, "marketCode": "0", "marketName": "거래소", "orderWarning": order}


LISTS = {
    "0": [stock_row("005930", "삼성전자"), stock_row("069500", "KODEX 200"), stock_row("122630", "KODEX 레버리지"),
          stock_row("000040", "KR모터스", audit="투자주의환기종목", state="관리종목")],
    "10": [stock_row("035720", "카카오"), stock_row("440790", "엔에이치스팩29호"),
           stock_row("123456", "정리주식", order="2", state="정리매매|거래정지")],
    "8": [stock_row("069500", "KODEX 200"), stock_row("122630", "KODEX 레버리지")],
    "60": [stock_row("500001", "신한 레버리지 원유선물 ETN")],
}


def directory_routes(extra=None):
    def route(body, headers):
        return {"list": LISTS.get(body["mrkt_tp"], []), "return_code": 0}
    return {"ka10099": route, **(extra or {})}


def test_stocks_classify_with_stock_lists():
    c, http = make(directory_routes())
    infos = {i["symbol"]: i for i in c.stocks(["005930", "069500", "122630", "035720", "440790", "123456"])}
    assert infos["005930"] == {
        "symbol": "005930", "name": "삼성전자", "englishName": None, "market": "KOSPI", "currency": "KRW",
        "securityType": "STOCK", "status": "ACTIVE", "leverageFactor": None,
        "koreanMarketDetail": {"krxTradingSuspended": False, "liquidationTrading": False}}
    assert infos["069500"]["securityType"] == "ETF" and infos["069500"]["market"] == "KOSPI"
    assert infos["122630"]["leverageFactor"] == "2"
    assert infos["035720"]["market"] == "KOSDAQ"
    assert infos["440790"]["securityType"] == "SPAC"
    assert infos["123456"]["koreanMarketDetail"] == {"krxTradingSuspended": True, "liquidationTrading": True}
    # 목록은 시장구분마다 한 번만 받는다
    assert http.apis().count("ka10099") == 13
    c.stocks(["005930"])
    assert http.apis().count("ka10099") == 13


def test_stocks_fall_back_to_single_lookup_and_skip_unknown():
    lookup = {**fixture("ka10100"), "code": "999990", "name": "새상장", "marketCode": "10", "marketName": "코스닥"}

    def ka10100(body, headers):
        if body["stk_cd"] == "999990":
            return lookup
        return {"return_code": 1902, "return_msg": "종목 정보가 없습니다"}
    c, _ = make(directory_routes({"ka10100": ka10100}))
    infos = c.stocks(["999990", "999999", "005930"])
    assert [i["symbol"] for i in infos] == ["999990", "005930"]
    assert infos[0]["market"] == "KOSDAQ" and infos[0]["securityType"] == "STOCK"


def test_stock_directory_is_shared_through_daily_file(tmp_path):
    c, _ = make(directory_routes(), tmp_path)
    c.stocks(["005930"])
    assert (tmp_path / "kiwoom-stocks-2026-10-01.json").exists()
    c2, http2 = make(directory_routes(), tmp_path)
    assert c2.stocks(["069500"])[0]["securityType"] == "ETF"
    assert "ka10099" not in http2.apis()


def test_warnings_from_stock_info():
    c, _ = make(directory_routes())
    assert c.warnings("005930") == []
    types = [w["warningType"] for w in c.warnings("000040")]
    assert types == ["INVESTMENT_CAUTION_ALERT", "ADMINISTRATIVE_ISSUE"]
    assert [w["warningType"] for w in c.warnings("123456")] == ["LIQUIDATION_TRADING", "TRADING_SUSPENDED"]
    assert c.warnings("AAPL") == []


def test_listed_stocks():
    c, _ = make(directory_routes())
    kospi = c.listed_stocks("KOSPI")
    assert {s["symbol"] for s in kospi} == {"005930", "069500", "122630", "000040"}
    assert {"symbol": "005930", "name": "삼성전자", "market": "KOSPI", "securityType": "STOCK"} in kospi
    assert {s["symbol"] for s in c.listed_stocks("KOSDAQ")} == {"035720", "440790", "123456"}
    with pytest.raises(KiwoomApiError):
        c.listed_stocks("TSE")


def test_investor_trading_fixture():
    c, http = make({"ka10059": [fixture("ka10059")]})
    rows = c.investor_trading("005930", 2)
    assert rows == [
        {"date": "2024-11-07", "individual": {"netBuyVolume": "1584"}, "foreigner": {"netBuyVolume": "-61779"},
         "institution": {"netBuyVolume": "60195"}},
        {"date": "2024-11-06", "individual": {"netBuyVolume": "-639"}, "foreigner": {"netBuyVolume": "-7"},
         "institution": {"netBuyVolume": "646"}}]
    assert http.calls[-1]["body"] == {"dt": "20261001", "stk_cd": "005930", "amt_qty_tp": "2", "trde_tp": "0",
                                      "unit_tp": "1"}
    with pytest.raises(KiwoomApiError):
        c.investor_trading("AAPL")


# --- 순위 ---

def test_trading_amount_ranking_converts_units_and_excludes_caution():
    ranking = {"trde_prica_upper": [
        {"stk_cd": "000040", "now_rank": "1", "stk_nm": "KR모터스", "cur_prc": "+1000", "flu_rt": "+5.00",
         "now_trde_qty": "100", "trde_prica": "900000"},
        {"stk_cd": "005930", "now_rank": "2", "stk_nm": "삼성전자", "cur_prc": "-71000", "flu_rt": "-1.23",
         "now_trde_qty": "34954641", "trde_prica": "5308092"},
        {"stk_cd": "069500", "now_rank": "3", "stk_nm": "KODEX 200", "cur_prc": "35000", "flu_rt": "0.00",
         "now_trde_qty": "10", "trde_prica": "1000"}], "return_code": 0}
    c, http = make(directory_routes({"ka10032": [ranking]}))
    items, ranked_at = c.rankings_with_time("MARKET_TRADING_AMOUNT", "KR", "1d", count=2)
    assert ranked_at is None
    assert items[0] == {"rank": 1, "symbol": "005930", "name": "삼성전자", "tradingAmount": "5308092000000",
                        "tradingVolume": "34954641", "price": {"lastPrice": "71000", "changeRate": "-0.0123"}}
    assert [i["symbol"] for i in items] == ["005930", "069500"]
    body = next(x["body"] for x in http.calls if x["api"] == "ka10032")
    assert body == {"mrkt_tp": "000", "mang_stk_incls": "0", "stex_tp": "1"}

    c, _ = make(directory_routes({"ka10032": [ranking]}))
    items, _ = c.rankings_with_time("MARKET_TRADING_AMOUNT", "KR", "1d", count=30, exclude_caution=False)
    assert [i["rank"] for i in items] == [1, 2, 3] and items[0]["symbol"] == "000040"


def test_mover_rankings_page_until_count():
    page1 = fixture("ka10027")
    page1["pred_pre_flu_rt_upper"] = [{**page1["pred_pre_flu_rt_upper"][0], "stk_cd": "005930"}]
    page2 = {"pred_pre_flu_rt_upper": [{**page1["pred_pre_flu_rt_upper"][0], "stk_cd": "035720"}], "return_code": 0}
    pages = iter([(200, page1, {"cont-yn": "Y", "next-key": "k1"}), (200, page2, {"cont-yn": "N"})])
    c, http = make(directory_routes({"ka10027": lambda body, h: next(pages)}))
    items = c.rankings("TOP_LOSERS", "KR", count=5)
    assert [i["symbol"] for i in items] == ["005930", "035720"]
    assert items[0]["tradingAmount"] is None and items[0]["price"] == {"lastPrice": "74800", "changeRate": "0.2986"}
    bodies = [x["body"] for x in http.calls if x["api"] == "ka10027"]
    assert bodies[0]["sort_tp"] == "3" and bodies[0]["stk_cnd"] == "1"


def test_unsupported_rankings_raise():
    c, _ = make({})
    for args in (("MARKET_TRADING_AMOUNT", "KR", "1w"), ("VOLUME", "KR", "1d"), ("MARKET_TRADING_AMOUNT", "JP", "1d")):
        with pytest.raises(KiwoomApiError) as e:
            c.rankings_with_time(*args)
        assert e.value.status == 0


# --- 환율 ---

def test_exchange_rate_averages_buy_and_sell_and_caches():
    def fx(body, headers):
        if body["exch_tp"] == "1":
            return {"buy_aplc_exrt": "1405.00", "sell_aplc_exrt": "0.00", "aplc_exrt": "1405.000000", "return_code": 0}
        return {"buy_aplc_exrt": "0.00", "sell_aplc_exrt": "1375.00", "aplc_exrt": "1375.000000", "return_code": 0}
    c, http = make({"ust31301": fx})
    clock = [100.0]
    c._monotonic = lambda: clock[0]
    assert c.exchange_rate() == {"rate": "1390.00"}
    assert float(c.exchange_rate("KRW", "USD")["rate"]) == pytest.approx(1 / 1390)
    assert http.apis().count("ust31301") == 2
    assert http.calls[-1]["url"].endswith("/api/us/exchange")
    with pytest.raises(KiwoomApiError):
        c.exchange_rate("JPY", "KRW")


def test_exchange_rate_uses_one_side_when_other_fails():
    def fx(body, headers):
        if body["exch_tp"] == "1":
            return fixture("ust31301")
        return 500, {"return_code": 1999, "return_msg": "예기치 못한 에러"}, {}
    c, _ = make({"ust31301": fx})
    assert c.exchange_rate() == {"rate": "1533.20"}


def test_exchange_rate_raises_when_unavailable():
    c, _ = make({"ust31301": [(500, {"return_code": 1999, "return_msg": "x"}, {})]})
    with pytest.raises(KiwoomApiError):
        c.exchange_rate()


# --- 미국 (문서 기준. 실측 전) ---

def us_routes():
    return {"usa10098": [fixture("usa10098")], "usa20100": [fixture("usa20100")], "usa20101": [fixture("usa20101")],
            "usa06012": [(200, fixture("usa06012"), {"cont-yn": "N"})]}


def test_us_quotes_resolve_exchange_once():
    c, http = make(us_routes())
    assert c.prices(["NVDA"]) == [{"symbol": "NVDA", "lastPrice": "201.47"}]
    book = c.orderbook("NVDA")
    assert book["asks"][0]["price"] == "201.53" and book["bids"][0]["price"] == "201.42"
    assert http.apis().count("usa10098") == 1
    assert http.calls[-1]["body"] == {"stex_tp": "ND", "stk_cd": "NVDA"}


def test_us_stock_info_and_candles():
    c, http = make(us_routes())
    info = c.stocks(["NVDA"])[0]
    assert info == {"symbol": "NVDA", "name": "엔비디아", "englishName": "NVIDIA CORP", "market": "NASDAQ",
                    "currency": "USD", "securityType": "STOCK", "status": "ACTIVE", "leverageFactor": None,
                    "koreanMarketDetail": None}
    candles = c.daily_candles("NVDA", 5)
    assert candles[-1]["timestamp"] == "2026-06-24T00:00:00-04:00"
    assert candles[-1]["closePrice"] == "201.3612" and candles[-1]["volume"] == "431663"
    body = next(x["body"] for x in http.calls if x["api"] == "usa06012")
    assert body == {"stex_tp": "ND", "stk_cd": "NVDA", "upd_stkpc_tp": "1", "exrt_appl_tp": "0"}


def test_us_ranking_units():
    c, http = make({"usa20540": [fixture("usa20540")]})
    items = c.rankings("MARKET_TRADING_AMOUNT", "US", count=1)
    row = fixture("usa20540")["result_list"][0]
    assert items[0]["symbol"] == row["stk_cd"]
    assert items[0]["tradingAmount"] == str(int(row["trde_prica"]) * 1000)
    assert items[0]["price"]["changeRate"] == "-0.0191"


def test_confirmed_price_with_one_sided_book_at_price_limit():
    # 상한가: 매도 호가가 비고 매수 호가만 상한가에 쌓인다 → 현재가를 쓴다 (목표가 청산이 막히지 않게)
    c = BookClient({"005930": 91_000, "000660": 50_000}, {"005930": (91_000, None), "000660": (60_000, None)})
    assert c.confirmed_prices(["005930", "000660"]) == {"005930": 91_000.0}  # 호가와 3% 넘게 다르면 쓰지 않는다
