"""투자자 프로필·주린이모드 API (docs/API.md "투자자 프로필과 주린이모드", B10): GET 기본값 · PUT 진단 · PATCH 스위치 · Me.beginnerMode."""
from datetime import UTC, datetime

import pytest
from django.test import Client
from django.utils import timezone

from accounts.assessment import ANSWERS_REQUIRED, DEPOSIT_ALONE, Q2_DUPLICATE, Q2_EMPTY
from accounts.models import InvestorProfile

pytestmark = pytest.mark.django_db

URL = "/api/me/investor-profile"
JSON = "application/json"
PASSWORD = "Test-pass-9x"
# docs/API.md의 예 (경험 1 입문, 성향 2 안정추구형, 추천 켬)
EXAMPLE = {"q1": "none", "q2": ["deposit"], "q3": "never", "q4": "heard", "q5": "loss_10", "q6": "weeks", "q7": "practice"}
# 경험 3+3+2+3 = 11 숙련, 성향 3+2+2+1 = 8 공격투자형, 추천 끔
EXPERT = {"q1": "over_3y", "q2": ["us_stock", "derivatives", "kr_stock"], "q3": "daily", "q4": "explain",
          "q5": "more", "q6": "intraday", "q7": "short_term"}
DEFAULTS = {"beginnerMode": True, "answers": None, "experienceScore": None, "experienceLevel": None, "riskScore": None,
            "riskProfile": None, "recommendedBeginnerMode": None, "assessedAt": None}
# 2026-10-04 16:30 UTC = 2026-10-05 01:30 KST (날짜가 바뀌는 시각으로 KST 변환을 확인한다)
FROZEN = datetime(2026, 10, 4, 16, 30, tzinfo=UTC)
FROZEN_KST = "2026-10-05T01:30:00+09:00"


@pytest.fixture
def alice(django_user_model):
    return django_user_model.objects.create_user(username="alice", password=PASSWORD)


@pytest.fixture
def bob(django_user_model):
    return django_user_model.objects.create_user(username="bob", password=PASSWORD)


@pytest.fixture
def frozen(monkeypatch):
    monkeypatch.setattr(timezone, "now", lambda: FROZEN)
    return FROZEN


def as_user(client, user):
    client.force_login(user)
    return client


def put(client, data):
    return client.put(URL, data, content_type=JSON)


def patch(client, data):
    return client.patch(URL, data, content_type=JSON)


def assert_400(response, detail=None):
    assert response.status_code == 400
    assert set(response.json()) == {"detail"}
    if detail is not None:
        assert response.json()["detail"] == detail


def test_get_defaults_without_row(client, alice):
    response = as_user(client, alice).get(URL)
    assert response.status_code == 200
    assert response.json() == DEFAULTS
    assert not InvestorProfile.objects.exists()  # 읽기만으로는 행을 만들지 않는다


def test_put_example_scores(client, alice, frozen):
    response = put(as_user(client, alice), {"answers": EXAMPLE})
    assert response.status_code == 200
    assert response.json() == {**DEFAULTS, "answers": EXAMPLE, "experienceScore": 1, "experienceLevel": "intro",
                               "riskScore": 2, "riskProfile": "stable_seeking", "recommendedBeginnerMode": True,
                               "assessedAt": FROZEN_KST}
    row = InvestorProfile.objects.get(user=alice)
    assert (row.experience_score, row.experience_level, row.risk_score, row.risk_profile) == (1, "intro", 2, "stable_seeking")
    assert row.assessed_at == FROZEN and row.beginner_mode is True
    assert client.get(URL).json() == response.json()


def test_put_never_changes_beginner_mode(client, alice):
    """진단이 끔을 추천해도 beginnerMode는 그대로다 (사용자가 PATCH로 받아들인다)."""
    as_user(client, alice)
    body = put(client, {"answers": EXPERT}).json()
    assert (body["experienceScore"], body["experienceLevel"], body["riskScore"], body["riskProfile"]) == (
        11, "expert", 8, "aggressive")
    assert body["recommendedBeginnerMode"] is False
    assert body["beginnerMode"] is True
    assert body["answers"]["q2"] == ["kr_stock", "us_stock", "derivatives"]  # 저장은 보기 순서로

    patch(client, {"beginnerMode": False})
    body = put(client, {"answers": EXAMPLE}).json()  # 다시 내면 덮어쓰지만 스위치는 그대로
    assert body["recommendedBeginnerMode"] is True
    assert body["beginnerMode"] is False
    assert body["answers"] == EXAMPLE
    assert InvestorProfile.objects.get(user=alice).beginner_mode is False


def test_put_rejects_beginner_mode_key(client, alice):
    as_user(client, alice)
    assert_400(put(client, {"answers": EXPERT, "beginnerMode": False}), "알 수 없는 항목입니다: beginnerMode")
    assert not InvestorProfile.objects.exists()


@pytest.mark.parametrize("data, detail", [
    ({}, ANSWERS_REQUIRED),
    ({"answers": None}, ANSWERS_REQUIRED),
    ({"answers": [EXAMPLE]}, ANSWERS_REQUIRED),
    ({"answers": {**EXAMPLE, "q8": "x"}}, "모르는 문항입니다: q8"),
    ({"answers": {k: v for k, v in EXAMPLE.items() if k != "q5"}}, "q5에 답해 주세요."),
    ({"answers": {**EXAMPLE, "q1": "ten_years"}}, "q1의 답이 올바르지 않습니다."),
    ({"answers": {**EXAMPLE, "q4": 2}}, "q4의 답이 올바르지 않습니다."),
    ({"answers": {**EXAMPLE, "q2": []}}, Q2_EMPTY),
    ({"answers": {**EXAMPLE, "q2": "kr_stock"}}, Q2_EMPTY),
    ({"answers": {**EXAMPLE, "q2": ["gold"]}}, "q2의 답이 올바르지 않습니다."),
    ({"answers": {**EXAMPLE, "q2": ["kr_stock", "kr_stock"]}}, Q2_DUPLICATE),
    ({"answers": {**EXAMPLE, "q2": ["deposit", "fund_etf"]}}, DEPOSIT_ALONE),
    ({"answers": EXAMPLE, "extra": 1}, "알 수 없는 항목입니다: extra"),
])
def test_put_bad_input(client, alice, data, detail):
    as_user(client, alice)
    assert_400(put(client, data), detail)
    assert client.get(URL).json() == DEFAULTS


def test_put_non_object_body(client, alice):
    assert_400(put(as_user(client, alice), [EXAMPLE]), "요청 본문은 JSON 객체여야 합니다.")


def test_bad_resubmit_keeps_previous_result(client, alice):
    as_user(client, alice)
    first = put(client, {"answers": EXAMPLE}).json()
    assert_400(put(client, {"answers": {**EXPERT, "q2": []}}))
    assert client.get(URL).json() == first


def test_patch_switch_before_assessment(client, alice):
    as_user(client, alice)
    response = patch(client, {"beginnerMode": False})
    assert response.status_code == 200
    assert response.json() == {**DEFAULTS, "beginnerMode": False}
    assert patch(client, {"beginnerMode": True}).json() == DEFAULTS
    assert InvestorProfile.objects.get(user=alice).beginner_mode is True


def test_patch_keeps_assessment(client, alice, frozen):
    as_user(client, alice)
    assessed = put(client, {"answers": EXPERT}).json()
    response = patch(client, {"beginnerMode": False})
    assert response.json() == {**assessed, "beginnerMode": False}


@pytest.mark.parametrize("data, detail", [
    ({}, "beginnerMode는 true 또는 false여야 합니다."),
    ({"beginnerMode": "false"}, "beginnerMode는 true 또는 false여야 합니다."),
    ({"beginnerMode": 0}, "beginnerMode는 true 또는 false여야 합니다."),
    ({"beginnerMode": None}, "beginnerMode는 true 또는 false여야 합니다."),
    ({"beginnerMode": False, "answers": EXAMPLE}, "알 수 없는 항목입니다: answers"),
    ({"beginnerMode": False, "assessedAt": "2026-10-05T09:00:00+09:00"}, "알 수 없는 항목입니다: assessedAt"),
])
def test_patch_bad_input(client, alice, data, detail):
    as_user(client, alice)
    assert_400(patch(client, data), detail)
    assert client.get(URL).json() == DEFAULTS


def test_patch_non_object_body(client, alice):
    assert_400(patch(as_user(client, alice), [False]), "요청 본문은 JSON 객체여야 합니다.")


def test_me_follows_beginner_mode(client, alice):
    as_user(client, alice)
    assert client.get("/api/auth/me").json()["beginnerMode"] is True
    patch(client, {"beginnerMode": False})
    assert client.get("/api/auth/me").json()["beginnerMode"] is False
    # 프로필 수정 응답(Me)도 같은 값
    assert client.patch("/api/me/profile", {"isPublic": True}, content_type=JSON).json()["beginnerMode"] is False


def test_login_returns_beginner_mode(alice):
    InvestorProfile.objects.create(user=alice, beginner_mode=False)
    browser = Client(enforce_csrf_checks=True)
    token = browser.get("/api/auth/csrf").json()["csrfToken"]
    response = browser.post("/api/auth/login", {"username": "alice", "password": PASSWORD}, content_type=JSON,
                            headers={"X-CSRFToken": token})
    assert response.status_code == 200 and response.json()["beginnerMode"] is False


def test_results_only_for_owner(client, alice, bob):
    """진단 결과는 본인만 본다: 다른 사람의 GET·Me에는 내 값이 나오지 않는다."""
    as_user(client, alice)
    put(client, {"answers": EXPERT})
    patch(client, {"beginnerMode": False})
    other = as_user(Client(), bob)
    assert other.get(URL).json() == DEFAULTS
    assert other.get("/api/auth/me").json()["beginnerMode"] is True
    # bob의 진단은 alice의 값을 바꾸지 않는다
    put(other, {"answers": EXAMPLE})
    assert client.get(URL).json()["experienceLevel"] == "expert"


@pytest.mark.parametrize("method", ["get", "put", "patch"])
def test_login_required(client, method):
    response = getattr(client, method)(URL, {}, content_type=JSON)
    assert response.status_code == 401
    assert response.json() == {"detail": "로그인이 필요합니다."}


@pytest.mark.parametrize("method, data", [("put", {"answers": EXAMPLE}), ("patch", {"beginnerMode": False})])
def test_changes_require_csrf(alice, method, data):
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(alice)
    browser.get("/api/auth/csrf")
    response = getattr(browser, method)(URL, data, content_type=JSON)
    assert response.status_code == 403 and set(response.json()) == {"detail"}
    assert not InvestorProfile.objects.exists()
    ok = getattr(browser, method)(URL, data, content_type=JSON,
                                  headers={"X-CSRFToken": browser.cookies["csrftoken"].value})
    assert ok.status_code == 200


def test_schema_lists_paths(client, alice):
    response = as_user(client, alice).get("/api/schema/")
    assert response.status_code == 200
    assert b"/api/me/investor-profile" in response.content
