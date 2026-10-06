"""계정 API (docs/API.md "계정"): CSRF 쿠키, 로그인·로그아웃, 내 정보, 프로필 수정, 투자자 프로필·주린이모드."""
from django.contrib.auth import authenticate, login, logout
from django.db import IntegrityError, transaction
from django.middleware.csrf import get_token
from django.utils import timezone
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from accounts import assessment
from accounts.models import NICKNAME_TAKEN, InvestorProfile, clean_nickname, nickname_error, profile_of
from accounts.modes import beginner_mode_of, investor_profile
from config.api import Rejected

LOGIN_FAILED = "아이디 또는 비밀번호가 올바르지 않습니다."
PROFILE_KEYS = ("isPublic", "nickname")
NOT_OBJECT = "요청 본문은 JSON 객체여야 합니다."
BEGINNER_MODE_NOT_BOOL = "beginnerMode는 true 또는 false여야 합니다."

# OpenAPI 문서용 (응답은 아래 me()가 만든다)
ME_SCHEMA = inline_serializer("Me", {
    "id": serializers.IntegerField(),
    "username": serializers.CharField(),
    "nickname": serializers.CharField(),
    "isPublic": serializers.BooleanField(),
    "isStaff": serializers.BooleanField(),
    "beginnerMode": serializers.BooleanField(),
})
CSRF_SCHEMA = inline_serializer("CsrfToken", {"csrfToken": serializers.CharField()})
LOGIN_SCHEMA = inline_serializer("LoginRequest", {"username": serializers.CharField(),
                                                  "password": serializers.CharField()})
PROFILE_SCHEMA = inline_serializer("ProfilePatch", {"isPublic": serializers.BooleanField(required=False),
                                                    "nickname": serializers.CharField(required=False)})
INVESTOR_PROFILE_SCHEMA = inline_serializer("InvestorProfile", {
    "beginnerMode": serializers.BooleanField(),
    "answers": serializers.DictField(allow_null=True),
    "experienceScore": serializers.IntegerField(allow_null=True),
    "experienceLevel": serializers.ChoiceField(choices=list(assessment.EXPERIENCE_LEVEL_LABELS), allow_null=True),
    "riskScore": serializers.IntegerField(allow_null=True),
    "riskProfile": serializers.ChoiceField(choices=list(assessment.RISK_PROFILE_LABELS), allow_null=True),
    "recommendedBeginnerMode": serializers.BooleanField(allow_null=True),
    "assessedAt": serializers.DateTimeField(allow_null=True),
})
ASSESSMENT_SCHEMA = inline_serializer("InvestorProfileSubmit", {"answers": serializers.DictField()})
BEGINNER_MODE_SCHEMA = inline_serializer("BeginnerModePatch", {"beginnerMode": serializers.BooleanField()})


def me(user, profile=None) -> dict:
    """Me 응답. beginnerMode는 InvestorProfile의 값 (행이 없으면 true)."""
    profile = profile or profile_of(user)
    return {"id": user.pk, "username": user.get_username(), "nickname": profile.nickname,
            "isPublic": profile.is_public, "isStaff": user.is_staff, "beginnerMode": beginner_mode_of(user)}


def iso(value) -> str | None:
    return timezone.localtime(value).isoformat() if value else None


def investor_profile_json(profile: InvestorProfile) -> dict:
    """InvestorProfile 응답. 진단 전이면 answers부터 assessedAt까지 null. 본인에게만 돌려준다."""
    return {
        "beginnerMode": profile.beginner_mode,
        "answers": profile.answers,
        "experienceScore": profile.experience_score,
        "experienceLevel": profile.experience_level,
        "riskScore": profile.risk_score,
        "riskProfile": profile.risk_profile,
        "recommendedBeginnerMode": profile.recommended_beginner_mode,
        "assessedAt": iso(profile.assessed_at),
    }


def stored_investor_profile(user) -> InvestorProfile:
    """값을 바꿀 때 쓰는 저장된 행 (없으면 기본값으로 만든다). 읽기만 할 때는 modes.investor_profile."""
    profile, _ = InvestorProfile.objects.get_or_create(user=user)
    return profile


def body_of(request, allowed: tuple[str, ...]) -> dict:
    """요청 본문 (JSON 객체, allowed 밖의 키 없음). 아니면 400."""
    data = request.data
    if not isinstance(data, dict):
        raise Rejected(NOT_OBJECT)
    unknown = sorted(set(data) - set(allowed))
    if unknown:
        raise Rejected(f"알 수 없는 항목입니다: {', '.join(unknown)}")
    return data


class CsrfView(APIView):
    """csrftoken 쿠키를 심는다. 프론트는 쿠키가 없을 때 먼저 부른다."""
    permission_classes = [AllowAny]

    @extend_schema(responses=CSRF_SCHEMA)
    def get(self, request):
        return Response({"csrfToken": get_token(request)})


class LoginView(APIView):
    permission_classes = [AllowAny]
    throttle_classes = [ScopedRateThrottle]  # 같은 주소의 로그인 시도 횟수 제한 (settings의 "login")
    throttle_scope = "login"

    @extend_schema(request=LOGIN_SCHEMA, responses=ME_SCHEMA)
    def post(self, request):
        # DRF 세션 인증은 로그인한 요청만 CSRF를 검사한다. 로그인 요청(익명)은 여기서 직접 검사한다 → 403 {"detail"}.
        SessionAuthentication().enforce_csrf(request)
        data = request.data if isinstance(request.data, dict) else {}
        username, password = data.get("username"), data.get("password")
        if not (isinstance(username, str) and isinstance(password, str) and username and password):
            raise Rejected("아이디와 비밀번호를 입력하세요.")
        user = authenticate(request, username=username, password=password)  # 비활성 계정도 None
        if user is None:
            raise Rejected(LOGIN_FAILED)  # 아이디가 있는지는 알려 주지 않는다
        login(request, user)
        return Response(me(user))


class LogoutView(APIView):
    @extend_schema(request=None, responses={204: None})
    def post(self, request):
        logout(request)
        return Response(status=status.HTTP_204_NO_CONTENT)


class MeView(APIView):
    @extend_schema(responses=ME_SCHEMA)
    def get(self, request):
        return Response(me(request.user))


class ProfileView(APIView):
    @extend_schema(request=PROFILE_SCHEMA, responses=ME_SCHEMA)
    def patch(self, request):
        """준 항목만 바꾼다. 모르는 키나 타입이 틀리면 400."""
        data = body_of(request, PROFILE_KEYS)
        profile = profile_of(request.user)
        fields = []
        if "isPublic" in data:
            if not isinstance(data["isPublic"], bool):
                raise Rejected("isPublic은 true 또는 false여야 합니다.")
            profile.is_public = data["isPublic"]
            fields.append("is_public")
        if "nickname" in data:
            if not isinstance(data["nickname"], str):
                raise Rejected("nickname은 문자열이어야 합니다.")
            nickname = clean_nickname(data["nickname"])
            error = nickname_error(nickname, request.user)
            if error:
                raise Rejected(error)
            profile.nickname = nickname
            fields.append("nickname")
        if fields:
            try:
                with transaction.atomic():
                    profile.save(update_fields=fields)
            except IntegrityError:  # 검사와 저장 사이에 다른 사람이 같은 닉네임을 가져갔다
                raise Rejected(NICKNAME_TAKEN) from None
        return Response(me(request.user, profile))


class InvestorProfileView(APIView):
    """투자 성향·경험 진단과 주린이모드 스위치 (docs/API.md "투자자 프로필과 주린이모드"). 늘 요청한 본인의 것만."""

    @extend_schema(responses=INVESTOR_PROFILE_SCHEMA)
    def get(self, request):
        return Response(investor_profile_json(investor_profile(request.user)))

    @extend_schema(request=ASSESSMENT_SCHEMA, responses=INVESTOR_PROFILE_SCHEMA)
    def put(self, request):
        """진단 제출: 점수표로 계산해 저장한다 (다시 내면 덮어쓴다). beginnerMode는 바꾸지 않는다."""
        data = body_of(request, ("answers",))
        error = assessment.answers_error(data.get("answers"))
        if error:
            raise Rejected(error)
        answers = assessment.clean_answers(data["answers"])
        result = assessment.assess(answers)
        profile = stored_investor_profile(request.user)
        profile.answers = answers
        profile.experience_score = result.experience_score
        profile.experience_level = result.experience_level
        profile.risk_score = result.risk_score
        profile.risk_profile = result.risk_profile
        profile.recommended_beginner_mode = result.recommended_beginner_mode
        profile.assessed_at = timezone.now()
        profile.save(update_fields=["answers", "experience_score", "experience_level", "risk_score", "risk_profile",
                                    "recommended_beginner_mode", "assessed_at", "updated_at"])
        return Response(investor_profile_json(profile))

    @extend_schema(request=BEGINNER_MODE_SCHEMA, responses=INVESTOR_PROFILE_SCHEMA)
    def patch(self, request):
        """주린이모드 스위치만 (진단 전에도 된다)."""
        data = body_of(request, ("beginnerMode",))
        if not isinstance(data.get("beginnerMode"), bool):
            raise Rejected(BEGINNER_MODE_NOT_BOOL)
        profile = stored_investor_profile(request.user)
        profile.beginner_mode = data["beginnerMode"]
        profile.save(update_fields=["beginner_mode", "updated_at"])
        return Response(investor_profile_json(profile))

