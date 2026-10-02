"""닉네임에 보이지 않는 문자를 못 쓰는지, 로그인 시도 횟수를 제한하는지."""
import pytest
from django.core.cache import cache
from django.test import Client
from rest_framework.throttling import SimpleRateThrottle

from accounts.models import NICKNAME_BAD_CHARS, NICKNAME_TAKEN, profile_of

pytestmark = pytest.mark.django_db
JSON = "application/json"


@pytest.fixture
def alice(django_user_model):
    return django_user_model.objects.create_user(username="alice", password="Test-pass-9x")


def patch_profile(client, data):
    return client.patch("/api/me/profile", data, content_type=JSON)


@pytest.mark.parametrize("nickname", [
    "alice​",      # 폭 없는 공백: 화면에는 "alice"로 보인다
    "al‮ice",      # 오른쪽→왼쪽 방향 바꿈
    "앨\n리스",          # 줄 바꿈
    "앨\u0000리스",      # 제어 문자
])
def test_nickname_rejects_invisible_characters(client, django_user_model, alice, nickname):
    bob = django_user_model.objects.create_user(username="bob", password="Test-pass-9x")
    client.force_login(bob)
    response = patch_profile(client, {"nickname": nickname})
    assert response.status_code == 400 and response.json() == {"detail": NICKNAME_BAD_CHARS}
    assert profile_of(bob).nickname == "bob"


def test_nickname_is_normalized_before_duplicate_check(client, django_user_model, alice):
    """전각 문자는 보통 문자로 바꿔 저장하고, 그렇게 바꾼 값으로 중복을 본다."""
    bob = django_user_model.objects.create_user(username="bob", password="Test-pass-9x")
    client.force_login(bob)
    assert patch_profile(client, {"nickname": "ｔｒａｄｅｒ"}).json()["nickname"] == "trader"
    response = patch_profile(client, {"nickname": "ａｌｉｃｅ"})  # 전각으로 쓴 다른 사람의 아이디
    assert response.status_code == 400 and response.json() == {"detail": NICKNAME_TAKEN}


def test_login_attempts_are_throttled(alice, monkeypatch):
    monkeypatch.setattr(SimpleRateThrottle, "THROTTLE_RATES", {"login": "3/min"})
    cache.clear()
    browser = Client(enforce_csrf_checks=True)
    browser.get("/api/auth/csrf")

    def attempt(password):
        return browser.post("/api/auth/login", {"username": "alice", "password": password}, content_type=JSON,
                            headers={"X-CSRFToken": browser.cookies["csrftoken"].value})
    assert [attempt("wrong").status_code for _ in range(3)] == [400, 400, 400]
    blocked = attempt("Test-pass-9x")  # 맞는 비밀번호여도 제한 중에는 막는다
    assert blocked.status_code == 429 and "요청이 너무 많습니다" in blocked.json()["detail"]
    assert int(blocked["Retry-After"]) > 0
    cache.clear()
    assert attempt("Test-pass-9x").status_code == 200
