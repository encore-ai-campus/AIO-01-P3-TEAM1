"""autotrade 테스트 공용. trading 테스트의 가짜 조회 클라이언트·엔진 설정·로그인 fixture를 그대로 쓰고,
시연 추천이 ATR을 계산할 수 있게 일봉 30개를 주는 가짜와 알림 기록기를 더한다. 실제 증권사·AI·Discord를 부르지 않는다.

가격은 장마감 기준이다: 미리 보기의 lastPrice·priceAtCreation은 직전 정규장 종가 (CandleClient에서 오늘 봉은 미완성 —
종가 = 어제 봉 = 지금 가격 × (0.9 + 0.1 × 28/29)). 시각에 기대는 테스트는 clock fixture로 지금 시각을 고정한다
(django.utils.timezone.now와 장 달력·일봉을 함께 — KST와 UTC 날짜가 다른 0~9시에도 같은 결과).
"""
from datetime import datetime, timedelta

import pytest
from django.core.cache import cache
from django.db import connection
from django.utils import timezone
from notifications import service as notices
from paper_engine.data.calendar import MarketCalendar
from trading.tests.conftest import KST, FakeClient, api, engine_setup, login, set_price, switch, user  # noqa: F401

from autotrade.recommend import sources
from autotrade.models import Recommendation
from config import engine

__all__ = ["login", "set_price", "switch", "make_rec", "close_of", "CLOSE_RATE"]

CLOSE_RATE = 0.9 + 0.1 * 28 / 29  # CandleClient의 어제 봉 종가 ÷ 지금 가격


def close_of(price: float) -> float:
    """CandleClient에서 지금 가격이 price일 때 직전 정규장 종가 (어제 봉)."""
    return float(f"{price * CLOSE_RATE:g}")


class CandleClient(FakeClient):
    """일봉 30개 (한 달 동안 10% 오른 흐름, 고가·저가는 종가 ±1.5%). short면 3개 (trading 가짜와 같음)."""

    def __init__(self):
        super().__init__()
        self.short = False

    def today(self):
        return datetime.now(KST).date()

    def daily_candles(self, symbol, count=200):
        if self.short:
            return super().daily_candles(symbol, count)
        self._hit("daily_candles")
        today = self.today()
        last = self.price[symbol]
        closes = [last * (0.9 + 0.1 * i / 29) for i in range(30)]
        return [{"timestamp": f"{today - timedelta(days=29 - i)}T00:00:00+09:00", "openPrice": f"{c:g}",
                 "highPrice": f"{c * 1.015:g}", "lowPrice": f"{c * 0.985:g}", "closePrice": f"{c:g}",
                 "volume": "1000"} for i, c in enumerate(closes)][-count:]


@pytest.fixture
def fake(monkeypatch):
    client = CandleClient()
    monkeypatch.setattr(engine, "broker_client", lambda: client)
    return client


class ClockClient(CandleClient):
    """지금 시각(now)을 고정한 가짜: 장 달력은 엔진 MarketCalendar(공휴일 키 없음)로 now 기준, 일봉은 now의 KST 날짜까지."""

    def __init__(self, now: datetime):
        super().__init__()
        self.now = now
        self.calendars = MarketCalendar()

    def today(self):
        return self.now.astimezone(KST).date()

    def market_calendar(self, market):
        self._hit("market_calendar")
        return self.calendars.calendar(market, self.now)


@pytest.fixture
def clock(monkeypatch):
    """clock("2026-09-22T10:00:00") — 지금 시각을 KST로 고정하고(timezone.now·가짜 장 달력·일봉) 캐시를 비운다.

    기본은 2026-09-22(화) 10:00 KST: 국내 정규장 중(기준일 9/21), 뉴욕은 9/21 21:00(장 마감 뒤). clock.client가 가짜다.
    """
    state = {}
    monkeypatch.setattr(timezone, "now", lambda: state["now"])

    def set_now(text: str, tz=KST) -> datetime:
        state["now"] = datetime.fromisoformat(text).replace(tzinfo=tz)
        set_now.client.now = state["now"]
        cache.clear()
        return state["now"]

    set_now.client = ClockClient(datetime(2026, 9, 22, 10, 0, tzinfo=KST))
    monkeypatch.setattr(engine, "broker_client", lambda: set_now.client)
    set_now("2026-09-22T10:00:00")
    return set_now


class Notices:
    """notifications.service.notify 기록기.

    executor는 알림을 트랜잭션 커밋 뒤(on_commit)에 보낸다. 테스트는 트랜잭션 안에서 돌아 커밋되지 않으므로,
    기록을 읽을 때 지금까지 커밋을 기다리는 콜백을 (한 번씩) 실행한다. 롤백된 트랜잭션의 콜백은 Django가 이미 지웠다.
    """

    def __init__(self):
        self._calls: list[dict] = []
        self._ran: list = []

    def __call__(self, users, kind, title, body, **options):
        self._calls.append({"users": users, "kind": kind, "title": title, "body": body, **options})
        return []

    def flush(self) -> None:
        while True:
            waiting = [f for _, f, _ in connection.run_on_commit if not any(f is done for done in self._ran)]
            if not waiting:
                return
            for callback in waiting:
                self._ran.append(callback)
                callback()

    @property
    def calls(self) -> list[dict]:
        self.flush()
        return self._calls

    @property
    def kinds(self) -> list[str]:
        return [c["kind"] for c in self.calls]


@pytest.fixture(autouse=True)
def sent(monkeypatch):
    recorder = Notices()
    monkeypatch.setattr(notices, "notify", recorder)
    defaults = {"RECOMMENDATION_VALID_DAYS": "3", "AUTOTRADE_DEMO": "on", "AUTOTRADE_DEMO_PER_USER": "5"}
    for key, value in defaults.items():
        monkeypatch.setenv(key, value)  # 개발자 .env 값을 읽지 않게
    return recorder


def make_rec(**kw) -> Recommendation:
    """삼성전자 진입 69,000 · 목표 80,000 · 손절 66,000 추천 (지금 가격 70,000이라 지정가가 바로 체결되지 않는다)."""
    values = {"symbol": "005930", "name": "삼성전자", "market_": "KR", "entry": 69000, "target": 80000,
              "stop": 66000, "probability": 0.5, "summary": "테스트 추천", "price_at_creation": 70000}
    source = kw.pop("source", Recommendation.ANALYSIS)
    return sources.create(source, **(values | kw))
