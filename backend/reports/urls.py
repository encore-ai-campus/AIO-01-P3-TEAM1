"""AI 리포트 API (docs/API.md "AI 리포트"). config/urls.py가 api/ 아래에 include한다. 경로에 끝 슬래시를 붙이지 않는다."""
from django.urls import path

from . import sse, views

urlpatterns = [
    path("reports/plan", views.PlanView.as_view()),
    path("reports", views.ReportsView.as_view()),
    path("reports/screening", views.ScreeningView.as_view()),
    path("reports/quota", views.QuotaView.as_view()),
    path("reports/recovery-stats", views.RecoveryStatsView.as_view()),  # 담당 4 (T4-7)
    path("reports/<int:pk>", views.ReportDetailView.as_view()),
    path("reports/<int:pk>/pdf", views.PdfView.as_view()),
    path("reports/<int:pk>/events", sse.events),  # SSE (일반 Django 뷰)
]
