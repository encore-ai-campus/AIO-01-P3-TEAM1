"""단타 세션 규칙 (docs/API.md "단타 연습" 세션 규칙): 국내 거래일 0시 ~ 15:15 KST 전에만 계획을 받는다.

2026-09-18(금)·19(토)·21(월)·22(화)·23(수), 2026-10-09(금, 한글날 — 양력 고정 공휴일)·12(월).
"""
from datetime import date

import pytest

from daytrade.session import basis_day, cutoff_at, session

from .conftest import at


def test_trading_day_before_open_accepts(clock):
    s = session(clock("2026-09-22T08:00"))
    assert s == {"date": "2026-09-22", "acceptingPlans": True, "opensAt": "2026-09-22T09:00:00+09:00",
                 "entryCutoffAt": "2026-09-22T15:15:00+09:00", "closeAt": "2026-09-22T15:30:00+09:00",
                 "isOpen": False}


def test_kst_midnight_is_already_the_new_session(clock):
    # 2026-09-22 00:00 KST = 2026-09-21 15:00 UTC. UTC 날짜(21일)가 아니라 KST 날짜(22일)의 세션이다
    s = session(clock("2026-09-22T00:00"))
    assert s["acceptingPlans"] and s["date"] == "2026-09-22" and not s["isOpen"]
    assert s["entryCutoffAt"] == "2026-09-22T15:15:00+09:00"


def test_during_session_is_open(clock):
    s = session(clock("2026-09-22T10:00"))
    assert s["acceptingPlans"] and s["isOpen"] and s["date"] == "2026-09-22"


@pytest.mark.parametrize("now", ["2026-09-22T15:15", "2026-09-22T15:29"])
def test_from_cutoff_plans_go_to_next_trading_day(clock, now):
    s = session(clock(now))
    assert not s["acceptingPlans"] and s["isOpen"]  # 15:15~15:30은 아직 정규장이지만 새 단타는 받지 않는다
    assert s["date"] == "2026-09-23" and s["entryCutoffAt"] == "2026-09-23T15:15:00+09:00"
    assert s["opensAt"] == "2026-09-23T09:00:00+09:00" and s["closeAt"] == "2026-09-23T15:30:00+09:00"


def test_one_minute_before_cutoff_still_accepts(clock):
    assert session(clock("2026-09-22T15:14:59"))["acceptingPlans"]


def test_friday_evening_and_weekend_point_to_monday(clock):
    friday = session(clock("2026-09-18T16:00"))
    assert not friday["acceptingPlans"] and not friday["isOpen"] and friday["date"] == "2026-09-21"
    saturday = session(clock("2026-09-19T10:00"))
    assert not saturday["acceptingPlans"] and not saturday["isOpen"] and saturday["date"] == "2026-09-21"


def test_holiday_is_not_a_trading_day(clock):
    s = session(clock("2026-10-09T10:00"))  # 한글날 (금)
    assert not s["acceptingPlans"] and not s["isOpen"] and s["date"] == "2026-10-12"


def test_without_calendar_only_weekends_are_skipped(clock):
    clock.client.calendar_fails = True
    s = session(clock("2026-10-09T10:00"))  # 장 달력이 없으면 공휴일을 모른다 → 평일이라 받는다
    assert s["acceptingPlans"] and s["isOpen"] and s["date"] == "2026-10-09"
    assert s["opensAt"] == "2026-10-09T09:00:00+09:00" and s["closeAt"] == "2026-10-09T15:30:00+09:00"
    s = session(clock("2026-09-19T10:00"))
    assert not s["acceptingPlans"] and s["date"] == "2026-09-21"
    s = session(clock("2026-09-22T15:20"))
    assert not s["acceptingPlans"] and s["isOpen"] and s["date"] == "2026-09-23"


def test_cutoff_at_is_kst():
    assert cutoff_at(date(2026, 9, 22)) == at("2026-09-22T15:15")
    assert cutoff_at(date(2026, 9, 22)).isoformat() == "2026-09-22T15:15:00+09:00"


@pytest.mark.parametrize("fails", [False, True])
def test_basis_day(clock, fails):
    clock.client.calendar_fails = fails  # 장 달력이 없어도 평일 15:40 규칙으로 같은 날을 고른다
    assert basis_day(clock("2026-09-22T15:39")) == date(2026, 9, 21)
    assert basis_day(clock("2026-09-22T15:40")) == date(2026, 9, 22)
    assert basis_day(clock("2026-09-22T00:30")) == date(2026, 9, 21)
    assert basis_day(clock("2026-09-19T12:00")) == date(2026, 9, 18)
    assert basis_day(clock("2026-09-21T09:00")) == date(2026, 9, 18)
