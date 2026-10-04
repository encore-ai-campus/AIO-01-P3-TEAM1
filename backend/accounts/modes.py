"""주린이모드와 단타 연습장 잠금을 읽는 곳 (docs/API.md "투자자 프로필과 주린이모드"·"단타 연습 퀴즈", docs/DECISIONS.md 14-7 B10).

다른 앱(notifications의 알림 문장, daytrade·autotrade의 단타 잠금)은 이 모듈로 읽는다. 읽기만 한다 — 값은 accounts/views.py가 바꾼다.
InvestorProfile **행이 없으면 기본값**이다: 주린이모드 켬, 진단 전, 퀴즈 통과 없음.
"""
from accounts.models import InvestorProfile

# 단타 연습장 잠금 사유 (docs/API.md DayLockReason). 이 순서로 돌려준다
LOCK_BEGINNER_MODE = "beginner_mode"     # 주린이모드 켬
LOCK_QUIZ_NOT_PASSED = "quiz_not_passed"  # 단타 연습 퀴즈를 통과한 적 없음


def investor_profile(user) -> InvestorProfile:
    """user의 투자자 프로필. 행이 없으면 저장하지 않은 기본값 (주린이모드 켬, 나머지 없음)."""
    return InvestorProfile.objects.filter(user=user).first() or InvestorProfile(user=user)


def lock_reasons(profile: InvestorProfile) -> list[str]:
    """이 프로필의 단타 연습장 잠금 사유. 빈 목록이면 열림 (= InvestorProfile.dayTradingUnlocked)."""
    reasons = []
    if profile.beginner_mode:
        reasons.append(LOCK_BEGINNER_MODE)
    if profile.day_quiz_passed_at is None:
        reasons.append(LOCK_QUIZ_NOT_PASSED)
    return reasons


def day_trading_lock(user) -> list[str]:
    """user의 단타 연습장 잠금 사유 코드 ("beginner_mode", "quiz_not_passed" 순). 빈 목록이면 열림. 쿼리 1번."""
    return lock_reasons(investor_profile(user))


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
