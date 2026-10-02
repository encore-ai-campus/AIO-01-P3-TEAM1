"""reports 테스트 공용: 로그인한 클라이언트, 가짜 종목 확인(증권사를 부르지 않는다), 리포트 만들기."""
import pytest
from accounts.models import profile_of
from trading import market

from config.api import Unavailable
from reports.models import Report

STOCKS = {
    "005930": {"symbol": "005930", "name": "삼성전자", "exchange": "KOSPI", "market": "KR"},
    "AAPL": {"symbol": "AAPL", "name": "Apple", "exchange": "NASDAQ", "market": "US"},
}


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
