"""모의 트레이딩 API (docs/API.md "모의 트레이딩"). 증권사는 가짜 클라이언트(conftest.FakeClient)다.

가짜 장 달력은 지금 정규장이 열려 있거나(1시간 전 ~ 1시간 뒤) 곧 열린다 → 장마감 기준일은 늘 어제(KST)이고,
평가·랭킹은 어제 봉의 종가 = 현재가 × 0.98 (CLOSE), 그 전 종가 = 현재가 × 0.97이다. 체결은 현재가(장중)로 한다.
방금 산 보유는 어제 종가 뒤에 산 것이라 체결가로 평가되므로(오늘 산 종목 — test_today_fill_e2efix.py) 종가 평가를 볼 때는
체결 시각을 앞당긴다 (conftest.backdate_fills).
시세(Quote)는 실시간이다: 가격 = 현재가, prevClose = 어제 종가 (오늘이 거래일). 자세한 날짜별 규칙은 test_live_quotes.py.
"""
from datetime import datetime, timedelta

import pytest
from accounts.models import profile_of
from django.core.cache import cache
from django.utils import timezone
from paper_engine.judge.risk import SELL_TAX_RATE

from config import engine
from trading import market, service
from trading.models import PaperAccount, PaperOrder, Reservation

from .conftest import backdate_fills, login, set_price, switch

pytestmark = pytest.mark.django_db

ORDER_KEYS = {"id", "symbol", "name", "market", "currency", "orderType", "limitPrice", "quantity", "status",
              "entryPrice", "fillPrice", "filledAt", "targetPrice", "stopPrice", "expireDate", "exitPrice",
              "exitReason", "closedAt", "pnlKrw", "note", "createdAt", "style"}
POSITION_KEYS = {"orderId", "symbol", "name", "market", "currency", "style", "quantity", "avgPrice", "lastPrice",
                 "costKrw", "valueKrw", "profitKrw", "profitRate", "targetPrice", "stopPrice", "expireDate", "filledAt",
                 "priceBasis"}
SUMMARY_KEYS = {"initialCapitalKrw", "cashKrw", "holdingsValueKrw", "equityKrw", "investedKrw", "profitKrw",
                "profitRate", "pendingKrw", "buyingPowerKrw", "positions", "notes", "pricesAsOf", "asOf"}
RESERVATION_KEYS = {"id", "kind", "symbol", "name", "market", "quantity", "orderId", "targetPrice", "stopPrice",
                    "days", "style", "runAt", "createdAt"}
CLOSE, PREV = 0.98, 0.97  # 가짜 일봉: 어제 종가 = 현재가 × 0.98, 그저께 = × 0.97


def buy(api, **body):
    return api.post("/api/orders", {"symbol": "005930", "quantity": 10, "orderType": "MARKET", **body}, format="json")


# --- 로그인·계좌 ---

def test_login_required(client):
    for method, path in (("get", "/api/account"), ("get", "/api/market"), ("post", "/api/orders"),
                         ("get", "/api/ranking")):
        response = getattr(client, method)(path)
        assert response.status_code == 401
        assert response.json() == {"detail": "로그인이 필요합니다."}


def test_account_created_on_first_use(api, user):
    assert not PaperAccount.objects.exists()
    body = api.get("/api/account").json()
    assert PaperAccount.objects.get(user=user).cash_krw == 10_000_000
    assert set(body) == SUMMARY_KEYS
    assert body["cashKrw"] == body["equityKrw"] == body["initialCapitalKrw"] == body["buyingPowerKrw"] == 10_000_000
    assert body["investedKrw"] == 0 and body["profitKrw"] == 0 and body["profitRate"] == 0
    assert body["pendingKrw"] == 0 and body["positions"] == [] and body["notes"] == []
    assert body["pricesAsOf"] == {}  # 보유가 없으면 비어 있다
    api.get("/api/account")
    assert PaperAccount.objects.count() == 1


def test_market_buy_price_move_and_sell(api, fake):
    response = buy(api)
    assert response.status_code == 201
    result = response.json()
    assert result["reservation"] is None and "매수" in result["message"]
    order = result["order"]
    assert set(order) == ORDER_KEYS
    assert order["status"] == "EXIT_WATCHING" and order["orderType"] == "MARKET"
    assert order["style"] == "long" and order["expireDate"] is None  # 목표·손절·기한이 없으면 장기 보유
    assert order["fillPrice"] == 70000 and order["quantity"] == 10 and order["filledAt"].endswith("+09:00")

    # 체결은 장중 확인 가격(70,000), 평가는 직전 장마감 종가(68,600) — 그 종가보다 먼저 산 보유로 만든다
    backdate_fills()
    cost = 700_000 * 1.001
    close = 70000 * CLOSE
    body = api.get("/api/account").json()
    assert body["cashKrw"] == pytest.approx(10_000_000 - cost)
    assert body["holdingsValueKrw"] == pytest.approx(10 * close)
    assert body["equityKrw"] == pytest.approx(10_000_000 - cost + 10 * close)
    assert body["investedKrw"] == pytest.approx(700_000)
    assert body["profitRate"] == pytest.approx((10 * close - cost) / 10_000_000)
    assert set(body["pricesAsOf"]) == {"KR"} and body["pricesAsOf"]["KR"].endswith("+09:00")
    position = body["positions"][0]
    assert set(position) == POSITION_KEYS
    assert position["orderId"] == order["id"] and position["avgPrice"] == 70000 and position["style"] == "long"
    assert position["lastPrice"] == pytest.approx(close) and position["priceBasis"] == "close"
    assert position["costKrw"] == pytest.approx(700_000) and position["profitKrw"] == pytest.approx(10 * close - 700_000)

    set_price(fake, "005930", 75000)
    body = api.get("/api/account").json()
    position = body["positions"][0]
    assert position["lastPrice"] == pytest.approx(75000 * CLOSE) and position["valueKrw"] == pytest.approx(735_000)
    assert position["profitKrw"] == pytest.approx(35_000)
    assert position["profitRate"] == pytest.approx(35_000 / 700_000)
    assert body["equityKrw"] == pytest.approx(10_000_000 - cost + 735_000)

    response = api.post(f"/api/orders/{order['id']}/sell")
    assert response.status_code == 200
    sold = response.json()["order"]
    assert sold["status"] == "CLOSED" and sold["exitReason"] == "MANUAL" and sold["exitPrice"] == 75000  # 매도는 장중
    proceeds = 750_000 - 750 - 750_000 * SELL_TAX_RATE["KR"]
    assert sold["pnlKrw"] == pytest.approx(proceeds - cost)
    body = api.get("/api/account").json()
    assert body["positions"] == [] and body["investedKrw"] == 0 and body["pricesAsOf"] == {}
    assert body["cashKrw"] == pytest.approx(10_000_000 - cost + proceeds)

    fills = api.get("/api/fills").json()
    assert fills["count"] == 2
    assert [f["side"] for f in fills["results"]] == ["SELL", "BUY"]
    assert fills["results"][1]["cashChangeKrw"] == pytest.approx(-cost)
    assert fills["results"][0]["reason"] == "MANUAL" and fills["results"][0]["symbol"] == "005930"
    assert api.get("/api/orders").json()["count"] == 0
    assert api.get("/api/orders?status=all").json()["count"] == 1


def test_account_uses_fill_price_when_quotes_fail(api, fake):
    buy(api)
    fake.fail = True
    cache.clear()
    response = api.get("/api/account")
    assert response.status_code == 200
    body = response.json()
    assert body["positions"][0]["lastPrice"] is None
    assert body["holdingsValueKrw"] == pytest.approx(700_000)
    assert body["pricesAsOf"] == {}
    assert any("종가를 조회하지 못해" in n for n in body["notes"])
    assert any(n.startswith("종가를 받지 못해 체결가로 평가") and "005930" in n for n in body["notes"])


def test_account_values_unpriced_holding_at_fill_price(api, fake):
    """한 종목의 종가만 받지 못하면 그 종목만 체결가로 평가하고 안내한다 (종가가 있는 시장만 pricesAsOf)."""
    buy(api)
    broken = fake.daily_candles

    def candles(symbol, count=200):
        if symbol == "005930":
            raise OSError("일봉 조회 실패")
        return broken(symbol, count)
    fake.daily_candles = candles
    cache.clear()
    body = api.get("/api/account").json()
    assert body["positions"][0]["lastPrice"] is None and body["holdingsValueKrw"] == pytest.approx(700_000)
    assert body["notes"] == ["종가를 받지 못해 체결가로 평가: 005930"] and body["pricesAsOf"] == {}


# --- 주문 규칙 ---

def test_limit_order_waits(api, fake):
    response = buy(api, orderType="LIMIT", limitPrice=69000)
    order = response.json()["order"]
    assert response.status_code == 201 and order["status"] == "ENTRY_PENDING" and order["limitPrice"] == 69000
    assert order["style"] == "long"
    body = api.get("/api/account").json()
    assert body["pendingKrw"] == pytest.approx(690_000 * 1.001)
    assert body["buyingPowerKrw"] == pytest.approx(10_000_000 - 690_000 * 1.001)


def test_limit_order_outside_session_is_accepted_pending(api, fake):
    switch(fake, KR=False)
    response = buy(api, orderType="LIMIT", limitPrice=71000)
    assert response.status_code == 201
    assert response.json()["order"]["status"] == "ENTRY_PENDING" and response.json()["reservation"] is None


def test_market_order_outside_session_is_reserved(api, fake):
    switch(fake, KR=False)
    response = buy(api, targetPrice=77000, stopPrice=66000, days=10)
    assert response.status_code == 201
    result = response.json()
    assert result["order"] is None and "예약" in result["message"]
    reservation = result["reservation"]
    assert set(reservation) == RESERVATION_KEYS
    assert reservation["kind"] == "BUY" and reservation["quantity"] == 10 and reservation["days"] == 10
    assert reservation["style"] == "swing" and Reservation.objects.get().style == "swing"
    assert reservation["targetPrice"] == 77000 and reservation["runAt"] is not None
    assert not PaperOrder.objects.exists()
    assert [r["id"] for r in api.get("/api/reservations").json()["results"]] == [reservation["id"]]
    assert buy(api).json()["detail"] == "같은 종목의 매수 예약이 이미 있음"
    assert api.delete(f"/api/reservations/{reservation['id']}").status_code == 204
    assert api.get("/api/reservations").json()["results"] == []


def test_order_validation(api, fake):
    assert buy(api, symbol="999999").status_code == 400
    assert buy(api, quantity="10").json()["detail"] == "quantity은(는) 숫자여야 합니다."
    assert buy(api, orderType="LIMIT").json()["detail"] == "limitPrice이(가) 필요합니다."
    assert buy(api, orderType="STOP").status_code == 400
    assert "정수" in buy(api, quantity=1.5).json()["detail"]
    assert "함께" in buy(api, targetPrice=77000).json()["detail"]
    assert "함께" in buy(api, days=5).json()["detail"]  # 기한만 주면 스윙인데 목표·손절이 없다
    assert "기한" in buy(api, targetPrice=77000, stopPrice=66000, days=0).json()["detail"]
    response = buy(api, symbol="035720")  # 종목 목록에는 있지만 가격이 없다
    assert response.status_code == 400 and response.json()["detail"] == "확인된 가격이 없어 주문하지 않음"
    assert not PaperOrder.objects.exists()


def test_market_long_check_uses_current_price(api, fake, monkeypatch):
    """시장가 장기 보유 점검 가격은 현재가 (실시간 시세 = 화면 예상 금액과 같다), 받지 못하면 직전 종가 (docs/API.md POST /api/orders)."""
    seen = []
    real = service.assess_position
    monkeypatch.setattr(service, "assess_position", lambda price, *rest: seen.append(price) or real(price, *rest))
    # 현재가 70,000 × 145주 ≈ 1,016만원 > 매수 가능 1,000만원 (직전 종가 68,600이면 996만원이라 통과한다)
    response = buy(api, quantity=145)
    assert response.status_code == 400 and "cash_short" in response.json()["reasonCodes"]
    assert seen == [70000]
    cache.clear()
    fake.prices = lambda symbols: (_ for _ in ()).throw(OSError("현재가 조회 실패"))
    assert buy(api, quantity=1).status_code == 201  # 체결은 지금처럼 장중 확인 가격
    assert seen[-1] == pytest.approx(70000 * CLOSE)


def test_duplicate_symbol_rejected(api, fake):
    assert buy(api).status_code == 201
    response = buy(api, quantity=1)
    assert response.status_code == 400 and "같은 종목" in response.json()["detail"]
    assert PaperOrder.objects.count() == 1


def test_buying_power_shortage_rejected(api, fake):
    # 스윙: 엔진 접수 점검 (장중 가격 1,050만원 > 1,000만원). 장중 가격으로 계산한 필요 금액은 문장에 넣지 않는다
    response = buy(api, quantity=150, targetPrice=77000, stopPrice=66000)
    assert response.status_code == 400 and "매수 가능 금액 부족" in response.json()["detail"]
    assert "reasonCodes" not in response.json()
    # 장기 보유: 비중 점검 (시장가는 현재가 70,000 × 150주 = 1,050만원 > 매수 가능 1,000만원, 자산의 100%도 넘음) → 사유 코드
    response = buy(api, quantity=150)
    assert response.status_code == 400 and set(response.json()) == {"detail", "reasonCodes"}
    assert response.json()["reasonCodes"] == ["cash_short", "position_limit"]
    assert len(response.json()["detail"].split("; ")) == 2  # 사유와 코드는 같은 길이·같은 순서
    assert "70,000" not in response.json()["detail"]  # 장중 가격 숫자는 넣지 않는다


def test_halt_switch_blocks_new_buys(api, fake):
    engine.HALT_FILE.write_text("")
    response = buy(api)
    assert response.status_code == 400 and "중단 스위치" in response.json()["detail"]
    assert api.get("/api/market").json()["halted"] is True


def test_modify_and_cancel(api, fake):
    order = buy(api, orderType="LIMIT", limitPrice=69000, targetPrice=75000, stopPrice=65000).json()["order"]
    assert order["style"] == "swing"
    response = api.patch(f"/api/orders/{order['id']}", {"targetPrice": 80000, "stopPrice": 60000, "days": 5},
                         format="json")
    assert response.status_code == 200
    changed = response.json()
    assert changed["targetPrice"] == 80000 and changed["stopPrice"] == 60000
    assert changed["expireDate"] == f"{timezone.localdate() + timedelta(days=5)}"
    assert "순서" in api.patch(f"/api/orders/{order['id']}", {"stopPrice": 90000}, format="json").json()["detail"]

    response = api.post(f"/api/orders/{order['id']}/cancel")
    assert response.status_code == 200 and response.json()["status"] == "CANCELED"
    assert api.post(f"/api/orders/{order['id']}/cancel").status_code == 400


def test_sell_pending_order_cancels(api, fake):
    order = buy(api, orderType="LIMIT", limitPrice=69000).json()["order"]
    result = api.post(f"/api/orders/{order['id']}/sell").json()
    assert result["order"]["status"] == "CANCELED" and result["reservation"] is None and "취소" in result["message"]


def test_sell_outside_session_is_reserved(api, fake):
    order = buy(api).json()["order"]
    switch(fake, KR=False)
    response = api.post(f"/api/orders/{order['id']}/sell")
    assert response.status_code == 200
    result = response.json()
    assert result["order"]["status"] == "EXIT_WATCHING"
    assert result["reservation"]["kind"] == "SELL" and result["reservation"]["orderId"] == order["id"]
    assert result["reservation"]["style"] is None  # 매도 예약에는 보유 방식이 없다
    again = api.post(f"/api/orders/{order['id']}/sell")
    assert again.status_code == 400 and "매도 예약이 이미 있음" in again.json()["detail"]


def test_other_users_orders_are_404(api, fake, django_user_model):
    order = buy(api).json()["order"]
    switch(fake, KR=False)
    reservation = buy(api, symbol="000660", quantity=1).json()["reservation"]
    _, bob = login(django_user_model, "bob")
    assert bob.patch(f"/api/orders/{order['id']}", {"targetPrice": 80000}, format="json").status_code == 404
    assert bob.post(f"/api/orders/{order['id']}/sell").status_code == 404
    assert bob.post(f"/api/orders/{order['id']}/cancel").status_code == 404
    assert bob.delete(f"/api/reservations/{reservation['id']}").status_code == 404
    assert bob.get("/api/orders?status=all").json()["count"] == 0
    assert bob.get("/api/fills").json()["count"] == 0
    assert bob.get("/api/reservations").json()["results"] == []
    assert Reservation.objects.count() == 1


# --- 랭킹 ---

def test_ranking(fake, django_user_model):
    clients = {}
    for name in ("alice", "bob", "carol", "dave", "erin"):
        u, c = login(django_user_model, name)
        clients[name] = c
        profile = profile_of(u)
        profile.is_public = name != "carol"
        profile.save()
    buy(clients["alice"])                                       # 005930 10주 @70,000
    buy(clients["bob"], symbol="000660", quantity=1)            # 000660 1주 @200,000
    buy(clients["carol"], symbol="005935", quantity=100)        # 005935 100주 @60,000
    clients["erin"].get("/api/account")                         # 계좌만 있음 (수익률 0)
    backdate_fills()                                            # 직전 종가보다 먼저 산 보유 (종가로 평가)
    set_price(fake, "005930", 80000)
    set_price(fake, "000660", 150000)
    set_price(fake, "005935", 90000)

    body = clients["carol"].get("/api/ranking").json()
    assert [e["nickname"] for e in body["results"]] == ["alice", "dave", "erin", "bob"]
    assert [e["rank"] for e in body["results"]] == [1, 2, 3, 4]
    assert all(set(e) == {"rank", "nickname", "profitRate", "isMe"} for e in body["results"])
    assert not any(e["isMe"] for e in body["results"])
    assert body["results"][0]["profitRate"] > 0 > body["results"][3]["profitRate"]
    assert body["results"][1]["profitRate"] == 0 == body["results"][2]["profitRate"]
    assert body["me"]["isPublic"] is False and body["me"]["rank"] is None and body["me"]["profitRate"] > 0.2

    body = clients["alice"].get("/api/ranking").json()
    assert body["me"] == {"isPublic": True, "rank": 1, "profitRate": body["results"][0]["profitRate"]}
    assert [e["isMe"] for e in body["results"]] == [True, False, False, False]


# --- 시세·종목 ---

def test_quotes(api, fake):
    body = api.get("/api/quotes?symbols=005930,000000,AAPL,005930").json()
    assert body["asOf"]  # 응답 시각
    quotes = {q["symbol"]: q for q in body["quotes"]}
    assert list(quotes) == ["005930", "AAPL"]  # 모르는 종목은 빠진다
    samsung = quotes["005930"]
    assert set(samsung) == {"symbol", "name", "currency", "price", "prevClose", "change", "changeRate", "asOf",
                            "basis"}
    assert samsung["name"] == "삼성전자" and samsung["currency"] == "KRW" and samsung["basis"] == "live"
    # 실시간: 가격은 현재가, prevClose는 오늘(거래일)의 전 거래일 종가 = 어제 봉의 종가
    assert isinstance(samsung["price"], float) and samsung["price"] == 70000
    assert samsung["prevClose"] == pytest.approx(70000 * CLOSE)
    assert samsung["change"] == pytest.approx(70000 * (1 - CLOSE))
    assert samsung["changeRate"] == pytest.approx(1 / CLOSE - 1)
    # asOf = 현재가를 받은 시각 (서버 시각 KST, 초까지)
    received = datetime.fromisoformat(samsung["asOf"])
    assert samsung["asOf"].endswith("+09:00") and received.microsecond == 0
    assert timedelta(0) <= datetime.fromisoformat(body["asOf"]) - received < timedelta(seconds=5)
    assert quotes["AAPL"]["currency"] == "USD" and quotes["AAPL"]["price"] == 200
    assert quotes["AAPL"]["basis"] == "live"
    assert api.get("/api/quotes").json()["quotes"] == []
    too_many = ",".join(f"{i:06d}" for i in range(51))
    assert api.get(f"/api/quotes?symbols={too_many}").status_code == 400


def test_quote_without_close_is_null(api, fake):
    """현재가도 일봉도 받지 못한 종목(종목 목록에는 있음)은 장마감 기준 Quote이고 가격·기준 시각이 null이다."""
    quote = api.get("/api/quotes?symbols=035720").json()["quotes"][0]
    assert (quote["price"], quote["prevClose"], quote["change"], quote["asOf"], quote["basis"]) == (
        None, None, None, None, "close")


def test_quotes_are_cached(api, fake, monkeypatch):
    monkeypatch.setattr(market, "PRICE_TTL", 60)  # 현재가 1초 캐시가 테스트 도중 지나지 않게
    api.get("/api/quotes?symbols=005930")
    api.get("/api/quotes?symbols=005930")
    assert fake.calls.count("prices") == 1  # 현재가는 종목마다 캐시 (팀 전체가 같이 쓴다)
    assert fake.calls.count("daily_candles") == 1
    cache.delete("trading:candles:005930")  # 일봉 60초 캐시가 지났다고 본다
    cache.delete("trading:live:005930")  # 현재가 캐시도
    api.get("/api/quotes?symbols=005930")
    assert fake.calls.count("prices") == 2
    assert fake.calls.count("daily_candles") == 1  # 전 거래일 종가는 종목·날짜마다 일봉 1번 (직전 영업일 봉이면 하루 캐시)


def test_search(api, fake):
    body = api.get("/api/stocks/search?q=삼성").json()
    assert [s["symbol"] for s in body["results"]] == ["005930", "005935"]
    assert body["results"][0] == {"symbol": "005930", "name": "삼성전자", "exchange": "KOSPI", "market": "KR"}
    assert api.get("/api/stocks/search?q=005930").json()["results"][0]["symbol"] == "005930"
    assert api.get("/api/stocks/search?q=0059").json()["results"][0]["symbol"] == "005930"
    assert api.get("/api/stocks/search?q=삼성전자우").json()["results"][0]["symbol"] == "005935"
    assert api.get("/api/stocks/search?q=apple").json()["results"][0]["market"] == "US"
    assert len(api.get("/api/stocks/search?q=삼성&limit=1").json()["results"]) == 1
    assert api.get("/api/stocks/search?q=").json() == {"results": []}


def test_stock_detail(api, fake):
    body = api.get("/api/stocks/000660").json()
    assert set(body) == {"symbol", "name", "exchange", "market", "currency", "quote", "candles", "asOf", "warnings"}
    assert (body["symbol"], body["exchange"], body["market"], body["currency"]) == ("000660", "KOSPI", "KR", "KRW")
    assert body["quote"]["price"] == 200000 and body["quote"]["basis"] == "live" and body["warnings"] == ["투자경고"]
    assert len(body["candles"]) == 3  # 오늘 진행 중인 봉까지
    candle = body["candles"][-1]
    assert set(candle) == {"date", "open", "high", "low", "close", "volume"}
    assert candle["date"] == f"{timezone.localdate()}"
    assert candle["close"] == pytest.approx(200000) and isinstance(candle["volume"], float)
    assert body["candles"][0]["date"] < body["candles"][-1]["date"]
    assert body["asOf"] == body["quote"]["asOf"]  # 마지막 봉이 오늘 진행 중 → 현재가를 받은 시각
    fake.ended.add("KR")  # 오늘 정규장이 끝났다 → 오늘 봉은 완성 봉
    cache.clear()
    body = api.get("/api/stocks/000660").json()
    assert body["candles"][-1]["date"] == f"{timezone.localdate()}" and body["quote"]["basis"] == "live"
    assert body["asOf"] == market.calendar("KR")["today"]["integrated"]["regularMarket"]["endTime"]
    assert api.get("/api/stocks/999999").status_code == 404


def test_market_status(api, fake):
    body = api.get("/api/market").json()
    assert body["brokerReady"] is True and body["halted"] is False
    assert body["quoteProvider"] == "키움증권 REST API"
    kr = body["markets"][0]
    assert set(kr) == {"market", "isOpen", "opensAt", "closesAt", "closeDate", "lastCloseAt"}
    assert kr["market"] == "KR" and kr["isOpen"] is True and kr["opensAt"] and kr["closesAt"]
    assert kr["closeDate"] == f"{timezone.localdate() - timedelta(days=1)}"  # 정규장 중이면 어제가 기준일
    assert kr["lastCloseAt"] == market.calendar("KR")["previousBusinessDay"]["integrated"]["regularMarket"][
        "endTime"]
    switch(fake, KR=False)
    kr = api.get("/api/market").json()["markets"][0]
    assert kr["isOpen"] is False and kr["opensAt"] and kr["closesAt"] is None and kr["closeDate"]


def test_market_status_quote_provider_for_toss(api, fake, monkeypatch):
    import dataclasses

    from .conftest import CFG
    monkeypatch.setattr(engine, "engine_config", lambda: dataclasses.replace(CFG, broker="toss"))
    assert api.get("/api/market").json()["quoteProvider"] == "토스증권 Open API(개발)"


def test_broker_missing(api):
    for path in ("/api/quotes?symbols=005930", "/api/stocks/search?q=삼성", "/api/stocks/005930"):
        response = api.get(path)
        assert response.status_code == 503 and "증권사" in response.json()["detail"]
    assert buy(api).status_code == 503
    body = api.get("/api/market").json()
    assert body["brokerReady"] is False and body["markets"][0]["isOpen"] is False
    assert body["markets"][0]["closeDate"] is None and body["markets"][0]["lastCloseAt"] is None
    assert api.get("/api/account").status_code == 200
    assert api.get("/api/ranking").status_code == 200


def test_broker_error_is_503(api, fake):
    fake.fail = True
    response = api.get("/api/quotes?symbols=005930")
    assert response.status_code == 503 and "증권사 조회 실패" in response.json()["detail"]
