"""reports 테스트 공용: 로그인한 클라이언트, 가짜 종목·Worker, 리포트 만들기."""
import time

import pytest
from accounts.models import profile_of
from trading import market

from config.api import Unavailable
from reports.models import Report

STOCKS = {
    "005930": {"symbol": "005930", "name": "삼성전자", "exchange": "KOSPI", "market": "KR"},
    "AAPL": {"symbol": "AAPL", "name": "Apple", "exchange": "NASDAQ", "market": "US"},
}


class FakeWorker:
    """Orchestrator가 WorkerContext를 올바르게 만드는지 확인하는 가짜 Worker."""

    def __init__(self, worker_id, result=None, error=None, delay=0, calls=None, output_contract=None):
        self.id = worker_id
        self.output_contract = output_contract or {
            "market_agent": "MarketResult",
            "fundamental_agent": "FundamentalResult",
            "news_agent": "NewsResult",
            "report_agent": "ReportDraft",
            "review_agent": "ReviewResult",
            "risk_agent": "RiskResult",
        }.get(worker_id, "FakeResult")
        self.result = {} if result is None else result
        self.error = error
        self.delay = delay
        self.calls = [] if calls is None else calls

    def run(self, ctx):
        self.calls.append(ctx)
        if self.delay:
            time.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return self.result


@pytest.fixture
def fake_worker():
    return FakeWorker


@pytest.fixture
def user(django_user_model):
    user = django_user_model.objects.create_user(username="alice", password="pw-alice-123")
    profile = profile_of(user)
    profile.nickname = "앨리스"
    profile.save()
    return user


@pytest.fixture
def other(django_user_model):
    return django_user_model.objects.create_user(username="bob", password="pw-bob-123")  # 닉네임은 기본값(아이디)


@pytest.fixture
def api(client, user):
    client.force_login(user)
    return client


@pytest.fixture
def stocks(monkeypatch):
    """trading.market.stock_item을 가짜로. broker_ready=False로 바꾸면 증권사 조회 불가(503)."""
    fake = {"broker_ready": True, "calls": []}

    def stock_item(symbol):
        fake["calls"].append(symbol)
        if not fake["broker_ready"]:
            raise Unavailable("증권사 조회 키가 없어 시세를 조회할 수 없습니다.")
        return STOCKS.get(symbol.strip().upper())
    monkeypatch.setattr(market, "stock_item", stock_item)
    return fake


def make_report(user, symbol="005930", **fields) -> Report:
    stock = STOCKS[symbol]
    return Report.objects.create(user=user, symbol=symbol, name=stock["name"], market=stock["market"], **fields)
