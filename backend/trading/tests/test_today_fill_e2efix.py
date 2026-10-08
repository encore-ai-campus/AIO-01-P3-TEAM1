"""오늘 산 종목 평가 (docs/API.md "장마감 기준"의 "오늘 산 종목", docs/DECISIONS.md 23장 — UX-1).

평가할 종가의 asOf 뒤에 체결된 보유는 그 종가 대신 체결가로 평가한다 (손익 0, Position.priceBasis "today_fill").
기준일이 오늘로 바뀌면(KR 15:40) 그날 종가로 평가된다 (close). 종가를 받지 못하면 체결가 (fill).

운영 점검 때의 숫자를 그대로 쓴다: 어제(21일) 종가 79,900원, 오늘(22일) 76,600원에 12주 체결, 22일 종가 77,000원.
"""
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest
from accounts.models import profile_of
from django.utils import timezone

from config import engine
from trading import market, service
from trading.models import EquityDaily

from .conftest import login
from .test_close_valuation import FixedClient

pytestmark = pytest.mark.django_db
KST = ZoneInfo("Asia/Seoul")
CLOSES = {"2026-09-18": 80_500.0, "2026-09-21": 79_900.0, "2026-09-22": 77_000.0}
FILL = 76_600.0
COMMISSION = 0.001  # conftest.CFG의 KR 수수료율


class DayClient(FixedClient):
    """005930의 일봉 종가가 CLOSES이고, 현재가(체결 가격)가 FILL인 가짜 조회 클라이언트."""

    def __init__(self, now: datetime):
        super().__init__(now)
        self.price["005930"] = FILL
        self.broken: set[str] = set()

    def daily_candles(self, symbol, count=200):
        if symbol in self.broken:
            raise OSError("일봉 조회 실패")
        if symbol != "005930":
            return super().daily_candles(symbol, count)
        self._hit("daily_candles")
        return [{"timestamp": f"{day}T00:00:00+09:00", "openPrice": f"{c:g}", "highPrice": f"{c:g}",
                 "lowPrice": f"{c:g}", "closePrice": f"{c:g}", "volume": "1000"} for day, c in CLOSES.items()][-count:]


@pytest.fixture
def clock(monkeypatch):
    """clock(text) — 지금 시각(KST)을 고정하고 캐시를 비운다. clock.client는 가짜 조회 클라이언트."""
    client = DayClient(datetime(2026, 9, 22, 10, tzinfo=KST))
    state = {"now": client.now}
    monkeypatch.setattr(timezone, "now", lambda: state["now"].astimezone(UTC))
    monkeypatch.setattr(engine, "broker_client", lambda: client)

    def set_now(text: str) -> datetime:
        state["now"] = client.now = datetime.fromisoformat(text).replace(tzinfo=KST)
        market.cache.clear()
        return state["now"]

    set_now.client = client
    set_now("2026-09-22T10:00:00")
    return set_now


def public_login(django_user_model, name: str):
    u, client = login(django_user_model, name)
    profile = profile_of(u)
    profile.is_public = True
    profile.save()
    return client


def buy(api, quantity: int = 12):
    response = api.post("/api/orders", {"symbol": "005930", "quantity": quantity, "orderType": "MARKET"}, format="json")
    assert response.status_code == 201, response.json()
    assert response.json()["order"]["fillPrice"] == FILL
    return response.json()["order"]


def position(api) -> dict:
    return api.get("/api/account").json()["positions"][0]


def test_today_fill_is_valued_at_fill_price_until_todays_close(api, clock):
    clock("2026-09-22T10:29:00")
    buy(api)
    body = api.get("/api/account").json()
    p = body["positions"][0]
    assert p["priceBasis"] == "today_fill"
    assert p["lastPrice"] == pytest.approx(79_900)            # 직전 종가는 그대로 보인다
    assert p["valueKrw"] == pytest.approx(12 * FILL) == p["costKrw"]
    assert p["profitKrw"] == pytest.approx(0) and p["profitRate"] == pytest.approx(0)  # 가짜 +4.31%가 아니다
    assert body["holdingsValueKrw"] == pytest.approx(12 * FILL)
    assert body["profitKrw"] == pytest.approx(-12 * FILL * COMMISSION)   # 산 수수료만
    assert body["pricesAsOf"] == {"KR": "2026-09-21T15:30:00+09:00"}
    assert body["notes"] == []                                 # 종가를 받지 못한 것이 아니다

    clock("2026-09-22T15:39:00")                               # 기준일은 아직 어제
    assert position(api)["priceBasis"] == "today_fill"

    clock("2026-09-22T15:40:00")                               # 기준일이 오늘로 바뀜 → 그날 종가로 평가
    p = position(api)
    assert p["priceBasis"] == "close" and p["lastPrice"] == pytest.approx(77_000)
    assert p["profitKrw"] == pytest.approx(12 * (77_000 - FILL))


def test_holding_bought_before_the_close_is_valued_at_close(api, clock):
    clock("2026-09-21T10:00:00")                               # 21일 장중에 삼 (21일 종가 asOf 15:30보다 앞)
    buy(api)
    clock("2026-09-22T10:29:00")
    p = position(api)
    assert p["priceBasis"] == "close" and p["lastPrice"] == pytest.approx(79_900)
    assert p["profitKrw"] == pytest.approx(12 * (79_900 - FILL))


def test_same_symbol_differs_per_account(clock, django_user_model):
    """같은 종목도 계좌마다 체결 시각이 달라 평가 기준이 다르다 (어제 산 bob은 종가, 오늘 산 alice는 체결가)."""
    alice, bob = public_login(django_user_model, "alice"), public_login(django_user_model, "bob")
    clock("2026-09-21T10:00:00")
    buy(bob)
    clock("2026-09-22T10:29:00")
    buy(alice)
    assert position(alice)["priceBasis"] == "today_fill" and position(bob)["priceBasis"] == "close"

    body = alice.get("/api/ranking").json()
    rates = {e["nickname"]: e["profitRate"] for e in body["results"]}
    assert rates["alice"] == pytest.approx(-12 * FILL * COMMISSION / 10_000_000)  # 0% (산 수수료만), 사자마자 1위가 아니다
    assert rates["bob"] == pytest.approx((12 * 79_900 - 12 * FILL * (1 + COMMISSION)) / 10_000_000)
    assert [e["nickname"] for e in body["results"]] == ["bob", "alice"]
    assert body["me"]["profitRate"] == rates["alice"]


def test_missing_close_is_fill_basis(api, clock):
    clock("2026-09-22T10:29:00")
    buy(api)
    clock.client.broken.add("005930")
    market.cache.clear()
    body = api.get("/api/account").json()
    p = body["positions"][0]
    assert p["priceBasis"] == "fill" and p["lastPrice"] is None and p["valueKrw"] == pytest.approx(12 * FILL)
    assert body["notes"] == ["종가를 받지 못해 체결가로 평가: 005930"]


def test_equity_record_uses_todays_close(api, clock):
    """일별 자산(17:00 이후)은 그날 종가 — 오늘 산 보유도 그날 종가 asOf(15:30)보다 먼저 샀으므로 영향이 없다."""
    clock("2026-09-22T10:29:00")
    buy(api)
    out = []
    assert service.record_equity(clock("2026-09-22T17:00:00"), out.append) == 1
    assert EquityDaily.objects.get().holdings_value_krw == pytest.approx(12 * 77_000)
