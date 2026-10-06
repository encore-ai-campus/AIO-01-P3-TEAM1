"""팀원 프로필. 계정 자체는 Django 기본 User(auth_user)를 쓴다 (docs/DECISIONS.md 8-1).

사용자를 만들면 프로필이 자동으로 생긴다 (signals.py). 다른 앱은 프로필을 `profile_of(user)`로만 얻는다
(`Profile.objects.create`로 만들면 자동으로 생긴 것과 겹쳐 실패한다).
"""
import secrets
import unicodedata

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import IntegrityError, models, transaction
from django.db.models.functions import Lower

NICKNAME_MIN, NICKNAME_MAX = 2, 12
NICKNAME_LENGTH_ERROR = f"닉네임은 {NICKNAME_MIN}~{NICKNAME_MAX}자여야 합니다."
NICKNAME_TAKEN = "이미 쓰는 닉네임입니다."
NICKNAME_BAD_CHARS = "닉네임에 쓸 수 없는 문자가 있습니다."
# 제어·서식(폭 없는 공백, 방향 바꿈)·줄/문단 구분·대체 쌍·사용자 정의·미지정 문자. 다른 팀원 이름처럼 보이게 만들 수 있다
INVISIBLE_CATEGORIES = {"Cc", "Cf", "Zl", "Zp", "Cs", "Co", "Cn"}


class Profile(models.Model):
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="profile")
    nickname = models.CharField(max_length=12, unique=True)  # 랭킹에 보이는 이름. 기본값은 아이디
    is_public = models.BooleanField(default=False)           # 내 정보 공개 (켜면 랭킹보드에 수익률이 나온다)

    class Meta:
        # 닉네임은 대소문자를 무시하고도 겹치지 않게 DB에서 막는다 (SQLite·PostgreSQL 모두 식 인덱스 지원).
        constraints = [models.UniqueConstraint(Lower("nickname"), name="accounts_profile_nickname_ci_unique")]

    def __str__(self) -> str:
        return f"{self.nickname} ({self.user.username})"


class InvestorProfile(models.Model):
    """투자자 프로필과 주린이모드 (docs/API.md "투자자 프로필과 주린이모드", docs/DECISIONS.md 14-7 B10).

    **행이 없으면 기본값**으로 본다 (beginnerMode 켬, 진단 전) — 신호·데이터 마이그레이션 없이,
    진단 제출이나 스위치처럼 값을 바꿀 때 행을 만든다. 점수 계산은 accounts/assessment.py(결정론).
    """
    user = models.OneToOneField(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name="investor_profile")
    beginner_mode = models.BooleanField(default=True)  # 주린이모드 (켬 = 쉬운 보기)
    # 진단 결과 (진단 전이면 모두 None). answers는 InvestorAnswers 그대로 (q1~q7)
    answers = models.JSONField(null=True, blank=True)
    experience_score = models.IntegerField(null=True, blank=True)  # 0~11
    experience_level = models.CharField(max_length=20, null=True, blank=True)  # intro | novice | intermediate | expert
    risk_score = models.IntegerField(null=True, blank=True)  # 0~8
    risk_profile = models.CharField(max_length=20, null=True, blank=True)  # stable | stable_seeking | neutral | active | aggressive
    recommended_beginner_mode = models.BooleanField(null=True, blank=True)
    assessed_at = models.DateTimeField(null=True, blank=True)  # 마지막 진단 제출 시각
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        db_table = "investor_profiles"

    def __str__(self) -> str:
        return f"{self.user} beginner={self.beginner_mode}"


def profile_of(user) -> Profile:
    """user의 프로필. 없으면 닉네임을 아이디로 해서 만든다 (겹치면 숫자를 붙인다). 다른 앱은 프로필을 이 함수로만 얻는다."""
    profile = Profile.objects.filter(user=user).first()
    if profile is not None:
        return profile
    for _ in range(5):  # 동시에 같은 닉네임·같은 사용자로 만들면 DB 제약에 걸린다 → 다시 확인하고 다시 고른다
        try:
            with transaction.atomic():
                return Profile.objects.create(user=user, nickname=default_nickname(user))
        except IntegrityError:
            profile = Profile.objects.filter(user=user).first()
            if profile is not None:
                return profile
    raise IntegrityError(f"프로필을 만들지 못했습니다: {user.get_username()}")


def default_nickname(user) -> str:
    """기본 닉네임: 아이디(12자까지). 다른 사람과 겹치면 뒤에 숫자를 붙이고, 그래도 안 되면 무작위로."""
    candidates = _nickname_candidates(user.get_username()[:NICKNAME_MAX])
    return next(candidate for candidate in candidates if not nickname_taken(candidate, user))


def _nickname_candidates(base: str):
    if len(base) >= NICKNAME_MIN:
        yield base
    for number in range(2, 100):
        suffix = str(number)
        yield base[:NICKNAME_MAX - len(suffix)] + suffix
    while True:
        yield "user" + secrets.token_hex(4)


def nickname_taken(nickname: str, user=None) -> bool:
    """다른 사람의 닉네임이나 아이디와 대소문자 무시하고 겹치는지. 자기 아이디·닉네임은 괜찮다."""
    user_model = get_user_model()
    nicknames = Profile.objects.filter(nickname__iexact=nickname)
    usernames = user_model.objects.filter(**{f"{user_model.USERNAME_FIELD}__iexact": nickname})
    if user is not None and user.pk is not None:
        nicknames = nicknames.exclude(user=user)
        usernames = usernames.exclude(pk=user.pk)
    return nicknames.exists() or usernames.exists()


def clean_nickname(text: str) -> str:
    """입력한 닉네임을 저장할 모양으로: 유니코드 NFKC 정규화(전각·호환 문자를 보통 문자로) 후 앞뒤 공백 제거."""
    return unicodedata.normalize("NFKC", text).strip()


def nickname_error(nickname: str, user=None) -> str | None:
    """닉네임 규칙 위반 사유 (없으면 None). nickname은 clean_nickname을 거친 값이어야 한다. API와 관리자 화면이 같이 쓴다."""
    if not NICKNAME_MIN <= len(nickname) <= NICKNAME_MAX:
        return NICKNAME_LENGTH_ERROR
    if any(unicodedata.category(ch) in INVISIBLE_CATEGORIES for ch in nickname):
        return NICKNAME_BAD_CHARS
    if nickname_taken(nickname, user):
        return NICKNAME_TAKEN
    return None
