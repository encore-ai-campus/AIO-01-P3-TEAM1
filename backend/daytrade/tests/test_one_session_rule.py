"""단타 진입 세션 판정은 하나다 (docs/API.md "단타 연습" 세션 규칙): trading.market.day_entry_open.

상태의 acceptingPlans(daytrade.session) · 리스크 점검의 day_entry_closed(autotrade.risk) · style day 주문 접수(trading.service)가
같은 시각에 같은 답을 낸다. 시각은 clock fixture로 고정한다 (2026-10-09(금)은 한글날, 2026-09-19는 토요일).
"""
import pytest
from autotrade import risk
from paper_engine.agents.executor import DAY_CLOSE_AT
from trading import market
from trading import service as trading
from trading.models import PaperOrder
from trading.store import account_for

from daytrade.session import cutoff_at, session

from .conftest import at

pytestmark = pytest.mark.django_db

CASES = [
    ("2026-09-22T00:00", True),     # 국내 거래일 0시 (UTC로는 전날 15:00)
    ("2026-09-22T00:30", True),
    ("2026-09-22T10:00", True),
    ("2026-09-22T15:14:59", True),
    ("2026-09-22T15:15", False),    # 엔진 DAY_CLOSE_AT부터는 받지 않는다
    ("2026-09-22T23:59", False),
    ("2026-09-19T10:00", False),    # 토요일
    ("2026-10-09T10:00", False),    # 한글날 (장 달력이 안다)
]


def risk_closed(user, now) -> bool:
    found = risk.evaluate(user, symbol="005930", name="삼성전자", market="KR", currency="KRW", entry=69000,
                          target=80000, stop=66000, holding_days=1, horizon="DAY", now=now)
    return "day_entry_closed" in found["reasonCodes"]


def day_order(user, now):
    return trading.buy(account_for(user), "alice", "005930", 1, trading.LIMIT, 69000.0, 80000.0, 66000.0, None, now,
                       style="day")


@pytest.mark.parametrize("text, accepting", CASES)
def test_status_risk_and_order_intake_agree(clock, user, unlocked, text, accepting):
    now = clock(text)
    assert market.day_entry_open(now) is accepting
    assert session(now)["acceptingPlans"] is accepting
    assert risk_closed(user, now) is (not accepting)
    if accepting:
        assert day_order(user, now)["order"]["style"] == "day"
    else:
        with pytest.raises(trading.Rejected, match="단타 진입 마감"):
            day_order(user, now)
        assert not PaperOrder.objects.exists()


def test_without_calendar_only_weekends_are_skipped_everywhere(clock, user, unlocked):
    clock.client.calendar_fails = True
    holiday = clock("2026-10-09T10:00")  # 장 달력이 없으면 공휴일을 모른다 → 평일이라 받는다
    assert market.day_entry_open(holiday) and session(holiday)["acceptingPlans"] and not risk_closed(user, holiday)
    saturday = clock("2026-09-19T10:00")
    assert not market.day_entry_open(saturday) and not session(saturday)["acceptingPlans"]
    assert risk_closed(user, saturday)


def test_cutoff_is_the_engine_constant():
    assert cutoff_at is market.day_entry_cutoff
    assert market.day_entry_cutoff(at("2026-09-22T10:00").date()) == at("2026-09-22T15:15")
    assert f"{DAY_CLOSE_AT:%H:%M}" == "15:15"
    assert f"{DAY_CLOSE_AT:%H:%M}" in risk.DAY_ENTRY_CLOSED and f"{DAY_CLOSE_AT:%H:%M}" in trading.DAY_ENTRY_CLOSED
