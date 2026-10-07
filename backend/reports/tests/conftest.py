"""reports 테스트 공용: 로그인한 클라이언트, 가짜 종목 확인(증권사를 부르지 않는다), 리포트 만들기, 가짜 LLM(fake_llm)."""
import time

import pytest
from accounts.models import profile_of
from paper_engine.llm import LlmError, LlmTimeout
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


class FakeLlm:
    """가짜 LLM 클라이언트 (담당 4, docs/tasks/00-공통.md 11절). `complete_json_once`와 같은 서명이다.

    script: 모델 이름 → 호출 순서대로의 결과 목록.
      - "timeout" → LlmTimeout, "server_error" → LlmError("HTTP 503 …"), "bad_output" → LlmError("JSON 객체가 없는 응답 …")
      - dict → 그 응답 (비용은 cost)
      - {"__delay__": 초} → 그만큼 걸린 뒤 다음 항목을 이 호출의 결과로 쓴다. 제한 시간보다 길면 제한 시간만큼 걸린 뒤 LlmTimeout
    calls: 받은 호출 (model, system, user, timeout) 순서대로. 대본에 없는 모델이나 다 쓴 대본을 부르면 AssertionError.
    """

    def __init__(self, script: dict[str, list], cost: float = 0.01, sleep=time.sleep):
        self.script = {model: list(items) for model, items in script.items()}
        self.cost, self.sleep = cost, sleep
        self.calls: list[tuple[str, str, str, float]] = []

    def complete_json_once(self, model: str, system: str, user: str, timeout: float) -> tuple[dict, float]:
        self.calls.append((model, system, user, timeout))
        item = self._next(model)
        if isinstance(item, dict) and "__delay__" in item:
            delay = item["__delay__"]
            if delay >= timeout:
                self.sleep(timeout)
                raise LlmTimeout(f"{timeout}초 안에 응답 없음")
            self.sleep(delay)
            item = self._next(model)
        if item == "timeout":
            raise LlmTimeout(f"{timeout}초 안에 응답 없음")
        if item == "server_error":
            raise LlmError("HTTP 503: 가짜 서버 오류")
        if item == "bad_output":
            raise LlmError("JSON 객체가 없는 응답: '가짜 응답'")
        assert isinstance(item, dict), f"FakeLlm 대본의 항목이 잘못됨: {item!r}"
        return dict(item), self.cost

    def _next(self, model: str):
        items = self.script.get(model)
        assert items, f"FakeLlm: {model}의 대본이 없거나 다 썼습니다"
        return items.pop(0)


@pytest.fixture
def fake_llm():
    """FakeLlm 만들기: `client = fake_llm({"gemini-3.8-flash": ["timeout", {"trend": "up"}]})`."""
    return FakeLlm
