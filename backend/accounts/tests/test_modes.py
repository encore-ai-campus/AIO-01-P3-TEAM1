"""다른 앱이 읽는 주린이모드·단타 잠금 (accounts/modes.py): 행이 없으면 기본값, beginner_modes는 쿼리 1번."""
from datetime import UTC, datetime

import pytest

from accounts.models import InvestorProfile
from accounts.modes import (LOCK_BEGINNER_MODE, LOCK_QUIZ_NOT_PASSED, beginner_mode_of, beginner_modes, day_trading_lock,
                            investor_profile, lock_reasons)

pytestmark = pytest.mark.django_db

PASSED = datetime(2026, 10, 5, 0, 30, tzinfo=UTC)


@pytest.fixture
def users(django_user_model):
    return [django_user_model.objects.create_user(username=name, password="x") for name in ("alice", "bob", "carol")]


def test_codes_match_contract():
    assert (LOCK_BEGINNER_MODE, LOCK_QUIZ_NOT_PASSED) == ("beginner_mode", "quiz_not_passed")


def test_beginner_modes_one_query(users, django_assert_num_queries):
    alice, bob, carol = users
    InvestorProfile.objects.create(user=alice, beginner_mode=False)
    InvestorProfile.objects.create(user=bob, beginner_mode=True)
    with django_assert_num_queries(1):
        modes = beginner_modes([alice.pk, bob.pk, carol.pk])
    assert modes == {alice.pk: False, bob.pk: True, carol.pk: True}  # carol은 행 없음 → True


def test_beginner_modes_empty_and_duplicates(users, django_assert_num_queries):
    alice = users[0]
    with django_assert_num_queries(0):
        assert beginner_modes([]) == {}
    InvestorProfile.objects.create(user=alice, beginner_mode=False)
    with django_assert_num_queries(1):
        assert beginner_modes(iter([alice.pk, alice.pk])) == {alice.pk: False}


def test_beginner_modes_unknown_id_defaults_true(users):
    assert beginner_modes([999_999]) == {999_999: True}


def test_beginner_mode_of(users, django_assert_num_queries):
    alice, bob, _ = users
    InvestorProfile.objects.create(user=alice, beginner_mode=False)
    with django_assert_num_queries(1):
        assert beginner_mode_of(alice) is False
    assert beginner_mode_of(bob) is True
    assert not InvestorProfile.objects.filter(user=bob).exists()  # 읽기만으로는 행을 만들지 않는다


def test_investor_profile_default_is_unsaved(users):
    profile = investor_profile(users[0])
    assert profile.pk is None and profile.beginner_mode is True
    assert profile.answers is None and profile.day_quiz_passed_at is None
    assert not InvestorProfile.objects.exists()


@pytest.mark.parametrize("row, expected", [
    (None, ["beginner_mode", "quiz_not_passed"]),                                  # 행 없음 = 켬 · 퀴즈 전
    ({"beginner_mode": True}, ["beginner_mode", "quiz_not_passed"]),
    ({"beginner_mode": False}, ["quiz_not_passed"]),
    ({"beginner_mode": True, "day_quiz_passed_at": PASSED}, ["beginner_mode"]),
    ({"beginner_mode": False, "day_quiz_passed_at": PASSED}, []),                  # 열림
])
def test_day_trading_lock(users, django_assert_num_queries, row, expected):
    alice = users[0]
    if row is not None:
        InvestorProfile.objects.create(user=alice, **row)
    with django_assert_num_queries(1):
        assert day_trading_lock(alice) == expected
    assert lock_reasons(investor_profile(alice)) == expected


def test_lock_is_per_user(users):
    alice, bob, _ = users
    InvestorProfile.objects.create(user=alice, beginner_mode=False, day_quiz_passed_at=PASSED)
    assert day_trading_lock(alice) == []
    assert day_trading_lock(bob) == ["beginner_mode", "quiz_not_passed"]
