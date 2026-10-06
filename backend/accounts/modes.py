"""주린이모드를 읽는 곳 (docs/API.md "투자자 프로필과 주린이모드", docs/DECISIONS.md 14-7 B10).

다른 앱(notifications의 알림 문장)은 이 모듈로 읽는다. 읽기만 한다 — 값은 accounts/views.py가 바꾼다.
InvestorProfile **행이 없으면 기본값**이다: 주린이모드 켬, 진단 전.
"""
from accounts.models import InvestorProfile


def investor_profile(user) -> InvestorProfile:
    """user의 투자자 프로필. 행이 없으면 저장하지 않은 기본값 (주린이모드 켬, 나머지 없음)."""
    return InvestorProfile.objects.filter(user=user).first() or InvestorProfile(user=user)


def beginner_mode_of(user) -> bool:
    """user의 주린이모드 (행이 없으면 True). 쿼리 1번."""
    mode = InvestorProfile.objects.filter(user=user).values_list("beginner_mode", flat=True).first()
    return True if mode is None else mode


def beginner_modes(user_ids) -> dict[int, bool]:
    """사용자 id → 주린이모드. 행이 없는 사용자는 True. 쿼리 1번 (빈 목록이면 0번)."""
    ids = list(dict.fromkeys(user_ids))
    if not ids:
        return {}
    stored = dict(InvestorProfile.objects.filter(user_id__in=ids).values_list("user_id", "beginner_mode"))
    return {user_id: stored.get(user_id, True) for user_id in ids}
