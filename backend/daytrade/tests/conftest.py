"""daytrade 테스트 공용. trading 테스트의 가짜 조회 클라이언트·엔진 설정·로그인 fixture를 그대로 쓰고,
지금 시각을 고정한다 (django.utils.timezone.now — KST로 적고 UTC로 바뀌는 날짜 경계를 같이 본다).

장 달력은 엔진 MarketCalendar(공휴일 키 없음 — 주말·양력 고정 공휴일만)로 그 시각 기준으로 만든다.
날짜는 공휴일이 없는 2026-09-14 ~ 2026-09-22와 양력 고정 공휴일 2026-10-09(금, 한글날)를 쓴다.
실제 증권사·AI·Discord를 부르지 않는다.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta

import pytest
from accounts.models import InvestorProfile
from autotrade import executor, risk, sources
from autotrade.models import Recommendation, TradePlan
from django.utils import timezone
from notifications import service as notices
from paper_engine.data.calendar import MarketCalendar
from trading import market
from trading.tests.conftest import KST, FakeClient, api, engine_setup, login  # noqa: F401

from config import engine

__all__ = ["KST", "login", "at", "unlock", "APPROVED"]
CALENDARS = MarketCalendar()  # 공휴일 키 없음 경고를 한 번만 남기게 모든 테스트가 같이 쓴다


def at(text: str) -> datetime:
    """"2026-09-22T10:00" → KST 시각."""
    return datetime.fromisoformat(text).replace(tzinfo=KST)


class DayClient(FakeClient):
    """지금 시각(now) 기준 장 달력과, now까지의 평일 일봉 5개(종가 = 기준 가격 × 0.96·0.97·0.98·0.99·1.0)."""

    def __init__(self, now: datetime):
        super().__init__()
        self.now = now
        self.calendars = CALENDARS
        self.calendar_fails = False

    def market_calendar(self, market_):
        self._hit("market_calendar")
        if self.calendar_fails:
            raise OSError("장 달력 조회 실패")
        return self.calendars.calendar(market_, self.now)

    def daily_candles(self, symbol, count=200):
        self._hit("daily_candles")
        day, days = self.now.astimezone(KST).date(), []
        while len(days) < 5:
            if day.weekday() < 5:
                days.append(day)
            day -= timedelta(days=1)
        base = self.price[symbol]
        return [{"timestamp": f"{d}T00:00:00+09:00", "openPrice": f"{base:g}", "highPrice": f"{base:g}",
                 "lowPrice": f"{base:g}", "closePrice": f"{base * rate:g}", "volume": "1000"}
                for d, rate in zip(reversed(days), (0.96, 0.97, 0.98, 0.99, 1.0))][-count:]


@pytest.fixture
def clock(monkeypatch):
    """clock("2026-09-22T10:00") — 지금 시각을 KST로 고정하고 시세·장 달력 캐시를 비운다. clock.client는 가짜 조회 클라이언트."""
    state = {}
    monkeypatch.setattr(timezone, "now", lambda: state["now"])

    def set_now(text: str) -> datetime:
        state["now"] = at(text)
        set_now.client.now = state["now"]
        market.cache.clear()  # 장 달력·일봉·시세 캐시
        return state["now"]

    set_now.client = DayClient(at("2026-09-22T10:00"))
    monkeypatch.setattr(engine, "broker_client", lambda: set_now.client)
    set_now("2026-09-22T10:00")
    return set_now


@pytest.fixture
def user(django_user_model):
    """로그인한 팀원 alice (trading 테스트의 api fixture가 이 사용자로 로그인한다)."""
    return django_user_model.objects.create_user("alice", password="pw-alice-1234")


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    """알림을 보내지 않는다 (executor는 커밋 뒤에 알리고, 테스트는 커밋하지 않는다 — 혹시 불려도 아무것도 하지 않게)."""
    monkeypatch.setattr(notices, "notify", lambda *args, **kwargs: [])


def unlock(user) -> InvestorProfile:
    """주린이모드 끔 + 단타 연습 퀴즈 통과 = 단타 연습장 열림."""
    profile, _ = InvestorProfile.objects.update_or_create(
        user=user, defaults={"beginner_mode": False, "day_quiz_passed_at": at("2026-09-01T12:00")})
    return profile


@pytest.fixture
def unlocked(user):
    return unlock(user)


# --- autotrade 접점의 가짜 (risk.evaluate · sources.create · executor.activate — 단타 쪽이 무엇을 넘기는지 기록한다) ---

APPROVED = {
    "approved": True, "activatable": True, "reasons": [], "reasonCodes": [], "quantity": 40,
    "amountKrw": 40 * 69000.0, "expectedProfitKrw": 400000.0, "maxLossKrw": 120000.0, "limitedBy": "건당 위험 한도",
    "budgetKrw": None, "lastPrice": 69300.0, "lastPriceAsOf": "2026-09-21T15:30:00+09:00", "priceBasis": "close",
}


@dataclass
class Fakes:
    """risk.evaluate·sources.create·executor.activate 기록기. result는 evaluate가 돌려줄 RiskPreview, block은 activate가 낼 예외."""
    result: dict = field(default_factory=lambda: dict(APPROVED))
    block: Exception | None = None
    evaluated: list[dict] = field(default_factory=list)
    created: list[dict] = field(default_factory=list)
    activated: list[dict] = field(default_factory=list)

    def evaluate(self, user, **kwargs):
        self.evaluated.append({"user": user, **kwargs})
        return dict(self.result)

    def create(self, source, **kwargs):
        self.created.append({"source": source, **kwargs})
        now = kwargs["now"]
        return Recommendation.objects.create(
            source=source, requested_by=kwargs["requested_by"], symbol=kwargs["symbol"], name=kwargs["name"],
            market=kwargs["market_"], currency="KRW", price_at_creation=69300.0, entry_price=kwargs["entry"],
            target_price=kwargs["target"], stop_price=kwargs["stop"], holding_days=kwargs["holding_days"],
            horizon=kwargs["horizon"], probability=0.5, probability_assumed=True, target_return=0.1,
            stop_loss_rate=-0.04, reward_risk=2.5, expected_return=0.02, summary=kwargs["summary"],
            valid_until=kwargs["valid_until"], created_at=now)

    def activate(self, rec, user, budget_krw=None, via="web", now=None, *, acknowledged=False):
        self.activated.append({"rec": rec, "user": user, "budget_krw": budget_krw, "via": via, "now": now,
                               "acknowledged": acknowledged})
        if self.block is not None:
            raise self.block
        return TradePlan.objects.create(
            recommendation=rec, user=user, symbol=rec.symbol, name=rec.name, market=rec.market,
            currency=rec.currency, status=TradePlan.ENTRY_PENDING, via=via, quantity=self.result["quantity"],
            budget_krw=budget_krw, entry_price=rec.entry_price, target_price=rec.target_price,
            stop_price=rec.stop_price, holding_days=rec.holding_days, horizon=rec.horizon,
            entry_deadline=rec.valid_until, activated_at=now, updated_at=now)


@pytest.fixture
def fakes(monkeypatch):
    found = Fakes()
    monkeypatch.setattr(risk, "evaluate", found.evaluate, raising=False)
    monkeypatch.setattr(sources, "create", found.create)
    monkeypatch.setattr(executor, "activate", found.activate)
    return found
