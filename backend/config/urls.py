from django.contrib import admin
from django.http import HttpResponse, JsonResponse
from django.urls import include, path
from drf_spectacular.views import SpectacularAPIView

EMPTY_PAGE = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>모의매매</title></head><body></body></html>'


def index(request):
    return HttpResponse(EMPTY_PAGE)


def health(request):
    """배포 상태 확인용. DB·Redis를 보지 않는다."""
    return JsonResponse({"status": "ok"})


urlpatterns = [
    path("", index),
    path("api/health", health),
    path("api/schema/", SpectacularAPIView.as_view(), name="schema"),
    # 앱별 API (docs/API.md). 경로는 각 앱의 urls.py가 "auth/login"처럼 api/ 뒤부터 적는다. 끝 슬래시 없음.
    path("api/", include("accounts.urls")),
    path("api/", include("trading.urls")),
    path("api/", include("analysis.urls")),
    path("api/", include("reports.urls")),
    path("api/", include("autotrade.urls")),
    path("api/", include("notifications.urls")),
    path("api/", include("longterm.urls")),
    path("admin/", admin.site.urls),
]
