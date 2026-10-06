"""다른 앱이 읽는 주린이모드 (accounts/modes.py): 행이 없으면 기본값, beginner_modes는 쿼리 1번."""
import pytest

from accounts.models import InvestorProfile
from accounts.modes import beginner_mode_of, beginner_modes, investor_profile

pytestmark = pytest.mark.django_db

@pytest.fixture
def users(django_user_model):
    return [django_user_model.objects.create_user(username=name, password="x") for name in ("alice", "bob", "carol")]


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
    assert profile.answers is None and profile.assessed_at is None
    assert not InvestorProfile.objects.exists()

