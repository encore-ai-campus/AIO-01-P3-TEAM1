from django.contrib import admin
from django.http import HttpResponse, JsonResponse
from django.urls import path
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
    path("admin/", admin.site.urls),
]
