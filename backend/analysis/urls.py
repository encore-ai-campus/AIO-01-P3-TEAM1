"""AI 분석 API (docs/API.md). config/urls.py가 api/ 아래에 include한다. 경로에 끝 슬래시를 붙이지 않는다."""
from django.urls import path

from . import views

urlpatterns = [
    path("analyses", views.AnalysesView.as_view()),
    path("analyses/quota", views.QuotaView.as_view()),
    path("analyses/<int:pk>", views.AnalysisDetailView.as_view()),
    path("jobs/<int:pk>", views.JobView.as_view()),
]
