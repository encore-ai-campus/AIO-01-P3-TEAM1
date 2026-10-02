"""사용자를 만들면 프로필이 자동으로 생긴다. 기본 닉네임은 아이디이고 겹치면 겹치지 않게 만든다."""
import pytest
from django.db import IntegrityError, transaction

from accounts.models import NICKNAME_MAX, NICKNAME_MIN, Profile, profile_of

pytestmark = pytest.mark.django_db


def nicknames():
    return [nickname.lower() for nickname in Profile.objects.values_list("nickname", flat=True)]


def test_profile_created_with_user(django_user_model):
    user = django_user_model.objects.create_user(username="alice", password="x")
    profile = Profile.objects.get(user=user)
    assert (profile.nickname, profile.is_public) == ("alice", False)
    assert profile_of(user) == profile
    assert Profile.objects.count() == 1


def test_superuser_gets_profile(django_user_model):
    user = django_user_model.objects.create_superuser(username="root", password="x")
    assert profile_of(user).nickname == "root"


def test_long_username_truncated(django_user_model):
    user = django_user_model.objects.create_user(username="a-very-long-username", password="x")
    assert profile_of(user).nickname == "a-very-long-"


def test_short_username_padded(django_user_model):
    nickname = profile_of(django_user_model.objects.create_user(username="a", password="x")).nickname
    assert NICKNAME_MIN <= len(nickname) <= NICKNAME_MAX
    assert nickname.startswith("a")


def test_default_nickname_avoids_taken(django_user_model):
    bob = django_user_model.objects.create_user(username="bob", password="x")
    profile = profile_of(bob)
    profile.nickname = "Carol"
    profile.save()
    carol = django_user_model.objects.create_user(username="carol", password="x")  # "Carol"은 bob의 닉네임
    assert profile_of(carol).nickname.lower() != "carol"
    upper = django_user_model.objects.create_user(username="BOB", password="x")  # "bob"은 다른 사람의 아이디
    assert profile_of(upper).nickname.lower() != "bob"
    assert len(set(nicknames())) == Profile.objects.count() == 3


def test_default_nickname_truncated_collision(django_user_model):
    users = [django_user_model.objects.create_user(username=f"same-prefix-1234-{i}", password="x") for i in range(3)]
    names = [profile_of(user).nickname for user in users]
    assert all(NICKNAME_MIN <= len(name) <= NICKNAME_MAX for name in names)
    assert len({name.lower() for name in names}) == 3


def test_profile_of_recreates_missing_profile(django_user_model):
    user = django_user_model.objects.create_user(username="alice", password="x")
    Profile.objects.filter(user=user).delete()
    user = django_user_model.objects.get(pk=user.pk)
    assert profile_of(user).nickname == "alice"
    assert Profile.objects.filter(user=user).count() == 1


def test_nickname_unique_ignores_case_in_db(django_user_model):
    alice = django_user_model.objects.create_user(username="alice", password="x")
    bob = django_user_model.objects.create_user(username="bob", password="x")
    profile_of(alice)
    profile = profile_of(bob)
    profile.nickname = "ALICE"
    with pytest.raises(IntegrityError), transaction.atomic():
        profile.save()


def test_admin_pages(admin_client, django_user_model):
    user = django_user_model.objects.create_user(username="alice", password="x")
    assert admin_client.get("/admin/auth/user/").status_code == 200
    assert admin_client.get("/admin/auth/user/add/").status_code == 200
    response = admin_client.get(f"/admin/auth/user/{user.pk}/change/")
    assert response.status_code == 200
    assert "nickname" in response.content.decode()
    assert admin_client.get("/admin/accounts/profile/").status_code == 200
    profile = profile_of(user)
    assert admin_client.get(f"/admin/accounts/profile/{profile.pk}/change/").status_code == 200
    assert admin_client.get("/admin/accounts/profile/add/").status_code == 403


def test_admin_created_user_gets_profile(admin_client, django_user_model):
    response = admin_client.post("/admin/auth/user/add/", {
        "username": "newbie", "usable_password": "true", "password1": "Zq7-admin-pass", "password2": "Zq7-admin-pass",
    })
    assert response.status_code == 302
    user = django_user_model.objects.get(username="newbie")
    assert profile_of(user).nickname == "newbie"


def test_admin_profile_form_rules(admin_client, django_user_model):
    alice = django_user_model.objects.create_user(username="alice", password="x")
    django_user_model.objects.create_user(username="bob", password="x")
    profile = profile_of(alice)
    url = f"/admin/accounts/profile/{profile.pk}/change/"
    response = admin_client.post(url, {"nickname": "BOB", "is_public": "on"})
    assert response.status_code == 200  # 폼 오류로 다시 보여 준다
    assert "이미 쓰는 닉네임입니다." in response.content.decode()
    response = admin_client.post(url, {"nickname": " 앨리스 ", "is_public": "on"})
    assert response.status_code == 302
    profile.refresh_from_db()
    assert (profile.nickname, profile.is_public) == ("앨리스", True)
