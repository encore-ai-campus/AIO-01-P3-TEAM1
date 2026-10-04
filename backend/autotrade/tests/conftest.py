"""autotrade 테스트 공용. trading 테스트의 가짜 조회 클라이언트·엔진 설정·로그인 fixture를 그대로 쓰고,
시연 추천이 ATR을 계산할 수 있게 일봉 30개를 주는 가짜와 알림 기록기를 더한다. 실제 증권사·AI·Discord를 부르지 않는다.
"""
from datetime import datetime, timedelta

import pytest
from notifications import service as notices
from trading.tests.conftest import KST, FakeClient, api, engine_setup, login, set_price, switch, user  # noqa: F401

from autotrade import sources
from autotrade.models import Recommendation
from config import engine

__all__ = ["login", "set_price", "switch", "make_rec"]


class CandleClient(FakeClient):
    """일봉 30개 (한 달 동안 10% 오른 흐름, 고가·저가는 종가 ±1.5%). short면 3개 (trading 가짜와 같음)."""

    def __init__(self):
        super().__init__()
        self.short = False

    def daily_candles(self, symbol, count=200):
        if self.short:
            return super().daily_candles(symbol, count)
        self._hit("daily_candles")
        today = datetime.now(KST).date()
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


class Notices:
    """notifications.service.notify 기록기."""

    def __init__(self):
        self.calls: list[dict] = []

    def __call__(self, users, kind, title, body, **options):
        self.calls.append({"users": users, "kind": kind, "title": title, "body": body, **options})
        return []

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
