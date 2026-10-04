"""단타 연습 퀴즈 API (docs/API.md "단타 연습 퀴즈"): GET(정답 없음) · POST 채점 · 5/5 통과 · 다시 풀기 · dayTradingUnlocked."""
import json
from datetime import UTC, datetime

import pytest
from django.test import Client
from django.utils import timezone

from accounts.models import InvestorProfile
from accounts.quiz import QUESTIONS

pytestmark = pytest.mark.django_db

URL = "/api/me/day-trading-quiz"
PROFILE_URL = "/api/me/investor-profile"
JSON = "application/json"
KEY = {q.id: q.answer for q in QUESTIONS}
# UTC와 KST의 날짜가 다른 시각 두 개 (KST 변환 확인)
FIRST = datetime(2026, 10, 5, 15, 10, tzinfo=UTC)    # 2026-10-06 00:10 KST
SECOND = datetime(2026, 10, 6, 23, 59, tzinfo=UTC)   # 2026-10-07 08:59 KST
FIRST_KST = "2026-10-06T00:10:00+09:00"
SECOND_KST = "2026-10-07T08:59:00+09:00"


def wrong(question_id: str) -> str:
    question = next(q for q in QUESTIONS if q.id == question_id)
    return next(cid for cid, _ in question.choices if cid != question.answer)


@pytest.fixture
def alice(django_user_model, client):
    user = django_user_model.objects.create_user(username="alice", password="Test-pass-9x")
    client.force_login(user)
    return user


@pytest.fixture
def clock(monkeypatch):
    """timezone.now를 고정한다. clock(t)로 바꾼다."""
    state = {"now": FIRST}
    monkeypatch.setattr(timezone, "now", lambda: state["now"])

    def set_now(value):
        state["now"] = value
    return set_now


def submit(client, answers):
    return client.post(URL, {"answers": answers}, content_type=JSON)


def test_get_has_no_answers(client, alice):
    response = client.get(URL)
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {"questions", "passedAt"}
    assert body["passedAt"] is None
    assert [q["id"] for q in body["questions"]] == ["q1", "q2", "q3", "q4", "q5"]
    for question in body["questions"]:
        assert set(question) == {"id", "text", "choices"}
        assert [c["id"] for c in question["choices"]] == ["a", "b", "c", "d"]
        assert all(set(c) == {"id", "text"} for c in question["choices"])
    dumped = json.dumps(body, ensure_ascii=False)
    assert not any(q.explanation in dumped for q in QUESTIONS)
    assert "answer" not in dumped and "explanation" not in dumped
    assert not InvestorProfile.objects.exists()


def test_pass_with_all_correct(client, alice, clock):
    response = submit(client, KEY)
    assert response.status_code == 200
    body = response.json()
    assert (body["passed"], body["correct"], body["total"], body["passedAt"]) == (True, 5, 5, FIRST_KST)
    assert [r["id"] for r in body["results"]] == ["q1", "q2", "q3", "q4", "q5"]
    assert all(r["correct"] and r["explanation"] for r in body["results"])
    assert InvestorProfile.objects.get(user=alice).day_quiz_passed_at == FIRST
    assert client.get(URL).json()["passedAt"] == FIRST_KST
    profile = client.get(PROFILE_URL).json()
    assert profile["dayQuizPassedAt"] == FIRST_KST
    assert profile["beginnerMode"] is True and profile["dayTradingUnlocked"] is False  # 주린이모드 켬이라 아직 잠김


def test_four_of_five_fails_without_row(client, alice, clock):
    body = submit(client, {**KEY, "q4": wrong("q4")}).json()
    assert (body["passed"], body["correct"], body["total"], body["passedAt"]) == (False, 4, 5, None)
    assert [r["correct"] for r in body["results"]] == [True, True, True, False, True]
    assert not InvestorProfile.objects.exists()


def test_failing_later_keeps_previous_pass(client, alice, clock):
    submit(client, KEY)
    clock(SECOND)
    body = submit(client, {qid: wrong(qid) for qid in KEY}).json()
    assert (body["passed"], body["correct"], body["passedAt"]) == (False, 0, FIRST_KST)
    assert InvestorProfile.objects.get(user=alice).day_quiz_passed_at == FIRST


def test_retry_after_failure_and_repass_updates_time(client, alice, clock):
    assert submit(client, {**KEY, "q1": wrong("q1")}).json()["passed"] is False
    assert submit(client, KEY).json()["passedAt"] == FIRST_KST  # 다시 풀 수 있다
    clock(SECOND)
    assert submit(client, KEY).json()["passedAt"] == SECOND_KST  # 다시 통과하면 그 시각


def test_unlock_needs_switch_off_and_quiz(client, alice, clock):
    """dayTradingUnlocked = beginnerMode false 이고 퀴즈 통과. 주린이모드를 다시 켜면 잠기고 퀴즈 기록은 남는다."""
    def patch(mode):
        return client.patch(PROFILE_URL, {"beginnerMode": mode}, content_type=JSON).json()
    assert patch(False)["dayTradingUnlocked"] is False  # 퀴즈 전
    submit(client, KEY)
    assert client.get(PROFILE_URL).json()["dayTradingUnlocked"] is True
    locked = patch(True)
    assert locked["dayTradingUnlocked"] is False and locked["dayQuizPassedAt"] == FIRST_KST
    assert patch(False)["dayTradingUnlocked"] is True


def test_pass_does_not_touch_assessment_or_switch(client, alice, clock):
    client.patch(PROFILE_URL, {"beginnerMode": False}, content_type=JSON)
    before = client.get(PROFILE_URL).json()
    submit(client, KEY)
    after = client.get(PROFILE_URL).json()
    assert {**after, "dayQuizPassedAt": None, "dayTradingUnlocked": False} == before


@pytest.mark.parametrize("data, detail", [
    ({}, "answers가 필요합니다."),
    ({"answers": None}, "answers가 필요합니다."),
    ({"answers": ["b", "a", "c", "d", "a"]}, "answers가 필요합니다."),
    ({"answers": {**KEY, "q6": "a"}}, "모르는 문항입니다: q6"),
    ({"answers": {k: v for k, v in KEY.items() if k != "q2"}}, "q2에 답해 주세요."),
    ({"answers": {**KEY, "q3": "z"}}, "q3에 없는 보기입니다."),
    ({"answers": {**KEY, "q3": 3}}, "q3에 없는 보기입니다."),
    ({"answers": KEY, "passed": True}, "알 수 없는 항목입니다: passed"),
])
def test_bad_input(client, alice, data, detail):
    response = client.post(URL, data, content_type=JSON)
    assert response.status_code == 400 and response.json() == {"detail": detail}
    assert not InvestorProfile.objects.exists()


def test_non_object_body(client, alice):
    response = client.post(URL, [KEY], content_type=JSON)
    assert response.status_code == 400 and response.json() == {"detail": "요청 본문은 JSON 객체여야 합니다."}


def test_pass_is_per_user(client, alice, django_user_model):
    submit(client, KEY)
    bob = django_user_model.objects.create_user(username="bob", password="Test-pass-9x")
    other = Client()
    other.force_login(bob)
    assert other.get(URL).json()["passedAt"] is None
    assert other.get(PROFILE_URL).json()["dayQuizPassedAt"] is None


@pytest.mark.parametrize("method", ["get", "post"])
def test_login_required(client, method):
    response = getattr(client, method)(URL, {}, content_type=JSON)
    assert response.status_code == 401 and response.json() == {"detail": "로그인이 필요합니다."}


def test_submit_requires_csrf(django_user_model):
    user = django_user_model.objects.create_user(username="carol", password="Test-pass-9x")
    browser = Client(enforce_csrf_checks=True)
    browser.force_login(user)
    browser.get("/api/auth/csrf")
    assert browser.post(URL, {"answers": KEY}, content_type=JSON).status_code == 403
    assert not InvestorProfile.objects.exists()
    ok = browser.post(URL, {"answers": KEY}, content_type=JSON,
                      headers={"X-CSRFToken": browser.cookies["csrftoken"].value})
    assert ok.status_code == 200 and ok.json()["passed"] is True
