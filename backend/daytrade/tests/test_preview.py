"""POST /api/day/preview — 잠김 400 · 입력 검사 · 리스크 엔진(DAY) 호출 · 세션 사유 · 목표·손절에서 팔 때의 비용.

리스크 엔진 계산(autotrade.risk.evaluate)은 기록기로 바꿔 끼우고, 여기서는 단타 쪽 규칙만 본다.
"""
import pytest

from daytrade.service import ENTRY_CLOSED_TEXT, LOCKED_TEXT

from .conftest import APPROVED

pytestmark = pytest.mark.django_db

BODY = {"symbol": "005930", "entryPrice": 69000, "targetPrice": 80000, "stopPrice": 66000}


def preview(api, **changes):
    return api.post("/api/day/preview", {**BODY, **changes}, format="json")


def test_locked_is_400_with_code(api, clock, fakes):
    body = preview(api)
    assert body.status_code == 400
    assert body.json()["reasonCodes"] == ["day_trading_locked"]
    assert body.json()["detail"] == LOCKED_TEXT
    assert fakes.evaluated == []


def test_preview_adds_session_and_costs(api, user, unlocked, clock, fakes):
    body = preview(api, budgetKrw=3_000_000)
    assert body.status_code == 200, body.json()
    p = body.json()
    for key, value in APPROVED.items():
        assert p[key] == value
    assert p["session"]["date"] == "2026-09-22" and p["session"]["acceptingPlans"]
    # 40주: 수수료 = (69,000 + 80,000) × 40 × 0.1%, 거래세 = 80,000 × 40 × 0.2%
    assert p["costsAtTarget"] == {"commissionKrw": pytest.approx(5960), "taxKrw": pytest.approx(6400),
                                  "totalKrw": pytest.approx(12360)}
    assert p["costsAtStop"] == {"commissionKrw": pytest.approx(5400), "taxKrw": pytest.approx(5280),
                                "totalKrw": pytest.approx(10680)}
    [call] = fakes.evaluated
    assert call["user"] == user and call["horizon"] == "DAY" and call["holding_days"] == 1
    assert (call["symbol"], call["name"], call["market"], call["currency"]) == ("005930", "삼성전자", "KR", "KRW")
    assert (call["entry"], call["target"], call["stop"]) == (69000, 80000, 66000)
    assert call["budget_krw"] == 3_000_000 and call["live_check"] is False and call["now"] == clock("2026-09-22T10:00")


def test_prices_snap_to_tick_before_checks(api, unlocked, clock, fakes):
    assert preview(api, entryPrice=69_099, targetPrice=80_050.5).status_code == 200
    call = fakes.evaluated[-1]
    assert (call["entry"], call["target"]) == (69000, 80000)  # 50,000~200,000원은 100원 단위로 내린다
    body = preview(api, entryPrice=66_050)  # 내리면 66,000 = 손절가
    assert body.status_code == 400 and "reasonCodes" not in body.json()


def test_after_cutoff_is_200_but_not_activatable(api, unlocked, clock, fakes):
    clock("2026-09-22T15:15")
    fakes.result |= {"approved": False, "activatable": False, "reasons": ["손익비 낮음"],
                     "reasonCodes": ["reward_risk_low"]}
    body = preview(api)
    assert body.status_code == 200
    p = body.json()
    assert p["activatable"] is False and p["session"]["acceptingPlans"] is False
    assert p["reasons"] == [ENTRY_CLOSED_TEXT, "손익비 낮음"]
    assert p["reasonCodes"] == ["day_entry_closed", "reward_risk_low"]
    assert p["session"]["date"] == "2026-09-23"


def test_closed_reason_from_risk_engine_is_not_repeated(api, unlocked, clock, fakes):
    clock("2026-09-22T15:30")
    fakes.result |= {"activatable": False, "reasons": ["진행 중 주문", "그 시각에는 못 만듦"],
                     "reasonCodes": ["position_exists", "day_entry_closed"]}
    p = preview(api).json()
    assert p["reasonCodes"] == ["position_exists", "day_entry_closed"]
    assert p["reasons"] == ["진행 중 주문", "그 시각에는 못 만듦"] and p["activatable"] is False


def test_weekend_preview_is_closed(api, unlocked, clock, fakes):
    clock("2026-09-19T10:00")
    p = preview(api).json()
    assert p["activatable"] is False and p["reasonCodes"] == ["day_entry_closed"]


def test_zero_quantity_costs_nothing(api, unlocked, clock, fakes):
    fakes.result |= {"approved": False, "activatable": False, "quantity": 0, "reasons": ["1주 미만"],
                     "reasonCodes": ["size_too_small"]}
    p = preview(api).json()
    assert p["costsAtTarget"]["totalKrw"] == 0 and p["costsAtStop"]["totalKrw"] == 0
    assert p["reasonCodes"] == ["size_too_small"] and p["activatable"] is False


@pytest.mark.parametrize("changes", [
    {"symbol": "AAPL", "entryPrice": 190, "targetPrice": 230, "stopPrice": 180},  # 미국 종목
    {"symbol": "999999"},  # 없는 종목
    {"symbol": ""},
    {"symbol": 5930},
    {"entryPrice": "69000"},  # 문자열
    {"entryPrice": True},
    {"entryPrice": -1},
    {"entryPrice": None},
    {"stopPrice": 70000},  # 손절가 ≥ 진입가
    {"targetPrice": 69000},  # 목표가 = 진입가
    {"budgetKrw": 0},
    {"budgetKrw": "100"},
    {"entryPrice": 10**400},  # float로 바꿀 수 없는 아주 긴 정수 (OverflowError → 500이 아니라 400)
    {"stopPrice": -10**400},
    {"budgetKrw": 10**400},
    {"acknowledged": True},  # 미리 보기에는 없는 키
    {"extra": 1},
])
def test_input_errors_are_400_without_codes(api, unlocked, clock, fakes, changes):
    body = preview(api, **changes)
    assert body.status_code == 400, body.json()
    assert set(body.json()) == {"detail"}
    assert fakes.evaluated == []


def test_missing_key_and_non_object_body(api, unlocked, clock, fakes):
    body = api.post("/api/day/preview", {"symbol": "005930", "entryPrice": 69000, "targetPrice": 80000},
                    format="json")
    assert body.status_code == 400 and "stopPrice" in body.json()["detail"]
    body = api.post("/api/day/preview", [BODY], format="json")
    assert body.status_code == 400 and set(body.json()) == {"detail"}


def test_without_broker_is_503(api, unlocked, fakes):
    assert preview(api).status_code == 503  # 종목 목록을 받지 못함
