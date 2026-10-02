"""계정 API (docs/API.md "계정"): CSRF 쿠키, 로그인·로그아웃, 내 정보, 프로필 수정."""
from django.contrib.auth import authenticate, login, logout
from django.db import IntegrityError, transaction
from django.middleware.csrf import get_token
from drf_spectacular.utils import extend_schema, inline_serializer
from rest_framework import serializers, status
from rest_framework.authentication import SessionAuthentication
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

from accounts.models import NICKNAME_TAKEN, clean_nickname, nickname_error, profile_of
from config.api import Rejected

LOGIN_FAILED = "아이디 또는 비밀번호가 올바르지 않습니다."
PROFILE_KEYS = ("isPublic", "nickname")

# OpenAPI 문서용 (응답은 아래 me()가 만든다)
ME_SCHEMA = inline_serializer("Me", {
    "id": serializers.IntegerField(),
    "username": serializers.CharField(),
    "nickname": serializers.CharField(),
    "isPublic": serializers.BooleanField(),
    "isStaff": serializers.BooleanField(),
})
CSRF_SCHEMA = inline_serializer("CsrfToken", {"csrfToken": serializers.CharField()})
LOGIN_SCHEMA = inline_serializer("LoginRequest", {"username": serializers.CharField(),
                                                  "password": serializers.CharField()})
PROFILE_SCHEMA = inline_serializer("ProfilePatch", {"isPublic": serializers.BooleanField(required=False),
                                                    "nickname": serializers.CharField(required=False)})


def me(user, profile=None) -> dict:
    """Me 응답."""
    profile = profile or profile_of(user)
    return {"id": user.pk, "username": user.get_username(), "nickname": profile.nickname,
            "isPublic": profile.is_public, "isStaff": user.is_staff}


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
        data = request.data
        if not isinstance(data, dict):
            raise Rejected("요청 본문은 JSON 객체여야 합니다.")
        unknown = sorted(set(data) - set(PROFILE_KEYS))
        if unknown:
            raise Rejected(f"알 수 없는 항목입니다: {', '.join(unknown)}")
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
