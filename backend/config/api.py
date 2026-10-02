"""API 공통 규칙 (docs/API.md "공통 규칙"): 오류 응답 형식과 목록 페이지."""
from django.db.models import QuerySet
from rest_framework import status
from rest_framework.exceptions import APIException, NotAuthenticated, PermissionDenied, Throttled
from rest_framework.response import Response
from rest_framework.views import exception_handler as drf_exception_handler

DEFAULT_LIMIT, MAX_LIMIT = 20, 100


class Rejected(APIException):
    """규칙 위반·주문 거절. `raise Rejected("사유")` → 400 {"detail": "사유"}."""
    status_code = status.HTTP_400_BAD_REQUEST
    default_detail = "요청을 처리할 수 없습니다."


class LimitExceeded(APIException):
    """한도 초과 → 429."""
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    default_detail = "한도를 넘었습니다."


class Unavailable(APIException):
    """증권사·AI 조회를 쓸 수 없음 → 503."""
    status_code = status.HTTP_503_SERVICE_UNAVAILABLE
    default_detail = "지금은 조회할 수 없습니다."


def exception_handler(exc, context):
    """오류를 {"detail": "메시지"} 하나로 맞춘다. 로그인하지 않았으면 401 (세션 인증의 기본은 403이다)."""
    if isinstance(exc, NotAuthenticated):
        return Response({"detail": "로그인이 필요합니다."}, status=status.HTTP_401_UNAUTHORIZED)
    if isinstance(exc, PermissionDenied) and str(exc.detail).startswith("CSRF Failed"):
        return Response({"detail": "보안 토큰(CSRF)이 맞지 않습니다. 새로고침한 뒤 다시 시도하세요."},
                        status=status.HTTP_403_FORBIDDEN)
    if isinstance(exc, Throttled):
        wait = f" {int(exc.wait) + 1}초 뒤에" if exc.wait else " 잠시 뒤에"
        response = Response({"detail": f"요청이 너무 많습니다.{wait} 다시 시도하세요."},
                            status=status.HTTP_429_TOO_MANY_REQUESTS)
        if exc.wait:
            response["Retry-After"] = str(int(exc.wait) + 1)
        return response
    response = drf_exception_handler(exc, context)
    if response is not None and not (isinstance(response.data, dict) and set(response.data) == {"detail"}):
        response.data = {"detail": _flatten(response.data)}  # 필드별 검증 오류를 한 문장으로
    return response


def _flatten(data) -> str:
    if isinstance(data, dict):
        return "; ".join(f"{key}: {_flatten(value)}" if key != "non_field_errors" else _flatten(value)
                         for key, value in data.items())
    if isinstance(data, (list, tuple)):
        return ", ".join(_flatten(item) for item in data)
    return str(data)


def page(request, items, serialize) -> Response:
    """`?limit=&offset=` 페이지 → {"count", "results"}. items는 QuerySet이나 리스트, serialize는 항목 → dict."""
    limit = _int(request.query_params.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT)
    offset = _int(request.query_params.get("offset"), 0, 0, None)
    count = items.count() if isinstance(items, QuerySet) else len(items)
    return Response({"count": count, "results": [serialize(item) for item in items[offset:offset + limit]]})


def _int(text, default: int, low: int, high: int | None) -> int:
    try:
        value = int(text)
    except (TypeError, ValueError):
        return default
    value = max(value, low)
    return value if high is None else min(value, high)
