"""trading 테스트 공용: 가짜 조회 클라이언트, 고정 엔진 설정, 로그인한 API 클라이언트.

실제 증권사를 부르지 않는다. 장 달력은 지금 시각을 기준으로 만든다 (열림: 1시간 전 ~ 1시간 뒤, 닫힘: 1시간 뒤 시작).
"""
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pytest
from analysis import jobs
from django.core.cache import cache
from django.db.models import F
from paper_engine.config import Config
from reports.autoreport import auto as reports_auto
from reports.orchestration import runner
from rest_framework.test import APIClient

from config import engine
from trading.models import PaperOrder

KST = ZoneInfo("Asia/Seoul")
CFG = Config(kiwoom_appkey=None, kiwoom_secretkey=None, token_cache=None, markets=("KR", "US"),
             paper_capital_krw=10_000_000, commission={"KR": 0.001, "US": 0.002})
LISTED = {
    "KOSPI": [{"symbol": "005930", "name": "삼성전자", "market": "KOSPI"},
              {"symbol": "005935", "name": "삼성전자우", "market": "KOSPI"},
              {"symbol": "000660", "name": "SK하이닉스", "market": "KOSPI"}],
    "KOSDAQ": [{"symbol": "035720", "name": "카카오게임즈", "market": "KOSDAQ"}],
    "NASDAQ": [{"symbol": "AAPL", "name": "Apple", "market": "NASDAQ"}],
}


class FakeClient:
    """엔진 조회 클라이언트(KiwoomClient·TossClient)와 같은 메서드·반환 형식."""

    def __init__(self):
        self.price = {"005930": 70000.0, "005935": 60000.0, "000660": 200000.0, "AAPL": 200.0}
        self.open = {"KR": True, "US": True}
        self.ended: set[str] = set()  # 오늘 정규장이 이미 끝난 시장
        self.fx = 1400.0
        self.calls: list[str] = []
        self.fail = False

    def _hit(self, name: str) -> None:
        self.calls.append(name)
        if self.fail:
            raise OSError("연결 실패")

    def prices(self, symbols):
        self._hit("prices")
        return [{"symbol": s, "lastPrice": f"{self.price[s]:g}"} for s in symbols if s in self.price]

    def confirmed_prices(self, symbols):
        self._hit("confirmed_prices")
        return {s: self.price[s] for s in symbols if s in self.price}

    def stocks(self, symbols):
        self._hit("stocks")
        out = []
        for items in LISTED.values():
            for s in items:
                if s["symbol"] in symbols:
                    currency = "USD" if s["market"] == "NASDAQ" else "KRW"
                    out.append({**s, "currency": currency, "status": "ACTIVE", "securityType": "STOCK"})
        return out

    def warnings(self, symbol):
        self._hit("warnings")
        return [{"warningType": "INVESTMENT_WARNING", "description": "투자경고"}] if symbol == "000660" else []

    def listed_stocks(self, exchange):
        self._hit("listed_stocks")
        return LISTED.get(exchange, [])

    def exchange_rate(self, base="USD", quote="KRW"):
        self._hit("exchange_rate")
        return {"rate": f"{self.fx}"}

    def market_calendar(self, market):
        self._hit("market_calendar")
        now = datetime.now(KST)
        if market in self.ended:  # 같은 날(KST) 이미 끝난 정규장
            end = max(now - timedelta(minutes=1), now.replace(hour=0, minute=0, second=1, microsecond=0))
            start = end - timedelta(hours=2)
        else:  # 시작 시각도 같은 날(KST) 안에 둔다 — 0시·23시대에 날짜를 넘으면 장 열림·닫힘이 뒤바뀐다
            midnight = now.replace(hour=0, minute=0, second=0, microsecond=0)
            if self.open[market]:
                start = max(now - timedelta(hours=1), midnight)
            else:
                start = now + min(timedelta(hours=1), (midnight + timedelta(days=1) - now) / 2)
            end = start + timedelta(hours=2)

        def entry(shift: int) -> dict:
            s, e = start + timedelta(days=shift), end + timedelta(days=shift)
            return {"date": f"{(now + timedelta(days=shift)).date()}",
                    "integrated": {"regularMarket": {"startTime": s.isoformat(), "endTime": e.isoformat()}}}
        return {"previousBusinessDay": entry(-1), "today": entry(0), "nextBusinessDay": entry(1)}

    def daily_candles(self, symbol, count=200):
        """그저께·어제·오늘(미완성) 일봉. 어제 종가는 현재가의 98%."""
        self._hit("daily_candles")
        today = datetime.now(KST).date()
        last = self.price[symbol]
        closes = [last * 0.97, last * 0.98, last]
        return [{"timestamp": f"{today - timedelta(days=2 - i)}T00:00:00+09:00", "openPrice": f"{c:g}",
                 "highPrice": f"{c * 1.01:g}", "lowPrice": f"{c * 0.99:g}", "closePrice": f"{c:g}", "volume": "1000"}
                for i, c in enumerate(closes)][-count:]


@pytest.fixture(autouse=True)
def engine_setup(monkeypatch, tmp_path):
    """캐시를 비우고, 엔진 설정을 고정하고, 중단 스위치·주문 잠금 파일을 tmp_path에 둔다 (저장소에 data/를 만들지 않는다)."""
    cache.clear()
    monkeypatch.setattr(engine, "engine_config", lambda: CFG)
    monkeypatch.setattr(engine, "broker_client", lambda: None)
    monkeypatch.setattr(engine, "HALT_FILE", tmp_path / "HALT")
    monkeypatch.setattr(jobs, "tick", lambda: None)  # 분석 작업은 analysis 앱 소유. 여기서는 부르는지만 본다
    monkeypatch.setattr(runner, "tick", lambda: 0)  # 리포트 실행·자동 리포트는 reports 앱 소유 (reports/tests가 본다)
    monkeypatch.setattr(reports_auto, "tick", lambda now, log: None, raising=False)
    yield
    cache.clear()


@pytest.fixture
def fake(monkeypatch):
    client = FakeClient()
    monkeypatch.setattr(engine, "broker_client", lambda: client)
    return client


def switch(fake: FakeClient, **open_):
    """장 열림·닫힘을 바꾸고 장 달력·시세 캐시를 비운다. switch(fake, KR=False)."""
    fake.open.update(open_)
    fake.ended -= set(open_)
    cache.clear()


def set_price(fake: FakeClient, symbol: str, price: float):
    fake.price[symbol] = price
    cache.clear()


def backdate_fills(days: int = 2) -> None:
    """보유 주문의 체결 시각을 days일 앞당긴다 → 직전 장마감 종가보다 먼저 산 보유가 되어 종가로 평가된다 (priceBasis close).
    그 종가 뒤에 산 보유(오늘 산 종목)는 체결가로 평가한다 (docs/API.md "장마감 기준", test_today_fill_e2efix.py)."""
    PaperOrder.objects.filter(status="EXIT_WATCHING").update(filled_at=F("filled_at") - timedelta(days=days))


CSAT_OPEN = datetime(2026, 11, 19, 10, tzinfo=KST)  # 2026-11-19 수능일: KRX 정규장 10:00~16:30


def csat_candles(client, live: dict):
    """수능일 일봉을 주는 daily_candles (client.now 기준): 17·18일 봉, 19일 개장 뒤에는 오늘 봉 (종가 = live[종목], 장중에 바뀐다).
    17·18일 종가는 기준 가격(client.price)의 97%·100%."""
    def daily_candles(symbol, count=200):
        client._hit("daily_candles")
        base = client.price[symbol]
        rows = [("2026-11-17", base * 0.97), ("2026-11-18", base)]
        if client.now >= CSAT_OPEN:
            rows.append(("2026-11-19", live[symbol]))
        return [{"timestamp": f"{day}T00:00:00+09:00", "openPrice": f"{base:g}", "highPrice": f"{max(base, c):g}",
                 "lowPrice": f"{min(base, c):g}", "closePrice": f"{c:g}", "volume": "1000"} for day, c in rows][-count:]
    return daily_candles


@pytest.fixture
def user(django_user_model):
    return django_user_model.objects.create_user("alice", password="pw-alice-1234")


@pytest.fixture
def api(user):
    client = APIClient()
    client.force_login(user)
    return client


def login(django_user_model, username: str) -> tuple:
    u = django_user_model.objects.create_user(username, password=f"pw-{username}-1234")
    client = APIClient()
    client.force_login(u)
    return u, client
