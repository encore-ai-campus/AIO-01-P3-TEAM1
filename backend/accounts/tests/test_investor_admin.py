"""관리자 화면의 투자자 프로필: 읽기 전용 (점수·단계·스위치·진단 시각만, 진단 답 원문은 없음)."""
from datetime import UTC, datetime

import pytest

from accounts.models import InvestorProfile

pytestmark = pytest.mark.django_db

ANSWERS = {"q1": "over_3y", "q2": ["kr_stock"], "q3": "daily", "q4": "explain", "q5": "loss_20", "q6": "weeks",
           "q7": "growth"}


@pytest.fixture
def assessed(django_user_model):
    user = django_user_model.objects.create_user(username="alice", password="x")
    return InvestorProfile.objects.create(
        user=user, beginner_mode=False, answers=ANSWERS, experience_score=9, experience_level="expert", risk_score=4,
        risk_profile="neutral", recommended_beginner_mode=False, assessed_at=datetime(2026, 10, 5, 1, 0, tzinfo=UTC))


def test_list_and_view_only_detail(admin_client, assessed):
    response = admin_client.get("/admin/accounts/investorprofile/")
    assert response.status_code == 200
    page = response.content.decode()
    assert "숙련 (expert)" in page and "위험중립형 (neutral)" in page

    url = f"/admin/accounts/investorprofile/{assessed.pk}/change/"
    response = admin_client.get(url)
    assert response.status_code == 200
    page = response.content.decode()
    assert "숙련 (expert)" in page
    assert "over_3y" not in page  # 진단 답 원문은 보이지 않는다
    assert 'name="beginner_mode"' not in page  # 입력 칸이 없다 (읽기 전용)


def test_cannot_add_or_change(admin_client, assessed):
    assert admin_client.get("/admin/accounts/investorprofile/add/").status_code == 403
    url = f"/admin/accounts/investorprofile/{assessed.pk}/change/"
    assert admin_client.post(url, {"beginner_mode": "on", "experience_score": "0"}).status_code == 403
    assessed.refresh_from_db()
    assert (assessed.beginner_mode, assessed.experience_score) == (False, 9)


def test_user_page_shows_read_only_inline(admin_client, assessed):
    response = admin_client.get(f"/admin/auth/user/{assessed.user.pk}/change/")
    assert response.status_code == 200
    page = response.content.decode()
    assert "투자자 프로필" in page and "숙련 (expert)" in page
    assert "over_3y" not in page


def test_user_page_without_row(admin_client, django_user_model):
    user = django_user_model.objects.create_user(username="bob", password="x")
    assert admin_client.get(f"/admin/auth/user/{user.pk}/change/").status_code == 200
    assert not InvestorProfile.objects.exists()


def test_user_can_still_be_deleted(admin_client, assessed):
    """투자자 프로필이 있어도 관리자 화면에서 사용자를 지울 수 있다 (프로필도 같이 지워진다)."""
    url = f"/admin/auth/user/{assessed.user.pk}/delete/"
    assert admin_client.post(url, {"post": "yes"}).status_code == 302
    assert not InvestorProfile.objects.exists()
