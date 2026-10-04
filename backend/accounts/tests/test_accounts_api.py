"""계정 API (docs/API.md "계정"): csrf → login → me → profile → logout."""
import pytest
from django.test import Client

from accounts.models import profile_of

pytestmark = pytest.mark.django_db

PASSWORD = "Test-pass-9x"
LOGIN_FAILED = "아이디 또는 비밀번호가 올바르지 않습니다."


@pytest.fixture
def alice(django_user_model):
    return django_user_model.objects.create_user(username="alice", password=PASSWORD)


@pytest.fixture
def browser():
    """실제 브라우저처럼 CSRF를 검사하는 클라이언트 (기본 테스트 클라이언트는 CSRF 검사를 끈다)."""
    return Client(enforce_csrf_checks=True)


def csrf_header(client) -> dict:
    """프론트처럼 요청할 때마다 csrftoken 쿠키 값을 읽어 헤더에 넣는다."""
    return {"X-CSRFToken": client.cookies["csrftoken"].value}


def post(client, url, data=None):
    return client.post(url, data or {}, content_type="application/json", headers=csrf_header(client))


def patch(client, data):
    return client.patch("/api/me/profile", data, content_type="application/json", headers=csrf_header(client))


def logged_in(client, user):
    client.force_login(user)
    client.get("/api/auth/csrf")
    return client


def assert_detail(response, status, detail=None):
    assert response.status_code == status
    body = response.json()
    assert set(body) == {"detail"}
    assert isinstance(body["detail"], str) and body["detail"]
    if detail is not None:
        assert body["detail"] == detail


def test_csrf_sets_cookie(browser):
    response = browser.get("/api/auth/csrf")
    assert response.status_code == 200
    assert isinstance(response.json()["csrfToken"], str)
    assert response.cookies["csrftoken"].value


def test_full_flow(browser, alice):
    token = browser.get("/api/auth/csrf").json()["csrfToken"]
    response = browser.post("/api/auth/login", {"username": "alice", "password": PASSWORD},
                            content_type="application/json", headers={"X-CSRFToken": token})
    assert response.status_code == 200
    assert response.json() == {"id": alice.pk, "username": "alice", "nickname": "alice",
                               "isPublic": False, "isStaff": False, "beginnerMode": True}

    response = browser.get("/api/auth/me")
    assert response.status_code == 200
    assert response.json()["username"] == "alice"

    response = patch(browser, {"isPublic": True})  # 로그인하면 csrftoken이 바뀐다 → 쿠키에서 다시 읽는다
    assert response.status_code == 200
    assert response.json()["isPublic"] is True
    response = patch(browser, {"nickname": "  앨리스  "})
    assert response.status_code == 200
    assert response.json() == {"id": alice.pk, "username": "alice", "nickname": "앨리스",
                               "isPublic": True, "isStaff": False, "beginnerMode": True}
    profile = profile_of(alice)
    assert (profile.nickname, profile.is_public) == ("앨리스", True)

    response = post(browser, "/api/auth/logout")
    assert response.status_code == 204
    assert_detail(browser.get("/api/auth/me"), 401, "로그인이 필요합니다.")


def test_login_requires_csrf(browser, alice):
    response = browser.post("/api/auth/login", {"username": "alice", "password": PASSWORD},
                            content_type="application/json")
    assert_detail(response, 403)
    browser.get("/api/auth/csrf")
    response = browser.post("/api/auth/login", {"username": "alice", "password": PASSWORD},
                            content_type="application/json", headers={"X-CSRFToken": "wrong" * 8})
    assert_detail(response, 403)
    assert_detail(browser.get("/api/auth/me"), 401)


@pytest.mark.parametrize("username, password", [("alice", "wrong-password"), ("nobody", PASSWORD), ("ALICE", PASSWORD)])
def test_login_wrong_credentials(browser, alice, username, password):
    browser.get("/api/auth/csrf")
    response = post(browser, "/api/auth/login", {"username": username, "password": password})
    assert_detail(response, 400, LOGIN_FAILED)
    assert_detail(browser.get("/api/auth/me"), 401)


def test_login_inactive_user_same_message(browser, alice):
    alice.is_active = False
    alice.save()
    browser.get("/api/auth/csrf")
    assert_detail(post(browser, "/api/auth/login", {"username": "alice", "password": PASSWORD}), 400, LOGIN_FAILED)


@pytest.mark.parametrize("data", [{}, {"username": "alice"}, {"username": "alice", "password": 123},
                                  {"username": ["alice"], "password": PASSWORD}])
def test_login_bad_body(browser, alice, data):
    browser.get("/api/auth/csrf")
    assert_detail(post(browser, "/api/auth/login", data), 400)


def test_login_non_object_body(browser, alice):
    browser.get("/api/auth/csrf")
    assert_detail(post(browser, "/api/auth/login", ["alice", PASSWORD]), 400)


def test_staff_flag(client, django_user_model):
    staff = django_user_model.objects.create_user(username="boss", password=PASSWORD, is_staff=True)
    client.force_login(staff)
    assert client.get("/api/auth/me").json()["isStaff"] is True


@pytest.mark.parametrize("method, url", [("get", "/api/auth/me"), ("post", "/api/auth/logout"),
                                         ("patch", "/api/me/profile")])
def test_login_required(client, method, url):
    response = getattr(client, method)(url, content_type="application/json")
    assert_detail(response, 401, "로그인이 필요합니다.")


def test_profile_patch_requires_csrf(browser, alice):
    logged_in(browser, alice)
    response = browser.patch("/api/me/profile", {"isPublic": True}, content_type="application/json")
    assert_detail(response, 403)
    assert profile_of(alice).is_public is False


def test_profile_empty_patch_changes_nothing(browser, alice):
    logged_in(browser, alice)
    response = patch(browser, {})
    assert response.status_code == 200
    assert response.json()["nickname"] == "alice"
    assert response.json()["isPublic"] is False


def test_profile_toggle_public(browser, alice):
    logged_in(browser, alice)
    assert patch(browser, {"isPublic": True}).json()["isPublic"] is True
    assert patch(browser, {"isPublic": False}).json()["isPublic"] is False
    assert profile_of(alice).is_public is False


@pytest.mark.parametrize("nickname", ["a", " a ", "", "   ", "열세글자가넘는닉네임입니다", "x" * 13])
def test_profile_nickname_length(browser, alice, nickname):
    logged_in(browser, alice)
    assert_detail(patch(browser, {"nickname": nickname}), 400, "닉네임은 2~12자여야 합니다.")
    assert profile_of(alice).nickname == "alice"


def test_profile_nickname_bounds_ok(browser, alice):
    logged_in(browser, alice)
    assert patch(browser, {"nickname": "ab"}).json()["nickname"] == "ab"
    assert patch(browser, {"nickname": "x" * 12}).json()["nickname"] == "x" * 12


def test_profile_nickname_taken(browser, alice, django_user_model):
    bob = django_user_model.objects.create_user(username="bob", password=PASSWORD)
    carol = django_user_model.objects.create_user(username="carol", password=PASSWORD)
    profile = profile_of(carol)
    profile.nickname = "Cat"
    profile.save()
    logged_in(browser, alice)
    for nickname in ("cat", "CAT", "Bob", "bob", "carol"):  # 다른 사람의 닉네임·아이디 (대소문자 무시)
        assert_detail(patch(browser, {"nickname": nickname}), 400, "이미 쓰는 닉네임입니다.")
    assert profile_of(alice).nickname == "alice"
    assert profile_of(bob).nickname == "bob"
    # 내 아이디·닉네임으로는 바꿀 수 있다
    assert patch(browser, {"nickname": "ALICE"}).json()["nickname"] == "ALICE"
    assert patch(browser, {"nickname": "alice"}).json()["nickname"] == "alice"


@pytest.mark.parametrize("data", [
    {"isPublic": "true"}, {"isPublic": 1}, {"isPublic": None},
    {"nickname": 123}, {"nickname": None}, {"nickname": ["alice2"]},
    {"unknown": 1}, {"isPublic": True, "is_public": True},
])
def test_profile_bad_input(browser, alice, data):
    logged_in(browser, alice)
    assert_detail(patch(browser, data), 400)
    profile = profile_of(alice)
    assert (profile.nickname, profile.is_public) == ("alice", False)


def test_profile_non_object_body(browser, alice):
    logged_in(browser, alice)
    assert_detail(patch(browser, [{"isPublic": True}]), 400)


def test_profile_invalid_nickname_does_not_apply_other_fields(browser, alice):
    logged_in(browser, alice)
    assert_detail(patch(browser, {"isPublic": True, "nickname": "a"}), 400)
    assert profile_of(alice).is_public is False
